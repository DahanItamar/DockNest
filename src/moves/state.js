// Site move state machine (docs/moving-sites.md). Pure: no database, SSH or clock access; callers pass `now`.
// The worker (a later PR) persists what these functions return into site_moves and site_move_steps.
//
// Rules this module enforces:
// - Every step is journaled before its side effect (`running`, attempt + 1) and after it (`done` with resources).
// - Re-running a finished step is a no-op, so a crash between "effect done" and "journal written" is safe.
// - Cancel is accepted only before the switch (`switch_dns`) starts. After that the action is "Switch back".
// - After a crash a `running` step is verified against real state: done, undone and re-run, or, when the
//   outcome cannot be known and the effect cannot be undone, the move stops in `recovery_required`.
// - Undo runs in reverse order over steps that changed something. Undo never deletes a backup or user data
//   that existed before the move; it only removes what the step journaled as created by this move.

export const MOVE_STATES = Object.freeze(['queued', 'running', 'waiting', 'rolling_back', 'recovery_required', 'completed', 'retention_expired', 'switching_back', 'rolled_back', 'cancelled', 'failed', 'switched_back', 'cleaned']);
// Must equal the list in the site_moves_active index (src/migrations.js, migration 6).
export const TERMINAL_STATES = Object.freeze(['rolled_back', 'cancelled', 'failed', 'switched_back', 'cleaned']);
export const STEP_STATES = Object.freeze(['pending', 'running', 'done', 'failed', 'skipped', 'undone', 'undo_failed']);
export const WAITING_FOR = Object.freeze(['owner-switch', 'dns']);
export const DNS_MODES = Object.freeze(['manual', 'cloudflare']);

const transitions = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['waiting', 'rolling_back', 'recovery_required', 'completed', 'cancelled', 'failed'],
  waiting: ['running', 'rolling_back', 'recovery_required'],
  rolling_back: ['rolled_back', 'cancelled', 'recovery_required'],
  recovery_required: ['running', 'rolling_back', 'switching_back'],
  completed: ['retention_expired', 'switching_back', 'cleaned'],
  retention_expired: ['switching_back', 'cleaned'],
  switching_back: ['switched_back', 'recovery_required'],
  rolled_back: [], cancelled: [], failed: [], switched_back: [], cleaned: [],
};
export const TRANSITIONS = Object.freeze(Object.fromEntries(Object.entries(transitions).map(([key, value]) => [key, Object.freeze([...value])])));

// effect: 'none' (reads only, or creates something a move never removes, such as a backup),
//         'reversible' (has an idempotent undo), 'irreversible' (outcome owned by someone else or atomic in SQLite).
// verify: how a crashed `running` step is resolved. 'rerun' re-runs it; 'check' asks the caller for the real state.
// limitSeconds: the step fails (and the move rolls back) when it runs longer.
const definitions = [
  { name: 'preflight', effect: 'none', verify: 'rerun', limitSeconds: 300 },
  { name: 'backup', effect: 'none', verify: 'check', limitSeconds: 3600 },
  { name: 'deploy_test', effect: 'reversible', verify: 'check', undo: 'move-undo', limitSeconds: 3600 },
  { name: 'test', effect: 'none', verify: 'rerun', limitSeconds: 300 },
  { name: 'await_switch', effect: 'none', verify: 'rerun', gate: 'owner-switch', modes: ['manual'] },
  { name: 'final_sync', effect: 'reversible', verify: 'check', undo: 'resume-source', limitSeconds: 1800 },
  { name: 'deploy_final', effect: 'reversible', verify: 'check', undo: 'move-undo', limitSeconds: 3600 },
  { name: 'switch_dns', effect: 'reversible', verify: 'check', undo: 'revert-dns', modes: ['cloudflare'], switch: true, limitSeconds: 300 },
  // Manual DNS: the step shows the exact record and marks the switch; the owner changes the record, verify_dns waits.
  { name: 'switch_dns', effect: 'irreversible', verify: 'check', modes: ['manual'], switch: true },
  { name: 'verify_dns', effect: 'none', verify: 'rerun', gate: 'dns' },
  { name: 'certificate', effect: 'reversible', verify: 'check', undo: 'remove-certificate-block', limitSeconds: 600 },
  { name: 'finalize', effect: 'irreversible', verify: 'check', limitSeconds: 60 },
];
export const STEP_NAMES = Object.freeze([...new Set(definitions.map(step => step.name))]);
export const SWITCH_STEP = 'switch_dns';

export class MoveStateError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const isTerminal = state => TERMINAL_STATES.includes(state);
// Holds the per-site slot (unique index) and blocks other mutating work on the site.
export const isActive = state => MOVE_STATES.includes(state) && !isTerminal(state);
export const canTransition = (from, to) => Boolean(TRANSITIONS[from]?.includes(to));
export function assertTransition(from, to) {
  if (!MOVE_STATES.includes(from) || !MOVE_STATES.includes(to)) throw new MoveStateError('unknown-state', `Unknown move state ${JSON.stringify(MOVE_STATES.includes(from) ? to : from)}.`);
  if (!canTransition(from, to)) throw new MoveStateError('illegal-transition', `A move cannot go from ${from} to ${to}.`);
  return to;
}

// The ordered steps for one move. Only the DNS mode changes the list: manual moves wait for the owner before the
// final sync and the owner changes the record; Cloudflare moves switch the record themselves.
export function planSteps(options = {}) {
  const mode = options.dnsMode ?? 'manual';
  if (!DNS_MODES.includes(mode)) throw new MoveStateError('invalid-options', `Unknown DNS mode ${JSON.stringify(mode)}.`);
  return definitions.filter(step => !step.modes || step.modes.includes(mode)).map(step => Object.freeze({ ...step }));
}
export const stepDefinition = (options, name) => planSteps(options).find(step => step.name === name);

export function initialSteps(moveId, options) {
  return planSteps(options).map(step => ({ move_id: moveId, step: step.name, attempt: 0, state: 'pending', started_at: null, finished_at: null, resources: {}, result: {} }));
}

// Journal records. Each function returns a new record and never mutates its input.
const record = (step, changes) => ({ ...step, ...changes });
export function beginStep(step, now) {
  if (step.state === 'done' || step.state === 'skipped') return step; // idempotent: a finished step is never re-run
  if (step.state === 'undone' || step.state === 'undo_failed') throw new MoveStateError('step-undone', `Step ${step.step} was undone; the move must start again.`);
  return record(step, { state: 'running', attempt: step.attempt + 1, started_at: now, finished_at: null });
}
export function completeStep(step, { resources, result } = {}, now) {
  if (step.state === 'done') return step;
  if (step.state !== 'running') throw new MoveStateError('step-not-running', `Step ${step.step} is ${step.state}, not running.`);
  return record(step, { state: 'done', finished_at: now, resources: journalSafe({ ...step.resources, ...resources }), result: journalSafe({ ...step.result, ...result }) });
}
// A failed step keeps the resources it recorded, so rollback can still undo a partial effect.
export function failStep(step, { resources, result } = {}, now) {
  if (step.state !== 'running') throw new MoveStateError('step-not-running', `Step ${step.step} is ${step.state}, not running.`);
  return record(step, { state: 'failed', finished_at: now, resources: journalSafe({ ...step.resources, ...resources }), result: journalSafe({ ...step.result, ...result }) });
}
export function skipStep(step, reason, now) {
  if (step.state === 'skipped') return step;
  if (step.state !== 'pending') throw new MoveStateError('step-not-pending', `Step ${step.step} is ${step.state}, not pending.`);
  return record(step, { state: 'skipped', finished_at: now, result: journalSafe({ ...step.result, skipped: reason }) });
}
export function undoneStep(step, result, now) {
  if (step.state === 'undone') return step;
  return record(step, { state: 'undone', finished_at: now, result: journalSafe({ ...step.result, ...result }) });
}
export function undoFailedStep(step, result, now) {
  return record(step, { state: 'undo_failed', finished_at: now, result: journalSafe({ ...step.result, ...result }) });
}

// Journal rows are shown in the UI and kept for audit, so they must never hold secret values. Key names that look
// like credentials, and values with URL userinfo or bearer tokens, are refused rather than silently stored.
const secretKey = /pass(word|wd)?|secret|token|private|credential|authorization|api[-_]?key|cookie|session/i;
const secretValue = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@|\bbearer\s+\S|-----BEGIN [A-Z ]*PRIVATE KEY/i;
export function journalSafe(value, path = 'journal') {
  if (Array.isArray(value)) { value.forEach((item, index) => journalSafe(item, `${path}[${index}]`)); return value; }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (secretKey.test(key)) throw new MoveStateError('secret-in-journal', `Refusing to journal ${path}.${key}: it looks like a secret.`);
      journalSafe(item, `${path}.${key}`);
    }
    return value;
  }
  if (typeof value === 'string' && secretValue.test(value)) throw new MoveStateError('secret-in-journal', `Refusing to journal ${path}: the value looks like a secret.`);
  return value;
}

const indexOf = (steps, name) => steps.findIndex(step => step.step === name);
const switchStarted = steps => { const step = steps[indexOf(steps, SWITCH_STEP)]; return Boolean(step) && step.state !== 'pending'; };

// Whether "Cancel" is offered, and what it does. Before any change: the move just ends. With changes on the target or a
// stopped source: everything is undone first ("Cancelling..."). From the switch on, cancel is refused; use switch back.
export function cancelDecision(move, steps) {
  if (!isActive(move.state) || ['completed', 'retention_expired', 'switching_back'].includes(move.state)) return { allowed: false, reason: 'This move has already finished.' };
  if (move.state === 'rolling_back') return { allowed: false, reason: 'This move is already being undone.' };
  if (switchStarted(steps)) return { allowed: false, reason: 'The switch has started, so the move can no longer be cancelled. Use Switch back after it finishes.' };
  const changed = steps.some(step => needsUndo(move, step));
  return { allowed: true, next: changed ? 'rolling_back' : 'cancelled', label: changed ? 'Cancelling...' : 'Cancel' };
}

const definitionFor = (move, name) => stepDefinition(move.options, name);
function needsUndo(move, step) {
  const definition = definitionFor(move, step.step);
  if (!definition?.undo) return false;
  if (step.state === 'done' || step.state === 'undo_failed') return true;
  // A failed or crashed step may have changed something before it stopped; its undo is idempotent.
  return (step.state === 'failed' || step.state === 'running') && step.attempt > 0;
}

// Undo order for a rollback: reverse plan order, only steps that changed something and are not undone yet.
// Re-computing after a partial rollback returns exactly the remaining work.
export function rollbackPlan(move, steps) {
  return steps.filter(step => needsUndo(move, step)).reverse().map(step => ({ step: step.step, undo: definitionFor(move, step.step).undo, resources: step.resources }));
}

// Crash recovery for one step that the journal shows as `running`. `observed` is what the caller found on the hosts
// or in DNS: 'done' (the effect is fully in place), 'absent' (nothing happened) or 'unknown' (could not check).
export function recoverStep(move, step, observed) {
  if (step.state !== 'running') return { action: 'none' };
  const definition = definitionFor(move, step.step);
  if (!definition) return { action: 'recovery_required', reason: `The journal names an unknown step ${step.step}.` };
  if (definition.verify === 'rerun') return { action: 'rerun' };
  if (observed === 'done') return { action: 'mark_done' };
  if (observed === 'absent') return definition.effect === 'reversible' ? { action: 'undo_then_rerun', undo: definition.undo } : { action: 'rerun' };
  if (definition.effect === 'irreversible') return { action: 'recovery_required', reason: `DockNest could not confirm whether ${step.step} finished. Check the site, then choose Resume or Undo.` };
  return { action: 'retry_later', reason: `DockNest could not check ${step.step} yet; it will try again.` };
}

// What the worker should do next for one move. Never side-effecting; the worker carries the action out, journals
// it with the functions above, and calls this again.
export function nextAction(move, steps, { now = new Date().toISOString() } = {}) {
  if (isTerminal(move.state)) return { type: 'none' };
  if (move.state === 'recovery_required') return { type: 'owner', reason: move.error ?? 'This move needs your decision.' };
  if (move.state === 'completed') return move.retain_until && now >= move.retain_until ? { type: 'transition', to: 'retention_expired' } : { type: 'none' };
  if (move.state === 'retention_expired' || move.state === 'switching_back') return { type: 'none' }; // owner-driven
  const running = steps.find(step => step.state === 'running');
  if (move.state === 'rolling_back') {
    if (running) return { type: 'recover', step: running.step };
    // An undo that failed stops the rollback: the owner is told plainly what state the site is in.
    if (steps.some(step => step.state === 'undo_failed')) return { type: 'transition', to: 'recovery_required' };
    const [first] = rollbackPlan(move, steps);
    if (first) return { type: 'undo', ...first };
    return { type: 'transition', to: move.cancel_requested ? 'cancelled' : 'rolled_back' };
  }
  if (running) return { type: 'recover', step: running.step };
  const failed = steps.find(step => step.state === 'failed' || step.state === 'undo_failed');
  if (failed) return { type: 'transition', to: rollbackPlan(move, steps).length ? 'rolling_back' : 'failed' };
  if (move.cancel_requested) {
    const decision = cancelDecision(move, steps);
    if (decision.allowed) return { type: 'transition', to: decision.next };
  }
  const pending = steps.find(step => step.state === 'pending');
  if (!pending) return { type: 'transition', to: 'completed' };
  if (move.state === 'queued') return { type: 'transition', to: 'running' };
  const definition = definitionFor(move, pending.step);
  // Gates hold no job: the move rests in `waiting` until the owner answers or (for DNS) the worker's poll confirms.
  if (definition.gate) return move.state === 'waiting' ? { type: 'wait', for: definition.gate, step: pending.step } : { type: 'transition', to: 'waiting', waiting_for: definition.gate };
  return { type: 'run', step: pending.step, limitSeconds: definition.limitSeconds ?? null };
}

// A gate was passed: the owner pressed "Switch now", or the DNS poll saw the record point at the new server.
// Completes the gate step and resumes the move. Only the gate the move is waiting for can be answered.
export function answerGate(move, steps, gate, now, result = {}) {
  const step = steps.find(item => item.state === 'pending');
  if (move.state !== 'waiting' || move.waiting_for !== gate || definitionFor(move, step?.step)?.gate !== gate) throw new MoveStateError('not-waiting', 'This move is not waiting for that.');
  return { move: applyTransition(move, 'running', now), step: completeStep(beginStep(step, now), { result }, now) };
}

// Owner decisions from recovery_required. Resume re-runs a failed step (it keeps its resources and attempt count);
// Undo retries an undo that failed. Both keep the journal, so nothing is forgotten.
export function retryStep(step) {
  if (step.state !== 'failed') throw new MoveStateError('step-not-failed', `Step ${step.step} is ${step.state}, not failed.`);
  return record(step, { state: 'pending', finished_at: null });
}
export function retryUndo(step) {
  if (step.state !== 'undo_failed') throw new MoveStateError('step-not-undo-failed', `Step ${step.step} is ${step.state}, not undo_failed.`);
  return record(step, { state: 'failed' });
}

export function applyTransition(move, to, now, changes = {}) {
  assertTransition(move.state, to);
  const finished = isTerminal(to) ? { finished_at: now } : {};
  return { ...move, ...changes, ...finished, state: to, waiting_for: to === 'waiting' ? changes.waiting_for ?? move.waiting_for : null, updated_at: now };
}
