// Append-only SFTP destinations (docs/storage-backends.md, "Append-only SFTP"). The write mode is what the last connection
// test detected, kept in storage_target_settings (kind 'sftp'); no row means normal, so destinations saved by an older
// release keep working exactly as before. Only a test (add, Test, Use for backups) sets or clears append-only.
// deletesRefusedAt: a normal destination refused a delete since its last test. DockNest then stops deleting there too,
// and asks the owner to test it again instead of assuming its mode changed.
// Leftovers: probe and .partial files that a destination keeps. They are listed (setting 'storage_leftovers', paths only)
// so the owner can expire them on the server; DockNest never retries them on its own.
import { db, audit, transaction } from '../db.js';

const LEFTOVERS = 'storage_leftovers', MAX_LEFTOVERS = 500;
// Callable inside a caller's transaction (adding a destination records its mode in the same one).
const atomic = fn => db.isTransaction ? fn() : transaction(fn);
// The retry date of a retention deferral (and a copy's delete_after) that the storage keeps: never due by itself.
// Released by a test that finds the destination normal again (releaseKept).
export const KEPT_UNTIL_RETEST = Number.MAX_SAFE_INTEGER;
export const KEPT_BY_STORAGE = 'EKEPTBYSTORAGE';
export const keptByStorage = error => error?.code === KEPT_BY_STORAGE;
export const keptError = () => Object.assign(new Error('This destination is append-only: DockNest does not delete files on it. Expire old files on the storage server.'), { code: KEPT_BY_STORAGE });

function stored(targetId) {
  const row = db.prepare("SELECT settings FROM storage_target_settings WHERE target_id=? AND kind='sftp'").get(targetId);
  if (!row) return {};
  try { const value = JSON.parse(row.settings); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
export function writeMode(targetId) {
  const value = stored(targetId), mode = value.writeMode === 'append-only' ? 'append-only' : 'normal';
  const deletesRefusedAt = typeof value.deletesRefusedAt === 'string' ? value.deletesRefusedAt : null;
  return { writeMode: mode, checkedAt: typeof value.checkedAt === 'string' ? value.checkedAt : null, deletesRefusedAt, keepsFiles: mode === 'append-only' || Boolean(deletesRefusedAt) };
}
const save = (targetId, value) => db.prepare("INSERT INTO storage_target_settings VALUES(?,'sftp',?) ON CONFLICT(target_id) DO UPDATE SET settings=excluded.settings WHERE kind='sftp'").run(targetId, JSON.stringify(value));

// After a test of a saved SFTP destination. Returns the previous mode so the caller can release what was kept.
export function recordWriteMode(targetId, mode, actor = 'system', at = new Date().toISOString()) {
  return atomic(() => {
    const previous = writeMode(targetId);
    save(targetId, { writeMode: mode === 'append-only' ? 'append-only' : 'normal', checkedAt: at });
    if (previous.writeMode !== mode || previous.deletesRefusedAt) audit(actor, 'storage.write_mode', targetId, { from: previous.writeMode, to: mode, ...(previous.deletesRefusedAt ? { deletesWereRefused: true } : {}) });
    return previous;
  });
}
export function markDeletesRefused(targetId, at = new Date().toISOString()) {
  atomic(() => {
    if (!db.prepare('SELECT 1 FROM storage_targets WHERE id=?').get(targetId)) return;
    const value = stored(targetId);
    if (value.deletesRefusedAt) return;
    save(targetId, { ...value, writeMode: value.writeMode === 'append-only' ? 'append-only' : 'normal', deletesRefusedAt: at });
    audit('worker', 'storage.delete_refused', targetId, {});
  });
}

export function leftovers(targetId = null) {
  let list = [];
  try { const value = JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(LEFTOVERS)?.value ?? '[]'); if (Array.isArray(value)) list = value; } catch { /* unreadable: treated as empty */ }
  return targetId ? list.filter(item => item.targetId === targetId) : list;
}
const writeLeftovers = list => db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(LEFTOVERS, JSON.stringify(list.slice(-MAX_LEFTOVERS)));
// `files`: storage references (scheme:target:/path). Recorded once each; the newest MAX_LEFTOVERS are kept.
export function recordLeftovers(targetId, files, at = new Date().toISOString()) {
  if (!files.length) return 0;
  return atomic(() => {
    const list = leftovers(), known = new Set(list.map(item => item.path));
    const added = files.filter(file => !known.has(file)).map(file => ({ targetId, path: file, at }));
    if (!added.length) return 0;
    writeLeftovers([...list, ...added]);
    audit('worker', 'storage.leftovers_kept', targetId, { count: added.length });
    return added.length;
  });
}
export const forgetLeftovers = paths => atomic(() => { const gone = new Set(paths); writeLeftovers(leftovers().filter(item => !gone.has(item.path))); });

// A test found the destination normal again: what retention left for the storage to keep is due at the next retention
// run, and copies return to their destination's count. Returns how many backups and copies were released.
export function releaseKept(targetId, prefix) {
  return atomic(() => {
    const backups = db.prepare('DELETE FROM retention_deferrals WHERE retry_after=? AND backup_id IN (SELECT id FROM backups WHERE path LIKE ?)').run(KEPT_UNTIL_RETEST, prefix + '%').changes;
    const copies = db.prepare("UPDATE backup_copies SET delete_state=NULL,delete_after=NULL,updated_at=? WHERE target_id=? AND delete_state='deferred' AND delete_after=?").run(new Date().toISOString(), targetId, KEPT_UNTIL_RETEST).changes;
    return { backups, copies };
  });
}
// What a destination keeps that DockNest would otherwise have deleted, for the Storage pages.
export function keptSummary(targetId, prefix) {
  const main = db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(b.size),0) AS bytes FROM retention_deferrals d JOIN backups b ON b.id=d.backup_id WHERE d.retry_after=? AND b.path LIKE ? AND b.id NOT IN (SELECT backup_id FROM backup_main_removed)').get(KEPT_UNTIL_RETEST, prefix + '%');
  const copies = db.prepare("SELECT COUNT(*) AS n,COALESCE(SUM(b.size),0) AS bytes FROM backup_copies c JOIN backups b ON b.id=c.backup_id WHERE c.target_id=? AND c.status='verified' AND c.delete_state='deferred' AND c.delete_after=?").get(targetId, KEPT_UNTIL_RETEST);
  return { backups: main.n + copies.n, bytes: main.bytes + copies.bytes, leftovers: leftovers(targetId).length };
}
