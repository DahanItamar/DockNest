import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { HELPER_RUNTIME_LABEL, HELPER_RUNTIME_LAYERS, HELPER_RUNTIME_TAG, HELPER_RUNTIME_TAR, HELPER_RUNTIME_TAR_SHA256, isLayerList, isTarSha256, pinnedRuntimeIds } from '../../shared/helper-runtime.js';
import { argvToCommand, sudoPrefix } from './command.js';

// Getting the helper runtime image onto a NAS (docs/nas-servers.md). The image tar ships inside the DockNest image, is
// checked against the SHA-256 pinned by the release build, streamed to `docker load` on the server over the same SSH
// connection, and the loaded image must have exactly the pinned layers. Nothing is pulled from a registry and the tag is
// never trusted: the server runs the image by the immutable ID it reports for those layers.
export class RuntimeImageRefused extends Error { constructor(message) { super(message); this.name = 'RuntimeImageRefused'; } }
export const MAX_TAR_BYTES = 512 * 1024 * 1024;
const LOAD_TIMEOUT_MS = 10 * 60 * 1000;

export async function verifiedTar({ tarPath = HELPER_RUNTIME_TAR, tarSha256 = HELPER_RUNTIME_TAR_SHA256 } = {}) {
  if (!isTarSha256(tarSha256)) throw new RuntimeImageRefused('This DockNest build has no pinned helper runtime image.');
  let info;
  try { info = await stat(tarPath); } catch { throw new RuntimeImageRefused('The helper runtime image file is missing from this DockNest build.'); }
  if (!info.isFile() || info.size < 1 || info.size > MAX_TAR_BYTES) throw new RuntimeImageRefused('The helper runtime image file is not valid.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(tarPath)) hash.update(chunk);
  if (hash.digest('hex') !== tarSha256) throw new RuntimeImageRefused('The helper runtime image file does not match the pinned checksum.');
  return info.size;
}

// Runs one fixed argv with a stream as its stdin. The command is quoted by argvToCommand; output is capped and dropped.
export function execWithInput(client, argv, input, { timeoutMs = LOAD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    client.exec(argvToCommand(argv), { pty: false }, (error, stream) => {
      if (error) return reject(error);
      let done = false;
      const finish = (fn, value) => { if (!done) { done = true; clearTimeout(timer); fn(value); } };
      const timer = setTimeout(() => { try { stream.close(); } catch { /* already closed */ } finish(reject, new RuntimeImageRefused('Loading the helper runtime image timed out.')); }, timeoutMs);
      stream.on('data', () => {}); stream.stderr.on('data', () => {});
      stream.once('error', cause => finish(reject, cause));
      stream.once('close', code => finish(resolve, Number.isInteger(code) ? code : 1));
      pipeline(input, stream).catch(cause => finish(reject, cause));
    });
  });
}

const ID_LINE = /^sha256:[a-f0-9]{64}$/;
// What this server holds under the release tag: its own image ID and the image's layers. Layers are content hashes, equal
// on every Docker image store; the ID is store-specific (config digest or manifest digest), so it is read here, not pinned.
async function heldImage(run, lead, tag) {
  const out = await run([...lead, 'docker', 'image', 'inspect', '--format', '{{.Id}}|{{json .RootFS.Layers}}', tag]).catch(() => ({ code: 1, stdout: '' }));
  if (out.code !== 0) return null;
  const [id, layers] = String(out.stdout).trim().split('|');
  try { return ID_LINE.test(id) ? { id, layers: JSON.parse(layers) } : null; } catch { return null; }
}
const sameLayers = (a, b) => Array.isArray(a) && a.length === b.length && a.every((item, index) => item === b[index]);

// `run(argv)` resolves { code, stdout } (the NAS read-only runner); `client` is the open SSH connection. Resolves { runId, loaded }:
// the immutable ID the helper is run by on this server.
export async function ensureRuntimeImage({ client, run, identity = 'root', layers = HELPER_RUNTIME_LAYERS, tag = HELPER_RUNTIME_TAG, ids = pinnedRuntimeIds(), tarPath, tarSha256 } = {}) {
  if (!isLayerList(layers) || !ids.length) throw new RuntimeImageRefused('The helper runtime image is not pinned in this DockNest build.');
  // Same layers are not enough: the image's own ID (which covers its Entrypoint, User and Env) must be one of the pinned IDs too.
  const genuine = image => Boolean(image) && ids.includes(image.id) && sameLayers(image.layers, layers);
  const lead = identity === 'sudo' ? sudoPrefix() : [];
  const held = await heldImage(run, lead, tag);
  if (genuine(held)) return { runId: held.id, loaded: false };
  await verifiedTar({ tarPath, tarSha256 });
  const code = await execWithInput(client, [...lead, 'docker', 'load'], createReadStream(tarPath ?? HELPER_RUNTIME_TAR));
  if (code !== 0) throw new RuntimeImageRefused('The server could not load the helper runtime image.');
  // The layers are hashes of the image's own content, so a swapped or damaged tar cannot produce them.
  const loaded = await heldImage(run, lead, tag);
  if (!genuine(loaded)) throw new RuntimeImageRefused('The loaded helper runtime image does not match the pinned ID and layers.');
  await removeOldRuntimes(run, lead, loaded.id);
  return { runId: loaded.id, loaded: true };
}

// Older DockNest runtime images (the DockNest label, any other ID) are removed once the pinned one is verified.
export async function removeOldRuntimes(run, lead, imageId) {
  const listed = await run([...lead, 'docker', 'image', 'ls', '--no-trunc', '--filter', `label=${HELPER_RUNTIME_LABEL}`, '--format', '{{.ID}}']).catch(() => null);
  if (!listed || listed.code !== 0) return 0;
  const old = [...new Set(String(listed.stdout).split('\n').map(line => line.trim()).filter(line => ID_LINE.test(line) && line !== imageId))].slice(0, 10);
  let removed = 0;
  for (const id of old) { const out = await run([...lead, 'docker', 'image', 'rm', id]).catch(() => null); if (out?.code === 0) removed++; }
  return removed;
}
