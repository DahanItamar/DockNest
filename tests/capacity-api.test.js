import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-capacity-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js');
const { db, id } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const { startSftpFixture } = await import('./sftp-fixture.js');
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
const csrf = 'fixture-csrf', at = new Date().toISOString();
function session(role) {
  const user = id(), token = randomBytes(32).toString('base64url');
  db.prepare("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)").run(user, role + '@example.invalid', 'fixture', 'fixture', '[]', at, role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), user, csrf, Date.now() + 3600000, Date.now(), Date.now(), Date.now());
  return token;
}
const admin = session('admin'), operator = session('operator');
const post = (route, body, token = admin) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, 'x-csrf-token': csrf }, body: JSON.stringify(body) });
const hostKey = sftp => sftp.options.hostKey;
const details = (sftp, extra = {}) => ({ host: sftp.options.host, port: sftp.options.port, username: sftp.options.username, hostKey: hostKey(sftp), authType: 'password', password: sftp.options.password, root: '/capacity-test', ...extra });
const stored = () => db.prepare('SELECT capacity_bytes FROM storage_targets ORDER BY created_at DESC').get().capacity_bytes;

test('capacity route is admin only, saves nothing and returns only the size', async () => {
  const sftp = await startSftpFixture();
  try {
    sftp.volume.blocks = 250000; sftp.volume.free = 200000; sftp.volume.available = 190000;
    assert.equal((await post('/storage-targets/capacity', details(sftp), operator)).status, 403);
    const response = await post('/storage-targets/capacity', details(sftp));
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { capacityBytes: 250000 * 4096 });
    assert.ok(!text.includes(sftp.options.password) && !text.includes(sftp.options.host));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM storage_targets').get().n, 0);
    sftp.volume.blocks = 0;
    assert.deepEqual(await (await post('/storage-targets/capacity', details(sftp))).json(), { capacityBytes: null });
  } finally { await sftp.close(); }
});
test('connect saves an explicit capacity, else the reported size, else 1 TB', async () => {
  const sftp = await startSftpFixture();
  try {
    sftp.volume.blocks = 250000; sftp.volume.free = 200000; sftp.volume.available = 190000;
    const connect = (name, extra) => post('/storage-targets/connect', { ...details(sftp, extra), name });
    assert.equal((await connect('typed', { capacityBytes: 5e12 })).status, 201);
    assert.equal(stored(), 5e12);
    assert.equal((await connect('reported', {})).status, 201);
    assert.equal(stored(), 250000 * 4096);
    sftp.volume.blocks = 0;
    assert.equal((await connect('fallback', {})).status, 201);
    assert.equal(stored(), 1e12);
  } finally { await sftp.close(); }
});
test.after(() => server.close());
