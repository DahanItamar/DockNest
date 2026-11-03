// Self-heal engine (docs/self-heal.md). Runs in the worker.
// - recordHealth(): the event stream (streams.js) reports a health change of a watched container; it is validated and
//   recorded. An unhealthy container opens an episode (one `unhealthy` row); the next healthy event closes it
//   (`recovered`). Events never start anything by themselves.
// - tickSelfHeal(): turns open episodes into short `self-heal` jobs (heal_queued, sorted first by claimJob) when the
//   window, gap and limit allow it. It reads only the database, never a server.
// - healClaimCheck(): inside claimJob's BEGIN IMMEDIATE, a queued restart steps aside (recorded as `skipped`) when the
//   site has queued work, an unfinished move, maintenance, the 2-minute settle time or the setting was turned off.
// - executeHealJob(): one `self-heal-restart` helper call; the helper re-checks the lock, maintenance marker, labels,
//   container ID, running state and health right before it acts.
// Alerts (owner decision 2): self_heal.restarted for the first restart of a container in a window, and
// self_heal.gave_up (limit reached or container recreated) once per container per window. Every restart is in the
// history and the audit log.
import { db, id, transaction } from '../db.js';
import { deploymentHeld } from '../deployment-hold.js';
import { transport, jobRunners, claimHooks, claimJob, siteInfo, movingSite } from '../engine.js';
import { emit } from '../alerts/delivery.js';
import { CONTAINER, CONTAINER_ID, STATUSES, KEEP_DAYS, TRANSIENT, RETRYABLE, REASONS, reasonText, timing } from './limits.js';

// Clock, SSH and timers; tests replace members.
export const healClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: timer => clearTimeout(timer) };
export const healTransport = { remote: (server, request) => transport.remote(server, request) };
const iso = ms => new Date(ms).toISOString();
const ACTOR = 'self-heal';
// Audit rows on the self-heal clock, so "once per window" compares like with like (tests move the clock).
const audit = (actor, action, target, detail) => db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?)').run(id(), actor, action, target, JSON.stringify(detail), iso(healClock.now()));

export function settingsOf(siteId) {
  const row = db.prepare('SELECT * FROM self_heal_settings WHERE site_id=?').get(siteId);
  if (!row) return null;
  let watched = []; try { watched = JSON.parse(row.watched); } catch { watched = []; }
  return { ...row, watched: Array.isArray(watched) ? watched : [] };
}
// The newest history row of one container (rowid breaks ties inside one millisecond).
const latestOf = (siteId, container) => db.prepare('SELECT *,rowid FROM self_heal_events WHERE site_id=? AND container=? ORDER BY at DESC,rowid DESC LIMIT 1').get(siteId, container) ?? null;
// An open episode that still wants a restart: an unhealthy event not yet acted on, one that waited for a reason that
// clears by itself (busy, maintenance, settle...), an attempt to retry after the gap (a failed restart, an unreachable
// server, the server-side lock or maintenance marker), or a limit reached, retried when the window has room again. A
// healthy event (recovered) or a check by the helper (no longer unhealthy, not running, recreated...) closes it.
// An interrupted restart (the worker stopped while it ran) is never retried: it may have happened; the next event decides.
export const wantsRestart = row => Boolean(row) && (row.kind === 'unhealthy' || (row.kind === 'restart_failed' && row.reason !== 'interrupted') || row.kind === 'limit_reached' || (row.kind === 'skipped' && (TRANSIENT.has(row.reason) || RETRYABLE.has(row.reason))));
function record(event) {
  const row = { id: id(), at: iso(healClock.now()), reason: null, jobId: null, containerId: null, ...event };
  db.prepare('INSERT INTO self_heal_events(id,site_id,server_id,container,container_id,kind,reason,job_id,at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(row.id, row.siteId, row.serverId, row.container, row.containerId, row.kind, row.reason ? String(row.reason).slice(0, 300) : null, row.jobId, row.at);
  if (row.kind === 'unhealthy' || row.kind === 'recovered') db.prepare('UPDATE self_heal_settings SET last_event_at=? WHERE site_id=?').run(row.at, row.siteId);
  return row;
}
// Attempts in the window: restarts, failed restarts and retryable attempts that never reached Docker.
const restartsSince = (siteId, container, sinceMs) => db.prepare(`SELECT COUNT(*) AS n,MAX(at) AS last,MIN(at) AS first FROM self_heal_events WHERE site_id=? AND container=? AND at>? AND (kind IN ('restarted','restart_failed') OR (kind='skipped' AND reason IN (${[...RETRYABLE].map(() => '?').join(',')})))`).get(siteId, container, iso(sinceMs), ...RETRYABLE);
const settleEnds = (siteId, nowMs) => { const last = db.prepare("SELECT MAX(finished_at) AS at FROM jobs WHERE site_id=? AND type NOT IN ('self-heal','restore-test') AND finished_at IS NOT NULL").get(siteId)?.at; return last ? Date.parse(last) + timing.settleMs - nowMs : 0; };
const activeHealJob = (siteId, container) => db.prepare("SELECT id FROM jobs WHERE site_id=? AND type='self-heal' AND status IN ('heal_queued','heal_running') AND json_extract(details,'$.container')=?").get(siteId, container);
const siteNames = siteId => db.prepare('SELECT s.name AS site,s.server_id,v.name AS server FROM sites s JOIN servers v ON v.id=s.server_id WHERE s.id=?').get(siteId);
const zoneFor = siteId => { try { return db.prepare('SELECT timezone FROM policies WHERE site_id=?').get(siteId)?.timezone || 'UTC'; } catch { return 'UTC'; } };

// Maintenance as DockNest last set it for the site (POST /api/sites/:id/maintenance writes `maintenance.set`). The
// helper also re-checks the marker on the server right before restarting.
function inMaintenance(siteId) {
  const row = db.prepare("SELECT detail FROM audit_events WHERE action='maintenance.set' AND target=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(siteId);
  try { return JSON.parse(row?.detail ?? '{}').enabled === true; } catch { return false; }
}
// Why a restart of this site must wait now, or null. Used by the tick (to record the wait once) and at claim time.
export function blockReason(siteId, nowMs = healClock.now(), ownJobId = null) {
  if (db.prepare('SELECT 1 FROM site_archives WHERE site_id=?').get(siteId)) return 'removed';
  if (deploymentHeld(db)) return 'deployment_hold';
  if (db.prepare("SELECT 1 FROM jobs WHERE site_id=? AND id IS NOT ? AND status IN ('running','recovery_required','move_running','edit_running','edit_waiting','heal_running')").get(siteId, ownJobId)) return 'site_busy';
  if (db.prepare("SELECT 1 FROM jobs WHERE site_id=? AND status IN ('queued','move_queued','edit_queued')").get(siteId)) return 'work_queued';
  // An unfinished Safe Edit pauses self-heal for its site between its steps too (docs/safe-edit.md, "Locks").
  if (db.prepare('SELECT 1 FROM site_edits WHERE site_id=? AND result IS NULL').get(siteId)) return 'site_busy';
  if (movingSite(siteId)) return 'moving';
  if (inMaintenance(siteId)) return 'maintenance';
  if (db.prepare("SELECT 1 FROM jobs WHERE site_id=? AND type NOT IN ('self-heal','restore-test') AND finished_at IS NOT NULL AND finished_at>?").get(siteId, iso(nowMs - timing.settleMs))) return 'settling';
  return null;
}

function alert(type, siteId, { at, jobId = null, code } = {}, key) {
  const names = siteNames(siteId);
  if (!names) return;
  try { emit({ type, key, at, jobId, code, siteId, serverId: names.server_id, siteName: names.site, serverName: names.server, timeZone: zoneFor(siteId) }); }
  catch (error) { console.error(`Self-heal alert could not be queued: ${error.code ?? error.name}`); }
}
// Once per container per window: the audit row is the record that it was sent.
export function gaveUp(siteId, container, reason, nowMs = healClock.now()) {
  const settings = settingsOf(siteId), since = iso(nowMs - (settings?.window_minutes ?? 60) * 60_000);
  if (db.prepare("SELECT 1 FROM audit_events WHERE action='self_heal.gave_up' AND target=? AND json_extract(detail,'$.container')=? AND created_at>?").get(siteId, container, since)) return false;
  audit(ACTOR, 'self_heal.gave_up', siteId, { container, reason });
  alert('self_heal.gave_up', siteId, { at: iso(nowMs), code: reason }, `occ:self-heal:${siteId}:${container}:gave-up:${nowMs}`);
  return true;
}

// ---------- events from the stream ----------
// `event` was validated by streams.js and mapped to its site through the watched names of that server.
export function recordHealth({ siteId, serverId, container, status, id: containerId }) {
  if (healRunner.halted) return null;
  if (!CONTAINER.test(container) || !STATUSES.includes(status) || !CONTAINER_ID.test(containerId)) return null;
  const settings = settingsOf(siteId);
  if (!settings?.enabled || !settings.watched.some(entry => entry.name === container)) return null;
  const latest = latestOf(siteId, container);
  if (status === 'unhealthy') {
    if (wantsRestart(latest)) return null; // already open and waiting
    const row = record({ siteId, serverId, container, containerId, kind: 'unhealthy' });
    tickSite(siteId);
    return row;
  }
  // `starting` is ignored (start_period and restarts report it); healthy closes an open episode.
  if (status === 'healthy' && latest && latest.kind !== 'recovered') return record({ siteId, serverId, container, containerId, kind: 'recovered' });
  return null;
}

// ---------- running restarts at once ----------
// The worker loop runs one job at a time, so a restart queued while another site's backup runs would wait for it. The
// worker therefore sets `healRunner.active`, and a restart queued by an event (or by a gap ending) is claimed and run
// at once beside the running job: claimJob's site rules (src/job-claim.js) keep it off a busy site, the claim is
// atomic, and only self-heal jobs are claimed here. Off unless the worker turns it on (tests drive claims themselves).
// `halted`: set once when this worker lost its lease (src/worker.js); from then on nothing here records, queues or
// schedules anything. Separate from `active`, which tests leave off while they drive claims themselves.
// `serverConnected`: whether the server's event stream is connected (set by streams.js); an unreachable server is
// retried only then, so a server that is down raises no limit or gave_up alerts.
export const healRunner = { active: () => false, running: null, halted: false, serverConnected: () => true };
export function haltSelfHeal() { healRunner.halted = true; cancelRechecks(); }
export const armedRechecks = () => rechecks.size;
export function healNow() {
  if (healRunner.running || !healRunner.active()) return healRunner.running;
  healRunner.running = (async () => {
    try {
      for (let count = 0; count < 50 && healRunner.active(); count++) {
        const job = claimJob({ healOnly: true });
        if (!job) break;
        await executeHealJob(job);
      }
    } catch (error) { console.error(`Self-heal restart step failed: ${error.code ?? error.name}`); }
    finally { healRunner.running = null; }
  })();
  return healRunner.running;
}
// One re-check when a wait ends: the 60 s gap after an attempt, the settle time after site work, or the window of a
// reached limit. Scheduled by the event that started the wait, never a polling loop; the worker's heartbeat tick
// (every 15 s, src/worker.js) covers waits that end with another job, such as a backup finishing.
const rechecks = new Map();
function recheckAt(siteId, ms) {
  if (rechecks.has(siteId) || !healRunner.active() || healRunner.halted) return;
  rechecks.set(siteId, healClock.setTimeout(() => { rechecks.delete(siteId); if (!healRunner.active() || healRunner.halted) return; try { tickSite(siteId); } catch (error) { console.error(`Self-heal re-check failed: ${error.code ?? error.name}`); } }, Math.max(1000, ms)));
}
export function cancelRechecks() { for (const timer of rechecks.values()) healClock.clearTimeout(timer); rechecks.clear(); }

// ---------- the tick ----------
export function tickSelfHeal(nowMs = healClock.now()) {
  for (const { site_id: siteId } of db.prepare('SELECT site_id FROM self_heal_settings WHERE enabled=1 AND site_id NOT IN (SELECT site_id FROM site_archives)').all()) {
    try { tickSite(siteId, nowMs); } catch (error) { console.error(`Self-heal tick failed for a site: ${error.code ?? error.name}`); }
  }
}
function tickSite(siteId, nowMs = healClock.now()) {
  if (healRunner.halted) return;
  const settings = settingsOf(siteId);
  if (!settings?.enabled) return;
  const serverId = db.prepare('SELECT server_id FROM sites WHERE id=?').get(siteId)?.server_id;
  if (!serverId) return;
  // The newest row of every container that has one, keeping only those that still want a restart.
  const open = db.prepare("SELECT * FROM (SELECT e.*,ROW_NUMBER() OVER (PARTITION BY container ORDER BY at DESC,rowid DESC) AS n FROM self_heal_events e WHERE site_id=?) WHERE n=1 AND kind IN ('unhealthy','skipped','restart_failed','limit_reached')").all(siteId).filter(wantsRestart);
  let queued = false;
  for (const row of open) {
    const entry = settings.watched.find(item => item.name === row.container);
    if (!entry || activeHealJob(siteId, row.container)) continue;
    if (row.kind === 'skipped' && row.reason === 'unreachable' && !healRunner.serverConnected(serverId)) continue; // retried once the stream is back
    transaction(() => {
      const latest = latestOf(siteId, row.container);
      if (!wantsRestart(latest) || latest.id !== row.id) return;
      const block = blockReason(siteId, nowMs);
      if (block) {
        if (latest.kind === 'unhealthy') record({ siteId, serverId, container: row.container, containerId: row.container_id, kind: 'skipped', reason: block });
        if (block === 'settling') recheckAt(siteId, settleEnds(siteId, nowMs) + 50);
        return;
      }
      const windowMs = settings.window_minutes * 60_000, restarts = restartsSince(siteId, row.container, nowMs - windowMs);
      if (restarts.n >= settings.max_restarts) {
        // One limit_reached row (and one gave_up per window); re-checked when the oldest attempt leaves the window.
        if (latest.kind !== 'limit_reached') { record({ siteId, serverId, container: row.container, containerId: row.container_id, kind: 'limit_reached', reason: 'limit' }); gaveUp(siteId, row.container, 'limit', nowMs); }
        recheckAt(siteId, Date.parse(restarts.first) + windowMs - nowMs + 50);
        return;
      }
      if (restarts.last && nowMs - Date.parse(restarts.last) < timing.minGapMs) { recheckAt(siteId, Date.parse(restarts.last) + timing.minGapMs - nowMs + 50); return; } // the gap
      if (!row.container_id) return;
      const jobId = id();
      db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,'self-heal','heal_queued','queued',?,?)")
        .run(jobId, siteId, iso(nowMs), JSON.stringify({ container: row.container, containerId: row.container_id, project: entry.project ?? null, service: entry.service ?? null, eventId: row.id }));
      queued = true;
    });
  }
  if (queued) healNow();
}

// ---------- claim ----------
export function healClaimCheck(job, nowMs = healClock.now()) {
  let details = {}; try { details = JSON.parse(job.details || '{}'); } catch { return 'unavailable'; }
  const settings = settingsOf(job.site_id);
  if (!settings?.enabled || !settings.watched.some(entry => entry.name === details.container)) return 'disabled';
  const block = blockReason(job.site_id, nowMs, job.id);
  if (block) return block;
  const latest = latestOf(job.site_id, details.container);
  if (latest && latest.kind === 'recovered') return 'not_unhealthy';
  return null;
}
// Called inside claimJob's transaction: the queued restart ends as skipped with its reason.
export function skipHealJob(job, reason) {
  let details = {}; try { details = JSON.parse(job.details || '{}'); } catch { details = {}; }
  if (db.prepare("UPDATE jobs SET status='completed',stage='skipped',finished_at=?,details=? WHERE id=? AND status='heal_queued'").run(iso(healClock.now()), JSON.stringify({ ...details, outcome: 'skipped', reason }), job.id).changes !== 1) return;
  const serverId = db.prepare('SELECT server_id FROM sites WHERE id=?').get(job.site_id)?.server_id ?? '';
  if (typeof details.container === 'string' && CONTAINER.test(details.container)) record({ siteId: job.site_id, serverId, container: details.container, containerId: CONTAINER_ID.test(details.containerId ?? '') ? details.containerId : null, kind: 'skipped', reason, jobId: job.id });
}
claimHooks.heal = { check: job => healClaimCheck(job), skip: skipHealJob };

// ---------- the job ----------
function finishHeal(jobId, status, stage, details, error = null) {
  return db.prepare('UPDATE jobs SET status=?,stage=?,finished_at=?,details=?,error=? WHERE id=? AND status=\'heal_running\'').run(status, stage, iso(healClock.now()), JSON.stringify(details), error, jobId).changes === 1;
}
const RESULT_CODES = new Set(['busy', 'maintenance', 'cleanup', 'missing', 'labels', 'recreated', 'not_running', 'not_unhealthy', 'timeout', 'exit_1', 'exit_125', 'exit_126', 'exit_127', 'exit_137', 'exit_other']);
jobRunners['self-heal'] = executeHealJob;
export async function executeHealJob(job) {
  let details = {}; try { details = JSON.parse(job.details || '{}'); } catch { details = {}; }
  const { container, containerId } = details;
  let site, server;
  try { ({ site, server } = siteInfo(job.site_id)); } catch { finishHeal(job.id, 'failed', 'failed', { ...details, outcome: 'skipped', reason: 'removed' }, REASONS.removed); return; }
  const base = { siteId: site.id, serverId: server.id, container, containerId, jobId: job.id };
  let result = null;
  try {
    if (!CONTAINER.test(container ?? '') || !CONTAINER_ID.test(containerId ?? '')) throw Object.assign(new Error('invalid'), { invalid: true });
    result = await healTransport.remote(server, { operation: 'self-heal-restart', siteKey: site.id, name: container, project: details.project ?? null, service: details.service ?? null, containerId, maintenanceDirectory: site.config.maintenance?.directory ?? null });
  } catch (error) {
    // Nothing was restarted: the helper never ran or refused the request. The next reconnect snapshot reports the
    // container again if it is still unhealthy.
    const reason = error.invalid ? 'unavailable' : 'unreachable';
    transaction(() => { if (finishHeal(job.id, 'failed', 'failed', { ...details, outcome: 'skipped', reason }, REASONS[reason])) record({ ...base, kind: 'skipped', reason }); });
    return;
  }
  const nowMs = healClock.now(), outcome = result?.outcome, code = RESULT_CODES.has(result?.code) ? result.code : 'exit_other';
  transaction(() => {
    if (outcome === 'restarted' || outcome === 'failed') {
      const settings = settingsOf(site.id), first = restartsSince(site.id, container, nowMs - (settings?.window_minutes ?? 60) * 60_000).n === 0;
      const failed = outcome === 'failed';
      if (!finishHeal(job.id, failed ? 'failed' : 'completed', failed ? 'failed' : 'completed', { ...details, outcome, ...(failed ? { reason: code } : {}) }, failed ? reasonText(code) : null)) return;
      const row = record({ ...base, kind: failed ? 'restart_failed' : 'restarted', reason: failed ? code : null });
      audit(ACTOR, 'self_heal.restarted', site.id, { container, job: job.id, firstInWindow: first, ...(failed ? { failed: true, reason: code } : {}) });
      if (first) alert('self_heal.restarted', site.id, { at: row.at, jobId: job.id, code: failed ? 'failed' : undefined }, `occ:self-heal:${row.id}`);
      return;
    }
    // The helper's own lock and maintenance checks are stored apart from the database-side waits, so they are not retried
    // every tick (see TRANSIENT).
    const SERVER_SIDE = { busy: 'locked', maintenance: 'maintenance_flag' };
    const reason = outcome === 'refused' && RESULT_CODES.has(result?.code) ? SERVER_SIDE[result.code] ?? result.code : 'unavailable';
    if (!finishHeal(job.id, 'completed', 'skipped', { ...details, outcome: 'skipped', reason })) return;
    record({ ...base, kind: 'skipped', reason });
    if (reason === 'recreated') gaveUp(site.id, container, 'recreated', nowMs);
  });
}

// ---------- worker start and maintenance ----------
// An interrupted restart is not retried: it may or may not have happened, so it counts toward the limit and the next
// event decides.
export function recoverInterruptedHeals() {
  for (const job of db.prepare("SELECT * FROM jobs WHERE status='heal_running'").all()) {
    let details = {}; try { details = JSON.parse(job.details || '{}'); } catch { details = {}; }
    transaction(() => {
      if (db.prepare("UPDATE jobs SET status='failed',stage='failed',finished_at=?,error=? WHERE id=? AND status='heal_running'").run(iso(healClock.now()), REASONS.interrupted, job.id).changes !== 1) return;
      const serverId = db.prepare('SELECT server_id FROM sites WHERE id=?').get(job.site_id)?.server_id ?? '';
      if (CONTAINER.test(details.container ?? '')) record({ siteId: job.site_id, serverId, container: details.container, containerId: CONTAINER_ID.test(details.containerId ?? '') ? details.containerId : null, kind: 'restart_failed', reason: 'interrupted', jobId: job.id });
    });
  }
}
// Rows older than 90 days, deleted by the worker's existing maintenance step (the trigger refuses anything newer).
export function purgeSelfHealEvents(nowMs = healClock.now()) {
  return db.prepare('DELETE FROM self_heal_events WHERE at<?').run(iso(nowMs - KEEP_DAYS * 86_400_000 - 60_000)).changes;
}
