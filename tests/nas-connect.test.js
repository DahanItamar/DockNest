import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandRefused } from '../src/nas/command.js';
import { connectCapabilities, ConnectRefused } from '../src/nas/connect.js';
import { unraidInstallCommand, loginHint, SYNOLOGY_RESET_HINT } from '../src/nas/guidance.js';

const nas = { kind: 'truenas', version: '25.10.0' };
const ready = (identity, extra = {}) => ({ nas, identity, helperRuntime: 'host', stagingBase: '/mnt/tank/.docknest', ready: true, checks: [], facts: { nas, helperRuntime: 'host', stagingBase: '/mnt/tank/.docknest', sshIdentity: identity }, ...extra });

test('a non-root user on a NAS with passwordless sudo connects and the helper test runs as sudo', async () => {
  let probe;
  const result = await connectCapabilities({ username: 'admin' }, { inspect: async () => ready('sudo'), test: async server => { probe = server; return { uid: 0, nas: { kind: 'forged' }, freeBytes: 5 }; } });
  assert.equal(JSON.parse(probe.capabilities).sshIdentity, 'sudo');
  assert.deepEqual(result.nas, nas, 'helper answers cannot set NAS facts');
  assert.equal(result.sshIdentity, 'sudo'); assert.equal(result.stagingBase, '/mnt/tank/.docknest');
});

test('a non-root user fails closed everywhere else', async () => {
  const never = async () => { throw new Error('the helper must not run'); };
  await assert.rejects(connectCapabilities({ username: 'ops' }, { inspect: async () => ({ nas: null, ready: false, checks: [] }), test: never }), ConnectRefused);
  const noSudo = { nas, identity: 'sudo', ready: false, checks: [{ id: 'identity', status: 'fail', message: 'admin cannot run sudo without a password.', fix: 'Give this user passwordless sudo.' }] };
  await assert.rejects(connectCapabilities({ username: 'admin' }, { inspect: async () => noSudo, test: never }), error => error.status === 409 && /passwordless sudo/.test(error.message) && !!error.fix);
  await assert.rejects(connectCapabilities({ username: 'admin' }, { inspect: async () => ready('sudo', { ready: false }), test: never }), ConnectRefused);
  const sshDown = new Error('boom');
  await assert.rejects(connectCapabilities({ username: 'admin' }, { inspect: async () => { throw sshDown; }, test: never }), error => error === sshDown);
  // sudo reached the helper but it is not root: refused.
  await assert.rejects(connectCapabilities({ username: 'admin' }, { inspect: async () => ready('sudo'), test: async () => ({ uid: 1000 }) }), ConnectRefused);
});

test('root keeps today\'s rules, with or without a NAS', async () => {
  const plain = await connectCapabilities({ username: 'root' }, { inspect: async () => ({ nas: null, ready: false, checks: [] }), test: async server => { assert.equal(server.capabilities, '{}'); return { uid: 0, freeBytes: 1 }; } });
  assert.deepEqual(plain, { uid: 0, freeBytes: 1 });
  const broken = await connectCapabilities({ username: 'root' }, { inspect: async () => { throw new Error('x'); }, test: async () => ({ uid: 0 }) });
  assert.deepEqual(broken, { uid: 0 });
  await assert.rejects(connectCapabilities({ username: 'root' }, { inspect: async () => ({ nas: null }), test: async () => ({ uid: 1000 }) }), ConnectRefused);
  const unraid = await connectCapabilities({ username: 'root' }, { inspect: async () => ready('root'), test: async () => ({ uid: 0 }) });
  assert.equal(unraid.sshIdentity, 'root');
});

test('wizard text: Unraid key command is persistent and takes only a DockNest key', () => {
  const key = 'ssh-rsa ' + Buffer.from('fake-key-material').toString('base64') + ' docknest';
  const command = unraidInstallCommand(key);
  assert.match(command, /\/boot\/config\/ssh\/root\/authorized_keys/);
  assert.throws(() => unraidInstallCommand("ssh-rsa AAA docknest'; rm -rf / #"));
  assert.equal(loginHint({ capabilities: '{"nas":{"kind":"synology"}}' }, { level: 'client-authentication' }, { synology: true }), SYNOLOGY_RESET_HINT);
  assert.equal(loginHint({ capabilities: '{"nas":{"kind":"synology"}}' }, { level: 'client-authentication' }), null, 'no hint while Synology support is off');
  assert.equal(loginHint({ capabilities: '{"nas":{"kind":"unraid"}}' }, { level: 'client-authentication' }), null);
  assert.equal(loginHint({ capabilities: null }, { level: 'client-authentication' }), null);
});

test('a container-runtime NAS that cannot run yet is a 409 with a fix, not a crash', async () => {
  await assert.rejects(connectCapabilities({ username: 'admin' }, { inspect: async () => ready('sudo', { helperRuntime: 'container' }), test: async () => { throw new CommandRefused('x'); } }), error => error instanceof ConnectRefused && error.status === 409 && !!error.fix);
});
test('Unraid key command keeps existing keys and is idempotent', () => {
  const command = unraidInstallCommand('ssh-rsa ' + Buffer.from('fake-key-material').toString('base64') + ' docknest');
  assert.ok(command.includes('[ -s /boot/config/ssh/root/authorized_keys ] || cp /root/.ssh/authorized_keys /boot/config/ssh/root/authorized_keys'));
  assert.ok(!command.includes('cp /boot'), 'the persistent file never overwrites /root keys');
  assert.equal((command.match(/grep -qxF/g) || []).length, 2);
});

test('a refusal says its fix once: the TrueNAS message already ends with it', async () => {
  const sentence = 'TrueNAS apps before 24.10 run on Kubernetes, which DockNest does not back up. Update TrueNAS to 24.10 or newer.';
  const old = { nas: { kind: 'truenas', version: '24.04.2' }, identity: 'sudo', ready: false, checks: [{ id: 'nas-version', status: 'fail', message: sentence, fix: 'Update TrueNAS to 24.10 or newer.' }] };
  await assert.rejects(connectCapabilities({ username: 'admin' }, { inspect: async () => old, test: async () => ({ uid: 0 }) }), error => error.message === sentence && error.fix === 'Update TrueNAS to 24.10 or newer.');
  const other = { nas, identity: 'sudo', ready: false, checks: [{ id: 'docker', status: 'fail', message: 'Docker was not found.', fix: 'Install or start Docker on the server.' }] };
  await assert.rejects(connectCapabilities({ username: 'admin' }, { inspect: async () => other, test: async () => ({ uid: 0 }) }), error => error.message === 'Docker was not found. Install or start Docker on the server.');
});
