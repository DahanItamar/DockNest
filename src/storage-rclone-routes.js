// Cloud drives and network shares as storage destinations (docs/cloud-drives.md): the sign-in, creating a destination and
// Reconnect. Mounted by storage-targets.js, so every route here is admin only. The API never returns a token, a client secret
// or a password; it returns `connected`, `account` (masked), `tokenExpiresAt` and the plain status.
import { Router } from 'express';
import { z } from 'zod';
import { db, id, audit, transaction } from './db.js';
import { seal } from './crypto.js';
import { requireRecentAuth, rateLimit } from './auth.js';
import { isLoopback } from './storage/s3-client.js';
import * as rclone from './storage/rclone.js';
import * as oauth from './storage/rclone-oauth.js';
import * as folder from './storage/folder.js';
import { BACKENDS, backendLabel } from './storage/rclone-errors.js';
import { RECONNECT_STATUS, loadSecrets, replaceToken, settingsOf } from './storage/rclone-state.js';

export const rcloneRoutes = Router();

// "ada@example.com" -> "a***@e***.com"; a plain user name keeps its first two characters.
export function maskAccount(value) {
  const text = String(value ?? '');
  if (!text) return null;
  const at = text.indexOf('@');
  if (at < 1) return text.slice(0, 2) + '***';
  const domain = text.slice(at + 1), dot = domain.lastIndexOf('.');
  return `${text[0]}***@${domain[0] ?? ''}***${dot > 0 ? domain.slice(dot) : ''}`;
}
// What the destination list shows. `used` is the tracked bytes the caller already computed.
export function rcloneView(row, used) {
  const settings = settingsOf(row.id) ?? {};
  const { credential, host, port, username, host_key: hostKey, auth_type: authType, ...rest } = row;
  return {
    ...rest, kind: 'rclone', backend: settings.backend ?? null, label: backendLabel(settings.backend), connected: row.status === 'connected',
    needsReconnect: row.status === RECONNECT_STATUS, account: maskAccount(settings.account), tokenExpiresAt: settings.tokenExpiresAt ?? null,
    hasCredential: Boolean(credential), trackedBytes: used, oauth: Boolean(BACKENDS[settings.backend]?.oauth),
    // Shown on the destination card: these providers cannot be append-only, and deleted files go to the provider's trash.
    semantics: { appendOnly: false, trash: ['drive', 'onedrive', 'dropbox'].includes(settings.backend), uploadCheck: settings.backend === 'drive' ? 'size and MD5' : 'size' },
  };
}

export function folderView(row, used) {
  const settings = settingsOf(row.id) ?? {};
  const { credential, host, port, username, host_key: hostKey, auth_type: authType, ...rest } = row;
  return { ...rest, kind: 'local', path: settings.path ?? null, sameDisk: Boolean(settings.sameDisk), connected: row.status === 'connected', hasCredential: false, trackedBytes: used, semantics: { appendOnly: false, trash: false, uploadCheck: 'size' } };
}

const prefix = z.string().trim().max(200).default('').transform(value => value.replace(/^\/+|\/+$/g, ''))
  .refine(value => /^[a-zA-Z0-9_ ./-]*$/.test(value) && !value.split('/').some(part => part === '..' || part === '.' || (value && !part)), 'Use a simple folder such as docknest or team/docknest.');
const name = z.string().trim().min(1).max(100);
const capacityBytes = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional();
const endpoint = z.string().trim().max(512).transform((value, ctx) => {
  let url;
  try { url = new URL(value); } catch { ctx.addIssue({ code: 'custom', message: 'Enter the WebDAV address as a URL, for example https://cloud.example.com/remote.php/dav/files/user.' }); return z.NEVER; }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname))) || url.username || url.password || url.search || url.hash || /[\u0000-\u001f\u007f\s]/.test(value)) { ctx.addIssue({ code: 'custom', message: 'Use an HTTPS address without credentials, query or fragment.' }); return z.NEVER; }
  return url.origin + url.pathname.replace(/\/+$/, '');
});
const login = { username: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/), password: z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/) };
const common = { name, root: prefix, capacityBytes };
const connectSchema = z.discriminatedUnion('backend', [
  z.object({ backend: z.enum(['drive', 'dropbox']), sessionId: z.string().min(8).max(100), ...common }),
  z.object({ backend: z.literal('onedrive'), sessionId: z.string().min(8).max(100), driveId: z.string().regex(/^[A-Za-z0-9!_.-]{1,200}$/), driveType: z.enum(['personal', 'business', 'documentLibrary']), ...common }),
  z.object({ backend: z.literal('webdav'), endpoint, vendor: z.enum(['nextcloud', 'owncloud', 'other']).default('other'), ...login, ...common }),
  z.object({ backend: z.literal('smb'), host: z.string().regex(/^[a-zA-Z0-9_.:-]{1,253}$/), port: z.number().int().min(1).max(65535).optional(), share: z.string().regex(/^[A-Za-z0-9_.$ -]{1,80}$/), domain: z.string().regex(/^[A-Za-z0-9_.-]{0,100}$/).optional(), ...login, ...common }),
]);

const optionsOf = (targetId, data, settings, secrets) => ({ id: targetId, mode: 'rclone', name: data.name, backend: data.backend, settings, root: '/' + data.root, capacity: data.capacityBytes ?? 0, persist: false, secrets });

// ---- sign-in ----------------------------------------------------------------------------------------------------------
rcloneRoutes.post('/rclone/authorize', requireRecentAuth, rateLimit('rclone-authorize', 20), async (req, res) => {
  const data = z.object({ backend: z.enum(['drive', 'onedrive', 'dropbox']), flow: z.enum(['address', 'token']).default('address'), clientId: z.string().max(400).optional(), clientSecret: z.string().max(400).optional() }).parse(req.body);
  await rclone.version();
  const session = await oauth.start({ userId: req.user.id, ...data });
  audit(req.user.id, 'storage.authorize_started', null, { backend: data.backend, flow: data.flow, ownApp: Boolean(data.clientId) });
  res.status(201).json(session);
});
rcloneRoutes.post('/rclone/authorize/:sessionId', requireRecentAuth, rateLimit('rclone-paste', 40), async (req, res) => {
  const { pasted } = z.object({ pasted: z.string().min(1).max(20000) }).parse(req.body);
  const done = await oauth.submit({ sessionId: req.params.sessionId, userId: req.user.id, pasted });
  const taken = oauth.take({ sessionId: req.params.sessionId, userId: req.user.id });
  const secrets = { token: taken.token, ...(taken.client ?? {}) };
  const account = await rclone.account({ id: 'session-' + req.params.sessionId.slice(0, 8), mode: 'rclone', backend: taken.backend, settings: {}, persist: false, secrets });
  res.json({ backend: done.backend, account: maskAccount(account), tokenExpiresAt: done.tokenExpiresAt });
});
rcloneRoutes.get('/rclone/authorize/:sessionId/drives', rateLimit('rclone-paste', 40), async (req, res) => {
  const taken = oauth.take({ sessionId: req.params.sessionId, userId: req.user.id, backend: 'onedrive' });
  res.json({ drives: await rclone.drives({ id: 'session-' + req.params.sessionId.slice(0, 8), mode: 'rclone', backend: 'onedrive', settings: {}, persist: false, secrets: { token: taken.token, ...(taken.client ?? {}) } }) });
});
rcloneRoutes.delete('/rclone/authorize/:sessionId', rateLimit('rclone-paste', 40), (req, res) => { oauth.cancel({ sessionId: req.params.sessionId, userId: req.user.id }); res.json({ cancelled: true }); });

// ---- create -----------------------------------------------------------------------------------------------------------
rcloneRoutes.post('/rclone/connect', requireRecentAuth, rateLimit('rclone-connect', 20), async (req, res) => {
  const data = connectSchema.parse(req.body), targetId = id();
  await rclone.version();
  let settings, secrets, sessionId = null, taken = null;
  if (BACKENDS[data.backend].oauth) {
    sessionId = data.sessionId;
    taken = oauth.take({ sessionId, userId: req.user.id, backend: data.backend });
    settings = { backend: data.backend, ...(data.backend === 'onedrive' ? { driveId: data.driveId, driveType: data.driveType } : {}), clientIdSet: Boolean(taken.client), tokenExpiresAt: taken.token.expiry || null };
    secrets = { token: taken.token, ...(taken.client ?? {}) };
  } else if (data.backend === 'webdav') {
    settings = { backend: 'webdav', endpoint: data.endpoint, vendor: data.vendor };
    secrets = { username: data.username };
  } else {
    settings = { backend: 'smb', host: data.host, share: data.share, ...(data.port ? { port: data.port } : {}), ...(data.domain ? { domain: data.domain } : {}) };
    secrets = { username: data.username };
  }
  if (!BACKENDS[data.backend].oauth) secrets.passwordObscured = await rclone.obscure({ backend: data.backend }, data.password);
  const options = optionsOf(targetId, data, settings, secrets);
  await rclone.test(options);
  // A token rclone refreshed during the test is in options.secrets now.
  const account = BACKENDS[data.backend].oauth ? await rclone.account(options) : null;
  if (account) settings.account = account;
  const cap = data.capacityBytes ?? 0, now = new Date().toISOString();
  transaction(() => {
    db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(targetId, data.name, 'rclone.invalid', 1, '', 'not-sftp', 'rclone', seal(JSON.stringify(options.secrets)), '/' + data.root, cap, 'connected', now, now);
    db.prepare("INSERT INTO storage_target_settings VALUES(?,'rclone',?)").run(targetId, JSON.stringify({ ...settings, tokenExpiresAt: options.secrets.token?.expiry || settings.tokenExpiresAt || null }));
    db.prepare("INSERT OR IGNORE INTO settings VALUES('backup_storage_target',?)").run(targetId);
    audit(req.user.id, 'storage.connected', targetId, { authType: 'rclone', backend: data.backend });
  });
  if (sessionId) oauth.cancel({ sessionId, userId: req.user.id });
  const row = db.prepare('SELECT * FROM storage_targets WHERE id=?').get(targetId);
  res.status(201).json(rcloneView(row, 0));
});

// ---- local folder -----------------------------------------------------------------------------------------------------
// A folder mounted into the container (USB disk, NAS share), inside a path listed in DOCKNEST_LOCAL_STORAGE.
rcloneRoutes.post('/local/connect', requireRecentAuth, rateLimit('rclone-connect', 20), async (req, res) => {
  const data = z.object({ name, path: z.string().min(1).max(500), root: prefix, acceptSameDisk: z.boolean().default(false) }).parse(req.body), targetId = id();
  const checked = await folder.checkFolder(data.path);
  if (checked.sameDisk && !data.acceptSameDisk) return res.status(409).json({ error: 'This folder is on the same disk as DockNest. A disk failure would lose the backups together with DockNest.', code: 'same_disk', sameDisk: true });
  const options = { id: targetId, mode: 'folder', name: data.name, folder: checked.path, root: '/' + data.root };
  await folder.test(options);
  const now = new Date().toISOString();
  transaction(() => {
    db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(targetId, data.name, 'folder.invalid', 1, '', 'not-sftp', 'local', seal('{}'), '/' + data.root, 0, 'connected', now, now);
    db.prepare("INSERT INTO storage_target_settings VALUES(?,'folder',?)").run(targetId, JSON.stringify({ path: checked.path, sameDisk: checked.sameDisk }));
    db.prepare("INSERT OR IGNORE INTO settings VALUES('backup_storage_target',?)").run(targetId);
    audit(req.user.id, 'storage.connected', targetId, { authType: 'local', sameDisk: checked.sameDisk });
  });
  res.status(201).json(folderView(db.prepare('SELECT * FROM storage_targets WHERE id=?').get(targetId), 0));
});

// ---- reconnect --------------------------------------------------------------------------------------------------------
// Replaces only the token (and the owner's own app credentials when new ones were given); the folder, history and settings stay.
rcloneRoutes.post('/:id/reconnect', requireRecentAuth, rateLimit('rclone-connect', 20), async (req, res) => {
  const row = db.prepare("SELECT * FROM storage_targets WHERE id=? AND auth_type='rclone'").get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Cloud drive destination not found.' });
  const settings = settingsOf(row.id) ?? {};
  if (!BACKENDS[settings.backend]?.oauth) return res.status(409).json({ error: 'This destination signs in with a user name and password, not a token. Remove it and connect again to change them.', code: 'not_oauth' });
  const { sessionId } = z.object({ sessionId: z.string().min(8).max(100) }).parse(req.body);
  await rclone.version();
  const taken = oauth.take({ sessionId, userId: req.user.id, backend: settings.backend });
  const old = loadSecrets(row.id);
  const options = { id: row.id, mode: 'rclone', name: row.name, backend: settings.backend, settings, root: row.root, capacity: row.capacity_bytes, persist: false,
    secrets: { ...old, token: taken.token, ...(taken.client ?? {}) } };
  await rclone.test(options);
  transaction(() => {
    replaceToken(row.id, options.secrets.token, taken.client, req.user.id);
    db.prepare('UPDATE storage_targets SET last_tested_at=? WHERE id=?').run(new Date().toISOString(), row.id);
  });
  oauth.cancel({ sessionId, userId: req.user.id });
  res.json(rcloneView(db.prepare('SELECT * FROM storage_targets WHERE id=?').get(row.id), 0));
});
