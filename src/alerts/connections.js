// Connections (docs/alert-channels.md, "Data model" and "Sealed storage, redaction, audit and roles"). A Connection holds
// everything needed to reach one place: the login, sealed with the master key as one value (`secret`), and the plain
// destination (`settings`). A node on the Map is one provider plus one Connection.
// - `secret` is opened only at the moment of a send, a test or a view that shows sealed non-secret members (Email). It
//   is never returned, logged, audited or written to an error. Views carry plain fields and `<field>Set` flags.
// - `origin = legacy:<credentialId>` marks a Connection that came from (or through) a 2.8 credential. Replacing its secret
//   or deleting it also deletes that frozen 2.8 row, with secure_delete, so a removed secret leaves the live database.
import { db, audit } from '../db.js';
import { open } from '../crypto.js';
import { provider, sealedView } from './providers/index.js';

// "Allow private network" (docs/alert-channels.md, "Outbound safety"): off by default and when the row is missing, so
// an upgraded install behaves as before. Read at every send, so turning it off stops private sends at once.
export const PRIVATE_NETWORK_KEY = 'alerts_private_network';
export const allowPrivateNetwork = () => db.prepare('SELECT value FROM settings WHERE key=?').get(PRIVATE_NETWORK_KEY)?.value === 'true';
// Administrators only (the route in PR 4 adds the re-verification). Audited with the actor's role, never with values.
export function setAllowPrivateNetwork(enabled, actor, role) {
  if (role !== 'admin') throw Object.assign(new Error('Only an administrator can change this setting.'), { status: 403, code: 'ALERTS_ADMIN_REQUIRED' });
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(PRIVATE_NETWORK_KEY, enabled ? 'true' : 'false');
  audit(actor, 'alerts.private_network', null, { enabled: Boolean(enabled), role });
  return { allowPrivateNetwork: allowPrivateNetwork() };
}
// "Operators can manage alerts" (docs/alert-channels.md, "Who may do what"): off by default and when the row is missing,
// and the migration never sets it, so an upgraded install behaves as 2.8 (administrators only). Read at every request, so
// turning it off applies to an operator's very next request. Only an administrator changes it (the route adds the
// re-verification); audited with the actor's role, never with values.
export const OPERATORS_KEY = 'alerts_operators_manage';
export const operatorsManage = () => db.prepare('SELECT value FROM settings WHERE key=?').get(OPERATORS_KEY)?.value === 'true';
export function setOperatorsManage(enabled, actor, role) {
  if (role !== 'admin') throw Object.assign(new Error('Only an administrator can change this setting.'), { status: 403, code: 'ALERTS_ADMIN_REQUIRED' });
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(OPERATORS_KEY, enabled ? 'true' : 'false');
  audit(actor, 'alerts.operators_manage', null, { enabled: Boolean(enabled), role });
  return { operatorsManage: operatorsManage() };
}
// Whether this signed-in user may see and manage alerts now: administrators always, operators only with the setting on.
// The role always comes from the session (req.user), never from a request body.
export const canManageAlerts = user => user?.role === 'admin' || (user?.role === 'operator' && operatorsManage());
export const alertSettings = () => ({ allowPrivateNetwork: allowPrivateNetwork(), operatorsManage: operatorsManage() });

// The `private_ok` a save stamps (docs, "Data model"). It follows who last set the host or URL, not who saved last:
// - no host or URL change: the saved value stays (an operator renaming or changing recipients keeps an admin's server);
// - an operator setting a host or URL: 0;
// - Email: 1 when an administrator set the SMTP host (the 2.8 relay rule, independent of the setting);
// - a provider with fixed hosts (Telegram): 0, it never needs a private address;
// - an HTTP provider with a user host (`hosts: 'user'`): 1 only when an administrator set it while the setting was on.
// `provider` is a registry id, or a provider object (the registry entry itself).
export function privateOkFor({ provider: which, role, hostChanged = true, previous = 0 }) {
  if (!hostChanged) return Number(previous) === 1 ? 1 : 0;
  const item = typeof which === 'string' ? provider(which) : which;
  if (role !== 'admin' || !item) return 0;
  if (item.id === 'email') return 1;
  let hosts; try { hosts = item.target({}).hosts; } catch { hosts = null; }
  return hosts === 'user' && allowPrivateNetwork() ? 1 : 0;
}
// Whether a send through this Connection may reach a private address now: stamped, and the setting on at this moment.
export const privateAllowed = row => Number(row?.private_ok) === 1 && allowPrivateNetwork();

export const connectionLimits = Object.freeze({ connections: 60, nodes: 40, lines: 200 });
export const getConnection = connectionId => db.prepare('SELECT * FROM connections WHERE id=?').get(connectionId) ?? null;
export const openSecret = row => JSON.parse(open(row.secret));
export const nodesUsing = connectionId => db.prepare('SELECT id,name FROM alert_nodes WHERE connection_id=? ORDER BY name,id').all(connectionId).map(node => ({ id: node.id, name: node.name }));
export const legacyOrigin = credentialId => `legacy:${credentialId}`;
export const legacyCredentialId = row => (typeof row?.origin === 'string' && row.origin.startsWith('legacy:') ? row.origin.slice(7) : null);
const parsed = text => { try { return JSON.parse(text); } catch { return null; } };

// `last_error` is one column for tests and sends. It holds the sentence of the most recent failure of either kind, so a
// view gives each failed result its own sentence only when it is that most recent failure; an older failure (or a 2.8
// credential whose error was not copied at the upgrade) shows a fixed sentence instead of someone else's error.
export const TEST_FAILED = 'The last test did not go through.', SEND_FAILED = 'The last message could not be sent.';
export function resultErrors(row) {
  const testAt = Date.parse(row.last_test_at ?? '') || 0, sendAt = Date.parse(row.last_send_at ?? '') || 0;
  const latest = row.last_test === 'failed' && (row.last_send !== 'failed' || testAt >= sendAt) ? 'test' : row.last_send === 'failed' ? 'send' : null;
  return {
    testError: row.last_test === 'failed' ? (latest === 'test' && row.last_error) || TEST_FAILED : null,
    sendError: row.last_send === 'failed' ? (latest === 'send' && row.last_error) || SEND_FAILED : null,
    lastError: row.last_error,
  };
}
// The redacted view. Never carries `secret`; Email shows its sealed server fields as the 2.8 credential view did.
export function connectionView(row) {
  const item = provider(row.provider);
  let sealed = null; try { if (item) sealed = sealedView(row.provider, openSecret(row)); } catch { sealed = null; }
  return {
    id: row.id, provider: row.provider, name: row.name, values: { ...(sealed ?? {}), ...(parsed(row.settings) ?? {}) }, secretReadable: sealed !== null,
    usedBy: nodesUsing(row.id), createdAt: row.created_at, updatedAt: row.updated_at,
    lastTest: row.last_test, lastTestAt: row.last_test_at, lastSend: row.last_send, lastSendAt: row.last_send_at, ...resultErrors(row),
  };
}
export const listConnections = () => db.prepare('SELECT * FROM connections ORDER BY created_at,id').all().map(connectionView);

export function insertConnection({ id, provider: providerId, name, secret, settings, origin = null, privateOk = false, actor = null, at = new Date().toISOString() }) {
  if (!provider(providerId)) throw new Error('Unknown alert provider');
  db.prepare('INSERT INTO connections(id,provider,name,secret,settings,origin,private_ok,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, providerId, name, secret, JSON.stringify(settings), origin, privateOk ? 1 : 0, actor, actor, at, at);
  return getConnection(id);
}
// Every write to a row that holds a sealed value runs with secure_delete on: SQLite rewrites the whole row on any UPDATE,
// so without it the old copy (with the old sealed value) would stay in the page's free space.
export function sealedWrite(fn) {
  const [before] = Object.values(db.prepare('PRAGMA secure_delete').get());
  db.exec('PRAGMA secure_delete=ON');
  try { return fn(); } finally { db.exec(`PRAGMA secure_delete=${Number(before) === 1 ? 'ON' : Number(before) === 2 ? 'FAST' : 'OFF'}`); }
}
export function recordConnectionTest(connectionId, ok, error = null) {
  // A passing test keeps the sentence of a failed real send (the warning panel still needs it), and the other way round.
  sealedWrite(() => db.prepare("UPDATE connections SET last_test=?,last_test_at=?,last_error=CASE WHEN ?=1 THEN (CASE WHEN last_send='failed' AND COALESCE(last_send_at,'')>=COALESCE(last_test_at,'') THEN last_error END) ELSE ? END WHERE id=?").run(ok ? 'ok' : 'failed', new Date().toISOString(), ok ? 1 : 0, ok ? null : String(error ?? 'The check failed.').slice(0, 200), connectionId));
}
export function recordConnectionSend(connectionId, ok, error = null) {
  sealedWrite(() => db.prepare("UPDATE connections SET last_send=?,last_send_at=?,last_error=CASE WHEN ?=1 THEN (CASE WHEN last_test='failed' AND COALESCE(last_test_at,'')>=COALESCE(last_send_at,'') THEN last_error END) ELSE ? END WHERE id=?").run(ok ? 'ok' : 'failed', new Date().toISOString(), ok ? 1 : 0, ok ? null : String(error ?? 'The message could not be sent.').slice(0, 200), connectionId));
}

// Replacing or deleting a sealed value: secure_delete zeroes the freed space, then a checkpoint moves the old page images
// out of the WAL file. Pre-upgrade snapshots and older self-backups still hold old values (docs/alert-channels.md says so).
export function scrubbing(fn) {
  const result = sealedWrite(fn);
  if (!db.isTransaction) { try { db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); } catch { /* a busy reader: the next checkpoint does it */ } }
  return result;
}
// Deletes the frozen 2.8 credential row a Connection came from. Its 2.8 nodes lose it by their own ON DELETE SET NULL, so
// after a downgrade they show "Needs a credential" and send nothing, instead of sending with a secret that was removed.
export function purgeLegacyCredential(credentialId) {
  if (credentialId) db.prepare('DELETE FROM alert_credentials WHERE id=?').run(credentialId);
}

// True when an older DockNest changed the frozen 2.8 alert tables after they were copied (a downgrade, then changes, then
// this version again). Those changes are not copied twice; the Connections page warns about them (docs, "Rollback").
export function legacyChangedSinceImport() {
  const imported = db.prepare('SELECT imported_at FROM alert_legacy_import WHERE id=1').get()?.imported_at; if (!imported) return false;
  const newest = db.prepare('SELECT MAX(at) AS at FROM (SELECT MAX(updated_at) AS at FROM alert_credentials UNION ALL SELECT MAX(updated_at) FROM alert_channels UNION ALL SELECT MAX(updated_at) FROM alert_rules)').get().at;
  return Boolean(newest) && newest > imported;
}
