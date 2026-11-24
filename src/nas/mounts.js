import { posix } from 'node:path';

// Bind mounts for the helper runtime container. DockNest computes them from stored facts (the app's mounts, the Docker
// root directory, the staging base); a request can never add one. Each is mounted at the same path inside, so the
// helper sees host paths unchanged. Anything unusual is refused, never repaired.
export class MountRefused extends Error { constructor(message) { super(message); this.name = 'MountRefused'; } }
export const MAX_MOUNTS = 64;
// Letters, digits and a few path characters. A comma would add options to --mount, so it is refused with quotes,
// backslashes, dollar signs, backticks and control characters.
const SAFE_PATH = /^\/[\p{L}\p{N}._@+=: ~/-]*$/u;
const DENIED = ['/proc', '/sys', '/dev', '/etc', '/run', '/var/run', '/root', '/data', '/var/lib/docker', '/usr', '/bin', '/boot/config/ssh'];
export const UNRAID_TEMPLATES = '/boot/config/plugins/dockerMan/templates-user';

function within(path, base) { return path === base || path.startsWith(base + '/'); }

export function checkMountPath(value, { nasKind = null } = {}) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 1024 || !SAFE_PATH.test(value)) throw new MountRefused('A folder path is not valid for the helper runtime.');
  const parts = value.split('/');
  if (parts.includes('..') || parts.includes('.')) throw new MountRefused('A folder path is not valid for the helper runtime.');
  const path = posix.normalize(value).replace(/\/+$/, '') || '/';
  if (path === '/') throw new MountRefused('The whole server cannot be mounted into the helper runtime.');
  if (within(path, '/boot')) {
    if (nasKind === 'unraid' && within(path, UNRAID_TEMPLATES)) return path;
    throw new MountRefused('/boot cannot be mounted into the helper runtime.');
  }
  if (DENIED.some(base => within(path, base))) throw new MountRefused('A system folder cannot be mounted into the helper runtime.');
  return path;
}

// paths: array of absolute host paths. Returns sorted, de-duplicated paths with nested ones removed.
export function computeMounts(paths, options = {}) {
  if (!Array.isArray(paths)) throw new MountRefused('The helper runtime needs a list of folders.');
  const checked = [...new Set(paths.map(path => checkMountPath(path, options)))].sort();
  const result = checked.filter((path, index) => !checked.some((other, at) => at !== index && within(path, other)));
  if (result.length > MAX_MOUNTS) throw new MountRefused('Too many folders for the helper runtime.');
  return result;
}
export const mountArguments = mounts => mounts.flatMap(path => ['--mount', `type=bind,src=${path},dst=${path},bind-propagation=rslave`]);
