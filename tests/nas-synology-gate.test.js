import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { detectNas } from '../src/nas/detect.js';
import { checkNas } from '../src/nas/readiness.js';
import { connectCapabilities, ConnectRefused } from '../src/nas/connect.js';
import { nasWizard } from '../src/nas/guidance.js';
import { SYNOLOGY_ENABLED, SYNOLOGY_INFO, synologyEnabled, setSynologyEnabled, withoutSynology } from '../src/nas/synology-gate.js';
import { nasTypes, NAS_TYPES } from '../web/nas/nas.js';
import { buildJobReport, buildServerReport } from '../web/report/builders.js';

const files = { '/etc/synoinfo.conf': 'x=1', '/etc.defaults/VERSION': 'productversion="7.2.1"\n' };
const fakeRun = () => async argv => (argv[0] === 'cat' && files[argv[2]] !== undefined ? { code: 0, stdout: files[argv[2]] } : { code: 1, stdout: '' });
const memory = () => { const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)'); return db; };

test('the Synology gate is off by default and is stored as an opt-in setting', () => {
  assert.equal(SYNOLOGY_ENABLED, false);
  const db = memory();
  assert.equal(synologyEnabled(db), false);
  setSynologyEnabled(true, db); assert.equal(synologyEnabled(db), true);
  setSynologyEnabled(false, db); assert.equal(synologyEnabled(db), false);
  assert.equal(synologyEnabled({ prepare() { throw new Error('no table'); } }), false, 'fails closed');
});

test('with the gate off a Synology server is a normal Linux server with one plain info line', async () => {
  assert.equal(await detectNas(fakeRun()), null);
  const off = await checkNas({ run: fakeRun(), username: 'root' });
  assert.equal(off.nas, null); assert.equal(off.synologyOff, true);
  assert.equal(off.checks.length, 1); assert.equal(off.checks[0].message, SYNOLOGY_INFO);
  assert.equal(SYNOLOGY_INFO, 'Synology support is coming in a later update. You can still connect it as a normal Linux server with Docker.');
  const on = await checkNas({ run: fakeRun(), username: 'root', synology: true });
  assert.equal(on.nas.kind, 'synology');
});

test('a non-root Synology user is refused with the info line while the gate is off, root connects normally', async () => {
  const inspect = async () => checkNas({ run: fakeRun(), username: 'admin' });
  await assert.rejects(connectCapabilities({ username: 'admin' }, { inspect, test: async () => ({ uid: 0 }) }), error => error instanceof ConnectRefused && error.message.includes(SYNOLOGY_INFO));
  const rootInspect = async () => checkNas({ run: fakeRun(), username: 'root' });
  const facts = await connectCapabilities({ username: 'root' }, { inspect: rootInspect, test: async probe => { assert.equal(probe.capabilities, '{}'); return { uid: 0 }; } });
  assert.equal(facts.nas, undefined);
});

test('screens and discovery hide Synology while the gate is off', () => {
  assert.deepEqual(NAS_TYPES.map(([id]) => id), ['', 'unraid', 'truenas']);
  assert.deepEqual(nasTypes(true).map(([id]) => id), ['', 'unraid', 'synology', 'truenas']);
  assert.equal('synology' in nasWizard(false), false); assert.equal('synology' in nasWizard(true), true);
  const found = { nas: { kind: 'synology' }, containers: [{ name: 'a', nasApp: { manager: 'synology-project', project: 'p' } }] };
  const hidden = withoutSynology(found);
  assert.equal(hidden.nas, undefined); assert.equal(hidden.containers[0].nasApp, undefined);
  assert.equal(withoutSynology({ nas: { kind: 'unraid' } }).nas.kind, 'unraid');
});

test('problem reports from a Synology server carry only the synology tag', () => {
  const nas = report => new URL(report.href).searchParams.get('nas');
  assert.equal(nas(buildJobReport({ version: '3.0.0', installMode: 'image', jobType: 'backup', nas: 'synology' })), 'synology');
  assert.equal(nas(buildServerReport({ version: '3.0.0', installMode: 'image', check: 'ssh', nas: 'synology' })), 'synology');
  assert.equal(nas(buildServerReport({ version: '3.0.0', installMode: 'image', check: 'ssh', nas: 'nas.example.com' })), null);
  assert.equal(nas(buildJobReport({ version: '3.0.0', installMode: 'image', jobType: 'backup' })), null);
});
