// The 2.8 alert API (credentials, channels, rules) on the Connections store. docs/alerts.md and docs/alert-channels.md,
// "API" (adapter rules). The 2.8 routes and the Map keep working unchanged until the Map moves to the new routes (PR 4).
// - A CREDENTIAL is the set of Connections with `origin = legacy:<credentialId>`. They share one sealed login, copied
//   byte for byte and never opened to copy. Its id stays the 2.8 id. Creating one makes one Connection with that origin.
// - A CHANNEL is an alert node. Its destination (chat ID; recipients and subject prefix) lives on its Connection. A new
//   destination for a credential gets its own Connection (same sealed login, new settings); a node without one sends nothing.
// - A RULE is a line. Nothing here logs or audits a secret; views carry harmless fields and "set" flags.
// The frozen 2.8 tables are never read or written here, except deleting a 2.8 credential row whose secret was replaced
// or removed (connections.js, purgeLegacyCredential).
import { z } from 'zod';
import { db, id, audit, transaction } from '../db.js';
import { seal } from '../crypto.js';
import { EVENTS } from './events.js';
import { providers } from './providers/index.js';
import { cutName } from '../migrations.js';
import { connectionLimits, getConnection, openSecret, nodesUsing, insertConnection, legacyOrigin, legacyCredentialId, scrubbing, sealedWrite, purgeLegacyCredential, recordConnectionTest, recordConnectionSend, privateOkFor } from './connections.js';

export const limits = Object.freeze({ credentials: 20, channels: connectionLimits.nodes, rules: connectionLimits.lines });
export const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status }, extra);
const now = () => new Date().toISOString();
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const name = z.string().trim().min(1).max(80);
const fail = error => { throw httpError(400, error.issues?.[0]?.message ?? 'The settings are not valid.'); };

// ---- Credentials -------------------------------------------------------------------------------------------------
export const telegramSecret = providers.telegram.secretSchema;
export const smtpSecret = providers.email.secretSchema;
const secretSchemas = { telegram: telegramSecret, smtp: smtpSecret };
export const credentialCreate = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('telegram'), name, config: telegramSecret }).strict(),
  z.object({ kind: z.literal('smtp'), name, config: smtpSecret }).strict(),
]);
// The channel kind (and Connection provider) each credential kind serves.
export const channelKindFor = { telegram: 'telegram', smtp: 'email' };
const credentialKindFor = { telegram: 'telegram', email: 'smtp' };

// A Connection's 2.8 credential: its legacy origin, or the Connection itself when it has none.
const groupOf = row => legacyCredentialId(row) ?? row.id;
// The Connections of one credential, the one that kept the credential's id first.
const groupRows = credentialId => db.prepare("SELECT * FROM connections WHERE (origin=? OR (origin IS NULL AND id=?)) AND provider IN ('telegram','email') ORDER BY (id=?) DESC,created_at,id").all(legacyOrigin(credentialId), credentialId, credentialId);
const newest = (rows, field) => rows.filter(row => row[field]).sort((a, b) => String(b[`${field}_at`]).localeCompare(String(a[`${field}_at`])))[0] ?? null;
const credentialOf = (credentialId, rows) => {
  const tested = newest(rows, 'last_test');
  return {
    id: credentialId, kind: credentialKindFor[rows[0].provider], name: rows[0].id === credentialId ? rows[0].name : baseName(rows[0]), secret: rows[0].secret, rows,
    created_at: rows.map(row => row.created_at).sort()[0], updated_at: rows.map(row => row.updated_at).sort().at(-1),
    last_test: tested?.last_test ?? null, last_test_at: tested?.last_test_at ?? null, last_error: tested?.last_test === 'failed' ? tested.last_error : null,
  };
};
// "Bot (Work chat)" -> "Bot": the name a split Connection got from its credential.
const baseName = row => row.name.replace(/ \([^()]*\)$/, '') || row.name;
export function getCredential(credentialId) {
  if (typeof credentialId !== 'string') return null;
  const rows = groupRows(credentialId);
  return rows.length ? credentialOf(credentialId, rows) : null;
}
// Opens a credential's (or a Connection's) sealed login. Only for a send or a test.
export const credentialSecret = row => openSecret(row);
function secretView(kind, config) {
  return kind === 'telegram' ? { tokenSet: Boolean(config.token) } : { host: config.host, port: config.port, security: config.security, username: config.username, passwordSet: Boolean(config.password), from: config.from };
}
export function credentialView(credential) {
  let config; try { config = secretView(credential.kind, openSecret(credential)); } catch { config = null; }
  const usedBy = credential.rows.flatMap(row => nodesUsing(row.id)).sort((a, b) => byText(a.name, b.name) || byText(a.id, b.id)); // ORDER BY name, as 2.8
  return { id: credential.id, kind: credential.kind, name: credential.name, config, configReadable: config !== null, usedBy, createdAt: credential.created_at, updatedAt: credential.updated_at, lastTest: credential.last_test, lastTestAt: credential.last_test_at, lastError: credential.last_error };
}
function credentials() {
  const groups = new Map();
  for (const row of db.prepare("SELECT * FROM connections WHERE provider IN ('telegram','email') ORDER BY created_at,id").all()) {
    const key = groupOf(row); if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups].map(([key, rows]) => credentialOf(key, [...rows.filter(row => row.id === key), ...rows.filter(row => row.id !== key)]));
}
export const listCredentials = () => credentials().sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).map(credentialView);
const mustCredential = credentialId => getCredential(credentialId) ?? (() => { throw httpError(404, 'This credential does not exist.'); })();
const connectionCount = () => db.prepare('SELECT COUNT(*) AS n FROM connections').get().n;
const connectionsFull = () => httpError(409, `You can have up to ${connectionLimits.connections} connections.`);

// The 2.8 routes are for administrators only (routes.js), so `role` is 'admin' there; it decides `private_ok`.
export function createCredential(input, actor, { role = 'admin' } = {}) {
  const data = credentialCreate.safeParse(input); if (!data.success) fail(data.error);
  if (credentials().length >= limits.credentials) throw httpError(409, `You can have up to ${limits.credentials} credentials.`);
  if (connectionCount() >= connectionLimits.connections) throw connectionsFull();
  const credentialId = id(), providerId = channelKindFor[data.data.kind];
  // Not used yet: empty settings until a node names its chat or recipients. Email keeps the 2.8 relay rule (admin-set).
  insertConnection({ id: credentialId, provider: providerId, name: data.data.name, secret: seal(JSON.stringify(data.data.config)), settings: {}, origin: legacyOrigin(credentialId), privateOk: privateOkFor({ provider: providerId, role }) === 1, actor });
  audit(actor, 'alert.credential.create', credentialId, { kind: data.data.kind });
  return credentialView(getCredential(credentialId));
}
// Secrets left out of `config` keep their saved value. Changing the mail server, port, encryption or user name requires typing the
// password again, so a saved password can never be redirected by editing those alone. Every Connection of the credential
// gets the same new sealed value and name. A replaced secret also removes the frozen 2.8 row that still holds the old one.
export function updateCredential(credentialId, input, actor, { role = 'admin' } = {}) {
  const credential = mustCredential(credentialId);
  const patch = z.object({ name: name.optional(), config: z.record(z.string(), z.unknown()).optional() }).strict().safeParse(input); if (!patch.success) fail(patch.error);
  let current; try { current = openSecret(credential); } catch { current = {}; }
  const incoming = patch.data.config ?? {};
  const typed = key => ['token', 'password'].includes(key) && !(incoming[key] === undefined || incoming[key] === '');
  const merged = { ...current, ...Object.fromEntries(Object.entries(incoming).filter(([key, value]) => !(['token', 'password'].includes(key) && (value === undefined || value === '')))) };
  if (credential.kind === 'smtp' && 'username' in incoming && !incoming.username) merged.password = '';
  if (credential.kind === 'smtp' && merged.password && !incoming.password && ['host', 'port', 'security', 'username'].some(key => key in incoming && incoming[key] !== current[key])) throw httpError(400, 'Enter the password again when you change the mail server, port or encryption.');
  const parsed = secretSchemas[credential.kind].safeParse(merged); if (!parsed.success) fail(parsed.error);
  const sealed = seal(JSON.stringify(parsed.data)), title = patch.data.name ?? credential.name, at = now();
  const replaced = Object.keys(incoming).some(typed) || (credential.kind === 'smtp' && current.password && !merged.password);
  // `private_ok` follows who last set the mail server: an administrator keeps the 2.8 relay rule, anyone else public only.
  const hostChanged = credential.kind === 'smtp' && ['host', 'port'].some(key => key in incoming && incoming[key] !== current[key]);
  const write = () => transaction(() => {
    for (const row of credential.rows) {
      const suffix = row.id === credentialId ? null : nodesUsing(row.id)[0]?.name;
      const privateOk = privateOkFor({ provider: row.provider, role, hostChanged, previous: row.private_ok });
      db.prepare('UPDATE connections SET name=?,secret=?,private_ok=?,updated_at=?,updated_by=?,last_test=NULL,last_test_at=NULL,last_error=NULL WHERE id=?').run(suffix ? cutName(`${title} (${suffix})`) : title, sealed, privateOk, at, actor, row.id);
    }
    if (replaced) purgeLegacyCredential(credentialId);
  });
  if (replaced) scrubbing(write); else sealedWrite(write);
  audit(actor, 'alert.credential.update', credentialId, { kind: credential.kind, fields: Object.keys(incoming).slice(0, 12) }); // field names only, never values
  return credentialView(getCredential(credentialId));
}
export function deleteCredential(credentialId, actor) {
  const credential = mustCredential(credentialId);
  const nodes = credential.rows.flatMap(row => nodesUsing(row.id)).map(node => node.name).sort(byText);
  if (nodes.length) throw httpError(409, `This credential is used by ${nodes.map(node => `"${node}"`).join(', ')}. Remove or change those nodes first.`, { code: 'CREDENTIAL_IN_USE', nodes });
  scrubbing(() => transaction(() => {
    for (const row of credential.rows) db.prepare('DELETE FROM connections WHERE id=?').run(row.id);
    purgeLegacyCredential(credentialId);
  }));
  audit(actor, 'alert.credential.delete', credentialId, { kind: credential.kind });
  return { deleted: true };
}
export function recordCredentialTest(credentialId, ok, error = null) {
  const credential = getCredential(credentialId); if (!credential) return;
  for (const row of credential.rows) recordConnectionTest(row.id, ok, error);
}

// ---- Channels (nodes) --------------------------------------------------------------------------------------------
export const telegramNode = providers.telegram.settingsSchema;
export const emailNode = providers.email.settingsSchema;
const nodeSchemas = { telegram: telegramNode, email: emailNode };
const credentialId = z.uuid();
export const channelCreate = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('telegram'), name, credentialId, config: telegramNode }).strict(),
  z.object({ kind: z.literal('email'), name, credentialId, config: emailNode }).strict(),
]);

// A node can send only through a Connection of its own provider.
export function nodeConnection(row) {
  const connection = row?.connection_id ? getConnection(row.connection_id) : null;
  return connection && connection.provider === row.provider ? connection : null;
}
export function nodeCredential(row) { const connection = nodeConnection(row); return connection ? getCredential(groupOf(connection)) : null; }
const parsed = text => { try { return JSON.parse(text); } catch { return null; } };
export function channelView(row) {
  const connection = nodeConnection(row), credential = connection ? getCredential(groupOf(connection)) : null;
  const config = connection ? parsed(connection.settings) : row.prefill === null ? null : parsed(row.prefill);
  // The Connection's last real send (or node test) is the node's last result, as the 2.8 channel showed it.
  return { id: row.id, kind: row.provider, name: row.name, credentialId: credential?.id ?? null, credentialName: credential?.name ?? null, needsCredential: credential === null, config, createdAt: row.created_at, updatedAt: row.updated_at, lastResult: connection?.last_send ?? null, lastResultAt: connection?.last_send_at ?? null, lastError: connection?.last_send === 'failed' ? connection.last_error : null };
}
export const listChannels = () => db.prepare("SELECT * FROM alert_nodes WHERE provider IN ('telegram','email') ORDER BY created_at,id").all().map(channelView);
export const getChannel = channelId => db.prepare('SELECT * FROM alert_nodes WHERE id=?').get(channelId) ?? null;
const mustChannel = channelId => getChannel(channelId) ?? (() => { throw httpError(404, 'This channel does not exist.'); })();
function requireMatching(kind, credential) {
  if (!credential) throw httpError(400, 'Choose a credential for this node.');
  if (channelKindFor[credential.kind] !== kind) throw httpError(400, kind === 'telegram' ? 'A Telegram node needs a Telegram credential.' : 'An email node needs an SMTP credential.');
}
// The Connection of `credential` that reaches `settings`: one that already does, else the node's own one or an unused
// one moved there in place, else a new Connection with the same sealed login copied as is (never opened).
function connectionFor(credential, settings, nodeName, nodeId = null) {
  const key = JSON.stringify(settings), rows = credential.rows;
  const same = rows.find(row => row.settings === key); if (same) return same.id;
  const users = row => nodesUsing(row.id).filter(node => node.id !== nodeId).length;
  const own = nodeId ? rows.find(row => row.id === getChannel(nodeId)?.connection_id && !users(row)) : null;
  const reuse = own ?? rows.find(row => !nodesUsing(row.id).length);
  if (reuse) {
    sealedWrite(() => db.prepare('UPDATE connections SET settings=?,updated_at=?,last_send=NULL,last_send_at=NULL,last_error=NULL WHERE id=?').run(key, now(), reuse.id));
    // A new destination starts with no dedup history, so a real alert to it is never suppressed by one the old
    // destination got. Pending items stay: they go to the new destination, as a 2.8 node's queue did after an edit.
    // An unused Connection taken over by another node keeps nothing: its pending items were for a destination no node
    // uses (a deleted node's), and must not reach this one.
    db.prepare("DELETE FROM alert_outbox WHERE connection_id=? AND (status<>'pending' OR ?)").run(reuse.id, reuse === own ? 0 : 1);
    return reuse.id;
  }
  if (connectionCount() >= connectionLimits.connections) throw connectionsFull();
  const primary = rows[0];
  return insertConnection({ id: id(), provider: primary.provider, name: cutName(`${credential.name} (${nodeName})`), secret: primary.secret, settings, origin: legacyOrigin(credential.id), privateOk: primary.private_ok === 1 }).id;
}

export function createChannel(input, actor) {
  const data = channelCreate.safeParse(input); if (!data.success) fail(data.error);
  if (db.prepare('SELECT COUNT(*) AS n FROM alert_nodes').get().n >= limits.channels) throw httpError(409, `You can have up to ${limits.channels} alert nodes.`);
  const credential = getCredential(data.data.credentialId);
  requireMatching(data.data.kind, credential);
  const channelId = id(), at = now();
  transaction(() => {
    const connectionId = connectionFor(credential, data.data.config, data.data.name);
    db.prepare('INSERT INTO alert_nodes(id,provider,name,connection_id,prefill,created_at,updated_at) VALUES(?,?,?,?,NULL,?,?)').run(channelId, data.data.kind, data.data.name, connectionId, at, at);
  });
  audit(actor, 'alert.channel.create', channelId, { kind: data.data.kind, credentialId: data.data.credentialId });
  return channelView(getChannel(channelId));
}
export function updateChannel(channelId, input, actor) {
  const row = mustChannel(channelId);
  const patch = z.object({ name: name.optional(), credentialId: credentialId.optional(), config: z.record(z.string(), z.unknown()).optional() }).strict().safeParse(input); if (!patch.success) fail(patch.error);
  const current = channelView(row);
  const config = nodeSchemas[row.provider].safeParse({ ...(current.config ?? {}), ...(patch.data.config ?? {}) }); if (!config.success) fail(config.error);
  const credential = patch.data.credentialId ? getCredential(patch.data.credentialId) : current.credentialId ? getCredential(current.credentialId) : null;
  if (patch.data.credentialId) requireMatching(row.provider, credential);
  const title = patch.data.name ?? row.name;
  transaction(() => {
    // Without a credential the node keeps its destination as `prefill` and sends nothing, as in 2.8.
    if (!credential) db.prepare('UPDATE alert_nodes SET name=?,connection_id=NULL,prefill=?,updated_at=? WHERE id=?').run(title, JSON.stringify(config.data), now(), channelId);
    else {
      const target = connectionFor(credential, config.data, title, channelId);
      db.prepare('UPDATE alert_nodes SET name=?,connection_id=?,prefill=NULL,updated_at=? WHERE id=?').run(title, target, now(), channelId);
      carryPending(row.connection_id, target, channelId);
    }
  });
  audit(actor, 'alert.channel.update', channelId, { kind: row.provider, fields: Object.keys(patch.data.config ?? {}).slice(0, 12), credentialChanged: Boolean(patch.data.credentialId) });
  return channelView(getChannel(channelId));
}
// A node moved to another Connection (another credential, or a destination another Connection already reaches) takes
// its pending items along when no node is left on the old one, as a 2.8 node's queue followed the node. An item whose
// event the new Connection already has pending, or handled at or after it, stays behind (and fails unsent), so nothing
// is sent twice to one destination.
function carryPending(from, to, nodeId) {
  if (!from || from === to || nodesUsing(from).length) return;
  db.prepare("UPDATE alert_outbox SET connection_id=? WHERE connection_id=? AND node_id=? AND status='pending' AND NOT EXISTS (SELECT 1 FROM alert_outbox t WHERE t.connection_id=? AND t.dedupe_key=alert_outbox.dedupe_key AND (t.status='pending' OR t.created_at>=alert_outbox.created_at))").run(to, from, nodeId, to);
}
// Removes the node and its lines. Its Connection stays (a credential outlives its nodes, as in 2.8); its sent and
// pending messages keep their dedup history with node_id NULL, and nothing is sent through a Connection no node uses.
export function deleteChannel(channelId, actor) {
  const row = mustChannel(channelId);
  db.prepare('DELETE FROM alert_nodes WHERE id=?').run(channelId);
  audit(actor, 'alert.channel.delete', channelId, { kind: row.provider });
  return { deleted: true };
}
// The result of a send or a node test, kept on the node's Connection (`last_send`).
export function recordResult(channelId, ok, error = null) {
  const connectionId = getChannel(channelId)?.connection_id; if (!connectionId) return;
  recordConnectionSend(connectionId, ok, error);
}

// ---- Rules (lines) -----------------------------------------------------------------------------------------------
const events = z.array(z.enum(EVENTS)).min(1).max(EVENTS.length).transform(list => [...new Set(list)]);
export const ruleCreate = z.object({ channelId: z.uuid(), sourceKind: z.enum(['docknest', 'server', 'site']), sourceId: z.uuid().nullable().default(null), events, enabled: z.boolean().default(true) }).strict();
export const ruleUpdate = z.object({ events: events.optional(), enabled: z.boolean().optional() }).strict();
const eventList = text => { const list = parsed(text); return Array.isArray(list) ? list : []; };
export function ruleView(row) { return { id: row.id, channelId: row.node_id, sourceKind: row.source_kind, sourceId: row.source_id, events: eventList(row.events), enabled: row.enabled === 1, createdAt: row.created_at, updatedAt: row.updated_at }; }
export const listRules = () => db.prepare('SELECT * FROM alert_lines ORDER BY created_at,id').all().map(ruleView);
export function enabledRules() { return db.prepare('SELECT * FROM alert_lines WHERE enabled=1 ORDER BY created_at,id').all().map(row => ({ ...row, enabled: true, events: eventList(row.events) })); }

export function createRule(input, actor) {
  const data = ruleCreate.safeParse(input); if (!data.success) fail(data.error);
  const { channelId, sourceKind, sourceId } = data.data;
  mustChannel(channelId);
  if ((sourceKind === 'docknest') !== (sourceId === null)) throw httpError(400, sourceKind === 'docknest' ? 'A DockNest line has no source id.' : 'Choose the server or site for this line.');
  if (sourceKind === 'server' && !db.prepare('SELECT 1 FROM servers WHERE id=?').get(sourceId)) throw httpError(404, 'This server does not exist.');
  if (sourceKind === 'site' && !db.prepare('SELECT 1 FROM sites WHERE id=?').get(sourceId)) throw httpError(404, 'This site does not exist.');
  if (db.prepare('SELECT COUNT(*) AS n FROM alert_lines').get().n >= limits.rules) throw httpError(409, `You can have up to ${limits.rules} alert lines.`);
  if (db.prepare('SELECT 1 FROM alert_lines WHERE node_id=? AND source_kind=? AND source_id IS ?').get(channelId, sourceKind, sourceId)) throw httpError(409, 'This source already has a line to this channel. Edit that line instead.');
  const ruleId = id(), at = now();
  db.prepare('INSERT INTO alert_lines(id,node_id,source_kind,source_id,events,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(ruleId, channelId, sourceKind, sourceId, JSON.stringify(data.data.events), data.data.enabled ? 1 : 0, at, at);
  audit(actor, 'alert.rule.create', ruleId, { channelId, sourceKind, sourceId, events: data.data.events });
  return ruleView(db.prepare('SELECT * FROM alert_lines WHERE id=?').get(ruleId));
}
export function updateRule(ruleId, input, actor) {
  const row = db.prepare('SELECT * FROM alert_lines WHERE id=?').get(ruleId); if (!row) throw httpError(404, 'This line does not exist.');
  const data = ruleUpdate.safeParse(input); if (!data.success) fail(data.error);
  db.prepare('UPDATE alert_lines SET events=?,enabled=?,updated_at=? WHERE id=?').run(JSON.stringify(data.data.events ?? eventList(row.events)), (data.data.enabled ?? row.enabled === 1) ? 1 : 0, now(), ruleId);
  audit(actor, 'alert.rule.update', ruleId, { events: data.data.events, enabled: data.data.enabled });
  return ruleView(db.prepare('SELECT * FROM alert_lines WHERE id=?').get(ruleId));
}
export function deleteRule(ruleId, actor) {
  if (!db.prepare('SELECT 1 FROM alert_lines WHERE id=?').get(ruleId)) throw httpError(404, 'This line does not exist.');
  db.prepare('DELETE FROM alert_lines WHERE id=?').run(ruleId);
  audit(actor, 'alert.rule.delete', ruleId, {});
  return { deleted: true };
}
