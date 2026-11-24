// Measured recovery time per app (docs/recovery-time-adr.md). Pure: computed on read from the step rows of the newest
// passed restore test, so there is nothing to migrate and every upgraded install gets a number on day one.
// Recovery time = copy_backup + restore_copy + start_containers + check_health. check_space and clean_up are left out.
const DAY_MS = 86_400_000;
export const CADENCE_DAYS = Object.freeze({ daily: 1, weekly: 7, monthly: 30 });
export const STALE_MAX_DAYS = 35;
export const GROWTH_LIMIT = 1.5; // the newest backup is "more than 50% larger"

// Seconds a step took. Missing or unfinished steps count 0; a finish before the start (clock skew) is 0, never negative.
function stepSeconds(steps, name) {
  const row = steps.find(step => step?.step === name);
  if (!row || row.state === 'skipped' || !row.started_at || !row.finished_at) return 0;
  const seconds = (Date.parse(row.finished_at) - Date.parse(row.started_at)) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

// steps: restore_test_steps rows of the test; test: { result, finished_at }; latestBackup / testedBackup: { size } or null
// (sizes only decide "may be low"); cadence: 'daily' | 'weekly' | 'monthly' | null; now: ms.
export function recoveryTime(steps, test, latestBackup = null, cadence = null, now = Date.now(), testedBackup = null) {
  if (!test || test.result !== 'passed' || !Array.isArray(steps)) return null;
  const finished = Date.parse(test.finished_at);
  if (!Number.isFinite(finished)) return null;
  const copy = stepSeconds(steps, 'copy_backup'), restore = stepSeconds(steps, 'restore_copy');
  const start = stepSeconds(steps, 'start_containers') + stepSeconds(steps, 'check_health');
  const seconds = copy + restore + start;
  if (!(seconds > 0)) return null;
  const limit = Math.min(STALE_MAX_DAYS, CADENCE_DAYS[cadence] ? CADENCE_DAYS[cadence] * 2 : STALE_MAX_DAYS) * DAY_MS;
  const stale = now - finished > limit;
  const tested = Number(testedBackup?.size), latest = Number(latestBackup?.size);
  const mayBeLow = tested > 0 && latest > tested * GROWTH_LIMIT;
  return { seconds, phases: { copy, restore, start }, provenAt: test.finished_at, stale, mayBeLow };
}

// "under 2 min", whole minutes rounded up, hours with one decimal above 90 minutes. The caller adds "about".
export function formatRecoveryTime(seconds) {
  if (!(seconds > 0)) return null;
  if (seconds < 120) return 'under 2 min';
  const minutes = Math.ceil(seconds / 60);
  return minutes > 90 ? `${(Math.round(minutes / 6) / 10).toFixed(1)} h` : `${minutes} min`;
}
