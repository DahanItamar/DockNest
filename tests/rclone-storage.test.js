import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, copyFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// The rclone binary is a fake (tests/fake-rclone.js): no network and no accounts.
const root = await mkdtemp(join(tmpdir(), 'docknest-rclone-')), fakeDir = join(root, 'fake');
await (await import('node:fs/promises')).mkdir(fakeDir);
await copyFile(new URL('./fake-rclone.js', import.meta.url), join(fakeDir, 'rclone.js'));
Object.assign(process.env, { DATA_DIR: root, MASTER_KEY_FILE: join(root, 'master.key'), SETUP_TOKEN_FILE: join(root, 'setup.token'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured', SECURE_COOKIES: 'false', APP_ORIGIN: 'http://127.0.0.1:3000', DOCKNEST_RCLONE_BIN: join(fakeDir, 'rclone.js'), RCLONE_CONFIG_PASS: 'must-not-reach-rclone', RCLONE_TEST_LEAK: 'must-not-reach-rclone' });
// A folder a crashed run left behind, young or old, is removed before the first operation.
await (await import('node:fs/promises')).mkdir(join(root, 'tmp', 'rclone-crashed'), { recursive: true });
await writeFile(join(root, 'tmp', 'rclone-crashed', 'rclone.conf'), 'token = leftover');
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js');
const { db, id } = await import('../src/db.js');
const { seal, open, digest } = await import('../src/crypto.js');
const rclone = await import('../src/storage/rclone.js');
const oauth = await import('../src/storage/rclone-oauth.js');
const storage = await import('../src/storage.js');
const { messageFor, templateFor } = await import('../src/alerts/events.js');
const { detectJobsAndMoves } = await import('../src/alerts/detect.js');
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`, csrf = 'fixture-csrf', at = new Date().toISOString();
after(async () => { oauth.endAll(); server.close(); db.close(); await rm(root, { recursive: true, force: true }); });

function session(role) {
  const user = id(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(user, role + '@example.invalid', 'fixture', 'fixture', '[]', at, role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), user, csrf, Date.now() + 3600000, Date.now(), Date.now(), Date.now());
  return token;
}
const admin = session('admin'), operator = session('operator');
const call = (method, route, body, token = admin) => fetch(base + route, { method, headers: { 'content-type': 'application/json', Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
const post = (route, body, token) => call('POST', route, body, token);
const control = async value => writeFile(join(fakeDir, 'control.json'), JSON.stringify(value));
const calls = async () => (await readFile(join(fakeDir, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const resetCalls = () => rm(join(fakeDir, 'calls.jsonl'), { force: true });
const readAll = async stream => { const parts = []; for await (const chunk of stream) parts.push(chunk); return Buffer.concat(parts); };
const leftoverFolders = async () => (await readdir(join(root, 'tmp')).catch(() => [])).filter(name => name.startsWith('rclone-'));

// Fake values are built at run time so no literal looks like a credential to a secret scanner.
const fake = value => Array.from(value).join('');
const TOKEN = { access_token: 'fixture-access-token-0001', token_type: 'Bearer', refresh_token: 'fixture-refresh-token-0001', expiry: '2031-01-01T00:00:00Z' };
function seedDrive({ backend = 'drive', root: folder = '/docknest', secrets = { token: TOKEN }, settings = {} } = {}) {
  const targetId = id();
  db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(targetId, 'My cloud', 'rclone.invalid', 1, '', 'not-sftp', 'rclone', seal(JSON.stringify(secrets)), folder, 0, 'connected', at, at);
  db.prepare("INSERT INTO storage_target_settings VALUES(?,'rclone',?)").run(targetId, JSON.stringify({ backend, account: 'fixture.user@example.invalid', ...settings }));
  return targetId;
}
const options = (backend, extra = {}) => ({ id: id(), mode: 'rclone', name: 'Fixture', backend, root: '/docknest', capacity: 0, persist: false, settings: backend === 'webdav' ? { endpoint: 'https://dav.example.invalid/remote', vendor: 'other' } : backend === 'smb' ? { host: 'nas.example.invalid', share: 'backups' } : {}, secrets: backend === 'webdav' || backend === 'smb' ? { username: 'fixture-user', passwordObscured: 'OBSfixture' } : { token: TOKEN }, ...extra });

test('the probe writes, renames, reads, reads a range and deletes, and leaves nothing behind', async () => {
  await control({});
  const result = await rclone.test(options('webdav'));
  assert.equal(result.connected && result.writeVerified && result.copyVerified && result.rangeVerified && result.deleteVerified, true);
  assert.deepEqual(await readdir(join(fakeDir, 'store', 'docknest')).catch(() => []), []);
  assert.deepEqual(await leftoverFolders(), [], 'startup also removed the folder a crashed run left');
});

test('rclone gets a private 0600 config, no secrets in arguments and no inherited RCLONE variables', async () => {
  await resetCalls(); rclone.resetVersionCheck();
  const drive = options('drive', { secrets: { token: TOKEN, clientId: 'fixture-client-id.example', clientSecret: 'fixture-client-secret' } });
  await rclone.test(drive);
  const seen = await calls();
  assert.ok(seen.length > 5);
  for (const entry of seen.filter(item => item.command !== 'version')) {
    const text = JSON.stringify(entry.args);
    assert.ok(!text.includes(TOKEN.access_token) && !text.includes(TOKEN.refresh_token) && !text.includes('fixture-client-secret') && !text.includes('fixture-client-id'), 'no secret in arguments: ' + text);
    if (process.platform !== 'win32') assert.equal(entry.confMode, 0o600, entry.command);
    assert.deepEqual(entry.env, [], 'no RCLONE_* variables');
    assert.ok(entry.args.includes('--ask-password=false') && entry.args.includes('--tpslimit') && entry.args.includes('8'));
    assert.ok(entry.confKeys.includes('token'));
    assert.equal(entry.confType, 'drive');
    assert.ok(entry.home.startsWith(join(root, 'tmp', 'rclone-')) && entry.cwdConf.startsWith(join(root, 'tmp', 'rclone-')));
  }
  assert.ok(seen.some(item => item.command === 'version'));
  assert.deepEqual(await leftoverFolders(), [], 'every config folder is removed');
  await resetCalls();
  await rclone.obscure(options('webdav'), 'a-password-that-must-not-be-an-argument');
  assert.ok(!JSON.stringify(await calls()).includes('a-password'));
});

test('paths are confined to the destination root before rclone sees them', async () => {
  const dest = options('webdav');
  assert.equal(rclone.resolve(dest, '/docknest/a/b.enc'), '/docknest/a/b.enc');
  for (const value of ['/docknest', '/docknest/', '/other/x', '/docknest/../etc/passwd', '/docknestx/y', 'relative', '/docknest/a\\b', '/docknest/a\nb', '/docknest/a\0b']) assert.throws(() => rclone.resolve(dest, value), /outside managed/, value);
  await resetCalls();
  await assert.rejects(storage.openRead('rclone:' + id() + ':/docknest/x'), /destination is missing/);
  assert.deepEqual(await calls(), []);
});

test('uploads stream through rcat, refuse overwrites, serve exact ranges, rename, list and delete', async () => {
  await control({});
  const dest = options('webdav'), bytes = randomBytes(5000);
  await pipeline(Readable.from([bytes.subarray(0, 2500), bytes.subarray(2500)]), rclone.openWrite(dest, '/docknest/site/a.enc.partial'));
  assert.equal((await rclone.statFile(dest, '/docknest/site/a.enc.partial')).size, 5000);
  await assert.rejects(pipeline(Readable.from([Buffer.from('x')]), rclone.openWrite(dest, '/docknest/site/a.enc.partial')), error => error.code === 'EEXIST');
  await rclone.syncFile(dest, '/docknest/site/a.enc.partial');
  await rclone.renameFile(dest, '/docknest/site/a.enc.partial', '/docknest/site/a.enc');
  await assert.rejects(rclone.statFile(dest, '/docknest/site/a.enc.partial'), error => error.code === 'ENOENT');
  assert.ok((await readAll(await rclone.openRead(dest, '/docknest/site/a.enc'))).equals(bytes));
  assert.ok((await readAll(await rclone.openRead(dest, '/docknest/site/a.enc', { start: 1000, end: 1999 }))).equals(bytes.subarray(1000, 2000)));
  assert.ok((await readAll(await rclone.openRead(dest, '/docknest/site/a.enc', { start: 4990 }))).equals(bytes.subarray(4990)));
  await assert.rejects(rclone.openRead(dest, '/docknest/site/a.enc', { start: -1 }), /Invalid/);
  // Renaming onto an existing file is refused, the source is kept.
  await pipeline(Readable.from([Buffer.from('other')]), rclone.openWrite(dest, '/docknest/site/b.partial'));
  await assert.rejects(rclone.renameFile(dest, '/docknest/site/b.partial', '/docknest/site/a.enc'), error => error.code === 'EEXIST');
  assert.equal((await rclone.statFile(dest, '/docknest/site/b.partial')).size, 5);
  assert.deepEqual((await rclone.list(dest, '/docknest/site')).map(item => item.value).sort(), ['/docknest/site/a.enc', '/docknest/site/b.partial']);
  await rclone.removeFile(dest, '/docknest/site/b.partial');
  await assert.rejects(rclone.removeFile(dest, '/docknest/site/b.partial'), error => error.code === 'ENOENT');
  await rclone.removeFile(dest, '/docknest/site/a.enc');
  await rclone.removeDirectory(dest, '/docknest/site');
  assert.deepEqual(await leftoverFolders(), []);
});

test('an upload that rclone rejects fails the stream with the mapped reason only', async () => {
  const secret = fake('ya29.fixture-secret-in-stderr');
  await control({ fail: [{ cmd: 'rcat', stderr: `googleapi: Error 403: Rate Limit Exceeded, rateLimitExceeded https://x/?token=${secret}`, code: 1 }] });
  const dest = options('drive');
  await assert.rejects(pipeline(Readable.from([randomBytes(10)]), rclone.openWrite(dest, '/docknest/a.partial')), error => {
    assert.equal(error.reason, 'rate_limited');
    assert.match(error.message, /Google Drive is limiting requests, DockNest retries at the next run/);
    assert.ok(!JSON.stringify([error.message, error.stack]).includes(secret));
    return true;
  });
  await control({});
  assert.deepEqual(await leftoverFolders(), []);
});

test('Google Drive duplicate names fail closed; Drive upload hashes are compared', async () => {
  await control({});
  const dest = options('drive');
  await pipeline(Readable.from([Buffer.from('payload')]), rclone.openWrite(dest, '/docknest/d/one.partial'));
  await control({ duplicates: ['one.partial'] });
  await assert.rejects(rclone.renameFile(dest, '/docknest/d/one.partial', '/docknest/d/one'), error => error.code === 'EDUPLICATE' && /more than one file/.test(error.message));
  await assert.rejects(pipeline(Readable.from([Buffer.from('x')]), rclone.openWrite(dest, '/docknest/d/one.partial')), error => error.code === 'EEXIST');
  await control({});
  await rclone.renameFile(dest, '/docknest/d/one.partial', '/docknest/d/one');
  await rclone.removeFile(dest, '/docknest/d/one');
});

test('capacity comes from the provider, then the typed size, then is unbounded', async () => {
  await control({ about: { total: 15 * 1024 ** 3, free: 10 * 1024 ** 3, used: 5 * 1024 ** 3 } });
  const dest = options('drive');
  const reported = await rclone.capacity(dest, { managedBytes: 123 });
  assert.equal(reported.capacitySource, 'provider'); assert.equal(reported.available, 10 * 1024 ** 3); assert.equal(reported.managedBytes, 123);
  await control({});
  const typed = await rclone.capacity({ ...dest, id: id(), capacity: 2e9 }, { managedBytes: 5e8 });
  assert.equal(typed.capacitySource, 'configured'); assert.equal(typed.available, 1.5e9);
  const open_ = await rclone.capacity({ ...dest, id: id() });
  assert.equal(open_.unbounded, true);
});

test('a token rclone refreshed is sealed and saved, and the config file is gone', async () => {
  await control({ refresh: true });
  const targetId = seedDrive();
  const dest = storage.targetOptions(targetId);
  await rclone.statFile(dest, '/docknest/none').catch(() => {});
  const saved = JSON.parse(open(db.prepare('SELECT credential FROM storage_targets WHERE id=?').get(targetId).credential));
  assert.match(saved.token.access_token, /^refreshed-access-/);
  assert.equal(saved.token.refresh_token, TOKEN.refresh_token);
  assert.ok(!db.prepare('SELECT credential FROM storage_targets WHERE id=?').get(targetId).credential.includes('refreshed-access'), 'stored sealed');
  assert.equal(JSON.parse(db.prepare('SELECT settings FROM storage_target_settings WHERE target_id=?').get(targetId).settings).tokenExpiresAt, '2031-01-01T00:00:00Z');
  // The next operation starts from the saved token.
  await resetCalls();
  await control({});
  await rclone.statFile(storage.targetOptions(targetId), '/docknest/none').catch(() => {});
  assert.deepEqual(await leftoverFolders(), []);
  // A failed operation still removes the folder.
  await control({ fail: [{ cmd: 'lsjson', stderr: 'boom', code: 1 }] });
  await rclone.statFile(dest, '/docknest/x').catch(() => {});
  assert.deepEqual(await leftoverFolders(), []);
  await control({});
});

test('a revoked token marks the destination needs_reconnect once, with one audit row and one alert', async () => {
  const targetId = seedDrive();
  const dest = storage.targetOptions(targetId);
  detectJobsAndMoves(new Date(Date.now() - 1000).toISOString());
  await control({ fail: [{ cmd: 'lsjson', stderr: 'Failed to create file system: couldn\'t fetch token: invalid_grant: Token has been expired or revoked.', code: 1 }] });
  for (let run = 0; run < 3; run++) {
    await assert.rejects(rclone.statFile(dest, '/docknest/x'), error => error.reason === 'needs_reconnect' && /Google Drive needs you to sign in again/.test(error.message) && error.status === 502 && !/invalid_grant/.test(error.message));
  }
  assert.equal(db.prepare('SELECT status FROM storage_targets WHERE id=?').get(targetId).status, 'needs_reconnect');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='storage.reconnect_needed' AND target=?").get(targetId).n, 1);
  // Alert: the event reads only the destination name.
  assert.doesNotThrow(() => detectJobsAndMoves(new Date(Date.now() + 1000).toISOString()));
  assert.ok('reconnects' in JSON.parse(db.prepare("SELECT value FROM settings WHERE key='alerts_cursor'").get().value));
  assert.match(messageFor({ type: 'storage.reconnect_needed', destinationName: 'My cloud' }), /Storage needs you to sign in again: My cloud/);
  const template = templateFor({ type: 'storage.reconnect_needed', destinationName: 'My cloud', at });
  assert.equal(template.title, 'Storage needs you');
  assert.match(template.reason, /Sign in again to My cloud/);
  assert.ok(!JSON.stringify(template).includes('fixture.user'));
  await control({});
});

test('the API lists cloud drives without a token, secret or full account', async () => {
  const targetId = seedDrive({ secrets: { token: TOKEN, clientId: 'fixture-client-id.example', clientSecret: 'fixture-client-secret' }, settings: { tokenExpiresAt: '2031-01-01T00:00:00Z', clientIdSet: true } });
  const text = await (await call('GET', '/storage-targets')).text();
  const entry = JSON.parse(text).targets.find(item => item.id === targetId);
  assert.equal(entry.kind, 'rclone'); assert.equal(entry.backend, 'drive'); assert.equal(entry.connected, true); assert.equal(entry.needsReconnect, false);
  assert.equal(entry.account, 'f***@e***.invalid'); assert.equal(entry.tokenExpiresAt, '2031-01-01T00:00:00Z');
  assert.equal(entry.semantics.appendOnly, false);
  for (const secret of [TOKEN.access_token, TOKEN.refresh_token, 'fixture-client-secret', 'fixture.user@example.invalid', 'rclone.invalid', 'not-sftp']) assert.ok(!text.includes(secret), secret);
  assert.equal((await call('GET', '/storage-targets', undefined, operator)).status, 403);
});

test('the facade routes rclone references: targetMode, publishVerified, retention-style delete', async () => {
  await control({});
  const targetId = seedDrive({ backend: 'webdav', secrets: { username: 'fixture-user', passwordObscured: 'OBSfixture' }, settings: { endpoint: 'https://dav.example.invalid/remote', vendor: 'other' } });
  assert.equal(storage.targetMode({ auth_type: 'rclone' }), 'rclone');
  assert.equal(storage.targetMode({ auth_type: 's3-access-key' }), 's3');
  assert.equal(storage.targetMode({ auth_type: 'password' }), 'sftp');
  const prefix = storage.targetPrefix({ mode: 'rclone', id: targetId }), published = prefix + '/docknest/site/pkg.enc';
  assert.equal(storage.isRemoteFile(published), true);
  const content = randomBytes(4096), file = join(root, 'package.bin');
  await writeFile(file, content);
  await storage.publishVerified(file, published, createHash('sha256').update(content).digest('hex'));
  assert.equal((await storage.statFile(published)).size, 4096);
  assert.equal(await storage.storedHash(published), createHash('sha256').update(content).digest('hex'));
  await assert.rejects(storage.publishVerified(file, published, createHash('sha256').update(content).digest('hex')), error => error.code === 'EEXIST');
  await storage.removeFile(published);
  await assert.rejects(storage.statFile(published), error => error.code === 'ENOENT');
  assert.equal((await storage.storageCapacity({ options: storage.targetOptions(targetId) })).backend, 'rclone');
  assert.deepEqual(await leftoverFolders(), []);
});

test('sign-in A: the pasted address is checked, rebuilt from code and state and forwarded to the local listener', async () => {
  await control({});
  await rm(join(fakeDir, 'auth-requests.jsonl'), { force: true });
  const response = await post('/storage-targets/rclone/authorize', { backend: 'drive' });
  assert.equal(response.status, 201);
  const started = await response.json();
  assert.match(started.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?state=/);
  const state = new URL(started.url).searchParams.get('state');
  // A second address sign-in cannot start while one is open (the helper's port is fixed).
  assert.equal((await post('/storage-targets/rclone/authorize', { backend: 'dropbox' })).status, 409);
  const pasteRoute = `/storage-targets/rclone/authorize/${started.sessionId}`;
  for (const pasted of ['http://evil.example.invalid:53682/?state=' + state + '&code=fixture-code-12345', 'http://127.0.0.1:53682/?state=WrongState123456&code=fixture-code-12345', 'http://127.0.0.1:53682/?state=' + state + '&code=fixture-code-12345&extra=1', 'http://127.0.0.1:53682/?state=' + state + '&code=fixture-code-12345#x', 'garbage']) {
    const refused = await post(pasteRoute, { pasted });
    assert.equal(refused.status, 400, pasted);
    assert.ok(!(await refused.text()).includes('fixture-code-12345'));
  }
  assert.equal((await readFile(join(fakeDir, 'auth-requests.jsonl'), 'utf8').catch(() => '')), '', 'nothing refused was forwarded');
  assert.equal((await post(pasteRoute, { pasted: 'http://127.0.0.1:53682/?state=' + state + '&code=fixture-code-12345' }, operator)).status, 403, 'a session belongs to the admin who started it');
  const done = await post(pasteRoute, { pasted: 'http://127.0.0.1:53682/?state=' + state + '&code=fixture-code-12345&scope=email&authuser=0' });
  assert.equal(done.status, 200);
  const body = await done.text();
  assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ['account', 'backend', 'tokenExpiresAt']);
  assert.ok(!body.includes('issued-access') && !body.includes('issued-refresh'));
  assert.equal(JSON.parse(body).account, 'f***@e***.invalid', 'the account is masked on the sign-in answer too');
  assert.ok(!body.includes('fake.user'));
  const forwarded = (await readFile(join(fakeDir, 'auth-requests.jsonl'), 'utf8')).trim().split('\n');
  assert.deepEqual(forwarded, ['/?state=' + state + '&code=fixture-code-12345'], 'only code and state are forwarded');
  assert.equal(oauth.sessionCount(), 1);
  // The destination is created from the session: the token is tested, sealed, never returned.
  const created = await post('/storage-targets/rclone/connect', { backend: 'drive', sessionId: started.sessionId, name: 'Family Drive', root: 'docknest/prod' });
  assert.equal(created.status, 201);
  const text = await created.text(), view = JSON.parse(text);
  assert.ok(!text.includes('issued-') && !text.includes('rclone.invalid'));
  assert.equal(view.kind, 'rclone'); assert.equal(view.root, '/docknest/prod'); assert.equal(view.account, 'f***@e***.invalid');
  const row = db.prepare('SELECT * FROM storage_targets WHERE id=?').get(view.id);
  assert.equal(row.auth_type, 'rclone'); assert.equal(row.host, 'rclone.invalid'); assert.equal(row.host_key, 'not-sftp');
  assert.match(JSON.parse(open(row.credential)).token.access_token, /^issued-access-/);
  assert.equal(oauth.sessionCount(), 0, 'the session ends once the destination exists');
  assert.equal((await post('/storage-targets/rclone/connect', { backend: 'drive', sessionId: started.sessionId, name: 'Again', root: '' })).status, 404);
});

test('sign-in B and C: a pasted token, and the owner\'s own app passed by environment, never arguments', async () => {
  await control({});
  await resetCalls();
  const started = await (await post('/storage-targets/rclone/authorize', { backend: 'dropbox', flow: 'token', clientId: 'own-app-id-1234', clientSecret: 'own-app-secret-5678' })).json();
  assert.equal(started.url, null);
  const refused = await post(`/storage-targets/rclone/authorize/${started.sessionId}`, { pasted: JSON.stringify({ ...TOKEN, scope: 'x' }) });
  assert.equal(refused.status, 400);
  assert.equal((await post(`/storage-targets/rclone/authorize/${started.sessionId}`, { pasted: 'http://127.0.0.1:53682/?state=x&code=y' })).status, 400, 'a token session does not take addresses');
  assert.equal((await post(`/storage-targets/rclone/authorize/${started.sessionId}`, { pasted: JSON.stringify(TOKEN) })).status, 200);
  const created = await post('/storage-targets/rclone/connect', { backend: 'dropbox', sessionId: started.sessionId, name: 'Dropbox', root: '' });
  assert.equal(created.status, 201);
  const secrets = JSON.parse(open(db.prepare('SELECT credential FROM storage_targets WHERE id=?').get((await created.json()).id).credential));
  assert.equal(secrets.clientId, 'own-app-id-1234'); assert.equal(secrets.clientSecret, 'own-app-secret-5678'); assert.equal(secrets.token.refresh_token, TOKEN.refresh_token);
  const conf = (await calls()).filter(item => item.command !== 'version');
  assert.ok(conf.length > 0 && conf.every(item => !JSON.stringify(item.args).includes('own-app')), 'client credentials are never arguments');
  // Own app on an address sign-in: handed to the helper through its environment only.
  await resetCalls(); await rm(join(fakeDir, 'auth-requests.jsonl'), { force: true });
  const address = await (await post('/storage-targets/rclone/authorize', { backend: 'drive', clientId: 'own-app-id-1234', clientSecret: 'own-app-secret-5678' })).json();
  const authorize = (await calls()).find(item => item.command === 'authorize');
  assert.ok(!JSON.stringify(authorize.args).includes('own-app'));
  assert.equal(authorize.envValues.RCLONE_DRIVE_CLIENT_ID, 'own-app-id-1234');
  assert.equal(authorize.envValues.RCLONE_CONFIG_PASS, undefined);
  await call('DELETE', `/storage-targets/rclone/authorize/${address.sessionId}`);
  assert.equal(oauth.sessionCount(), 0);
  assert.equal((await post('/storage-targets/rclone/authorize', { backend: 'drive', clientId: 'only-id-12345' })).status, 400);
});

test('Reconnect replaces only the token, clears the state and keeps the folder and history', async () => {
  await control({});
  const targetId = seedDrive({ secrets: { token: TOKEN, clientId: 'keep-client-id-1', clientSecret: 'keep-secret' } });
  db.prepare("UPDATE storage_targets SET status='needs_reconnect' WHERE id=?").run(targetId);
  const started = await (await post('/storage-targets/rclone/authorize', { backend: 'drive', flow: 'token' })).json();
  const fresh = { ...TOKEN, access_token: 'fresh-access-token-0002', refresh_token: 'fresh-refresh-token-0002' };
  await post(`/storage-targets/rclone/authorize/${started.sessionId}`, { pasted: JSON.stringify(fresh) });
  assert.equal((await post(`/storage-targets/${targetId}/reconnect`, { sessionId: started.sessionId }, operator)).status, 403);
  const wrongBackend = await (await post('/storage-targets/rclone/authorize', { backend: 'dropbox', flow: 'token' })).json();
  await post(`/storage-targets/rclone/authorize/${wrongBackend.sessionId}`, { pasted: JSON.stringify(fresh) });
  assert.equal((await post(`/storage-targets/${targetId}/reconnect`, { sessionId: wrongBackend.sessionId })).status, 400);
  const done = await post(`/storage-targets/${targetId}/reconnect`, { sessionId: started.sessionId });
  assert.equal(done.status, 200);
  const view = await done.json();
  assert.equal(view.connected, true); assert.equal(view.needsReconnect, false); assert.equal(view.root, '/docknest');
  const row = db.prepare('SELECT * FROM storage_targets WHERE id=?').get(targetId), secrets = JSON.parse(open(row.credential));
  assert.equal(secrets.token.refresh_token, 'fresh-refresh-token-0002'); assert.equal(secrets.clientSecret, 'keep-secret');
  assert.equal(row.status, 'connected');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='storage.reconnected' AND target=?").get(targetId).n, 1);
  // A reconnect that does not work leaves the old state: the owner can try again.
  db.prepare("UPDATE storage_targets SET status='needs_reconnect' WHERE id=?").run(targetId);
  const again = await (await post('/storage-targets/rclone/authorize', { backend: 'drive', flow: 'token' })).json();
  await post(`/storage-targets/rclone/authorize/${again.sessionId}`, { pasted: JSON.stringify(fresh) });
  await control({ fail: [{ cmd: 'rcat', stderr: 'invalid_grant', code: 1 }] });
  assert.equal((await post(`/storage-targets/${targetId}/reconnect`, { sessionId: again.sessionId })).status, 502);
  assert.equal(db.prepare('SELECT status FROM storage_targets WHERE id=?').get(targetId).status, 'needs_reconnect');
  await control({});
  assert.equal((await post(`/storage-targets/${targetId}/reconnect`, { sessionId: again.sessionId })).status, 200, 'the same sign-in can be used again after a failed test');
});

test('WebDAV and SMB destinations: login stored obscured and sealed, strict endpoint rules', async () => {
  await control({});
  for (const endpoint of ['http://dav.example.invalid/x', 'https://user:pw@dav.example.invalid/x', 'nonsense']) {
    assert.equal((await post('/storage-targets/rclone/connect', { backend: 'webdav', endpoint, username: 'fixture-user', password: fake('fixture-pass'), name: 'Cloud', root: '' })).status, 400, endpoint);
  }
  const dav = await post('/storage-targets/rclone/connect', { backend: 'webdav', endpoint: 'https://dav.example.invalid/remote.php/dav/files/fixture/', vendor: 'nextcloud', username: 'fixture-user', password: fake('fixture-pass-value'), name: 'Nextcloud', root: 'docknest' });
  assert.equal(dav.status, 201);
  const view = await dav.json(), row = db.prepare('SELECT * FROM storage_targets WHERE id=?').get(view.id), secrets = JSON.parse(open(row.credential));
  assert.equal(secrets.username, 'fixture-user'); assert.equal(secrets.passwordObscured, 'OBS' + Buffer.from('fixture-pass-value').toString('base64url')); assert.ok(!('password' in secrets));
  assert.ok(!row.credential.includes('fixture-pass'));
  assert.equal(JSON.parse(db.prepare('SELECT settings FROM storage_target_settings WHERE target_id=?').get(view.id).settings).endpoint, 'https://dav.example.invalid/remote.php/dav/files/fixture');
  const smb = await post('/storage-targets/rclone/connect', { backend: 'smb', host: 'nas.example.invalid', share: 'backups', domain: 'WORKGROUP', username: 'fixture-user', password: fake('fixture-pass-2'), name: 'NAS', root: 'docknest' });
  assert.equal(smb.status, 201);
  for (const bad of [{ share: 'a/b' }, { host: 'a;b' }, { root: '../x' }, { root: 'a/../b' }]) {
    assert.equal((await post('/storage-targets/rclone/connect', { backend: 'smb', host: 'nas.example.invalid', share: 'backups', username: 'fixture-user', password: fake('fixture-pass-2'), name: 'NAS', root: '', ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await post('/storage-targets/rclone/connect', { backend: 'smb', host: 'nas.example.invalid', share: 'backups', username: 'u', password: fake('p'), name: 'NAS', root: '' }, operator)).status, 403);
  // The saved destination can be tested and used through the existing routes.
  assert.equal((await post(`/storage-targets/${view.id}/test`, {})).status, 200);
  assert.equal((await post(`/storage-targets/${view.id}/use`, {})).status, 200);
  assert.deepEqual(await leftoverFolders(), []);
});

test('rclone missing or too old is a plain refusal, and an unsupported provider is not offered', async () => {
  rclone.resetVersionCheck();
  await control({ version: 'v1.50.2' });
  await assert.rejects(rclone.version(), error => error.publicCode === 'rclone_old' && /older than/.test(error.message));
  assert.equal((await post('/storage-targets/rclone/authorize', { backend: 'drive' })).status, 503);
  await control({}); rclone.resetVersionCheck();
  assert.equal((await rclone.version()).minor, 70);
  assert.equal((await post('/storage-targets/rclone/authorize', { backend: 'box' })).status, 400);
  assert.equal((await post('/storage-targets/rclone/connect', { backend: 'sftp', name: 'x' })).status, 400);
});

test('a cloud drive destination is covered by the other storage views', async () => {
  const targetId = seedDrive();
  const { sameLocation, targetSummary } = await import('../src/site-storage.js');
  assert.equal(targetSummary(targetId).mode, 'rclone');
  const twin = seedDrive(), elsewhere = seedDrive({ root: '/other' }), otherAccount = seedDrive({ settings: { account: 'someone.else@example.invalid' } });
  assert.equal(sameLocation(targetId, twin), true, 'same account and folder is the same place');
  assert.equal(sameLocation(targetId, elsewhere), false);
  assert.equal(sameLocation(targetId, otherAccount), false);
  const usage = await (await call('GET', `/storage-targets/${targetId}/usage`)).json();
  assert.equal(usage.copies, 0);
  const { storageReport } = await import('../src/storage-report.js');
  await assert.doesNotReject(storageReport());
  const stat_ = await stat(join(root, 'tmp')).catch(() => null);
  assert.ok(!stat_ || (await readdir(join(root, 'tmp'))).filter(name => name.startsWith('rclone-')).length === 0);
});

test('the Recovery Guide describes a cloud drive without a command, a token or an address', async () => {
  const { loadInventory } = await import('../src/runbook/inventory.js');
  const { buildGuide, guideBlocks } = await import('../src/runbook/guide.js');
  const targetId = seedDrive({ secrets: { token: TOKEN, clientSecret: 'fixture-client-secret' } });
  db.prepare("INSERT INTO settings VALUES('backup_storage_target',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(targetId);
  const inventory = await loadInventory({ logins: true });
  const entry = inventory.storage.find(item => item.id === targetId);
  assert.deepEqual(Object.keys(entry).sort(), ['backend', 'id', 'mode', 'name', 'root']);
  const guide = buildGuide(inventory, { version: '3.0.0', include: { addresses: true, logins: true } });
  const text = JSON.stringify([guide, guideBlocks(guide)]);
  for (const secret of [TOKEN.access_token, TOKEN.refresh_token, 'fixture-client-secret', 'rclone.invalid']) assert.ok(!text.includes(secret), secret);
  assert.match(text, /Cloud drive or network share/);
});

test('two address sign-ins started at once: exactly one gets the helper port', async () => {
  await control({});
  const before = oauth.sessionCount();
  const [first, second] = await Promise.all([post('/storage-targets/rclone/authorize', { backend: 'drive' }), post('/storage-targets/rclone/authorize', { backend: 'dropbox' })]);
  assert.deepEqual([first.status, second.status].sort(), [201, 409]);
  assert.equal(oauth.sessionCount(), before + 1);
  const won = first.status === 201 ? await first.json() : await second.json();
  assert.equal((await call('DELETE', '/storage-targets/rclone/authorize/' + won.sessionId)).status, 200);
  assert.equal(oauth.sessionCount(), before);
});
