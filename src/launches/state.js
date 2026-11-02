// Launch step machine rules (docs/launch-site.md, "Worker and helper" and "Failure and rollback paths"). Pure: no
// database, SSH or clock. The engine (engine.js) persists what these decide in site_launches/site_launch_steps.
export const STEP_ORDER = Object.freeze(['check', 'fetch', 'build', 'start', 'check_health', 'web', 'certificate', 'save', 'first_backup']);
// Steps that run on the server as one short launch job each; save and first_backup run inside the tick.
export const SERVER_STEPS = Object.freeze(['check', 'fetch', 'build', 'start', 'check_health', 'web', 'certificate', 'teardown']);
// A failure here before the site is saved tears everything down. A certificate failure never does: the site stays on HTTP.
export const FATAL_STEPS = Object.freeze(['check', 'fetch', 'build', 'start', 'check_health', 'web', 'save']);
export const LABELS = Object.freeze({ check: 'Check the server', fetch: 'Get the site', build: 'Build', start: 'Start', check_health: 'Check it works', web: 'nginx', certificate: 'Certificate', save: 'Save the site', first_backup: 'First backup', teardown: 'Remove what the launch made' });
// Seconds a helper call may take before DockNest stops waiting (the step fails and, before save, everything is torn down).
export const STEP_LIMITS = Object.freeze({ check: 180, fetch: 660, build: 1800, start: 600, check_health: 120, web: 180, certificate: 300, teardown: 1800 });
export const HEALTH = Object.freeze({ pollSeconds: 10, limitSeconds: 600 });
export const REMOVE_WINDOW_MS = 24 * 3600_000;
export const RATE = Object.freeze({ perServer: 3, windowMs: 3600_000 });
export const ACTIVE_STATES = Object.freeze(['queued', 'running', 'needs_attention']);
export const OPEN_STATES = Object.freeze(['queued', 'running', 'waiting_dns', 'done', 'needs_attention']);

const byName = steps => Object.fromEntries(steps.map(step => [step.step, step]));
export const busyStep = steps => steps.find(step => step.state === 'launch_queued' || step.state === 'launch_running') ?? null;
export const saved = steps => byName(steps).save?.state === 'done';

// What the tick should do next for one launch. Returns { type, ... }:
// none | cancel | queue(step) | wait | save | first_backup(poll) | teardown | abort | finish(state) | recover(step) | fail(step)
export function nextAction(launch, steps, nowMs) {
  const map = byName(steps);
  if (busyStep(steps)) return { type: 'none' };
  const teardown = map.teardown;
  if (launch.state === 'queued') return launch.cancel_requested ? { type: 'cancel' } : { type: 'none' };
  if (teardown?.state === 'done') return { type: 'finish', to: launch.options?.removing ? 'removed' : launch.cancel_requested && !launch.failed_step ? 'cancelled' : 'failed' };
  if (teardown?.state === 'failed') return launch.state === 'needs_attention' ? { type: 'none' } : { type: 'finish', to: 'needs_attention' };
  if (launch.state === 'needs_attention') return { type: 'none' }; // the owner presses Try again
  if (launch.state !== 'running') return { type: 'none' };
  // A step a stopped worker left behind: ask the server once (launch-status) before deciding.
  const interrupted = STEP_ORDER.find(name => map[name]?.state === 'failed' && map[name].result?.interrupted && !map[name].result?.recovered);
  if (interrupted) return { type: 'recover', step: interrupted };
  const failed = FATAL_STEPS.find(name => map[name]?.state === 'failed');
  // Nothing was created before the fetch began (check is read-only), so a failed check ends the launch at once.
  if (failed && !saved(steps)) return failed === 'check' && !(map.fetch?.attempt > 0) ? { type: 'abort', step: failed } : { type: 'teardown', step: failed };
  if (launch.cancel_requested && !saved(steps) && ['pending', 'skipped'].includes(map.start?.state)) return map.fetch?.attempt > 0 ? { type: 'teardown', step: null } : { type: 'cancel' };
  for (const name of STEP_ORDER) {
    const step = map[name];
    if (!step || ['done', 'skipped'].includes(step.state)) continue;
    if (name === 'certificate' && ['waiting', 'failed'].includes(step.state)) continue; // never blocks the launch
    if (name === 'first_backup' && step.state === 'failed') continue;
    if (name === 'check_health' && step.state === 'waiting') {
      if (Date.parse(step.result?.deadline ?? '') <= nowMs) return { type: 'fail', step: name, reason: `The site did not answer within ${Math.round(HEALTH.limitSeconds / 60)} minutes.` };
      return step.next_at && Date.parse(step.next_at) > nowMs ? { type: 'wait' } : { type: 'queue', step: name };
    }
    if (name === 'save') return { type: 'save' };
    if (name === 'first_backup') return step.state === 'waiting' ? { type: 'first_backup', poll: true } : { type: 'first_backup', poll: false };
    if (step.state === 'pending') return { type: 'queue', step: name };
    return { type: 'none' };
  }
  return { type: 'finish', to: map.certificate?.state === 'waiting' ? 'waiting_dns' : 'done' };
}

// "Cancel" is offered until the start step begins.
export const cancelable = (launch, steps) => launch.state === 'queued' || (launch.state === 'running' && !launch.cancel_requested && ['pending', 'launch_queued'].includes(byName(steps).start?.state) && !saved(steps));

// Plain sentence for the API and the journal: at most 300 characters, never URLs with credentials, keys or tokens.
const SECRETISH = /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}[\s\S]*?(-{5}END [A-Z ]*PRIVATE KEY-{5}|$)|[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@\S*|\bbearer\s+\S+|(?:password|passwd|secret|token)\s*[=:]\s*\S+/gi;
export function plainReason(text, fallback = 'The step did not finish.') {
  const value = String(text ?? '').replace(SECRETISH, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (value || fallback).slice(0, 300);
}
