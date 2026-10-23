// Alert credentials, channels (the nodes on the Map) and rules (the lines). docs/alerts.md.
// - A CREDENTIAL holds the secret (Telegram bot token, or SMTP server and login). It is sealed with the master key
//   (src/crypto.js, like SSH keys and the Cloudflare token), opened only at the moment of a send, and never returned:
//   views carry harmless fields and "set" flags. Nothing here logs or audits a secret.
// - A CHANNEL (node) holds only non-secret settings (Telegram chat ID; email recipients and subject prefix) and points
//   at a credential. One credential can serve many nodes. A node without a matching credential sends nothing.
import { z } from 'zod';
import { db, id, audit } from '../db.js';
import { seal, open } from '../crypto.js';
import { EVENTS } from './events.js';
import { mailbox } from './smtp.js';

export const limits = Object.freeze({ credentials: 20, channels: 40, rules: 200 });
export const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status }, extra);
const now = () => new Date().toISOString();

const hostname = z.string().trim().min(1).max(253).regex(/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$|^\[?[0-9A-Fa-f:.]+\]?$/, 'Enter the mail server name, for example smtp.example.com.');
const address = z.string().trim().max(254).refine(value => mailbox(value), 'Enter a plain email address, for example alerts@example.com.');
const name = z.string().trim().min(1).max(80);
const fail = error => { throw httpError(400, error.issues?.[0]?.message ?? 'The settings are not valid.'); };

// ---- Credentials -------------------------------------------------------------------------------------------------
export const telegramSecret = z.object({ token: z.string().trim().regex(/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/, 'Paste the bot token exactly as BotFather shows it.') }).strict();
export const smtpSecret = z.object({
  host: hostname, port: z.number().int().min(1).max(65535), security: z.enum(['starttls', 'tls']),
  username: z.string().max(254).default(''), password: z.string().max(512).default(''), from: address,
}).strict().refine(value => !value.username === !value.password, { message: 'Enter both the user name and the password, or leave both empty.', path: ['password'] });
const secretSchemas = { telegram: telegramSecret, smtp: smtpSecret };
export const credentialCreate = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('telegram'), name, config: telegramSecret }).strict(),
  z.object({ kind: z.literal('smtp'), name, config: smtpSecret }).strict(),
]);
// The channel kind each credential kind can serve.
export const channelKindFor = { telegram: 'telegram', smtp: 'email' };

export const credentialSecret = row => JSON.parse(open(row.config));
function secretView(kind, config) {
  return kind === 'telegram' ? { tokenSet: Boolean(config.token) } : { host: config.host, port: config.port, security: config.security, username: config.username, passwordSet: Boolean(config.password), from: config.from };
}
export function credentialView(row) {
  let config; try { config = secretView(row.kind, credentialSecret(row)); } catch { config = null; }
  const usedBy = db.prepare('SELECT id,name FROM alert_channels WHERE credential_id=? ORDER BY name').all(row.id).map(node => ({ id: node.id, name: node.name }));
  return { id: row.id, kind: row.kind, name: row.name, config, configReadable: config !== null, usedBy, createdAt: row.created_at, updatedAt: row.updated_at, lastTest: row.last_test, lastTestAt: row.last_test_at, lastError: row.last_error };
}
export const listCredentials = () => db.prepare('SELECT * FROM alert_credentials ORDER BY created_at,id').all().map(credentialView);
export const getCredential = credentialId => db.prepare('SELECT * FROM alert_credentials WHERE id=?').get(credentialId) ?? null;
const mustCredential = credentialId => getCredential(credentialId) ?? (() => { throw httpError(404, 'This credential does not exist.'); })();

export function createCredential(input, actor) {
  const data = credentialCreate.safeParse(input); if (!data.success) fail(data.error);
  if (db.prepare('SELECT COUNT(*) AS n FROM alert_credentials').get().n >= limits.credentials) throw httpError(409, `You can have up to ${limits.credentials} credentials.`);
  const credentialId = id(), at = now();
  db.prepare('INSERT INTO alert_credentials(id,kind,name,config,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(credentialId, data.data.kind, data.data.name, seal(JSON.stringify(data.data.config)), at, at);
  audit(actor, 'alert.credential.create', credentialId, { kind: data.data.kind });
  return credentialView(getCredential(credentialId));
}
// Secrets left out of `config` keep their saved value. Changing the mail server, port, encryption or user name requires typing the
// password again, so a saved password can never be redirected by editing those alone.
export function updateCredential(credentialId, input, actor) {
  const row = mustCredential(credentialId);
  const patch = z.object({ name: name.optional(), config: z.record(z.string(), z.unknown()).optional() }).strict().safeParse(input); if (!patch.success) fail(patch.error);
  let current; try { current = credentialSecret(row); } catch { current = {}; }
  const incoming = patch.data.config ?? {};
  const merged = { ...current, ...Object.fromEntries(Object.entries(incoming).filter(([key, value]) => !(['token', 'password'].includes(key) && (value === undefined || value === '')))) };
  if (row.kind === 'smtp' && 'username' in incoming && !incoming.username) merged.password = '';
  if (row.kind === 'smtp' && merged.password && !incoming.password && ['host', 'port', 'security', 'username'].some(key => key in incoming && incoming[key] !== current[key])) throw httpError(400, 'Enter the password again when you change the mail server, port or encryption.');
  const parsed = secretSchemas[row.kind].safeParse(merged); if (!parsed.success) fail(parsed.error);
  db.prepare('UPDATE alert_credentials SET name=?,config=?,updated_at=?,last_test=NULL,last_test_at=NULL,last_error=NULL WHERE id=?').run(patch.data.name ?? row.name, seal(JSON.stringify(parsed.data)), now(), credentialId);
  audit(actor, 'alert.credential.update', credentialId, { kind: row.kind, fields: Object.keys(incoming).slice(0, 12) }); // field names only, never values
  return credentialView(getCredential(credentialId));
}
export function deleteCredential(credentialId, actor) {
  const row = mustCredential(credentialId);
  const nodes = db.prepare('SELECT name FROM alert_channels WHERE credential_id=? ORDER BY name').all(credentialId).map(node => node.name);
  if (nodes.length) throw httpError(409, `This credential is used by ${nodes.map(node => `"${node}"`).join(', ')}. Remove or change those nodes first.`, { code: 'CREDENTIAL_IN_USE', nodes });
  db.prepare('DELETE FROM alert_credentials WHERE id=?').run(credentialId);
  audit(actor, 'alert.credential.delete', credentialId, { kind: row.kind });
  return { deleted: true };
}
export function recordCredentialTest(credentialId, ok, error = null) {
  db.prepare('UPDATE alert_credentials SET last_test=?,last_test_at=?,last_error=? WHERE id=?').run(ok ? 'ok' : 'failed', now(), ok ? null : String(error ?? 'The check failed.').slice(0, 200), credentialId);
}

// ---- Channels (nodes) --------------------------------------------------------------------------------------------
const chatId = z.string().trim().regex(/^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/, 'Enter the chat ID (a number) or the @name of a public channel.');
const prefix = z.string().trim().max(40).regex(/^[^\r\n\u0000-\u001f\u007f]*$/, 'The subject prefix must be one line.');
export const telegramNode = z.object({ chatId }).strict();
export const emailNode = z.object({ to: z.array(address).min(1).max(5), subjectPrefix: prefix.default('') }).strict();
const nodeSchemas = { telegram: telegramNode, email: emailNode };
const credentialId = z.uuid();
export const channelCreate = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('telegram'), name, credentialId, config: telegramNode }).strict(),
  z.object({ kind: z.literal('email'), name, credentialId, config: emailNode }).strict(),
]);

// A node can send only with a credential of the matching kind.
export function nodeCredential(row) {
  const credential = row.credential_id ? getCredential(row.credential_id) : null;
  return credential && channelKindFor[credential.kind] === row.kind ? credential : null;
}
export function channelView(row) {
  let config; try { config = JSON.parse(row.config); } catch { config = null; }
  const credential = nodeCredential(row);
  return { id: row.id, kind: row.kind, name: row.name, credentialId: row.credential_id, credentialName: credential?.name ?? null, needsCredential: credential === null, config, createdAt: row.created_at, updatedAt: row.updated_at, lastResult: row.last_result, lastResultAt: row.last_result_at, lastError: row.last_error };
}
export const listChannels = () => db.prepare('SELECT * FROM alert_channels ORDER BY created_at,id').all().map(channelView);
export const getChannel = channelId => db.prepare('SELECT * FROM alert_channels WHERE id=?').get(channelId) ?? null;
const mustChannel = channelId => getChannel(channelId) ?? (() => { throw httpError(404, 'This channel does not exist.'); })();
function requireMatching(kind, id) {
  const credential = getCredential(id);
  if (!credential) throw httpError(400, 'Choose a credential for this node.');
  if (channelKindFor[credential.kind] !== kind) throw httpError(400, kind === 'telegram' ? 'A Telegram node needs a Telegram credential.' : 'An email node needs an SMTP credential.');
}

export function createChannel(input, actor) {
  const data = channelCreate.safeParse(input); if (!data.success) fail(data.error);
  if (db.prepare('SELECT COUNT(*) AS n FROM alert_channels').get().n >= limits.channels) throw httpError(409, `You can have up to ${limits.channels} alert nodes.`);
  requireMatching(data.data.kind, data.data.credentialId);
  const channelId = id(), at = now();
  db.prepare('INSERT INTO alert_channels(id,kind,name,config,credential_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(channelId, data.data.kind, data.data.name, JSON.stringify(data.data.config), data.data.credentialId, at, at);
  audit(actor, 'alert.channel.create', channelId, { kind: data.data.kind, credentialId: data.data.credentialId });
  return channelView(getChannel(channelId));
}
export function updateChannel(channelId, input, actor) {
  const row = mustChannel(channelId);
  const patch = z.object({ name: name.optional(), credentialId: credentialId.optional(), config: z.record(z.string(), z.unknown()).optional() }).strict().safeParse(input); if (!patch.success) fail(patch.error);
  const config = nodeSchemas[row.kind].safeParse({ ...JSON.parse(row.config), ...(patch.data.config ?? {}) }); if (!config.success) fail(config.error);
  const credential = patch.data.credentialId ?? row.credential_id;
  if (patch.data.credentialId) requireMatching(row.kind, patch.data.credentialId);
  db.prepare('UPDATE alert_channels SET name=?,config=?,credential_id=?,updated_at=?,last_result=NULL,last_result_at=NULL,last_error=NULL WHERE id=?').run(patch.data.name ?? row.name, JSON.stringify(config.data), credential, now(), channelId);
  audit(actor, 'alert.channel.update', channelId, { kind: row.kind, fields: Object.keys(patch.data.config ?? {}).slice(0, 12), credentialChanged: Boolean(patch.data.credentialId) });
  return channelView(getChannel(channelId));
}
export function deleteChannel(channelId, actor) {
  const row = mustChannel(channelId);
  db.prepare('DELETE FROM alert_channels WHERE id=?').run(channelId);
  audit(actor, 'alert.channel.delete', channelId, { kind: row.kind });
  return { deleted: true };
}
export function recordResult(channelId, ok, error = null) {
  db.prepare('UPDATE alert_channels SET last_result=?,last_result_at=?,last_error=? WHERE id=?').run(ok ? 'ok' : 'failed', now(), ok ? null : String(error ?? 'The message could not be sent.').slice(0, 200), channelId);
}

// ---- Rules -------------------------------------------------------------------------------------------------------
const events = z.array(z.enum(EVENTS)).min(1).max(EVENTS.length).transform(list => [...new Set(list)]);
export const ruleCreate = z.object({ channelId: z.uuid(), sourceKind: z.enum(['docknest', 'server', 'site']), sourceId: z.uuid().nullable().default(null), events, enabled: z.boolean().default(true) }).strict();
export const ruleUpdate = z.object({ events: events.optional(), enabled: z.boolean().optional() }).strict();
export function ruleView(row) { return { id: row.id, channelId: row.channel_id, sourceKind: row.source_kind, sourceId: row.source_id, events: JSON.parse(row.events), enabled: row.enabled === 1, createdAt: row.created_at, updatedAt: row.updated_at }; }
export const listRules = () => db.prepare('SELECT * FROM alert_rules ORDER BY created_at,id').all().map(ruleView);
export function enabledRules() { return db.prepare('SELECT * FROM alert_rules WHERE enabled=1').all().map(row => ({ ...row, enabled: true, events: JSON.parse(row.events) })); }

export function createRule(input, actor) {
  const data = ruleCreate.safeParse(input); if (!data.success) fail(data.error);
  const { channelId, sourceKind, sourceId } = data.data;
  mustChannel(channelId);
  if ((sourceKind === 'docknest') !== (sourceId === null)) throw httpError(400, sourceKind === 'docknest' ? 'A DockNest line has no source id.' : 'Choose the server or site for this line.');
  if (sourceKind === 'server' && !db.prepare('SELECT 1 FROM servers WHERE id=?').get(sourceId)) throw httpError(404, 'This server does not exist.');
  if (sourceKind === 'site' && !db.prepare('SELECT 1 FROM sites WHERE id=?').get(sourceId)) throw httpError(404, 'This site does not exist.');
  if (db.prepare('SELECT COUNT(*) AS n FROM alert_rules').get().n >= limits.rules) throw httpError(409, `You can have up to ${limits.rules} alert lines.`);
  if (db.prepare('SELECT 1 FROM alert_rules WHERE channel_id=? AND source_kind=? AND source_id IS ?').get(channelId, sourceKind, sourceId)) throw httpError(409, 'This source already has a line to this channel. Edit that line instead.');
  const ruleId = id(), at = now();
  db.prepare('INSERT INTO alert_rules(id,channel_id,source_kind,source_id,events,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(ruleId, channelId, sourceKind, sourceId, JSON.stringify(data.data.events), data.data.enabled ? 1 : 0, at, at);
  audit(actor, 'alert.rule.create', ruleId, { channelId, sourceKind, sourceId, events: data.data.events });
  return ruleView(db.prepare('SELECT * FROM alert_rules WHERE id=?').get(ruleId));
}
export function updateRule(ruleId, input, actor) {
  const row = db.prepare('SELECT * FROM alert_rules WHERE id=?').get(ruleId); if (!row) throw httpError(404, 'This line does not exist.');
  const data = ruleUpdate.safeParse(input); if (!data.success) fail(data.error);
  db.prepare('UPDATE alert_rules SET events=?,enabled=?,updated_at=? WHERE id=?').run(JSON.stringify(data.data.events ?? JSON.parse(row.events)), (data.data.enabled ?? row.enabled === 1) ? 1 : 0, now(), ruleId);
  audit(actor, 'alert.rule.update', ruleId, { events: data.data.events, enabled: data.data.enabled });
  return ruleView(db.prepare('SELECT * FROM alert_rules WHERE id=?').get(ruleId));
}
export function deleteRule(ruleId, actor) {
  if (!db.prepare('SELECT 1 FROM alert_rules WHERE id=?').get(ruleId)) throw httpError(404, 'This line does not exist.');
  db.prepare('DELETE FROM alert_rules WHERE id=?').run(ruleId);
  audit(actor, 'alert.rule.delete', ruleId, {});
  return { deleted: true };
}
