// A folder mounted into the DockNest container (a USB disk, a NAS share) as a backup destination.
// The folder must be inside a path listed in DOCKNEST_LOCAL_STORAGE, never inside DATA_DIR, and on a different disk than
// DATA_DIR unless the owner accepts the warning. Every path is resolved against the real folder, so a symbolic link cannot
// lead out of it. References are `folder:<targetId>:/path`, where the path is below the destination's root.
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, realpath, rename, rm, stat, statfs, open as openFile, access, constants } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { filesystemCapacity } from '../storage-capacity.js';

export const scheme = 'folder', label = 'Local folder';
const fail = (message, extra = {}) => Object.assign(new Error(message), { status: 400, expose: true, ...extra });
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };

// Validates a folder the owner typed. -> { path (real), sameDisk }. Throws a plain sentence.
export async function checkFolder(value) {
  if (!config.localStorage.length) throw fail('Mount a folder into DockNest first, and list its parent in DOCKNEST_LOCAL_STORAGE. See the cloud drives page.', { publicCode: 'folder_not_enabled' });
  const text = String(value ?? '');
  if (!path.isAbsolute(text) || /[\u0000-\u001f\u007f]/.test(text) || text.length > 500) throw fail('Enter the absolute path of the mounted folder.');
  let real;
  try { real = await realpath(text); } catch { throw fail('That folder does not exist inside DockNest. Mount it in compose.yaml and restart DockNest.', { publicCode: 'folder_missing' }); }
  const allowed = [];
  for (const entry of config.localStorage) { try { allowed.push(await realpath(entry)); } catch { /* not mounted */ } }
  if (!allowed.some(entry => inside(entry, real))) throw fail('That folder is not inside a path listed in DOCKNEST_LOCAL_STORAGE.', { publicCode: 'folder_not_allowed' });
  const data = await realpath(config.dataDir);
  if (inside(data, real) || inside(real, data)) throw fail('Choose a folder outside the DockNest data folder.', { publicCode: 'folder_in_data' });
  const attrs = await stat(real);
  if (!attrs.isDirectory()) throw fail('That path is not a folder.');
  await access(real, constants.R_OK | constants.W_OK).catch(() => { throw fail('DockNest cannot write to that folder. Check its permissions.', { publicCode: 'folder_readonly' }); });
  return { path: real, sameDisk: attrs.dev === (await stat(data)).dev };
}

const rootDir = options => options.root === '/' ? '' : options.root.replace(/\/+$/, '');
export function resolve(options, remote) {
  if (typeof remote !== 'string' || /[\u0000-\u001f\u007f\\]/.test(remote)) throw new Error('Backup path is outside managed folder storage');
  const normalized = path.posix.resolve(remote);
  if (!normalized.startsWith(rootDir(options) + '/') || normalized === rootDir(options) + '/') throw new Error('Backup path is outside managed folder storage');
  return normalized;
}
// The real file name for a value, after checking that the deepest existing part is still inside the destination folder.
async function place(options, value) {
  const base = await realpath(options.folder), target = path.join(base, ...value.split('/').filter(Boolean));
  let probe = target;
  for (;;) {
    try { const real = await realpath(probe); if (!inside(base, real)) throw new Error('Backup path is outside managed folder storage'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; const parent = path.dirname(probe); if (parent === probe) break; probe = parent; }
  }
  return target;
}
const syncDirectory = async directory => {
  if (process.platform === 'win32') return;
  const handle = await openFile(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
};
export async function readiness(options) { const attrs = await stat(await realpath(options.folder)); if (!attrs.isDirectory()) throw new Error('The folder is missing. Check that it is still mounted.'); }
export async function makeDirectory(options, value) { await mkdir(await place(options, value), { recursive: true, mode: 0o700 }); }
export async function statFile(options, value) { const attrs = await stat(await place(options, value)); if (!attrs.isFile()) throw new Error('Backup path is not a file'); return attrs; }
export async function openRead(options, value, { start, end } = {}) {
  if ((start !== undefined && (!Number.isSafeInteger(start) || start < 0)) || (end !== undefined && (!Number.isSafeInteger(end) || end < (start || 0)))) throw new Error('Invalid folder read range');
  return createReadStream(await place(options, value), { ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) });
}
export async function openWrite(options, value) {
  const file = await place(options, value);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  return createWriteStream(file, { flags: 'wx', mode: 0o600 });
}
export async function syncFile(options, value) {
  const file = await place(options, value), handle = await openFile(file, process.platform === 'win32' ? 'r+' : 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
}
export async function renameFile(options, fromValue, toValue) {
  const from = await place(options, fromValue), to = await place(options, toValue);
  if (await stat(to).then(() => true, () => false)) throw Object.assign(new Error('Folder destination object already exists'), { code: 'EEXIST' });
  await rename(from, to);
  await syncDirectory(path.dirname(to));
}
export async function removeFile(options, value) { const file = await place(options, value); await rm(file, { force: false }); await syncDirectory(path.dirname(file)); }
export async function removeDirectory(options, value) {
  const directory = await place(options, value);
  for (const name of ['payload.enc.partial', 'payload.enc']) await rm(path.join(directory, name), { force: true });
  await rm(directory, { recursive: false, force: true }).catch(error => { if (error.code !== 'ENOTEMPTY') throw error; });
}
export async function list(options, value) {
  const directory = await place(options, value), found = [];
  const walk = async (dir, prefix) => { for (const entry of await readdir(dir, { withFileTypes: true })) { if (entry.isDirectory()) await walk(path.join(dir, entry.name), prefix + entry.name + '/'); else if (entry.isFile()) found.push({ value: value.replace(/\/+$/, '') + '/' + prefix + entry.name, size: (await stat(path.join(dir, entry.name))).size }); } };
  await walk(directory, '');
  return found;
}
export async function test(options) {
  await readiness(options);
  const temporary = rootDir(options) + '/.docknest-probe-' + randomUUID(), published = temporary + '.verified', content = Buffer.from('DockNest storage probe');
  const read = async range => { const parts = []; for await (const chunk of await openRead(options, published, range)) parts.push(chunk); return Buffer.concat(parts).toString(); };
  try {
    await new Promise(async (resolveWrite, reject) => { try { const output = await openWrite(options, temporary); output.once('error', reject).once('finish', resolveWrite); output.end(content); } catch (error) { reject(error); } });
    await syncFile(options, temporary);
    await renameFile(options, temporary, published);
    if (await read() !== content.toString()) throw new Error('Storage read verification failed');
    if (await read({ start: 9, end: 15 }) !== 'storage') throw new Error('Storage ranged read verification failed');
    await removeFile(options, published);
    return { connected: true, writeVerified: true, copyVerified: true, readVerified: true, rangeVerified: true, deleteVerified: true };
  } finally { for (const value of [temporary, published]) await removeFile(options, value).catch(() => {}); }
}
export async function capacity(options, { managedBytes = 0 } = {}) {
  const value = await statfs(await realpath(options.folder));
  return { ...filesystemCapacity({ blockSize: value.bsize, blocks: value.blocks, free: value.bfree, available: value.bavail }), backend: 'folder', capacitySource: 'filesystem', estimated: false, targetId: options.id, name: options.name || 'Local folder', managedBytes };
}
