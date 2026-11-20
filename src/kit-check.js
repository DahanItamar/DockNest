// Kit check (docs/emergency-kit.md, "Kit check"): proof that the newest Self Backup recovery kit opens. After every
// completed Self Backup, and on "Check now", the worker reads the newest kit (as a download would, size capped and
// checksum verified), decrypts it in memory with the passphrase DockNest keeps, checks the kit's own hashes, compares
// its master key with the live one by SHA-256 and runs SQLite integrity_check on its state.sqlite in a 0700 folder under
// the worker's private kit folder, removed in every case. The result (time, result, reason code) goes in kit_checks; a
// failure raises selfbackup.kit_check_failed. This proves DockNest's copy of the passphrase, never the owner's own copy.
import { db, id, audit, transaction } from './db.js';
import { key, open } from './crypto.js';
import { checkRecoveryKit } from './recovery-kit.js';
import { selfBackupConfig, readLatestSelfBackup, selfBackupDirectory } from './self-backup.js';
import { emit } from './alerts/delivery.js';

const KEEP = 50, now = () => new Date().toISOString();
const httpError = (status, message) => Object.assign(new Error(message), { status });
const active = () => db.prepare("SELECT * FROM kit_checks WHERE result IN ('queued','running')").get();

export function kitCheckStatus() {
  const last = db.prepare("SELECT * FROM kit_checks WHERE result IN ('passed','failed') ORDER BY checked_at DESC,rowid DESC LIMIT 1").get();
  return { last: last ? { checkedAt: last.checked_at, result: last.result, reason: last.reason } : null, active: Boolean(active()) };
}
export function queueKitCheck(actor) {
  return transaction(() => {
    if (active()) throw httpError(409, 'A kit check is already queued or running.');
    if (!db.prepare("SELECT 1 FROM manager_backups WHERE status='completed'").get()) throw httpError(409, 'Run a Self Backup first: there is no recovery kit to check yet.');
    const checkId = id();
    db.prepare("INSERT INTO kit_checks(id,requested_by,created_at,result) VALUES(?,?,?,'queued')").run(checkId, actor, now());
    audit(actor, 'manager-backup.kit_check_queued', checkId);
    return { id: checkId, result: 'queued' };
  });
}
// The worker queues one after each completed Self Backup; a check already waiting covers that kit too.
export function queueKitCheckAfterBackup() {
  try { queueKitCheck('worker'); } catch (error) { if (error.status !== 409) throw error; }
}
export const claimKitCheck = () => transaction(() => {
  const check = db.prepare("SELECT * FROM kit_checks WHERE result='queued' ORDER BY created_at,rowid LIMIT 1").get();
  if (check) db.prepare("UPDATE kit_checks SET result='running' WHERE id=?").run(check.id);
  return check ?? null;
});
// A check interrupted with its worker runs again.
export const requeueInterruptedKitChecks = () => db.prepare("UPDATE kit_checks SET result='queued' WHERE result='running'").run();

async function outcome() {
  const saved = selfBackupConfig();
  if (!saved?.passphrase) return { passed: false, reason: 'no_passphrase', backupId: null };
  let kit;
  try { kit = await readLatestSelfBackup(); } catch (error) { return { passed: false, reason: error.status === 404 ? 'no_kit' : 'unreadable', backupId: null }; }
  const result = await checkRecoveryKit({ bytes: kit.bytes, passphrase: open(saved.passphrase), masterKey: key(), parent: await selfBackupDirectory() });
  return { ...result, backupId: kit.id };
}
export async function executeKitCheck(check) {
  let result;
  try { result = await outcome(); } catch { result = { passed: false, reason: 'error', backupId: null }; }
  const at = now(), state = result.passed ? 'passed' : 'failed';
  transaction(() => {
    if (!db.prepare("UPDATE kit_checks SET result=?,reason=?,checked_at=?,backup_id=? WHERE id=? AND result='running'").run(state, result.reason, at, result.backupId, check.id).changes) return;
    audit('worker', 'manager-backup.kit_check', check.id, { result: state, ...(result.reason ? { reason: result.reason } : {}) });
    if (!result.passed) emit({ type: 'selfbackup.kit_check_failed', key: `occ:kit-check:${check.id}`, at, code: result.reason, timeZone: selfBackupConfig()?.timezone ?? 'UTC' });
    db.prepare(`DELETE FROM kit_checks WHERE result IN ('passed','failed') AND id NOT IN (SELECT id FROM kit_checks WHERE result IN ('passed','failed') ORDER BY checked_at DESC,rowid DESC LIMIT ${KEEP})`).run();
  });
}
