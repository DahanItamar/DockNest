import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

// A local-folder destination: a USB disk or NAS share mounted into the container, listed in DOCKNEST_LOCAL_STORAGE.
const root = await mkdtemp(join(tmpdir(), 'docknest-folder-')), mounts = await mkdtemp(join(tmpdir(), 'docknest-mounts-'));
const usb = join(mounts, 'usb'), disk = join(usb, 'disk1'), outside = join(mounts, 'outside');
for (const directory of [usb, disk, outside, join(root, 'inside-data')]) await mkdir(directory, { recursive: true });
Object.assign(process.env, { DATA_DIR: root, MASTER_KEY_FILE: join(root, 'master.key'), SETUP_TOKEN_FILE: join(root, 'setup.token'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured', SECURE_COOKIES: 'false', APP_ORIGIN: 'http://127.0.0.1:3000', DOCKNEST_LOCAL_STORAGE: usb });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js');
const { db, id } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const { config } = await import('../src/config.js');
const folder = await import('../src/storage/folder.js');
const storage = await import('../src/storage.js');
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`, csrf = 'fixture-csrf', at = new Date().toISOString();
after(async () => { server.close(); db.close(); await rm(root, { recursive: true, force: true }); await rm(mounts, { recursive: true, force: true }); });
function session(role) {
  const user = id(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(user, role + '@example.invalid', 'fixture', 'fixture', '[]', at, role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), user, csrf, Date.now() + 3600000, Date.now(), Date.now(), Date.now());
  return token;
}
const admin = session('admin'), operator = session('operator');
const post = (route, body, token = admin) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, 'x-csrf-token': csrf }, body: JSON.stringify(body) });
const readAll = async stream => { const parts = []; for await (const chunk of stream) parts.push(chunk); return Buffer.concat(parts); };

test('only a folder inside DOCKNEST_LOCAL_STORAGE, outside the data folder, is accepted', async () => {
  const good = await folder.checkFolder(disk);
  assert.equal(typeof good.sameDisk, 'boolean');
  for (const [value, code] of [[outside, 'folder_not_allowed'], [join(usb, 'missing'), 'folder_missing'], [join(root, 'inside-data'), 'folder_not_allowed'], ['relative/path', undefined], ['', undefined], [root, 'folder_not_allowed']]) {
    await assert.rejects(folder.checkFolder(value), error => error.status === 400 && (code === undefined || error.publicCode === code), String(value));
  }
  // A listed folder that sits inside DATA_DIR is refused too.
  const saved = config.localStorage; config.localStorage = [root];
  try { await assert.rejects(folder.checkFolder(join(root, 'inside-data')), error => error.publicCode === 'folder_in_data'); } finally { config.localStorage = saved; }
  // Without the setting nothing is accepted and the sentence says what to do.
  config.localStorage = [];
  try { await assert.rejects(folder.checkFolder(disk), error => error.publicCode === 'folder_not_enabled' && /DOCKNEST_LOCAL_STORAGE/.test(error.message)); } finally { config.localStorage = saved; }
  // A symbolic link out of the allowed path does not pass as a folder inside it.
  const link = join(usb, 'escape');
  await symlink(outside, link, 'junction');
  await assert.rejects(folder.checkFolder(link), error => error.publicCode === 'folder_not_allowed');
  await rm(link, { recursive: true, force: true });
});

test('the destination is created through the API; a folder on the same disk as DockNest needs an explicit yes', async () => {
  assert.equal((await post('/storage-targets/local/connect', { name: 'USB', path: disk, root: 'docknest' }, operator)).status, 403);
  const first = await post('/storage-targets/local/connect', { name: 'USB', path: disk, root: 'docknest' });
  const warned = first.status === 409;
  if (warned) { const body = await first.json(); assert.equal(body.code, 'same_disk'); assert.match(body.error, /same disk as DockNest/); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM storage_targets WHERE auth_type='local'").get().n, 0); }
  const created = warned ? await post('/storage-targets/local/connect', { name: 'USB', path: disk, root: 'docknest', acceptSameDisk: true }) : first;
  assert.equal(created.status, 201);
  const view = await created.json(), row = db.prepare('SELECT * FROM storage_targets WHERE id=?').get(view.id);
  assert.equal(row.auth_type, 'local'); assert.equal(view.kind, 'local'); assert.equal(view.root, '/docknest'); assert.equal(view.connected, true); assert.equal(view.hasCredential, false);
  assert.equal(storage.targetMode(row), 'folder');
  assert.deepEqual(await readdir(join(disk, 'docknest')), [], 'the probe left nothing behind');
  for (const bad of [{ path: outside }, { path: 'relative' }, { path: disk, root: '../x' }]) assert.equal((await post('/storage-targets/local/connect', { name: 'X', root: '', acceptSameDisk: true, ...bad })).status, 400, JSON.stringify(bad));
  const listed = await (await fetch(base + '/storage-targets', { headers: { Cookie: 'dbm_session=' + admin } })).json();
  assert.equal(listed.targets.find(item => item.id === view.id).kind, 'local');
});

test('the facade publishes, reads, renames and deletes inside the folder and nothing leaves it', async () => {
  const targetId = db.prepare("SELECT id FROM storage_targets WHERE auth_type='local'").get().id;
  const options = storage.targetOptions(targetId), prefix = storage.targetPrefix(options), published = prefix + '/docknest/site/pkg.enc';
  assert.equal(options.mode, 'folder');
  const content = randomBytes(5000), source = join(root, 'package.bin'), sha = createHash('sha256').update(content).digest('hex');
  await writeFile(source, content);
  await storage.publishVerified(source, published, sha);
  assert.ok((await readFile(join(disk, 'docknest', 'site', 'pkg.enc'))).equals(content));
  assert.ok((await readAll(await storage.openRead(published, { start: 100, end: 199 }))).equals(content.subarray(100, 200)));
  await assert.rejects(storage.publishVerified(source, published, sha), error => error.code === 'EEXIST');
  assert.equal((await storage.storageCapacity({ options })).backend, 'folder');
  assert.equal((await storage.statFile(published)).size, 5000);
  // Confinement: values outside the destination root, and a link that leads out of the folder.
  for (const value of ['/docknest', '/other/x', '/docknest/../x', '/docknest/a\\b']) assert.throws(() => folder.resolve(options, value), /outside managed/, value);
  await symlink(outside, join(disk, 'docknest', 'link'), 'junction');
  await writeFile(join(outside, 'secret.txt'), 'outside');
  await assert.rejects(folder.openRead(options, '/docknest/link/secret.txt'), /outside managed/);
  await assert.rejects(folder.openWrite(options, '/docknest/link/new.enc'), /outside managed/);
  assert.deepEqual(await readdir(outside), ['secret.txt'], 'nothing was written outside the folder');
  await rm(join(disk, 'docknest', 'link'), { recursive: true, force: true });
  await storage.removeFile(published);
  await assert.rejects(storage.statFile(published), error => error.code === 'ENOENT');
  assert.equal(db.prepare('SELECT 1 FROM storage_targets WHERE id=?').get(targetId) !== undefined, true);
});
