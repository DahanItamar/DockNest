import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { HELPER_RUNTIME_IMAGE_ID, HELPER_RUNTIME_LABEL, HELPER_RUNTIME_TAR, HELPER_RUNTIME_TAR_SHA256, isPinnedImageId, isTarSha256 } from '../../shared/helper-runtime.js';
import { argvToCommand, sudoPrefix } from './command.js';

// Getting the helper runtime image onto a NAS (docs/nas-servers.md). The image tar ships inside the DockNest image, is
// checked against the SHA-256 pinned by the release build, streamed to `docker load` on the server over the same SSH
// connection, and the loaded image must have exactly the pinned image ID. Nothing is pulled from a registry and no tag
// is trusted: the server only ever runs the image by ID.
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
async function loadedId(run, lead, imageId) {
  const out = await run([...lead, 'docker', 'image', 'inspect', '--format', '{{.Id}}', imageId]).catch(() => ({ code: 1, stdout: '' }));
  return out.code === 0 && String(out.stdout).trim() === imageId;
}

// `run(argv)` resolves { code, stdout } (the NAS read-only runner); `client` is the open SSH connection.
export async function ensureRuntimeImage({ client, run, identity = 'root', imageId = HELPER_RUNTIME_IMAGE_ID, tarPath, tarSha256 } = {}) {
  if (!isPinnedImageId(imageId)) throw new RuntimeImageRefused('The helper runtime image is not pinned in this DockNest build.');
  const lead = identity === 'sudo' ? sudoPrefix() : [];
  if (await loadedId(run, lead, imageId)) return { loaded: false };
  await verifiedTar({ tarPath, tarSha256 });
  const code = await execWithInput(client, [...lead, 'docker', 'load'], createReadStream(tarPath ?? HELPER_RUNTIME_TAR));
  if (code !== 0) throw new RuntimeImageRefused('The server could not load the helper runtime image.');
  // The ID is a hash of the image's own configuration and layers, so a swapped or damaged tar cannot produce it.
  if (!(await loadedId(run, lead, imageId))) throw new RuntimeImageRefused('The loaded helper runtime image does not match the pinned ID.');
  await removeOldRuntimes(run, lead, imageId);
  return { loaded: true };
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
