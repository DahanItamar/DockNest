import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
// A fake broker socket and fake status files drive the real server; nothing here touches GitHub, Docker or a host.
const realFetch = globalThis.fetch, fetches = [];
globalThis.fetch = async url => { fetches.push(String(url)); throw new Error('no outbound calls in this test'); };
const root = await mkdtemp(join(tmpdir(), 'docknest-update-requests-')), updaterDir = join(root, 'updater'), statusDir = join(updaterDir, 'status');
await mkdir(statusDir, { recursive: true });
const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\docknest-test-${process.pid}-${randomBytes(4).toString('hex')}` : join(updaterDir, 'updater.sock');
Object.assign(process.env, { DATA_DIR: root, MASTER_KEY_FILE: join(root, 'master.key'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured', SECURE_COOKIES: 'false', APP_ORIGIN: 'http://127.0.0.1:3000', DOCKNEST_UPDATER_DIR: updaterDir, DOCKNEST_UPDATER_SOCKET: socketPath });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app, updates } = await import('../src/server.js');
const { db, id } = await import('../src/db.js');
const { digest, seal } = await import('../src/crypto.js');
const current = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, TARGET = 'v99.0.0';

// Fake broker: records each request and answers as `answer` says (an object, a raw string, or null to drop the connection).
const received = [];
let answer = request => ({ accepted: true, id: request.id });
const broker = net.createServer({ allowHalfOpen: true }, connection => {
  const chunks = []; let handled = false;
  const reply = () => {
    if (handled) return;
    let request; try { request = JSON.parse(Buffer.concat(chunks).toString()); } catch { return; }
    handled = true; received.push(request);
    const body = answer(request); if (body === null) return connection.destroy();
    connection.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  connection.on('data', chunk => { chunks.push(chunk); reply(); });
  connection.on('end', () => { if (!chunks.length) connection.end(); });
  connection.on('error', () => {});
});
await new Promise(resolve => broker.listen(socketPath, resolve));

const csrf = 'fixture-csrf', roles = ['admin', 'admin', 'operator', 'admin', 'admin'], users = roles.map(() => id()), tokens = users.map(() => randomBytes(32).toString('base64url'));
for (const [index, user] of users.entries()) {
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(user, `${user}@example.invalid`, 'fixture', seal('JBSWY3DPEHPK3PXP'), '[]', new Date().toISOString(), `User ${index}`, roles[index]);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(tokens[index]), user, csrf, Date.now() + 3600000, Date.now(), Date.now(), index === 1 ? Date.now() - 3 * 86400000 : Date.now());
}
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
test.after(() => { server.close(); broker.close(); });
const call = (route, { as = 0, method = 'GET', body, headers = {}, anonymous = false } = {}) => realFetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { ...(anonymous ? {} : { Cookie: 'dbm_session=' + tokens[as], 'x-csrf-token': csrf }), Origin: process.env.APP_ORIGIN, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const upd = (route, options) => call('/api/updates' + route, options);
const stamp = at => new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
const put = (name, value) => writeFile(join(statusDir, name), JSON.stringify(value));
const wipe = async () => { for (const name of ['service.json', 'current.json', 'status.json']) await rm(join(statusDir, name), { force: true }); };
const service = (over = {}) => ({ schema: 1, version: '2.2.0', protocol: 1, actions: ['upgrade'], installMode: 'image', env: { docker: '27.3', os: 'ubuntu' }, blocked: false, blockedReason: null, consecutiveExit4: {}, heartbeatAt: null, requestId: null, lastResult: null, ...over });
const result = (requestId, exitCode, reason = null) => ({ requestId, exitCode, refusal: null, reason, finishedAt: stamp(Date.now()) });
const status = (requestId, over = {}) => ({ phase: 'build', from: current, to: TARGET, startedAt: stamp(Date.now() - 60000), updatedAt: stamp(Date.now() - 30000), ok: null, error: null, rollbackHint: null, requestId, warning: null, reason: null, schemaFrom: 5, schemaTo: 5, ...over });
const row = requestId => db.prepare('SELECT * FROM update_requests WHERE id=?').get(requestId);
const reset = async () => { await wipe(); db.exec('DELETE FROM update_events; DELETE FROM update_requests;'); db.prepare("DELETE FROM settings WHERE key IN ('deployment_hold','artifact_reconciliation')").run(); answer = request => ({ accepted: true, id: request.id }); received.length = 0; await updates.sync(); };
const start = async () => { const response = await upd('/requests', { method: 'POST', body: { version: TARGET } }); assert.equal(response.status, 202); const { requestId } = await response.json(); return requestId; };
const progress = async () => (await call('/api/updates/progress', { anonymous: true })).json();

db.prepare('INSERT INTO update_preferences(id,check_enabled,decided_by,decided_at) VALUES(1,1,?,?)').run(users[0], new Date().toISOString());
db.prepare("INSERT INTO update_checks(id,status,checked_at,last_success_at,next_check_at,latest_version,published_at) VALUES(1,'ok',?,?,?,?,?)").run(new Date().toISOString(), new Date().toISOString(), Date.now() + 86400000, TARGET, '2026-10-22T08:00:00Z');

test('submitting is admin-only with re-authentication, CSRF, origin and a strict body; the action is always upgrade', async () => {
  await updates.sync();
  assert.equal((await upd('/requests', { as: 2, method: 'POST', body: { version: TARGET } })).status, 403);
  assert.equal((await (await upd('/requests', { as: 1, method: 'POST', body: { version: TARGET } })).json()).code, 'REAUTH_REQUIRED');
  assert.equal((await upd('/requests', { method: 'POST', body: { version: TARGET }, headers: { 'x-csrf-token': 'wrong' } })).status, 403);
  assert.equal((await upd('/requests', { method: 'POST', body: { version: TARGET }, headers: { Origin: 'https://evil.example' } })).status, 403);
  for (const body of [{}, { version: '99' }, { version: 'v99.0.0-rc1' }, { version: TARGET, action: 'downgrade' }, { version: TARGET, allowDataRollback: true }, { version: TARGET, retryOf: 'nope' }]) assert.equal((await upd('/requests', { method: 'POST', body })).status, 400, JSON.stringify(body));
  assert.equal((await upd('/requests', { anonymous: true, method: 'POST', body: { version: TARGET } })).status, 401);
  assert.deepEqual(received, []); assert.equal(db.prepare('SELECT count(*) AS n FROM update_requests').get().n, 0);
});

test('no updater: not installed, 503 and no row; with an updater the offer appears and only the exact offer is accepted', async () => {
  let state = await (await upd('')).json();
  assert.equal(state.state, 'updater-not-installed'); assert.equal(state.updater.present, false); assert.equal(state.offer.update, null); assert.equal(state.offer.cli.command, 'scripts/upgrade.sh');
  const none = await upd('/requests', { method: 'POST', body: { version: TARGET } });
  assert.equal(none.status, 503); assert.equal((await none.json()).code, 'UPDATER_UNAVAILABLE'); assert.equal(db.prepare('SELECT count(*) AS n FROM update_requests').get().n, 0);
  await put('service.json', service());
  state = await (await upd('')).json();
  assert.equal(state.state, 'update-available'); assert.equal(state.offer.update.version, TARGET); assert.equal(state.updater.present, true); assert.equal(state.updater.supported, true); assert.equal(state.active, null);
  for (const version of ['v98.0.0', 'v100.0.0']) { const wrong = await upd('/requests', { method: 'POST', body: { version } }); assert.equal(wrong.status, 409); assert.equal((await wrong.json()).code, 'NOT_OFFERED'); }
  await put('service.json', service({ protocol: 2 }));
  assert.equal((await (await upd('')).json()).offer.cli.reason, 'updater-outdated');
  await put('service.json', service());
  assert.deepEqual(received, []);
});

test('a request is accepted: exact schema 1 fields, a submitted row with the run values copied, a second request refused', async () => {
  const response = await upd('/requests', { method: 'POST', body: { version: TARGET } });
  assert.equal(response.status, 202);
  const { requestId } = await response.json();
  assert.equal(received.length, 1);
  assert.deepEqual(Object.keys(received[0]).sort(), ['action', 'id', 'requestedAt', 'requestedBy', 'schema', 'version']);
  assert.deepEqual({ ...received[0], id: 'x', requestedAt: 'x' }, { schema: 1, id: 'x', action: 'upgrade', version: TARGET, requestedBy: users[0], requestedAt: 'x' });
  assert.equal(received[0].id, requestId);
  const saved = row(requestId);
  assert.equal(saved.state, 'submitted'); assert.equal(saved.from_version, current); assert.equal(saved.to_version, TARGET); assert.equal(saved.requested_by, users[0]);
  assert.equal(saved.install_mode, 'image'); assert.equal(saved.updater_version, '2.2.0'); assert.deepEqual(JSON.parse(saved.env), { docker: '27.3', os: 'ubuntu' }); assert.ok(saved.accepted_at);
  assert.deepEqual(db.prepare("SELECT action,target FROM audit_events WHERE action='updater.requested'").all().map(item => ({ ...item })), [{ action: 'updater.requested', target: requestId }]);
  const again = await upd('/requests', { method: 'POST', body: { version: TARGET } });
  assert.equal(again.status, 423, 'a second request meets the lock'); assert.equal(received.length, 1);
  const state = await (await upd('')).json();
  assert.equal(state.state, 'update-in-progress'); assert.equal(state.active.requestId, requestId); assert.equal(state.active.state, 'submitted');
});

test('while an update runs every endpoint answers 423 except the exact exempt list, which keeps its own checks', async () => {
  const locked = async (route, options) => { const response = await call(route, options); assert.equal(response.status, 423, route); assert.deepEqual(await response.json(), { error: 'UPDATE_IN_PROGRESS' }); };
  for (const route of ['/api/state', '/api/servers', '/api/backups', '/api/updates/check', '/api/updates/consent', '/api/updates/history', '/api/access/users', '/api/self-backup/status', '/api/nope']) await locked(route);
  for (const [route, method] of [['/api/auth/login', 'POST'], ['/api/auth/setup', 'POST'], ['/api/updates/requests', 'POST'], ['/api/updates/settings', 'PATCH'], ['/api/auth/reauth', 'POST'], ['/api/auth/activity', 'POST'], ['/api/auth/verify', 'POST']]) await locked(route, { method, body: {} });
  for (const route of ['/API/state', '/api/updates/', '/api/updates/status/', '/api/auth/status/', '/api/updates%2Fstatus']) await locked(route, { anonymous: true });
  await locked('/api/auth/logout', { method: 'GET' }); await locked('/api/updates/requests/' + id() + '/acknowledge', { method: 'GET' }); await locked('/api/updates', { method: 'POST', body: {} });
  for (const route of ['/api/version', '/api/updates/progress', '/api/auth/status']) assert.equal((await call(route, { anonymous: true })).status, 200, route);
  assert.equal((await call('/healthz', { anonymous: true })).status, 200);
  assert.equal((await upd('')).status, 200); assert.equal((await upd('/status')).status, 200);
  assert.equal((await upd('', { anonymous: true })).status, 401, 'exempt routes keep their session check'); assert.equal((await upd('', { as: 2 })).status, 403, 'and their admin check');
  const ack = await upd('/requests/' + id() + '/acknowledge', { method: 'POST' });
  assert.equal(ack.status, 409, 'the acknowledge route is reached (not 423) and refuses an unknown id');
  assert.equal((await upd('/requests/' + id() + '/acknowledge', { method: 'POST', headers: { 'x-csrf-token': 'wrong' } })).status, 403, 'CSRF still applies');
  assert.equal((await upd('/requests/' + id() + '/acknowledge', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403, 'origin still applies');
  const logout = await call('/api/auth/logout', { as: 4, method: 'POST' });
  assert.equal(logout.status, 204, 'signing out stays possible'); assert.equal((await call('/api/auth/status', { as: 4 })).status, 200);
  assert.equal((await call('/api/auth/logout', { as: 4, method: 'POST' })).status, 401, 'and needs a session');
});

test('the public progress shows only the allowed fields and never the request id, user, error text or hint', async () => {
  const requestId = db.prepare("SELECT id FROM update_requests WHERE state='submitted'").get().id;
  await put('service.json', service({ requestId, heartbeatAt: stamp(Date.now()) }));
  await put('current.json', { requestId, target: TARGET, acceptedAt: stamp(Date.now() - 20000), events: [{ phase: 'verify', at: stamp(Date.now() - 20000) }, { phase: 'bogus', at: stamp(Date.now() - 19000) }, { phase: 'preflight', at: 'yesterday' }, { phase: 'fetch', at: stamp(Date.now() - 10000) }, { phase: 'idle', at: stamp(Date.now() - 15000), secret: 'leak' }], truncated: true });
  await put('status.json', status(requestId, { phase: 'fetch', error: 'SECRET-ERROR-TEXT /srv/private', rollbackHint: 'SECRET-HINT run rm', warning: 'SECRET-WARNING', secret: 'unknown-field' }));
  await updates.sync();
  const before = db.prepare('SELECT total_changes() AS n').get().n, response = await call('/api/updates/progress', { anonymous: true }), body = await response.json();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(body), ['active', 'phase', 'to', 'state', 'stale', 'updatedAt', 'events']);
  assert.deepEqual({ active: body.active, phase: body.phase, to: body.to, state: body.state, stale: body.stale }, { active: true, phase: 'fetch', to: TARGET, state: 'running', stale: false });
  assert.deepEqual(body.events.map(event => event.phase), ['verify', 'fetch'], 'unknown phases, bad times and out-of-order events are dropped');
  for (const event of body.events) assert.deepEqual(Object.keys(event), ['phase', 'at']);
  const text = JSON.stringify(body);
  for (const secret of [requestId, users[0], 'SECRET', 'leak', 'unknown-field', 'truncated', 'Test', '@example']) assert.ok(!text.includes(secret), secret);
  for (let index = 0; index < 20; index++) await call('/api/updates/progress', { anonymous: true });
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before, 'serving progress writes nothing');
  const admin = await (await upd('/status')).json();
  assert.equal(admin.requestId, requestId); assert.equal(admin.state, 'running'); assert.equal(admin.warning, 'SECRET-WARNING'); assert.equal(admin.error, null);
  // Additive report fields (docs/update-center.md section 7.1): typed values only, events as {phase, at}.
  assert.deepEqual(admin.events.map(event => Object.keys(event).sort()), admin.events.map(() => ['at', 'phase']));
  for (const key of ['reason', 'refusal', 'installMode', 'updaterVersion', 'env', 'fromSchema', 'toSchema', 'acceptedAt']) assert.ok(key in admin, key);
  assert.equal(admin.secret, undefined);
  assert.equal(row(requestId).state, 'running');
  assert.deepEqual(db.prepare('SELECT phase FROM update_events WHERE request_id=? ORDER BY at').all(requestId).map(event => event.phase), ['verify', 'fetch']);
});

test('events of another request are ignored, and a status of another request is never shown as current', async () => {
  const requestId = db.prepare("SELECT id FROM update_requests WHERE state='running'").get().id;
  await put('current.json', { requestId: id(), target: TARGET, acceptedAt: stamp(Date.now()), events: [{ phase: 'done', at: stamp(Date.now()) }], truncated: false });
  await put('status.json', status(id(), { phase: 'done', ok: true }));
  await updates.sync();
  assert.equal(row(requestId).state, 'running'); assert.equal((await progress()).state, 'running');
});

test('success: the lastResult closes the row, copies the schema, and the lock ends', async () => {
  const requestId = db.prepare("SELECT id FROM update_requests WHERE state='running'").get().id;
  await put('current.json', { requestId, target: TARGET, acceptedAt: stamp(Date.now() - 90000), events: [{ phase: 'verify', at: stamp(Date.now() - 80000) }, { phase: 'done', at: stamp(Date.now() - 5000) }], truncated: false });
  await put('status.json', status(requestId, { phase: 'done', ok: true, schemaFrom: 5, schemaTo: 6, warning: 'kept two folders' }));
  await put('service.json', service({ lastResult: result(requestId, 0) }));
  await updates.sync();
  const saved = row(requestId);
  assert.equal(saved.state, 'succeeded'); assert.equal(saved.exit_code, 0); assert.equal(saved.to_schema, 6); assert.equal(saved.warning, 'kept two folders'); assert.ok(saved.finished_at);
  assert.equal((await call('/api/state')).status, 200, 'the lock ended');
  const done = await progress();
  assert.equal(done.active, false); assert.equal(done.state, 'succeeded'); assert.equal(done.events.at(-1).phase, 'done');
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='updater.finished'").get().n, 1);
});

test('exit codes map to outcomes; exit 4 can be retried once and a second exit 4 blocks that target', async () => {
  await reset(); await put('service.json', service());
  const outcomes = [[1, 'refused', 'not_changed'], [2, 'refused', 'not_changed'], [3, 'busy', 'not_changed'], [4, 'rolled_back', 'rolled_back']];
  for (const [code, state, pub] of outcomes) {
    await put('service.json', service()); const requestId = await start();
    await put('status.json', status(requestId, { phase: 'failed', ok: false, error: 'boom', rollbackHint: 'cd /srv', reason: 'health-timeout' }));
    await put('service.json', service({ consecutiveExit4: code === 4 ? { [TARGET]: 1 } : {}, lastResult: result(requestId, code, 'health-timeout') }));
    await updates.sync();
    assert.equal(row(requestId).state, state, 'exit ' + code); assert.equal(row(requestId).exit_code, code); assert.equal(row(requestId).reason, 'health-timeout');
    assert.equal((await progress()).state, pub); assert.equal((await call('/api/state')).status, 200);
    if (code === 4) {
      const offer = await (await upd('')).json();
      assert.deepEqual(offer.retry, { requestId, version: TARGET, allowed: true }); assert.equal(offer.state, 'update-available');
      assert.equal((await upd('/requests', { method: 'POST', body: { version: TARGET, retryOf: id() } })).status, 409);
      await put('service.json', service());
      const retried = await start(); assert.equal(row(retried).state, 'submitted');
      await put('service.json', service({ consecutiveExit4: { [TARGET]: 2 }, blocked: true, blockedReason: 'repeated-rollback', lastResult: result(retried, 4) }));
      await updates.sync();
      const blocked = await (await upd('')).json();
      assert.equal(blocked.state, 'updater-blocked'); assert.equal(blocked.offer.update, null); assert.equal(blocked.offer.blocked.code, 'UPDATER_BLOCKED');
      assert.equal((await upd('/requests', { method: 'POST', body: { version: TARGET } })).status, 409);
    }
  }
});

test('exit 5 or 6 and an interrupted run need action: the lock stays until the broker shows blocked:false, and acknowledge never ends it', async () => {
  for (const code of [5, null]) {
    await reset(); await put('service.json', service()); const requestId = await start();
    await put('current.json', { requestId, target: TARGET, acceptedAt: stamp(Date.now() - 600000), events: [{ phase: 'verify', at: stamp(Date.now() - 600000) }], truncated: false });
    await put('status.json', status(requestId, { phase: 'failed', ok: false, error: 'unhealthy', rollbackHint: 'git checkout v2.1.0', updatedAt: stamp(Date.now() - 400000) }));
    await put('service.json', service({ blocked: true, blockedReason: code === 5 ? 'exit-5' : 'interrupted', lastResult: result(requestId, code, code ? null : 'interrupted') }));
    await updates.sync();
    assert.equal(row(requestId).state, 'needs_action'); assert.equal(row(requestId).rollback_hint, 'git checkout v2.1.0');
    const body = await progress();
    assert.equal(body.active, true); assert.equal(body.state, 'needs_action'); assert.ok(!JSON.stringify(body).includes('git checkout'));
    assert.equal((await call('/api/state')).status, 423);
    assert.equal((await upd('')).status, 200); assert.equal((await (await upd('')).json()).state, 'updater-blocked');
    assert.equal((await upd(`/requests/${requestId}/acknowledge`, { method: 'POST' })).status, 409, 'never for needs_action');
    await put('current.json', { requestId, target: TARGET, acceptedAt: stamp(Date.now() - 9 * 3600000), events: [], truncated: false });
    await updates.sync(); assert.equal(row(requestId).state, 'needs_action', 'age alone never ends it');
    await rm(join(statusDir, 'service.json')); await updates.sync(); await updates.sync();
    assert.equal(row(requestId).state, 'needs_action', 'no service.json keeps the lock'); assert.equal((await call('/api/state')).status, 423);
    await put('service.json', service({ blocked: true, blockedReason: 'exit-5', lastResult: result(requestId, code) })); await updates.sync();
    assert.equal(row(requestId).state, 'needs_action', 'still blocked');
    await put('service.json', service({ blocked: false, lastResult: result(requestId, code) })); await updates.sync(); await updates.sync();
    assert.equal(row(requestId).state, 'resolved'); assert.equal((await call('/api/state')).status, 200);
    assert.equal((await progress()).state, 'resolved');
  }
});

test('a status that ended without a broker result is read after a short wait: failed is needs action, done is success', async () => {
  await reset(); await put('service.json', service()); const requestId = await start();
  await put('status.json', status(requestId, { phase: 'failed', ok: false, updatedAt: stamp(Date.now() - 1000) })); await updates.sync();
  assert.equal(row(requestId).state, 'running', 'the broker may still be about to publish lastResult');
  await put('status.json', status(requestId, { phase: 'failed', ok: false, updatedAt: stamp(Date.now() - 60000) })); await updates.sync();
  assert.equal(row(requestId).state, 'needs_action');
});

test('stale: no heartbeat for 2 minutes or no phase change for 15 (45 in build); only then can an admin close the record', async () => {
  await reset(); await put('service.json', service()); const requestId = await start();
  const fresh = async (over = {}) => { db.exec('DELETE FROM update_events'); await put('current.json', { requestId, target: TARGET, acceptedAt: stamp(Date.now() - 3600000), events: [{ phase: 'verify', at: stamp(Date.now() - 3600000) }, { phase: over.phase ?? 'fetch', at: stamp(Date.now() - (over.age ?? 60000)) }], truncated: false }); };
  await fresh(); await put('status.json', status(requestId, { phase: 'fetch' })); await put('service.json', service({ requestId, heartbeatAt: stamp(Date.now() - 10000) })); await updates.sync();
  assert.equal((await progress()).stale, false);
  assert.equal((await upd(`/requests/${requestId}/acknowledge`, { method: 'POST' })).status, 409, 'a healthy request cannot be closed');
  await put('service.json', service({ requestId, heartbeatAt: stamp(Date.now() - 200000) })); await updates.sync();
  assert.equal((await progress()).stale, true, 'no heartbeat for 2 minutes');
  await put('service.json', service({ requestId, heartbeatAt: stamp(Date.now()) })); await fresh({ age: 16 * 60000 }); await updates.sync();
  assert.equal((await progress()).stale, true, 'no phase change for 15 minutes');
  await fresh({ phase: 'build', age: 16 * 60000 }); await put('status.json', status(requestId, { phase: 'build' })); await updates.sync();
  assert.equal((await progress()).stale, false, 'build gets 45 minutes');
  await fresh({ phase: 'build', age: 46 * 60000 }); await updates.sync(); assert.equal((await progress()).stale, true);
  assert.equal(row(requestId).state, 'running', 'stale does not end the request by itself');
  assert.equal((await call('/api/state')).status, 423);
  const closed = await upd(`/requests/${requestId}/acknowledge`, { method: 'POST' });
  assert.equal(closed.status, 200); assert.equal(row(requestId).state, 'lost'); assert.equal((await call('/api/state')).status, 200); assert.equal((await progress()).state, 'lost');
});

const ago = ms => new Date(Date.now() - ms).toISOString();
test('a submitted request the broker never ran: lost after 10 minutes while the broker is alive, after the hard stop plus 5 minutes when it is not', async () => {
  const submitted = async (publish) => { await reset(); await put('service.json', service()); const requestId = await start(); if (publish) await publish(requestId); else await rm(join(statusDir, 'service.json')); return requestId; };
  const age = async (requestId, ms) => { db.prepare('UPDATE update_requests SET requested_at=? WHERE id=?').run(ago(ms), requestId); await updates.sync(); return row(requestId).state; };
  // (a) idle broker (no run, so no heartbeat by design) or a fresh heartbeat on another run: it never carried this id.
  for (const publish of [async () => put('service.json', service()), async () => put('service.json', service({ requestId: id(), heartbeatAt: stamp(Date.now()) }))]) {
    const requestId = await submitted(publish);
    assert.equal(await age(requestId, 9 * 60000), 'submitted', 'inside 10 minutes'); assert.equal((await call('/api/state')).status, 423);
    assert.equal(await age(requestId, 11 * 60000), 'lost'); assert.equal((await call('/api/state')).status, 200);
  }
  // A trace of the id (status or current) means it ran: never the never-ran rule.
  let requestId = await submitted(async () => put('service.json', service()));
  await put('status.json', status(requestId, { phase: 'fetch' })); assert.equal(await age(requestId, 11 * 60000), 'running');
  // (b) no service.json, or a heartbeat that stopped: nothing can still run past the hard stop plus 5 minutes.
  for (const publish of [null, async () => put('service.json', service({ requestId: id(), heartbeatAt: stamp(Date.now() - 600000) }))]) {
    requestId = await submitted(publish);
    assert.equal(await age(requestId, 11 * 60000), 'submitted', 'a dead broker is not given up on after 10 minutes');
    assert.equal(await age(requestId, (2 * 3600 + 19 * 60) * 1000), 'submitted', 'inside the hard stop plus 5 minutes');
    assert.equal(await age(requestId, (2 * 3600 + 21 * 60) * 1000), 'lost'); assert.equal((await call('/api/state')).status, 200);
  }
  await reset();
});

test('an admin can close a stale submitted request (same rules as running); a fresh or healthy one cannot be closed', async () => {
  await reset(); await put('service.json', service()); let requestId = await start();
  const ack = (as = 0, headers = {}) => upd(`/requests/${requestId}/acknowledge`, { as, method: 'POST', headers });
  assert.equal((await ack()).status, 409, 'just submitted'); await rm(join(statusDir, 'service.json')); await updates.sync();
  assert.equal((await ack()).status, 409, 'no updater but under 2 minutes is not stale');
  db.prepare('UPDATE update_requests SET requested_at=? WHERE id=?').run(ago(3 * 60000), requestId); await updates.sync();
  assert.equal((await progress()).stale, true); assert.equal((await progress()).state, 'running');
  assert.equal((await ack(2)).status, 403, 'admin only'); assert.equal((await ack(0, { 'x-csrf-token': 'wrong' })).status, 403); assert.equal((await ack(0, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await upd(`/requests/${id()}/acknowledge`, { method: 'POST' })).status, 409, 'only the active id');
  assert.equal((await ack()).status, 200); assert.equal(row(requestId).state, 'lost'); assert.equal((await call('/api/state')).status, 200);
  await reset(); await put('service.json', service()); requestId = await start();
  db.prepare('UPDATE update_requests SET requested_at=? WHERE id=?').run(ago(5 * 60000), requestId); await updates.sync();
  assert.equal((await progress()).stale, false, 'an idle live broker is not stale'); assert.equal((await ack()).status, 409); assert.equal(row(requestId).state, 'submitted');
  await reset();
});

test('lost on its own only past the hard stop plus 5 minutes from the broker acceptedAt; never from requested_at', async () => {
  await reset(); await put('service.json', service()); let requestId = await start();
  await reset(); await put('service.json', service()); requestId = await start();
  const current = (accepted, last) => put('current.json', { requestId, target: TARGET, acceptedAt: stamp(accepted), events: [{ phase: 'verify', at: stamp(accepted) }, { phase: 'build', at: stamp(last) }], truncated: false });
  await put('service.json', service({ requestId, heartbeatAt: stamp(Date.now() - 600000) }));
  await current(Date.now() - 3600000, Date.now() - 3000000); await updates.sync();
  assert.equal(row(requestId).state, 'running', 'stale but inside the broker hard stop');
  await current(Date.now() - (2 * 3600 + 15 * 60 + 4 * 60) * 1000, Date.now() - 3000000); await updates.sync();
  assert.equal(row(requestId).state, 'running', 'four minutes past the grace is not enough');
  await put('service.json', service({ requestId, heartbeatAt: stamp(Date.now()) })); await current(Date.now() - 4 * 3600000, Date.now() - 20000); await updates.sync();
  assert.equal(row(requestId).state, 'running', 'a live heartbeat with recent progress is never closed');
  await put('service.json', service({ requestId, heartbeatAt: stamp(Date.now() - 600000) })); await current(Date.now() - (2 * 3600 + 21 * 60) * 1000, Date.now() - 3000000); await updates.sync();
  assert.equal(row(requestId).state, 'lost'); assert.equal((await call('/api/state')).status, 200);
});

test('reconciliation: the traces are gone but the running version is the target, so the request succeeded', async () => {
  await reset(); const requestId = id();
  db.prepare("INSERT INTO update_requests(id,from_version,to_version,from_schema,requested_by,requested_at,state) VALUES(?,?,?,?,?,?,'running')").run(requestId, '2.0.0', 'v' + current, 4, users[0], new Date(Date.now() - 600000).toISOString());
  await updates.sync();
  assert.equal(row(requestId).state, 'succeeded'); assert.equal(row(requestId).exit_code, 0);
  await reset(); const other = id();
  db.prepare("INSERT INTO update_requests(id,from_version,to_version,from_schema,requested_by,requested_at,state) VALUES(?,?,?,?,?,?,'running')").run(other, '2.0.0', 'v98.0.0', 4, users[0], new Date(Date.now() - 600000).toISOString());
  await updates.sync(); assert.equal(row(other).state, 'running', 'a different target is not reconciled');
  await reset();
});

test('broker refusals map to their codes, finish the row as refused and release the lock', async () => {
  const expected = { 'needs-host-ack': [409, 'UPDATER_BLOCKED'], 'state-mismatch': [409, 'UPDATER_STATE_MISMATCH'], 'low-disk': [409, 'UPDATER_LOW_DISK'], busy: [409, 'UPDATER_BUSY'], duplicate: [409, 'UPDATER_BUSY'], invalid: [409, 'UPDATER_REFUSED'], 'version-refused': [409, 'UPDATER_REFUSED'], stale: [409, 'UPDATER_REFUSED'], 'rate-limited': [429, 'UPDATER_RATE_LIMITED'] };
  for (const [refusal, [status, code]] of Object.entries(expected)) {
    await reset(); await put('service.json', service()); answer = () => ({ accepted: false, code: refusal });
    const response = await upd('/requests', { method: 'POST', body: { version: TARGET } }), body = await response.json();
    assert.equal(response.status, status, refusal); assert.equal(body.code, code); assert.equal(body.refusal, refusal);
    const saved = db.prepare('SELECT state,refusal FROM update_requests').get(); assert.deepEqual({ ...saved }, { state: 'refused', refusal });
    assert.equal((await call('/api/state')).status, 200);
  }
  await reset(); await put('service.json', service()); answer = () => ({ accepted: false, code: 'made-up' });
  assert.equal((await upd('/requests', { method: 'POST', body: { version: TARGET } })).status, 503, 'an unknown refusal code is not trusted');
  assert.equal(db.prepare('SELECT state FROM update_requests').get().state, 'submitted', 'the request was delivered; it stays until the broker shows otherwise');
});

test('an updater that never answers or is unreachable gives 503; only a request that never reached it is refused', async () => {
  await reset(); await put('service.json', service()); answer = () => null;
  const dropped = await upd('/requests', { method: 'POST', body: { version: TARGET } });
  assert.equal(dropped.status, 503); assert.equal(db.prepare('SELECT state FROM update_requests').get().state, 'submitted');
  await reset(); await put('service.json', service()); answer = request => ({ accepted: true, id: id() });
  assert.equal((await upd('/requests', { method: 'POST', body: { version: TARGET } })).status, 503, 'an answer for another id is invalid'); await reset();
  await new Promise(resolve => broker.close(resolve));
  await put('service.json', service());
  const down = await upd('/requests', { method: 'POST', body: { version: TARGET } });
  assert.equal(down.status, 503); assert.deepEqual({ ...db.prepare('SELECT state,refusal FROM update_requests').get() }, { state: 'refused', refusal: 'unavailable' });
  await new Promise(resolve => broker.listen(socketPath, resolve)); await reset();
});

test('a deployment hold or a pending recovery review disables the offer and refuses the request; the check stays advisory', async () => {
  await reset(); await put('service.json', service());
  db.prepare("INSERT INTO settings VALUES('deployment_hold','true') ON CONFLICT(key) DO UPDATE SET value='true'").run();
  let state = await (await upd('')).json();
  assert.equal(state.state, 'update-available'); assert.equal(state.offer.update.version, TARGET); assert.equal(state.offer.blocked.code, 'UPDATE_ON_HOLD');
  assert.equal((await (await upd('/requests', { method: 'POST', body: { version: TARGET } })).json()).code, 'UPDATE_ON_HOLD');
  db.prepare("DELETE FROM settings WHERE key='deployment_hold'").run();
  db.prepare("INSERT INTO settings VALUES('artifact_reconciliation',?)").run(JSON.stringify({ pending: true }));
  state = await (await upd('')).json(); assert.equal(state.offer.blocked.code, 'RECOVERY_REVIEW_REQUIRED');
  assert.equal((await (await upd('/requests', { method: 'POST', body: { version: TARGET } })).json()).code, 'RECOVERY_REVIEW_REQUIRED');
  assert.equal(received.length, 0); await reset();
  await put('service.json', service({ blocked: true, blockedReason: 'exit-6' })); state = await (await upd('')).json();
  assert.equal(state.state, 'updater-blocked'); assert.equal(state.updater.status, 'blocked');
  assert.equal((await upd('/requests', { method: 'POST', body: { version: TARGET } })).status, 409);
  db.prepare("INSERT INTO update_requests(id,from_version,to_version,from_schema,requested_by,requested_at,state,refusal,finished_at) VALUES(?,?,?,?,?,?,'refused','state-mismatch',?)").run(id(), current, TARGET, 5, users[0], new Date().toISOString(), new Date().toISOString());
  await put('service.json', service()); state = await (await upd('')).json();
  assert.equal(state.state, 'updater-state-mismatch'); await reset();
});

test('/api/state carries update.available for administrators only, from the cache', async () => {
  const admin = await (await call('/api/state')).json(), operator = await (await call('/api/state', { as: 2 })).json();
  assert.deepEqual(admin.update, { available: TARGET }); assert.ok(!('update' in operator));
  assert.deepEqual(fetches, []);
});

test('history lists in-app runs and command-line versions, newest first, with a cursor; admin only', async () => {
  await reset();
  const insert = (requestId, version, state, at) => db.prepare('INSERT INTO update_requests(id,from_version,to_version,from_schema,requested_by,requested_at,finished_at,state) VALUES(?,?,?,?,?,?,?,?)').run(requestId, '2.0.0', version, 4, users[0], at, at, state);
  const a = id(), b = id();
  insert(a, 'v2.5.0', 'rolled_back', '2099-01-01T00:00:00.000Z'); insert(b, 'v2.6.0', 'succeeded', '2099-02-01T00:00:00.000Z');
  db.prepare("INSERT OR IGNORE INTO release_history(version,schema_version,first_started_at,last_started_at) VALUES('2.6.0',6,'2099-02-01T00:00:00.000Z','2099-02-01T00:00:00.000Z'),('2.0.5',4,'2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z')").run();
  const all = await (await upd('/history')).json();
  assert.deepEqual(all.items.slice(0, 2).map(item => [item.id, item.version, item.outcome, item.source]), [[b, 'v2.6.0', 'installed', 'in-app'], [a, 'v2.5.0', 'rolled_back', 'in-app']]);
  assert.ok(all.items.some(item => item.id === null && item.version === '2.0.5' && item.source === 'cli' && item.outcome === 'installed'));
  assert.ok(!all.items.some(item => item.source === 'cli' && item.version === '2.6.0'), 'a version an in-app run installed is not listed twice');
  for (const item of all.items) assert.deepEqual(Object.keys(item), ['id', 'version', 'at', 'outcome', 'source']);
  const first = await (await upd('/history?limit=1')).json();
  assert.equal(first.items.length, 1); assert.ok(first.next);
  const second = await (await upd('/history?limit=1&cursor=' + first.next)).json();
  assert.equal(second.items[0].id, a);
  assert.equal((await upd('/history?cursor=garbage')).status, 400); assert.equal((await upd('/history', { as: 2 })).status, 403);
  // One past request's admin status, for its Recent updates report: same fields as /status, admin only.
  const one = await (await upd('/requests/' + a)).json(), latest = await (await upd('/status')).json();
  assert.equal(one.requestId, a); assert.equal(one.state, 'rolled_back'); assert.equal(one.to, 'v2.5.0');
  assert.deepEqual(Object.keys(one).sort(), Object.keys(latest).sort());
  assert.equal((await upd('/requests/no-such-request')).status, 404); assert.equal((await upd('/requests/' + a, { as: 2 })).status, 403);
  await reset();
});

test('the progress limiter is in memory, per client address, and ignores X-Forwarded-For from an untrusted peer', async () => {
  const codes = [];
  for (let index = 0; index < 150; index++) codes.push((await call('/api/updates/progress', { anonymous: true, headers: { 'X-Forwarded-For': `203.0.113.${index}` } })).status);
  assert.ok(codes.includes(429), 'rotating forwarded addresses does not escape the limit'); assert.ok(codes.filter(code => code === 200).length <= 120);
  const limited = await call('/api/updates/progress', { anonymous: true });
  assert.equal(limited.status, 429); assert.ok(limited.headers.get('retry-after')); assert.equal(limited.headers.get('cache-control'), 'no-store');
});

test('a request that appears between the check and the submit is refused by the server state and the unique index', async () => {
  await reset(); await put('service.json', service()); await updates.sync();
  const insert = state => db.prepare("INSERT INTO update_requests(id,from_version,to_version,from_schema,requested_by,requested_at,state) VALUES(?,?,?,?,?,?,?)").run(id(), current, TARGET, 5, users[0], new Date().toISOString(), state);
  insert('running');
  const response = await upd('/requests', { method: 'POST', body: { version: TARGET } });
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'UPDATE_IN_PROGRESS'); assert.equal(received.length, 0);
  assert.throws(() => insert('submitted'), /UNIQUE|constraint/i);
  await reset();
});
