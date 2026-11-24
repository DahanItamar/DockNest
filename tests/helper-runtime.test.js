import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { pinText, imageIdFromTar, layersFromTar } from '../scripts/pin-helper-runtime.js';
import { ensureRuntimeImage, verifiedTar, removeOldRuntimes, RuntimeImageRefused } from '../src/nas/runtime-image.js';
import { computeRuntimeMounts, requestPaths } from '../src/nas/runtime-prepare.js';
import { prepareHelper } from '../src/nas/run.js';
import { MountRefused } from '../src/nas/mounts.js';
import { HELPER_RUNTIME_IMAGE_ID, HELPER_RUNTIME_TAR_SHA256, HELPER_RUNTIME_LAYERS, HELPER_RUNTIME_TAG } from '../shared/helper-runtime.js';

// Fake values built at runtime: no hash literals in the repository.
const hex = seed => createHash('sha256').update(seed).digest('hex');
const sha = seed => 'sha256:' + hex(seed);
const imageId = sha('image'), runId = sha('server-id'), otherId = sha('other'), oldId = sha('old');
const layers = [sha('layer-1'), sha('layer-2')];
const directory = await mkdtemp(join(tmpdir(), 'docknest-runtime-'));

test('the repository pins nothing: a source build refuses the container runtime', () => {
  assert.equal(HELPER_RUNTIME_IMAGE_ID, null); assert.equal(HELPER_RUNTIME_TAR_SHA256, null); assert.equal(HELPER_RUNTIME_LAYERS, null);
});

test('the pin script writes only valid values and only into the expected lines', async () => {
  const source = await readFile(new URL('../shared/helper-runtime.js', import.meta.url), 'utf8');
  const pinned = pinText(source, imageId, hex('tar'), layers);
  assert.ok(pinned.includes(`export const HELPER_RUNTIME_IMAGE_ID = '${imageId}';`) && pinned.includes(`export const HELPER_RUNTIME_TAR_SHA256 = '${hex('tar')}';`));
  assert.ok(pinned.includes(`['${layers[0]}','${layers[1]}']`));
  assert.equal(pinText(pinned, otherId, hex('tar2'), [sha('x')]).includes(imageId), false, 'pinning again replaces, never appends');
  for (const bad of ['docknest-helper-runtime:latest', 'sha256:' + 'A'.repeat(64), imageId + '\nexport const x = 1;', 'sha256:abc']) assert.throws(() => pinText(source, bad, hex('tar'), layers), /image ID/);
  for (const bad of ['xyz', hex('tar').toUpperCase(), hex('tar') + '; rm']) assert.throws(() => pinText(source, imageId, bad, layers), /checksum/);
  for (const bad of [null, [], ['x'], [sha('a') + "'];process.exit(1);['"]]) assert.throws(() => pinText(source, imageId, hex('tar'), bad), /layers/);
  assert.throws(() => pinText('export const HELPER_RUNTIME_IMAGE_ID = 5;', imageId, hex('tar'), layers), /not found/);
});

async function makeTar(name, manifest, blobs = {}) {
  const root = await mkdtemp(join(directory, name + '-'));
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  const files = ['manifest.json'];
  for (const [file, content] of Object.entries(blobs)) { await writeFile(join(root, file), JSON.stringify(content)); files.push(file); }
  assert.equal(spawnSync('tar', ['-cf', 'image.tar', ...files], { cwd: root }).status, 0);
  return join(root, 'image.tar');
}
test('the image ID and layers come from the saved tar and exactly one image is accepted', async () => {
  assert.equal(imageIdFromTar(await makeTar('a', [{ Config: `blobs/sha256/${hex('image')}`, Layers: [] }])), imageId);
  assert.equal(imageIdFromTar(await makeTar('b', [{ Config: `${hex('image')}.json`, Layers: [] }])), imageId);
  const two = await makeTar('c', [{ Config: `blobs/sha256/${hex('a')}` }, { Config: `blobs/sha256/${hex('b')}` }]), named = await makeTar('d', [{ Config: 'latest' }]);
  assert.throws(() => imageIdFromTar(two), /exactly one/); assert.throws(() => imageIdFromTar(named), /SHA-256/);
  const config = `${hex('config')}.json`;
  assert.deepEqual(layersFromTar(await makeTar('e', [{ Config: config }], { [config]: { rootfs: { type: 'layers', diff_ids: layers } } })), layers);
  const bad = await makeTar('f', [{ Config: config }], { [config]: { rootfs: { diff_ids: ['bad'] } } });
  assert.throws(() => layersFromTar(bad), /layers/);
});

// A fake server: images by tag, a client whose `docker load` reads the tar and then makes the image appear under the tag.
function fakeServer({ held = null, loadsAs = { id: runId, layers }, loadCode = 0, labelled = [] } = {}) {
  const tags = new Map(held ? [[HELPER_RUNTIME_TAG, held]] : []), removed = [], calls = [];
  const run = async argv => {
    calls.push(argv);
    const a = argv[0] === 'sudo' ? argv.slice(3) : argv;
    if (a[1] === 'image' && a[2] === 'inspect') { const image = tags.get(a.at(-1)); return image ? { code: 0, stdout: `${image.id}|${JSON.stringify(image.layers)}\n` } : { code: 1, stdout: '' }; }
    if (a[1] === 'image' && a[2] === 'ls') return { code: 0, stdout: [...labelled, 'not-an-id', '$(rm)'].join('\n') + '\n' };
    if (a[1] === 'image' && a[2] === 'rm') { removed.push(a[3]); return { code: 0, stdout: '' }; }
    return { code: 127, stdout: '' };
  };
  const client = { exec(command, _options, callback) {
    calls.push(['exec', command]);
    const stream = new PassThrough({ autoDestroy: false, emitClose: false }); stream.stderr = new PassThrough();
    stream.on('data', () => {});
    stream.on('finish', () => setImmediate(() => { if (loadCode === 0) tags.set(HELPER_RUNTIME_TAG, loadsAs); stream.emit('close', loadCode); }));
    callback(null, stream);
  } };
  return { run, client, calls, tags, removed };
}
const tarFile = join(directory, 'helper-runtime.tar');
await writeFile(tarFile, 'fake image tar bytes');
const tarSha256 = hex('fake image tar bytes');
const pinnedArgs = { layers, tarPath: tarFile, tarSha256 };

test('an image already held with the pinned layers is used by the ID the server reports, with nothing sent', async () => {
  const server = fakeServer({ held: { id: runId, layers } });
  assert.deepEqual(await ensureRuntimeImage({ ...server, ...pinnedArgs }), { runId, loaded: false });
  assert.ok(!server.calls.some(call => call[0] === 'exec'));
});

test('a missing or different image is loaded from the checked tar, verified by layers, and old runtimes are removed', async () => {
  const server = fakeServer({ held: { id: otherId, layers: [sha('older')] }, labelled: [oldId, runId, otherId] });
  const result = await ensureRuntimeImage({ ...server, identity: 'sudo', ...pinnedArgs });
  assert.deepEqual(result, { runId, loaded: true });
  assert.equal(server.calls.find(call => call[0] === 'exec')[1], "'sudo' '-n' '--' 'docker' 'load'", 'one fixed argv, no shell string');
  assert.deepEqual(server.removed.sort(), [oldId, otherId].sort(), 'never the loaded image, never a non-ID line');
  assert.deepEqual(await ensureRuntimeImage({ ...fakeServer(), ...pinnedArgs }), { runId, loaded: true });
});

test('fail closed: wrong layers after load, failed load, unpinned build, damaged or missing tar', async () => {
  await assert.rejects(ensureRuntimeImage({ ...fakeServer({ loadsAs: { id: runId, layers: [sha('evil')] } }), ...pinnedArgs }), /does not match the pinned layers/);
  await assert.rejects(ensureRuntimeImage({ ...fakeServer({ loadCode: 1 }), ...pinnedArgs }), /could not load/);
  await assert.rejects(ensureRuntimeImage({ ...fakeServer(), ...pinnedArgs, layers: null }), RuntimeImageRefused);
  await assert.rejects(ensureRuntimeImage({ ...fakeServer(), ...pinnedArgs, layers: [] }), RuntimeImageRefused);
  const server = fakeServer();
  await assert.rejects(ensureRuntimeImage({ ...server, ...pinnedArgs, tarSha256: hex('different') }), /pinned checksum/);
  assert.ok(!server.calls.some(call => call[0] === 'exec'), 'a tar that fails the checksum is never sent');
  await assert.rejects(verifiedTar({ tarPath: join(directory, 'missing.tar'), tarSha256 }), /missing/);
  await assert.rejects(verifiedTar({ tarPath: tarFile, tarSha256: null }), /no pinned/);
});

test('old runtime removal only touches labelled image IDs other than the current one', async () => {
  const server = fakeServer({ labelled: [oldId, runId] });
  assert.equal(await removeOldRuntimes(server.run, [], runId), 1);
  assert.deepEqual(server.removed, [oldId]);
});

test('the helper is run by the server-reported ID; a source build or a bad ID is refused', () => {
  const server = { id: 's1', username: 'admin', capabilities: JSON.stringify({ nas: { kind: 'truenas' }, helperRuntime: 'container' }) };
  const prepared = prepareHelper(server, { operation: 'test' }, { runtimeMounts: ['/mnt/tank/.docknest'], runtimeImageId: runId });
  assert.ok(prepared.command.includes(`'${runId}'`) && !prepared.command.includes('sh -c'));
  assert.throws(() => prepareHelper(server, { operation: 'test' }, { runtimeMounts: [] }), /not pinned/, 'no ID, no pin: refused');
  assert.throws(() => prepareHelper(server, { operation: 'test' }, { runtimeMounts: [], runtimeImageId: 'docknest-helper-runtime:release' }), /not pinned/);
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
