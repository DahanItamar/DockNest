// Starting restore tests: "Run test now" and the schedule (docs/restore-tests.md, "Which backup and when").
// - The schedule runs inside the worker's existing tick (no loop or timer of its own) and reads one indexed query:
//   enabled sites whose next_due_at has come. A site that is busy (a backup, restore or move, or a test that has not
//   finished) waits for a later tick; backups go first because tickScheduler queues a due backup before this runs.
// - Once a test is queued or skipped, next_due_at moves on one cadence step at a time until it is in the future, so an
//   outage never causes a burst of catch-up tests.
// - Manual runs: administrators and operators, one unfinished test per site and at most 6 per site per 24 hours.
import { db, audit } from '../db.js';
import { deploymentHeld } from '../deployment-hold.js';
import { movingSite } from '../engine.js';
import { createRestoreTest, advanceRestoreTest, latestTestableBackup, needsExternalStorage, testTransport } from './engine.js';
import { settingsRow, followingDueAt } from './settings.js';

export const MANUAL_TESTS_PER_DAY = 6;
export const TOO_MANY_MESSAGE = `You can run ${MANUAL_TESTS_PER_DAY} tests a day for each site.`;
const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });
const iso = ms => new Date(ms).toISOString();
// Work on the site itself, other than restore tests: queued or running jobs, unresolved recovery, or a move.
export const siteBusy = siteId => !!db.prepare("SELECT 1 FROM jobs WHERE site_id=? AND type NOT IN ('restore-test','site-move') AND status IN ('queued','running','recovery_required')").get(siteId) || !!movingSite(siteId);
export const unfinishedTest = siteId => db.prepare("SELECT id,result,cleanup FROM restore_tests WHERE site_id=? AND (result IS NULL OR cleanup IN ('pending','failed'))").get(siteId) ?? null;

// The internal web check needs a container and a port. When the owner gave only a path, the first container that ran at
// capture and exposes a TCP port is used, preferring the common web ports. Without one, no web check runs.
const WEB_PORTS = [80, 8080, 8000, 3000, 5000, 443, 8443, 8081, 2368];
export function resolveProbe(probe, manifest) {
  if (!probe || manifest?.kind === 'static') return null;
  const containers = (Array.isArray(manifest?.containers) ? manifest.containers : []).filter(item => item && typeof item === 'object');
  const nameOf = item => String(item.Name ?? item.name ?? '').replace(/^\//, '');
  const portsOf = item => Object.keys(item.Config?.ExposedPorts ?? {}).map(key => /^(\d+)\/tcp$/.exec(key)).filter(Boolean).map(match => Number(match[1])).filter(port => port >= 1 && port <= 65535);
  const rank = port => { const index = WEB_PORTS.indexOf(port); return index === -1 ? WEB_PORTS.length + port : index; };
  let service = probe.service ?? null, port = probe.port ?? null;
  if (service && !containers.some(item => nameOf(item) === service)) return { service, port: port ?? 80, path: probe.path || '/' }; // the helper reports it as skipped
  const candidates = (service ? containers.filter(item => nameOf(item) === service) : [...containers.filter(item => item.State?.Running !== false), ...containers.filter(item => item.State?.Running === false)]);
  if (!port) {
    const best = candidates.flatMap((item, order) => portsOf(item).map(value => ({ item, value, order }))).sort((a, b) => rank(a.value) - rank(b.value) || a.order - b.order)[0];
    if (best) { service ??= nameOf(best.item); port = best.value; }
  }
  if (!service) service = candidates.map(nameOf).find(Boolean) ?? null;
  return service && port ? { service, port, path: probe.path || '/' } : null;
}

// Settings and backup checks shared by both triggers. Throws an httpError with the contract's code.
function prepare(site, settings, backupId) {
  if (!settings?.server_id) throw httpError(409, 'NO_TEST_SERVER', 'Choose a test server first.');
  if (!db.prepare('SELECT 1 FROM servers WHERE id=?').get(settings.server_id)) throw httpError(409, 'NO_TEST_SERVER', 'The chosen test server was removed. Choose another one.');
  const backup = backupId ? db.prepare('SELECT * FROM backups WHERE id=? AND site_id=? AND verified=1').get(backupId, site.id) : latestTestableBackup(site.id);
  if (!backup || db.prepare('SELECT 1 FROM retention_operations WHERE backup_id=?').get(backup.id)) throw httpError(409, 'NO_VERIFIED_BACKUP', 'Not tested: no verified backup yet.');
  let manifest; try { manifest = JSON.parse(backup.manifest || '{}'); } catch { manifest = {}; }
  if (needsExternalStorage(manifest)) throw httpError(409, 'EXTERNAL_STORAGE', 'This site needs external storage that a restore test cannot attach.');
  let probe = null; try { probe = settings.probe ? JSON.parse(settings.probe) : null; } catch { probe = null; }
  return {
    siteId: site.id, serverId: settings.server_id, backupId: backup.id,
    limits: { timeLimitMinutes: settings.time_limit_minutes, memoryMb: settings.memory_mb, cpus: settings.cpus },
    internet: settings.allow_internet === 1, liveServer: settings.allow_live_server === 1, probe: resolveProbe(probe, manifest),
  };
}

// POST /api/sites/:id/restore-tests. Returns { id, jobId }; jobId is null while the test waits for its server.
export function runTestNow(site, { backupId = null, actor }) {
  if (db.prepare('SELECT 1 FROM site_archives WHERE site_id=?').get(site.id)) throw httpError(409, 'SITE_ARCHIVED', 'This site was removed from active sites.');
  const settings = settingsRow(site.id);
  if (!settings?.server_id) throw httpError(409, 'NO_TEST_SERVER', 'Choose a test server first.');
  if (settings.server_id === site.server_id && settings.allow_live_server !== 1) throw httpError(409, 'LIVE_SERVER_NOT_ALLOWED', 'Testing on the live server needs the live-server opt-in.');
  const open = unfinishedTest(site.id);
  if (open) throw httpError(409, 'TEST_ACTIVE', open.cleanup === 'failed' ? 'The last test of this site could not clean up. Resolve it in Jobs first.' : 'This site already has a restore test that has not finished.');
  if (siteBusy(site.id)) throw httpError(409, 'SITE_BUSY', 'This site is busy with a backup, restore or move. Try again when it finishes.');
  const since = iso(testTransport.now() - 86_400_000);
  if (db.prepare("SELECT COUNT(*) AS n FROM restore_tests WHERE site_id=? AND trigger='manual' AND created_at>?").get(site.id, since).n >= MANUAL_TESTS_PER_DAY) throw httpError(429, 'TOO_MANY_TESTS', TOO_MANY_MESSAGE);
  const { id: testId } = createRestoreTest({ ...prepare(site, settings, backupId), trigger: 'manual', actor });
  return { id: testId, jobId: advanceRestoreTest(testId) };
}

const SKIPS = { NO_TEST_SERVER: 'no_test_server', LIVE_SERVER_NOT_ALLOWED: 'live_server_not_allowed', NO_VERIFIED_BACKUP: 'no_verified_backup', EXTERNAL_STORAGE: 'external_storage', SITE_ARCHIVED: 'site_archived', INVALID: 'invalid' };
// Runs in the worker tick, before tickRestoreTests. Event-driven: one indexed query, nothing when nothing is due.
export function tickRestoreTestSchedule() {
  const nowMs = testTransport.now();
  const due = db.prepare("SELECT r.*,s.server_id AS live_server_id FROM restore_test_settings r JOIN sites s ON s.id=r.site_id WHERE r.enabled=1 AND r.next_due_at IS NOT NULL AND r.next_due_at<=? AND r.site_id NOT IN (SELECT site_id FROM site_archives) ORDER BY r.next_due_at,r.site_id").all(iso(nowMs));
  if (!due.length || deploymentHeld(db)) return 0;
  let queued = 0;
  for (const settings of due) {
    try {
      // Waits without moving the due time: the test runs on a later tick, once.
      // Waiting keeps the due time; a stuck clean-up or recovery shows why on the card.
      const open = unfinishedTest(settings.site_id), recovery = db.prepare("SELECT 1 FROM jobs WHERE site_id=? AND type NOT IN ('restore-test','site-move') AND status='recovery_required'").get(settings.site_id);
      const waiting = open?.cleanup === 'failed' ? 'Waiting for the clean-up to be fixed.' : recovery ? 'Waiting for the backup to be recovered.' : null;
      if (open || siteBusy(settings.site_id)) {
        if ((settings.skip_reason ?? null) !== waiting && (waiting || /^Waiting for /.test(settings.skip_reason ?? ''))) db.prepare('UPDATE restore_test_settings SET skip_reason=? WHERE site_id=?').run(waiting, settings.site_id);
        continue;
      }
      const site = db.prepare('SELECT * FROM sites WHERE id=?').get(settings.site_id);
      const next = followingDueAt(settings.next_due_at, settings.cadence, nowMs);
      let reason = null, code = null, testId = null;
      try {
        if (settings.server_id && settings.server_id === site.server_id && settings.allow_live_server !== 1) throw httpError(409, 'LIVE_SERVER_NOT_ALLOWED', 'Testing on the live server needs the live-server opt-in.');
        testId = createRestoreTest({ ...prepare(site, settings, null), trigger: 'schedule', actor: 'scheduler' }).id;
      } catch (error) {
        if (!error.status) throw error;
        code = SKIPS[error.code] ?? 'other'; reason = String(error.message).slice(0, 300);
      }
      db.prepare('UPDATE restore_test_settings SET next_due_at=?,skip_reason=? WHERE site_id=? AND enabled=1').run(next, reason, settings.site_id);
      if (testId) { queued++; advanceRestoreTest(testId); }
      else audit('scheduler', 'restore_test.skipped', settings.site_id, { reason: code });
    } catch (error) {
      console.error(`Restore test schedule for site ${settings.site_id} skipped: ${error.code ?? error.name}`);
    }
  }
  return queued;
}
