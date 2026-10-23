import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Unknown non-API paths answer with the app and a 404 status (the app renders its own 404 page); API 404s stay JSON.
const directory = await mkdtemp(join(tmpdir(), 'docknest-status-'));
const page = '<!doctype html><title>DockNest fixture app</title><div id="root"></div>';
await mkdir(join(directory, 'dist'));
await writeFile(join(directory, 'dist', 'index.html'), page);
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const original = process.cwd();
process.chdir(directory); // the server resolves ./dist when it loads
const { app } = await import('../src/server.js');
process.chdir(original);
const { db, id } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const token = randomBytes(32).toString('base64url'), csrf = 'fixture-csrf', user = id();
db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(user, 'qa@example.invalid', 'fixture', 'fixture', '[]', new Date().toISOString(), 'QA', 'admin');
db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), user, csrf, Date.now() + 3600000, Date.now(), Date.now(), Date.now());
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

for (const method of ['GET', 'HEAD']) {
  test(`${method}: the app is served at / and /index.html with 200`, async () => {
    for (const path of ['/', '/index.html']) {
      const response = await fetch(base + path, { method });
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type'), /text\/html/);
      if (method === 'GET') assert.equal(await response.text(), page);
    }
  });
  test(`${method}: an unknown path answers 404 with the app`, async () => {
    for (const path of ['/no/such/page', '/missing']) {
      const response = await fetch(base + path, { method });
      assert.equal(response.status, 404, path);
      assert.match(response.headers.get('content-type'), /text\/html/);
      if (method === 'GET') assert.equal(await response.text(), page);
    }
  });
  test(`${method}: an unknown API path stays JSON, never the app`, async () => {
    const signedOut = await fetch(base + '/api/does-not-exist', { method });
    assert.equal(signedOut.status, 401);
    assert.match(signedOut.headers.get('content-type'), /application\/json/);
    const response = await fetch(base + '/api/does-not-exist', { method, headers: { Cookie: 'dbm_session=' + token } });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /application\/json/);
    if (method === 'GET') assert.deepEqual(await response.json(), { error: 'API endpoint not found.' });
  });
}
