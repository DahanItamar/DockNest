import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MOVE_STATES, TERMINAL_STATES, TRANSITIONS, STEP_NAMES, canTransition, assertTransition, isActive, planSteps, initialSteps,
  beginStep, completeStep, failStep, skipStep, undoneStep, undoFailedStep, retryStep, retryUndo, journalSafe, cancelDecision,
  rollbackPlan, recoverStep, nextAction, answerGate, applyTransition, MoveStateError,
} from '../src/moves/state.js';
import { siteMovesSchema } from '../src/migrations.js';

const now = '2026-10-23T10:00:00.000Z';

test('a draft preview can only start or be cancelled, does nothing by itself and blocks no other site work', async () => {
  const { isMoving } = await import('../src/moves/state.js');
  assert.deepEqual(TRANSITIONS.draft, ['queued', 'cancelled']);
  assert.equal(isActive('draft'), true, 'it holds the one-move-per-site slot');
  assert.equal(isMoving('draft'), false); assert.equal(isMoving('queued'), true);
  assert.deepEqual(nextAction({ id: 'm', state: 'draft', options: { dnsMode: 'manual' } }, []), { type: 'none' });
  assert.deepEqual(cancelDecision({ id: 'm', state: 'draft', options: { dnsMode: 'manual' } }, []), { allowed: true, next: 'cancelled', label: 'Cancel' });
  assert.throws(() => assertTransition('draft', 'running'), MoveStateError);
});
const move = (changes = {}) => ({ id: 'move', state: 'running', waiting_for: null, cancel_requested: 0, options: { dnsMode: 'manual' }, retain_until: null, ...changes });
test('a failure after the switch never rolls back: the owner decides, the new copy is never removed', () => {
  for (const options of [{ dnsMode: 'manual' }, { dnsMode: 'cloudflare' }]) {
    const names = planSteps(options).map(step => step.name), switchAt = names.indexOf('switch_dns');
    for (const failing of ['verify_dns', 'certificate', 'finalize']) {
      const list = steps(options, names.slice(0, names.indexOf(failing)), { [failing]: { state: 'failed', attempt: 1 } });
      assert.ok(names.indexOf(failing) > switchAt);
      assert.deepEqual(nextAction(move({ options }), list), { type: 'transition', to: 'recovery_required' }, `${options.dnsMode} ${failing}`);
      assert.deepEqual(nextAction(move({ options, state: 'rolling_back' }), list), { type: 'transition', to: 'recovery_required' });
    }
  }
  const options = { dnsMode: 'manual' };
  assert.deepEqual(nextAction(move({ options }), steps(options, ['preflight', 'backup', 'deploy_test'], { test: { state: 'failed', attempt: 1 } })), { type: 'transition', to: 'rolling_back' }, 'before the switch a failure still undoes the copy');
  assert.ok(canTransition('waiting', 'switching_back'), 'Cancel and go back while waiting for DNS');
});
// Steps with the first `done` steps finished (resources recorded) and the rest pending.
function steps(options, doneNames = [], extra = {}) {
  return initialSteps('move', options).map(step => doneNames.includes(step.step) ? { ...step, state: 'done', attempt: 1, resources: { created: step.step } } : step).map(step => extra[step.step] ? { ...step, ...extra[step.step] } : step);
}
const manual = { dnsMode: 'manual' }, cloudflare = { dnsMode: 'cloudflare' };

test('the transition table covers every state, and terminal states lead nowhere', () => {
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...MOVE_STATES].sort());
  for (const [from, list] of Object.entries(TRANSITIONS)) for (const to of list) assert.ok(MOVE_STATES.includes(to), `${from} -> ${to}`);
  for (const state of TERMINAL_STATES) { assert.deepEqual(TRANSITIONS[state], []); assert.equal(isActive(state), false); }
  assert.equal(isActive('completed'), true, 'a completed move still holds the old copy, so it keeps the site slot');
  assert.equal(isActive('nonsense'), false);
});

test('legal and illegal transitions', () => {
  for (const [from, to] of [['queued', 'running'], ['running', 'waiting'], ['waiting', 'running'], ['running', 'rolling_back'], ['rolling_back', 'rolled_back'], ['rolling_back', 'cancelled'], ['recovery_required', 'rolling_back'], ['completed', 'switching_back'], ['completed', 'retention_expired'], ['retention_expired', 'cleaned'], ['switching_back', 'switched_back']]) assert.equal(canTransition(from, to), true, `${from} -> ${to}`);
  for (const [from, to] of [['queued', 'completed'], ['completed', 'running'], ['rolled_back', 'running'], ['cancelled', 'queued'], ['waiting', 'completed'], ['completed', 'rolling_back'], ['cleaned', 'switching_back'], ['retention_expired', 'running']]) {
    assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
    assert.throws(() => assertTransition(from, to), error => error instanceof MoveStateError && error.code === 'illegal-transition');
  }
  assert.throws(() => assertTransition('running', 'flying'), error => error.code === 'unknown-state');
});

test('the migration index and the state module agree on which states free the site', () => {
  const list = /WHERE state NOT IN \(([^)]*)\)/.exec(siteMovesSchema)[1].split(',').map(item => item.trim().replace(/'/g, ''));
  assert.deepEqual(list.sort(), [...TERMINAL_STATES].sort());
  const stepStates = /state IN \(([^)]*)\)/.exec(siteMovesSchema)[1].split(',').map(item => item.trim().replace(/'/g, ''));
  assert.deepEqual(stepStates, ['pending', 'running', 'done', 'failed', 'skipped', 'undone', 'undo_failed']);
  for (const name of STEP_NAMES) assert.ok(name.length <= 32);
});

test('the plan depends only on the DNS mode', () => {
  assert.deepEqual(planSteps(manual).map(step => step.name), ['preflight', 'backup', 'deploy_test', 'test', 'await_switch', 'final_sync', 'deploy_final', 'switch_dns', 'verify_dns', 'certificate', 'finalize']);
  assert.deepEqual(planSteps(cloudflare).map(step => step.name), ['preflight', 'backup', 'deploy_test', 'test', 'final_sync', 'deploy_final', 'switch_dns', 'verify_dns', 'certificate', 'finalize']);
  assert.equal(planSteps(manual).find(step => step.name === 'switch_dns').effect, 'irreversible');
  assert.equal(planSteps(cloudflare).find(step => step.name === 'switch_dns').undo, 'revert-dns');
  assert.equal(planSteps(manual).find(step => step.name === 'test').effect, 'none', 'the test step is mandatory and read-only');
  assert.throws(() => planSteps({ dnsMode: 'route53' }), error => error.code === 'invalid-options');
});

test('journal records are idempotent and never mutate their input', () => {
  const [first] = initialSteps('move', manual), frozen = Object.freeze({ ...first });
  const running = beginStep(frozen, now);
  assert.deepEqual({ state: running.state, attempt: running.attempt, started_at: running.started_at }, { state: 'running', attempt: 1, started_at: now });
  const done = completeStep(running, { resources: { dir: '/var/lib/docknest/moves/site' }, result: { ok: true } }, now);
  assert.equal(done.state, 'done');
  assert.equal(completeStep(done, { result: { other: 1 } }, now), done, 'completing twice is a no-op');
  assert.equal(beginStep(done, now), done, 'a done step is never re-run');
  assert.equal(frozen.state, 'pending');
  assert.throws(() => completeStep(first, {}, now), error => error.code === 'step-not-running');
  assert.throws(() => beginStep(undoneStep(done, {}, now), now), error => error.code === 'step-undone');
  const retried = retryStep(failStep(beginStep(first, now), { resources: { half: true } }, now));
  assert.deepEqual({ state: retried.state, attempt: retried.attempt, resources: retried.resources }, { state: 'pending', attempt: 1, resources: { half: true } });
  assert.equal(beginStep(retried, now).attempt, 2);
  assert.equal(retryUndo(undoFailedStep(done, { error: 'ssh' }, now)).state, 'failed');
  assert.equal(skipStep(first, 'cloudflare proxied', now).state, 'skipped');
  assert.throws(() => skipStep(done, 'x', now), error => error.code === 'step-not-pending');
});

test('the journal refuses secret-looking keys and values', () => {
  const [first] = initialSteps('move', manual), running = beginStep(first, now);
  for (const resources of [{ token: 'x' }, { nested: { dbPassword: 'x' } }, { list: [{ apiKey: 'x' }] }, { url: 'postgres://user:hunter2@db:5432/app' }, { header: 'Bearer abc' }, { key: '-----BEGIN OPENSSH PRIVATE KEY-----' }]) {
    assert.throws(() => completeStep(running, { resources }, now), error => error.code === 'secret-in-journal' && !error.message.includes('hunter2'), JSON.stringify(Object.keys(resources)));
  }
  assert.deepEqual(journalSafe({ containers: ['web'], url: 'postgres://db:5432', record: { id: 'r1', previousContent: '203.0.113.7' } }), { containers: ['web'], url: 'postgres://db:5432', record: { id: 'r1', previousContent: '203.0.113.7' } });
});

test('a full manual move walks every step through the gates to completed', () => {
  let current = move({ state: 'queued' }), list = initialSteps('move', manual);
  const seen = [];
  for (let guard = 0; guard < 60; guard++) {
    const action = nextAction(current, list, { now });
    seen.push(action.type + ':' + (action.step ?? action.to ?? action.for));
    if (action.type === 'transition') { current = applyTransition(current, action.to, now, action.waiting_for ? { waiting_for: action.waiting_for } : {}); if (action.to === 'completed') break; continue; }
    if (action.type === 'wait') { const answered = answerGate(current, list, action.for, now); current = answered.move; list = list.map(step => step.step === answered.step.step ? answered.step : step); continue; }
    assert.equal(action.type, 'run');
    list = list.map(step => step.step === action.step ? completeStep(beginStep(step, now), { resources: { by: step.step } }, now) : step);
  }
  assert.equal(current.state, 'completed');
  assert.deepEqual(seen, ['transition:running', 'run:preflight', 'run:backup', 'run:deploy_test', 'run:test', 'transition:waiting', 'wait:await_switch', 'run:final_sync', 'run:deploy_final', 'run:switch_dns', 'transition:waiting', 'wait:verify_dns', 'run:certificate', 'run:finalize', 'transition:completed']);
});

test('answering a gate completes exactly that gate and nothing else', () => {
  const list = steps(manual, ['preflight', 'backup', 'deploy_test', 'test']), waiting = move({ state: 'waiting', waiting_for: 'owner-switch' });
  const { move: resumed, step } = answerGate(waiting, list, 'owner-switch', now, { pressedBy: 'admin' });
  assert.equal(resumed.state, 'running'); assert.equal(resumed.waiting_for, null);
  assert.deepEqual({ step: step.step, state: step.state }, { step: 'await_switch', state: 'done' });
  assert.throws(() => answerGate(waiting, list, 'dns', now), error => error.code === 'not-waiting');
  assert.throws(() => answerGate(move(), list, 'owner-switch', now), error => error.code === 'not-waiting');
  assert.deepEqual(nextAction(waiting, list), { type: 'wait', for: 'owner-switch', step: 'await_switch' }, 'waiting holds no job and runs nothing');
});

test('cancel is allowed only before the switch, and undoes what was changed', () => {
  assert.deepEqual(cancelDecision(move({ state: 'queued' }), steps(manual)), { allowed: true, next: 'cancelled', label: 'Cancel' });
  assert.deepEqual(cancelDecision(move(), steps(manual, ['preflight', 'backup'])), { allowed: true, next: 'cancelled', label: 'Cancel' }, 'a backup is not undone');
  assert.deepEqual(cancelDecision(move({ state: 'waiting', waiting_for: 'owner-switch' }), steps(manual, ['preflight', 'backup', 'deploy_test', 'test'])), { allowed: true, next: 'rolling_back', label: 'Cancelling...' });
  assert.equal(cancelDecision(move(), steps(manual, ['preflight', 'backup', 'deploy_test', 'test', 'await_switch', 'final_sync'], { deploy_final: { state: 'running', attempt: 1 } })).next, 'rolling_back', 'during the final sync cancel restores the source');
  for (const list of [steps(manual, ['preflight', 'backup', 'deploy_test', 'test', 'await_switch', 'final_sync', 'deploy_final'], { switch_dns: { state: 'running', attempt: 1 } }), steps(cloudflare, ['preflight', 'backup', 'deploy_test', 'test', 'final_sync', 'deploy_final', 'switch_dns'])]) {
    const decision = cancelDecision(move(), list);
    assert.equal(decision.allowed, false); assert.match(decision.reason, /Switch back/);
  }
  for (const state of ['completed', 'retention_expired', 'switching_back', 'rolled_back', 'cancelled', 'rolling_back']) assert.equal(cancelDecision(move({ state }), steps(manual)).allowed, false, state);
  // A requested cancel is honoured at the next step boundary.
  assert.deepEqual(nextAction(move({ cancel_requested: 1 }), steps(manual, ['preflight', 'backup', 'deploy_test'])), { type: 'transition', to: 'rolling_back' });
  assert.deepEqual(nextAction(move({ cancel_requested: 1 }), steps(manual, ['preflight'])), { type: 'transition', to: 'cancelled' });
  assert.deepEqual(nextAction(move({ cancel_requested: 1, options: cloudflare }), steps(cloudflare, ['preflight', 'backup', 'deploy_test', 'test', 'final_sync', 'deploy_final', 'switch_dns'])), { type: 'transition', to: 'waiting', waiting_for: 'dns' }, 'after the switch a late cancel request is ignored');
});

test('rollback undoes in reverse order, resumes after a crash and ends in cancelled or rolled_back', () => {
  const list = steps(cloudflare, ['preflight', 'backup', 'deploy_test', 'test', 'final_sync'], { deploy_final: { state: 'failed', attempt: 1, resources: { containers: ['web'] } } });
  const failing = move({ options: cloudflare });
  assert.deepEqual(nextAction(failing, list), { type: 'transition', to: 'rolling_back' });
  const rolling = applyTransition(failing, 'rolling_back', now);
  assert.deepEqual(rollbackPlan(rolling, list).map(item => [item.step, item.undo]), [['deploy_final', 'move-undo'], ['final_sync', 'resume-source'], ['deploy_test', 'move-undo']]);
  // After one undo the remaining work is exactly the rest, so a crash mid-rollback resumes cleanly.
  const partly = list.map(step => step.step === 'deploy_final' ? undoneStep(step, {}, now) : step);
  assert.deepEqual(nextAction(rolling, partly), { type: 'undo', step: 'final_sync', undo: 'resume-source', resources: { created: 'final_sync' } });
  const all = partly.map(step => ['final_sync', 'deploy_test'].includes(step.step) ? undoneStep(step, {}, now) : step);
  assert.deepEqual(nextAction(rolling, all), { type: 'transition', to: 'rolled_back' });
  assert.deepEqual(nextAction({ ...rolling, cancel_requested: 1 }, all), { type: 'transition', to: 'cancelled' });
  // A failed undo stops and asks the owner; retrying the undo picks it up again.
  const stuck = partly.map(step => step.step === 'final_sync' ? undoFailedStep(step, { error: 'The old site is stopped. Press Resume old site.' }, now) : step);
  assert.deepEqual(nextAction(rolling, stuck), { type: 'transition', to: 'recovery_required' });
  const retry = stuck.map(step => step.state === 'undo_failed' ? retryUndo(step) : step);
  assert.equal(nextAction(rolling, retry).step, 'final_sync');
  // A failure before any change ends the move without a rollback.
  assert.deepEqual(nextAction(move(), steps(manual, [], { preflight: { state: 'failed', attempt: 1 } })), { type: 'transition', to: 'failed' });
});

test('crash recovery: every running step resolves to done, rerun, undo, wait or an owner decision', () => {
  const at = (options, name, observed) => recoverStep(move({ options }), { step: name, state: 'running', attempt: 1, resources: {} }, observed);
  for (const name of ['preflight', 'test', 'verify_dns']) assert.deepEqual(at(manual, name, 'unknown'), { action: 'rerun' }, name);
  assert.deepEqual(at(manual, 'deploy_test', 'done'), { action: 'mark_done' });
  assert.deepEqual(at(manual, 'deploy_test', 'absent'), { action: 'undo_then_rerun', undo: 'move-undo' });
  assert.equal(at(manual, 'deploy_test', 'unknown').action, 'retry_later');
  assert.deepEqual(at(manual, 'backup', 'absent'), { action: 'rerun' });
  assert.deepEqual(at(cloudflare, 'switch_dns', 'absent'), { action: 'undo_then_rerun', undo: 'revert-dns' });
  assert.equal(at(manual, 'switch_dns', 'unknown').action, 'recovery_required', 'a manual switch with an unknown outcome needs the owner');
  assert.equal(at(manual, 'finalize', 'unknown').action, 'recovery_required');
  assert.deepEqual(at(manual, 'finalize', 'absent'), { action: 'rerun' }, 'finalize is one transaction: absent means it never committed');
  assert.equal(at(manual, 'mystery', 'done').action, 'recovery_required', 'an unknown journal entry is never guessed at');
  assert.deepEqual(recoverStep(move(), { step: 'test', state: 'done' }, 'done'), { action: 'none' });
  // Every step of both plans has a defined recovery for every observation: nothing is ever lost track of.
  for (const options of [manual, cloudflare]) for (const step of planSteps(options)) for (const observed of ['done', 'absent', 'unknown']) assert.ok(['rerun', 'mark_done', 'undo_then_rerun', 'retry_later', 'recovery_required'].includes(at(options, step.name, observed).action));
  // nextAction sends a crashed running step to recovery first, in normal and rollback states.
  const crashed = steps(manual, ['preflight'], { backup: { state: 'running', attempt: 1 } });
  assert.deepEqual(nextAction(move(), crashed), { type: 'recover', step: 'backup' });
  assert.deepEqual(nextAction(move({ state: 'rolling_back' }), crashed), { type: 'recover', step: 'backup' });
});

test('owner-driven and terminal states never act on their own', () => {
  assert.deepEqual(nextAction(move({ state: 'recovery_required', error: 'The old site is stopped. Press Resume old site.' }), steps(manual)), { type: 'owner', reason: 'The old site is stopped. Press Resume old site.' });
  for (const state of [...TERMINAL_STATES, 'retention_expired', 'switching_back']) assert.deepEqual(nextAction(move({ state }), steps(manual)), { type: 'none' }, state);
  const done = move({ state: 'completed', retain_until: '2026-10-30T10:00:00.000Z' });
  assert.deepEqual(nextAction(done, [], { now }), { type: 'none' });
  assert.deepEqual(nextAction(done, [], { now: '2026-10-30T10:00:00.000Z' }), { type: 'transition', to: 'retention_expired' }, 'day 7 only asks; it never deletes');
  const finished = applyTransition(move({ state: 'rolling_back' }), 'rolled_back', now);
  assert.equal(finished.finished_at, now); assert.equal(finished.waiting_for, null);
});

test('the state module has no I/O imports', async () => {
  const source = await readFile(new URL('../src/moves/state.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import /m);
});
