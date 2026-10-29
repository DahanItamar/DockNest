// Recovery without DockNest (docs/incremental-backups.md): "Download chain" is a plain tar of the encrypted packages and
// ORDER.txt, and the recovery kit's decrypt tool checks every package and every link before it writes anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';

const temporary = await mkdtemp(join(tmpdir(), 'dbm-incremental-recovery-'));
Object.assign(process.env, { DATA_DIR: join(temporary, 'data'), BACKUP_DIR: temporary, MASTER_KEY_FILE: join(temporary, 'master.key'), BACKUP_STORAGE: 'local', NODE_ENV: 'test' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { encryptStream } = await import('../src/engine.js');
const { tarHeader, tarPadding, orderText, packageName } = await import('../src/incremental-routes.js');
const tool = new URL('../scripts/decrypt-backup.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const tar = entries => Buffer.concat([...entries.flatMap(([name, body]) => [tarHeader(name, body.length, 0), body, Buffer.alloc(tarPadding(body.length))]), Buffer.alloc(1024)]);

// A chain of `length` real packages (gzip tar with a sealed manifest.json), encrypted with the master key.
async function makeChain(directory, length, tamper = () => {}) {
  await mkdir(directory, { recursive: true });
  const chainId = randomUUID(), members = [];
  for (let index = 0; index < length; index++) {
    const previous = members[index - 1], id = randomUUID();
    const manifest = { formatVersion: 2, backupKind: index ? 'incremental' : 'full', chain: { id: chainId, position: index, parentBackupId: previous?.id ?? null, parentSha256: previous?.checksum ?? null } };
    tamper(index, manifest);
    const plain = gzipSync(tar([['images.tar', randomBytes(3000)], ['manifest.json', Buffer.from(JSON.stringify(manifest))], [`mount-0-0.tar`, randomBytes(700)]]));
    const file = join(directory, packageName(index, id));
    await encryptStream(Readable.from([plain]), createWriteStream(file));
    const bytes = await readFile(file);
    members.push({ id, checksum: sha(bytes), size: bytes.length, manifest: { chain: { ...manifest.chain, ...(index ? { parentBackupId: previous.id, parentSha256: previous.checksum } : {}) } }, link: { backup_kind: manifest.backupKind, chain_id: chainId }, plain });
  }
  await writeFile(join(directory, 'ORDER.txt'), orderText(members));
  return members;
}
const decrypt = (folder, output) => spawnSync(process.execPath, [tool, '--chain', folder, process.env.MASTER_KEY_FILE, output], { encoding: 'utf8' });
const brokenText = id => `This backup depends on backup ${id}, which is missing or damaged.`;

test('the decrypt tool checks a good chain and writes every package in restore order', async () => {
  const folder = join(temporary, 'good'), output = join(temporary, 'good-out'), members = await makeChain(folder, 3);
  const result = decrypt(folder, output);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 packages, every link matches/);
  const written = (await readdir(output)).filter(name => name !== 'CHAIN.json').sort();
  assert.deepEqual(written, members.map((member, index) => `${String(index + 1).padStart(2, '0')}-${member.id}.tar.gz`));
  for (const [index, name] of written.entries()) assert.deepEqual(await readFile(join(output, name)), members[index].plain);
  // CHAIN.json is what the kit's helper reads next (python3 helper.py restore-chain).
  assert.deepEqual(JSON.parse(await readFile(join(output, 'CHAIN.json'), 'utf8')), { formatVersion: 1, chainId: members[0].link.chain_id, packages: members.map((member, index) => ({ file: written[index], backupId: member.id, kind: index ? 'incremental' : 'full', sha256: member.checksum })) });
  assert.match(result.stdout, /python3 helper\.py restore-chain/);
  const order = await readFile(join(folder, 'ORDER.txt'), 'utf8');
  assert.match(order, /full backup first/); assert.match(order, /--listed-incremental=\/dev\/null/); assert.match(order, /helper\.py restore-chain/);
});
// Without DockNest and without ORDER.txt: a plain copy of the site's storage folder, as DockNest names the files.
const stored = (index, id) => `backup_2026-10-29T00-00-0${index}Z--${id}.tar.gz.enc`;
async function storageFolder(name, length, tamper) {
  const folder = join(temporary, name), members = await makeChain(folder, length, tamper);
  for (const [index, member] of members.entries()) await rename(join(folder, packageName(index, member.id)), join(folder, stored(index, member.id)));
  await rm(join(folder, 'ORDER.txt'));
  return { folder, members };
}
test('kit only: given the package to restore, the decrypt tool finds its chain from the sealed manifests in a storage folder', async () => {
  const { folder, members } = await storageFolder('storage', 3);
  // Another chain's package in the same folder is ignored.
  await storageFolder('storage-other', 1).then(async other => rename(join(other.folder, stored(0, other.members[0].id)), join(folder, stored(9, other.members[0].id))));
  const output = join(temporary, 'storage-out'), result = decrypt(join(folder, stored(2, members[2].id)), output);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 packages, every link matches/);
  const chain = JSON.parse(await readFile(join(output, 'CHAIN.json'), 'utf8'));
  assert.deepEqual(chain.packages.map(item => item.backupId), members.map(member => member.id), 'full backup first');
  assert.deepEqual(chain.packages.map(item => item.sha256), members.map(member => member.checksum));
  for (const [index, item] of chain.packages.entries()) assert.deepEqual(await readFile(join(output, item.file)), members[index].plain);
  assert.deepEqual((await readdir(output)).sort(), ['CHAIN.json', ...chain.packages.map(item => item.file)].sort(), 'no staging files are left');
  // The middle increment on its own: a chain of two.
  const shorter = decrypt(join(folder, stored(1, members[1].id)), join(temporary, 'storage-out-2'));
  assert.equal(shorter.status, 0, shorter.stderr); assert.match(shorter.stdout, /2 packages, every link matches/);
});
test('kit only: a missing or tampered parent and a package outside any chain are refused, and nothing is left behind', async () => {
  const missing = await storageFolder('storage-missing', 3);
  await rm(join(missing.folder, stored(1, missing.members[1].id)));
  let output = join(temporary, 'storage-missing-out'), result = decrypt(join(missing.folder, stored(2, missing.members[2].id)), output);
  assert.notEqual(result.status, 0); assert.match(result.stderr, new RegExp(brokenText(missing.members[1].id).replace(/[.()]/g, '\\$&')));
  assert.deepEqual(await readdir(output), [], 'nothing is left behind');
  // The full package was replaced by another file: its SHA-256 is not the one the increment recorded.
  const swapped = await storageFolder('storage-swapped', 2);
  const stranger = await storageFolder('storage-stranger', 1);
  await rename(join(stranger.folder, stored(0, stranger.members[0].id)), join(swapped.folder, stored(0, swapped.members[0].id)));
  output = join(temporary, 'storage-swapped-out'); result = decrypt(join(swapped.folder, stored(1, swapped.members[1].id)), output);
  assert.notEqual(result.status, 0); assert.match(result.stderr, new RegExp(brokenText(swapped.members[0].id).replace(/[.()]/g, '\\$&')));
  assert.deepEqual(await readdir(output), []);
  // A package that is not part of a chain.
  const plain = join(temporary, 'storage-plain'); await mkdir(plain);
  const id = randomUUID(), file = join(plain, stored(0, id));
  await encryptStream(Readable.from([gzipSync(tar([['manifest.json', Buffer.from(JSON.stringify({ formatVersion: 1 }))]]))]), createWriteStream(file));
  result = decrypt(file, join(temporary, 'storage-plain-out'));
  assert.notEqual(result.status, 0); assert.match(result.stderr, /not part of an incremental chain/);
});
test('the decrypt tool refuses a tampered sealed link, a reordered list and a missing package, and writes nothing', async () => {
  // The sealed manifest of the second increment names the wrong parent package.
  const folder = join(temporary, 'sealed'), output = join(temporary, 'sealed-out');
  const members = await makeChain(folder, 3, (index, manifest) => { if (index === 2) manifest.chain.parentSha256 = 'f'.repeat(64); });
  let result = decrypt(folder, output);
  assert.notEqual(result.status, 0); assert.match(result.stderr, new RegExp(brokenText(members[1].id).replace(/[.()]/g, '\\$&')));
  assert.deepEqual(await readdir(output), [], 'nothing is left behind');
  // Reordered ORDER.txt.
  const reordered = join(temporary, 'reordered'), list = await makeChain(reordered, 3), lines = (await readFile(join(reordered, 'ORDER.txt'), 'utf8')).split('\n');
  const rows = lines.map((line, index) => /^\d+ /.test(line) ? index : -1).filter(index => index >= 0);
  [lines[rows[1]], lines[rows[2]]] = [lines[rows[2]], lines[rows[1]]];
  await writeFile(join(reordered, 'ORDER.txt'), lines.join('\n'));
  result = decrypt(reordered, join(temporary, 'reordered-out'));
  assert.notEqual(result.status, 0); assert.match(result.stderr, /which is missing or damaged/);
  // A missing package.
  const missing = join(temporary, 'missing'), chain = await makeChain(missing, 2);
  await rm(join(missing, packageName(0, chain[0].id)));
  result = decrypt(missing, join(temporary, 'missing-out'));
  assert.notEqual(result.status, 0); assert.match(result.stderr, new RegExp(chain[0].id));
  assert.ok(list.length === 3);
  // ORDER.txt is not authenticated: an id that is not a plain id (path traversal) is refused before anything is read.
  const traversal = join(temporary, 'traversal'), items = await makeChain(traversal, 2), text = await readFile(join(traversal, 'ORDER.txt'), 'utf8');
  await writeFile(join(traversal, 'ORDER.txt'), text.replace(` ${items[1].id} `, ' ../../escape '));
  result = decrypt(traversal, join(temporary, 'traversal-out'));
  assert.notEqual(result.status, 0); assert.match(result.stderr, /invalid line/);
});
const python = ['python3', 'python'].find(command => { try { execFileSync(command, ['-c', 'import tarfile'], { stdio: 'ignore' }); return true; } catch { return false; } });
test('the chain download tar is a standard archive (read by Python tarfile), ORDER.txt first, packages unchanged', { skip: !python && 'python not available' }, async () => {
  const folder = join(temporary, 'archive'), members = await makeChain(folder, 2), order = orderText(members);
  const entries = [['ORDER.txt', order], ...await Promise.all(members.map(async (member, index) => [packageName(index, member.id), await readFile(join(folder, packageName(index, member.id)))]))];
  const archive = join(temporary, 'chain.tar'); await writeFile(archive, tar(entries));
  const listed = JSON.parse(execFileSync(python, ['-I', '-c', 'import json,sys,tarfile,hashlib\nwith tarfile.open(sys.argv[1]) as t:print(json.dumps([[m.name,m.size,hashlib.sha256(t.extractfile(m).read()).hexdigest()] for m in t.getmembers()]))', archive], { encoding: 'utf8' }));
  assert.deepEqual(listed, entries.map(([name, body]) => [name, body.length, sha(body)]));
  // Sizes past 8 GiB use the base-256 form.
  const big = tarHeader('big.enc', 9 * 1024 ** 3);
  assert.equal(big[124], 0x80); assert.equal(Number(big.subarray(128, 136).readBigUInt64BE()), 9 * 1024 ** 3);
  assert.ok(gunzipSync(members[0].plain).length > 0);
});
