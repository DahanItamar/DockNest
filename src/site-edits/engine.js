// Safe Edit engine (docs/safe-edit.md): review, apply and the ticked step machine
// backup -> prepare -> apply -> check_health -> finish, or roll_back -> finish when the change does not come up.
// - tickSiteEdits() runs each worker tick. The backup step queues a normal backup (actor `edit:<id>`) and waits for it
//   across ticks without holding the worker. Every step that touches the server is one short `site-edit` job (statuses
//   edit_queued/edit_running, which releases before 2.15.0 never claim; claimJob keeps the server busy while one runs).
//   Health polls rest in edit_waiting between ticks, like restore tests.
// - The candidate (file texts and environment values) never reaches SQLite in the clear: the API holds it sealed for
//   15 minutes behind a one-use review token (tokens.js); the worker gets it through the job's sealed `details.payload`,
//   which is wiped to {} when the apply step ends and when the edit ends.
// - Reasons are fixed sentences chosen by code (state.js); helper text, Docker output and values never pass through.
// - An unfinished edit holds the site (partial unique index; requireNotEditing in src/engine.js), also while it needs
//   attention. Data rollback (owner decision): only when an existing service's image changed, in place from the safety
//   copy edit-apply takes on the server (remote/helper/edit.py); Restore backup in needs_attention is the normal restore.
import { db, id, audit, transaction } from '../db.js';
import { deploymentHeld } from '../deployment-hold.js';
import { seal, open } from '../crypto.js';
import { transport, siteInfo, enqueueBackup, enqueueRestore, jobRunners, movingSite, busySite, editingSite } from '../engine.js';
import { COPY, copySeconds, STEPS, LIMITS, POLL_PHASES, PHASE_STEP, REVIEW_CODES, REASONS, SAY, FIELD, ENV_KEY, ENV_REFUSED_PREFIX, stateFor, cancellable, reasonFor, helperCode, changesRecord, tabsUsed } from './state.js';
import { resolveInvocation, storedInvocation, allowedRoots, invocationHash, helperInvocation } from './invocation.js';
import { issueToken, takeToken } from './tokens.js';
import { reviewDiff, inlineSecretKeys } from './diff.js';

// Seconds; tests shrink them with `editTiming.scale`.
export const editTiming = { scale: 1, pollSeconds: 10, retrySeconds: [30, 60, 120, 300, 600, 900], callSeconds: { 'edit-load': 120, 'edit-check': 180, 'edit-prepare': 1200, 'edit-apply': 600, 'edit-poll': 120, 'edit-rollback': 900, 'edit-finish': 300, 'edit-status': 120, discover: 120 } };
// SSH, the restore queue and the clock; tests replace members.
export const editTransport = {
  remote: (server, request, options) => transport.remote(server, request, () => {}, () => {}, options),
  enqueueRestore: (backupId, plan, actor) => enqueueRestore(backupId, plan, actor),
  now: () => Date.now(),
};
const clock = () => editTransport.now();
const iso = ms => new Date(ms).toISOString();
const httpError = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const parseJson = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
// Re-entrant: a step that concludes inside its own transaction joins it instead of nesting BEGIN.
const atomic = fn => (db.isTransaction ? fn() : transaction(fn));
const editJobs = "type='site-edit' AND json_extract(details,'$.editId')=?";

// ---------- persistence ----------
export function loadEdit(editId) {
  const row = db.prepare('SELECT * FROM site_edits WHERE id=?').get(editId);
  return row ? { ...row, progress: parseJson(row.progress, {}), changes: parseJson(row.changes, {}), cancel_requested: !!row.cancel_requested, data_rollback: !!row.data_rollback } : null;
}
export const loadSteps = editId => db.prepare('SELECT * FROM site_edit_steps WHERE edit_id=?').all(editId).sort((a, b) => STEPS.indexOf(a.step) - STEPS.indexOf(b.step));
const plain = text => (text == null ? null : String(text).replace(/\s+/g, ' ').trim().slice(0, 300));
function setStep(editId, step, state, detail = null) {
  const at = iso(clock()), text = detail == null ? null : plain(detail).slice(0, 500);
  if (state === 'running') db.prepare('UPDATE site_edit_steps SET state=?,detail=COALESCE(?,detail),started_at=COALESCE(started_at,?),finished_at=NULL WHERE edit_id=? AND step=?').run(state, text, at, editId, step);
  else db.prepare('UPDATE site_edit_steps SET state=?,detail=COALESCE(?,detail),started_at=COALESCE(started_at,?),finished_at=? WHERE edit_id=? AND step=?').run(state, text, at, at, editId, step);
}
// Writes progress (and the state that goes with its phase) while the edit is unfinished.
function save(edit, changes, row = {}) {
  edit.progress = { ...edit.progress, ...changes };
  const state = row.state ?? stateFor(edit.progress.phase, edit.progress.outcome, true);
  const sets = ['progress=?', 'state=?'], values = [JSON.stringify(edit.progress), state];
  for (const [column, value] of Object.entries(row)) if (column !== 'state') { sets.push(`${column}=?`); values.push(value); }
  db.prepare(`UPDATE site_edits SET ${sets.join(',')} WHERE id=? AND result IS NULL`).run(...values, edit.id);
  edit.state = state;
}
// A new phase starts with a fresh retry count.
const moveTo = (edit, phase, changes = {}, row = {}) => save(edit, { phase, attempts: 0, nextAttemptAt: null, ...changes }, row);
const goFinish = (edit, outcome, { reason = null, failedStep = null } = {}) => moveTo(edit, 'finish', { outcome, reasonPending: reason, failedStep });
const goRollBack = (edit, reason, failedStep) => moveTo(edit, 'roll_back', { reasonPending: reason, failedStep });
function goAttention(edit, attentionStep, reason) {
  atomic(() => {
    moveTo(edit, 'attention', { attentionStep }, { reason: plain(reason), failed_step: PHASE_STEP[attentionStep] ?? 'roll_back' });
    if (PHASE_STEP[attentionStep]) setStep(edit.id, PHASE_STEP[attentionStep], 'failed', reason);
    audit('worker', 'site.edit.needs_attention', edit.site_id, { edit: edit.id, step: PHASE_STEP[attentionStep] ?? 'roll_back', ...auditChanges(edit) });
  });
}
const auditChanges = edit => ({ fields: edit.changes?.changed ?? [], envKeys: edit.changes?.env ?? {}, files: edit.changes?.files ?? [] });

// Ends the edit: result written once, every waiting job closed, every payload wiped, steps that will not run skipped.
function conclude(edit, result, { failedStep = null, reason = null } = {}) {
  const at = iso(clock()), text = result === 'applied' ? null : plain(reason);
  return atomic(() => {
    const changed = db.prepare('UPDATE site_edits SET result=?,state=?,failed_step=?,reason=?,finished_at=?,progress=? WHERE id=? AND result IS NULL')
      .run(result, result === 'cancelled' ? 'cancelled' : 'done', failedStep, text, at, JSON.stringify({ ...edit.progress, phase: 'done' }), edit.id).changes;
    if (!changed) return false;
    db.prepare(`UPDATE jobs SET status='completed',stage='completed',finished_at=? WHERE ${editJobs} AND status IN ('edit_waiting','edit_queued')`).run(at, edit.id);
    wipePayloads(edit.id);
    if (failedStep && result !== 'rolled_back') { const row = loadSteps(edit.id).find(step => step.step === failedStep); if (row && row.state !== 'failed') setStep(edit.id, failedStep, 'failed', text); }
    for (const row of loadSteps(edit.id)) if (['pending', 'running'].includes(row.state)) setStep(edit.id, row.step, 'skipped');
    audit('worker', 'site.edit.' + result, edit.site_id, { edit: edit.id, ...(failedStep ? { step: failedStep } : {}), ...auditChanges(edit) });
    return true;
  });
}
const wipePayloads = editId => db.prepare(`UPDATE jobs SET details=json_set(details,'$.payload',json('{}')) WHERE ${editJobs} AND json_type(details,'$.payload')='text'`).run(editId);

// ---------- the job of a step ----------
const activeJob = editId => db.prepare(`SELECT id,status,details FROM jobs WHERE ${editJobs} AND status IN ('edit_queued','edit_running','edit_waiting')`).get(editId);
// The check and the insert share one immediate transaction, so the API and the worker can never both add a step job.
// The non-secret context (invocation, roots, services) travels from job to job; the sealed payload only to prepare and
// apply, and the job it came from is wiped.
function ensureJob(edit, phase, before = null) {
  const jobId = id();
  return atomic(() => {
    before?.();
    if (activeJob(edit.id)) return null;
    const previous = edit.job_id ? db.prepare('SELECT details FROM jobs WHERE id=?').get(edit.job_id) : null, from = parseJson(previous?.details, {});
    const payload = phase === 'prepare' && typeof from.payload === 'string' ? from.payload : undefined;
    const details = { editId: edit.id, step: phase, targetServerId: edit.server_id, invocation: from.invocation, allowedRoots: from.allowedRoots, services: from.services, ...(payload ? { payload } : {}) };
    db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,'site-edit','edit_queued',?,?,?)").run(jobId, edit.site_id, phase, iso(clock()), JSON.stringify(details));
    if (edit.job_id) db.prepare("UPDATE jobs SET details=json_set(details,'$.payload',json('{}')) WHERE id=? AND json_type(details,'$.payload')='text'").run(edit.job_id);
    db.prepare('UPDATE site_edits SET job_id=? WHERE id=?').run(jobId, edit.id);
    edit.job_id = jobId;
    return jobId;
  });
}

// ---------- the tick ----------
export function tickSiteEdits() {
  for (const { id: editId } of db.prepare('SELECT id FROM site_edits WHERE result IS NULL ORDER BY created_at,id').all()) {
    try { advance(loadEdit(editId)); } catch (error) { console.error(`Safe Edit ${editId} could not advance: ${error.code ?? error.name}`); }
  }
}
// One edit at once: used after the API changes it, so it does not wait for the tick.
export function advanceSiteEdit(editId) { const edit = loadEdit(editId); if (edit) advance(edit); }

function advance(edit) {
  if (!edit || edit.result !== null) return;
  const job = activeJob(edit.id), p = edit.progress, phase = p.phase;
  if (edit.cancel_requested && cancellable(edit)) {
    if (phase === 'backup') {
      // A pre-change backup no worker has started yet is withdrawn; one already running finishes as a normal backup.
      if (p.backupJobId) db.prepare("UPDATE jobs SET status='completed',stage='cancelled',finished_at=? WHERE id=? AND status='queued'").run(iso(clock()), p.backupJobId);
      conclude(edit, 'cancelled', { reason: SAY.cancelled });
      return;
    }
    // A prepare job no worker has claimed yet is withdrawn; a running one checks for the cancel when it ends.
    if (!job || (job.status === 'edit_queued' && db.prepare("UPDATE jobs SET status='completed',stage='cancelled',finished_at=? WHERE id=? AND status='edit_queued'").run(iso(clock()), job.id).changes === 1)) {
      if (p.prepareStarted) goFinish(edit, 'cancelled', { reason: SAY.cancelled }); else conclude(edit, 'cancelled', { reason: SAY.cancelled });
      return;
    }
  }
  if (phase === 'backup') { advanceBackup(edit, job); return; }
  if (phase === 'attention') { advanceAttention(edit); return; }
  if (job && job.status !== 'edit_waiting') return;
  // The deployment hold pauses work that has not touched the server yet; started changes always finish.
  if (phase === 'prepare' && !p.prepareStarted && deploymentHeld(db)) return;
  if ((p.nextAttemptAt ?? 0) > clock()) return;
  if (POLL_PHASES.includes(phase) && (p.nextPollAt ?? 0) > clock()) return;
  if (job) {
    if (parseJson(job.details, {}).step === phase) { db.prepare("UPDATE jobs SET status='edit_queued' WHERE id=? AND status='edit_waiting'").run(job.id); return; }
    db.prepare("UPDATE jobs SET status='completed',stage='completed',finished_at=? WHERE id=? AND status='edit_waiting'").run(iso(clock()), job.id);
  }
  ensureJob(edit, phase);
}

function advanceBackup(edit, job) {
  const p = edit.progress;
  if (db.prepare('SELECT 1 FROM site_archives WHERE site_id=?').get(edit.site_id)) { conclude(edit, 'failed', { failedStep: 'backup', reason: SAY.siteGone }); return; }
  if (!p.backupJobId) {
    if (deploymentHeld(db)) return;
    let queued;
    try { queued = enqueueBackup(edit.site_id, 'edit:' + edit.id, { editId: edit.id }); }
    catch { return; } // the site is busy for a moment (a job just finishing): the next tick tries again
    atomic(() => { save(edit, { backupJobId: queued.id }, { started_at: iso(clock()) }); setStep(edit.id, 'backup', 'running'); });
    return;
  }
  const backupJob = db.prepare('SELECT status FROM jobs WHERE id=?').get(p.backupJobId);
  if (!backupJob || ['failed', 'recovery_required'].includes(backupJob.status)) { conclude(edit, 'failed', { failedStep: 'backup', reason: SAY.backupFailed }); return; }
  if (backupJob.status !== 'completed') return;
  const backup = db.prepare('SELECT id FROM backups WHERE job_id=?').get(p.backupJobId);
  if (!backup) { conclude(edit, 'failed', { failedStep: 'backup', reason: SAY.backupFailed }); return; }
  ensureJob(edit, 'prepare', () => {
    if (job) db.prepare("UPDATE jobs SET status='completed',stage='completed',finished_at=? WHERE id=? AND status='edit_waiting'").run(iso(clock()), job.id);
    db.prepare('UPDATE site_edits SET backup_id=? WHERE id=?').run(backup.id, edit.id);
    setStep(edit.id, 'backup', 'done');
    moveTo(edit, 'prepare');
  });
}
function restoreJobState(jobId) { return jobId ? db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId)?.status ?? 'failed' : null; }
function advanceAttention(edit) {
  const status = restoreJobState(edit.progress.restoreJobId);
  if (status === 'completed') { goFinish(edit, 'failed', { failedStep: edit.failed_step ?? 'roll_back', reason: SAY.restoredBackup }); save(edit, { restoredBackup: true, keepMaintenance: true }); return; }
  else if (status && !['queued', 'running'].includes(status)) save(edit, { restoreJobId: null, restoreFailed: true });
}

// ---------- helper calls ----------
// Every op holds the per-site lock on the server and stops when its stdin closes; a call that takes longer than its
// limit is stopped (stdin closes) and counts as an unknown outcome.
async function call(server, request, limitSeconds = null) {
  const controller = new AbortController(), seconds = limitSeconds ?? editTiming.callSeconds[request.operation] ?? 120;
  const timer = setTimeout(() => controller.abort(), seconds * 1000 * editTiming.scale);
  try { return await editTransport.remote(server, { ...request, watchStdin: true }, { keepStdinOpen: true, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
// edit-apply copies the data and edit-rollback puts it back: their limits grow with the reviewed data size (state.js COPY).
const applySeconds = edit => copySeconds(editTiming.callSeconds['edit-apply'], edit.progress.dataBytes, 1);
const rollbackSeconds = edit => copySeconds(editTiming.callSeconds['edit-rollback'], edit.progress.dataBytes, COPY.restoreFactor);
// remote: the helper answered with an error (and maybe a fixed code); unreachable: SSH, a time limit or no answer.
const classify = error => (error?.remoteReported ? { kind: 'remote', code: helperCode(error.helperCode) } : { kind: 'unreachable', code: null });
const openPayload = sealed => { if (typeof sealed !== 'string') return null; try { return JSON.parse(open(sealed)); } catch { return null; } };

function context(edit, details) {
  const server = db.prepare('SELECT * FROM servers WHERE id=?').get(edit.server_id);
  const invocation = details?.invocation, roots = details?.allowedRoots;
  if (!server || !invocation || !Array.isArray(roots)) return null;
  // `config`: the site's saved configuration with its maintenance settings (no secrets), for the helper's maintenance page.
  return { server, base: { editId: edit.id, siteId: edit.site_id, invocation, allowedRoots: roots, config: siteInfo(edit.site_id).site.config, sshPort: server.port }, services: details.services ?? [] };
}
// Before anything is written the site's recorded invocation must still be the one reviewed.
const invocationUnchanged = (edit, ctx) => { const stored = storedInvocation(edit.site_id); return !!stored && invocationHash(stored) === edit.progress.invocationSha && JSON.stringify(helperInvocation(stored)) === JSON.stringify(ctx.base.invocation); };
function retryLater(edit, onGiveUp) {
  const attempts = (edit.progress.attempts ?? 0) + 1, delays = editTiming.retrySeconds;
  if (attempts > delays.length) { onGiveUp(); return; }
  save(edit, { attempts, nextAttemptAt: clock() + delays[attempts - 1] * 1000 * editTiming.scale });
}

// ---------- the worker job ----------
jobRunners['site-edit'] = executeSiteEditJob;
export async function executeSiteEditJob(job) {
  const details = parseJson(job.details || '{}', {}), { editId, step } = details;
  let error = null;
  try {
    const edit = loadEdit(editId);
    if (edit && edit.result === null && edit.progress.phase === step && RUNNERS[step]) {
      const ctx = context(edit, details);
      if (!ctx) throw Object.assign(new Error('missing context'), { code: 'NO_CONTEXT' });
      await RUNNERS[step](edit, ctx, details, job);
    }
  } catch (caught) {
    error = 'The Safe Edit step could not run.';
    console.error(`Safe Edit ${editId} step ${step} failed: ${caught?.code ?? caught?.name}`);
    const edit = loadEdit(editId);
    // Without its context the step cannot run at all: before any write the edit simply fails, afterwards it needs you.
    if (edit?.result === null && edit.progress.phase === step) {
      if (['prepare'].includes(step) || (step === 'apply' && !edit.progress.applyStarted)) conclude(edit, 'failed', { failedStep: step, reason: SAY.applyFailed + ' Nothing was changed.' });
      else goAttention(edit, ['finish', 'recover'].includes(step) ? step : 'roll_back', SAY.rollbackFailed);
    }
  }
  const after = loadEdit(editId);
  if (!error && after?.result === null && POLL_PHASES.includes(step) && after.progress.phase === step) db.prepare("UPDATE jobs SET status='edit_waiting' WHERE id=? AND status='edit_running'").run(job.id);
  else db.prepare("UPDATE jobs SET status=?,stage=?,finished_at=?,error=? WHERE id=? AND status='edit_running'").run(error ? 'failed' : 'completed', error ? 'failed' : 'completed', iso(clock()), error, job.id);
}

// The helper's site lock was held by another DockNest task: nothing happened, the step simply runs again later.
const busyRetry = (edit, onGiveUp) => { retryLater(edit, onGiveUp); };
const failReason = (code, fallback) => (code === 'FILE_CHANGED' ? SAY.filesChangedDuringBackup : Object.hasOwn(REASONS, code) && !REVIEW_CODES.includes(code) ? REASONS[code] : code && REVIEW_CODES.includes(code) ? `${REASONS[code]} Nothing was changed.` : fallback);
const RUNNERS = {
  async prepare(edit, ctx, details) {
    const candidate = openPayload(details.payload);
    if (!candidate || !invocationUnchanged(edit, ctx)) { conclude(edit, 'failed', { failedStep: 'prepare', reason: candidate ? 'The site\'s Compose setup changed after the review. Nothing was changed.' : SAY.applyFailed + ' Nothing was changed.' }); return; }
    atomic(() => { save(edit, { prepareStarted: true }); setStep(edit.id, 'prepare', 'running'); });
    let answer;
    try { answer = await call(ctx.server, { ...ctx.base, operation: 'edit-prepare', files: candidate.files, env: candidate.env, ...(candidate.containerChanges ? { containerChanges: candidate.containerChanges } : {}), reviewedModelSha256: candidate.reviewedModelSha256 }); }
    catch (error) {
      const failure = classify(error), reason = failure.kind === 'unreachable' ? SAY.unreachableNothing : failReason(failure.code, SAY.applyFailed + ' Nothing was changed.');
      atomic(() => { setStep(edit.id, 'prepare', 'failed', reason); goFinish(edit, 'failed', { failedStep: 'prepare', reason }); });
      return;
    }
    if (answer?.ok !== true) {
      const code = helperCode(answer?.code), reason = failReason(code, SAY.applyFailed + ' Nothing was changed.');
      if (code === 'SITE_BUSY') { busyRetry(edit, () => atomic(() => { setStep(edit.id, 'prepare', 'failed', REASONS.SITE_BUSY); goFinish(edit, 'failed', { failedStep: 'prepare', reason: REASONS.SITE_BUSY + ' Nothing was changed.' }); })); return; }
      atomic(() => { setStep(edit.id, 'prepare', 'failed', reason); goFinish(edit, 'failed', { failedStep: 'prepare', reason }); });
      return;
    }
    const pulled = Array.isArray(answer.pulled) ? answer.pulled.length : 0;
    atomic(() => {
      setStep(edit.id, 'prepare', 'done', pulled ? `${pulled} new image${pulled === 1 ? '' : 's'} pulled` : null);
      const fresh = loadEdit(edit.id);
      // The candidate now lives in the server's journal; apply needs only the reviewed model's hash, so the sealed payload
      // is not passed on (ensureJob gives it to prepare only).
      if (fresh.cancel_requested) goFinish(fresh, 'cancelled', { reason: SAY.cancelled }); else moveTo(fresh, 'apply', { reviewedModelSha256: candidate.reviewedModelSha256 });
    });
  },
  async apply(edit, ctx, details, job) {
    const reviewed = edit.progress.reviewedModelSha256;
    if (!reviewed || !invocationUnchanged(edit, ctx)) { goFinish(edit, 'failed', { failedStep: 'apply', reason: reviewed ? 'The site\'s Compose setup changed after the review. Nothing was changed.' : SAY.applyFailed + ' Nothing was changed.' }); return; }
    // Journalled before the first write: from here on, an unknown outcome is decided by edit-status, never guessed.
    atomic(() => { save(edit, { applyStarted: true }); setStep(edit.id, 'apply', 'running'); });
    let answer, failure = null;
    try { answer = await call(ctx.server, { ...ctx.base, operation: 'edit-apply', reviewedModelSha256: reviewed }, applySeconds(edit)); }
    catch (error) { failure = classify(error); }
    finally { db.prepare("UPDATE jobs SET details=json_set(details,'$.payload',json('{}')) WHERE id=?").run(job.id); }
    if (!failure && answer?.ok !== true) failure = { kind: 'remote', code: helperCode(answer?.code) };
    if (failure?.kind === 'unreachable') { moveTo(edit, 'recover', { interrupted: 'apply', recoverWhy: 'unreachable' }); return; }
    if (typeof answer?.dataCopy === 'boolean') save(edit, { dataCopy: answer.dataCopy });
    if (failure) {
      // Refused before anything was written (the helper says so by code): the edit ends, finish takes the maintenance page
      // down and starts a site the safety copy stopped. DATA_COPY_SPACE is only ever raised while the journal is prepared.
      const before = { DATA_COPY_SPACE: SAY.dataCopySpace, MAINTENANCE_FAILED: REASONS.MAINTENANCE_FAILED + ' Nothing was changed.', INVALID_REQUEST: REASONS.INVALID_REQUEST + ' Nothing was changed.', DATA_TOO_LARGE: REASONS.DATA_TOO_LARGE, DATA_UNREADABLE: REASONS.DATA_UNREADABLE, DATA_NOT_LOCAL: REASONS.DATA_NOT_LOCAL };
      if (before[failure.code]) { const reason = before[failure.code]; atomic(() => { setStep(edit.id, 'apply', 'failed', reason); goFinish(edit, 'failed', { failedStep: 'apply', reason }); }); return; }
      // FILE_CHANGED: nothing of the candidate stays on disk (the helper restored the originals or never wrote), and a
      // hand edit made meanwhile must not be overwritten by a rollback: the edit ends, the maintenance page goes off.
      // The lock was busy or the journal is not prepared: the helper did nothing at all.
      if (failure.code === 'SITE_BUSY') { busyRetry(edit, () => moveTo(edit, 'recover', { interrupted: 'apply', recoverWhy: 'unreachable' })); return; }
      if (failure.code === 'NO_JOURNAL') { atomic(() => { setStep(edit.id, 'apply', 'failed', REASONS.NO_JOURNAL); goFinish(edit, 'failed', { failedStep: 'apply', reason: REASONS.NO_JOURNAL + ' Nothing was changed.' }); }); return; }
      if (failure.code === 'FILE_CHANGED') { atomic(() => { setStep(edit.id, 'apply', 'failed', SAY.filesChangedDuringBackup); goFinish(edit, 'failed', { failedStep: 'apply', reason: SAY.filesChangedDuringBackup }); }); return; }
      // Docker could not start the written candidate: roll back. Anything else (FAILED, out of space mid-write, an unknown
      // code) leaves the write state unknown: edit-status decides, so the journal is never dropped while it is needed.
      if (failure.code === 'APPLY_FAILED') { const reason = REASONS.APPLY_FAILED; atomic(() => { setStep(edit.id, 'apply', 'failed', reason); goRollBack(edit, reason, 'apply'); }); return; }
      moveTo(edit, 'recover', { interrupted: 'apply', recoverWhy: 'failed' });
      return;
    }
    const at = clock();
    atomic(() => { setStep(edit.id, 'apply', 'done'); setStep(edit.id, 'check_health', 'running'); moveTo(edit, 'check_health', { windowStartedAt: at, helperStartedAt: Number.isFinite(answer.startedAt) ? answer.startedAt : at / 1000, nextPollAt: at, dataCopy: answer.dataCopy === true, ...(Number.isSafeInteger(answer.dataBytes) ? { dataBytes: answer.dataBytes } : {}) }); });
  },
  check_health: (edit, ctx) => poll(edit, ctx, 'check_health'),
  rollback_health: (edit, ctx) => poll(edit, ctx, 'rollback_health'),
  async roll_back(edit, ctx) {
    setStep(edit.id, 'roll_back', 'running');
    let answer;
    try { answer = await call(ctx.server, { ...ctx.base, operation: 'edit-rollback', restoreData: edit.data_rollback }, rollbackSeconds(edit)); }
    catch (error) {
      if (classify(error).kind === 'remote') { goAttention(edit, 'roll_back', SAY.rollbackFailed); return; }
      retryLater(edit, () => goAttention(edit, 'roll_back', `${SAY.unreachable} ${SAY.rollbackFailed}`));
      return;
    }
    if (typeof answer?.dataCopy === 'boolean') save(edit, { dataCopy: answer.dataCopy });
    if (answer?.ok !== true) {
      if (helperCode(answer?.code) === 'SITE_BUSY') { busyRetry(edit, () => goAttention(edit, 'roll_back', SAY.rollbackFailed)); return; }
      goAttention(edit, 'roll_back', SAY.rollbackFailed); return;
    }
    const at = clock();
    // With data_rollback the helper also put the data sets back from its safety copy, in place (owner decision).
    moveTo(edit, 'rollback_health', { rolledBack: true, dataRestored: answer.dataRestored === true, windowStartedAt: at, helperStartedAt: at / 1000, nextPollAt: at });
  },
  async finish(edit, ctx) {
    setStep(edit.id, 'finish', 'running');
    const p = edit.progress;
    try {
      const answer = await call(ctx.server, { ...ctx.base, operation: 'edit-finish', ...(p.keepMaintenance ? { keepMaintenance: true } : {}) });
      if (answer?.ok === false) throw Object.assign(new Error('finish'), { remoteReported: true });
    } catch {
      retryLater(edit, () => {
        // Nothing of the candidate was ever written: the leftovers (journal, protective tags) are harmless.
        if (!p.applyStarted && ['failed', 'cancelled'].includes(p.outcome)) { setStep(edit.id, 'finish', 'failed', SAY.unreachable); conclude(edit, p.outcome, { failedStep: p.failedStep, reason: p.reasonPending }); }
        else goAttention(edit, 'finish', SAY.finishFailed);
      });
      return;
    }
    atomic(() => {
      save(edit, { dataCopy: false });
      setStep(edit.id, 'finish', 'done');
      if (p.outcome === 'rolled_back') setStep(edit.id, 'roll_back', 'done', p.dataRestored ? 'Previous version and data back.' : 'Previous version back.');
      conclude(edit, p.outcome, { failedStep: p.failedStep, reason: p.reasonPending });
    });
  },
  // After a restart or an unreachable server during prepare/apply: the journal on the server decides.
  async recover(edit, ctx) {
    const p = edit.progress, why = ['unreachable', 'failed'].includes(p.recoverWhy) ? p.recoverWhy : 'restart';
    let status;
    try { status = await call(ctx.server, { ...ctx.base, operation: 'edit-status' }); }
    catch { retryLater(edit, () => goAttention(edit, 'recover', `${SAY.unreachable} DockNest could not check whether the change was written.`)); return; }
    if (typeof status?.dataCopy === 'boolean') save(edit, { dataCopy: status.dataCopy });
    if (status?.ok === false || !['original', 'none', 'candidate', 'mixed'].includes(status?.files)) { retryLater(edit, () => goAttention(edit, 'recover', 'DockNest could not check whether the change was written.')); return; }
    const step = p.interrupted === 'prepare' ? 'prepare' : 'apply';
    if (status?.files === 'original' || status?.files === 'none') {
      const reason = why === 'unreachable' ? SAY.unreachableNothing : why === 'failed' ? SAY.applyFailed + ' Nothing was changed.' : SAY.restartedNothing;
      atomic(() => { setStep(edit.id, step, 'failed', reason); goFinish(edit, 'failed', { failedStep: step, reason }); });
      return;
    }
    const reason = why === 'unreachable' ? SAY.unreachableUndone : why === 'failed' ? SAY.applyFailedUndone : SAY.restartedUndone;
    atomic(() => { setStep(edit.id, step, 'failed', reason); goRollBack(edit, reason, step); });
  },
};

// Health polls across ticks (the restore test rules, decided by the helper): running, Docker-healthy where a service has
// a health check, still running after 60 seconds, and the site's health URL answering 200-399 from the server.
async function poll(edit, ctx, phase) {
  const p = edit.progress, now = clock(), limitMs = edit.time_limit_seconds * 1000 * editTiming.scale, elapsed = now - (p.windowStartedAt ?? now), final = elapsed >= limitMs;
  const healthUrl = siteInfo(edit.site_id).site.config.healthUrl || undefined;
  let answer;
  try { answer = await call(ctx.server, { ...ctx.base, operation: 'edit-poll', services: ctx.services, ...(healthUrl ? { healthUrl } : {}), windowStartedAt: p.helperStartedAt, timeLimitSeconds: edit.time_limit_seconds, final }); }
  catch { answer = null; }
  if (answer?.ok === false || (answer && !['waiting', 'healthy', 'unhealthy'].includes(answer.state))) answer = null;
  if (!answer && final) answer = { state: 'unhealthy', unreachable: true };
  if (answer?.state === 'healthy') {
    const seconds = Number.isInteger(answer.healthSeconds) && answer.healthSeconds >= 0 ? answer.healthSeconds : Math.round(elapsed / 1000);
    atomic(() => {
      if (phase === 'check_health') { save(edit, {}, { health_seconds: seconds }); setStep(edit.id, 'check_health', 'done', `Healthy after ${seconds} s`); goFinish(edit, 'applied'); }
      else goFinish(edit, 'rolled_back', { reason: p.reasonPending, failedStep: p.failedStep });
    });
    return;
  }
  if (answer?.state === 'unhealthy' || (final && answer)) {
    const reason = answer.unreachable ? `${SAY.unreachable} The health check could not finish.` : SAY.unhealthy(edit.time_limit_seconds);
    if (phase === 'check_health') atomic(() => { setStep(edit.id, 'check_health', 'failed', reason); goRollBack(edit, reason, 'check_health'); });
    else goAttention(edit, 'roll_back', SAY.previousUnhealthy);
    return;
  }
  save(edit, { nextPollAt: now + editTiming.pollSeconds * 1000 * editTiming.scale, polls: (p.polls ?? 0) + 1 });
}

// ---------- worker start ----------
// A step that was running when the worker stopped: its job fails. Prepare and apply have an unknown outcome on the server,
// so edit-status decides next (files still original -> failed; candidate written -> roll_back). Polls, rollback, the data
// restore and finish are idempotent and simply run again.
export function recoverInterruptedSiteEdits() {
  for (const job of db.prepare("SELECT * FROM jobs WHERE type='site-edit' AND status='edit_running'").all()) {
    db.prepare("UPDATE jobs SET status='failed',stage='failed',error='Worker interrupted; the Safe Edit resumes from its journal.',finished_at=? WHERE id=? AND status='edit_running'").run(iso(clock()), job.id);
    const { editId, step } = parseJson(job.details || '{}', {}), edit = editId && loadEdit(editId);
    if (!edit || edit.result !== null || edit.progress.phase !== step) continue;
    if (['prepare', 'apply'].includes(step)) moveTo(edit, 'recover', { interrupted: step, recoverWhy: 'restart' });
  }
}

// ---------- API side: load, review, apply, cancel, retry, restore backup ----------
const siteFor = siteId => {
  const site = db.prepare('SELECT * FROM sites WHERE id=?').get(siteId);
  if (!site) throw httpError(404, 'NOT_FOUND', 'Site not found.');
  if (db.prepare('SELECT 1 FROM site_archives WHERE site_id=?').get(siteId)) throw httpError(409, 'SITE_ARCHIVED', 'This site was removed from active sites.');
  const config = parseJson(site.config, {});
  if (config.kind === 'static') throw httpError(409, 'NOT_EDITABLE', 'A static site has no containers to edit.');
  const server = db.prepare('SELECT * FROM servers WHERE id=?').get(site.server_id);
  if (!server) throw httpError(404, 'NOT_FOUND', 'Server not found.');
  return { site: { ...site, config }, server };
};
const unreachableError = () => httpError(502, 'SERVER_UNREACHABLE', 'The server could not be reached. Try again.');
async function editContext(siteId) {
  const { site, server } = siteFor(siteId);
  let resolved;
  try { resolved = await resolveInvocation(site, server, target => call(target, { operation: 'discover' })); }
  catch (error) { if (error.status) throw error; throw unreachableError(); }
  if (resolved.problem) throw httpError(422, 'NOT_EDITABLE', resolved.problem);
  const config = siteInfo(site.id).site.config, found = allowedRoots(site.config, resolved);
  // The helper needs at least one site folder. A single container without saved files gets its own maintenance folder,
  // which only DockNest writes; Compose sites always have their project folder.
  const roots = found.length ? found : [config.maintenance.directory];
  return { site, server, resolved, base: { editId: id(), siteId: site.id, invocation: helperInvocation(resolved), allowedRoots: roots, config, sshPort: server.port }, roots };
}
// A read-only op (load, check). A busy site lock is 409; any other refusal is one fixed reason with its code.
const refusal = code => (code === 'SITE_BUSY' ? httpError(409, 'SITE_BUSY', REASONS.SITE_BUSY) : httpError(422, code ?? 'NOT_EDITABLE', reasonFor(code, REASONS.NOT_EDITABLE)));
async function helperRead(server, request, { refusalIsAnswer = false } = {}) {
  let answer;
  try { answer = await call(server, request); }
  catch (error) {
    const failure = classify(error);
    if (failure.kind === 'remote') throw refusal(failure.code);
    throw unreachableError();
  }
  // The helper answers every refusal as a result with ok: false (remote/helper/edit.py); edit-check's are the caller's.
  if (answer?.ok === false && !refusalIsAnswer) throw refusal(helperCode(answer.code));
  return answer;
}

// Reasons a tab is not usable, by the helper's code. Unknown codes get a general sentence.
const TAB_REASONS = Object.freeze({ EDIT_IN_COMPOSE: 'Edit this in Compose.', AMBIGUOUS: 'Edit this in Compose.', NO_COMPOSE: 'This site has no Compose file to edit.', NO_ENV: 'This site has no environment file.', SERVICE_FROZEN: REASONS.SERVICE_FROZEN, COMPOSE_TOO_OLD: REASONS.COMPOSE_TOO_OLD, FILE_TOO_LARGE: REASONS.FILE_TOO_LARGE, IMAGE_FROM_ENV: 'This image is set in Environment. Edit it there.' });
const str = (value, max = 512) => (typeof value === 'string' ? value.slice(0, max) : '');
// Compose reports published ports as text ("8080"); a range or a ${VAR} is not one number.
const portNumber = value => { const number = typeof value === 'string' && /^\d{1,5}$/.test(value) ? Number(value) : value; return Number.isInteger(number) && number >= 1 && number <= 65535 ? number : null; };
// Where the guided Ports and Image tabs make their text edit: one line (1-based) of one of the site's Compose files.
const location = value => (value && typeof value.file === 'string' && Number.isInteger(value.line) && value.line >= 1 ? { file: value.file, line: value.line } : null);
function normalizeLoad(answer) {
  // A file the helper could not read (too large, not UTF-8, missing) comes with text and sha256 null; the Compose tab
  // then says why. Such a file cannot be part of a review.
  const files = (Array.isArray(answer?.files) ? answer.files : []).filter(file => typeof file?.path === 'string').map(file => ({ path: file.path, inode: Number.isFinite(file.inode) ? file.inode : null, sha256: /^[0-9a-f]{64}$/.test(file.sha256 ?? '') ? file.sha256 : null, text: typeof file.text === 'string' && /^[0-9a-f]{64}$/.test(file.sha256 ?? '') ? file.text : null }));
  const env = (Array.isArray(answer?.env) ? answer.env : []).filter(item => typeof item?.file === 'string').map(item => ({ file: item.file, keys: (Array.isArray(item.keys) ? item.keys : []).filter(key => typeof key === 'string' && ENV_KEY.test(key)).map(key => ({ key, set: true })) }));
  const services = (Array.isArray(answer?.services) ? answer.services : []).filter(item => typeof item?.name === 'string').map(item => ({ name: str(item.name, 128), image: str(item.image), ports: (Array.isArray(item.ports) ? item.ports : []).map(port => ({ host: portNumber(port?.host), container: portNumber(port?.container), protocol: port?.protocol === 'udp' ? 'udp' : 'tcp', hostIp: str(port?.hostIp, 64), at: location(port?.at), ...(helperCode(port?.reason) ? { reason: helperCode(port.reason) } : {}) })), frozen: !!item.frozen, healthcheck: !!item.healthcheck, imageAt: location(item.imageAt), imageReason: helperCode(item.imageReason), imageVariable: typeof item.imageVariable === 'string' && ENV_KEY.test(item.imageVariable) ? item.imageVariable : null }));
  const usable = Object.fromEntries(['compose', 'env', 'ports', 'image'].map(tab => [tab, !!answer?.usable?.[tab]]));
  const reasons = {};
  for (const [tab, code] of Object.entries(answer?.reasons ?? {})) if (['compose', 'env', 'ports', 'image'].includes(tab)) { const known = helperCode(code); { const variable = tab === 'image' && known === 'IMAGE_FROM_ENV' && typeof answer?.variables?.image === 'string' && ENV_KEY.test(answer.variables.image) ? answer.variables.image : null; reasons[tab] = { code: known ?? 'UNAVAILABLE', message: variable ? `Edit ${variable} in Environment.` : TAB_REASONS[known] ?? (known && Object.hasOwn(REASONS, known) ? REASONS[known] : 'Not available for this site.'), ...(variable ? { variable } : {}) }; } }
  return { files, env, services, usable, reasons, composeVersion: str(answer?.composeVersion, 32) || null };
}

// GET /api/sites/:id/edit: the editable view. Environment keys only, never values.
export async function editView(siteId) {
  const ctx = await editContext(siteId);
  const loaded = normalizeLoad(await helperRead(ctx.server, { ...ctx.base, operation: 'edit-load' }));
  const active = editingSite(siteId);
  return { siteId, kind: ctx.resolved.kind, composeVersion: loaded.composeVersion, files: loaded.files, env: loaded.env, services: loaded.services, usable: loaded.usable, reasons: loaded.reasons, healthUrl: !!ctx.site.config.healthUrl, timeLimit: { ...LIMITS.timeLimit }, limits: { fileBytes: LIMITS.fileBytes, envKeys: LIMITS.envKeys, valueBytes: LIMITS.valueBytes }, active: active ? { id: active.id, state: active.state } : null };
}

// Plain checks on the request before anything reaches the server.
function refuse(code, field, message = REASONS[code]) { return httpError(422, code, message, field ? { field } : {}); }
export function checkEnvEntries(env) {
  const seen = new Set();
  for (const entry of env) {
    if (!ENV_KEY.test(entry.key)) throw refuse('ENV_REFUSED', `env.${String(entry.key).slice(0, 60).replace(/[^A-Za-z0-9_]/g, '_')}`, 'Environment keys use letters, digits and underscores, and do not start with a digit.');
    if (ENV_REFUSED_PREFIX.test(entry.key)) throw refuse('ENV_REFUSED', `env.${entry.key}`, 'Keys starting with COMPOSE_, DOCKER_ or BUILDKIT_ cannot be set here: they would change how Docker runs the site.');
    if (!entry.remove && /[\r\n\0]/.test(entry.value ?? '')) throw refuse('ENV_REFUSED', `env.${entry.key}`, 'Environment values cannot hold line breaks.');
    if (!entry.remove && Buffer.byteLength(entry.value ?? '', 'utf8') > LIMITS.valueBytes) throw refuse('ENV_REFUSED', `env.${entry.key}`, 'Environment values are at most 8 KB.');
    const key = entry.file + '\0' + entry.key;
    if (seen.has(key)) throw refuse('ENV_REFUSED', `env.${entry.key}`, 'Each environment key can change once per review.');
    seen.add(key);
  }
}

// POST /api/sites/:id/edit/review: the gate runs on the server; the answer is the diff (values masked), a summary,
// warnings and a one-use token. Nothing is stored.
export async function reviewSiteEdit(siteId, body, { userId, sessionHash }) {
  const files = body.files ?? [], env = body.env ?? [], containerChanges = body.containerChanges ?? null;
  checkEnvEntries(env);
  const ctx = await editContext(siteId);
  const loaded = normalizeLoad(await helperRead(ctx.server, { ...ctx.base, operation: 'edit-load' }));
  const envFiles = new Set(loaded.env.map(item => item.file)), byPath = new Map(loaded.files.map(file => [file.path, file]));
  for (const file of files) {
    const original = byPath.get(file.path);
    if (!original || envFiles.has(file.path)) throw refuse('PATH_REFUSED', 'files', 'Only the site\'s own Compose files can be edited here.');
    if (!original.sha256 || original.sha256 !== file.sha256) throw refuse('FILE_CHANGED', 'files');
  }
  const changedFiles = files.filter(file => byPath.get(file.path).text !== file.text);
  const existing = new Map(loaded.env.map(item => [item.file, new Set(item.keys.map(key => key.key))]));
  for (const entry of env) if (!existing.has(entry.file)) throw refuse('PATH_REFUSED', 'env', 'Only the site\'s own environment files can be edited here.');
  const envChanges = env.filter(entry => !entry.remove || existing.get(entry.file).has(entry.key));
  // Ports and image of a single-container site travel as containerChanges (there is no Compose text to edit).
  if (containerChanges && ctx.resolved.kind !== 'container') throw refuse('NOT_EDITABLE', 'containerChanges', 'Ports and image of a Compose site change in its Compose file.');
  if (!changedFiles.length && !envChanges.length && !containerChanges) throw httpError(422, 'NO_CHANGES', 'Nothing changed.');
  const request = { ...ctx.base, operation: 'edit-check', files: changedFiles.map(({ path, sha256, text }) => ({ path, sha256, text })), env: envChanges.map(entry => (entry.remove ? { file: entry.file, key: entry.key, remove: true } : { file: entry.file, key: entry.key, value: entry.value })), ...(containerChanges ? { containerChanges } : {}) };
  const answer = await helperRead(ctx.server, request, { refusalIsAnswer: true });
  if (answer?.ok !== true) {
    const code = helperCode(answer?.code), known = code && REVIEW_CODES.includes(code) ? code : 'COMPOSE_INVALID';
    if (code === 'SITE_BUSY') throw refusal(code);
    throw httpError(422, known, REASONS[known], typeof answer?.field === 'string' && FIELD.test(answer.field) ? { field: answer.field } : {});
  }
  const verdict = answer.verdict ?? {};
  const hashes = (Array.isArray(verdict.hashes) ? verdict.hashes : []).filter(item => typeof item?.path === 'string').map(item => ({ path: item.path, before: str(item.before, 64), after: str(item.after, 64) }));
  const changed = (Array.isArray(verdict.changed) ? verdict.changed : []).filter(path => typeof path === 'string' && FIELD.test(path));
  const envChanged = { added: [], replaced: [], removed: [] };
  for (const entry of envChanges) envChanged[entry.remove ? 'removed' : existing.get(entry.file).has(entry.key) ? 'replaced' : 'added'].push(entry.key);
  const newPorts = (Array.isArray(verdict.newPorts) ? verdict.newPorts : []).filter(port => Number.isInteger(port?.host)).map(port => ({ host: port.host, allAddresses: !!port.allAddresses }));
  const imageChanged = !!verdict.imageChanged, reviewedModelSha256 = str(verdict.reviewedModelSha256, 64);
  if (!/^[0-9a-f]{64}$/.test(reviewedModelSha256)) throw httpError(422, 'COMPOSE_INVALID', REASONS.COMPOSE_INVALID);
  const dataBytes = imageChanged && Number.isSafeInteger(verdict.dataBytes) && verdict.dataBytes >= 0 ? verdict.dataBytes : null;
  const tabs = tabsUsed({ files: changedFiles, env: envChanges, changed: [...changed, ...(containerChanges?.image ? ['container.image'] : []), ...(containerChanges?.ports ? ['container.ports'] : [])] });
  const healthChecks = loaded.services.some(service => service.healthcheck), healthUrl = !!ctx.site.config.healthUrl;
  const warnings = [];
  for (const port of newPorts) if (port.allAddresses) warnings.push({ code: 'PUBLIC_PORT', port: port.host, message: `Port ${port.host} is reachable from the internet.` });
  const secretKeys = [...new Set(changedFiles.flatMap(file => inlineSecretKeys(file.text)))];
  if (secretKeys.length) warnings.push({ code: 'INLINE_SECRETS', keys: secretKeys.slice(0, 20), message: 'Move secrets to Environment: they are safer there.' });
  if (dataBytes !== null && dataBytes >= 1024 ** 3) warnings.push({ code: 'LARGE_DATA_COPY', bytes: dataBytes, message: 'The safety copy of the data is large, so the change takes longer and needs that much free disk space.' });
  if (!healthChecks && !healthUrl) warnings.push({ code: 'NO_HEALTH_CHECK', message: 'This site has no health check or health URL, so only "running and stable" counts.' });
  const summary = { tabs, changed, envChanged, imageChanged, dataRollback: imageChanged, dataBytes, maintenance: true, newPorts, health: healthUrl ? 'url' : healthChecks ? 'docker' : 'running', timeLimitSeconds: LIMITS.timeLimit.default, files: hashes };
  const diff = reviewDiff({ originals: loaded.files, files: changedFiles, env: envChanges.map(entry => ({ ...entry, existed: existing.get(entry.file).has(entry.key) })) });
  const candidate = { files: request.files, env: request.env, ...(containerChanges ? { containerChanges } : {}), reviewedModelSha256, originalHashes: hashes.map(({ path, before }) => ({ path, before })) };
  const meta = { dataBytes, invocationSha: invocationHash(ctx.resolved), invocation: ctx.base.invocation, allowedRoots: ctx.roots, services: loaded.services.map(service => service.name), changes: changesRecord({ tabs, changed, envChanged, hashes, imageChanged }), imageChanged };
  const { token, expiresAt } = issueToken({ userId, sessionHash, siteId, hashes, candidate, meta });
  return { token, expiresAt: iso(expiresAt), diff, summary, warnings };
}

// POST /api/sites/:id/edit/apply: 202 with the new edit. The token is used up here; it is put back only when the site
// is busy for a moment, so the owner can try again without typing secrets again.
export function applySiteEdit(siteId, { token, timeLimitSeconds = LIMITS.timeLimit.default }, { userId, sessionHash }) {
  const { site } = siteFor(siteId);
  const taken = takeToken(token, { userId, sessionHash, siteId });
  const editId = id(), jobId = id(), at = iso(clock()), { meta, candidate } = taken;
  try {
    atomic(() => {
      if (deploymentHeld(db)) throw httpError(409, 'DEPLOYMENT_HOLD', 'An update is in progress. Try again when it finishes.');
      if (movingSite(siteId)) throw httpError(409, 'MOVE_RUNNING', 'This site is being moved. Wait for the move to finish first.');
      if (editingSite(siteId)) throw httpError(409, 'EDIT_RUNNING', 'This site already has a change in progress.');
      if (busySite(siteId)) throw httpError(409, 'SITE_BUSY', 'This site is busy with a backup or restore. Try again when it finishes.');
      const recent = db.prepare('SELECT COUNT(*) AS n FROM site_edits WHERE site_id=? AND created_at>?').get(siteId, iso(clock() - 3600_000)).n;
      if (recent >= LIMITS.editsPerHour) throw httpError(429, 'RATE_LIMITED', 'This site had 10 changes in the last hour. Try again later.');
      const stored = storedInvocation(siteId);
      if (!stored || invocationHash(stored) !== meta.invocationSha) throw httpError(409, 'REVIEW_EXPIRED', 'The site\'s Compose setup changed. Review the change again.');
      db.prepare("INSERT INTO site_edits(id,site_id,server_id,state,changes,progress,time_limit_seconds,data_rollback,created_by,created_at) VALUES(?,?,?,'queued',?,?,?,?,?,?)")
        .run(editId, siteId, site.server_id, JSON.stringify(meta.changes), JSON.stringify({ phase: 'backup', invocationSha: meta.invocationSha, ...(Number.isSafeInteger(meta.dataBytes) ? { dataBytes: meta.dataBytes } : {}) }), timeLimitSeconds, meta.imageChanged ? 1 : 0, userId, at);
      for (const step of STEPS) db.prepare("INSERT INTO site_edit_steps(edit_id,step,state) VALUES(?,?,'pending')").run(editId, step);
      const details = { editId, step: 'backup', targetServerId: site.server_id, invocation: meta.invocation, allowedRoots: meta.allowedRoots, services: meta.services, payload: seal(JSON.stringify(candidate)) };
      db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,'site-edit','edit_waiting','backup',?,?)").run(jobId, siteId, at, JSON.stringify(details));
      db.prepare('UPDATE site_edits SET job_id=? WHERE id=?').run(jobId, editId);
      audit(userId, 'site.edit.requested', siteId, { edit: editId, tabs: meta.changes.tabs, fields: meta.changes.changed, envKeys: meta.changes.env, files: meta.changes.files, dataRollback: !!meta.imageChanged, timeLimitSeconds });
    });
  } catch (error) {
    if (/UNIQUE constraint failed: site_edits\.site_id/.test(error.message)) { taken.restore(); throw httpError(409, 'EDIT_RUNNING', 'This site already has a change in progress.'); }
    if (['DEPLOYMENT_HOLD', 'MOVE_RUNNING', 'EDIT_RUNNING', 'SITE_BUSY', 'RATE_LIMITED'].includes(error.code)) taken.restore();
    throw error;
  }
  return { edit: { id: editId } };
}

const editFor = editId => loadEdit(String(editId)) ?? (() => { throw httpError(404, 'NOT_FOUND', 'Safe Edit not found.'); })();
export function cancelSiteEdit(editId, actor) {
  const edit = editFor(editId);
  if (edit.result !== null) throw httpError(409, 'EDIT_FINISHED', 'This change has already finished.');
  if (!cancellable(edit)) throw httpError(409, 'CANCEL_TOO_LATE', 'The change is being applied, so it can no longer be cancelled. If it does not come up, it is undone by itself.');
  if (db.prepare('UPDATE site_edits SET cancel_requested=1 WHERE id=? AND result IS NULL AND cancel_requested=0').run(edit.id).changes) audit(actor, 'site.edit.cancel_requested', edit.site_id, { edit: edit.id });
  advanceSiteEdit(edit.id);
  return { cancelRequested: true };
}
const restoreRunning = edit => ['queued', 'running'].includes(restoreJobState(edit.progress.restoreJobId) ?? '');
export function retrySiteEdit(editId, actor) {
  const edit = editFor(editId);
  if (edit.state !== 'needs_attention' || !edit.progress.attentionStep) throw httpError(409, 'NOT_NEEDED', 'This change does not need your attention.');
  if (restoreRunning(edit)) throw httpError(409, 'RESTORE_RUNNING', 'The backup is being restored. Wait for it to finish.');
  const phase = edit.progress.attentionStep;
  atomic(() => {
    moveTo(edit, phase === 'finish' ? 'finish' : phase === 'recover' ? 'recover' : 'roll_back', { attentionStep: null, restoreFailed: false });
    audit(actor, 'site.edit.retry', edit.site_id, { edit: edit.id, step: PHASE_STEP[phase] ?? 'roll_back' });
  });
  advanceSiteEdit(edit.id);
  return { edit: { id: edit.id, state: loadEdit(edit.id).state } };
}
export async function restoreSiteEditBackup(editId, actor) {
  const edit = editFor(editId);
  if (edit.state !== 'needs_attention') throw httpError(409, 'NOT_NEEDED', 'This change does not need your attention.');
  if (!edit.backup_id) throw httpError(409, 'NO_BACKUP', 'The backup from before the change is no longer available.');
  if (restoreRunning(edit)) throw httpError(409, 'RESTORE_RUNNING', 'The backup is already being restored.');
  let queued;
  try { queued = await editTransport.enqueueRestore(edit.backup_id, { serverId: edit.server_id, mode: 'new-copy' }, 'edit:' + edit.id); }
  catch (error) { throw httpError(409, 'RESTORE_REFUSED', error?.status === 409 && typeof error.message === 'string' && error.message.length <= 200 ? error.message : 'The backup could not be restored right now. Try again.'); }
  atomic(() => { save(loadEdit(edit.id), { restoreJobId: queued.id, restoreFailed: false }); audit(actor, 'site.edit.restore_backup', edit.site_id, { edit: edit.id, backup: edit.backup_id, job: queued.id }); });
  return { restore: { jobId: queued.id } };
}
