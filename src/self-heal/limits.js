// Self-heal limits and the reason catalogue (docs/self-heal.md, "Decisions at a glance"). The CHECK constraints of
// migration 15 back up LIMITS. Reasons are stored as codes and shown as fixed sentences: never stderr, paths or
// event content.
export const LIMITS = Object.freeze({
  maxRestarts: Object.freeze({ min: 1, max: 10, default: 3 }),
  windowMinutes: Object.freeze({ min: 10, max: 1440, default: 60 }),
});
export const MIN_GAP_MS = 60_000;          // at least 60 s between two restarts of one container
export const THROTTLE_MS = 10_000;         // at most one event acted on per container per 10 s
export const SETTLE_MS = 120_000;          // no restart within 2 minutes after DockNest work on the site ended
export const WATCH_PER_SERVER = 50;        // containers one server's stream watches (the helper accepts up to 60)
export const KEEP_DAYS = 90;               // history kept; the worker's maintenance step deletes older rows
// The live values. Only the Linux integration run shortens them (the same properties, less CI time).
export const timing = { minGapMs: MIN_GAP_MS, throttleMs: THROTTLE_MS, settleMs: SETTLE_MS };
export const STREAM = Object.freeze({ keepaliveMs: 15_000, keepaliveMisses: 3, backoffStartMs: 5_000, backoffMaxMs: 300_000, steadyMs: 60_000, lineBytes: 4096, bufferBytes: 65_536 });
export const CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export const CONTAINER_ID = /^[a-f0-9]{64}$/;
export const STATUSES = Object.freeze(['healthy', 'unhealthy', 'starting']);

// Reconnect delay after the n-th failed attempt (0-based): 5 s doubling to 5 minutes, with +-20 % jitter so servers
// that dropped together do not reconnect together. Driven by the close event, never by a timer that reads state.
export function backoffMs(attempt, random = Math.random) {
  const base = Math.min(STREAM.backoffMaxMs, STREAM.backoffStartMs * 2 ** Math.max(0, Math.min(attempt, 16)));
  return Math.min(STREAM.backoffMaxMs, Math.max(1000, Math.round(base * (0.8 + 0.4 * random()))));
}

// Reasons a restart waits. While one of these holds, the unhealthy event stays open and the restart happens once it
// clears, if the container is still unhealthy then (the helper re-checks).
// The server-side refusals (`locked`, `maintenance_flag`) are not in this set: re-asking the server every tick would
// only repeat them; the next health event or reconnect snapshot opens a new episode.
export const TRANSIENT = new Set(['site_busy', 'work_queued', 'moving', 'maintenance', 'settling', 'deployment_hold']);
// Attempts that did not restart (the server could not be reached, the site lock or maintenance marker on the server).
// They are tried again once the 60 s gap after them has passed, and count toward the restart limit like a restart, so
// an unreachable server is asked at most N times per window. A failed `docker restart` is retried the same way.
export const RETRYABLE = new Set(['unreachable', 'locked', 'maintenance_flag', 'cleanup']);
export const REASONS = Object.freeze({
  site_busy: 'DockNest was working on this site.',
  work_queued: 'A backup or change for this site was waiting, so the restart stepped aside.',
  moving: 'The site is being moved.',
  maintenance: 'The site was in maintenance.',
  settling: 'DockNest work on this site had just finished; containers get 2 minutes to start.',
  deployment_hold: 'DockNest was being updated.',
  locked: 'Another DockNest step held the site lock on the server.',
  maintenance_flag: 'The site was in maintenance on the server.',
  cleanup: 'A server cleanup was running.',
  not_unhealthy: 'The container was no longer unhealthy.',
  not_running: 'The container was not running.',
  labels: 'The container is no longer the one this site watches.',
  recreated: 'Container recreated.',
  missing: 'The container was not found on the server.',
  disabled: 'Self-heal was turned off.',
  removed: 'The site was removed.',
  unreachable: 'The server could not be reached.',
  unavailable: 'Self-heal is not available in this worker.',
  interrupted: 'DockNest stopped during the restart.',
  limit: 'Restart limit reached for this window.',
  timeout: 'The restart did not finish in 2 minutes.',
  exit_1: 'Docker could not restart the container.',
  exit_125: 'Docker refused the restart command.',
  exit_126: 'Docker could not run the restart command.',
  exit_127: 'Docker was not found on the server.',
  exit_137: 'The restart was stopped before it finished.',
  exit_other: 'Docker could not restart the container.',
});
export const reasonText = code => (code && Object.hasOwn(REASONS, code) ? REASONS[code] : null);
// "Not watching: {reason}" on the settings card.
export const NOT_WATCHING = Object.freeze({
  recreated: 'container recreated',
  host_key: 'the server SSH host key does not match the pinned key',
  unreachable: 'the server cannot be reached; DockNest keeps trying',
  docker_events: 'Docker events could not be read on the server',
  stream_ended: 'the event stream ended; DockNest reconnects',
  worker_offline: 'the DockNest worker is not running',
  no_healthcheck: 'no container in this site has a health check',
  static: 'static websites have no containers',
  too_many: 'this server already has 50 watched containers',
});
