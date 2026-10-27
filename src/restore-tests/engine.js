// Automatic restore test engine (docs/restore-tests.md): test rows, the ticked step machine and its worker jobs.
// - tickRestoreTests() runs each worker tick. Every step that touches the test server is one short `restore-test` job
//   (statuses test_queued/test_running, which releases before 2.9.0 never claim). Waits for health and stability are
//   polls on later ticks, so the worker is never held for a whole test: between polls the check_health job rests in
//   test_waiting (never claimed) and the tick queues it again when the next poll is due, so a test leaves one job row
//   per step.
// - A started test holds its test server until its clean-up is done or acknowledged (src/restore-tests/hold.js). It
//   never makes its site busy, so a stuck clean-up blocks only the test server.
// - The result is written once (a trigger enforces it). Backup evidence is written only for passed and failed, and
//   never replaces evidence from another method (recordTestVerification).
// - Clean-up always runs once anything reached the server, also after a failure, cancel, time limit or restart.
import { readFile } from 'node:fs/promises';
import { db, id, audit, transaction } from '../db.js';
import { deploymentHeld } from '../deployment-hold.js';
import { transport, uploadBackupTo, jobRunners } from '../engine.js';
import { recordTestVerification, recordVerification } from '../recovery-evidence.js';
import { secretValue } from '../moves/state.js';
import { validateLimits, cpuProblem } from './limits.js';
import { heldBy } from './hold.js';

export const STEPS = Object.freeze(['check_space', 'copy_backup', 'restore_copy', 'start_containers', 'check_health', 'clean_up']);
export const LABELS = Object.freeze({ check_space: 'Check space', copy_backup: 'Copy backup', restore_copy: 'Restore copy', start_containers: 'Start containers', check_health: 'Check health', clean_up: 'Clean up' });
export const RESULTS = Object.freeze(['passed', 'failed', 'couldnt_run', 'cancelled']);
const NEXT = { check_space: 'copy_backup', copy_backup: 'restore_copy', restore_copy: 'start_containers', start_containers: 'check_health' };
// Seconds; tests shrink them with `testTiming.scale`.
export const testTiming = { scale: 1, stableSeconds: 60, pollSeconds: 10, cancelPollMs: 1000, cleanupSeconds: 600, retryMinutes: [5, 15, 60] };
// SSH and the clock; tests replace members.
export const testTransport = {
  remote: (server, request, options) => transport.remote(server, request, () => {}, () => {}, options),
  upload: uploadBackupTo,
  now: () => Date.now(),
};
// The reaper the helper starts on the test server is the reviewed helper itself.
const reaperSource = (await readFile(new URL('../../remote/helper.py', import.meta.url))).toString('base64');
const LOCKED = new Set(['restore-test-prepare', 'restore-test-run', 'restore-test-teardown']);
const iso = ms => new Date(ms).toISOString();
const clock = () => testTransport.now();
const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });
const server = serverId => db.prepare('SELECT * FROM servers WHERE id=?').get(serverId);

// ---------- reasons and checks ----------
// One plain sentence, at most 300 characters, with no data paths, URLs with credentials, tokens or keys.
export function plainReason(text, fallback = 'The test could not finish.') {
  let value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value || secretValue.test(value)) return fallback;
  value = value.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[address]').replace(/(?:\/[\w.@%+-]+){2,}\/?/g, '[path]');
  return value.length > 300 ? value.slice(0, 297) + '...' : value;
}
const CHECK_KINDS = new Set(['package', 'authentic', 'running', 'health', 'stable', 'database', 'sqlite', 'http', 'static-files']);
const CHECK_STATUS = new Set(['passed', 'failed', 'skipped', 'not-configured']);
function cleanChecks(list) {
  const checks = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || !CHECK_KINDS.has(item.kind) || !CHECK_STATUS.has(item.status)) continue;
    checks.push({ name: String(item.name ?? '').slice(0, 60), kind: item.kind, target: item.target == null ? null : String(item.target).slice(0, 80), status: item.status, detail: item.detail == null ? null : plainReason(item.detail, null)?.slice(0, 120) ?? null });
  }
  while (JSON.stringify(checks).length > 8000) checks.splice(Math.max(0, checks.length - 2), 1);
  return checks;
}

// ---------- persistence ----------
export function loadTest(testId) {
  const row = db.prepare('SELECT * FROM restore_tests WHERE id=?').get(testId);
  return row ? { ...row, limits: JSON.parse(row.limits), progress: JSON.parse(row.progress), checks: JSON.parse(row.checks), cancel_requested: !!row.cancel_requested } : null;
}
export const loadSteps = testId => db.prepare('SELECT * FROM restore_test_steps WHERE test_id=?').all(testId).sort((a, b) => STEPS.indexOf(a.step) - STEPS.indexOf(b.step));
const saveProgress = (test, changes) => { test.progress = { ...test.progress, ...changes }; db.prepare('UPDATE restore_tests SET progress=? WHERE id=?').run(JSON.stringify(test.progress), test.id); };
function setStep(testId, step, state, detail) {
  const at = iso(clock()), text = detail == null ? null : plainReason(detail, null);
  if (state === 'running') db.prepare('UPDATE restore_test_steps SET state=?,detail=COALESCE(?,detail),started_at=COALESCE(started_at,?),finished_at=NULL WHERE test_id=? AND step=?').run(state, text, at, testId, step);
  else if (state === 'skipped') db.prepare('UPDATE restore_test_steps SET state=?,detail=COALESCE(?,detail),finished_at=? WHERE test_id=? AND step=?').run(state, text, at, testId, step);
  else db.prepare('UPDATE restore_test_steps SET state=?,detail=COALESCE(?,detail),started_at=COALESCE(started_at,?),finished_at=? WHERE test_id=? AND step=?').run(state, text, at, at, testId, step);
}
const stepSeconds = (testId, names) => names.reduce((sum, name) => {
  const row = db.prepare('SELECT started_at,finished_at,state FROM restore_test_steps WHERE test_id=? AND step=?').get(testId, name);
  return sum + (row?.state === 'done' && row.started_at && row.finished_at ? Math.max(0, (Date.parse(row.finished_at) - Date.parse(row.started_at)) / 1000) : 0);
}, 0);

// ---------- creating a test ----------
// The newest verified backup that retention is not removing. (The scheduler and "Run test now" call this; PR C.)
export function latestTestableBackup(siteId) {
  return db.prepare('SELECT * FROM backups b WHERE b.site_id=? AND b.verified=1 AND NOT EXISTS (SELECT 1 FROM retention_operations r WHERE r.backup_id=b.id) ORDER BY b.captured_at DESC,b.id DESC LIMIT 1').get(siteId) ?? null;
}
export const needsExternalStorage = manifest => (manifest?.excludedPaths || manifest?.backupPlan?.coverage?.excludedPaths || []).some(item => item?.requiredForRestore);
export function createRestoreTest({ siteId, serverId, backupId = null, trigger = 'manual', limits = {}, internet = false, liveServer = false, probe = null, actor }) {
  if (!['schedule', 'manual'].includes(trigger)) throw httpError(400, 'INVALID', 'Unknown trigger.');
  const checked = validateLimits(limits);
  const site = db.prepare('SELECT * FROM sites WHERE id=?').get(siteId);
  if (!site) throw httpError(404, 'NOT_FOUND', 'Site not found.');
  if (db.prepare('SELECT 1 FROM site_archives WHERE site_id=?').get(siteId)) throw httpError(409, 'SITE_ARCHIVED', 'This site was removed from active sites.');
  const target = server(serverId);
  if (!target) throw httpError(409, 'NO_TEST_SERVER', 'Choose a test server first.');
  if (target.id === site.server_id && !liveServer) throw httpError(409, 'LIVE_SERVER_NOT_ALLOWED', 'Testing on the live server needs the live-server opt-in.');
  const backup = backupId ? db.prepare('SELECT * FROM backups WHERE id=? AND site_id=? AND verified=1').get(backupId, siteId) : latestTestableBackup(siteId);
  if (!backup || db.prepare('SELECT 1 FROM retention_operations WHERE backup_id=?').get(backup.id)) throw httpError(409, 'NO_VERIFIED_BACKUP', 'Not tested: no verified backup yet.');
  const manifest = JSON.parse(backup.manifest || '{}');
  if (needsExternalStorage(manifest)) throw httpError(409, 'EXTERNAL_STORAGE', 'This site needs external storage that a restore test cannot attach.');
  if (probe !== null && manifest.kind === 'static') throw httpError(409, 'PROBE_STATIC', 'A static site has no container for a web check.');
  const testId = id(), at = iso(clock());
  const record = { ...checked, internet: internet === true, liveServer: target.id === site.server_id, ...(probe ? { probe } : {}) };
  try {
    transaction(() => {
      db.prepare("INSERT INTO restore_tests(id,site_id,backup_id,backup_captured_at,server_id,trigger,limits,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(testId, siteId, backup.id, backup.captured_at, target.id, trigger, JSON.stringify(record), actor, at);
      for (const step of STEPS) db.prepare("INSERT INTO restore_test_steps(test_id,step,state) VALUES(?,?,'pending')").run(testId, step);
      audit(actor, 'restore_test.enqueue', siteId, { test: testId, trigger, backup: backup.id, server: target.id });
    });
  } catch (error) {
    if (/UNIQUE constraint failed: restore_tests\.site_id/.test(error.message)) throw httpError(409, 'TEST_ACTIVE', 'This site already has a restore test that has not finished.');
    throw error;
  }
  return { id: testId };
}
export function cancelRestoreTest(testId, actor) {
  const changed = db.prepare('UPDATE restore_tests SET cancel_requested=1 WHERE id=? AND result IS NULL AND cancel_requested=0').run(testId).changes;
  if (changed) audit(actor, 'restore_test.cancel_requested', testId, {});
  return { cancelRequested: !!changed || !!loadTest(testId)?.cancel_requested };
}

// ---------- verdicts and evidence ----------
function evidenceFor(test, result, failedStep, checks) {
  const base = { testId: test.id, internet: !!test.limits.internet, checks: checks.length };
  const evidence = [];
  const authentic = checks.find(item => item.kind === 'authentic');
  // A failed authentication is recorded at once like a scrub does (copy_backup), so only a pass is added here.
  if (authentic?.status === 'passed') evidence.push(['integrity', { ...base, status: 'passed' }]);
  if (result === 'passed') evidence.push(['isolatedRestore', { ...base, status: 'passed' }]);
  else if (failedStep !== 'copy_backup') evidence.push(['isolatedRestore', { ...base, status: 'failed', failedStep }]);
  const data = checks.filter(item => ['database', 'sqlite'].includes(item.kind));
  if (data.length) evidence.push(['application', { ...base, status: data.every(item => item.status === 'passed') ? (result === 'passed' ? 'passed' : 'partial') : 'failed', scope: 'configured database checks; application workflows need separate review' }]);
  return evidence;
}
// Writes the result once, skips the steps that will not run and leaves clean-up pending when the server was touched.
function conclude(test, result, { step = test.step, reason = null, checks = [] } = {}) {
  const all = cleanChecks([...(test.checks || []), ...(checks || [])]);
  const at = clock(), failedStep = result === 'passed' ? null : step;
  const restoreSeconds = loadSteps(test.id).find(row => row.step === 'start_containers')?.state === 'done' || (result === 'passed' && test.progress.kind === 'static') ? Math.round(stepSeconds(test.id, ['copy_backup', 'restore_copy', 'start_containers'])) : null;
  const text = result === 'passed' ? null : plainReason(reason, result === 'cancelled' ? 'The test was cancelled.' : 'The test could not finish.');
  return transaction(() => {
    const changed = db.prepare("UPDATE restore_tests SET result=?,failed_step=?,reason=?,checks=?,restore_seconds=?,total_seconds=?,finished_at=?,step='clean_up',cleanup=COALESCE(cleanup,'done') WHERE id=? AND result IS NULL")
      .run(result, failedStep, text, JSON.stringify(all), restoreSeconds, test.started_at ? Math.round((at - Date.parse(test.started_at)) / 1000) : 0, iso(at), test.id).changes;
    if (!changed) return false;
    db.prepare("UPDATE jobs SET status='completed',stage='completed',finished_at=? WHERE type='restore-test' AND json_extract(details,'$.testId')=? AND status='test_waiting'").run(iso(at), test.id);
    if (failedStep && failedStep !== 'clean_up') setStep(test.id, failedStep, result === 'cancelled' ? 'skipped' : 'failed', text);
    for (const row of loadSteps(test.id)) if (row.step !== 'clean_up' && ['pending', 'running'].includes(row.state)) setStep(test.id, row.step, 'skipped');
    const cleanup = db.prepare('SELECT cleanup FROM restore_tests WHERE id=?').get(test.id).cleanup;
    if (cleanup === 'done') setStep(test.id, 'clean_up', 'skipped', 'Nothing reached the test server.');
    if (['passed', 'failed'].includes(result) && test.backup_id) for (const [kind, evidence] of evidenceFor(test, result, failedStep, all)) recordTestVerification(test.backup_id, kind, evidence, test.job_id);
    audit('worker', 'restore_test.' + result, test.site_id, { test: test.id, ...(failedStep ? { step: failedStep } : {}), server: test.server_id });
    return true;
  });
}

// ---------- the tick ----------
const activeJob = testId => db.prepare("SELECT id,status FROM jobs WHERE type='restore-test' AND json_extract(details,'$.testId')=? AND status IN ('test_queued','test_running','test_waiting')").get(testId);
function ensureJob(test, step) {
  if (activeJob(test.id)) return;
  const jobId = id();
  transaction(() => {
    db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,'restore-test','test_queued',?,?,?)")
      .run(jobId, test.site_id, step, iso(clock()), JSON.stringify({ testId: test.id, step, targetServerId: test.server_id }));
    db.prepare('UPDATE restore_tests SET job_id=? WHERE id=?').run(jobId, test.id);
  });
}
// Backups go first: a test does not start while a backup on the test server is due within the test's time limit.
function backupDueOn(serverId, untilMs) {
  return !!db.prepare('SELECT 1 FROM policies p JOIN sites s ON s.id=p.site_id WHERE p.enabled=1 AND s.server_id=? AND p.next_run IS NOT NULL AND p.next_run<=? AND p.site_id NOT IN (SELECT site_id FROM site_archives)').get(serverId, iso(untilMs));
}
export function tickRestoreTests() {
  for (const { id: testId } of db.prepare("SELECT id FROM restore_tests WHERE result IS NULL OR cleanup='pending' ORDER BY created_at,id").all()) {
    try { advance(loadTest(testId)); } catch (error) { console.error(`Restore test ${testId} could not advance: ${error.code ?? error.name}`); }
  }
}
function advance(test) {
  const job = activeJob(test.id);
  if (test.result === null) {
    if (job && job.status !== 'test_waiting') return;
    if (!test.started_at) {
      if (test.cancel_requested) { conclude(test, 'cancelled', { step: null, reason: 'The test was cancelled before it started.' }); return; }
      if (deploymentHeld(db)) return;
      const holder = heldBy(test.server_id);
      if (holder && holder !== test.id) return;
      if (backupDueOn(test.server_id, clock() + test.limits.timeLimitMinutes * 60000)) return;
      ensureJob(test, 'check_space');
      return;
    }
    if (test.cancel_requested) { conclude(test, 'cancelled', { reason: 'The test was cancelled.' }); return; }
    if (clock() >= Date.parse(test.deadline_at)) { conclude(test, 'couldnt_run', { reason: `Test couldn't finish: time limit (${test.limits.timeLimitMinutes} minutes). Raise it in Advanced.` }); return; }
    if (test.step === 'check_health' && (test.progress.nextPollAt ?? 0) > clock()) return;
    if (job) { db.prepare("UPDATE jobs SET status='test_queued' WHERE id=? AND status='test_waiting'").run(job.id); return; }
    ensureJob(test, test.step);
    return;
  }
  if (test.cleanup === 'pending' && !job && (!test.cleanup_next_at || Date.parse(test.cleanup_next_at) <= clock())) ensureJob(test, 'clean_up');
}

// ---------- the worker job ----------
jobRunners['restore-test'] = executeRestoreTestJob;
export async function executeRestoreTestJob(job) {
  const { testId, step } = JSON.parse(job.details || '{}');
  let error = null;
  try {
    const test = loadTest(testId);
    if (!test) throw new Error('Restore test not found.');
    if (step === 'clean_up') await runCleanup(test);
    else if (test.result === null && (test.step === step || (step === 'check_space' && !test.started_at))) await runStep(test, step);
  } catch (caught) { error = plainReason(caught?.message, 'The restore test step failed.'); console.error(`Restore test ${testId} step ${step} failed: ${caught?.code ?? caught?.name}`); }
  const after = !error && step === 'check_health' ? loadTest(testId) : null;
  if (after?.result === null && after.step === 'check_health') db.prepare("UPDATE jobs SET status='test_waiting' WHERE id=? AND status='test_running'").run(job.id);
  else db.prepare("UPDATE jobs SET status=?,stage=?,finished_at=?,error=? WHERE id=? AND status='test_running'").run(error ? 'failed' : 'completed', error ? 'failed' : 'completed', iso(clock()), error, job.id);
}
// Cancel and the time limit stop the current helper call (its stdin closes and the helper ends itself).
async function guarded(test, work) {
  const controller = new AbortController(); let why = null;
  const check = () => {
    if (why) return;
    if (db.prepare('SELECT cancel_requested FROM restore_tests WHERE id=?').get(test.id)?.cancel_requested) why = 'cancelled';
    else if (test.deadline_at && clock() >= Date.parse(test.deadline_at)) why = 'time';
    if (why) controller.abort();
  };
  check();
  const timer = setInterval(check, testTiming.cancelPollMs);
  try { return await work(controller.signal); }
  catch (error) { if (why) throw Object.assign(new Error(why), { stopped: why }); throw error; }
  finally { clearInterval(timer); }
}
async function call(test, request, signal) {
  const options = LOCKED.has(request.operation) ? { keepStdinOpen: true, ...(signal ? { signal } : {}) } : {};
  return testTransport.remote(server(test.server_id), LOCKED.has(request.operation) ? { ...request, watchStdin: true } : request, options);
}
const helperLimits = test => ({ memoryMb: test.limits.memoryMb, cpus: test.limits.cpus, internet: !!test.limits.internet });
function stopped(test, error) {
  if (error.stopped === 'cancelled') return conclude(loadTest(test.id), 'cancelled', { reason: 'The test was cancelled.' });
  return conclude(loadTest(test.id), 'couldnt_run', { reason: `Test couldn't finish: time limit (${test.limits.timeLimitMinutes} minutes). Raise it in Advanced.` });
}
const unreachable = error => error?.remoteReported ? plainReason(error.message) : 'The test server could not be reached.';
async function runStep(test, step) {
  if (step === 'check_space' && !test.started_at) {
    const at = clock();
    try {
      transaction(() => {
        db.prepare("UPDATE restore_tests SET started_at=?,deadline_at=?,step='check_space' WHERE id=? AND started_at IS NULL").run(iso(at), iso(at + test.limits.timeLimitMinutes * 60000), test.id);
      });
    } catch (error) {
      if (/UNIQUE constraint failed: restore_tests\.server_id/.test(error.message)) return; // another test holds the server; wait
      throw error;
    }
    test = loadTest(test.id);
    audit('worker', 'restore_test.started', test.site_id, { test: test.id, server: test.server_id });
  }
  setStep(test.id, step, 'running');
  try { await guarded(test, signal => STEP_RUNNERS[step](test, signal)); }
  catch (error) {
    if (error.stopped) { stopped(test, error); return; }
    if (!error?.remoteReported && !error?.aborted && !error?.code) console.error(`Restore test ${test.id} step ${step} stopped: ${error?.name}`);
    conclude(loadTest(test.id), 'couldnt_run', { step, reason: unreachable(error) });
  }
}
function advanceTo(test, step, detail, progress = {}) {
  transaction(() => {
    setStep(test.id, step, 'done', detail);
    const next = NEXT[step];
    db.prepare('UPDATE restore_tests SET step=?,progress=? WHERE id=? AND result IS NULL').run(next, JSON.stringify({ ...test.progress, ...progress }), test.id);
  });
}
const addChecks = (test, checks) => { test.checks = cleanChecks([...(test.checks || []), ...(checks || [])]); db.prepare('UPDATE restore_tests SET checks=? WHERE id=? AND result IS NULL').run(JSON.stringify(test.checks), test.id); };
// A helper verdict ('failed' or 'couldnt_run') ends the test at this step; 'ok' moves on.
function verdict(test, step, answer) {
  if (answer?.outcome === 'ok') { addChecks(test, answer.checks); return true; }
  conclude(loadTest(test.id), answer?.outcome === 'failed' ? 'failed' : 'couldnt_run', { step, reason: answer?.reason, checks: answer?.checks });
  return false;
}
const STEP_RUNNERS = {
  async check_space(test, signal) {
    const backup = test.backup_id && db.prepare('SELECT * FROM backups WHERE id=?').get(test.backup_id);
    if (!backup) { conclude(test, 'couldnt_run', { step: 'check_space', reason: 'The backup was removed before the test started.' }); return; }
    const manifest = JSON.parse(backup.manifest || '{}');
    const need = { bytes: backup.size, kind: manifest.kind === 'static' ? 'static' : 'docker', containers: manifest.containers?.length || 1, grouped: (manifest.containers?.length || 0) > 1, architecture: manifest.kind === 'static' ? null : manifest.architecture ?? null, liveServer: !!test.limits.liveServer };
    const answer = await call(test, { operation: 'restore-test-check', testId: test.id, need, limits: helperLimits(test) }, signal);
    const problem = answer?.problems?.[0] ?? (manifest.kind !== 'static' ? cpuProblem(test.limits.cpus, answer?.facts?.nproc) : null);
    if (problem || answer?.ok !== true) { conclude(loadTest(test.id), 'couldnt_run', { step: 'check_space', reason: problem ?? 'The test server did not pass Check space.' }); return; }
    advanceTo(test, 'check_space', null, { kind: need.kind, probeTools: !!answer.facts?.probeTools });
  },
  async copy_backup(test, signal) {
    db.prepare("UPDATE restore_tests SET cleanup='pending' WHERE id=? AND cleanup IS NULL").run(test.id);
    const target = server(test.server_id);
    const prepare = () => call(test, { operation: 'restore-test-prepare', testId: test.id, deadline: Date.parse(test.deadline_at) / 1000, grace: Math.min(3600, Math.max(60, Math.round(testTiming.cleanupSeconds * testTiming.scale))), reaper: reaperSource }, signal);
    let upload;
    try { upload = await testTransport.upload(target, test.backup_id, null, { prepare, signal }); }
    catch (error) {
      if (signal.aborted) throw error;
      if (/checksum differs|unable to authenticate|Unsupported backup format|Truncated backup/i.test(String(error?.message))) {
        // As a scrub does: the package is marked unverified, so no test, restore or move picks it again.
        transaction(() => {
          recordVerification(test.backup_id, 'integrity', { status: 'failed', method: 'full package authentication failed during an automatic restore test', testId: test.id }, test.job_id);
          db.prepare('UPDATE backups SET verified=0 WHERE id=?').run(test.backup_id);
          audit('worker', 'backup.integrity_failed', test.backup_id, { test: test.id });
        });
        conclude(loadTest(test.id), 'failed', { step: 'copy_backup', reason: 'The backup did not pass authentication (AES-256-GCM and its stored SHA256).', checks: [{ name: 'Backup authentic', kind: 'authentic', target: null, status: 'failed', detail: null }] });
        return;
      }
      conclude(loadTest(test.id), 'couldnt_run', { step: 'copy_backup', reason: error?.remoteReported ? plainReason(error.message) : 'The backup could not be copied to the test server.' });
      return;
    }
    addChecks(test, [{ name: 'Backup authentic', kind: 'authentic', target: null, status: 'passed', detail: 'AES-256-GCM and SHA256' }]);
    advanceTo(test, 'copy_backup', null, { plaintextChecksum: upload.plaintextChecksum });
  },
  async restore_copy(test, signal) {
    const answer = await call(test, { operation: 'restore-test-run', phase: 'restore', testId: test.id, plaintextChecksum: test.progress.plaintextChecksum, limits: helperLimits(test) }, signal);
    if (!verdict(test, 'restore_copy', answer)) return;
    if (answer.kind === 'static') {
      advanceTo(test, 'restore_copy', null, { kind: 'static' });
      transaction(() => { for (const step of ['start_containers', 'check_health']) setStep(test.id, step, 'skipped', 'A static site has no containers.'); });
      conclude(loadTest(test.id), 'passed');
      return;
    }
    advanceTo(test, 'restore_copy', `${answer.containers} container${answer.containers === 1 ? '' : 's'}, ${answer.networkMode === 'internet' ? 'with internet, mail blocked' : 'no internet'}`, { kind: 'docker', running: answer.running, internet: answer.networkMode === 'internet' });
  },
  async start_containers(test, signal) {
    const answer = await call(test, { operation: 'restore-test-run', phase: 'start', testId: test.id }, signal);
    if (!verdict(test, 'start_containers', answer)) return;
    const at = clock();
    advanceTo(test, 'start_containers', `${answer.started} started`, { startedAt: at, nextPollAt: at });
  },
  async check_health(test, signal) {
    const startedAt = test.progress.startedAt ?? clock();
    const final = clock() - startedAt >= testTiming.stableSeconds * 1000 * testTiming.scale;
    const answer = await call(test, { operation: 'restore-test-run', phase: 'poll', testId: test.id, final, stable: clock() > startedAt, ...(test.limits.probe ? { probe: test.limits.probe } : {}) }, signal);
    if (!verdict(test, 'check_health', answer)) return;
    if (!final) { saveProgress(test, { nextPollAt: clock() + testTiming.pollSeconds * 1000 * testTiming.scale, polls: (test.progress.polls ?? 0) + 1 }); return; }
    setStep(test.id, 'check_health', 'done', `${(answer.checks || []).filter(item => item.status === 'passed').length} checks passed`);
    conclude(loadTest(test.id), 'passed');
  },
};

// ---------- clean-up ----------
async function runCleanup(test) {
  if (test.cleanup !== 'pending') return;
  setStep(test.id, 'clean_up', 'running');
  const limit = testTiming.cleanupSeconds * 1000 * testTiming.scale, controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  try {
    const removed = await call(test, { operation: 'restore-test-teardown', testId: test.id }, controller.signal);
    const status = await call(test, { operation: 'restore-test-status', testId: test.id });
    if (status?.present !== false) throw Object.assign(new Error('Clean-up left containers, networks, firewall rules or files on the test server.'), { remoteReported: true });
    transaction(() => {
      db.prepare("UPDATE restore_tests SET cleanup='done',cleanup_next_at=NULL WHERE id=? AND cleanup='pending'").run(test.id);
      setStep(test.id, 'clean_up', 'done', removed?.keptImages ? `${removed.keptImages} image${removed.keptImages === 1 ? '' : 's'} kept: another container uses it.` : null);
      audit('worker', 'restore_test.cleaned', test.site_id, { test: test.id, counts: removed?.counts ?? {}, keptImages: removed?.keptImages ?? 0 });
    });
  } catch (error) {
    const attempts = test.cleanup_attempts + 1, retries = testTiming.retryMinutes;
    const reason = error?.name === 'AbortError' || controller.signal.aborted ? 'Clean-up took longer than 10 minutes.' : unreachable(error);
    transaction(() => {
      if (attempts > retries.length) {
        db.prepare("UPDATE restore_tests SET cleanup='failed',cleanup_attempts=?,cleanup_next_at=NULL WHERE id=?").run(attempts, test.id);
        setStep(test.id, 'clean_up', 'failed', `${reason} The test server stays blocked until this is resolved.`);
        audit('worker', 'restore_test.cleanup_failed', test.site_id, { test: test.id, server: test.server_id, attempts });
      } else {
        const minutes = retries[attempts - 1];
        db.prepare('UPDATE restore_tests SET cleanup_attempts=?,cleanup_next_at=? WHERE id=?').run(attempts, iso(clock() + minutes * 60000 * testTiming.scale), test.id);
        setStep(test.id, 'clean_up', 'running', `${reason} DockNest tries again in ${minutes} minutes.`);
      }
    });
  } finally { clearTimeout(timer); }
}
// A needs_cleanup test: the administrator asks for one more try (POST /api/restore-tests/:id/cleanup, PR C).
export function retryRestoreTestCleanup(testId, actor) {
  const changed = db.prepare("UPDATE restore_tests SET cleanup='pending',cleanup_attempts=0,cleanup_next_at=NULL WHERE id=? AND cleanup='failed'").run(testId).changes;
  if (!changed) throw httpError(409, 'NOT_NEEDED', 'This test does not need clean-up.');
  audit(actor, 'restore_test.cleanup_retry', testId, {});
  return { cleanup: 'pending' };
}
// Acknowledge only when the test server reports nothing left (POST /api/jobs/:id/recovery, PR C).
export async function acknowledgeRestoreTestCleanup(testId, actor) {
  const test = loadTest(testId);
  if (!test || test.cleanup !== 'failed') throw httpError(409, 'NOT_NEEDED', 'This test does not need clean-up.');
  const status = await call(test, { operation: 'restore-test-status', testId });
  if (status?.present !== false) throw httpError(409, 'LEFTOVERS', 'The test server still has containers, networks, firewall rules or files from this test.');
  db.prepare("UPDATE restore_tests SET cleanup='acknowledged' WHERE id=? AND cleanup='failed'").run(testId);
  audit(actor, 'restore_test.recovery_acknowledged', test.site_id, { test: testId });
  return { cleanup: 'acknowledged' };
}

// ---------- worker start ----------
// A step that was running when the worker stopped has an unknown outcome on the server: the test ends couldnt_run and
// its clean-up runs first on the next tick. A clean-up that was running simply runs again.
export function recoverInterruptedRestoreTests() {
  for (const job of db.prepare("SELECT * FROM jobs WHERE type='restore-test' AND status='test_running'").all()) {
    db.prepare("UPDATE jobs SET status='failed',stage='failed',error='Worker interrupted; the restore test cleans up from its journal.',finished_at=? WHERE id=? AND status='test_running'").run(iso(clock()), job.id);
    const { testId, step } = JSON.parse(job.details || '{}');
    const test = testId && loadTest(testId);
    if (!test) continue;
    if (test.result === null && test.started_at) conclude(test, 'couldnt_run', { step, reason: 'DockNest restarted during this step, so the test stopped.' });
    else if (test.cleanup === 'pending') db.prepare('UPDATE restore_tests SET cleanup_next_at=NULL WHERE id=?').run(test.id);
  }
}

// ---------- read model (the API in PR C builds on this) ----------
export function testState(test) {
  if (test.result === null) return test.started_at ? 'running' : 'queued';
  if (test.cleanup === 'pending') return 'cleaning';
  if (test.cleanup === 'failed') return 'needs_cleanup';
  return 'finished';
}
