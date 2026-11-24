import test from 'node:test';
import assert from 'node:assert/strict';
import { engineLabel, sharedRuntime, runtimeConfig, oneEngineMessage, sortByEngine, groupRuntime, testServerProblem, podmanOnly, isRootful } from '../web/runtime-ui.js';
// Engines in the UI (docs/podman-rootless.md): the words and the rules the screens show. The API checks everything again.
const notes = { engine: 'podman', rootless: true, user: 'svc', uid: 1002 };
const appUser = { engine: 'docker', rootless: true, user: 'app', uid: 1001 };
const container = (name, runtime) => ({ name, ...(runtime ? { runtime } : {}) });

test('engines are named plainly', () => {
  assert.equal(engineLabel(undefined), 'Docker');
  assert.equal(engineLabel({ engine: 'docker', rootless: false }), 'Docker');
  assert.equal(engineLabel({ engine: 'podman', rootless: false }), 'Podman');
  assert.equal(engineLabel(appUser), 'Docker rootless, user app');
  assert.equal(engineLabel(notes), 'Podman rootless, user svc');
  assert.equal(engineLabel({ engine: 'lxc', rootless: false }), 'Docker', 'an unknown engine never reaches the screen as its own text');
});

test('one app, one engine', () => {
  assert.deepEqual(sharedRuntime([container('a'), container('b', { engine: 'docker', rootless: false })]).runtime, { engine: 'docker', rootless: false });
  assert.deepEqual(sharedRuntime([container('a', notes), container('b', notes)]).runtime, notes);
  assert.equal(sharedRuntime([container('a'), container('b', notes)]).conflict.length, 2);
  assert.equal(sharedRuntime([container('a', notes), container('b', { ...notes, uid: 1003, user: 'other' })]).conflict.length, 2);
  assert.equal(oneEngineMessage('Shop'), "Shop's containers run in two engines. Make two apps.");
});

test('a saved app carries its engine only when it is not rootful Docker', () => {
  assert.deepEqual(runtimeConfig([container('a')]), {});
  assert.deepEqual(runtimeConfig([container('a', { engine: 'docker', rootless: false })]), {});
  assert.deepEqual(runtimeConfig([container('a', notes), container('b', notes)]), { runtime: notes });
  assert.deepEqual(runtimeConfig([container('a', { engine: 'podman', rootless: false, extra: 'x' })]), { runtime: { engine: 'podman', rootless: false } });
  assert.deepEqual(runtimeConfig([container('a', notes), container('b')]), {}, 'a split app saves no engine; the API refuses it');
});

test('groups read in the same order every time, rootful Docker first', () => {
  const groups = [{ name: 'queue', containers: [container('q', notes)] }, { name: 'zeta', containers: [container('z')] }, { name: 'alpha', containers: [container('a')] }, { name: 'notes2', containers: [container('n', appUser)] }];
  assert.deepEqual(sortByEngine(groups, groupRuntime).map(group => group.name), ['alpha', 'zeta', 'notes2', 'queue']);
  assert.deepEqual(groupRuntime({ containers: [] }), { engine: 'docker', rootless: false });
});

test('a restore test server is refused in one plain sentence when it cannot run the app', () => {
  const server = (engines, name = 'Server 2') => ({ name, capabilities: { engines } });
  const site = { config: { runtime: notes } };
  assert.equal(testServerProblem({ config: {} }, server([])), '');
  assert.equal(testServerProblem(site, null), '');
  assert.equal(testServerProblem(site, server([{ ...notes, cgroupDelegated: true }])), '');
  assert.match(testServerProblem(site, server([{ ...notes, cgroupDelegated: false }])), /cannot limit memory for user apps, so DockNest will not test there\. Turn on memory and CPU delegation for user svc on Server 2/);
  assert.match(testServerProblem(site, server([])), /Server 2 does not run Podman rootless, user svc\. Pick a server that does/);
  assert.match(testServerProblem(site, { name: 'Server 2' }), /does not run/);
  assert.equal(testServerProblem({ config: { runtime: { engine: 'podman', rootless: false } } }, server([{ engine: 'podman', rootless: false, cgroupDelegated: false }])), '', 'rootful Podman needs no delegation');
});

test('a Podman-only server is recognised', () => {
  assert.equal(podmanOnly({ capabilities: { docker: null, engines: [{ engine: 'podman', rootless: false }] } }), true);
  assert.equal(podmanOnly({ capabilities: { docker: '28.0.1', engines: [{ engine: 'podman', rootless: false }] } }), false);
  assert.equal(podmanOnly({ capabilities: { docker: null, engines: [] } }), false);
  assert.equal(podmanOnly({}), false);
  assert.equal(isRootful(undefined) && isRootful({ engine: 'docker', rootless: false }) && !isRootful(notes), true);
});
