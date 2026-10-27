// Restore test API, scheduler and alerts (docs/restore-tests.md, "API contract", "Which backup and when", "Alerts"):
// roles, CSRF, re-verification, validation codes, the manual rate limit, the card and detail shapes the UI builds on
// (web/restore-tests/restore-tests-client.js), per-backup state, the schedule's due times and skips, and alert events.
// The helper is faked; real Docker is covered by scripts/integration-restore-test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-restore-tests-api-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const { claimJob, executeJob } = await import('../src/engine.js');
const rt = await import('../src/restore-tests/engine.js');
const scheduler = await import('../src/restore-tests/scheduler.js');
const settingsModule = await import('../src/restore-tests/settings.js');
const detect = await import('../src/alerts/detect.js');
const store = await import('../src/alerts/store.js');
const events = await import('../src/alerts/events.js');
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;

let now = Date.parse('2026-11-02T08:00:00.000Z');
rt.testTransport.now = () => now;
const at = () => new Date(now).toISOString();
let answers = {};
const name = request => request.operation + (request.phase ? ':' + request.phase : '');
rt.testTransport.remote = async (_server, request) => {
  if (answers[name(request)]) return answers[name(request)](request);
  switch (name(request)) {
    case 'restore-test-check': return { ok: true, problems: [], facts: { nproc: 2, probeTools: true } };
    case 'restore-test-prepare': return { root: '/x', remotePath: '/x/p', reaper: true };
    case 'restore-test-run:restore': return { outcome: 'ok', kind: 'docker', containers: 1, running: 1, networkMode: 'isolated-internal', checks: [] };
    case 'restore-test-run:start': return { outcome: 'ok', started: 1 };
    case 'restore-test-run:poll': return request.final ? { outcome: 'ok', healthy: true, running: 1, checks: [{ name: 'Containers running', kind: 'running', target: null, status: 'passed', detail: '1 running' }] } : { outcome: 'ok', healthy: true, running: 1 };
    case 'restore-test-teardown': return { removed: true, counts: { containers: 1 }, keptImages: 0 };
    case 'restore-test-status': return { present: false };
    default: throw new Error('unexpected ' + name(request));
  }
};
rt.testTransport.upload = async (_server, _backupId, _jobId, { prepare }) => { await prepare(); return { plaintextChecksum: 'f'.repeat(64) }; };
rt.testTiming.scale = 0.001;

function user(role, authenticatedAt = Date.now(), csrfHeader = true) {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId, userId + '@example.invalid', 'fixture', 'fixture', '[]', new Date().toISOString(), role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), userId, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), authenticatedAt);
  const call = (method, route, body) => fetch(base + route, { method, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, ...(csrfHeader ? { 'x-csrf-token': 'csrf' } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  call.id = userId;
  return call;
}
const admin = user('admin'), staleAdmin = user('admin', Date.now() - 3600000), operator = user('operator'), noCsrf = user('admin', Date.now(), false);
const json = async response => ({ status: response.status, body: await response.json() });

function serverRow(label, capabilities = null) {
  const serverId = randomUUID();
  db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at,capabilities) VALUES(?,?,?,?,?,?,?,?,?)').run(serverId, label, '192.0.2.10', 22, 'root', 'fixture', '0'.repeat(64), at(), capabilities ? JSON.stringify(capabilities) : null);
  return serverId;
}
const dockerManifest = { kind: 'docker', architecture: 'x86_64', containers: [{ Name: '/shop-db', State: { Running: true }, Config: { ExposedPorts: { '5432/tcp': {} } } }, { Name: '/shop-web', State: { Running: true }, Config: { ExposedPorts: { '8080/tcp': {}, '9000/tcp': {} } } }] };
function backupRow(siteId, manifest = dockerManifest, capturedAt = at()) {
  const jobId = randomUUID(), backupId = randomUUID();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,started_at,finished_at) VALUES(?,?,'backup','completed','completed',?,?,?)").run(jobId, siteId, at(), at(), at());
  db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(backupId, siteId, jobId, capturedAt, join(directory, backupId + '.enc'), 4096, 'a'.repeat(64), JSON.stringify(manifest), 0, 1, at());
  return backupId;
}
function fixture(label = 'shop', { kind = 'docker', backup = true, policy = null } = {}) {
  const live = serverRow(label + '-live'), testServer = serverRow(label + '-test'), siteId = randomUUID();
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, live, label, JSON.stringify(kind === 'static' ? { kind: 'static', containers: [] } : { containers: ['shop-web', 'shop-db'] }), at());
  db.prepare('INSERT INTO policies VALUES (?,?,?,?,7,?)').run(siteId, policy ? 1 : 0, '0 2 * * *', 'UTC', policy);
  const backupId = backup ? backupRow(siteId, kind === 'static' ? { kind: 'static', containers: [] } : dockerManifest) : null;
  return { live, testServer, siteId, backupId };
}
const good = (serverId, extra = {}) => ({ enabled: true, cadence: 'weekly', serverId, allowLiveServer: false, allowInternet: false, timeLimitMinutes: 30, memoryMb: 1024, cpus: 1, probe: null, ...extra });
const put = (as, siteId, body) => as('PUT', `/sites/${siteId}/restore-tests/settings`, body).then(json);
async function drive(testId, rounds = 300) {
  for (let round = 0; round < rounds; round++) {
    const row = rt.loadTest(testId);
    if (row.result !== null && ['done', 'failed', 'acknowledged'].includes(row.cleanup)) return row;
    rt.tickRestoreTests();
    const job = claimJob();
    if (job) await executeJob(job); else now += 1000;
  }
  return rt.loadTest(testId);
}

test('upgrade safety: a site without settings is off, and its card is empty', async () => {
  const { siteId } = fixture('fresh');
  const card = await json(await operator('GET', `/sites/${siteId}/restore-tests`));
  assert.equal(card.status, 200);
  assert.deepEqual(card.body, { settings: { enabled: false, cadence: 'weekly', serverId: null, allowLiveServer: false, allowInternet: false, timeLimitMinutes: 30, memoryMb: 1024, cpus: 1, probe: null, nextDueAt: null, skipReason: null }, last: null, active: null, items: [], next: null });
  assert.equal(scheduler.tickRestoreTestSchedule(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM restore_tests WHERE site_id=?').get(siteId).n, 0);
  assert.equal((await operator('GET', `/sites/${randomUUID()}/restore-tests`)).status, 404);
});

test('settings are administrator only; changes need CSRF and are audited without values', async () => {
  const { siteId, testServer } = fixture('roles');
  assert.equal((await operator('GET', `/sites/${siteId}/restore-tests/settings`)).status, 403);
  const refused = await put(operator, siteId, good(testServer));
  assert.equal(refused.status, 403); assert.equal(refused.body.code, 'ADMIN_REQUIRED');
  assert.equal((await noCsrf('PUT', `/sites/${siteId}/restore-tests/settings`, good(testServer))).status, 403);
  const saved = await put(admin, siteId, good(testServer, { timeLimitMinutes: 45, memoryMb: 1536, cpus: 1.25, probe: { path: '/health' } }));
  assert.equal(saved.status, 200);
  assert.deepEqual({ ...saved.body, nextDueAt: !!saved.body.nextDueAt }, { enabled: true, cadence: 'weekly', serverId: testServer, allowLiveServer: false, allowInternet: false, timeLimitMinutes: 45, memoryMb: 1536, cpus: 1.25, probe: { service: null, port: null, path: '/health' }, nextDueAt: true, skipReason: null });
  assert.deepEqual((await json(await admin('GET', `/sites/${siteId}/restore-tests/settings`))).body.memoryMb, 1536);
  const row = db.prepare("SELECT detail FROM audit_events WHERE action='restore_test.settings' AND target=? ORDER BY created_at DESC LIMIT 1").get(siteId);
  const detail = JSON.parse(row.detail);
  assert.ok(detail.changed.includes('memoryMb') && detail.changed.includes('serverId'));
  assert.doesNotMatch(row.detail, /1536|health|serverId":"/, 'field names only');
});

test('settings validation returns the contract codes', async () => {
  const { siteId, live, testServer } = fixture('valid');
  const code = async body => (await put(admin, siteId, body)).body.code;
  for (const bad of [{ cpus: 0.3 }, { cpus: 1.1 }, { cpus: 17 }, { memoryMb: 255 }, { memoryMb: 1024.5 }, { timeLimitMinutes: 9 }, { timeLimitMinutes: 121 }, { cpus: '1' }, { cadence: 'hourly' }, { probe: { path: 'no-slash' } }, { extra: true }]) {
    assert.equal(await code(good(testServer, bad)), 'INVALID', JSON.stringify(bad));
  }
  assert.equal(await code(good(randomUUID())), 'INVALID');
  assert.equal((await put(admin, siteId, good(null))).status, 409);
  assert.equal(await code(good(null)), 'TEST_SERVER_REQUIRED');
  assert.equal(await code(good(live)), 'LIVE_SERVER_NOT_ALLOWED');
  assert.equal((await put(admin, siteId, good(null, { enabled: false }))).status, 200, 'off without a server is fine');
  // Presets and custom values at the edges are accepted.
  for (const limits of [{ timeLimitMinutes: 10, memoryMb: 256, cpus: 0.5 }, { timeLimitMinutes: 120, memoryMb: 16384, cpus: 1.75 }]) assert.equal((await put(admin, siteId, good(testServer, limits))).status, 200);
  const cores = serverRow('two-cores', { cpus: 2 });
  const above = await put(admin, siteId, good(cores, { cpus: 2.25 }));
  assert.equal(above.status, 409); assert.equal(above.body.code, 'CPUS_ABOVE_SERVER');
  assert.match(above.body.error, /has 2 CPUs, so it cannot give each container 2\.25/);
  assert.equal((await put(admin, siteId, good(cores, { cpus: 2 }))).status, 200);
  const statics = fixture('static', { kind: 'static' });
  const probe = await put(admin, statics.siteId, good(statics.testServer, { probe: { path: '/' } }));
  assert.equal(probe.status, 409); assert.equal(probe.body.code, 'PROBE_STATIC');
});

test('turning on the live server or internet needs a re-verification within 5 minutes', async () => {
  const { siteId, live, testServer } = fixture('reverify');
  for (const body of [good(live, { allowLiveServer: true }), good(testServer, { allowInternet: true })]) {
    const stale = await put(staleAdmin, siteId, body);
    assert.equal(stale.status, 403); assert.equal(stale.body.code, 'REVERIFY_REQUIRED');
  }
  assert.equal((await put(admin, siteId, good(live, { allowLiveServer: true, allowInternet: true }))).status, 200);
  // Already on: saving again (or turning them off) needs no new re-verification.
  assert.equal((await put(staleAdmin, siteId, good(live, { allowLiveServer: true, allowInternet: true, memoryMb: 2048 }))).status, 200);
  assert.equal((await put(staleAdmin, siteId, good(testServer))).status, 200);
  const detail = JSON.parse(db.prepare("SELECT detail FROM audit_events WHERE action='restore_test.settings' AND target=? ORDER BY created_at DESC LIMIT 1").get(siteId).detail);
  assert.equal(detail.allowInternet, false);
});

test('Run test: operators may run; one unfinished test per site; busy sites and missing backups are refused', async () => {
  const { siteId, testServer } = fixture('run');
  const none = await json(await operator('POST', `/sites/${siteId}/restore-tests`, {}));
  assert.equal(none.status, 409); assert.equal(none.body.code, 'NO_TEST_SERVER');
  await put(admin, siteId, good(testServer, { probe: { path: '/health' } }));
  const busyJob = randomUUID();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','queued','queued',?)").run(busyJob, siteId, at());
  assert.equal((await json(await operator('POST', `/sites/${siteId}/restore-tests`, {}))).body.code, 'SITE_BUSY');
  db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(busyJob);
  const started = await json(await operator('POST', `/sites/${siteId}/restore-tests`, {}));
  assert.equal(started.status, 202);
  assert.deepEqual(Object.keys(started.body).sort(), ['id', 'jobId']);
  assert.ok(started.body.jobId, 'the first step is queued at once');
  assert.deepEqual(rt.loadTest(started.body.id).limits.probe, { service: 'shop-web', port: 8080, path: '/health' }, 'the web check takes the first web port');
  const again = await json(await operator('POST', `/sites/${siteId}/restore-tests`, {}));
  assert.equal(again.status, 409); assert.equal(again.body.code, 'TEST_ACTIVE');
  const card = (await json(await operator('GET', `/sites/${siteId}/restore-tests`))).body;
  assert.deepEqual(card.active, { id: started.body.id, state: 'queued', step: 'check_space' });
  const job = (await json(await operator('GET', '/jobs/' + started.body.jobId))).body;
  assert.equal(job.type, 'restore-test'); assert.equal(job.status, 'test_queued'); assert.equal(job.details.testId, started.body.id);
  const finished = await drive(started.body.id);
  assert.equal(finished.result, 'passed');
  assert.equal(JSON.parse(db.prepare('SELECT capabilities FROM servers WHERE id=?').get(testServer).capabilities).cpus, 2, 'Check space records the CPU count');
  const empty = fixture('no-backup', { backup: false });
  await put(admin, empty.siteId, good(empty.testServer));
  assert.equal((await json(await operator('POST', `/sites/${empty.siteId}/restore-tests`, {}))).body.code, 'NO_VERIFIED_BACKUP');
  assert.equal((await json(await operator('POST', `/sites/${siteId}/restore-tests`, { backupId: 'nope' }))).body.code, 'INVALID');
});

test('Run test allows 6 manual tests per site in 24 hours, then 429 with the plain message', async () => {
  const { siteId, testServer } = fixture('limit');
  await put(admin, siteId, good(testServer));
  for (let index = 0; index < 6; index++) {
    const started = await json(await operator('POST', `/sites/${siteId}/restore-tests`, {}));
    assert.equal(started.status, 202, 'run ' + index);
    assert.equal((await operator('POST', `/restore-tests/${started.body.id}/cancel`, {})).status, 202);
    assert.equal(rt.loadTest(started.body.id).result, 'cancelled', 'a queued test ends at once');
    now += 60_000;
  }
  const refused = await json(await operator('POST', `/sites/${siteId}/restore-tests`, {}));
  assert.equal(refused.status, 429);
  assert.deepEqual(refused.body, { error: 'You can run 6 tests a day for each site.', code: 'TOO_MANY_TESTS' });
  now += 86_400_000;
  assert.equal((await operator('POST', `/sites/${siteId}/restore-tests`, {})).status, 202, 'the window moves on');
});

test('detail matches the contract; cancel, clean-up retry and acknowledge follow their roles', async () => {
  const { siteId, testServer, backupId } = fixture('detail');
  await put(admin, siteId, good(testServer));
  answers = { 'restore-test-run:start': () => ({ outcome: 'failed', reason: 'web stopped after it started (exit code 1).', checks: [{ name: 'Containers running', kind: 'running', target: 'web', status: 'failed', detail: 'exit 1' }] }), 'restore-test-teardown': () => { throw Object.assign(new Error('Docker failed'), { remoteReported: true }); } };
  const { body: { id: testId } } = await json(await operator('POST', `/sites/${siteId}/restore-tests`, {}));
  const row = await drive(testId, 2000);
  answers = {};
  assert.equal(row.result, 'failed'); assert.equal(row.cleanup, 'failed');
  const detail = (await json(await operator('GET', '/restore-tests/' + testId))).body;
  assert.deepEqual(Object.keys(detail).sort(), ['backupCapturedAt', 'backupId', 'cancelRequested', 'checks', 'cleanup', 'createdAt', 'deadlineAt', 'failedStep', 'finishedAt', 'id', 'limits', 'reason', 'restoreSeconds', 'result', 'serverId', 'serverName', 'siteId', 'startedAt', 'state', 'steps', 'totalSeconds', 'trigger']);
  assert.equal(detail.state, 'needs_cleanup'); assert.equal(detail.failedStep, 'start_containers'); assert.equal(detail.backupId, backupId);
  assert.equal(detail.reason, 'web stopped after it started (exit code 1).');
  assert.deepEqual(detail.limits, { memoryMb: 1024, cpus: 1, timeLimitMinutes: 30, internet: false });
  assert.deepEqual(detail.steps.map(step => [step.step, step.label, step.state]), [['check_space', 'Check space', 'done'], ['copy_backup', 'Copy backup', 'done'], ['restore_copy', 'Restore copy', 'done'], ['start_containers', 'Start containers', 'failed'], ['check_health', 'Check health', 'skipped'], ['clean_up', 'Clean up', 'failed']]);
  assert.equal(detail.steps[3].detail, detail.reason);
  assert.deepEqual(detail.checks.find(check => check.kind === 'running'), { name: 'Containers running', kind: 'running', target: 'web', status: 'failed', detail: 'exit 1' });
  assert.equal((await json(await operator('POST', `/restore-tests/${testId}/cancel`, {}))).body.code, 'NOT_ACTIVE');
  const card = (await json(await operator('GET', `/sites/${siteId}/restore-tests`))).body;
  assert.equal(card.active, null);
  assert.deepEqual({ ...card.last, finishedAt: !!card.last.finishedAt }, { id: testId, result: 'failed', finishedAt: true, restoreSeconds: null, internet: false, failedStep: 'start_containers', reason: detail.reason, serverName: 'detail-test' });
  assert.equal((await json(await operator('POST', `/sites/${siteId}/restore-tests`, {}))).body.code, 'TEST_ACTIVE', 'a failed clean-up still holds the site’s one unfinished test');
  // Acknowledge through the job's recovery route: administrators only, with the site name, and only when nothing is left.
  const jobId = rt.loadTest(testId).job_id;
  const ack = body => admin('POST', `/jobs/${jobId}/recovery`, body).then(json);
  assert.equal((await operator('POST', `/jobs/${jobId}/recovery`, { confirmation: 'detail', reviewedRemoteRecovery: true })).status, 403);
  assert.equal((await ack({ confirmation: 'wrong', reviewedRemoteRecovery: true })).body.code, 'CONFIRMATION_REQUIRED');
  answers = { 'restore-test-status': () => ({ present: true }) };
  assert.equal((await ack({ confirmation: 'detail', reviewedRemoteRecovery: true })).body.code, 'LEFTOVERS');
  answers = { 'restore-test-status': () => { throw new Error('ssh: connect to host 192.0.2.10 port 22: refused'); } };
  const unreachable = await ack({ confirmation: 'detail', reviewedRemoteRecovery: true });
  assert.equal(unreachable.status, 502); assert.doesNotMatch(unreachable.body.error, /192\.0\.2|ssh:/, 'remote output never reaches the browser');
  answers = {};
  // Retry clean-up instead: administrators only.
  assert.equal((await operator('POST', `/restore-tests/${testId}/cleanup`, {})).status, 403);
  assert.equal((await json(await admin('POST', `/restore-tests/${testId}/cleanup`, {}))).status, 202);
  assert.equal((await drive(testId)).cleanup, 'done');
  assert.equal((await json(await admin('POST', `/restore-tests/${testId}/cleanup`, {}))).body.code, 'NOT_NEEDED');
  assert.equal((await operator('GET', '/restore-tests/' + randomUUID())).status, 404);
});

test('backups carry restoreTest from their newest passed or failed test', async () => {
  const { siteId, testServer, backupId } = fixture('tested');
  const other = backupRow(siteId, dockerManifest, new Date(now - 3600_000).toISOString());
  await put(admin, siteId, good(testServer));
  const { body: { id: testId } } = await json(await operator('POST', `/sites/${siteId}/restore-tests`, { backupId }));
  await drive(testId);
  const state = (await json(await operator('GET', '/state'))).body;
  const mine = state.backups.find(item => item.id === backupId), untested = state.backups.find(item => item.id === other);
  assert.deepEqual({ ...mine.restoreTest, testedAt: !!mine.restoreTest.testedAt }, { status: 'passed', testId, testedAt: true });
  assert.deepEqual(untested.restoreTest, { status: 'not-tested', testId: null, testedAt: null });
  const page = (await json(await operator('GET', '/backups?limit=200'))).body;
  assert.equal(page.items.find(item => item.id === backupId).restoreTest.status, 'passed');
  const card = (await json(await operator('GET', `/sites/${siteId}/restore-tests?backupId=${backupId}`))).body;
  assert.deepEqual(card.items.map(item => [item.id, item.backupId, item.trigger, item.result]), [[testId, backupId, 'manual', 'passed']]);
  assert.equal((await json(await operator('GET', `/sites/${siteId}/restore-tests?backupId=${other}`))).body.items.length, 0);
});

test('the card pages its history with a cursor', async () => {
  const { siteId, testServer } = fixture('pages');
  await put(admin, siteId, good(testServer));
  const ids = [];
  for (let index = 0; index < 23; index++) {
    const { id: testId } = rt.createRestoreTest({ siteId, serverId: testServer, trigger: 'schedule', actor: 'scheduler' });
    rt.cancelRestoreTest(testId, 'test'); rt.advanceRestoreTest(testId); ids.unshift(testId); now += 1000;
  }
  const first = (await json(await operator('GET', `/sites/${siteId}/restore-tests`))).body;
  assert.equal(first.items.length, 20); assert.ok(first.next);
  const second = (await json(await operator('GET', `/sites/${siteId}/restore-tests?cursor=${first.next}`))).body;
  assert.deepEqual([...first.items, ...second.items].map(item => item.id), ids);
  assert.equal(second.next, null);
  assert.equal((await operator('GET', `/sites/${siteId}/restore-tests?cursor=bad`)).status, 400);
});

test('schedule: due 30 minutes after the next backup, waits while busy, skips plainly and never piles up', async () => {
  const nextBackup = new Date(now + 3 * 3600_000).toISOString();
  const { siteId, testServer } = fixture('sched', { policy: nextBackup });
  db.prepare('UPDATE restore_test_settings SET enabled=0').run(); // only this site is scheduled here
  const saved = (await put(admin, siteId, good(testServer, { cadence: 'daily' }))).body;
  assert.equal(saved.nextDueAt, new Date(Date.parse(nextBackup) + 30 * 60_000).toISOString());
  // Changing a limit keeps the due time; changing the cadence sets a new one.
  assert.equal((await put(admin, siteId, good(testServer, { cadence: 'daily', memoryMb: 2048 }))).body.nextDueAt, saved.nextDueAt);
  assert.equal(scheduler.tickRestoreTestSchedule(), 0, 'not due yet');
  // A ten-day outage: one test, and the next due time is in the future, one day step at a time.
  now = Date.parse(saved.nextDueAt) + 10 * 86_400_000 + 60_000;
  const busyJob = randomUUID();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','running','running',?)").run(busyJob, siteId, at());
  assert.equal(scheduler.tickRestoreTestSchedule(), 0, 'the backup goes first');
  assert.equal(settingsModule.settingsRow(siteId).next_due_at, saved.nextDueAt, 'waiting does not move the due time');
  db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(busyJob);
  assert.equal(scheduler.tickRestoreTestSchedule(), 1);
  assert.equal(scheduler.tickRestoreTestSchedule(), 0, 'one test only');
  const row = settingsModule.settingsRow(siteId), next = Date.parse(row.next_due_at);
  assert.ok(next > now && next - now <= 86_400_000);
  assert.equal((next - Date.parse(saved.nextDueAt)) % 86_400_000, 0, 'the time of day stays');
  const scheduled = db.prepare("SELECT * FROM restore_tests WHERE site_id=? AND trigger='schedule'").all(siteId);
  assert.equal(scheduled.length, 1);
  assert.equal((await drive(scheduled[0].id)).result, 'passed');
  // No verified backup: skipped with the plain reason, audited, and the due time moves on.
  db.prepare('UPDATE backups SET verified=0 WHERE site_id=?').run(siteId);
  now = next + 1000;
  assert.equal(scheduler.tickRestoreTestSchedule(), 0);
  const skipped = settingsModule.settingsRow(siteId);
  assert.equal(skipped.skip_reason, 'Not tested: no verified backup yet.');
  assert.ok(Date.parse(skipped.next_due_at) > now);
  assert.equal(JSON.parse(db.prepare("SELECT detail FROM audit_events WHERE action='restore_test.skipped' AND target=? ORDER BY created_at DESC LIMIT 1").get(siteId).detail).reason, 'no_verified_backup');
  assert.equal((await json(await operator('GET', `/sites/${siteId}/restore-tests`))).body.settings.skipReason, 'Not tested: no verified backup yet.');
  // Turning tests off clears the due time; the schedule then ignores the site.
  assert.equal((await put(admin, siteId, good(testServer, { enabled: false }))).body.nextDueAt, null);
});

test('schedule without a backup policy: one cadence period from now; deployment hold waits', async () => {
  const { siteId, testServer } = fixture('nopolicy');
  const saved = (await put(admin, siteId, good(testServer, { cadence: 'monthly' }))).body;
  assert.equal(saved.nextDueAt, new Date(now + 30 * 86_400_000).toISOString());
  now = Date.parse(saved.nextDueAt) + 1000;
  db.prepare("INSERT INTO settings VALUES('deployment_hold','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  assert.equal(scheduler.tickRestoreTestSchedule(), 0, 'held');
  db.prepare("DELETE FROM settings WHERE key='deployment_hold'").run();
  assert.equal(scheduler.tickRestoreTestSchedule(), 1);
  const row = db.prepare("SELECT id FROM restore_tests WHERE site_id=?").get(siteId);
  rt.cancelRestoreTest(row.id, 'test'); rt.advanceRestoreTest(row.id);
});

test('settings due-time helpers step by the cadence', () => {
  const start = Date.parse('2026-11-01T02:30:00.000Z');
  assert.equal(settingsModule.followingDueAt('2026-11-01T02:30:00.000Z', 'weekly', start + 20 * 86_400_000), '2026-11-22T02:30:00.000Z');
  assert.equal(settingsModule.followingDueAt('2026-11-01T02:30:00.000Z', 'daily', start), '2026-11-02T02:30:00.000Z');
  assert.equal(scheduler.resolveProbe({ path: '/' }, { kind: 'static' }), null);
  assert.equal(scheduler.resolveProbe({ path: '/' }, { containers: [{ Name: '/worker', Config: {} }] }), null, 'no port, no web check');
  assert.deepEqual(scheduler.resolveProbe({ service: 'shop-db', port: null, path: '/x' }, dockerManifest), { service: 'shop-db', port: 5432, path: '/x' });
  assert.deepEqual(scheduler.resolveProbe({ service: 'web', port: 81, path: '/' }, dockerManifest), { service: 'web', port: 81, path: '/' }, 'an unknown service is left for the helper to report');
});

test('alerts: failed, couldn’t run, passed again and clean-up needs you, once each, with names only', async () => {
  db.exec("DELETE FROM alert_queue;DELETE FROM alert_rules;DELETE FROM alert_channels;DELETE FROM alert_credentials;DELETE FROM settings WHERE key='alerts_cursor'");
  const { siteId, live, testServer, backupId } = fixture('alert.example.com');
  db.prepare("UPDATE servers SET name='Ashburn-1' WHERE id=?").run(testServer);
  const credential = store.createCredential({ kind: 'telegram', name: 'Bot', config: { token: '123456789:' + 'AbCdEf_-12'.repeat(4).slice(0, 35) } }, 'test');
  const channel = store.createChannel({ kind: 'telegram', name: 'Phone', credentialId: credential.id, config: { chatId: '-1001234567890' } }, 'test');
  store.createRule({ channelId: channel.id, sourceKind: 'server', sourceId: testServer, events: ['restore_test.failed', 'restore_test.couldnt_run', 'restore_test.recovered', 'restore_test.needs_you'] }, 'test');
  // A cursor from before 2.9.0 has no tests field: old tests are not replayed.
  const insert = (result, finishedAt, cleanup = 'done') => { const testId = randomUUID(); db.prepare("INSERT INTO restore_tests(id,site_id,backup_id,backup_captured_at,server_id,trigger,limits,created_by,created_at,started_at,finished_at,result,cleanup) VALUES(?,?,?,?,?,'schedule','{}','scheduler',?,?,?,?,?)").run(testId, siteId, backupId, finishedAt, testServer, finishedAt, finishedAt, finishedAt, result, cleanup); return testId; };
  insert('failed', '2026-01-01T01:00:00.000Z');
  db.prepare("INSERT INTO settings VALUES('alerts_cursor',?)").run(JSON.stringify({ jobs: '2026-01-01T02:00:00.000Z', moves: '2026-01-01T02:00:00.000Z' }));
  assert.equal(detect.detectJobsAndMoves('2026-01-01T02:00:00.000Z'), 0);
  assert.ok(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='alerts_cursor'").get().value).tests, 'the tests cursor starts now');
  insert('failed', '2026-01-01T03:00:00.000Z'); insert('couldnt_run', '2026-01-01T04:00:00.000Z'); insert('cancelled', '2026-01-01T04:30:00.000Z'); insert('passed', '2026-01-01T05:00:00.000Z'); insert('passed', '2026-01-01T06:00:00.000Z');
  db.prepare("INSERT INTO audit_events VALUES (?,?,?,?,?,?)").run(randomUUID(), 'worker', 'restore_test.cleanup_failed', siteId, JSON.stringify({ test: randomUUID(), server: testServer, attempts: 4 }), new Date().toISOString());
  assert.equal(detect.detectJobsAndMoves(), 4);
  assert.equal(detect.detectJobsAndMoves(), 0, 'seen once');
  const messages = db.prepare('SELECT event,message FROM alert_queue ORDER BY event').all().map(row => `${row.event}|${row.message}`);
  assert.deepEqual(messages, [
    "restore_test.couldnt_run|Restore test couldn't run: alert.example.com on Ashburn-1 at 04:00 UTC. Open DockNest to see why.",
    'restore_test.failed|Restore test failed: alert.example.com on Ashburn-1 at 03:00 UTC. Open DockNest to see why.',
    'restore_test.needs_you|Restore test could not clean up on Ashburn-1. Open DockNest to check it.',
    'restore_test.recovered|Restore test passed again: alert.example.com on Ashburn-1 at 05:00 UTC.',
  ]);
  // A site line (the live site) matches too, and the new events are part of the catalogue.
  assert.ok(events.EVENTS.includes('restore_test.needs_you'));
  assert.ok(store.ruleCreate.safeParse({ channelId: channel.id, sourceKind: 'site', sourceId: siteId, events: ['restore_test.failed'] }).success);
  assert.ok(events.ruleMatches({ enabled: true, events: ['restore_test.failed'], source_kind: 'server', source_id: live }, { type: 'restore_test.failed', serverId: live, targetServerId: testServer }));
});

test('no secrets in errors: a refused setting never echoes the request', async () => {
  const { siteId, testServer } = fixture('echo');
  const secret = 'postgres://admin:hunter2@db.internal:5432/shop';
  const response = await put(admin, siteId, good(testServer, { probe: { path: secret } }));
  assert.equal(response.status, 400);
  assert.doesNotMatch(JSON.stringify(response.body), /hunter2/);
});

test('review fixes: claimed-then-cancelled steps, one step job, nproc range, double acknowledge', async () => {
  const { siteId, testServer } = fixture('review');
  await put(admin, siteId, good(testServer));
  // One active step job, however often the test is advanced.
  const { body: { id: testId, jobId } } = await json(await operator('POST', `/sites/${siteId}/restore-tests`, {}));
  assert.equal(rt.advanceRestoreTest(testId), jobId); rt.tickRestoreTests();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='restore-test' AND json_extract(details,'$.testId')=?").get(testId).n, 1);
  // Cancel after a worker claimed the first step: the step's own guard ends it cancelled.
  const claimed = claimJob();
  assert.equal(JSON.parse(claimed.details).testId, testId); assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId).status, 'test_running');
  assert.equal((await operator('POST', `/restore-tests/${testId}/cancel`, {})).status, 202);
  assert.equal(rt.loadTest(testId).result, null, 'a claimed step is not withdrawn');
  await executeJob(claimed);
  const ended = await drive(testId);
  assert.equal(ended.result, 'cancelled', 'the next tick ends it'); assert.equal(ended.cleanup, 'done');
  // A withdrawn test_queued job is never claimed.
  now += 1000;
  const second = (await json(await operator('POST', `/sites/${siteId}/restore-tests`, {}))).body;
  await operator('POST', `/restore-tests/${second.id}/cancel`, {});
  assert.equal(db.prepare('SELECT status,stage FROM jobs WHERE id=?').get(second.jobId).stage, 'cancelled');
  assert.notEqual(claimJob()?.id, second.jobId);
  // Check space keeps a sane CPU count only.
  for (const [nproc, expected] of [[8, 8], [99999, 8], [0, 8]]) {
    answers = { 'restore-test-check': () => ({ ok: true, problems: [], facts: { nproc } }) };
    now += 1000;
    const run = (await json(await operator('POST', `/sites/${siteId}/restore-tests`, {}))).body;
    await drive(run.id);
    assert.equal(JSON.parse(db.prepare('SELECT capabilities FROM servers WHERE id=?').get(testServer).capabilities).cpus, expected, 'nproc ' + nproc);
  }
  answers = {};
  // Two acknowledges at once: one wins, the other is NOT_NEEDED and writes no audit row.
  const failed = randomUUID();
  db.prepare("INSERT INTO restore_tests(id,site_id,backup_captured_at,server_id,trigger,limits,created_by,created_at,started_at,finished_at,result,cleanup) VALUES(?,?,?,?,'manual','{}','x',?,?,?,'failed','failed')").run(failed, fixture('ack').siteId, at(), testServer, at(), at(), at());
  const results = await Promise.allSettled([rt.acknowledgeRestoreTestCleanup(failed, 'a'), rt.acknowledgeRestoreTestCleanup(failed, 'b')]);
  assert.deepEqual(results.map(item => item.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'NOT_NEEDED');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='restore_test.recovery_acknowledged' AND detail LIKE ?").get('%' + failed + '%').n, 1);
});

test('review fixes: re-verify whenever tests would run on the live server', async () => {
  const { siteId, live, testServer } = fixture('livemove');
  assert.equal((await put(admin, siteId, good(live, { allowLiveServer: true }))).status, 200);
  assert.equal((await put(staleAdmin, siteId, good(testServer))).status, 200, 'moving off the live server needs nothing');
  const back = await put(staleAdmin, siteId, good(live, { allowLiveServer: true }));
  assert.equal(back.status, 403); assert.equal(back.body.code, 'REVERIFY_REQUIRED', 'back onto the live server re-verifies');
  // The site moves onto the test server: the opt-in was never given for it, so testing there needs it and a re-verify.
  db.prepare('UPDATE sites SET server_id=? WHERE id=?').run(testServer, siteId);
  assert.equal((await json(await operator('POST', `/sites/${siteId}/restore-tests`, {}))).body.code, 'LIVE_SERVER_NOT_ALLOWED');
  assert.equal((await put(staleAdmin, siteId, good(testServer, { allowLiveServer: true }))).body.code, 'REVERIFY_REQUIRED');
});

test('review fixes: a due test waiting on a failed clean-up says why and keeps its due time', async () => {
  const { siteId, testServer } = fixture('waiting');
  db.prepare('UPDATE restore_test_settings SET enabled=0').run();
  await put(admin, siteId, good(testServer, { cadence: 'daily' }));
  db.prepare("INSERT INTO restore_tests(id,site_id,backup_captured_at,server_id,trigger,limits,created_by,created_at,started_at,finished_at,result,cleanup) VALUES(?,?,?,?,'manual','{}','x',?,?,?,'failed','failed')").run(randomUUID(), siteId, at(), testServer, at(), at(), at());
  const due = settingsModule.settingsRow(siteId).next_due_at;
  now = Date.parse(due) + 1000;
  assert.equal(scheduler.tickRestoreTestSchedule(), 0);
  const row = settingsModule.settingsRow(siteId);
  assert.equal(row.skip_reason, 'Waiting for the clean-up to be fixed.'); assert.equal(row.next_due_at, due);
});

test.after(() => listener.close());
