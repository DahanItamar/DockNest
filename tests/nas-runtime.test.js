import test from 'node:test';
import assert from 'node:assert/strict';
import { helperArgv, helperCommand, identityFor, bindNasGate, LEGACY_HOST_COMMAND, LOADER, quote, CommandRefused } from '../src/nas/command.js';
bindNasGate(() => true); // the gate itself is tested in nas-gates.test.js
import { computeMounts, checkMountPath, MountRefused } from '../src/nas/mounts.js';
import { prepareHelper, setSudoAuditSink, auditSudo } from '../src/nas/run.js';
import { detectNas, parseUnraidVersion, parseSynologyVersion, parseTrueNasVersion, trueNasSupported, pythonUsable, chooseStagingBase } from '../src/nas/detect.js';
import { checkNas, withoutNasFacts } from '../src/nas/readiness.js';
import { HELPER_RUNTIME_IMAGE_ID } from '../shared/helper-runtime.js';

// A fake image ID built at runtime (no hash literals in the repository).
const fakeId = 'sha256:' + 'ab'.repeat(32);

test('existing servers keep the exact legacy command', () => {
  assert.equal(helperCommand({ identity: 'root', runtime: 'host' }), LEGACY_HOST_COMMAND);
  assert.equal(prepareHelper({ username: 'root', capabilities: '{"uid":0}' }, { operation: 'test' }).command, LEGACY_HOST_COMMAND);
  // A non-root user on a server that is not a NAS never gets sudo.
  const odd = prepareHelper({ username: 'ops', capabilities: { uid: 1000 } }, { operation: 'test' });
  assert.equal(odd.identity, 'root'); assert.equal(odd.command, LEGACY_HOST_COMMAND);
});

test('sudo mode is one fixed argv with no shell string', () => {
  const argv = helperArgv({ identity: 'sudo', runtime: 'host' });
  assert.deepEqual(argv, ['sudo', '-n', '--', 'python3', '-c', LOADER]);
  const command = helperCommand({ identity: 'sudo', runtime: 'host' });
  assert.ok(command.startsWith("'sudo' '-n' '--' 'python3' '-c' '"));
  for (const banned of ['-S', '-i', '-s', '-E', '-u']) assert.ok(!argv.includes(banned));
  assert.ok(!command.includes('sh -c') && !command.includes('bash'));
});

test('the container runtime has no network, no ports, a pinned image and computed mounts', () => {
  const argv = helperArgv({ identity: 'sudo', runtime: 'container', operation: 'capture', mounts: ['/mnt/user/appdata/app', '/mnt/user/appdata/app/sub', '/mnt/user/system/docknest'], imageId: fakeId, allowedIds: [fakeId] });
  assert.deepEqual(argv.slice(0, 8), ['sudo', '-n', '--', 'docker', 'run', '--rm', '-i', '--pull']);
  assert.equal(argv[argv.indexOf('--network') + 1], 'none');
  assert.ok(!argv.includes('-p') && !argv.includes('--publish') && !argv.includes('--privileged'));
  assert.ok(argv.includes(fakeId));
  const mounts = argv.filter((_, i) => argv[i - 1] === '--mount');
  assert.deepEqual(mounts, ['type=bind,src=/mnt/user/appdata/app,dst=/mnt/user/appdata/app,bind-propagation=rslave', 'type=bind,src=/mnt/user/system/docknest,dst=/mnt/user/system/docknest,bind-propagation=rslave']);
  assert.equal(helperArgv({ runtime: 'container', operation: 'domain-routes', mounts: [], imageId: fakeId, allowedIds: [fakeId] }).includes('host'), true);
  assert.equal(helperArgv({ runtime: 'container', operation: 'restore', mounts: [], imageId: fakeId, allowedIds: [fakeId] })[helperArgv({ runtime: 'container', operation: 'restore', mounts: [], imageId: fakeId, allowedIds: [fakeId] }).indexOf('--network') + 1], 'none');
});

test('the container runtime fails closed without a pinned image or mounts', () => {
  assert.equal(HELPER_RUNTIME_IMAGE_ID, null);
  assert.throws(() => helperArgv({ runtime: 'container', mounts: [] }), CommandRefused);
  assert.throws(() => helperArgv({ runtime: 'container', mounts: [], imageId: 'docknest-helper-runtime:latest' }), CommandRefused);
  assert.throws(() => prepareHelper({ username: 'root', capabilities: { nas: { kind: 'unraid' }, helperRuntime: 'container' } }, { operation: 'test' }), CommandRefused);
  assert.throws(() => helperArgv({ identity: 'su' }), CommandRefused);
});

test('mount deny-list and path rules', () => {
  for (const bad of ['/', '/proc', '/proc/1', '/sys/x', '/dev', '/etc', '/etc/ssh', '/boot', '/boot/config', '/run', '/var/run/docker.sock', '/root/.ssh', 'rel/path', '/a/../etc', '/a/./b', '/a,b', '/a b"c', '/a\nb', '/a$b', '/a`b', '', null, 5])
    assert.throws(() => checkMountPath(bad), MountRefused, String(bad));
  assert.throws(() => checkMountPath('/boot/config/plugins/dockerMan/templates-user'), MountRefused);
  assert.equal(checkMountPath('/boot/config/plugins/dockerMan/templates-user', { nasKind: 'unraid' }), '/boot/config/plugins/dockerMan/templates-user');
  assert.throws(() => checkMountPath('/boot/config/ssh/root', { nasKind: 'unraid' }), MountRefused);
  assert.equal(checkMountPath('/volume1/docker/my app/'), '/volume1/docker/my app');
  assert.deepEqual(computeMounts(['/b', '/a', '/a/c', '/a']), ['/a', '/b']);
  assert.throws(() => computeMounts(Array.from({ length: 65 }, (_, i) => '/m/' + i)), MountRefused);
});

test('quoting keeps an argument one word', () => {
  assert.equal(quote("it's"), "'it'\\''s'");
  assert.throws(() => quote('a\nb'), CommandRefused);
  assert.throws(() => quote('a\0b'), CommandRefused);
});

test('sudo audit holds the operation, server and result only', async () => {
  const seen = [];
  setSudoAuditSink((id, entry) => seen.push([id, entry]));
  const prepared = prepareHelper({ id: 's1', username: 'admin', capabilities: { nas: { kind: 'truenas' }, helperRuntime: 'host' } }, { operation: 'capture', secret: 'hunter2-value' });
  assert.equal(prepared.identity, 'sudo');
  await auditSudo({ id: 's1' }, prepared, 'ok');
  await auditSudo({ id: 's1' }, { ...prepared, identity: 'root' }, 'ok');
  setSudoAuditSink(null);
  assert.deepEqual(seen, [['s1', { operation: 'capture', runtime: 'host', result: 'ok' }]]);
});

test('identityFor only offers sudo on a detected NAS', () => {
  assert.deepEqual(identityFor({ username: 'root', capabilities: null }), { identity: 'root', runtime: 'host', nasKind: null });
  assert.equal(identityFor({ username: 'truenas_admin', capabilities: '{"nas":{"kind":"truenas"}}' }).identity, 'sudo');
  assert.equal(identityFor({ username: 'root', capabilities: '{"nas":{"kind":"unraid"},"helperRuntime":"container"}' }).runtime, 'container');
  assert.equal(identityFor({ username: 'x', capabilities: 'not json' }).identity, 'root');
});

// A fake server: files by path, commands by prefix.
function fakeRun({ files = {}, python = null, docker = null, image = null, sudoOk = true, existing = [], free = 500 * 1024 ** 2 * 100, authKeys = true } = {}) {
  const calls = [];
  const run = async argv => {
    calls.push(argv);
    let a = argv;
    if (a[0] === 'sudo') { if (!sudoOk) return { code: 1, stdout: '' }; a = a.slice(3); if (a[0] === 'true') return { code: 0, stdout: '' }; }
    if (a[0] === 'cat') return a[2] in files ? { code: 0, stdout: files[a[2]] } : { code: 1, stdout: '' };
    if (a[0] === 'test') return { code: a[2] === '/usr/bin/midclt' ? (files.midclt ? 0 : 1) : a[1] === '-s' ? (authKeys ? 0 : 1) : existing.includes(a[2]) ? 0 : 1, stdout: '' };
    if (a[0] === 'python3') return python ? { code: 0, stdout: python + '\n' } : { code: 127, stdout: '' };
    if (a[1] === 'version') return docker ? { code: 0, stdout: docker + '\n' } : { code: 127, stdout: '' };
    if (a[1] === 'image') return image ? { code: 0, stdout: image + '\n' } : { code: 1, stdout: '' };
    if (a[0] === 'ls') return { code: 0, stdout: a[3] === '/mnt' ? 'tank\n.ix-apps\n' : 'volume1\nvolume2\nhome\n' };
    if (a[0] === 'df') return { code: 0, stdout: `Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 9999 1 ${Math.floor(free / 1024)} 1% /m\n` };
    return { code: 127, stdout: '' };
  };
  return { run, calls };
}
const unraidFiles = { '/etc/unraid-version': 'version="6.12.10"\n' };

test('NAS detection from file samples', async () => {
  assert.deepEqual(await detectNas(fakeRun({ files: unraidFiles }).run, { unraid: true }), { kind: 'unraid', version: '6.12.10' });
  assert.deepEqual(await detectNas(fakeRun({ files: { '/etc/synoinfo.conf': 'x=1', '/etc.defaults/VERSION': 'majorversion="7"\nproductversion="7.2.1"\n' } }).run, { synology: true }), { kind: 'synology', version: '7.2.1' });
  assert.deepEqual(await detectNas(fakeRun({ files: { '/etc/version': 'TrueNAS-SCALE 25.10.0\n', midclt: 1 } }).run), { kind: 'truenas', version: '25.10.0' });
  assert.equal(await detectNas(fakeRun({ files: { '/etc/version': 'TrueNAS-SCALE 25.10.0\n' } }).run), null, 'midclt is required');
  assert.equal(await detectNas(fakeRun({ files: { '/etc/synoinfo.conf': 'x' } }).run), null);
  assert.equal(await detectNas(fakeRun().run), null);
  assert.equal(parseUnraidVersion('version="6.12.10"; rm -rf /'), null);
  assert.equal(parseSynologyVersion('productversion="a b"'), null);
  assert.equal(parseTrueNasVersion('Debian'), null);
});

test('TrueNAS versions and Python versions', () => {
  assert.equal(trueNasSupported('24.10.2'), true); assert.equal(trueNasSupported('25.04'), true);
  assert.equal(trueNasSupported('24.04.2'), false); assert.equal(trueNasSupported('22.12'), false); assert.equal(trueNasSupported(null), false);
  assert.equal(pythonUsable([3, 9]), true); assert.equal(pythonUsable([3, 8]), false); assert.equal(pythonUsable(null), false);
});

test('staging base is on persistent storage', () => {
  assert.equal(chooseStagingBase('unraid', { cache: true }), '/mnt/cache/system/docknest');
  assert.equal(chooseStagingBase('unraid', {}), '/mnt/user/system/docknest');
  assert.equal(chooseStagingBase('synology', { volume: 'volume2' }), '/volume2/@docknest');
  assert.equal(chooseStagingBase('synology', { volume: '../x' }), '/volume1/@docknest');
  assert.equal(chooseStagingBase('truenas', { pools: ['.ix-apps', 'tank', 'a;b'] }), '/mnt/tank/.docknest');
  assert.equal(chooseStagingBase('truenas', { pools: [] }), null);
});

test('readiness: root on Unraid with Python uses the host runtime', async () => {
  const fake = fakeRun({ files: unraidFiles, python: '3 11', docker: '27.0.3', existing: ['/mnt/cache'] });
  const result = await checkNas({ run: fake.run, username: 'root', unraid: true });
  assert.equal(result.ready, true); assert.equal(result.helperRuntime, 'host'); assert.equal(result.identity, 'root');
  assert.equal(result.stagingBase, '/mnt/cache/system/docknest');
  assert.equal(result.checks.find(c => c.id === 'docker').status, 'warn');
  assert.equal(result.checks.find(c => c.id === 'key-persistence').status, 'ok');
});

test('readiness: sudo that needs a password fails closed with one fix and runs nothing as root', async () => {
  const fake = fakeRun({ files: { '/etc/version': 'TrueNAS-SCALE 25.10.0', midclt: 1 }, python: '3 11', docker: '28.0.1', sudoOk: false });
  const result = await checkNas({ run: fake.run, username: 'truenas_admin' });
  assert.equal(result.ready, false);
  const identity = result.checks.find(c => c.id === 'identity');
  assert.equal(identity.status, 'fail'); assert.equal(identity.passwordless, false); assert.match(identity.fix, /passwordless sudo/);
  assert.equal(result.checks.some(c => c.id === 'runtime'), false);
  assert.ok(fake.calls.filter(a => a[0] === 'sudo').every(a => a.join(' ') === 'sudo -n -- true'));
});

test('readiness: sudo user, passwordless, on TrueNAS', async () => {
  const fake = fakeRun({ files: { '/etc/version': 'TrueNAS-SCALE 25.10.0', midclt: 1 }, python: '3 11', docker: '28.0.1' });
  const result = await checkNas({ run: fake.run, username: 'truenas_admin' });
  assert.equal(result.ready, true); assert.equal(result.identity, 'sudo');
  assert.equal(result.stagingBase, '/mnt/tank/.docknest');
  assert.ok(fake.calls.some(a => a[0] === 'sudo' && a[3] === 'python3'));
});

test('readiness: old TrueNAS is refused, no-Python needs a pinned image, low space and lost keys are named', async () => {
  const old = await checkNas({ run: fakeRun({ files: { '/etc/version': 'TrueNAS-SCALE 24.04.2', midclt: 1 }, python: '3 11', docker: '27.0.0' }).run, username: 'root' });
  assert.equal(old.ready, false); assert.match(old.checks[0].message, /Kubernetes/);
  const noImage = await checkNas({ run: fakeRun({ files: unraidFiles, python: null, docker: '27.0.0' }).run, username: 'root' , unraid: true });
  assert.equal(noImage.checks.find(c => c.id === 'runtime').status, 'fail');
  const pinned = await checkNas({ run: fakeRun({ files: unraidFiles, python: '3 8', docker: '27.0.0', image: fakeId }).run, username: 'root', imageId: fakeId , unraid: true });
  assert.equal(pinned.helperRuntime, 'container'); assert.equal(pinned.checks.find(c => c.id === 'runtime').status, 'ok');
  const unloaded = await checkNas({ run: fakeRun({ files: unraidFiles, python: null, docker: '27.0.0' }).run, username: 'root', imageId: fakeId , unraid: true });
  assert.equal(unloaded.checks.find(c => c.id === 'runtime').status, 'warn');
  const tight = await checkNas({ run: fakeRun({ files: unraidFiles, python: '3 11', docker: '28.0.0', free: 1024 ** 3, authKeys: false }).run, username: 'root' , unraid: true });
  assert.equal(tight.checks.find(c => c.id === 'staging').status, 'fail');
  assert.equal(tight.checks.find(c => c.id === 'key-persistence').status, 'warn');
  assert.ok(tight.checks.find(c => c.id === 'hard-links'));
  const plain = await checkNas({ run: fakeRun().run, username: 'root' });
  assert.equal(plain.nas, null); assert.equal(plain.ready, false);
});

test('more system folders are denied and helper answers cannot set NAS facts', () => {
  for (const bad of ['/root', '/root/x', '/data', '/var/lib/docker', '/var/lib/docker/volumes', '/usr/bin', '/bin']) assert.throws(() => checkMountPath(bad), MountRefused, bad);
  assert.equal(checkMountPath('/var/lib/docknest'), '/var/lib/docknest');
  assert.deepEqual(withoutNasFacts({ uid: 0, nas: { kind: 'unraid' }, helperRuntime: 'container', stagingBase: '/x', sshIdentity: 'root', docker: '27' }), { uid: 0, docker: '27' });
});

test('TrueNAS version formats match the helper, and unreadable versions are refused', () => {
  for (const [text, version] of [['TrueNAS-SCALE-24.10.2', '24.10.2'], ['TrueNAS-SCALE 25.04', '25.04'], ['TrueNAS-25.10.0\n', '25.10.0'], ['25.04.1', '25.04.1']]) {
    assert.equal(parseTrueNasVersion(text), version, text); assert.equal(trueNasSupported(version), true);
  }
  assert.equal(parseTrueNasVersion('TrueNAS-SCALE-garbage'), 'unknown'); assert.equal(trueNasSupported('unknown'), false);
  assert.equal(parseTrueNasVersion('Debian 12.5'), null);
  assert.equal(trueNasSupported(parseTrueNasVersion('TrueNAS-SCALE-24.04.2')), false);
});
