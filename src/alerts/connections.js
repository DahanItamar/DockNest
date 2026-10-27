// Connections (docs/alert-channels.md, "Data model" and "Sealed storage, redaction, audit and roles"). A Connection holds
// everything needed to reach one place: the login, sealed with the master key as one value (`secret`), and the plain
// destination (`settings`). A node on the Map is one provider plus one Connection.
// - `secret` is opened only at the moment of a send, a test or a view that shows sealed non-secret members (Email). It
//   is never returned, logged, audited or written to an error. Views carry plain fields and `<field>Set` flags.
// - `origin = legacy:<credentialId>` marks a Connection that came from (or through) a 2.8 credential. Replacing its secret
//   or deleting it also deletes that frozen 2.8 row, with secure_delete, so a removed secret leaves the live database.
import { db } from '../db.js';
import { open } from '../crypto.js';
import { provider, sealedView } from './providers/index.js';

export const connectionLimits = Object.freeze({ connections: 60, nodes: 40, lines: 200 });
export const getConnection = connectionId => db.prepare('SELECT * FROM connections WHERE id=?').get(connectionId) ?? null;
export const openSecret = row => JSON.parse(open(row.secret));
export const nodesUsing = connectionId => db.prepare('SELECT id,name FROM alert_nodes WHERE connection_id=? ORDER BY name,id').all(connectionId).map(node => ({ id: node.id, name: node.name }));
export const legacyOrigin = credentialId => `legacy:${credentialId}`;
export const legacyCredentialId = row => (typeof row?.origin === 'string' && row.origin.startsWith('legacy:') ? row.origin.slice(7) : null);
const parsed = text => { try { return JSON.parse(text); } catch { return null; } };

// The redacted view. Never carries `secret`; Email shows its sealed server fields as the 2.8 credential view did.
export function connectionView(row) {
  const item = provider(row.provider);
  let sealed = null; try { if (item) sealed = sealedView(row.provider, openSecret(row)); } catch { sealed = null; }
  return {
    id: row.id, provider: row.provider, name: row.name, values: { ...(sealed ?? {}), ...(parsed(row.settings) ?? {}) }, secretReadable: sealed !== null,
    usedBy: nodesUsing(row.id), createdAt: row.created_at, updatedAt: row.updated_at,
    lastTest: row.last_test, lastTestAt: row.last_test_at, lastSend: row.last_send, lastSendAt: row.last_send_at, lastError: row.last_error,
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
  sealedWrite(() => db.prepare('UPDATE connections SET last_test=?,last_test_at=?,last_error=? WHERE id=?').run(ok ? 'ok' : 'failed', new Date().toISOString(), ok ? null : String(error ?? 'The check failed.').slice(0, 200), connectionId));
}
export function recordConnectionSend(connectionId, ok, error = null) {
  sealedWrite(() => db.prepare('UPDATE connections SET last_send=?,last_send_at=?,last_error=? WHERE id=?').run(ok ? 'ok' : 'failed', new Date().toISOString(), ok ? null : String(error ?? 'The message could not be sent.').slice(0, 200), connectionId));
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
