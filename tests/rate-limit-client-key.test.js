import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
// Security regression: sign-in limits keyed by the full IPv6 address let one client with an ordinary /64 allocation
// rotate addresses and get a fresh budget on every request. The bundled proxy is simulated with TRUST_PROXY.
const temp = await mkdtemp(path.join(tmpdir(), 'dbm-ratekey-'));
Object.assign(process.env, { DATA_DIR: temp, BACKUP_DIR: path.join(temp, 'backups'), MASTER_KEY_FILE: path.join(temp, 'master.key'), SETUP_TOKEN_FILE: path.join(temp, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000', TRUST_PROXY: '127.0.0.1' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { clientKey } = await import('../src/auth.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const login = forwarded => fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: process.env.APP_ORIGIN, 'X-Forwarded-For': forwarded }, body: JSON.stringify({ password: 'not-the-password' }) }).then(response => response.status);

test('client key groups an IPv6 /64 and unwraps IPv4-mapped addresses; IPv4 is unchanged', () => {
  assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey('2001:db8:1:2::1'), clientKey('2001:0db8:0001:0002:ffff:eeee:dddd:cccc'));
  assert.equal(clientKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.notEqual(clientKey('2001:db8:1:2::1'), clientKey('2001:db8:1:3::1'));
  assert.equal(clientKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(clientKey('::1'), '0:0:0:0::/64');
  assert.equal(clientKey(undefined), 'unknown');
  for (const mapped of ['::ffff:cb00:7107', '0:0:0:0:0:ffff:cb00:7107', '::FFFF:CB00:7107']) assert.equal(clientKey(mapped), '203.0.113.7', mapped);
  assert.equal(clientKey('::fffe:cb00:7107'), '0:0:0:0::/64', 'only ::ffff:0:0/96 is IPv4-mapped');
});

test('the public update-progress limiter shares one budget per IPv6 /64', async () => {
  const { progressHandler, createLimiter } = await import('../src/updates/lock.js');
  const handler = progressHandler({ progress: () => ({ active: false, events: [] }) }, createLimiter({ perMinute: 3 }));
  const hit = ip => { let status = 200; const res = { set() {}, status(code) { status = code; return this; }, json() { return this; } }; handler({ ip }, res); return status; };
  assert.deepEqual([1, 2, 3, 4, 5].map(index => hit(`2001:db8:9:9::${index}`)), [200, 200, 200, 429, 429]);
  assert.equal(hit('2001:db8:9:a::1'), 200);
  assert.deepEqual([hit('::ffff:cb00:7107'), hit('::ffff:203.0.113.7'), hit('203.0.113.7'), hit('203.0.113.7')], [200, 200, 200, 429], 'mapped forms share the IPv4 budget');
});

test('sign-in rate limit cannot be reset by rotating addresses inside one IPv6 /64', async () => {
  const statuses = [];
  for (let index = 1; index <= 12; index++) statuses.push(await login(`2001:db8:5:6::${index.toString(16)}`));
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.deepEqual(statuses.slice(10), [429, 429], 'the eleventh attempt from the same /64 is limited');
  assert.equal(await login('2001:db8:5:7::1'), 401, 'a different /64 keeps its own budget');
});

test.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); await rm(temp, { recursive: true, force: true }); });
