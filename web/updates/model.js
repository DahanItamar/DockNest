// Pure helpers for the Update Center and the lock view (docs/update-center.md sections 6 and 7). No React, no network.
export const STAGES = [
  { id: 'verify', name: 'Verify', phases: ['verify'] },
  { id: 'prepare', name: 'Prepare', phases: ['preflight', 'fetch'] },
  { id: 'protect', name: 'Protect', phases: ['idle', 'backup'] },
  { id: 'install', name: 'Install', phases: ['checkout', 'build', 'stop', 'restore-snapshot', 'start'] },
  { id: 'confirm', name: 'Confirm', phases: ['health', 'rollback', 'release', 'cleanup'] },
];
// restore-snapshot only occurs in CLI rollbacks; it is mapped to Install but never listed.
export const PHASES = ['verify', 'preflight', 'fetch', 'idle', 'backup', 'checkout', 'build', 'stop', 'start', 'health', 'rollback', 'release', 'cleanup'];
export const stageOf = phase => STAGES.findIndex(s => s.phases.includes(phase));
export const FINAL_STATES = ['succeeded', 'rolled_back', 'not_changed', 'lost'];
// The lock view renders while the request runs, and stays through needs_action until the host confirms.
export const isLocking = p => !!p && (p.state === 'running' || p.state === 'needs_action' || (p.active === true && ![...FINAL_STATES, 'resolved'].includes(p.state)));
export const retryDelay = failures => [2000, 4000, 8000][failures] ?? 10000;
const pad = n => String(n).padStart(2, '0');
export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(s % 60);
}
export const STATUS_LABEL = { complete: 'Done', current: 'In progress', waiting: 'Waiting', failed: 'Stopped', 'rolled-back': 'Rolled back' };
// Stage status for the 5-stage track. lastPhase is the last forward phase this browser saw (or the reported phase).
export function trackFor({ phase, state, lastPhase }) {
  const forwardPhase = lastPhase && lastPhase !== 'rollback' && stageOf(lastPhase) >= 0 ? lastPhase : phase !== 'rollback' ? phase : null;
  const forward = forwardPhase ? stageOf(forwardPhase) : -1, current = Math.max(stageOf(phase), 0);
  return STAGES.map((stage, i) => {
    let status = 'waiting';
    if (state === 'succeeded') status = 'complete';
    else if (state === 'running' && phase !== 'rollback') status = i < current ? 'complete' : i === current ? 'current' : 'waiting';
    else if (state === 'running') { const f = forward < 0 ? 3 : forward; status = i < f ? 'complete' : i === 4 ? 'current' : i === f ? 'failed' : 'waiting'; }
    else if (state === 'rolled_back') { const f = forward < 0 ? 3 : forward; status = i < f ? 'complete' : i === 4 ? 'rolled-back' : i === f ? 'failed' : 'waiting'; }
    else if (state === 'not_changed') { const f = forward < 0 ? 0 : forward; status = i < f ? 'complete' : i === f ? 'failed' : 'waiting'; }
    else if (state === 'needs_action') { const f = forward < 0 ? current : forward; status = i < f ? 'complete' : i === f ? 'failed' : 'waiting'; }
    return { id: stage.id, name: stage.name, status };
  });
}
// Status of each of the 13 listed phases for "Show details" (names only, no output).
export function phaseStatuses({ phase, state, lastPhase }) {
  const forwardPhase = lastPhase && PHASES.includes(lastPhase) && lastPhase !== 'rollback' ? lastPhase : phase !== 'rollback' ? phase : null;
  const f = forwardPhase ? PHASES.indexOf(forwardPhase) : -1, out = {};
  PHASES.forEach((name, i) => {
    let status = 'pending';
    if (state === 'succeeded') status = name === 'rollback' ? 'skipped' : 'complete';
    else if (state === 'running' && phase !== 'rollback') { const c = PHASES.indexOf(phase); status = name === 'rollback' ? 'pending' : i < c ? 'complete' : i === c ? 'current' : 'pending'; }
    else {
      const at = f < 0 ? (state === 'not_changed' ? 0 : 7) : f;
      if (name === 'rollback') status = state === 'running' ? 'current' : state === 'rolled_back' ? 'complete' : 'skipped';
      else if (name === 'release') status = state === 'rolled_back' ? 'complete' : state === 'running' ? 'pending' : 'skipped';
      else if (i < at) status = 'complete';
      else if (i === at) status = 'failed';
      else status = state === 'not_changed' ? 'pending' : state === 'running' ? 'pending' : 'skipped';
    }
    out[name] = status;
  });
  return out;
}
export const PHASE_LABEL = {
  verify: () => 'Verifying the release signature', preflight: () => 'Checking this installation', fetch: to => 'Downloading ' + to,
  idle: () => 'Waiting for running jobs to finish', backup: () => 'Backing up DockNest’s own data', checkout: to => 'Switching to ' + to,
  build: () => 'Building the new version', stop: () => 'Stopping DockNest', start: () => 'Starting DockNest', health: () => 'Checking health',
  rollback: (to, from) => 'Restoring ' + from, release: () => 'Resuming backups and restores', cleanup: () => 'Removing old update files',
};
// What the admin reads for the current stage (docs/update-center.md section 7 table).
export function liveFor({ phase, to, from }) {
  if (phase === 'rollback') return ['Rolling back to ' + from, 'DockNest is going back to the previous version. This page keeps checking.'];
  const i = Math.max(stageOf(phase), 0);
  return [
    ['Verifying ' + to, 'Checking that this is an official, signed release.'],
    ['Preparing ' + to, 'Checking this installation and downloading the release.'],
    ['Protecting your data', 'Pausing backups, letting running jobs finish and saving DockNest’s own data.'],
    ['Installing ' + to, 'Replacing the running containers. DockNest is briefly offline.'],
    ['Confirming ' + to, 'Checking that ' + to + ' is healthy and resuming paused work.'],
  ][i];
}
export const vv = v => typeof v === 'string' && v ? (v.startsWith('v') ? v : 'v' + v) : '';
export const safeVersion = v => typeof v === 'string' && /^v\d+\.\d+\.\d+$/.test(v) ? v : null;
export const tagUrl = v => safeVersion(v) ? 'https://github.com/DahanItamar/DockNest/releases/tag/' + v : null;
// Highlight chips from the (display-only) typed highlights block.
export function highlightChips(h) {
  if (!h || typeof h !== 'object') return [];
  const count = v => Number.isInteger(v) && v > 0 && v < 1000 ? v : 0, chips = [];
  if (h.security === true) chips.push({ id: 'security', label: 'Security fixes' });
  if (count(h.features)) chips.push({ id: 'features', label: count(h.features) + (count(h.features) === 1 ? ' new feature' : ' new features') });
  if (count(h.improvements)) chips.push({ id: 'improvements', label: count(h.improvements) + (count(h.improvements) === 1 ? ' improvement' : ' improvements') });
  if (count(h.fixes)) chips.push({ id: 'fixes', label: count(h.fixes) + (count(h.fixes) === 1 ? ' fix' : ' fixes') });
  return chips;
}
export const HISTORY_STATUS = { succeeded: 'Installed', installed: 'Installed', rolled_back: 'Rolled back', needs_action: 'Needs manual action', resolved: 'Resolved on the host', not_changed: 'Not changed', refused: 'Not changed', busy: 'Not changed', lost: 'Closed without a result' };
// Messages for every submit error code (REQ-05). Unknown codes fall back to the server text.
// The earliest time a new run is allowed, as HH:MM in the viewer's time zone; the date is added when it is not today.
export function retryTime(retryAt, now = new Date()) {
  const at = new Date(retryAt);
  if (typeof retryAt !== 'string' || Number.isNaN(at.getTime())) return null;
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return at.toDateString() === now.toDateString() ? time : at.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' at ' + time;
}
export function submitMessage(error, now = new Date()) {
  const code = error?.code, status = error?.status;
  const table = {
    REAUTH_REQUIRED: 'Your sign-in check expired. Enter the password and code again.',
    UPDATE_IN_PROGRESS: 'An update is already running. This page will show its progress.',
    NOT_OFFERED: 'This version is no longer offered. Check for updates and try again.',
    RECOVERY_REVIEW_REQUIRED: 'Resolve recovery review first. The update cannot start until then.',
    UPDATER_BLOCKED: 'Updates are blocked until a server operator confirms on the DockNest host with sudo scripts/install-updater.sh --ack.',
    UPDATER_STATE_MISMATCH: 'DockNest cannot confirm which version is installed. Nothing was changed. Check the server and try again.',
    UPDATER_LOW_DISK: 'The DockNest host has too little free disk space for this update. Free up disk space, for example old Docker images or build cache, then try again.',
    UPDATER_BUSY: 'The host updater is busy. Try again in a minute.',
    UPDATER_REFUSED: 'The host updater refused this update. Nothing was changed.',
    UPDATER_RATE_LIMITED: 'Too many update requests. Wait a few minutes and try again.',
    UPDATER_UNAVAILABLE: 'DockNest cannot reach the host updater. Check the connection in the Update Center, then try again.',
  };
  if (code === 'UPDATER_RATE_LIMITED') {
    const when = retryTime(error?.retryAt, now);
    if (error?.limit === 'daily') return 'The updater has reached its daily limit for updates, so nothing was changed.' + (when ? ' You can update again at ' + when + '.' : ' Try again later.');
    if (error?.limit === 'cooldown') return 'The updater needs a minute between runs.' + (when ? ' Try again at ' + when + '.' : ' Try again shortly.');
    return 'The updater is limiting update runs right now. Try again later.';
  }
  if (code === 'RATE_LIMITED' || status === 429) {
    const wait = Number(error?.retryAfter);
    if (Number.isInteger(wait) && wait > 0) return 'Too many requests. Try again in ' + wait + (wait === 1 ? ' second.' : ' seconds.');
  }
  if (table[code]) return table[code];
  if (status === 401) return 'The password or code was not accepted. Check them and try again.';
  if (status === 429) return 'Too many attempts. Wait a minute and try again.';
  return error?.message || 'The update could not be started.';
}
