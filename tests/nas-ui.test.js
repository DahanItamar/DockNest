import test from 'node:test';
import assert from 'node:assert/strict';
import { nasName, groupManager, managerCaption, webUiText, discoveryErrorTitle, sortChecks, runtimeTitle, identityText, MANAGER_LABELS, TRUENAS_OLD } from '../web/nas/nas.js';
import { recoveryText } from '../src/runbook/guide.js';
import { inventoryParts, changesBetween, digestOf } from '../src/runbook/state.js';

test('NAS names and manager captions come from fixed lists only', () => {
  assert.equal(nasName('unraid'), 'Unraid NAS'); assert.equal(nasName('synology'), 'Synology NAS'); assert.equal(nasName('truenas'), 'TrueNAS NAS');
  for (const bad of ['', null, undefined, '__proto__', 'toString', 'linux']) assert.equal(nasName(bad), null, String(bad));
  assert.equal(groupManager([{ nasApp: { manager: 'nope' } }, { nasApp: { manager: 'truenas-app' } }]), 'truenas-app');
  assert.equal(groupManager([{}, null]), null); assert.equal(groupManager(undefined), null);
  assert.equal(managerCaption('unraid-template'), 'Unraid template · the Docker page keeps managing it');
  assert.equal(managerCaption(null), '');
  for (const manager of Object.keys(MANAGER_LABELS)) assert.ok(managerCaption(manager).length > 10);
});

test('the WebUI setting is plain text, capped, and never a link', () => {
  assert.equal(webUiText({ nasApp: { webUi: 'http://[IP]:[PORT:8080]/' } }), 'http://[IP]:[PORT:8080]/');
  assert.equal(webUiText({ nasApp: { webUi: 'x'.repeat(500) } }).length, 200);
  for (const bad of [{}, null, { nasApp: { webUi: 5 } }, { nasApp: { webUi: '' } }]) assert.equal(webUiText(bad), '');
});

test('discovery errors: the TrueNAS version message gets its own title', () => {
  const message = 'TrueNAS apps before 24.10 run on Kubernetes, which DockNest does not back up. Update TrueNAS to 24.10 or newer.';
  assert.ok(TRUENAS_OLD.test(message)); assert.equal(discoveryErrorTitle(message), 'This TrueNAS version is not supported');
  assert.equal(discoveryErrorTitle('Something else'), 'Containers could not be found'); assert.equal(discoveryErrorTitle(undefined), 'Containers could not be found');
});

test('readiness checks are ordered, filtered and described', () => {
  const rows = sortChecks([{ id: 'docker', status: 'ok', message: 'Docker 27' }, { id: 'weird', status: 'bad', message: 'x' }, { id: 'nas-version', status: 'ok', message: 'unraid 6' }, { id: 'staging', status: 'warn', message: 'm' }, null, { id: 'runtime', status: 'ok' }]);
  assert.deepEqual(rows.map(row => row.id), ['nas-version', 'staging', 'docker']);
  assert.equal(runtimeTitle({ helperRuntime: 'container' }), 'Helper runtime: Container (no Python on host)');
  assert.equal(runtimeTitle({ helperRuntime: 'host' }), 'Helper runtime: Python on the server'); assert.equal(runtimeTitle({}), 'Helper runtime');
  assert.equal(identityText('sudo'), 'Connected as a user with passwordless sudo'); assert.equal(identityText('root'), 'Connected as root'); assert.equal(identityText('x'), '');
});

const at = '2026-11-20T10:00:00.000Z';
test('Recovery Guide: expected time to recover is measured, dated and honest', () => {
  assert.equal(recoveryText(null), 'Not measured yet. Run a restore test to measure it.');
  assert.match(recoveryText({ seconds: 11 * 60 + 20, provenAt: at, stale: false, mayBeLow: false }), /^About 12 min \(proven on .*2026.*\)\.$/);
  assert.match(recoveryText({ seconds: 60, provenAt: at }), /^Under 2 min \(proven on/);
  assert.match(recoveryText({ seconds: 600, provenAt: at, stale: true }), /This test is old: run a new one\.$/);
  assert.match(recoveryText({ seconds: 600, provenAt: at, mayBeLow: true }), /may take longer\.$/);
});

const inventory = recoveryTime => ({
  apps: [{ id: 'a1', name: 'Notes', serverId: 's1', domains: [], schedule: null, lastTest: null, recoveryTime, mainTargetId: 't', copyTargetIds: [] }],
  servers: [{ id: 's1', name: 'Server', host: 'h', port: 22 }], storage: [], defaultTarget: null, selfBackup: { schedule: null }, emergency: { split: false }, notes: '',
});
test('Recovery Guide digest: only an app with a measured time adds a part, so old guides stay current after an upgrade', () => {
  const none = inventoryParts(inventory(null));
  assert.ok(!('recovery' in none));
  const measured = inventoryParts(inventory({ seconds: 700, provenAt: at, stale: false, mayBeLow: false }));
  assert.ok('recovery' in measured);
  assert.deepEqual(changesBetween(none, measured).map(change => change.code), ['recovery_changed']);
  // Same minutes and day: the digest does not move because the second count did.
  assert.equal(digestOf(measured), digestOf(inventoryParts(inventory({ seconds: 701, provenAt: at, stale: true, mayBeLow: true }))));
  assert.notEqual(digestOf(measured), digestOf(inventoryParts(inventory({ seconds: 1500, provenAt: at }))));
  assert.deepEqual(changesBetween(measured, inventoryParts(inventory({ seconds: 1500, provenAt: at }))).map(change => change.code), ['recovery_changed']);
});
