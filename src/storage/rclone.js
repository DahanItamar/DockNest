// Cloud-drive and network-share adapter: the bundled `rclone` binary as a transport, one child process per operation
// (docs/cloud-drives.md). DockNest encrypts every package before it reaches any adapter, so rclone only ever moves
// ciphertext; its own crypt backend, daemon and mount are never used.
//  - Configuration: a temporary rclone.conf (mode 0600) in a private folder under DATA_DIR/tmp, passed with --config and
//    removed in a finally. Secrets never appear in arguments, rclone gets a minimal environment, and its stderr is parsed
//    for known failures and then dropped (rclone-errors.js).
//  - If rclone refreshed the OAuth token, the file is read back and the new token is sealed and saved.
//  - Operations on one destination run one at a time, so two refreshes never race.
//  - Publication keeps `.partial` + server-side move. syncFile is a check that the file exists: these providers have no
//    fsync; an upload counts as durable once rclone exits 0 and the size (and Drive's MD5) matches what was streamed.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat as statPath, writeFile } from 'node:fs/promises';
import { PassThrough, Writable } from 'node:stream';
import { config } from '../config.js';
import { RCLONE_MINIMUM } from './rclone-pin.js';
import { BACKENDS, backendLabel, classify, rcloneError } from './rclone-errors.js';
import { parseToken } from './rclone-input.js';
import { loadSecrets, saveToken, markReconnect } from './rclone-state.js';

export const scheme = 'rclone', label = 'Cloud drive';
// Rate limits and retries (docs/cloud-drives.md, "Rate limits").
const SAFE_FLAGS = ['--ask-password=false', '--tpslimit', '8', '--retries', '3', '--low-level-retries', '10', '--timeout', '5m', '--contimeout', '30s', '--log-level', 'ERROR', '--stats', '0'];
const MAX_OUTPUT = 16 * 1024 * 1024, MAX_STDERR = 64 * 1024;

// ---- confinement ------------------------------------------------------------------------------------------------------
const rootDir = options => options.root === '/' ? '' : options.root.replace(/\/+$/, '');
export function resolve(options, remote) {
  if (typeof remote !== 'string' || /[\u0000-\u001f\u007f\\]/.test(remote)) throw new Error('Backup path is outside managed cloud storage');
  const normalized = path.posix.resolve(remote);
  if (!normalized.startsWith(rootDir(options) + '/') || normalized === rootDir(options) + '/') throw new Error('Backup path is outside managed cloud storage');
  return normalized;
}
// "dn:" is the one remote in every generated config. An SMB share is the first path component of the remote.
const REMOTE = 'dn';
function remoteOf(options, value) {
  const share = options.backend === 'smb' ? options.settings?.share + '/' : '';
  return `${REMOTE}:${share}${value.replace(/^\/+/, '')}`;
}

// ---- configuration file -----------------------------------------------------------------------------------------------
const plain = value => {
  const text = String(value ?? '');
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error('A storage setting holds a control character');
  return text;
};
export function buildConfig(options, secrets) {
  const settings = options.settings ?? {}, lines = ['[' + REMOTE + ']'];
  const add = (key, value) => { if (value !== undefined && value !== null && value !== '') lines.push(`${key} = ${plain(value)}`); };
  const client = () => { add('client_id', secrets.clientId); add('client_secret', secrets.clientSecret); };
  const token = () => { if (secrets.token) add('token', JSON.stringify(secrets.token)); };
  switch (options.backend) {
    case 'drive': add('type', 'drive'); add('scope', 'drive.file'); add('use_trash', 'true'); client(); token(); break;
    case 'onedrive': add('type', 'onedrive'); add('drive_id', settings.driveId); add('drive_type', settings.driveType); client(); token(); break;
    case 'dropbox': add('type', 'dropbox'); client(); token(); break;
    case 'webdav': add('type', 'webdav'); add('url', settings.endpoint); add('vendor', settings.vendor || 'other'); add('user', secrets.username); add('pass', secrets.passwordObscured); break;
    case 'smb': add('type', 'smb'); add('host', settings.host); add('port', settings.port); add('domain', settings.domain); add('user', secrets.username); add('pass', secrets.passwordObscured); break;
    default: throw new Error('Unsupported cloud storage type');
  }
  return lines.join('\n') + '\n';
}
const tokenLine = text => { const match = /^token = (\{.*\})$/m.exec(text); return match ? match[1] : null; };

// ---- processes --------------------------------------------------------------------------------------------------------
function command(args) {
  const bin = config.rcloneBin;
  return bin.endsWith('.js') ? { cmd: process.execPath, args: [bin, ...args] } : { cmd: bin, args };
}
// No RCLONE_* and nothing else from the container's environment: a stray RCLONE_CONFIG_PASS or backend option cannot leak in.
export function childEnvironment(home) {
  const env = { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: home, LANG: 'C' };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}
const locks = new Map();
async function acquire(key) {
  const previous = locks.get(key) ?? Promise.resolve();
  let release;
  const mine = new Promise(resolveLock => { release = resolveLock; });
  const chain = previous.then(() => mine);
  locks.set(key, chain);
  await previous;
  return () => { release(); if (locks.get(key) === chain) locks.delete(key); };
}
const tempRoot = () => path.join(config.dataDir, 'tmp');
let swept = false;
async function sweepStale() {
  if (swept) return;
  swept = true;
  try {
    for (const name of await readdir(tempRoot())) {
      if (!name.startsWith('rclone-')) continue;
      const folder = path.join(tempRoot(), name);
      // Left by a crash: nothing in this process holds a folder older than an hour.
      try { if (Date.now() - (await statPath(folder)).mtimeMs > 3600_000) await rm(folder, { recursive: true, force: true }); } catch { /* gone */ }
    }
  } catch { /* no folder yet */ }
}
export async function privateFolder() {
  await sweepStale();
  await mkdir(tempRoot(), { recursive: true, mode: 0o700 });
  return mkdtemp(path.join(tempRoot(), 'rclone-'));
}
const secretsOf = options => (options.persist === false ? options.secrets : loadSecrets(options.id)) ?? options.secrets ?? {};

// Starts rclone with a fresh private config and holds the destination's lock until the process has ended and the folder is
// removed. Resolves { child, finished } where `finished` is { code, stderr, spawnFailed }.
async function launch(options, args, { input = false } = {}) {
  const release = await acquire(options.id ?? 'unsaved');
  let folder;
  try {
    folder = await privateFolder();
    const secrets = secretsOf(options), file = path.join(folder, 'rclone.conf');
    await writeFile(file, buildConfig(options, secrets), { mode: 0o600, flag: 'wx' });
    const { cmd, args: argv } = command([...args, '--config', file, ...SAFE_FLAGS]);
    const child = spawn(cmd, argv, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: childEnvironment(folder), windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => { if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8'); });
    const finished = new Promise(resolveRun => {
      let spawnFailed = false;
      child.once('error', () => { spawnFailed = true; resolveRun({ code: -1, stderr: '', spawnFailed }); });
      child.once('close', code => resolveRun({ code, stderr, spawnFailed }));
    }).then(async result => {
      try { await writeBack(options, file, secrets); } catch { /* the old token stays; the next operation refreshes again */ }
      try { await rm(folder, { recursive: true, force: true }); } finally { release(); }
      return result;
    });
    return { child, finished };
  } catch (error) {
    if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {});
    release();
    throw error;
  }
}
async function writeBack(options, file, before) {
  if (!before.token) return;
  const line = tokenLine(await readFile(file, 'utf8'));
  if (!line) return;
  const token = parseToken(line);
  if (token.access_token === before.token.access_token && token.refresh_token === before.token.refresh_token) return;
  if (options.persist === false) options.secrets = { ...options.secrets, token };
  else saveToken(options.id, token);
}
function failure(options, result) {
  if (result.spawnFailed) return Object.assign(new Error('rclone is not available in this DockNest, so cloud drives cannot be used. Install rclone or use the official image.'), { code: 'ERCLONEMISSING', reason: 'rclone_missing', status: 503, expose: true, publicCode: 'rclone_missing' });
  const info = classify(result.stderr, result.code, options.backend);
  if (info.needsReconnect && options.persist !== false) markReconnect(options.id);
  return rcloneError(info, { rcloneExit: result.code });
}
async function run(options, args, { input, stdin, limit = MAX_OUTPUT } = {}) {
  const { child, finished } = await launch(options, args, { input: stdin !== undefined || input });
  const chunks = []; let size = 0, overflow = false;
  child.stdout.on('data', chunk => { size += chunk.length; if (size > limit) { overflow = true; child.kill('SIGKILL'); } else chunks.push(chunk); });
  if (stdin !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
  const result = await finished;
  if (overflow) throw rcloneError({ reason: 'failed', message: `${backendLabel(options.backend)} returned more data than DockNest accepts.` });
  if (result.code !== 0) throw failure(options, result);
  return Buffer.concat(chunks).toString('utf8');
}

// ---- version ----------------------------------------------------------------------------------------------------------
let checkedVersion = null;
export async function version() {
  if (checkedVersion) return checkedVersion;
  const { cmd, args } = command(['version']);
  const text = await new Promise((resolveRun, reject) => {
    let output = '';
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], env: childEnvironment(tempRoot()), windowsHide: true });
    child.stdout.on('data', chunk => { if (output.length < 4096) output += chunk.toString('utf8'); });
    child.once('error', () => reject(Object.assign(new Error('rclone is not available in this DockNest, so cloud drives cannot be used. Install rclone or use the official image.'), { code: 'ERCLONEMISSING', reason: 'rclone_missing', status: 503, expose: true, publicCode: 'rclone_missing' })));
    child.once('close', () => resolveRun(output));
  });
  const match = /^rclone v(\d+)\.(\d+)\.(\d+)/m.exec(text);
  if (!match) throw Object.assign(new Error('The rclone program did not report a version DockNest understands.'), { status: 503, expose: true, publicCode: 'rclone_missing' });
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major < RCLONE_MINIMUM.major || (major === RCLONE_MINIMUM.major && minor < RCLONE_MINIMUM.minor)) {
    throw Object.assign(new Error(`rclone ${major}.${minor}.${patch} is older than the ${RCLONE_MINIMUM.major}.${RCLONE_MINIMUM.minor} DockNest needs. Use the official image or update rclone.`), { status: 503, expose: true, publicCode: 'rclone_old' });
  }
  return (checkedVersion = { major, minor, patch });
}
export const resetVersionCheck = () => { checkedVersion = null; };
// Hides a password as rclone stores it in a config file. `rclone obscure -` reads it from stdin, so it is never an argument.
export async function obscure(options, secret) {
  const { cmd, args } = command(['obscure', '-']);
  return new Promise((resolveRun, reject) => {
    let output = '';
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'], env: childEnvironment(tempRoot()), windowsHide: true });
    child.stdout.on('data', chunk => { if (output.length < 4096) output += chunk.toString('utf8'); });
    child.stdin.on('error', () => {});
    child.stdin.end(String(secret));
    child.once('error', () => reject(failure(options, { spawnFailed: true })));
    child.once('close', code => { const value = output.trim(); if (code === 0 && value && /^[A-Za-z0-9_-]+$/.test(value)) resolveRun(value); else reject(failure(options, { code, stderr: '' })); });
  });
}

// ---- operations -------------------------------------------------------------------------------------------------------
const baseName = value => value.slice(value.lastIndexOf('/') + 1), parentOf = value => value.slice(0, value.lastIndexOf('/')) || '/';
const attributes = item => {
  const size = Number(item.Size), mtime = new Date(item.ModTime || 0);
  if (!Number.isSafeInteger(size) || size < 0) throw rcloneError({ reason: 'failed', message: 'The storage provider did not report a valid file size.' });
  return { size, mtime, hashes: item.Hashes ?? {}, isFile: () => !item.IsDir, isDirectory: () => Boolean(item.IsDir), isSymbolicLink: () => false };
};
async function lsjson(options, value, extra = []) {
  const text = await run(options, ['lsjson', ...extra, remoteOf(options, value)]);
  try { return JSON.parse(text || 'null'); } catch { throw rcloneError({ reason: 'failed', message: `${backendLabel(options.backend)} gave an answer DockNest could not read.` }); }
}
export async function statFile(options, value, { hash = false } = {}) {
  const item = await lsjson(options, value, ['--stat', ...(hash ? ['--hash'] : [])]);
  if (!item || Array.isArray(item)) throw rcloneError({ reason: 'not_found', missing: true, message: `The file or folder is not on ${backendLabel(options.backend)}.` });
  if (item.IsDir) throw new Error('Backup path is not a file');
  return attributes(item);
}
const isMissing = error => error?.code === 'ENOENT';
// Google Drive allows two files with one name, so its listing is counted instead of trusting a single answer.
async function nameCount(options, value) {
  let items;
  try { items = await lsjson(options, parentOf(value), ['--files-only']); } catch (error) { if (isMissing(error)) return 0; throw error; }
  return (items ?? []).filter(item => item.Name === baseName(value)).length;
}
async function absent(options, value) {
  if (options.backend === 'drive') return (await nameCount(options, value)) === 0;
  try { await statFile(options, value); } catch (error) { if (isMissing(error)) return true; throw error; }
  return false;
}
async function assertSingle(options, value) {
  if (options.backend !== 'drive') return;
  const count = await nameCount(options, value);
  if (count > 1) throw Object.assign(new Error('Google Drive holds more than one file with this name. Remove the extra copies in Google Drive; DockNest will not guess which one is its own.'), { code: 'EDUPLICATE', status: 409, expose: true, publicCode: 'duplicate_name' });
}
export async function makeDirectory(options, value) { await run(options, ['mkdir', remoteOf(options, value)]); }
export async function syncFile(options, value) { await statFile(options, value); }

export async function openRead(options, value, { start, end } = {}) {
  if ((start !== undefined && (!Number.isSafeInteger(start) || start < 0)) || (end !== undefined && (!Number.isSafeInteger(end) || end < (start || 0)))) throw new Error('Invalid cloud storage read range');
  const range = [];
  if (start) range.push('--offset', String(start));
  if (end !== undefined) range.push('--count', String(end - (start || 0) + 1));
  const { child, finished } = await launch(options, ['cat', ...range, remoteOf(options, value)]);
  const output = new PassThrough();
  child.stdout.pipe(output, { end: false });
  finished.then(result => { if (result.code === 0) output.end(); else output.destroy(failure(options, result)); });
  output.once('close', () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return output;
}
// Streams to the temporary name with `rcat`. The name must be free first; afterwards the provider is asked for the size
// (and Drive's MD5) and both must match what was streamed.
export function openWrite(options, value) {
  let proc = null, written = 0, failed = null;
  const md5 = createHash('md5');
  return new Writable({
    highWaterMark: 1024 * 1024,
    construct(callback) {
      (async () => {
        if (!await absent(options, value)) throw Object.assign(new Error('Cloud storage destination object already exists'), { code: 'EEXIST' });
        proc = await launch(options, ['rcat', remoteOf(options, value)], { input: true });
        proc.child.stdout.resume();
        proc.child.stdin.on('error', error => { failed = error; });
        proc.finished.then(result => { if (result.code !== 0 && !this.destroyed) this.destroy(failure(options, result)); });
      })().then(() => callback(), callback);
    },
    write(chunk, _encoding, callback) {
      if (failed) return callback(failed);
      written += chunk.length; md5.update(chunk);
      if (proc.child.stdin.write(chunk)) callback(); else proc.child.stdin.once('drain', () => callback(failed));
    },
    final(callback) {
      (async () => {
        proc.child.stdin.end();
        const result = await proc.finished;
        if (result.code !== 0) throw failure(options, result);
        const attrs = await statFile(options, value, { hash: options.backend === 'drive' });
        if (attrs.size !== written) throw new Error('Cloud storage object size does not match the uploaded bytes');
        const reported = attrs.hashes.md5 ?? attrs.hashes.MD5;
        if (options.backend === 'drive' && reported && reported.toLowerCase() !== md5.digest('hex')) throw new Error('Cloud storage object checksum does not match the uploaded bytes');
      })().then(() => callback(), callback);
    },
    destroy(error, callback) {
      if (proc && proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill('SIGKILL');
      callback(error);
    },
  });
}
export async function renameFile(options, fromValue, toValue) {
  const source = await statFile(options, fromValue);
  if (!await absent(options, toValue)) throw Object.assign(new Error('Cloud storage destination object already exists'), { code: 'EEXIST' });
  await assertSingle(options, fromValue);
  await run(options, ['moveto', remoteOf(options, fromValue), remoteOf(options, toValue)]);
  await assertSingle(options, toValue);
  const published = await statFile(options, toValue);
  if (published.size !== source.size) throw new Error('Cloud storage published object size does not match the authenticated upload');
}
export async function removeFile(options, value) { await run(options, ['deletefile', remoteOf(options, value)]); }
export async function removeDirectory(options, value) {
  for (const name of ['payload.enc.partial', 'payload.enc']) { try { await removeFile(options, value + '/' + name); } catch (error) { if (!isMissing(error)) throw error; } }
  try { await run(options, ['rmdir', remoteOf(options, value)]); } catch (error) { if (!isMissing(error)) throw error; }
}
// Files below a managed directory, as storage values.
export async function list(options, value) {
  const items = await lsjson(options, value, ['--recursive', '--files-only']);
  return (items ?? []).map(item => ({ value: value.replace(/\/+$/, '') + '/' + item.Path, size: Number(item.Size) }));
}
export async function readiness(options) {
  await version();
  await makeDirectory(options, rootDir(options) || '/');
}
export async function test(options) {
  await readiness(options);
  const temporary = rootDir(options) + '/.docknest-probe-' + randomUUID(), published = temporary + '.verified', content = Buffer.from('DockNest storage probe');
  const read = async range => { const parts = []; for await (const chunk of await openRead(options, published, range)) parts.push(chunk); return Buffer.concat(parts).toString(); };
  try {
    await new Promise((resolveWrite, reject) => { const output = openWrite(options, temporary); output.once('error', reject).once('finish', resolveWrite); output.end(content); });
    if ((await statFile(options, temporary)).size !== content.length) throw new Error('Storage write verification failed');
    await renameFile(options, temporary, published);
    if (await read() !== content.toString()) throw new Error('Storage read verification failed');
    if (await read({ start: 9, end: 15 }) !== 'storage') throw new Error('Storage ranged read verification failed');
    await removeFile(options, published);
    if (!await absent(options, published)) throw new Error('Storage delete verification failed');
    return { connected: true, writeVerified: true, copyVerified: true, readVerified: true, rangeVerified: true, deleteVerified: true, duplicateCheck: options.backend === 'drive' };
  } finally {
    for (const value of [temporary, published]) { try { await removeFile(options, value); } catch (error) { if (!isMissing(error)) { /* cleanup is best effort after a failed probe */ } } }
  }
}

const readings = new Map();
// Free and total space as the provider reports it (`rclone about`); otherwise the size the owner typed; otherwise unbounded.
export async function capacity(options, { maxAgeMs = 0, managedBytes = 0 } = {}) {
  const cached = readings.get(options.id);
  let about = cached && Date.now() - cached.at < maxAgeMs ? cached.about : undefined;
  if (about === undefined) {
    try {
      const data = JSON.parse(await run(options, ['about', '--json', REMOTE + ':' + (options.backend === 'smb' ? options.settings?.share + '/' : '')]));
      about = Number.isFinite(data.total) && Number.isFinite(data.free) && data.total > 0 ? { total: Number(data.total), free: Number(data.free), used: Number.isFinite(data.used) ? Number(data.used) : null } : null;
    } catch { about = null; }
    readings.set(options.id, { at: Date.now(), about });
  }
  const common = { backend: 'rclone', cloud: options.backend, targetId: options.id, name: options.name || backendLabel(options.backend), managedBytes };
  if (about) return { ...common, used: about.used ?? about.total - about.free, total: about.total, available: about.free, capacitySource: 'provider', estimated: false };
  if (options.capacity > 0) return { ...common, used: managedBytes, total: options.capacity, available: Math.max(0, options.capacity - managedBytes), capacitySource: 'configured', estimated: true };
  return { ...common, used: managedBytes, total: null, available: null, unbounded: true, capacitySource: 'cloud-storage', estimated: false };
}
// Account name or e-mail the provider reports (`rclone config userinfo`), or null. Best effort: a failure is not a failed connect.
export async function account(options) {
  try {
    const data = JSON.parse(await run(options, ['config', 'userinfo', '--json', REMOTE + ':']));
    const value = data.email ?? data.user ?? data.name ?? data.display_name ?? null;
    return typeof value === 'string' && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
  } catch { return null; }
}
// OneDrive: the drives the signed-in account can use, for the short list shown after sign-in. [] when rclone cannot list them.
export async function drives(options) {
  try {
    const data = JSON.parse(await run(options, ['backend', 'drives', REMOTE + ':']));
    return (Array.isArray(data) ? data : []).filter(item => /^[A-Za-z0-9!_.-]{1,200}$/.test(String(item.id)))
      .map(item => ({ id: String(item.id), name: String(item.name ?? item.id).slice(0, 100), type: ['personal', 'business', 'documentLibrary'].includes(item.driveType) ? item.driveType : 'personal' }));
  } catch { return []; }
}
export { BACKENDS };
