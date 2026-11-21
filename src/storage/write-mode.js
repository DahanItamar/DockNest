// Append-only SFTP destinations (docs/storage-backends.md, "Append-only SFTP"). The write mode is what the last connection
// test detected, kept in storage_target_settings (kind 'sftp'); no row means normal, so destinations saved by an older
// release keep working exactly as before. Only a test (add, Test, Use for backups) sets or clears append-only. The SFTP
// destination configured by environment variables is never tested for its mode and stays normal.
// deletesRefusedAt: a normal destination refused a delete since its last test. DockNest then stops deleting there too,
// and asks the owner to test it again instead of assuming its mode changed.
// unverifiedAt: the last test found deletes refused but files still changeable (broken). Everything is kept, the card
// warns instead of showing Append-only, and only a passing test clears it.
// unprotectedBefore: the destination became append-only while it already held DockNest files; files written before that
// test are protected only if the owner made them read-only on the server.
// Leftovers: probe and .partial files that a destination keeps. They are listed (setting 'storage_leftovers', paths only)
// so the owner can expire them on the server; DockNest never retries them on its own.
import { db, audit, transaction } from '../db.js';

const LEFTOVERS = 'storage_leftovers', DROPPED = 'storage_leftovers_dropped', MAX_LEFTOVERS = 500;
// Callable inside a caller's transaction (adding a destination records its mode in the same one).
const atomic = fn => db.isTransaction ? fn() : transaction(fn);
// The retry date of a retention deferral (and a copy's delete_after) that the storage keeps: never due by itself.
// Released by a test that finds the destination normal again (releaseKept).
export const KEPT_UNTIL_RETEST = Number.MAX_SAFE_INTEGER;
export const KEPT_BY_STORAGE = 'EKEPTBYSTORAGE';
export const keptByStorage = error => error?.code === KEPT_BY_STORAGE;
export const keptError = () => Object.assign(new Error('This destination keeps what it stores (append-only): DockNest does not delete files on it. Expire old files on the storage server.'), { code: KEPT_BY_STORAGE });

function stored(targetId) {
  const row = db.prepare("SELECT settings FROM storage_target_settings WHERE target_id=? AND kind='sftp'").get(targetId);
  if (!row) return {};
  try { const value = JSON.parse(row.settings); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
export function writeMode(targetId) {
  const value = stored(targetId), mode = value.writeMode === 'append-only' ? 'append-only' : 'normal';
  const text = key => typeof value[key] === 'string' ? value[key] : null, deletesRefusedAt = text('deletesRefusedAt'), unverifiedAt = text('unverifiedAt');
  return { writeMode: mode, checkedAt: text('checkedAt'), deletesRefusedAt, unverifiedAt, unprotectedBefore: mode === 'append-only' ? text('unprotectedBefore') : null, keepsFiles: mode === 'append-only' || Boolean(deletesRefusedAt || unverifiedAt) };
}
const save = (targetId, value) => db.prepare("INSERT INTO storage_target_settings VALUES(?,'sftp',?) ON CONFLICT(target_id) DO UPDATE SET settings=excluded.settings WHERE kind='sftp'").run(targetId, JSON.stringify(value));

// After a passing test of a saved SFTP destination. Returns the previous mode so the caller can release what was kept.
// holdsFiles: DockNest already stored files there, so a switch to append-only records unprotectedBefore.
export function recordWriteMode(targetId, mode, actor = 'system', at = new Date().toISOString(), { holdsFiles = false } = {}) {
  return atomic(() => {
    const previous = writeMode(targetId), appendOnly = mode === 'append-only';
    const unprotectedBefore = !appendOnly ? null : previous.writeMode === 'append-only' ? previous.unprotectedBefore : holdsFiles ? at : null;
    save(targetId, { writeMode: appendOnly ? 'append-only' : 'normal', checkedAt: at, ...(unprotectedBefore ? { unprotectedBefore } : {}) });
    if (previous.writeMode !== mode || previous.deletesRefusedAt || previous.unverifiedAt) audit(actor, 'storage.write_mode', targetId, { from: previous.writeMode, to: mode, ...(previous.deletesRefusedAt ? { deletesWereRefused: true } : {}), ...(previous.unverifiedAt ? { wasUnverified: true } : {}) });
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
// A test of a saved destination found it broken: its detected mode stays, but every file is kept until a test passes.
export function markUnverified(targetId, actor = 'system', at = new Date().toISOString()) {
  atomic(() => {
    if (!db.prepare('SELECT 1 FROM storage_targets WHERE id=?').get(targetId)) return;
    const value = stored(targetId);
    save(targetId, { ...value, writeMode: value.writeMode === 'append-only' ? 'append-only' : 'normal', unverifiedAt: at });
    if (!value.unverifiedAt) audit(actor, 'storage.write_mode_unverified', targetId, {});
  });
}

export function leftovers(targetId = null) {
  let list = [];
  try { const value = JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(LEFTOVERS)?.value ?? '[]'); if (Array.isArray(value)) list = value; } catch { /* unreadable: treated as empty */ }
  return targetId ? list.filter(item => item.targetId === targetId) : list;
}
const setting = (key, value) => db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
const droppedCounts = () => { try { const value = JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(DROPPED)?.value ?? '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } };
// Leftovers past the newest MAX_LEFTOVERS are no longer named, but still counted per destination.
export const droppedLeftovers = targetId => Number.isSafeInteger(droppedCounts()[targetId]) ? droppedCounts()[targetId] : 0;
function writeLeftovers(list) {
  const over = list.slice(0, Math.max(0, list.length - MAX_LEFTOVERS));
  if (over.length) {
    const counts = droppedCounts();
    for (const item of over) counts[item.targetId] = (Number.isSafeInteger(counts[item.targetId]) ? counts[item.targetId] : 0) + 1;
    setting(DROPPED, counts);
  }
  setting(LEFTOVERS, list.slice(-MAX_LEFTOVERS));
}
// `files`: storage references (scheme:target:/path). Recorded once each; the newest MAX_LEFTOVERS are named.
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
export const forgetLeftovers = paths => atomic(() => { const gone = new Set(paths); setting(LEFTOVERS, leftovers().filter(item => !gone.has(item.path))); });

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
  return { backups: main.n + copies.n, bytes: main.bytes + copies.bytes, leftovers: leftovers(targetId).length + droppedLeftovers(targetId) };
}
// Whether DockNest already stored files on a destination (main packages, copies, recovery kits).
export function holdsFiles(targetId, prefix) {
  return Boolean(db.prepare('SELECT 1 FROM backups WHERE path LIKE ? LIMIT 1').get(prefix + '%')
    || db.prepare("SELECT 1 FROM backup_copies WHERE target_id=? AND status<>'deleted' LIMIT 1").get(targetId)
    || db.prepare("SELECT 1 FROM manager_backups WHERE target_id=? AND status='completed' LIMIT 1").get(targetId)
    || db.prepare('SELECT 1 FROM manager_backup_copies WHERE target_id=? LIMIT 1').get(targetId));
}
