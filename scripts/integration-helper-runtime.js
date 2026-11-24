import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// The helper runtime image (docs/nas-servers.md) loaded over SSH onto a real nested host: the tar is checked, streamed to
// `docker load`, verified by pinned ID and layers, found again without a second load, and a wrong checksum is refused before
// anything is sent. The loaded image then runs the way DockNest runs the helper: only the folders it was given, no network.
// Needs the tar made by scripts/build-helper-runtime.sh (HELPER_RUNTIME_TAR); without it the scenario is skipped and says so.
// Receives only the disposable nested hosts created by integration-linux; everything it creates is removed again.
export async function runHelperRuntimeScenario({ run, hosts, servers, record }) {
  const tarPath = process.env.HELPER_RUNTIME_TAR;
  if (!tarPath) { record('Helper runtime image over SSH: skipped (HELPER_RUNTIME_TAR is not set)'); return; }
  const [{ connect }, { sshRunner }, { ensureRuntimeImage }, { helperArgv }, pin] = await Promise.all([import('../src/ssh.js'), import('../src/nas/service.js'), import('../src/nas/runtime-image.js'), import('../src/nas/command.js'), import('./pin-helper-runtime.js')]);
  const { HELPER_RUNTIME_TAG: tag } = await import('../shared/helper-runtime.js');
  const layers = pin.layersFromTar(tarPath), ids = [pin.imageIdFromTar(tarPath), pin.manifestDigestFromTar(tarPath)];
  const tarSha256 = createHash('sha256').update(await readFile(tarPath)).digest('hex');
  const pinned = { layers, ids, tarPath, tarSha256 };
  const on = (...args) => run('exec', hosts[0], ...args);
  const present = () => on('docker', 'image', 'inspect', '--format', '{{.Id}}', tag).then(() => true, () => false);
  const folder = '/srv/qa-runtime', outside = '/srv/qa-runtime-outside';
  const client = await connect(servers[0]);
  try {
    const runner = sshRunner(client);
    await on('docker', 'image', 'rm', '-f', tag).catch(() => {});
    // Wrong checksum: refused, nothing sent, nothing loaded.
    await assert.rejects(ensureRuntimeImage({ client, run: runner, identity: 'root', ...pinned, tarSha256: '0'.repeat(64) }), /pinned checksum/);
    assert.equal(await present(), false, 'a tar that fails its checksum is never loaded');
    // Wrong pinned ID: the tar loads, the result does not match, and the call fails closed.
    await assert.rejects(ensureRuntimeImage({ client, run: runner, identity: 'root', ...pinned, ids: ['sha256:' + '1'.repeat(64)] }), /pinned ID and layers/);
    await on('docker', 'image', 'rm', '-f', tag).catch(() => {});
    const first = await ensureRuntimeImage({ client, run: runner, identity: 'root', ...pinned });
    assert.equal(first.loaded, true); assert.ok(ids.includes(first.runId), 'the server reports one of the pinned IDs');
    const second = await ensureRuntimeImage({ client, run: runner, identity: 'root', ...pinned });
    assert.deepEqual(second, { runId: first.runId, loaded: false }, 'a held image is used without loading again');
    // Run it as DockNest does: identity mounts of the given folder only, no network.
    await on('sh', '-c', 'mkdir -p "$1" "$2" && echo ok > "$1/marker" && echo hidden > "$2/secret"', 'setup', folder, outside);
    const argv = helperArgv({ runtime: 'container', operation: 'capture', mounts: [folder], imageId: first.runId, allowedIds: [first.runId] }).slice(0, -3);
    const seen = await on(...argv, 'python3', '-c', `import os,socket;print(os.path.exists('${folder}/marker'),os.path.exists('${outside}/secret'),len(socket.if_nameindex()))`);
    assert.equal(seen, 'True False 1', 'the helper sees its folder only and has no network interface but loopback');
    record('The helper runtime image is checked against its pinned checksum, loaded over SSH, verified by pinned ID and layers and found again without a second load; a bad checksum is refused before sending, and the container sees only its given folders with no network');
  } finally {
    client.end();
    await on('rm', '-rf', folder, outside).catch(() => {});
    await on('docker', 'image', 'rm', '-f', tag).catch(() => {});
  }
}
