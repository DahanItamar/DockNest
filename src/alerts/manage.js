// Connections and alert nodes for the API (docs/alert-channels.md, "Who may do what", "API" and "Sealed storage,
// redaction, audit and roles"). routes.js checks who is signed in and passes the role from the session; everything here
// takes `role` from the caller and never from a request body.
// - A Connection holds the login (sealed with the master key as one value) and the plain destination. Views carry plain
//   fields and `<field>Set` flags; a secret is never returned, logged, audited or put in an error.
// - Secrets left out of a PATCH keep their saved value. Changing a `host` field needs every saved secret typed again, so a
//   saved token can never be pointed at a new server by editing the server alone.
// - A change of a secret, a `host` or a `destination` field needs a recent re-verification (`recent`), for administrators
//   and operators alike, and is audited by field name only.
// - Other (webhook URL) is admin-only to create, edit or delete. Operators may still pick and test one an admin saved.
// - A failed test answers with the provider's own fixed sentence for an administrator. For an operator every failure is one
//   sentence, OPERATOR_TEST_FAILED, recorded as such too, and routes.js answers it at a fixed time.
import { z } from 'zod';
import { db, id, audit, transaction } from '../db.js';
import { seal } from '../crypto.js';
import { provider, split } from './providers/index.js';
import { connectionLimits, getConnection, openSecret, nodesUsing, insertConnection, connectionView, legacyCredentialId, scrubbing, sealedWrite, purgeLegacyCredential, privateOkFor, recordConnectionTest, resultErrors, SEND_FAILED } from './connections.js';
import { httpError, carryPending } from './store.js';
import { sendWith, DeliveryError } from './delivery.js';
import { testMessage } from './events.js';

export const OPERATOR_TEST_FAILED = 'DockNest could not deliver to this address.';
const now = () => new Date().toISOString();
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const parsed = text => { try { return JSON.parse(text); } catch { return null; } };
// Names: one line, at most 80 characters. Control characters and bidi overrides or isolates are dropped (they could make a
// name read as another); Hebrew, Arabic and other right-to-left names need none of them and stay as typed.
export const nameField = z.string().transform(value => value.replace(/[\u202a-\u202e\u2066-\u2069]/g, '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()).pipe(z.string().min(1, 'Enter a name.').max(80, 'Use up to 80 characters for the name.'));
const values = z.record(z.string().max(64), z.unknown()).refine(record => Object.keys(record).length <= 24, 'Too many fields.');
const issue = error => { const first = error.issues?.[0]; return httpError(400, first?.message ?? 'The settings are not valid.', first?.path?.length ? { field: String(first.path[0]) } : {}); };
const adminRequired = () => httpError(403, 'Only an administrator can change this kind of connection.', { code: 'ALERTS_ADMIN_REQUIRED' });
const reauthRequired = () => httpError(403, 'Verify your own authenticator or recovery code before this change.', { code: 'REAUTH_REQUIRED' });
const mustProvider = providerId => provider(providerId) ?? (() => { throw httpError(400, 'Choose a provider.', { field: 'provider' }); })();
const mustConnection = connectionId => getConnection(connectionId) ?? (() => { throw httpError(404, 'This connection does not exist.'); })();
const secretKeys = item => item.fields.filter(field => field.secret).map(field => field.key);
const labelOf = (item, key) => item.fields.find(field => field.key === key)?.label ?? key;

// The view for one signed-in role: `editable` is false for Other when the viewer is an operator (shown, not editable).
export const viewFor = (row, role) => ({ ...connectionView(row), editable: role === 'admin' || !provider(row.provider)?.adminOnly });
export const listConnectionViews = role => db.prepare('SELECT * FROM connections ORDER BY created_at,id').all().map(row => viewFor(row, role));

// Full values -> the sealed part and the plain settings, each checked by the provider's own schema.
function parseValues(item, input) {
  const { secret, settings } = split(item.id, input);
  const login = item.secretSchema.safeParse(secret); if (!login.success) throw issue(login.error);
  const destination = item.settingsSchema.safeParse(settings); if (!destination.success) throw issue(destination.error);
  return { secret: login.data, settings: destination.data };
}

// The saved values of a Connection merged with a change. Secrets left out (or empty) keep their saved value; a changed
// `host` field needs every saved secret typed again. Returns the parsed result and what changed, by field name.
function merge(item, row, incoming) {
  let current; try { current = openSecret(row); } catch { current = null; }
  const saved = { ...(current ?? {}), ...(parsed(row.settings) ?? {}) }, secrets = new Set(secretKeys(item));
  const typed = key => secrets.has(key) && incoming[key] !== undefined && incoming[key] !== '';
  const next = { ...saved };
  for (const [key, value] of Object.entries(incoming)) if (!(secrets.has(key) && !typed(key))) next[key] = value;
  // Email keeps the 2.8 rule: clearing the user name clears the password too.
  if (item.id === 'email' && 'username' in incoming && !incoming.username) next.password = '';
  const result = parseValues(item, next), before = current ? { ...current, ...(parsed(row.settings) ?? {}) } : saved, after = { ...result.secret, ...result.settings };
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !same(before[key], after[key]));
  const hostChanged = item.host.some(key => changed.includes(key));
  const missing = secretKeys(item).find(key => current?.[key] && !typed(key) && !item.host.includes(key));
  if (hostChanged && missing) throw httpError(400, `Enter the ${labelOf(item, missing).toLowerCase()} again when you change the ${labelOf(item, item.host.find(key => changed.includes(key))).toLowerCase()}.`, { field: missing });
  const replaced = [...secrets].some(typed) || (item.id === 'email' && Boolean(current?.password) && !result.secret.password);
  return { ...result, changed, hostChanged, replaced, destinationChanged: item.destination.some(key => changed.includes(key)) };
}

// ---- Connections -------------------------------------------------------------------------------------------------
export function createConnection(input, actor, { role, recent }) {
  const body = z.object({ provider: z.string().max(32), name: nameField, values: values.default({}) }).strict().safeParse(input); if (!body.success) throw issue(body.error);
  const item = mustProvider(body.data.provider);
  if (item.adminOnly && role !== 'admin') throw adminRequired();
  if (!recent) throw reauthRequired();
  const { secret, settings } = parseValues(item, body.data.values);
  if (db.prepare('SELECT COUNT(*) AS n FROM connections').get().n >= connectionLimits.connections) throw httpError(409, `You can have up to ${connectionLimits.connections} connections.`);
  const connectionId = id();
  sealedWrite(() => insertConnection({ id: connectionId, provider: item.id, name: body.data.name, secret: seal(JSON.stringify(secret)), settings, privateOk: privateOkFor({ provider: item, role }) === 1, actor }));
  audit(actor, 'connection.create', connectionId, { provider: item.id, role });
  return viewFor(getConnection(connectionId), role);
}

export function updateConnection(connectionId, input, actor, { role, recent }) {
  const row = mustConnection(connectionId), item = provider(row.provider);
  if (!item) throw httpError(409, 'This kind of connection is not supported any more.');
  if (item.adminOnly && role !== 'admin') throw adminRequired();
  const body = z.object({ name: nameField.optional(), values: values.optional() }).strict().safeParse(input); if (!body.success) throw issue(body.error);
  const change = body.data.values ? merge(item, row, body.data.values) : null;
  const sensitive = Boolean(change && (change.replaced || change.hostChanged || change.destinationChanged));
  if (sensitive && !recent) throw reauthRequired();
  const name = body.data.name ?? row.name, at = now();
  const privateOk = privateOkFor({ provider: item, role, hostChanged: Boolean(change?.hostChanged), previous: row.private_ok });
  const write = () => transaction(() => {
    if (!change) { db.prepare('UPDATE connections SET name=?,updated_at=?,updated_by=? WHERE id=?').run(name, at, actor, connectionId); return; }
    // A new login or destination starts with no test or send result: the old ones were about something else.
    db.prepare(`UPDATE connections SET name=?,secret=?,settings=?,private_ok=?,updated_at=?,updated_by=?${sensitive ? ',last_test=NULL,last_test_at=NULL,last_send=NULL,last_send_at=NULL,last_error=NULL' : ''} WHERE id=?`).run(name, seal(JSON.stringify(change.secret)), JSON.stringify(change.settings), privateOk, at, actor, connectionId);
    // A new destination keeps its pending items (they go to the new place) but no finished dedup history, so a real alert
    // to it is never suppressed by one the old destination got.
    if (change.destinationChanged) db.prepare("DELETE FROM alert_outbox WHERE connection_id=? AND status<>'pending'").run(connectionId);
    // A replaced secret also removes the frozen 2.8 row that still holds the old one (docs, "Rollback").
    if (change.replaced) purgeLegacyCredential(legacyCredentialId(row));
  });
  if (change?.replaced) scrubbing(write); else sealedWrite(write);
  const fields = [...(body.data.name !== undefined && body.data.name !== row.name ? ['name'] : []), ...(change?.changed ?? [])].slice(0, 16);
  audit(actor, 'connection.update', connectionId, { provider: item.id, fields, role }); // field names only, never values
  return viewFor(getConnection(connectionId), role);
}

export function deleteConnection(connectionId, actor, { role, recent }) {
  const row = mustConnection(connectionId);
  if (provider(row.provider)?.adminOnly && role !== 'admin') throw adminRequired();
  const nodes = nodesUsing(connectionId);
  if (nodes.length) throw httpError(409, `This connection is used by ${nodes.map(node => `"${node.name}"`).join(', ')}. Choose another connection on ${nodes.length === 1 ? 'that node' : 'those nodes'} first.`, { code: 'CONNECTION_IN_USE', nodes: nodes.map(node => node.name) });
  if (!recent) throw reauthRequired();
  scrubbing(() => transaction(() => { db.prepare('DELETE FROM connections WHERE id=?').run(connectionId); purgeLegacyCredential(legacyCredentialId(row)); }));
  audit(actor, 'connection.delete', connectionId, { provider: row.provider, role });
  return { deleted: true };
}

// The answer to a test that went through. WhatsApp and Teams only learn that the service took the message.
const passed = item => ({ ok: true, delivered: !item.testNote, ...(item.testNote ? { note: item.testNote } : {}) });
const failedSentence = (error, role) => (role === 'admin' ? (error instanceof DeliveryError ? error.message : 'The test message could not be sent.') : OPERATOR_TEST_FAILED);
const testFailed = message => httpError(502, message, { code: 'TEST_FAILED' });

export async function testConnection(connectionId, actor, { role }) {
  const row = mustConnection(connectionId), item = provider(row.provider);
  if (!item) throw httpError(409, 'This kind of connection is not supported any more.');
  try { await sendWith(row, testMessage()); }
  catch (error) {
    const message = failedSentence(error, role);
    recordConnectionTest(connectionId, false, message); audit(actor, 'connection.test', connectionId, { provider: item.id, ok: false, role });
    throw testFailed(message);
  }
  recordConnectionTest(connectionId, true); audit(actor, 'connection.test', connectionId, { provider: item.id, ok: true, role });
  return passed(item);
}

// "Send test" with unsaved values: sent once, stored nowhere. Editing a saved Connection merges its saved secrets by the
// same rules as a save (a changed host needs them typed again). Private addresses follow who would save it now.
export async function testValues(input, actor, { role, recent }) {
  const body = z.object({ provider: z.string().max(32), name: z.string().max(200).optional(), values: values.default({}), connectionId: z.uuid().optional() }).strict().safeParse(input); if (!body.success) throw issue(body.error);
  const item = mustProvider(body.data.provider);
  if (item.adminOnly && role !== 'admin') throw adminRequired();
  let secret, settings, privateOk;
  if (body.data.connectionId) {
    const row = mustConnection(body.data.connectionId); if (row.provider !== item.id) throw httpError(400, 'This connection is for another provider.');
    const change = merge(item, row, body.data.values); ({ secret, settings } = change);
    // A saved login sent to a new destination (another chat, recipient or number) is the same act as saving that
    // destination, so it needs the same recent re-verification.
    if (change.destinationChanged && !recent) throw reauthRequired();
    privateOk = privateOkFor({ provider: item, role, hostChanged: change.hostChanged, previous: row.private_ok });
  } else { ({ secret, settings } = parseValues(item, body.data.values)); privateOk = privateOkFor({ provider: item, role }); }
  const probe = { id: 'unsaved', provider: item.id, secret: seal(JSON.stringify(secret)), settings: JSON.stringify(settings), private_ok: privateOk };
  try { await sendWith(probe, testMessage()); }
  catch (error) { audit(actor, 'connection.test', body.data.connectionId ?? null, { provider: item.id, ok: false, unsaved: true, role }); throw testFailed(failedSentence(error, role)); }
  audit(actor, 'connection.test', body.data.connectionId ?? null, { provider: item.id, ok: true, unsaved: true, role });
  return passed(item);
}

// ---- Nodes -------------------------------------------------------------------------------------------------------
// A node is one provider plus one Connection of that provider. Without one it sends nothing and shows "Needs a
// connection"; `prefill` keeps a 2.8 destination (a chat ID, recipients) so "New connection" can offer it. No secrets.
export function nodeView(row) {
  const connection = row.connection_id ? getConnection(row.connection_id) : null, usable = connection && connection.provider === row.provider ? connection : null;
  const prefill = row.prefill ? parsed(row.prefill) : null;
  return {
    id: row.id, provider: row.provider, name: row.name, connectionId: usable?.id ?? null, connectionName: usable?.name ?? null, needsConnection: !usable,
    prefill: prefill && typeof prefill === 'object' ? prefill : null, createdAt: row.created_at, updatedAt: row.updated_at,
    lastSend: usable?.last_send ?? null, lastSendAt: usable?.last_send_at ?? null, sendError: usable?.last_send === 'failed' ? resultErrors(usable).sendError ?? SEND_FAILED : null,
  };
}
export const listNodes = () => db.prepare('SELECT * FROM alert_nodes ORDER BY created_at,id').all().map(nodeView);
const getNode = nodeId => db.prepare('SELECT * FROM alert_nodes WHERE id=?').get(nodeId) ?? null;
const mustNode = nodeId => getNode(nodeId) ?? (() => { throw httpError(404, 'This alert node does not exist.'); })();
function connectionFor(item, connectionId) {
  if (connectionId === null || connectionId === undefined) return null;
  const connection = getConnection(connectionId);
  if (!connection) throw httpError(404, 'This connection does not exist.', { field: 'connectionId' });
  if (connection.provider !== item.id) throw httpError(400, `Choose a ${item.label} connection for this node.`, { field: 'connectionId' });
  return connection;
}
const nodeBody = z.object({ name: nameField, provider: z.string().max(32), connectionId: z.uuid().nullable().default(null) }).strict();

export function createNode(input, actor, { role }) {
  const body = nodeBody.safeParse(input); if (!body.success) throw issue(body.error);
  const item = mustProvider(body.data.provider), connection = connectionFor(item, body.data.connectionId);
  if (db.prepare('SELECT COUNT(*) AS n FROM alert_nodes').get().n >= connectionLimits.nodes) throw httpError(409, `You can have up to ${connectionLimits.nodes} alert nodes.`);
  const nodeId = id(), at = now();
  db.prepare('INSERT INTO alert_nodes(id,provider,name,connection_id,prefill,created_at,updated_at) VALUES(?,?,?,?,NULL,?,?)').run(nodeId, item.id, body.data.name, connection?.id ?? null, at, at);
  audit(actor, 'alert.node.create', nodeId, { provider: item.id, role });
  return nodeView(getNode(nodeId));
}

// Changing a node's provider clears its Connection unless one of the new provider comes with it.
export function updateNode(nodeId, input, actor, { role }) {
  const row = mustNode(nodeId);
  const body = z.object({ name: nameField.optional(), provider: z.string().max(32).optional(), connectionId: z.uuid().nullable().optional() }).strict().safeParse(input); if (!body.success) throw issue(body.error);
  const item = mustProvider(body.data.provider ?? row.provider), providerChanged = item.id !== row.provider;
  const connectionId = body.data.connectionId !== undefined ? body.data.connectionId : providerChanged ? null : row.connection_id;
  const connection = connectionFor(item, connectionId);
  transaction(() => {
    db.prepare('UPDATE alert_nodes SET name=?,provider=?,connection_id=?,prefill=?,updated_at=? WHERE id=?').run(body.data.name ?? row.name, item.id, connection?.id ?? null, connection || providerChanged ? null : row.prefill, now(), nodeId);
    // Its pending items follow it to the new Connection when no other node is left on the old one (as a 2.8 node's queue).
    if (connection && row.connection_id && connection.id !== row.connection_id) carryPending(row.connection_id, connection.id, nodeId);
  });
  const fields = Object.keys(body.data).filter(key => key !== 'name' || body.data.name !== row.name);
  audit(actor, 'alert.node.update', nodeId, { provider: item.id, fields, role });
  return nodeView(getNode(nodeId));
}

// Removes the node and its lines (ON DELETE CASCADE). Its Connection stays; its outbox rows keep their dedup history.
export function deleteNode(nodeId, actor, { role }) {
  const row = mustNode(nodeId);
  db.prepare('DELETE FROM alert_nodes WHERE id=?').run(nodeId);
  audit(actor, 'alert.node.delete', nodeId, { provider: row.provider, role });
  return { deleted: true };
}

export async function testNode(nodeId, actor, { role }) {
  const row = mustNode(nodeId), connection = row.connection_id ? getConnection(row.connection_id) : null;
  if (!connection || connection.provider !== row.provider) throw httpError(400, 'Choose a connection for this node first.');
  const item = provider(row.provider);
  try { await sendWith(connection, testMessage()); }
  catch (error) {
    const message = failedSentence(error, role);
    recordConnectionTest(connection.id, false, message); audit(actor, 'alert.node.test', nodeId, { provider: row.provider, ok: false, role });
    throw testFailed(message);
  }
  recordConnectionTest(connection.id, true); audit(actor, 'alert.node.test', nodeId, { provider: row.provider, ok: true, role });
  return passed(item);
}

