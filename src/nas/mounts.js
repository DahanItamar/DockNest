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

// paths: absolute host paths, or { src, dst } when the folder is mounted from its resolved location (src) at the path the helper
// uses (dst), so a link swapped in after the check cannot change what is mounted. Returns sorted, de-duplicated entries with
// nested ones removed; an entry whose src equals its dst stays a plain string.
export function computeMounts(paths, options = {}) {
  if (!Array.isArray(paths)) throw new MountRefused('The helper runtime needs a list of folders.');
  const entries = paths.map(item => {
    const src = checkMountPath(typeof item === 'string' ? item : item?.src, options), dst = checkMountPath(typeof item === 'string' ? item : item?.dst, options);
    return { src, dst };
  });
  const unique = [...new Map(entries.map(entry => [entry.dst, entry])).values()].sort((a, b) => (a.dst < b.dst ? -1 : a.dst > b.dst ? 1 : 0));
  // A nested folder is already inside its parent only when it is the same place inside the parent's source.
  const covered = (entry, other) => entry !== other && within(entry.dst, other.dst) && entry.src === other.src + entry.dst.slice(other.dst.length);
  const result = unique.filter(entry => !unique.some(other => covered(entry, other))).map(entry => (entry.src === entry.dst ? entry.dst : entry));
  if (result.length > MAX_MOUNTS) throw new MountRefused('Too many folders for the helper runtime.');
  return result;
}
export const mountArguments = mounts => mounts.flatMap(item => { const src = typeof item === 'string' ? item : item.src, dst = typeof item === 'string' ? item : item.dst; return ['--mount', `type=bind,src=${src},dst=${dst},bind-propagation=rslave`]; });
