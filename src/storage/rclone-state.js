// Database side of a cloud-drive destination: its sealed credential, the refreshed token rclone hands back, and the
// "needs reconnect" state. The adapter (rclone.js) stays free of SQL.
import { db, audit } from '../db.js';
import { seal, open } from '../crypto.js';

export const RECONNECT_STATUS = 'needs_reconnect';
const row = targetId => db.prepare("SELECT credential,status FROM storage_targets WHERE id=? AND auth_type='rclone'").get(targetId);
export function loadSecrets(targetId) {
  const found = row(targetId);
  if (!found) return null;
  return JSON.parse(open(found.credential));
}
export function settingsOf(targetId) {
  try { return JSON.parse(db.prepare('SELECT settings FROM storage_target_settings WHERE target_id=?').get(targetId)?.settings || 'null'); } catch { return null; }
}
function writeSettings(targetId, patch) {
  const settings = { ...(settingsOf(targetId) ?? {}), ...patch };
  db.prepare("INSERT INTO storage_target_settings VALUES(?,'rclone',?) ON CONFLICT(target_id) DO UPDATE SET settings=excluded.settings").run(targetId, JSON.stringify(settings));
}
// rclone refreshed the access token during an operation: keep the new one (sealed) so the next operation starts from it.
export function saveToken(targetId, token) {
  const secrets = loadSecrets(targetId);
  if (!secrets) return false;
  db.prepare('UPDATE storage_targets SET credential=? WHERE id=?').run(seal(JSON.stringify({ ...secrets, token })), targetId);
  writeSettings(targetId, { tokenExpiresAt: token.expiry || null });
  return true;
}
// Reconnect replaces only the token (and the owner's own app credentials when new ones were given) and clears the state.
export function replaceToken(targetId, token, client, actor) {
  const secrets = loadSecrets(targetId);
  if (!secrets) return false;
  const next = { ...secrets, token, ...(client?.clientId ? { clientId: client.clientId, clientSecret: client.clientSecret } : {}) };
  db.prepare("UPDATE storage_targets SET credential=?,status='connected' WHERE id=?").run(seal(JSON.stringify(next)), targetId);
  writeSettings(targetId, { tokenExpiresAt: token.expiry || null, ...(client?.clientId ? { clientIdSet: true } : {}) });
  audit(actor, 'storage.reconnected', targetId, {});
  return true;
}
// Found by a real operation or a test, never by polling. One audit row per outage: the alert detector reads it, and the
// status itself dedupes until the owner reconnects.
export function markReconnect(targetId) {
  const found = row(targetId);
  if (!found || found.status === RECONNECT_STATUS) return false;
  db.prepare('UPDATE storage_targets SET status=? WHERE id=?').run(RECONNECT_STATUS, targetId);
  audit('system', 'storage.reconnect_needed', targetId, {});
  return true;
}
