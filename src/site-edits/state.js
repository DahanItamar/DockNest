// Safe Edit vocabulary (docs/safe-edit.md): steps, states, phases and the fixed reasons. Pure: no database, SSH or clock.
// Helper answers are mapped to these fixed sentences by code; the helper's own text, Docker's stderr, values and resolved
// paths never reach the API, SQLite, audit rows or alerts.

export const STEPS = Object.freeze(['backup', 'prepare', 'apply', 'check_health', 'roll_back', 'finish']);
export const LABELS = Object.freeze({ backup: 'Backup', prepare: 'Prepare', apply: 'Apply', check_health: 'Check health', roll_back: 'Roll back', finish: 'Finish' });
export const STATES = Object.freeze(['queued', 'running', 'checking', 'rolling_back', 'done', 'needs_attention', 'cancelled']);
export const RESULTS = Object.freeze(['applied', 'rolled_back', 'failed', 'cancelled']);
export const TABS = Object.freeze(['compose', 'env', 'ports', 'image']);

// The engine's position (site_edits.progress.phase). Each phase belongs to one step of the timeline.
// rollback_health is part of roll_back (the data comes back inside edit-rollback); recover runs edit-status after an interrupted
// or unreachable step; attention waits for the owner (needs_attention).
export const PHASE_STEP = Object.freeze({ backup: 'backup', prepare: 'prepare', apply: 'apply', check_health: 'check_health', roll_back: 'roll_back', rollback_health: 'roll_back', finish: 'finish' });
// Phases that run as a `site-edit` job on the site's server.
export const JOB_PHASES = Object.freeze(['prepare', 'apply', 'check_health', 'roll_back', 'rollback_health', 'finish', 'recover']);
// Phases that wait between polls: their job rests in edit_waiting.
export const POLL_PHASES = Object.freeze(['check_health', 'rollback_health']);

// The row's state for a phase (the outcome decides it for finish).
export function stateFor(phase, outcome = null, started = true) {
  if (phase === 'attention') return 'needs_attention';
  if (phase === 'backup') return started ? 'running' : 'queued';
  if (phase === 'check_health') return 'checking';
  if (['roll_back', 'rollback_health'].includes(phase)) return 'rolling_back';
  if (phase === 'finish') return outcome === 'rolled_back' ? 'rolling_back' : outcome === 'applied' ? 'checking' : 'running';
  return 'running';
}

// Cancel is accepted only before `apply` starts; afterwards rollback is the undo.
export const cancellable = edit => edit.result === null && !edit.progress?.applyStarted && ['backup', 'prepare'].includes(edit.progress?.phase ?? 'backup');

export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const ENV_REFUSED_PREFIX = /^(COMPOSE_|DOCKER_|BUILDKIT_)/i;
export const LIMITS = Object.freeze({ fileBytes: 256 * 1024, files: 10, envKeys: 200, valueBytes: 8 * 1024, editsPerHour: 10, tokenMs: 15 * 60_000, timeLimit: { min: 60, max: 600, default: 120 } });

// Review refusals (422) and step failures. `field` from the helper passes only when it is a plain field path.
export const REASONS = Object.freeze({
  PRIVILEGE_ADDED: 'This change adds a privilege the site did not have. Change it by hand.',
  PATH_REFUSED: 'This change uses a folder outside the site or a protected path.',
  FILE_CHANGED: 'This file changed on the server. Reload it.',
  COMPOSE_INVALID: 'Docker Compose cannot read this change. Check the file and try again.',
  SERVICE_REMOVED: 'Removing a service is not supported. Remove it by hand.',
  PORT_IN_USE: 'This port is already in use on the server.',
  SERVICE_FROZEN: 'This service has host access. Change it by hand.',
  ENV_REFUSED: 'This environment key or value is not allowed.',
  COMPOSE_TOO_OLD: 'Update Docker Compose to 2.24 or newer.',
  FILE_TOO_LARGE: 'This file is larger than 256 KB.',
  PULL_FAILED: 'The new image could not be pulled. Nothing was changed.',
  DISK_FULL: 'The server does not have enough free disk space. Nothing was changed.',
  ROLLBACK_FAILED: 'The previous version could not be put back.',
  NOT_EDITABLE: 'This site cannot be edited here.',
  // Codes the helper (remote/helper/edit.py) adds to the contract list.
  UNKNOWN_SETTING: 'This change uses a Compose setting DockNest cannot check. Change it by hand.',
  SYMLINK_REFUSED: 'A folder this change mounts goes through a symbolic link.',
  NO_ENV_FILE: 'This site has no environment file.',
  NOT_COMPOSE: 'This site is a single container, so it has no Compose file.',
  UNSUPPORTED_CONTAINER: 'This container uses settings DockNest cannot recreate. Change it by hand.',
  SITE_BUSY: 'Another DockNest task is working on this site. Try again in a minute.',
  INVALID_REQUEST: 'The server did not accept this change.',
  NO_JOURNAL: 'This change was not prepared on the server.',
  MAINTENANCE_FAILED: 'The maintenance page could not be switched.',
  APPLY_FAILED: 'Docker could not start the changed site.',
  FAILED: 'Safe Edit could not run on the server.',
  DATA_NOT_LOCAL: 'This site keeps data on a volume DockNest cannot copy, so an image change cannot be undone safely. Change the image by hand.',
  OWN_SITE: 'This is DockNest itself. Update it with the DockNest upgrade, not Safe Edit.',
});
export const REVIEW_CODES = Object.freeze(['PRIVILEGE_ADDED', 'PATH_REFUSED', 'FILE_CHANGED', 'COMPOSE_INVALID', 'SERVICE_REMOVED', 'PORT_IN_USE', 'SERVICE_FROZEN', 'ENV_REFUSED', 'COMPOSE_TOO_OLD', 'FILE_TOO_LARGE', 'UNKNOWN_SETTING', 'SYMLINK_REFUSED', 'NO_ENV_FILE', 'NOT_COMPOSE', 'UNSUPPORTED_CONTAINER', 'INVALID_REQUEST', 'DATA_NOT_LOCAL', 'OWN_SITE']);
export const FIELD = /^[A-Za-z0-9_.\-[\]]{1,200}$/;
export const reasonFor = (code, fallback = 'The change could not be checked. Try again.') => (Object.hasOwn(REASONS, code) ? REASONS[code] : fallback);
export const helperCode = value => (typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(value) ? (value === 'FILE_CHANGED_APPLY' ? 'FILE_CHANGED' : value) : null);

// Step and outcome sentences (one plain line, <= 300 characters, never a value or path).
export const SAY = Object.freeze({
  backupFailed: 'The backup before the change did not finish. Nothing was changed.',
  filesChangedDuringBackup: 'The files changed during the backup.',
  unreachable: 'The server could not be reached.',
  unreachableNothing: 'The server could not be reached. Nothing was changed.',
  applyFailed: 'The change could not be applied.',
  restartedNothing: 'DockNest restarted before the change was written. Nothing was changed.',
  restartedUndone: 'DockNest restarted during the change, so it was undone.',
  unreachableUndone: 'The server could not be reached during the change, so it was undone.',
  unhealthy: seconds => `The site did not become healthy in ${seconds % 60 === 0 ? `${seconds / 60} minute${seconds === 60 ? '' : 's'}` : `${seconds} seconds`}.`,
  previousUnhealthy: 'The previous version did not become healthy either. The site stays behind the maintenance page.',
  rollbackFailed: 'The previous version could not be put back. The site stays behind the maintenance page.',
  dataCopySpace: 'Not enough free disk space for the safety copy. Nothing was changed.',
  dataCopyKept: 'A safety copy of the data is kept on the server.',
  finishFailed: 'The maintenance page could not be turned off.',
  cancelled: 'The change was cancelled before anything was written.',
  restoredBackup: 'The backup from before the change was restored through the normal restore. Check the site, then turn off its maintenance page.',
  siteGone: 'This site was removed from active sites.',
});

// The `changes` column: tabs used, changed field paths, env key names and file hashes. Never a value. Trimmed to fit the
// 4096-character limit (field paths first, then file hashes) with `truncated: true`.
export function changesRecord({ tabs, changed = [], envChanged = {}, hashes = [], imageChanged = false }) {
  const record = { tabs: [...new Set(tabs)].filter(tab => TABS.includes(tab)), changed: changed.filter(path => FIELD.test(path)).slice(0, 200), env: { added: [...(envChanged.added ?? [])], replaced: [...(envChanged.replaced ?? [])], removed: [...(envChanged.removed ?? [])] }, files: hashes.map(({ path, before, after }) => ({ path: String(path).slice(0, 512), before, after })), imageChanged: !!imageChanged };
  for (const key of ['added', 'replaced', 'removed']) record.env[key] = record.env[key].filter(name => ENV_KEY.test(name)).slice(0, 200);
  while (JSON.stringify(record).length > 4096 && record.changed.length) { record.changed.pop(); record.truncated = true; }
  while (JSON.stringify(record).length > 4096 && record.files.length) { record.files.pop(); record.truncated = true; }
  for (const key of ['added', 'replaced', 'removed']) while (JSON.stringify(record).length > 4096 && record.env[key].length) { record.env[key].pop(); record.truncated = true; }
  return record;
}

// Which tabs a review used, from the request and the helper's changed field paths.
export function tabsUsed({ files = [], env = [], changed = [] }) {
  const tabs = new Set();
  if (files.length) tabs.add('compose');
  if (env.length) tabs.add('env');
  if (changed.some(path => /\.image$/.test(path))) tabs.add('image');
  if (changed.some(path => /\.ports(\.|\[|$)/.test(path))) tabs.add('ports');
  return [...tabs];
}
