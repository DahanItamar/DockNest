import { open, readFile, rename, rm, stat, mkdir, readdir } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve, join, basename, dirname } from 'node:path';
// Recovery kit tool: decrypts DockNest packages without DockNest. Standard library only.
//   node decrypt-backup.js <payload.enc> <master.key> <new-output.tar.gz>
//   node decrypt-backup.js --chain <chain folder with ORDER.txt> <master.key> <new empty output folder>
//   node decrypt-backup.js --chain <backup_...--ID.tar.gz.enc> <master.key> <new empty output folder>
// Chain mode (incremental backups, docs/incremental-backups.md) checks every file and every link before it writes a
// single package: each file's size and SHA-256, its AES-256-GCM tag, and inside each sealed manifest the chain id, the
// position and the parent's backup id and SHA-256. It then writes the decrypted packages in restore order, and
// CHAIN.json, which the bundled helper (python3 helper.py restore-chain) reads to rebuild the files.
// Given one package file instead of a folder (no DockNest, no ORDER.txt: a copy of the site's storage folder), the
// chain is found from the sealed manifests: each increment names its parent's backup ID, whose file is found by name in
// the same folder and must have the SHA-256 the increment recorded.
const usage = 'Usage: node decrypt-backup.js <payload.enc> <master.key> <new-output.tar.gz>\n       node decrypt-backup.js --chain <chain folder with ORDER.txt | the backup_...--ID.tar.gz.enc to restore> <master.key> <new empty output folder>';
// One backup ID pattern, as helper.py checks it (CHAIN_ID / CHAIN_PACKAGE_NAME), and its longest chain (MAX_CHAIN).
const BACKUP_ID = /^[A-Za-z0-9-]{1,64}$/, MAX_CHAIN = 31;
const broken = id => new Error(`This backup depends on backup ${id}, which is missing or damaged. Restore ${id}'s chain from an earlier point, or pick a full backup.`);
// The output folder must be new or empty; it is created private.
async function prepareOutput(output) {
  try { if ((await readdir(output)).length) throw new Error('The output folder must be new or empty.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(output, { recursive: true, mode: 0o700 });
}
const args = process.argv.slice(2), chainMode = args[0] === '--chain';
const [inputArg, keyArg, outputArg] = chainMode ? args.slice(1) : args;
if (!inputArg || !keyArg || !outputArg) { console.error(usage); process.exit(1); }
const key = Buffer.from((await readFile(resolve(keyArg), 'utf8')).trim(), 'base64');
if (key.length !== 32) throw new Error('Expected a base64-encoded 32-byte master key.');

async function envelope(input) {
  const size = (await stat(input)).size;
  if (size < 32) throw new Error('Truncated encrypted package.');
  const handle = await open(input, 'r'), header = Buffer.alloc(16), tag = Buffer.alloc(16);
  try { await handle.read(header, 0, 16, 0); await handle.read(tag, 0, 16, size - 16); } finally { await handle.close(); }
  if (header.subarray(0, 4).toString('ascii') !== 'DBM1') throw new Error('Unsupported payload format.');
  return { size, header, tag };
}
function decipherFor({ header, tag }) {
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(4));
  decipher.setAAD(header); decipher.setAuthTag(tag);
  return decipher;
}
async function decryptTo(input, output, sinks = []) {
  const info = await envelope(input);
  const partial = output + '.' + randomBytes(8).toString('hex') + '.partial';
  try {
    const file = createWriteStream(partial, { flags: 'wx', mode: 0o600 });
    const tee = new Writable({ write(chunk, _encoding, callback) { for (const sink of sinks) sink.update(chunk); if (file.write(chunk)) callback(); else file.once('drain', callback); }, final(callback) { file.end(callback); }, destroy(error, callback) { file.destroy(); callback(error); } });
    await pipeline(createReadStream(input, { start: 16, end: info.size - 17 }), decipherFor(info), tee);
    // Reserve the output first so an existing file cannot be overwritten.
    const reservation = await open(output, 'wx', 0o600);
    await reservation.close();
    try { await rename(partial, output); } catch (error) { await rm(output, { force: true }); throw error; }
  } catch (error) { await rm(partial, { force: true }); throw error; }
}

if (!chainMode) {
  const input = resolve(inputArg), output = resolve(outputArg);
  if (input === output) throw new Error('Output must differ from input.');
  await decryptTo(input, output);
  console.log('Authenticated package written: ' + output);
  console.log('Inspect the bundled manifest and restore guide before extracting or restoring.');
} else if ((await stat(resolve(inputArg))).isFile()) {
  await decryptFromPackage(resolve(inputArg), resolve(outputArg));
} else {
  await decryptChain(resolve(inputArg), resolve(outputArg));
}

// Reads manifest.json from a decrypted payload (.tar.gz) as it streams: tar headers are 512-byte blocks, entries are
// padded to 512 bytes, and pax ('x') or GNU ('L') records may carry a long name.
function manifestReader() {
  let buffer = Buffer.alloc(0), remaining = 0, padding = 0, capture = null, pending = null, done = false, manifest = null, nextName = null;
  const gunzip = createGunzip();
  const parse = new Writable({
    write(chunk, _encoding, callback) {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (!done) {
          if (remaining > 0) {
            const take = Math.min(remaining, buffer.length); if (!take) break;
            if (capture) capture.push(buffer.subarray(0, take));
            buffer = buffer.subarray(take); remaining -= take;
            if (remaining === 0 && capture) { const body = Buffer.concat(capture); capture = null; pending?.(body); pending = null; }
            continue;
          }
          if (padding > 0) { const take = Math.min(padding, buffer.length); if (!take) break; buffer = buffer.subarray(take); padding -= take; continue; }
          if (buffer.length < 512) break;
          const header = buffer.subarray(0, 512); buffer = buffer.subarray(512);
          if (header.every(byte => byte === 0)) { done = true; break; }
          const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
          const size = header[124] & 0x80 ? Number(header.subarray(125, 136).readBigUInt64BE(3)) : parseInt(field(124, 12).trim() || '0', 8);
          const type = String.fromCharCode(header[156] || 48), prefix = field(345, 155);
          const name = nextName ?? (prefix ? prefix + '/' : '') + field(0, 100); nextName = null;
          remaining = size; padding = (512 - (size % 512)) % 512;
          if (type === 'x' || type === 'L') {
            capture = [];
            pending = body => { const text = body.toString('utf8'); if (type === 'L') nextName = text.replace(/\0.*$/s, ''); else { const match = /\d+ path=([^\n]*)\n/.exec(text); if (match) nextName = match[1]; } };
          } else if (['manifest.json', './manifest.json'].includes(name) && size <= 16 * 1024 * 1024) {
            capture = []; pending = body => { manifest = JSON.parse(body.toString('utf8')); };
          }
          if (size === 0 && pending) { pending(Buffer.alloc(0)); pending = null; capture = null; }
        }
        callback();
      } catch (error) { callback(error); }
    },
  });
  gunzip.pipe(parse);
  return { update: chunk => gunzip.write(chunk), finish: () => new Promise((resolveFinish, reject) => { parse.once('finish', () => resolveFinish(manifest)); parse.once('error', reject); gunzip.once('error', reject); gunzip.end(); }) };
}

async function sha256File(file) { const hash = createHash('sha256'); await pipeline(createReadStream(file), new Writable({ write(chunk, _encoding, callback) { hash.update(chunk); callback(); } })); return hash.digest('hex'); }
async function decryptChain(folder, output) {
  const order = (await readFile(join(folder, 'ORDER.txt'), 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(line => /^\d+ \S+ (full|incremental) /.test(line)).map(line => {
    const [position, file, kind, backupId, sha256, size, parent, parentSha256] = line.split(' ');
    return { position: Number(position), file, kind, backupId, sha256, size: Number(size), parent, parentSha256 };
  });
  if (!order.length) throw new Error('ORDER.txt lists no backups.');
  // ORDER.txt is not authenticated: ids become file names, so only plain ids, hashes and sizes are accepted.
  for (const item of order) if (!BACKUP_ID.test(item.backupId) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || (item.parent !== '-' && !BACKUP_ID.test(item.parent))) throw new Error('ORDER.txt has an invalid line; it was not written by DockNest.');
  await prepareOutput(output);
  // 1. Every encrypted file: present, the listed size and SHA-256, and listed in order with matching parents.
  const actual = [];
  for (const [index, item] of order.entries()) {
    const file = join(folder, basename(item.file));
    if (item.position !== index || (index === 0) !== (item.kind === 'full')) throw broken(order[Math.max(0, index - 1)].backupId);
    let size, sha256;
    try { size = (await stat(file)).size; sha256 = await sha256File(file); } catch { throw broken(item.backupId); }
    if (size !== item.size || sha256 !== item.sha256) throw broken(item.backupId);
    if (index && (item.parent !== order[index - 1].backupId || item.parentSha256 !== actual[index - 1])) throw broken(order[index - 1].backupId);
    actual.push(sha256);
  }
  // 2. Decrypt each one (GCM-authenticated) and check the links inside its sealed manifest against the real files.
  let chainId = null;
  const written = [];
  try { await decryptMembers(); await writeChainFile(output, chainId, order.map((item, index) => ({ file: basename(written[index]), backupId: item.backupId, kind: item.kind, sha256: actual[index] }))); }
  catch (error) { for (const file of written) await rm(file, { force: true }); throw error; }
  report(chainId, written, output);
  async function decryptMembers() { for (const [index, item] of order.entries()) {
    const target = join(output, `${String(index + 1).padStart(2, '0')}-${item.backupId}.tar.gz`), reader = manifestReader();
    try { await decryptTo(join(folder, basename(item.file)), target, [reader]); } catch { throw broken(item.backupId); }
    written.push(target);
    const manifest = await reader.finish().catch(() => null), chain = manifest?.chain;
    if (manifest?.formatVersion !== 2 || manifest.backupKind !== item.kind || !chain || chain.position !== index) throw broken(item.backupId);
    chainId ??= chain.id;
    if (chain.id !== chainId) throw broken(order[index - 1].backupId);
    if (index === 0 ? chain.parentBackupId != null || chain.parentSha256 != null : chain.parentBackupId !== order[index - 1].backupId || chain.parentSha256 !== actual[index - 1]) throw broken(order[Math.max(0, index - 1)].backupId);
  } }
}

// CHAIN.json: the decrypted packages in restore order with each backup ID and encrypted SHA-256 (the parent links the
// sealed manifests name). The helper's restore-chain step checks those links again before it extracts anything.
async function writeChainFile(output, chainId, packages) {
  const handle = await open(join(output, 'CHAIN.json'), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ formatVersion: 1, chainId, packages }, null, 1) + '\n'); } finally { await handle.close(); }
}
function report(chainId, written, output) {
  console.log(`Chain ${chainId} verified: ${written.length} ${written.length === 1 ? 'package' : 'packages'}, every link matches.`);
  console.log('Restore in this order (full backup first):');
  for (const file of written) console.log('  ' + file);
  console.log(`Rebuild the files as root on Linux with GNU tar: python3 helper.py restore-chain ${output} <new empty folder>`);
}

// Without ORDER.txt: start at the package to restore and follow the parent links of the sealed manifests back to the
// full backup. Files are named backup_<time>--<backup ID>.tar.gz.enc (as DockNest stores them); the parent's file must
// be the only one with that ID in the folder and must have the SHA-256 its child recorded.
async function decryptFromPackage(file, output) {
  const idOf = name => { const match = /^backup_.+--([^/\\]+)\.tar\.gz\.enc$/.exec(name); return match && BACKUP_ID.test(match[1]) ? match[1] : null; };
  const folder = dirname(file), names = await readdir(folder);
  let id = idOf(basename(file));
  if (!id) throw new Error('Name the package as DockNest stored it: backup_<time>--<backup ID>.tar.gz.enc');
  await prepareOutput(output);
  const found = [], written = [];
  try {
    for (;;) {
      if (found.length >= MAX_CHAIN) throw broken(id);
      const child = found.at(-1);
      let sha256;
      try { sha256 = await sha256File(file); } catch { throw broken(id); }
      if (child && sha256 !== child.manifest.chain.parentSha256) throw broken(id);
      const staged = join(output, `.pending-${id}.tar.gz`), reader = manifestReader();
      try { await decryptTo(file, staged, [reader]); } catch { throw broken(id); }
      written.push(staged);
      const manifest = await reader.finish().catch(() => null), chain = manifest?.chain;
      if (!child && (manifest?.formatVersion !== 2 || !chain)) throw new Error('This package is not part of an incremental chain. Decrypt it alone: node decrypt-backup.js <payload.enc> <master.key> <new-output.tar.gz>');
      if (manifest?.formatVersion !== 2 || !['full', 'incremental'].includes(manifest.backupKind) || !chain || typeof chain.id !== 'string' || !Number.isInteger(chain.position)) throw broken(id);
      if (child && (chain.id !== child.manifest.chain.id || chain.position !== child.manifest.chain.position - 1)) throw broken(id);
      found.push({ id, file, sha256, manifest, staged });
      if (manifest.backupKind === 'full') {
        if (chain.position !== 0 || chain.parentBackupId != null || chain.parentSha256 != null) throw broken(id);
        break;
      }
      if (chain.position < 1 || typeof chain.parentBackupId !== 'string' || !/^[a-f0-9]{64}$/.test(String(chain.parentSha256))) throw broken(id);
      const parent = chain.parentBackupId, matches = names.filter(name => idOf(name) === parent);
      if (matches.length !== 1) throw broken(parent);
      id = parent; file = join(folder, matches[0]);
    }
    found.reverse();
    const finals = [];
    for (const [index, item] of found.entries()) {
      const target = join(output, `${String(index + 1).padStart(2, '0')}-${item.id}.tar.gz`);
      await rename(item.staged, target); written[written.indexOf(item.staged)] = target; finals.push(target);
    }
    await writeChainFile(output, found[0].manifest.chain.id, found.map((item, index) => ({ file: basename(finals[index]), backupId: item.id, kind: item.manifest.backupKind, sha256: item.sha256 })));
    report(found[0].manifest.chain.id, finals, output);
  } catch (error) { for (const staged of written) await rm(staged, { force: true }); throw error; }
}
