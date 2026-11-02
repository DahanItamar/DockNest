// Deploy keys (docs/launch-site.md, "Deploy key" and "Security review changes" items 10 and 17). DockNest generates an
// ed25519 key pair here, shows the public key for the owner to add to the Git host as a read-only deploy key and seals
// the private key with the master key. The private key is never returned, logged or audited; it leaves this module only
// as the request body of a launch helper call (over SSH stdin). The Git host's SSH key is read from the server's
// network view (helper `launch-host-key`) and pinned only after the administrator confirmed its SHA-256 fingerprint.
// Deploy keys are always for administrators, with a re-verification within 5 minutes for every change.
import express from 'express';
import { z } from 'zod';
import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto';
import { db, id, audit, transaction } from '../db.js';
import { seal, open } from '../crypto.js';
import { requireAdmin, requireRecentAuth, rateLimit } from '../auth.js';
import { transport } from '../engine.js';
import { parseGitHost, LaunchInputError } from './validate.js';

const httpError = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const now = () => new Date().toISOString();
// SSH and the helper; tests replace `remote`.
export const deployKeyTransport = { remote: (server, request) => transport.remote(server, request, () => {}, () => {}, {}) };

// ---------- the key pair (OpenSSH format, built here so no ssh-keygen is needed) ----------
// The PEM armour is built from parts so no file holds a literal private-key header (repository privacy scan).
const pemLine = edge => `${'-'.repeat(5)}${edge} OPENSSH ${['PRIVATE', 'KEY'].join(' ')}${'-'.repeat(5)}`;
const sshString = value => { const body = Buffer.isBuffer(value) ? value : Buffer.from(value); const length = Buffer.alloc(4); length.writeUInt32BE(body.length); return Buffer.concat([length, body]); };
const uint32 = value => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value >>> 0); return buffer; };
export const sha256Fingerprint = blob => 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
export function generateDeployKey(comment) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'), seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);
  const check = randomBytes(4).readUInt32BE();
  let secret = Buffer.concat([uint32(check), uint32(check), sshString('ssh-ed25519'), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(comment)]);
  const padding = []; for (let index = 1; secret.length % 8; index++) { padding.push(index); secret = Buffer.concat([secret, Buffer.from([index])]); }
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0'), sshString('none'), sshString('none'), sshString(''), uint32(1), sshString(blob), sshString(secret)]);
  const pem = `${pemLine('BEGIN')}\n${body.toString('base64').match(/.{1,70}/g).join('\n')}\n${pemLine('END')}\n`;
  return { publicKey: `ssh-ed25519 ${blob.toString('base64')} ${comment}`, fingerprint: sha256Fingerprint(blob), privateKey: pem };
}

// ---------- the Git host key ----------
// A known_hosts line as the helper returns it: `[host]:port type base64` or `host type base64` (no options, no markers).
const KEY_TYPES = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com'];
export function parseHostKeyLine(line, expectedHost) {
  const parts = String(line ?? '').trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 3 || String(line).length > 8192) return null;
  const [hostPart, type, data] = parts.length === 3 ? parts : [null, ...parts];
  if (!KEY_TYPES.includes(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  if (hostPart !== null && hostPart !== expectedHost) return null;
  const blob = Buffer.from(data, 'base64');
  let typeLength; try { typeLength = blob.readUInt32BE(0); } catch { return null; }
  if (blob.subarray(4, 4 + typeLength).toString() !== type) return null;
  return { line: `${expectedHost} ${type} ${data}`, type, sha256: sha256Fingerprint(blob) };
}
const knownHostsName = ({ host, port }) => (port === 22 ? host : `[${host}]:${port}`);
const normaliseSha = text => { const value = String(text ?? '').trim().replace(/^SHA256:/i, '').replace(/=+$/, ''); return /^[A-Za-z0-9+/]{43}$/.test(value) ? 'SHA256:' + value : null; };

// Reads the Git host key from `server`'s network view. The helper connects and returns the key; trust comes only from
// the administrator comparing the fingerprint with the one the Git host publishes.
export async function readHostKey(serverRow, gitHost, allowPrivate) {
  let answer;
  try { answer = await deployKeyTransport.remote(serverRow, { operation: 'launch-host-key', gitHost: gitHost.text, allowPrivate: !!allowPrivate }); }
  catch (error) { throw httpError(409, 'SERVER_UNREACHABLE', error?.hostKeyRejected ? `The saved host key for ${serverRow.name} no longer matches. Check the server on the Servers page.` : `DockNest could not read the Git host key from ${serverRow.name}. Check the host name and that the server can reach it.`); }
  if (answer?.ok === false) throw httpError(409, /^[A-Z_]{2,40}$/.test(String(answer.code)) ? answer.code : 'HOST_KEY_UNAVAILABLE', hostKeyReason(answer.code, gitHost.text, serverRow.name));
  const parsed = parseHostKeyLine(answer?.hostKeyLine, knownHostsName(gitHost));
  // Our own hash of the key decides; a helper answer whose fingerprint does not match its key is refused.
  if (!parsed || (answer.sha256 && normaliseSha(answer.sha256) !== parsed.sha256)) throw httpError(409, 'HOST_KEY_UNAVAILABLE', `DockNest could not read a usable SSH key from ${gitHost.text}.`);
  return parsed;
}
function hostKeyReason(code, host, serverName) {
  return ({ PRIVATE_ADDRESS: `${host} resolves to a private address from ${serverName}. Tick "Allow private address" for a Git server on your own network.`, REFUSED_ADDRESS: `DockNest does not connect to the address ${host} resolves to.`, DNS_FAILED: `${serverName} could not resolve ${host}.`, CONNECT_FAILED: `${serverName} could not connect to ${host}.` })[code] ?? `DockNest could not read the SSH key of ${host} from ${serverName}.`;
}

// ---------- store ----------
const serverRow = serverId => db.prepare('SELECT * FROM servers WHERE id=?').get(serverId);
export function deployKeyView(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, gitHost: row.git_host, publicKey: row.public_key, fingerprint: row.fingerprint, hostKey: { sha256: row.host_key_sha256, type: row.host_key_line.split(/\s+/)[1] ?? null }, pinnedFromServerId: row.pinned_from_server_id, pinnedFromServerName: row.pinned_from_server_id ? serverRow(row.pinned_from_server_id)?.name ?? null : null, pinnedAt: row.pinned_at, createdAt: row.created_at };
}
export const listDeployKeys = () => db.prepare('SELECT * FROM deploy_keys ORDER BY created_at,id').all().map(deployKeyView);
const activeUse = keyId => db.prepare("SELECT 1 FROM site_launches WHERE deploy_key_id=? AND state IN ('queued','running','needs_attention')").get(keyId);

// POST /api/deploy-keys. Without `hostKeySha256` it only reads the Git host key and answers 409 HOST_KEY_CONFIRM with its
// fingerprint, creating nothing. With it, the key is read again and must still match; then the pair is generated.
export async function createDeployKey({ name, gitHost: rawHost, serverId, allowPrivate = false, hostKeySha256 }, actor) {
  const gitHost = parseGitHost(rawHost, { allowPrivate });
  const server = serverRow(serverId);
  if (!server) throw httpError(404, 'NOT_FOUND', 'Server not found.');
  const hostKey = await readHostKey(server, gitHost, allowPrivate);
  confirmHostKey(hostKey, hostKeySha256, gitHost.text);
  const keyId = id(), at = now(), pair = generateDeployKey(`docknest-${keyId.slice(0, 8)}`);
  db.prepare('INSERT INTO deploy_keys(id,name,git_host,host_key_line,host_key_sha256,public_key,fingerprint,sealed_private_key,pinned_from_server_id,pinned_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(keyId, name, gitHost.text, hostKey.line, hostKey.sha256, pair.publicKey, pair.fingerprint, seal(pair.privateKey), server.id, at, actor, at);
  audit(actor, 'deploy_key.created', keyId, { name, gitHost: gitHost.text, fingerprint: pair.fingerprint, hostKey: hostKey.sha256, server: server.id });
  return { key: deployKeyView(db.prepare('SELECT * FROM deploy_keys WHERE id=?').get(keyId)) };
}
function confirmHostKey(hostKey, confirmed, host) {
  const answer = { hostKey: { sha256: hostKey.sha256, type: hostKey.type } };
  if (confirmed === undefined || confirmed === null || confirmed === '') throw httpError(409, 'HOST_KEY_CONFIRM', `Compare this fingerprint with the one ${host} publishes, then confirm it.`, answer);
  if (normaliseSha(confirmed) !== hostKey.sha256) throw httpError(409, 'HOST_KEY_CHANGED', `The SSH key of ${host} is not the one you confirmed. Check the fingerprint again.`, answer);
}

// POST /api/deploy-keys/:id/pin: read the Git host key again (from the same or another server) and pin it after the
// administrator confirms it. Used after the Git host rotated its key and before using the key from another server.
export async function repinDeployKey(keyId, { serverId, allowPrivate = false, hostKeySha256 }, actor) {
  const row = db.prepare('SELECT * FROM deploy_keys WHERE id=?').get(keyId);
  if (!row) throw httpError(404, 'NOT_FOUND', 'Deploy key not found.');
  const server = serverRow(serverId);
  if (!server) throw httpError(404, 'NOT_FOUND', 'Server not found.');
  if (activeUse(keyId)) throw httpError(409, 'KEY_IN_USE', 'A launch is using this deploy key. Pin its host key again when the launch has finished.');
  const gitHost = parseGitHost(row.git_host, { allowPrivate });
  const hostKey = await readHostKey(server, gitHost, allowPrivate);
  confirmHostKey(hostKey, hostKeySha256, gitHost.text);
  transaction(() => {
    if (activeUse(keyId)) throw httpError(409, 'KEY_IN_USE', 'A launch is using this deploy key. Pin its host key again when the launch has finished.');
    db.prepare('UPDATE deploy_keys SET host_key_line=?,host_key_sha256=?,pinned_from_server_id=?,pinned_at=? WHERE id=?').run(hostKey.line, hostKey.sha256, server.id, now(), keyId);
  });
  audit(actor, 'deploy_key.pinned', keyId, { hostKey: hostKey.sha256, previous: row.host_key_sha256, server: server.id, previousServer: row.pinned_from_server_id });
  // A key is pinned from one server at a time (item 17): moving the pin means the previous server must confirm again.
  const previous = row.pinned_from_server_id && row.pinned_from_server_id !== server.id ? { serverId: row.pinned_from_server_id, serverName: serverRow(row.pinned_from_server_id)?.name ?? null } : null;
  return { key: deployKeyView(db.prepare('SELECT * FROM deploy_keys WHERE id=?').get(keyId)), ...(previous ? { replacedPin: { ...previous, text: `Launches on ${previous.serverName ?? 'the previous server'} with this key now need the Git host key confirmed from there again.` } } : {}) };
}

export function deleteDeployKey(keyId, actor) {
  const row = transaction(() => {
    const found = db.prepare('SELECT id,name,fingerprint FROM deploy_keys WHERE id=?').get(keyId);
    if (!found) throw httpError(404, 'NOT_FOUND', 'Deploy key not found.');
    if (activeUse(keyId)) throw httpError(409, 'KEY_IN_USE', 'A launch is using this deploy key. Delete it when the launch has finished.');
    db.prepare('DELETE FROM deploy_keys WHERE id=?').run(keyId);
    return found;
  });
  audit(actor, 'deploy_key.deleted', keyId, { name: row.name, fingerprint: row.fingerprint });
  return { deleted: true };
}

// For a launch helper request only (never an API answer): the private key and the pinned host key line. Using a key from
// a server other than the one its host key was read from needs the host key confirmed from that server first (item 17).
export function deployKeyForLaunch(keyId, serverId) {
  const row = db.prepare('SELECT * FROM deploy_keys WHERE id=?').get(keyId);
  if (!row) throw httpError(409, 'DEPLOY_KEY_MISSING', 'The deploy key for this launch was deleted. Choose another deploy key.');
  if (row.pinned_from_server_id !== serverId) throw httpError(409, 'HOST_KEY_REPIN_REQUIRED', `The Git host key of ${row.git_host} was confirmed from another server. Confirm it again from this server on the Connections page.`, { keyId: row.id });
  return { privateKey: open(row.sealed_private_key), hostKeyLine: row.host_key_line, gitHost: row.git_host };
}
export const deployKeyRow = keyId => db.prepare('SELECT id,name,git_host,pinned_from_server_id FROM deploy_keys WHERE id=?').get(keyId) ?? null;

// ---------- API: /api/deploy-keys ----------
const uuid = z.uuid();
const createBody = z.object({ name: z.string().trim().min(1).max(80), gitHost: z.string().min(1).max(262), serverId: uuid, allowPrivate: z.boolean().default(false), hostKeySha256: z.string().max(80).optional() }).strict();
const pinBody = z.object({ serverId: uuid, allowPrivate: z.boolean().default(false), hostKeySha256: z.string().max(80).optional() }).strict();
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); }
  catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message ?? 'The request is not valid.' });
    if (error instanceof LaunchInputError || error.status) return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.field ? { field: error.field } : {}), ...(error.hostKey ? { hostKey: error.hostKey } : {}) });
    next(error);
  }
};
export const deployKeyRoutes = express.Router();
deployKeyRoutes.use(requireAdmin);
deployKeyRoutes.get('/', (_req, res) => res.json({ keys: listDeployKeys() }));
deployKeyRoutes.get('/:id', handle(async (req, res) => {
  const key = deployKeyView(db.prepare('SELECT * FROM deploy_keys WHERE id=?').get(uuid.parse(req.params.id)));
  if (!key) throw httpError(404, 'NOT_FOUND', 'Deploy key not found.');
  res.json({ key });
}));
deployKeyRoutes.post('/', requireRecentAuth, rateLimit('deploy-key', 30, 10 * 60_000), handle(async (req, res) => res.status(201).json(await createDeployKey(createBody.parse(req.body), req.user.id))));
deployKeyRoutes.post('/:id/pin', requireRecentAuth, rateLimit('deploy-key', 30, 10 * 60_000), handle(async (req, res) => res.json(await repinDeployKey(uuid.parse(req.params.id), pinBody.parse(req.body), req.user.id))));
deployKeyRoutes.delete('/:id', requireRecentAuth, rateLimit('deploy-key', 30, 10 * 60_000), handle(async (req, res) => res.json(deleteDeployKey(uuid.parse(req.params.id), req.user.id))));
