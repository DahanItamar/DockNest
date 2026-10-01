import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
const temp = await mkdtemp(path.join(tmpdir(), 'dbm-auth-'));
process.env.DATA_DIR = temp;
process.env.BACKUP_DIR = path.join(temp, 'backups');
process.env.MASTER_KEY_FILE = path.join(temp, 'master.key');
process.env.SETUP_TOKEN_FILE = path.join(temp, 'setup.token');
process.env.SECURE_COOKIES = 'false';
process.env.NODE_ENV = 'test';
process.env.APP_ORIGIN = 'http://127.0.0.1:3000';
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await writeFile(process.env.SETUP_TOKEN_FILE, 'integration-test-setup-token');
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { totp, passwordVerify, seal, open, verifyTotp } = await import('../src/crypto.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
let cookie = '', csrfToken = '';
async function request(route, body, options = {}) {
  const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Origin: process.env.APP_ORIGIN, ...(cookie ? { Cookie: cookie } : {}), ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}), ...options.headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json().catch(() => null), cookie: response.headers.get('set-cookie') };
}
test('setup, mandatory 2FA, sessions, CSRF, replay protection and one-use recovery', async () => {
  assert.equal((await request('/state')).status, 401);
  assert.equal((await request('/backups/no-id/download')).status, 401);
  const credentials = { email: 'owner@example.org', password: 'auth-test-1234' };
  assert.equal((await request('/auth/setup', { ...credentials, setupToken: 'wrong-token' })).status, 403);
  assert.equal((await request('/auth/setup', { ...credentials, setupToken: 'integration-test-setup-token' }, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  const setup = await request('/auth/setup', { ...credentials, setupToken: 'integration-test-setup-token' });
  assert.equal(setup.status, 201);
  assert.equal((await request('/auth/status')).data.authenticated, false);
  const stored = db.prepare('SELECT * FROM users').get();
  assert.notEqual(stored.totp_secret, setup.data.secret);
  assert.equal(passwordVerify(credentials.password, stored.password_hash), true);
  assert.equal((await request('/auth/verify', { challenge: setup.data.challenge, code: setup.data.recoveryCodes[0] })).status, 401, 'recovery codes cannot bypass first enrollment');
  const code = totp(setup.data.secret);
  const verified = await request('/auth/verify', { challenge: setup.data.challenge, code });
  assert.equal(verified.status, 200);
  assert.match(verified.cookie, /HttpOnly/);
  assert.match(verified.cookie, /SameSite=Strict/);
  cookie = verified.cookie.split(';')[0]; csrfToken = verified.data.csrfToken;
  assert.equal((await request('/state')).status, 200);
  assert.equal((await request('/auth/verify', { challenge: setup.data.challenge, code })).status, 401);
  assert.equal((await request('/servers', {}, { headers: { 'x-csrf-token': '' } })).status, 403);
  const added = await request('/servers', { name: 'Test Linux host', host: '127.0.0.1', port: 22, username: 'root', privateKey: '-----BEGIN PRIVATE KEY-----\n' + 'x'.repeat(80) + '\n-----END PRIVATE KEY-----', hostKey: 'ab'.repeat(32) });
  assert.equal(added.status, 201);
  const state = await request('/state');
  assert.equal(state.data.servers[0].private_key, undefined);
  assert.equal(state.data.servers[0].privateKey, undefined);
  assert.equal(state.data.servers[0].hostKey, 'ab'.repeat(32));
  assert.equal((await request('/auth/logout', {})).status, 204);
  assert.equal((await request('/state')).status, 401);
  cookie = ''; csrfToken = '';
  const login = await request('/auth/login', credentials);
  assert.equal(login.status, 200);
  assert.equal((await request('/state')).status, 401, 'password alone does not authenticate');
  assert.equal((await request('/auth/verify', { challenge: login.data.challenge, code })).status, 401, 'TOTP cannot be reused');
  const recovery = await request('/auth/verify', { challenge: login.data.challenge, code: setup.data.recoveryCodes[0] });
  assert.equal(recovery.status, 200);
  const secondLogin = await request('/auth/login', credentials);
  assert.equal((await request('/auth/verify', { challenge: secondLogin.data.challenge, code: setup.data.recoveryCodes[0] })).status, 401);
});
test('all private API routes reject anonymous and forged sessions before reading data or running operations', async () => {
  const routes = [
    ['GET','/state'], ['GET','/servers/example/discover'], ['GET','/jobs/example'], ['GET','/backups/example/download'],
    ['POST','/servers'], ['PATCH','/servers/example'], ['POST','/servers/example/test'],
    ['POST','/sites'], ['PATCH','/sites/example'], ['POST','/sites/example/policy'], ['POST','/sites/example/backup'],
    ['POST','/jobs/example/recovery'], ['POST','/backups/example/pin'], ['POST','/backups/example/restore-plan'], ['POST','/backups/example/restore'],
    ['PATCH','/maintenance'], ['POST','/sites/example/maintenance'], ['POST','/sites/example/maintenance/deploy'],
    ['GET','/access'], ['POST','/access/invitations'], ['POST','/access/users/example/invitation'], ['POST','/access/users/example/revoke'],
    ['POST','/access/invitations/example/revoke'], ['POST','/access/password'],
    ['POST','/auth/activity'], ['POST','/auth/reauth'], ['POST','/auth/logout'], ['GET','/unknown-private-route'],
  ];
  for(const cookie of ['', 'dbm_session='+ 'a'.repeat(43)]){
    for(const [method,route] of routes){
      const response=await fetch(base+route,{method,headers:{Origin:process.env.APP_ORIGIN,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(method==='GET'?{}:{body:'{}'})});
      assert.equal(response.status,401,`${method} ${route} must require a valid session`);
      assert.equal((await response.json()).user,undefined);
    }
  }
});

test('local loopback aliases work while foreign, missing and production alias origins remain blocked', async () => {
  const { allowedOrigins } = await import('../src/config.js');
  assert.deepEqual([...allowedOrigins('http://127.0.0.1:3000',true)],['http://127.0.0.1:3000']);
  assert.deepEqual([...allowedOrigins('https://backup.example.org',false)],['https://backup.example.org']);
  for(const Origin of ['http://localhost:3000','http://127.0.0.1:3000']){
    assert.equal((await request('/auth/login',{password:'wrong'},{headers:{Origin}})).status,401);
  }
  for(const Origin of ['http://localhost:3001','http://localhost.attacker.invalid:3000','https://localhost:3000','null','']){
    assert.equal((await request('/auth/login',{password:'wrong'},{headers:{Origin}})).status,403);
  }
});

test('authenticated secret encryption and RFC 6238 counter vector', () => {
  const value = seal('private ssh material'); assert.equal(open(value), 'private ssh material');
  const tampered = Buffer.from(value, 'base64'); tampered[15] ^= 1;
  assert.throws(() => open(tampered.toString('base64')));
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totp(secret, 1), '287082');
  assert.equal(verifyTotp(secret, '287082', -1, 59000), 1);
  assert.equal(verifyTotp(secret, '287082', 1, 59000), null);
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); await rm(temp, { recursive: true, force: true }); });
