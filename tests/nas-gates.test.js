import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { detectNas } from '../src/nas/detect.js';
import { checkNas } from '../src/nas/readiness.js';
import { connectCapabilities, ConnectRefused } from '../src/nas/connect.js';
import { identityFor, bindNasGate } from '../src/nas/command.js';
import { nasWizard } from '../src/nas/guidance.js';
import { NAS_DEFAULTS, gateInfo, nasEnabled, nasGates, setNasEnabled, withoutGated } from '../src/nas/gate.js';
import { nasTypes, NAS_TYPES, reportTag } from '../web/nas/nas.js';
import { buildJobReport, buildServerReport } from '../web/report/builders.js';

const SYNO = { '/etc/synoinfo.conf': 'x=1', '/etc.defaults/VERSION': 'productversion="7.2.1"\n' };
const UNRAID = { '/etc/unraid-version': 'version="7.0.1"\n' };
const fakeRun = files => async argv => (argv[0] === 'cat' && files[argv[2]] !== undefined ? { code: 0, stdout: files[argv[2]] } : { code: 1, stdout: '' });
const memory = () => { const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)'); return db; };

test('Synology and Unraid are off by default and stored as opt-in settings; TrueNAS is never gated', () => {
  assert.deepEqual({ ...NAS_DEFAULTS }, { synology: false, unraid: false });
  const db = memory();
  assert.deepEqual(nasGates(db), { synology: false, unraid: false });
  setNasEnabled('unraid', true, db);
  assert.deepEqual(nasGates(db), { synology: false, unraid: true });
  setNasEnabled('unraid', false, db); setNasEnabled('synology', true, db);
  assert.deepEqual(nasGates(db), { synology: true, unraid: false });
  assert.equal(nasEnabled('truenas', db), true);
  assert.throws(() => setNasEnabled('truenas', true, db));
  assert.equal(nasEnabled('unraid', { prepare() { throw new Error('no table'); } }), false, 'fails closed');
});

for (const [kind, files] of [['synology', SYNO], ['unraid', UNRAID]]) {
  test(`with ${kind} off a ${kind} server is a normal Linux server with one plain info line`, async () => {
    assert.equal(await detectNas(fakeRun(files)), null);
    const off = await checkNas({ run: fakeRun(files), username: 'root' });
    assert.equal(off.nas, null); assert.equal(off.gatedOff, kind);
    assert.equal(off.checks.length, 1); assert.equal(off.checks[0].message, gateInfo(kind));
    assert.match(off.checks[0].message, /^(Synology|Unraid) support is coming in a later update\. You can still connect it as a normal Linux server with Docker\.$/);
    assert.equal((await checkNas({ run: fakeRun(files), username: 'root', [kind]: true })).nas.kind, kind);
  });

  test(`a non-root ${kind} user is refused with the info line while it is off, root connects normally`, async () => {
    await assert.rejects(connectCapabilities({ username: 'admin' }, { inspect: async () => checkNas({ run: fakeRun(files), username: 'admin' }), test: async () => ({ uid: 0 }) }), error => error instanceof ConnectRefused && error.message.includes(gateInfo(kind)));
    const facts = await connectCapabilities({ username: 'root' }, { inspect: async () => checkNas({ run: fakeRun(files), username: 'root' }), test: async probe => { assert.equal(probe.capabilities, '{}'); return { uid: 0 }; } });
    assert.equal(facts.nas, undefined);
  });

  test(`a ${kind} server saved while it was on goes back to the normal identity when it is off, read live`, () => {
    const server = { username: 'admin', capabilities: JSON.stringify({ nas: { kind }, helperRuntime: 'container' }) };
    assert.deepEqual(identityFor(server), { identity: 'root', runtime: 'host', nasKind: null });
    assert.deepEqual(identityFor(server, { [kind]: true }), { identity: 'sudo', runtime: 'container', nasKind: kind });
    let live = false;
    bindNasGate(() => live);
    assert.equal(identityFor(server).nasKind, null);
    live = true; assert.equal(identityFor(server).nasKind, kind);
    live = false; assert.equal(identityFor(server).nasKind, null);
    bindNasGate(() => false);
    assert.equal(identityFor({ username: 'admin', capabilities: '{"nas":{"kind":"truenas"}}' }).identity, 'sudo');
  });
}

test('screens and discovery hide gated systems while they are off', () => {
  assert.deepEqual(NAS_TYPES.map(([id]) => id), ['', 'truenas']);
  assert.deepEqual(nasTypes({ unraid: true, synology: true }).map(([id]) => id), ['', 'unraid', 'synology', 'truenas']);
  assert.deepEqual(nasTypes({ unraid: true }).map(([id]) => id), ['', 'unraid', 'truenas']);
  assert.deepEqual(Object.keys(nasWizard({})), ['truenas']);
  assert.deepEqual(Object.keys(nasWizard({ unraid: true })), ['unraid', 'truenas']);
  const syno = { nas: { kind: 'synology' }, containers: [{ name: 'a', nasApp: { manager: 'synology-project', project: 'p' } }] };
  assert.equal(withoutGated(syno, { synology: false }).nas, undefined);
  assert.equal(withoutGated(syno, { synology: false }).containers[0].nasApp, undefined);
  assert.equal(withoutGated(syno, { synology: true }).nas.kind, 'synology');
  const unraid = { nas: { kind: 'unraid' }, containers: [{ nasApp: { manager: 'unraid-template' } }, { nasApp: { manager: 'unraid-compose-manager' } }] };
  assert.equal(withoutGated(unraid, { unraid: false }).nas, undefined);
  assert.deepEqual(withoutGated(unraid, { unraid: false }).containers, [{}, {}]);
  assert.equal(withoutGated({ nas: { kind: 'truenas' } }, {}).nas.kind, 'truenas');
});

test('problem reports from early-access NAS servers carry only the synology or unraid tag', () => {
  const nas = report => new URL(report.href).searchParams.get('nas');
  const base = { version: '3.0.0', installMode: 'image' };
  for (const tag of ['synology', 'unraid']) {
    assert.equal(nas(buildJobReport({ ...base, jobType: 'backup', nas: tag })), tag);
    assert.equal(nas(buildServerReport({ ...base, check: 'ssh', nas: tag })), tag);
  }
  assert.equal(nas(buildServerReport({ ...base, check: 'ssh', nas: 'nas.example.com' })), null);
  assert.equal(nas(buildJobReport({ ...base, jobType: 'backup', nas: 'truenas' })), null);
  assert.equal(nas(buildJobReport({ ...base, jobType: 'backup' })), null);
  assert.equal(reportTag({ capabilities: { nas: { kind: 'unraid' } } }), 'unraid');
  assert.equal(reportTag({ capabilities: { nas: { kind: 'truenas' } } }), undefined);
});
