// Safe Edit API and engine (docs/safe-edit.md): roles and re-verification, the gate verdicts and their fixed reasons,
// redaction (environment values never in a response, SQLite, steps, audit or alerts), the review token (expiry, one
// use, binding), the per-site rate limit, the step machine with rollback, data rollback and needs-attention actions,
// restart and unreachable-server recovery, site locks and the claim predicates.
// The helper (remote/helper/edit.py) is faked here; real Docker runs in scripts/integration-safe-edit.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const directory = await mkdtemp(join(tmpdir(), 'docknest-site-edits-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const { claimJob, executeJob, tickScheduler, enqueueBackup } = await import('../src/engine.js');
const { CLAIMABLE_JOB_SQL } = await import('../src/job-claim.js');
const se = await import('../src/site-edits/engine.js');
const tokens = await import('../src/site-edits/tokens.js');
const { messageFor, templateFor, EVENTS } = await import('../src/alerts/events.js');
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
test.after(() => listener.close());

let now = Date.parse('2026-11-02T08:00:00.000Z');
se.editTransport.now = () => now;
tokens.tokenClock.now = () => now;
const at = () => new Date(now).toISOString();
const SECRET = 'hunter2-SuperSecret-Value';
const sha = text => createHash('sha256').update(text).digest('hex');
const COMPOSE = 'services:\n  web:\n    image: shop:1.0\n    ports:\n      - "8080:80"\n  db:\n    image: postgres:16\n';

// ---------- the fake helper ----------
let answers = {}, calls = [];
const loadAnswer = (text = COMPOSE) => ({ files: [{ path: '/srv/shop/compose.yaml', inode: 11, sha256: sha(text), text }], env: [{ file: '/srv/shop/.env', keys: ['DB_PASSWORD', 'TAG'] }], services: [{ name: 'web', image: 'shop:1.0', ports: [{ host: 8080, container: 80, protocol: 'tcp', hostIp: '' }], frozen: false, healthcheck: true }, { name: 'db', image: 'postgres:16', ports: [], frozen: false, healthcheck: false }], composeVersion: '2.29.1', usable: { compose: true, env: true, ports: true, image: true }, reasons: {} });
const verdict = (extra = {}) => ({ ok: true, verdict: { changed: ['services.web.image'], envChanged: { added: [], replaced: [], removed: [] }, imageChanged: true, newPorts: [], hashes: [{ path: '/srv/shop/compose.yaml', before: sha(COMPOSE), after: 'b'.repeat(64) }], reviewedModelSha256: 'c'.repeat(64), ...extra } });
const transportError = () => Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
const remoteError = (code, message = 'Docker said: /etc/shadow root:x:secret') => Object.assign(new Error(message), { remoteReported: true, helperCode: code });
se.editTransport.remote = async (_server, request, options) => {
  calls.push({ ...request, options });
  if (answers[request.operation]) return answers[request.operation](request);
  switch (request.operation) {
    case 'discover': return { containers: [{ name: 'shop-web', labels: labels() }, { name: 'shop-db', labels: labels() }] };
    case 'edit-load': return loadAnswer();
    case 'edit-check': return verdict();
    case 'edit-prepare': return { ok: true, pulled: ['web'] };
    case 'edit-apply': return { ok: true, startedAt: now / 1000 };
    case 'edit-poll': return { state: 'healthy', healthSeconds: 61 };
    case 'edit-rollback': return { ok: true };
    case 'edit-finish': return { ok: true };
    case 'edit-status': return { journal: true, files: 'candidate', maintenance: true };
    default: throw new Error('unexpected ' + request.operation);
  }
};
const labels = () => ({ 'com.docker.compose.project': 'shop', 'com.docker.compose.project.config_files': '/srv/shop/compose.yaml', 'com.docker.compose.project.working_dir': '/srv/shop', 'com.docker.compose.project.environment_file': '/srv/shop/.env' });
let restores = [];
se.editTransport.enqueueRestore = async (backupId, plan, actor) => {
  const jobId = randomUUID(), siteId = db.prepare('SELECT site_id FROM backups WHERE id=?').get(backupId).site_id;
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,'restore','queued','queued',?,?)").run(jobId, siteId, at(), JSON.stringify({ backupId }));
  restores.push({ backupId, plan, actor, jobId });
  return { id: jobId };
};

// ---------- users and fixtures ----------
function user(role, authenticatedAt = Date.now(), csrfHeader = true) {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId, userId + '@example.invalid', 'fixture', 'fixture', '[]', new Date().toISOString(), role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), userId, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), authenticatedAt);
  const call = (method, route, body) => fetch(base + route, { method, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, ...(csrfHeader ? { 'x-csrf-token': 'csrf' } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  call.id = userId;
  return call;
}
const admin = user('admin'), otherAdmin = user('admin'), staleAdmin = user('admin', Date.now() - 3600000), operator = user('operator'), noCsrf = user('admin', Date.now(), false);
const json = async response => ({ status: response.status, body: await response.json(), headers: response.headers });
function site(label = 'shop') {
  const serverId = randomUUID(), siteId = randomUUID();
  db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(serverId, label + '-server', '192.0.2.10', 22, 'root', 'fixture', '0'.repeat(64), at());
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, serverId, label, JSON.stringify({ containers: ['shop-web', 'shop-db'], composeFiles: ['/srv/shop/compose.yaml'], healthUrl: '' }), at());
  db.prepare("INSERT INTO policies VALUES (?,0,'0 2 * * *','UTC',7,NULL)").run(siteId);
  return { siteId, serverId };
}
const candidate = (text = COMPOSE.replace('shop:1.0', 'shop:1.1')) => ({ files: [{ path: '/srv/shop/compose.yaml', sha256: sha(COMPOSE), text }], env: [{ file: '/srv/shop/.env', key: 'DB_PASSWORD', value: SECRET }] });
async function review(siteId, body = candidate(), who = admin) { return json(await who('POST', `/sites/${siteId}/edit/review`, body)); }
async function apply(siteId, extra = {}, who = admin) {
  const reviewed = await review(siteId, undefined, who);
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  const applied = await json(await who('POST', `/sites/${siteId}/edit/apply`, { token: reviewed.body.token, ...extra }));
  assert.equal(applied.status, 202, JSON.stringify(applied.body));
  return applied.body.edit.id;
}
// The worker: tick, claim and run. A claimed backup is completed as the real backup would (package + backups row).
async function drive(rounds = 12, { onBackup = null } = {}) {
  for (let round = 0; round < rounds; round++) {
    se.tickSiteEdits();
    const job = claimJob();
    if (!job) { now += 1000; continue; }
    if (job.type === 'backup') { onBackup ? onBackup(job) : completeBackup(job); continue; }
    if (job.type === 'restore') { db.prepare("UPDATE jobs SET status='completed',stage='completed',finished_at=? WHERE id=?").run(at(), job.id); continue; }
    await executeJob(job);
  }
}
function completeBackup(job) {
  const backupId = randomUUID();
  db.prepare("UPDATE jobs SET status='completed',stage='completed',finished_at=?,details=? WHERE id=?").run(at(), JSON.stringify({ backupId, editId: JSON.parse(job.details).editId }), job.id);
  db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(backupId, job.site_id, job.id, at(), join(directory, backupId + '.enc'), 4096, 'a'.repeat(64), JSON.stringify({ kind: 'docker', containers: [] }), 0, 1, at());
}
const edit = editId => se.loadEdit(editId);
const steps = editId => Object.fromEntries(se.loadSteps(editId).map(row => [row.step, row.state]));
const ops = () => calls.map(call => call.operation);
const everything = () => JSON.stringify(['site_edits', 'site_edit_steps', 'jobs', 'audit_events', 'alert_outbox', 'settings', 'site_compose_invocations'].map(table => db.prepare(`SELECT * FROM ${table}`).all()));
// Each test starts with no unfinished work from the one before (edits of every site are ticked together).
test.beforeEach(() => {
  answers = {}; calls = []; restores = []; now += 3600_000 * 2;
  db.prepare("UPDATE site_edits SET result='cancelled',state='cancelled' WHERE result IS NULL").run();
  db.prepare("UPDATE jobs SET status='completed' WHERE status IN ('queued','running','edit_queued','edit_running','edit_waiting')").run();
});

// ---------- roles, re-verification, CSRF ----------
test('load is administrators only, needs a recent re-verification and CSRF on writes; reading an edit is open to operators', async () => {
  const { siteId } = site();
  assert.deepEqual((await json(await operator('GET', `/sites/${siteId}/edit`))).body.code, 'ADMIN_REQUIRED');
  assert.equal((await json(await staleAdmin('GET', `/sites/${siteId}/edit`))).body.code, 'REAUTH_REQUIRED');
  assert.equal((await noCsrf('POST', `/sites/${siteId}/edit/review`, candidate())).status, 403);
  assert.equal((await json(await staleAdmin('POST', `/sites/${siteId}/edit/apply`, { token: 'x' }))).body.code, 'REAUTH_REQUIRED');
  assert.equal((await json(await operator('POST', `/sites/${siteId}/edit/review`, candidate()))).body.code, 'ADMIN_REQUIRED');
  const loaded = await json(await admin('GET', `/sites/${siteId}/edit`));
  assert.equal(loaded.status, 200);
  assert.equal(loaded.headers.get('cache-control'), 'no-store');
  assert.equal(loaded.body.kind, 'compose');
  assert.deepEqual(loaded.body.env, [{ file: '/srv/shop/.env', keys: [{ key: 'DB_PASSWORD', set: true }, { key: 'TAG', set: true }] }]);
  assert.equal(loaded.body.files[0].sha256, sha(COMPOSE));
  assert.deepEqual(loaded.body.timeLimit, { min: 60, max: 600, default: 120 });
  // The invocation was derived once from the Compose labels and recorded with the site; every op uses it.
  const recorded = db.prepare('SELECT kind,invocation,source FROM site_compose_invocations WHERE site_id=?').get(siteId);
  assert.deepEqual({ ...recorded, invocation: JSON.parse(recorded.invocation) }, { kind: 'compose', source: 'labels', invocation: { project: 'shop', files: ['/srv/shop/compose.yaml'], projectDirectory: '/srv/shop', envFiles: ['/srv/shop/.env'] } });
  const load = calls.find(call => call.operation === 'edit-load');
  assert.deepEqual(load.invocation, { project: 'shop', files: ['/srv/shop/compose.yaml'], projectDirectory: '/srv/shop', envFiles: ['/srv/shop/.env'] });
  assert.deepEqual(load.allowedRoots, ['/srv/shop']);
  assert.equal(load.watchStdin, true); assert.equal(load.options.keepStdinOpen, true);
  const editId = await apply(siteId);
  const seen = await json(await operator('GET', `/site-edits/${editId}`));
  assert.equal(seen.status, 200); assert.deepEqual(seen.body.actions, { cancel: false, retry: false, restoreBackup: false });
  assert.equal((await json(await admin('GET', `/site-edits/${editId}`))).body.actions.cancel, true);
  assert.equal((await json(await operator('POST', `/site-edits/${editId}/cancel`, {}))).body.code, 'ADMIN_REQUIRED');
  assert.equal((await json(await operator('GET', `/sites/${siteId}/edits`))).status, 200);
});

test('a static site and a site whose containers were not started together cannot be edited', async () => {
  const { siteId } = site();
  db.prepare('UPDATE sites SET config=? WHERE id=?').run(JSON.stringify({ kind: 'static', documentRoot: '/var/www/x', containers: [] }), siteId);
  assert.equal((await json(await admin('GET', `/sites/${siteId}/edit`))).body.code, 'NOT_EDITABLE');
  const other = site('mixed');
  answers.discover = () => ({ containers: [{ name: 'shop-web', labels: labels() }, { name: 'shop-db', labels: {} }] });
  const refused = await json(await admin('GET', `/sites/${other.siteId}/edit`));
  assert.equal(refused.status, 422); assert.equal(refused.body.code, 'NOT_EDITABLE');
  answers.discover = () => { throw transportError(); };
  const third = site('away');
  assert.equal((await json(await admin('GET', `/sites/${third.siteId}/edit`))).body.code, 'SERVER_UNREACHABLE');
});

// ---------- the gate and redaction ----------
test('gate verdicts come back as one fixed reason and code; helper text, values and paths never do', async () => {
  const { siteId } = site();
  for (const code of ['PRIVILEGE_ADDED', 'PATH_REFUSED', 'SERVICE_REMOVED', 'PORT_IN_USE', 'SERVICE_FROZEN', 'COMPOSE_TOO_OLD', 'COMPOSE_INVALID', 'FILE_TOO_LARGE']) {
    answers['edit-check'] = () => ({ ok: false, code, reason: 'env_file /etc/shadow: root:$6$secret', field: 'services.web.privileged' });
    const refused = await review(siteId);
    assert.equal(refused.status, 422, code); assert.equal(refused.body.code, code);
    assert.equal(refused.body.field, 'services.web.privileged');
    assert.doesNotMatch(JSON.stringify(refused.body), /shadow|secret|\$6\$/, code);
  }
  // A field that is not a plain path is dropped; an unknown code is a plain "cannot read".
  answers['edit-check'] = () => ({ ok: false, code: 'SOMETHING_NEW', field: '/etc/shadow ../x' });
  const unknown = await review(siteId);
  assert.equal(unknown.body.code, 'COMPOSE_INVALID'); assert.equal(unknown.body.field, undefined);
  // A helper error (not a result) with a code: same fixed reason, never the helper's message.
  answers['edit-check'] = () => { throw remoteError('PATH_REFUSED'); };
  const thrown = await review(siteId);
  assert.equal(thrown.body.code, 'PATH_REFUSED'); assert.doesNotMatch(JSON.stringify(thrown.body), /shadow|Docker said/);
  answers['edit-check'] = () => { throw transportError(); };
  assert.equal((await review(siteId)).body.code, 'SERVER_UNREACHABLE');
});

test('environment keys and values that could steer Compose are refused before anything reaches the server', async () => {
  const { siteId } = site();
  for (const [entry, code] of [[{ key: 'COMPOSE_FILE', value: '/etc/x.yaml' }, 'ENV_REFUSED'], [{ key: 'DOCKER_HOST', value: 'tcp://x' }, 'ENV_REFUSED'], [{ key: 'buildkit_progress', value: 'x' }, 'ENV_REFUSED'], [{ key: 'A\nB', value: 'x' }, 'ENV_REFUSED'], [{ key: '1ABC', value: 'x' }, 'ENV_REFUSED'], [{ key: 'GOOD', value: 'line\nCOMPOSE_FILE=/x' }, 'ENV_REFUSED'], [{ key: 'GOOD', value: 'nul\0' }, 'ENV_REFUSED']]) {
    calls = [];
    const refused = await review(siteId, { env: [{ file: '/srv/shop/.env', ...entry }] });
    assert.equal(refused.status, 422, JSON.stringify(entry)); assert.equal(refused.body.code, code);
    assert.ok(!ops().includes('edit-check'), 'refused before the server');
    assert.doesNotMatch(JSON.stringify(refused.body), /tcp:\/\/x|\/etc\/x\.yaml|line\n|nul\u0000/);
  }
  assert.equal((await review(siteId, { env: [{ file: '/srv/shop/.env', key: 'GOOD', value: 'x'.repeat(8193) }] })).status, 400);
  assert.equal((await review(siteId, { env: [{ file: '/etc/environment', key: 'GOOD', value: 'x' }] })).body.code, 'PATH_REFUSED');
  assert.equal((await review(siteId, { files: [{ path: '/srv/shop/.env', sha256: sha(COMPOSE), text: 'A=1' }] })).body.code, 'PATH_REFUSED');
  assert.equal((await review(siteId, { files: [{ path: '/srv/shop/compose.yaml', sha256: sha(COMPOSE), text: COMPOSE }] })).body.code, 'NO_CHANGES');
  // A Compose file of more than 256 KB is refused by size (bytes, not characters).
  assert.equal((await review(siteId, { files: [{ path: '/srv/shop/compose.yaml', sha256: sha(COMPOSE), text: 'é'.repeat(140 * 1024) }] })).body.code, 'FILE_TOO_LARGE');
});

test('a file edited by hand between load and review is refused as changed; reload shows the new text', async () => {
  const { siteId } = site();
  const handEdited = COMPOSE + '  cache:\n    image: redis:7\n';
  answers['edit-load'] = () => loadAnswer(handEdited);
  const refused = await review(siteId);
  assert.equal(refused.status, 422); assert.equal(refused.body.code, 'FILE_CHANGED'); assert.equal(refused.body.error, 'This file changed on the server. Reload it.');
  assert.ok(!ops().includes('edit-check'));
});

test('review: diff with environment values masked, summary, warnings and a token; nothing is stored', async () => {
  const { siteId } = site();
  answers['edit-check'] = () => verdict({ changed: ['services.web.image', 'services.web.ports'], newPorts: [{ host: 8081, allAddresses: true }] });
  const text = COMPOSE.replace('shop:1.0', 'shop:1.1').replace('8080:80', '8081:80') + '    environment:\n      API_TOKEN: abc123\n';
  await admin('GET', `/sites/${siteId}/edit`); // records the invocation once
  const before = everything();
  const reviewed = await review(siteId, { ...candidate(text), env: [{ file: '/srv/shop/.env', key: 'DB_PASSWORD', value: SECRET }, { file: '/srv/shop/.env', key: 'NEW_KEY', value: SECRET + '2' }, { file: '/srv/shop/.env', key: 'TAG', remove: true }] });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.equal(reviewed.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(JSON.stringify(reviewed.body), new RegExp(SECRET));
  assert.deepEqual(reviewed.body.diff.env, [{ file: '/srv/shop/.env', key: 'DB_PASSWORD', change: 'replaced', value: '(changed)' }, { file: '/srv/shop/.env', key: 'NEW_KEY', change: 'added', value: '(changed)' }, { file: '/srv/shop/.env', key: 'TAG', change: 'removed', value: null }]);
  const lines = reviewed.body.diff.files[0].hunks.flatMap(hunk => hunk.lines);
  assert.ok(lines.some(line => line.type === 'remove' && line.text === '    image: shop:1.0'));
  assert.ok(lines.some(line => line.type === 'add' && line.text === '    image: shop:1.1'));
  assert.deepEqual(reviewed.body.summary.tabs.sort(), ['compose', 'env', 'image', 'ports']);
  assert.deepEqual(reviewed.body.summary.envChanged, { added: ['NEW_KEY'], replaced: ['DB_PASSWORD'], removed: ['TAG'] });
  assert.equal(reviewed.body.summary.dataRollback, true); assert.equal(reviewed.body.summary.maintenance, true); assert.equal(reviewed.body.summary.health, 'docker');
  assert.deepEqual(reviewed.body.warnings.map(item => item.code), ['PUBLIC_PORT', 'INLINE_SECRETS']);
  assert.deepEqual(reviewed.body.warnings[1].keys, ['API_TOKEN']);
  assert.match(reviewed.body.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(everything(), before, 'review writes nothing to SQLite');
  // The values went only to the helper, over stdin.
  const check = calls.find(call => call.operation === 'edit-check');
  assert.deepEqual(check.env.map(entry => entry.key), ['DB_PASSWORD', 'NEW_KEY', 'TAG']);
  assert.equal(check.env[0].value, SECRET);
  // No health check and no health URL: Review says only "running and stable" counts. An env-only change keeps dataRollback off.
  answers['edit-load'] = () => ({ ...loadAnswer(), services: [{ name: 'web', image: 'shop:1.0', ports: [], frozen: false, healthcheck: false }] });
  answers['edit-check'] = () => verdict({ changed: [], imageChanged: false });
  const envOnly = await review(siteId, { env: [{ file: '/srv/shop/.env', key: 'DB_PASSWORD', value: SECRET }] });
  assert.deepEqual(envOnly.body.warnings.map(item => item.code), ['NO_HEALTH_CHECK']);
  assert.equal(envOnly.body.summary.dataRollback, false); assert.equal(envOnly.body.summary.health, 'running');
});

// ---------- the token ----------
test('the review token is one-use, expires after 15 minutes and is bound to user, session and site', async () => {
  const { siteId } = site(), other = site('other');
  let reviewed = await review(siteId);
  assert.equal((await json(await otherAdmin('POST', `/sites/${siteId}/edit/apply`, { token: reviewed.body.token }))).body.code, 'REVIEW_EXPIRED', 'another user');
  assert.equal((await json(await admin('POST', `/sites/${siteId}/edit/apply`, { token: reviewed.body.token }))).body.code, 'REVIEW_EXPIRED', 'a presented-by-someone-else token is burnt');
  reviewed = await review(siteId);
  assert.equal((await json(await admin('POST', `/sites/${other.siteId}/edit/apply`, { token: reviewed.body.token }))).body.code, 'REVIEW_EXPIRED', 'another site');
  reviewed = await review(siteId);
  now += 15 * 60_000 + 1;
  assert.equal((await json(await admin('POST', `/sites/${siteId}/edit/apply`, { token: reviewed.body.token }))).body.code, 'REVIEW_EXPIRED', 'expired');
  reviewed = await review(siteId);
  const first = await json(await admin('POST', `/sites/${siteId}/edit/apply`, { token: reviewed.body.token }));
  assert.equal(first.status, 202);
  assert.equal((await json(await admin('POST', `/sites/${siteId}/edit/apply`, { token: reviewed.body.token }))).body.code, 'REVIEW_EXPIRED', 'one use');
  // The second edit is refused while the first runs, and its token survives for a retry later.
  const second = await review(siteId);
  const busy = await json(await admin('POST', `/sites/${siteId}/edit/apply`, { token: second.body.token }));
  assert.equal(busy.status, 409); assert.equal(busy.body.code, 'EDIT_RUNNING');
  assert.equal(tokens.tokenCount() >= 1, true);
  assert.equal((await json(await admin('POST', `/sites/${siteId}/edit/apply`, { token: 'not-a-token' }))).body.code, 'REVIEW_EXPIRED');
  assert.equal((await admin('POST', `/sites/${siteId}/edit/apply`, { token: second.body.token, timeLimitSeconds: 30 })).status, 400);
});

test('10 edits per site per hour; the 11th is refused with 429', async () => {
  const { siteId, serverId } = site();
  for (let index = 0; index < 10; index++) db.prepare("INSERT INTO site_edits(id,site_id,server_id,state,result,created_by,created_at) VALUES(?,?,?,'done','applied','x',?)").run(randomUUID(), siteId, serverId, new Date(now - index * 60_000).toISOString());
  const reviewed = await review(siteId);
  const refused = await json(await admin('POST', `/sites/${siteId}/edit/apply`, { token: reviewed.body.token }));
  assert.equal(refused.status, 429); assert.equal(refused.body.code, 'RATE_LIMITED');
  db.prepare('UPDATE site_edits SET created_at=? WHERE site_id=?').run(new Date(now - 3601_000).toISOString(), siteId);
  assert.equal((await admin('POST', `/sites/${siteId}/edit/apply`, { token: reviewed.body.token })).status, 202, 'the token survived the refusal');
});

// ---------- the step machine ----------
test('a change that comes up: backup, prepare, apply, check health (polls), finish; no value is ever stored', async () => {
  const { siteId } = site();
  let polls = 0;
  answers['edit-poll'] = request => (++polls < 3 ? { state: 'waiting' } : { state: 'healthy', healthSeconds: 64, final: request.final });
  const editId = await apply(siteId, { timeLimitSeconds: 300 });
  const row = edit(editId);
  assert.equal(row.state, 'queued'); assert.equal(row.data_rollback, true); assert.equal(row.time_limit_seconds, 300);
  assert.doesNotMatch(everything(), new RegExp(SECRET), 'the payload is sealed');
  const payload = JSON.parse(db.prepare('SELECT details FROM jobs WHERE id=?').get(row.job_id).details).payload;
  assert.equal(typeof payload, 'string');
  await drive(60);
  const done = edit(editId);
  assert.equal(done.result, 'applied', JSON.stringify(done)); assert.equal(done.state, 'done'); assert.equal(done.health_seconds, 64); assert.ok(done.backup_id);
  assert.deepEqual(steps(editId), { backup: 'done', prepare: 'done', apply: 'done', check_health: 'done', roll_back: 'skipped', finish: 'done' });
  assert.deepEqual(ops().filter(op => op.startsWith('edit-')), ['edit-load', 'edit-check', 'edit-prepare', 'edit-apply', 'edit-poll', 'edit-poll', 'edit-poll', 'edit-finish']);
  // prepare and apply got the candidate (and its reviewed model) over stdin; later steps never did.
  for (const op of ['edit-prepare', 'edit-apply']) { const call = calls.find(item => item.operation === op); assert.equal(call.env[0].value, SECRET); assert.equal(call.reviewedModelSha256, 'c'.repeat(64)); }
  for (const call of calls.filter(item => ['edit-poll', 'edit-finish'].includes(item.operation))) { assert.equal(call.env, undefined); assert.equal(call.files, undefined); }
  assert.deepEqual(calls.find(item => item.operation === 'edit-poll').services, ['web', 'db']);
  // The backup was a normal backup by `edit:<id>`; every payload is wiped and no value is anywhere in SQLite.
  assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='backup.enqueue' AND actor=?").get('edit:' + editId));
  for (const job of db.prepare("SELECT details FROM jobs WHERE type='site-edit' AND json_extract(details,'$.editId')=?").all(editId)) assert.deepEqual(JSON.parse(job.details).payload ?? {}, {});
  assert.doesNotMatch(everything(), new RegExp(SECRET));
  const audits = db.prepare("SELECT action,detail FROM audit_events WHERE action LIKE 'site.edit.%' AND target=? ORDER BY created_at").all(siteId);
  assert.deepEqual(audits.map(item => item.action), ['site.edit.requested', 'site.edit.applied']);
  assert.deepEqual(JSON.parse(audits[0].detail).envKeys, { added: [], replaced: ['DB_PASSWORD'], removed: [] });
  assert.deepEqual(JSON.parse(audits[0].detail).fields, ['services.web.image']);
  const history = await json(await admin('GET', `/sites/${siteId}/edits?limit=1`));
  assert.equal(history.body.items[0].id, editId); assert.equal(history.body.items[0].result, 'applied');
  const detail = await json(await admin('GET', `/site-edits/${editId}`));
  assert.deepEqual(detail.body.steps.map(step => step.label), ['Backup', 'Prepare', 'Apply', 'Check health', 'Roll back', 'Finish']);
  assert.equal(detail.body.maintenance, 'off'); assert.equal(detail.body.dataRollback, true);
});

test('health check fails after an image change: files rolled back, data restored from the pre-change backup, rolled back', async () => {
  const { siteId, serverId } = site();
  let window = 0;
  answers['edit-poll'] = request => (calls.filter(call => call.operation === 'edit-rollback').length ? { state: 'healthy', healthSeconds: 61 } : request.final ? (window++, { state: 'waiting' }) : { state: 'waiting' });
  const editId = await apply(siteId);
  await drive(8);
  now += 121_000; // past the 2-minute window
  await drive(30);
  const done = edit(editId);
  assert.equal(done.result, 'rolled_back', JSON.stringify(done)); assert.equal(done.failed_step, 'check_health');
  assert.equal(done.reason, 'The site did not become healthy in 2 minutes.');
  assert.deepEqual(steps(editId), { backup: 'done', prepare: 'done', apply: 'done', check_health: 'failed', roll_back: 'done', finish: 'done' });
  assert.equal(calls.find(call => call.operation === 'edit-rollback').restoreData, true);
  assert.equal(restores.length, 1); assert.equal(restores[0].backupId, done.backup_id); assert.equal(restores[0].actor, 'edit:' + editId); assert.equal(restores[0].plan.serverId, serverId);
  const order = ops().filter(op => ['edit-apply', 'edit-rollback', 'edit-finish'].includes(op));
  assert.deepEqual(order, ['edit-apply', 'edit-rollback', 'edit-finish']);
  assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='site.edit.rolled_back' AND target=?").get(siteId));
  assert.ok(window >= 1);
});

test('an env-only change that fails is rolled back without a data restore', async () => {
  const { siteId } = site();
  answers['edit-check'] = () => verdict({ changed: [], imageChanged: false });
  answers['edit-poll'] = () => (calls.filter(call => call.operation === 'edit-rollback').length ? { state: 'healthy' } : { state: 'unhealthy', reason: 'EXITED' });
  const reviewed = await review(siteId, { env: [{ file: '/srv/shop/.env', key: 'DB_PASSWORD', value: SECRET }] });
  const editId = (await json(await admin('POST', `/sites/${siteId}/edit/apply`, { token: reviewed.body.token }))).body.edit.id;
  await drive(30);
  assert.equal(edit(editId).result, 'rolled_back'); assert.equal(edit(editId).data_rollback, false);
  assert.equal(calls.find(call => call.operation === 'edit-rollback').restoreData, false);
  assert.equal(restores.length, 0);
});

test('a rollback that fails: needs attention, maintenance stays on, then Try again and Restore backup', async () => {
  const { siteId } = site();
  answers['edit-poll'] = () => ({ state: 'unhealthy' });
  answers['edit-rollback'] = () => ({ ok: false, code: 'ROLLBACK_FAILED', reason: 'journal /var/lib/docknest/edits/x corrupted' });
  const editId = await apply(siteId);
  await drive(30);
  let row = edit(editId);
  assert.equal(row.state, 'needs_attention'); assert.equal(row.result, null); assert.equal(row.reason, 'The previous version could not be put back. The site stays behind the maintenance page.');
  assert.ok(!ops().includes('edit-finish'), 'maintenance stays: finish never ran');
  assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='site.edit.needs_attention' AND target=?").get(siteId));
  assert.doesNotMatch(everything(), /corrupted|\/var\/lib\/docknest\/edits/);
  let detail = (await json(await admin('GET', `/site-edits/${editId}`))).body;
  assert.deepEqual(detail.actions, { cancel: false, retry: true, restoreBackup: true }); assert.equal(detail.maintenance, 'on');
  // The site stays locked: no backup, restore or second edit.
  assert.equal((await json(await admin('POST', `/sites/${siteId}/backup`))).body.code, 'SITE_EDITING');
  // Try again: the rollback works this time.
  answers['edit-rollback'] = () => ({ ok: true });
  answers['edit-poll'] = () => ({ state: 'healthy' });
  assert.equal((await admin('POST', `/site-edits/${editId}/retry`, {})).status, 202);
  await drive(20);
  row = edit(editId);
  assert.equal(row.result, 'rolled_back', JSON.stringify(row));
  assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='site.edit.retry' AND target=?").get(siteId));

  // Another one: Restore backup instead.
  calls = [];
  answers['edit-poll'] = () => ({ state: 'unhealthy' });
  answers['edit-rollback'] = () => { throw remoteError('ROLLBACK_FAILED'); };
  now += 3600_000;
  const second = await apply(siteId);
  await drive(30);
  assert.equal(edit(second).state, 'needs_attention');
  const restored = await json(await admin('POST', `/site-edits/${second}/restore-backup`, {}));
  assert.equal(restored.status, 202); assert.equal(restores.at(-1).actor, 'edit:' + second);
  detail = (await json(await admin('GET', `/site-edits/${second}`))).body;
  assert.deepEqual(detail.actions, { cancel: false, retry: false, restoreBackup: false }); assert.equal(detail.restore.running, true);
  assert.equal((await json(await admin('POST', `/site-edits/${second}/retry`, {}))).body.code, 'RESTORE_RUNNING');
  await drive(4);
  row = edit(second);
  assert.equal(row.result, 'failed'); assert.equal(row.reason, 'The backup from before the change was restored. Check the site, then turn off its maintenance page.');
  assert.equal((await json(await admin('GET', `/site-edits/${second}`))).body.maintenance, 'on');
});

// What a worker killed inside edit-apply leaves: the apply job edit_running, applyStarted journalled, the step running.
async function killInsideApply(editId) {
  for (let round = 0; round < 10; round++) {
    se.tickSiteEdits();
    const job = claimJob(); if (!job) { now += 1000; continue; }
    if (job.type === 'backup') { completeBackup(job); continue; }
    if (JSON.parse(job.details).step === 'apply') {
      const row = edit(editId);
      db.prepare('UPDATE site_edits SET progress=? WHERE id=?').run(JSON.stringify({ ...row.progress, applyStarted: true }), editId);
      db.prepare("UPDATE site_edit_steps SET state='running',started_at=? WHERE edit_id=? AND step='apply'").run(at(), editId);
      return job;
    }
    await executeJob(job);
  }
  throw new Error('apply never started');
}
test('DockNest restarts mid-apply: edit-status decides (candidate written -> roll back; still original -> failed)', async () => {
  const { siteId } = site();
  const editId = await apply(siteId);
  const job = await killInsideApply(editId);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status, 'edit_running');
  se.recoverInterruptedSiteEdits();
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status, 'failed');
  assert.equal(edit(editId).progress.phase, 'recover');
  answers['edit-poll'] = () => ({ state: 'healthy' });
  await drive(20);
  let row = edit(editId);
  assert.equal(row.result, 'rolled_back', JSON.stringify(row)); assert.equal(row.reason, 'DockNest restarted during the change, so it was undone.'); assert.equal(row.failed_step, 'apply');
  assert.equal(steps(editId).apply, 'failed');
  assert.ok(!ops().includes('edit-apply'), 'apply is never re-run blind');

  // Same, but the journal says nothing was written: the edit fails and finish takes the maintenance page down.
  calls = []; now += 3600_000;
  answers['edit-status'] = () => ({ journal: true, files: 'original', maintenance: true });
  const second = await apply(siteId);
  await killInsideApply(second);
  se.recoverInterruptedSiteEdits();
  await drive(10);
  row = edit(second);
  assert.equal(row.result, 'failed'); assert.equal(row.reason, 'DockNest restarted before the change was written. Nothing was changed.');
  assert.ok(!ops().includes('edit-rollback')); assert.ok(ops().includes('edit-finish'));
});

test('the server becomes unreachable mid-apply: DockNest retries edit-status, then rolls back what was written', async () => {
  const { siteId } = site();
  answers['edit-apply'] = () => { throw transportError(); };
  let statusCalls = 0;
  answers['edit-status'] = () => { if (++statusCalls < 3) throw transportError(); return { journal: true, files: 'mixed', maintenance: true }; };
  answers['edit-poll'] = () => ({ state: 'healthy' });
  const editId = await apply(siteId);
  await drive(10);
  assert.equal(edit(editId).progress.phase, 'recover');
  for (let index = 0; index < 4; index++) { now += 200_000; await drive(4); }
  const row = edit(editId);
  assert.equal(row.result, 'rolled_back', JSON.stringify(row)); assert.equal(row.reason, 'The server could not be reached during the change, so it was undone.');
  assert.equal(statusCalls, 3);
});

test('the files change during the backup: refused at apply, nothing rolled back over the hand edit', async () => {
  const { siteId } = site();
  answers['edit-apply'] = () => { throw remoteError('FILE_CHANGED', 'The files changed during the backup.'); };
  const editId = await apply(siteId);
  await drive(20);
  const row = edit(editId);
  assert.equal(row.result, 'failed'); assert.equal(row.failed_step, 'apply'); assert.equal(row.reason, 'The files changed during the backup.');
  assert.ok(!ops().includes('edit-rollback')); assert.ok(ops().includes('edit-finish'));
  // Same at prepare (the hand edit happened while the backup ran): nothing written, no maintenance page.
  calls = []; now += 3600_000;
  answers['edit-prepare'] = () => ({ ok: false, code: 'FILE_CHANGED' });
  const second = await apply(siteId);
  await drive(20);
  assert.equal(edit(second).result, 'failed'); assert.equal(edit(second).failed_step, 'prepare'); assert.ok(!ops().includes('edit-apply'));
});

test('a failed pull ends the edit before anything is written; the pre-change backup failing does too', async () => {
  const { siteId } = site();
  answers['edit-prepare'] = () => ({ ok: false, code: 'PULL_FAILED', reason: 'registry said 401 for token abc' });
  const editId = await apply(siteId);
  await drive(20);
  let row = edit(editId);
  assert.equal(row.result, 'failed'); assert.equal(row.reason, 'The new image could not be pulled. Nothing was changed.');
  assert.ok(!ops().includes('edit-apply'));
  now += 3600_000; calls = [];
  const second = await apply(siteId);
  await drive(6, { onBackup: job => db.prepare("UPDATE jobs SET status='failed',stage='failed',finished_at=? WHERE id=?").run(at(), job.id) });
  row = edit(second);
  assert.equal(row.result, 'failed'); assert.equal(row.failed_step, 'backup'); assert.equal(row.reason, 'The backup before the change did not finish. Nothing was changed.');
  assert.ok(!ops().includes('edit-prepare'));
});

test('cancel works before apply only', async () => {
  const { siteId } = site();
  const editId = await apply(siteId);
  se.tickSiteEdits(); // the backup is queued
  assert.equal((await json(await admin('POST', `/site-edits/${editId}/cancel`, {}))).body.cancelRequested, true);
  assert.equal(edit(editId).result, 'cancelled'); assert.equal(edit(editId).state, 'cancelled');
  now += 3600_000;
  answers['edit-poll'] = () => ({ state: 'waiting' });
  const second = await apply(siteId);
  await drive(10);
  assert.equal(edit(second).state, 'checking');
  const refused = await json(await admin('POST', `/site-edits/${second}/cancel`, {}));
  assert.equal(refused.status, 409); assert.equal(refused.body.code, 'CANCEL_TOO_LATE');
});

// ---------- locks and claims ----------
test('site locks: a queued backup refuses Apply; an unfinished edit refuses backups, schedules, restores and moves of the site', async () => {
  const { siteId } = site();
  const reviewed = await review(siteId);
  const queued = enqueueBackup(siteId, admin.id);
  const busy = await json(await admin('POST', `/sites/${siteId}/edit/apply`, { token: reviewed.body.token }));
  assert.equal(busy.status, 409); assert.equal(busy.body.code, 'SITE_BUSY');
  db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(queued.id);
  const applied = await json(await admin('POST', `/sites/${siteId}/edit/apply`, { token: reviewed.body.token }));
  assert.equal(applied.status, 202, 'the token survived SITE_BUSY');
  assert.equal((await json(await admin('POST', `/sites/${siteId}/backup`))).body.code, 'SITE_EDITING');
  db.prepare('UPDATE policies SET enabled=1,next_run=? WHERE site_id=?').run(new Date(now - 1000).toISOString(), siteId);
  tickScheduler(new Date(now));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE site_id=? AND type='backup' AND status='queued'").get(siteId).n, 0, 'the scheduled backup waits');
  assert.ok(!db.prepare("SELECT 1 FROM audit_events WHERE action='schedule.invalid' AND target=?").get(siteId));
  db.prepare('UPDATE policies SET enabled=0 WHERE site_id=?').run(siteId);
});

test('claim predicates: edit_queued is claimed, edit_running holds the server, edit_waiting holds nothing', () => {
  const a = site('claim-a'), b = site('claim-b');
  db.prepare('UPDATE sites SET server_id=? WHERE id=?').run(a.serverId, b.siteId);
  const job = (siteId, type, status, details = {}) => { const jobId = randomUUID(); db.prepare('INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,?,?,?,?,?)').run(jobId, siteId, type, status, 'x', new Date(now++).toISOString(), JSON.stringify(details)); return jobId; };
  const pending = db.prepare("SELECT id FROM jobs WHERE status IN ('queued','edit_queued','move_queued','test_queued')").all().map(row => row.id);
  for (const jobId of pending) db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(jobId);
  const editJob = job(a.siteId, 'site-edit', 'edit_queued', { editId: randomUUID(), step: 'prepare', targetServerId: a.serverId });
  assert.equal(db.prepare(CLAIMABLE_JOB_SQL).get().id, editJob);
  db.prepare("UPDATE jobs SET status='edit_running' WHERE id=?").run(editJob);
  const backup = job(b.siteId, 'backup', 'queued');
  assert.equal(db.prepare(CLAIMABLE_JOB_SQL).get(), undefined, 'the server is busy while an edit step runs');
  db.prepare("UPDATE jobs SET status='edit_waiting' WHERE id=?").run(editJob);
  assert.equal(db.prepare(CLAIMABLE_JOB_SQL).get().id, backup, 'a waiting poll holds nothing');
  db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(backup);
  db.prepare("UPDATE jobs SET status='edit_queued' WHERE id=?").run(editJob);
  assert.equal(db.prepare(CLAIMABLE_JOB_SQL).get(), undefined, 'an edit step waits for a running backup on its server');
  const claimed = (db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(backup), claimJob());
  assert.equal(claimed.id, editJob);
  const row = db.prepare('SELECT status,stage FROM jobs WHERE id=?').get(editJob);
  assert.deepEqual({ ...row }, { status: 'edit_running', stage: 'x' });
  db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(editJob);
});

test('deployment preflight: the hold waits for edit_* and heal_* jobs', () => {
  const { siteId } = site('hold');
  const preflight = mode => spawnSync(process.execPath, ['scripts/deployment-preflight.js', mode], { env: process.env, encoding: 'utf8' });
  const others = db.prepare("SELECT id,status FROM jobs WHERE status IN ('queued','running','recovery_required') OR substr(status,1,5) IN ('edit_','heal_')").all();
  for (const row of others) db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(row.id);
  for (const status of ['edit_waiting', 'edit_queued', 'edit_running', 'heal_running']) {
    const jobId = randomUUID();
    db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'site-edit',?,'x',?)").run(jobId, siteId, status, at());
    const result = preflight('hold');
    assert.equal(result.status, 1, status); assert.match(result.stderr, /Deployment blocked/);
    db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(jobId);
  }
  assert.equal(preflight('hold').status, 0);
  assert.equal(preflight('release').status, 0);
  for (const row of others) db.prepare('UPDATE jobs SET status=? WHERE id=?').run(row.status, row.id);
});

// ---------- alerts ----------
test('alert events: edit.rolled_back and edit.needs_you name the site only; existing lines do not gain them', () => {
  assert.ok(EVENTS.includes('edit.rolled_back') && EVENTS.includes('edit.needs_you'));
  const event = { type: 'edit.rolled_back', siteName: 'shop', serverName: 'main', at: '2026-11-02T08:00:00.000Z' };
  assert.match(messageFor(event), /^Change undone: shop on main/);
  assert.equal(templateFor(event).title, 'Change undone');
  assert.match(templateFor({ ...event, type: 'edit.needs_you' }).reason, /maintenance page/);
  // A line stores its own event list, so lines saved before 2.15 keep exactly the events they had.
  const web = new URL('../web/map/alerts-client.js', import.meta.url);
  assert.ok(web);
});
