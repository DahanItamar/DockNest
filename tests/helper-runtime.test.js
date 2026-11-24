import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { pinText, imageIdFromTar } from '../scripts/pin-helper-runtime.js';
import { ensureRuntimeImage, verifiedTar, removeOldRuntimes, RuntimeImageRefused } from '../src/nas/runtime-image.js';
import { computeRuntimeMounts, requestPaths } from '../src/nas/runtime-prepare.js';
import { MountRefused } from '../src/nas/mounts.js';
import { HELPER_RUNTIME_IMAGE_ID, HELPER_RUNTIME_TAR_SHA256 } from '../shared/helper-runtime.js';

// Fake values built at runtime: no hash literals in the repository.
const hex = seed => createHash('sha256').update(seed).digest('hex');
const imageId = 'sha256:' + hex('image'), otherId = 'sha256:' + hex('other'), oldId = 'sha256:' + hex('old');
const directory = await mkdtemp(join(tmpdir(), 'docknest-runtime-'));

test('the repository pins nothing: a source build refuses the container runtime', () => {
  assert.equal(HELPER_RUNTIME_IMAGE_ID, null); assert.equal(HELPER_RUNTIME_TAR_SHA256, null);
});

test('the pin script writes only valid values and only into the expected lines', async () => {
  const source = await readFile(new URL('../shared/helper-runtime.js', import.meta.url), 'utf8');
  const pinned = pinText(source, imageId, hex('tar'));
  assert.ok(pinned.includes(`export const HELPER_RUNTIME_IMAGE_ID = '${imageId}';`) && pinned.includes(`export const HELPER_RUNTIME_TAR_SHA256 = '${hex('tar')}';`));
  assert.equal(pinText(pinned, otherId, hex('tar2')).includes(imageId), false, 'pinning again replaces, never appends');
  for (const bad of ['docknest-helper-runtime:latest', 'sha256:' + 'A'.repeat(64), imageId + '\nexport const x = 1;', 'sha256:abc']) assert.throws(() => pinText(source, bad, hex('tar')), /image ID/);
  for (const bad of ['xyz', hex('tar').toUpperCase(), hex('tar') + '; rm']) assert.throws(() => pinText(source, imageId, bad), /checksum/);
  assert.throws(() => pinText('export const HELPER_RUNTIME_IMAGE_ID = 5;', imageId, hex('tar')), /not found/);
});

test('the image ID comes from the saved tar\'s manifest and exactly one image is accepted', async () => {
  const make = async (name, manifest) => {
    const root = await mkdtemp(join(directory, name + '-'));
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    const tarFile = join(root, 'image.tar');
    assert.equal(spawnSync('tar', ['-cf', 'image.tar', 'manifest.json'], { cwd: root }).status, 0);
    return tarFile;
  };
  assert.equal(imageIdFromTar(await make('a', [{ Config: `blobs/sha256/${hex('image')}`, Layers: [] }])), imageId);
  assert.equal(imageIdFromTar(await make('b', [{ Config: `${hex('image')}.json`, Layers: [] }])), imageId);
  const two = await make('c', [{ Config: `blobs/sha256/${hex('a')}` }, { Config: `blobs/sha256/${hex('b')}` }]), named = await make('d', [{ Config: 'latest' }]);
  assert.throws(() => imageIdFromTar(two), /exactly one/);
  assert.throws(() => imageIdFromTar(named), /SHA-256/);
});

// A fake server: images by ID, a client whose `docker load` reads the tar and then makes the image appear.
function fakeServer({ present = [], loadsAs = imageId, loadCode = 0, labelled = [] } = {}) {
  const images = new Set(present), calls = [];
  const run = async argv => {
    calls.push(argv);
    const a = argv[0] === 'sudo' ? argv.slice(3) : argv;
    if (a[1] === 'image' && a[2] === 'inspect') return images.has(a.at(-1)) ? { code: 0, stdout: a.at(-1) + '\n' } : { code: 1, stdout: '' };
    if (a[1] === 'image' && a[2] === 'ls') return { code: 0, stdout: [...labelled, 'not-an-id', '$(rm)'].join('\n') + '\n' };
    if (a[1] === 'image' && a[2] === 'rm') { images.delete(a[3]); return { code: 0, stdout: '' }; }
    return { code: 127, stdout: '' };
  };
  const client = { exec(command, _options, callback) {
    calls.push(['exec', command]);
    const stream = new PassThrough({ autoDestroy: false, emitClose: false }); stream.stderr = new PassThrough();
    stream.on('data', () => {});
    stream.on('finish', () => setImmediate(() => { if (loadCode === 0) images.add(loadsAs); stream.emit('close', loadCode); }));
    callback(null, stream);
  } };
  return { run, client, calls, images };
}
const tarFile = join(directory, 'helper-runtime.tar');
await writeFile(tarFile, 'fake image tar bytes');
const tarSha256 = hex('fake image tar bytes');

test('an already loaded image is used without sending anything', async () => {
  const server = fakeServer({ present: [imageId] });
  assert.deepEqual(await ensureRuntimeImage({ ...server, imageId, tarPath: tarFile, tarSha256 }), { loaded: false });
  assert.ok(!server.calls.some(call => call[0] === 'exec'));
});

test('a missing image is loaded from the checked tar over the connection, verified by ID and old runtimes are removed', async () => {
  const server = fakeServer({ labelled: [oldId, imageId, otherId] });
  const result = await ensureRuntimeImage({ ...server, identity: 'sudo', imageId, tarPath: tarFile, tarSha256 });
  assert.deepEqual(result, { loaded: true });
  const exec = server.calls.find(call => call[0] === 'exec')[1];
  assert.equal(exec, "'sudo' '-n' '--' 'docker' 'load'", 'one fixed argv, no shell string');
  assert.ok(server.images.has(imageId) && !server.images.has(oldId));
  const removed = server.calls.filter(call => call.includes('rm')).map(call => call.at(-1));
  assert.deepEqual(removed.sort(), [oldId, otherId].sort(), 'never the pinned image, never a non-ID line');
});

test('fail closed: wrong ID after load, failed load, unpinned build, damaged or missing tar', async () => {
  await assert.rejects(ensureRuntimeImage({ ...fakeServer({ loadsAs: otherId }), imageId, tarPath: tarFile, tarSha256 }), /does not match the pinned ID/);
  await assert.rejects(ensureRuntimeImage({ ...fakeServer({ loadCode: 1 }), imageId, tarPath: tarFile, tarSha256 }), /could not load/);
  await assert.rejects(ensureRuntimeImage({ ...fakeServer(), imageId: null, tarPath: tarFile, tarSha256 }), RuntimeImageRefused);
  await assert.rejects(ensureRuntimeImage({ ...fakeServer(), imageId: 'docknest-helper-runtime:latest', tarPath: tarFile, tarSha256 }), RuntimeImageRefused);
  const server = fakeServer();
  await assert.rejects(ensureRuntimeImage({ ...server, imageId, tarPath: tarFile, tarSha256: hex('different') }), /pinned checksum/);
  assert.ok(!server.calls.some(call => call[0] === 'exec'), 'a tar that fails the checksum is never sent');
  await assert.rejects(verifiedTar({ tarPath: join(directory, 'missing.tar'), tarSha256 }), /missing/);
  await assert.rejects(verifiedTar({ tarPath: tarFile, tarSha256: null }), /no pinned/);
});

test('old runtime removal only touches labelled image IDs other than the pinned one', async () => {
  const server = fakeServer({ present: [oldId, imageId], labelled: [oldId, imageId] });
  assert.equal(await removeOldRuntimes(server.run, [], imageId), 1);
  assert.ok(server.images.has(imageId) && !server.images.has(oldId));
});

// Mounts: computed from DockNest's own facts, the config and Docker's bind sources; never from anything else.
function mountRunner(binds, containers = []) {
  return async argv => {
    const a = argv[0] === 'sudo' ? argv.slice(3) : argv;
    if (a[1] === 'inspect') return { code: 0, stdout: binds.join('\n') + '\n' };
    if (a[1] === 'ps') return { code: 0, stdout: containers.join('\n') + '\n' };
    return { code: 127, stdout: '' };
  };
}
const nasServer = { id: 's1', username: 'admin', capabilities: JSON.stringify({ nas: { kind: 'truenas' }, helperRuntime: 'container', stagingBase: '/mnt/tank/.docknest' }) };

test('a backup call mounts the app folders and the staging base, and refuses a system folder as a whole', async () => {
  const request = { operation: 'capture', config: { containers: ['app-web-1'], stagingRoot: '/mnt/tank/.docknest', composeFiles: ['/mnt/tank/apps/app/compose.yaml'], configFiles: [] } };
  const mounts = await computeRuntimeMounts({ server: nasServer, request, run: mountRunner(['/mnt/tank/apps/app/data']), identity: 'sudo', nasKind: 'truenas' });
  assert.deepEqual(mounts, ['/mnt/tank/.docknest', '/mnt/tank/apps/app']);
  await assert.rejects(computeRuntimeMounts({ server: nasServer, request, run: mountRunner(['/etc/app']), identity: 'sudo', nasKind: 'truenas' }), MountRefused);
  await assert.rejects(computeRuntimeMounts({ server: nasServer, request: { ...request, config: { ...request.config, configFiles: ['/etc/app/.env'] } }, run: mountRunner([]), identity: 'sudo', nasKind: 'truenas' }), MountRefused);
  await assert.rejects(computeRuntimeMounts({ server: nasServer, request, run: async () => ({ code: 1, stdout: '' }), identity: 'sudo', nasKind: 'truenas' }), MountRefused, 'Docker failing means no guess');
});

test('a looking call skips what the deny-list refuses; names that are not container names are dropped', async () => {
  const mounts = await computeRuntimeMounts({ server: nasServer, request: { operation: 'discover' }, run: mountRunner(['/etc/nginx', '/mnt/tank/apps/a'], ['a'.repeat(64)]), identity: 'sudo', nasKind: 'truenas' });
  assert.deepEqual(mounts, ['/mnt/tank/.docknest', '/mnt/tank/apps/a']);
  const calls = [];
  await computeRuntimeMounts({ server: nasServer, request: { operation: 'capture', config: { containers: ['ok-1', '--all', 'a b', '$(x)'] } }, run: async argv => { calls.push(argv); return { code: 0, stdout: '' }; }, identity: 'root', nasKind: 'truenas' });
  assert.deepEqual(calls.find(call => call[1] === 'inspect').slice(-1), ['ok-1']);
  assert.deepEqual(requestPaths(nasServer, { stagingBase: '/mnt/tank/x', config: { composeFiles: ['/a/b/c.yml', 5] } }, { stagingBase: '/mnt/tank/.docknest' }).sort(), ['/a/b', '/mnt/tank/.docknest', '/mnt/tank/x'].sort());
  const unraid = await computeRuntimeMounts({ server: { id: 'u', capabilities: '{}' }, request: { operation: 'discover' }, run: mountRunner([]), identity: 'root', nasKind: 'unraid' });
  assert.deepEqual(unraid, ['/boot/config/plugins/dockerMan/templates-user']);
});
