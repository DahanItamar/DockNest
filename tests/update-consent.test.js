import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dns from 'node:dns';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
// Every outbound attempt is recorded from before the server loads: fetch, DNS lookups and socket connects.
const realFetch = globalThis.fetch, fetches = [], outbound = [];
globalThis.fetch = async url => { fetches.push(String(url)); return String(url).startsWith('https://api.github.com/') ? new Response(JSON.stringify([{ tag_name: 'v99.0.0', draft: false, prerelease: false, published_at: '2026-10-22T08:00:00Z', name: 'Future' }]), { headers: { 'content-type': 'application/json' } }) : new Response('', { status: 404 }); };
const connect = net.Socket.prototype.connect, lookup = dns.lookup;
net.Socket.prototype.connect = function (...args) { const options = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: args[1] }; if (!options.path && !['127.0.0.1', 'localhost', '::1', undefined].includes(options.host)) outbound.push(options.host); return connect.apply(this, args); };
dns.lookup = function (host, ...rest) { if (!['127.0.0.1', 'localhost', '::1'].includes(host)) outbound.push(host); return lookup.call(this, host, ...rest); };
const root = await mkdtemp(join(tmpdir(), 'docknest-update-consent-'));
Object.assign(process.env, { DATA_DIR: root, MASTER_KEY_FILE: join(root, 'master.key'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured', SECURE_COOKIES: 'false', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js');
const { db, id } = await import('../src/db.js');
const { digest, seal } = await import('../src/crypto.js');
const { tickUpdateCheck, pendingCheck } = await import('../src/updates/check.js');
const users = [id(), id(), id()], csrf = 'fixture-csrf', tokens = users.map(() => randomBytes(32).toString('base64url'));
for (const [index, user] of users.entries()) {
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(user, `${user}@example.invalid`, 'fixture', seal('JBSWY3DPEHPK3PXP'), '[]', new Date().toISOString(), `User ${index}`, index === 2 ? 'operator' : 'admin');
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(tokens[index]), user, csrf, Date.now() + 3600000, Date.now(), Date.now(), Date.now());
}
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
test.after(() => server.close());
const request = (route, { as = 0, method = 'GET', body, headers = {} } = {}) => realFetch(`http://127.0.0.1:${server.address().port}/api/updates${route}`, { method, headers: { Cookie: 'dbm_session=' + tokens[as], Origin: process.env.APP_ORIGIN, 'x-csrf-token': csrf, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const noOutbound = () => { assert.deepEqual(fetches, []); assert.deepEqual(outbound, []); };

test('before consent nothing is contacted; the routes are admin-only with CSRF, origin and body checks', async () => {
  const state = await (await request('')).json();
  assert.equal(state.state, 'consent-pending'); assert.equal(state.consent.checkEnabled, null); assert.equal(state.check, null);
  const checksOff = await request('/check', { method: 'POST' });
  assert.equal(checksOff.status, 409); assert.equal((await checksOff.json()).code, 'CHECKS_OFF');
  const pending = await request('/settings', { method: 'PATCH', body: { checkEnabled: true } });
  assert.equal(pending.status, 409); assert.equal((await pending.json()).code, 'CONSENT_PENDING');
  for (const [route, method] of [['', 'GET'], ['/consent', 'POST'], ['/settings', 'PATCH'], ['/check', 'POST']]) {
    const response = await request(route, { as: 2, method, body: method === 'GET' ? undefined : { checkEnabled: true } });
    assert.equal(response.status, 403); assert.equal((await response.json()).code, 'ADMIN_REQUIRED');
  }
  assert.equal((await request('/consent', { method: 'POST', body: { checkEnabled: true }, headers: { 'x-csrf-token': 'wrong' } })).status, 403);
  assert.equal((await request('/consent', { method: 'POST', body: { checkEnabled: true }, headers: { Origin: 'https://evil.example' } })).status, 403);
  for (const body of [{ checkEnabled: 'yes' }, {}, { checkEnabled: true, extra: 1 }]) assert.equal((await request('/consent', { method: 'POST', body })).status, 400);
  assert.equal(tickUpdateCheck({ db }, () => {}), null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM update_preferences').get().n, 0);
  noOutbound();
});

test('consent is asked once: the first answer wins, a second admin gets ALREADY_DECIDED; "No" contacts nothing', async () => {
  const first = await request('/consent', { method: 'POST', body: { checkEnabled: false } });
  assert.equal(first.status, 200); assert.equal((await first.json()).state, 'checks-off');
  const second = await request('/consent', { as: 1, method: 'POST', body: { checkEnabled: true } });
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.equal(body.code, 'ALREADY_DECIDED'); assert.equal(body.consent.checkEnabled, false); assert.equal(body.consent.decidedBy.id, users[0]);
  assert.equal((await request('/check', { method: 'POST' })).status, 409);
  assert.equal(tickUpdateCheck({ db }, () => {}), null);
  assert.deepEqual(db.prepare("SELECT actor,action,detail FROM audit_events WHERE action LIKE 'update.%'").all().map(row => ({ ...row })), [{ actor: users[0], action: 'update.consent', detail: '{"checkEnabled":false}' }]);
  noOutbound();
});

test('turning checks on checks once straight away; Check now within a minute is cached; turning off keeps the cache and stops calls', async () => {
  const on = await request('/settings', { as: 1, method: 'PATCH', body: { checkEnabled: true } });
  assert.equal(on.status, 200);
  await pendingCheck();
  assert.deepEqual(fetches, ['https://api.github.com/repos/DahanItamar/DockNest/releases?per_page=30', 'https://github.com/DahanItamar/DockNest/releases/download/v99.0.0/docknest-release.json']);
  const state = await (await request('')).json();
  assert.equal(state.state, 'update-available'); assert.equal(state.check.latest.version, 'v99.0.0'); assert.equal(state.check.latest.releaseUrl, 'https://github.com/DahanItamar/DockNest/releases/tag/v99.0.0');
  const cached = await request('/check', { method: 'POST' });
  assert.equal(cached.status, 200); assert.equal(fetches.length, 2, 'within a minute the cached result is returned');
  const off = await (await request('/settings', { method: 'PATCH', body: { checkEnabled: false } })).json();
  assert.equal(off.state, 'checks-off'); assert.equal(off.check.latest.version, 'v99.0.0'); assert.equal(off.check.nextCheckAt, null);
  assert.equal((await (await request('/check', { method: 'POST' })).json()).code, 'CHECKS_OFF');
  db.prepare('UPDATE update_checks SET next_check_at=0').run();
  assert.equal(tickUpdateCheck({ db }, () => {}), null);
  assert.equal(fetches.length, 2);
  assert.deepEqual(db.prepare("SELECT action,detail FROM audit_events WHERE action='update.settings' ORDER BY created_at").all().map(row => row.detail), ['{"checkEnabled":true}', '{"checkEnabled":false}']);
});

test('the audit entry is written in the same transaction as the settings change', async () => {
  const before = db.prepare('SELECT check_enabled FROM update_preferences WHERE id=1').get().check_enabled, count = fetches.length;
  db.exec("CREATE TRIGGER fail_settings_audit BEFORE INSERT ON audit_events WHEN NEW.action='update.settings' BEGIN SELECT RAISE(ABORT,'audit failed'); END");
  try {
    const response = await request('/settings', { method: 'PATCH', body: { checkEnabled: before !== 1 } });
    assert.ok(response.status >= 400, "the request fails when the audit cannot be written");
  } finally { db.exec('DROP TRIGGER fail_settings_audit'); }
  assert.equal(db.prepare('SELECT check_enabled FROM update_preferences WHERE id=1').get().check_enabled, before, 'the change rolled back with the failed audit');
  assert.equal(fetches.length, count);
});
