import { HELPER_RUNTIME_IMAGE_ID, isPinnedImageId } from '../../shared/helper-runtime.js';
import { detectNas, looksLikeSynology, dockerFacts, pythonFacts, pythonUsable, stagingFacts, trueNasSupported, TRUENAS_TOO_OLD } from './detect.js';
import { sudoPrefix } from './command.js';
import { SYNOLOGY_INFO } from './synology-gate.js';

// Readiness for a NAS server (backend only). `run(argv)` runs one fixed argv as the SSH user and resolves
// { code, stdout }; `runAsRoot(argv)` runs it with `sudo -n --` (or directly for root). Each failed check names one fix.
export const MIN_STAGING_FREE = 2 * 1024 ** 3;
const ok = (id, message, extra = {}) => ({ id, status: 'ok', message, ...extra });
const warn = (id, message, fix, extra = {}) => ({ id, status: 'warn', message, fix, ...extra });
const fail = (id, message, fix, extra = {}) => ({ id, status: 'fail', message, fix, ...extra });

export const SUDO_FIX = 'Give this user passwordless sudo (a NOPASSWD rule for it), or connect as root.';

export async function checkNas({ run, username = 'root', imageId = HELPER_RUNTIME_IMAGE_ID, synology = false }) {
  const checks = [];
  const nas = await detectNas(run, { synology });
  if (!nas && !synology && await looksLikeSynology(run)) return { nas: null, synologyOff: true, ready: false, checks: [warn('synology', SYNOLOGY_INFO, 'Connect it as a normal Linux server with a root SSH key.')] };
  if (!nas) return { nas: null, ready: false, checks: [fail('nas', 'This server is not a Unraid or TrueNAS system.', 'Add it as a regular Linux server with a root SSH key.')] };
  const identity = username === 'root' ? 'root' : 'sudo';
  const runAsRoot = identity === 'root' ? run : argv => run([...sudoPrefix(), ...argv]);

  if (nas.kind === 'truenas' && nas.version && !trueNasSupported(nas.version)) checks.push(fail('nas-version', TRUENAS_TOO_OLD, 'Update TrueNAS to 24.10 or newer.'));
  else checks.push(ok('nas-version', `${nas.kind} ${nas.version ?? ''}`.trim()));

  // Fail closed: if sudo needs a password, nothing else runs as root.
  if (identity === 'sudo') {
    const sudo = await run([...sudoPrefix(), 'true']).catch(() => ({ code: 1 }));
    if (sudo.code !== 0) {
      checks.push(fail('identity', `${username} cannot run sudo without a password.`, SUDO_FIX, { identity, passwordless: false }));
      return { nas, identity, ready: false, checks };
    }
    checks.push(ok('identity', `${username} uses sudo without a password.`, { identity, passwordless: true }));
  } else checks.push(ok('identity', 'Connected as root.', { identity }));

  const python = await pythonFacts(runAsRoot);
  const docker = await dockerFacts(runAsRoot);
  let helperRuntime = null;
  if (pythonUsable(python)) { helperRuntime = 'host'; checks.push(ok('runtime', `Python ${python.join('.')} on the server.`, { helperRuntime })); }
  else if (!docker) checks.push(fail('runtime', 'The server has no usable Python and no Docker.', 'Install or start Docker first.'));
  else if (!isPinnedImageId(imageId)) checks.push(fail('runtime', 'This DockNest build has no helper runtime image.', 'Update DockNest to a release that includes the helper runtime.'));
  else {
    const image = await runAsRoot([docker.binary, 'image', 'inspect', '--format', '{{.Id}}', imageId]).catch(() => ({ code: 1, stdout: '' }));
    helperRuntime = 'container';
    checks.push(image.code === 0 && String(image.stdout).trim() === imageId ? ok('runtime', 'The helper runtime image is loaded.', { helperRuntime }) : warn('runtime', 'The helper runtime image will be loaded on the first connection.', 'Nothing to do.', { helperRuntime }));
  }

  if (!docker) checks.push(fail('docker', 'Docker was not found.', 'Install or start Docker on the server.'));
  else checks.push(docker.major < 20 ? fail('docker', `Docker ${docker.text} is too old.`, 'Update Docker to 20.10 or newer.') : docker.major < 28 ? warn('docker', `Docker ${docker.text}: features that need Docker 28 are refused.`, 'Update Docker to 28 or newer to use them.') : ok('docker', `Docker ${docker.text}`));

  const stagingBase = await stagingFacts(run, nas.kind);
  if (!stagingBase) checks.push(fail('staging', 'DockNest found no storage pool for its working folder.', 'Create a pool or volume first.'));
  else {
    const probe = await runAsRoot(['df', '-Pk', '--', stagingBase.split('/').slice(0, 3).join('/')]).catch(() => ({ code: 1, stdout: '' }));
    const free = Number(String(probe.stdout).trim().split('\n').pop()?.trim().split(/\s+/)[3]) * 1024;
    if (probe.code !== 0 || !Number.isFinite(free)) checks.push(fail('staging', `${stagingBase} could not be checked.`, 'Make sure the storage pool is online.', { stagingBase }));
    else if (free < MIN_STAGING_FREE) checks.push(fail('staging', `${stagingBase} has too little free space.`, 'Free at least 2 GB on that pool.', { stagingBase, freeBytes: free }));
    else checks.push(ok('staging', `${stagingBase} is on persistent storage.`, { stagingBase, freeBytes: free }));
    if (nas.kind === 'unraid' && stagingBase.startsWith('/mnt/user/')) checks.push(warn('hard-links', '/mnt/user is a union of disks; hard links across disks are not kept.', 'Use a /mnt/cache path when you have a cache pool.'));
  }
  if (nas.kind === 'unraid' && identity === 'root') {
    const kept = await run(['test', '-s', '/boot/config/ssh/root/authorized_keys']).catch(() => ({ code: 1 }));
    checks.push(kept.code === 0 ? ok('key-persistence', 'The SSH key survives a reboot.') : warn('key-persistence', 'The SSH key may be lost on reboot (Unraid keeps /root in RAM).', 'Add the key to /boot/config/ssh/root/authorized_keys.'));
  }
  const ready = !checks.some(check => check.status === 'fail');
  return { nas, identity, helperRuntime, stagingBase, ready, checks };
}

// What goes into the server capabilities JSON. Facts only; nothing secret.
export const capabilityFacts = result => result?.nas ? { nas: result.nas, helperRuntime: result.helperRuntime ?? null, stagingBase: result.stagingBase ?? null, sshIdentity: result.identity ?? null } : {};
// These keys come only from the NAS readiness check; a helper answer can never set them.
export const NAS_FACT_KEYS = Object.freeze(['nas', 'helperRuntime', 'stagingBase', 'sshIdentity']);
export const withoutNasFacts = value => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !NAS_FACT_KEYS.includes(key)));
