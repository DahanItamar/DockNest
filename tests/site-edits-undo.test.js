// Safe Edit: remove an environment variable, the apply time limit and Undo of a Compose replace (issue 187).
// Same fake helper and worker as tests/site-edits.test.js; real Docker runs in scripts/integration-safe-edit.js.
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
  db.prepare("DELETE FROM rate_limits WHERE key LIKE 'site-edit-review:%'").run(); // the per-client review limit is tested by its own case
  db.prepare("UPDATE site_edits SET result='cancelled',state='cancelled' WHERE result IS NULL").run();
  db.prepare("UPDATE jobs SET status='completed' WHERE status IN ('queued','running','edit_queued','edit_running','edit_waiting')").run();
});


// ---------- helpers for these tests ----------
const NEW = COMPOSE.replace('shop:1.0', 'shop:1.1');
const NEWER = COMPOSE.replace('shop:1.0', 'shop:1.2');
const FILE = '/srv/shop/compose.yaml';
let server = COMPOSE;
const serve = text => { server = text; answers['edit-load'] = () => loadAnswer(server); };
test.beforeEach(() => serve(COMPOSE));
const replaceBody = (from, to) => ({ files: [{ path: FILE, sha256: sha(from), text: to }] });
const checked = (from, to, extra = {}) => verdict({ imageChanged: false, changed: ['services.web.image'], hashes: [{ path: FILE, before: sha(from), after: sha(to) }], ...extra });
// Applies a Compose replace, drives it to the end and makes the server hold the new text.
async function replaceCompose(siteId, from, to, who = admin) {
  answers['edit-check'] = () => checked(from, to);
  const reviewed = await review(siteId, replaceBody(from, to), who);
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  const applied = await json(await who('POST', `/sites/${siteId}/edit/apply`, { token: reviewed.body.token }));
  assert.equal(applied.status, 202, JSON.stringify(applied.body));
  await drive(60);
  assert.equal(edit(applied.body.edit.id).result, 'applied');
  serve(to);
  return applied.body.edit.id;
}
const detail = async (editId, who = admin) => (await json(await who('GET', `/site-edits/${editId}`))).body;
const undoReview = async (editId, who = admin) => json(await who('POST', `/site-edits/${editId}/undo/review`, {}));
const undoRow = editId => db.prepare('SELECT * FROM site_edit_undo WHERE edit_id=?').get(editId);

// ---------- the apply time limit ----------
test('the apply time limit is 60 to 600 seconds and is stored on the edit; the default is 120', async () => {
  const { siteId } = site();
  answers['edit-check'] = () => checked(COMPOSE, NEW);
  const send = async limit => {
    const reviewed = await review(siteId, replaceBody(COMPOSE, NEW));
    return json(await admin('POST', `/sites/${siteId}/edit/apply`, { token: reviewed.body.token, ...(limit === undefined ? {} : { timeLimitSeconds: limit }) }));
  };
  for (const bad of [59, 601, 90.5, '120', 0]) assert.equal((await send(bad)).body.code, 'INVALID', String(bad));
  const low = await send(60); assert.equal(low.status, 202); assert.equal(edit(low.body.edit.id).time_limit_seconds, 60);
  db.prepare("UPDATE site_edits SET result='cancelled',state='cancelled' WHERE result IS NULL").run();
  const high = await send(600); assert.equal(high.status, 202); assert.equal(edit(high.body.edit.id).time_limit_seconds, 600);
  db.prepare("UPDATE site_edits SET result='cancelled',state='cancelled' WHERE result IS NULL").run();
  const normal = await send(); assert.equal(edit(normal.body.edit.id).time_limit_seconds, 120);
});

// ---------- removing an environment variable ----------
const removal = (key = 'DB_PASSWORD') => ({ env: [{ file: '/srv/shop/.env', key, remove: true }] });
const envCheck = (use, key = 'DB_PASSWORD') => () => verdict({ imageChanged: false, changed: [], envChanged: { added: [], replaced: [], removed: [key] }, hashes: [{ path: '/srv/shop/.env', before: 'd'.repeat(64), after: 'e'.repeat(64), keyed: true }], ...(use ? { envUse: { [key]: use } } : {}) });

test('removing a variable: a red line in the diff and a warning; the request carries remove, never a value', async () => {
  const { siteId } = site();
  answers['edit-check'] = envCheck({ required: false, services: ['web'] });
  const reviewed = await review(siteId, removal());
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.deepEqual(reviewed.body.diff.env, [{ file: '/srv/shop/.env', key: 'DB_PASSWORD', change: 'removed', value: null }]);
  assert.deepEqual(reviewed.body.summary.envChanged, { added: [], replaced: [], removed: ['DB_PASSWORD'] });
  const warning = reviewed.body.warnings.find(item => item.code === 'ENV_REMOVED');
  assert.equal(warning.message, 'DB_PASSWORD is deleted from the .env file. Restoring the backup brings it back.');
  assert.deepEqual(calls.find(call => call.operation === 'edit-check').env, [{ file: '/srv/shop/.env', key: 'DB_PASSWORD', remove: true }]);
  assert.doesNotMatch(JSON.stringify(reviewed.body), /hunter2/);
});

test('removing a variable several services use names them; two, three and more read naturally', async () => {
  const { siteId } = site();
  const say = async services => { answers['edit-check'] = envCheck({ required: false, services }); return (await review(siteId, removal())).body.warnings.find(item => item.code === 'ENV_SHARED')?.message; };
  assert.equal(await say(['web', 'db']), 'DB_PASSWORD is used by web and db. Both lose it.');
  // Only services the site really has are named; one reader is the plain removal warning.
  answers['edit-check'] = envCheck({ required: false, services: ['web', 'ghost'] });
  assert.equal((await review(siteId, removal())).body.warnings.some(item => item.code === 'ENV_SHARED'), false);
  const text = await import('../src/site-edits/state.js');
  assert.equal(text.sharedText('TZ', ['web', 'worker', 'cron']), 'TZ is used by web, worker and cron. All three lose it.');
  assert.equal(text.sharedText('TZ', ['a', 'b', 'c', 'd']), 'TZ is used by a, b, c and d. All 4 lose it.');
});

test('a variable the Compose file requires is refused by the server, naming the file; fail closed without the helper answer', async () => {
  const { siteId } = site();
  serve(COMPOSE + '    environment:\n      PASS: ${DB_PASSWORD}\n');
  answers['edit-check'] = envCheck({ required: true, services: ['db'] });
  const refused = await review(siteId, removal());
  assert.equal(refused.status, 422); assert.equal(refused.body.code, 'ENV_REQUIRED'); assert.equal(refused.body.field, 'env.DB_PASSWORD');
  assert.equal(refused.body.error, 'DB_PASSWORD is required by compose.yaml and has no default. Edit the file first.');
  assert.equal(tokens.tokenCount(), 0, 'no token for a refused review');
  answers['edit-check'] = envCheck(null);
  assert.equal((await review(siteId, removal())).body.code, 'COMPOSE_INVALID');
});

test('a removal can go with a Compose edit in the same review, and a key that is not in the file changes nothing', async () => {
  const { siteId } = site();
  answers['edit-check'] = envCheck({ required: false, services: [] });
  const reviewed = await review(siteId, { ...replaceBody(COMPOSE, NEW), ...removal() });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  const unknown = await review(siteId, removal('NOT_THERE'));
  assert.equal(unknown.body.code, 'NO_CHANGES');
});

test('removing a variable: apply, journal and audit hold the key name only', async () => {
  const { siteId } = site();
  answers['edit-check'] = envCheck({ required: false, services: ['web'] });
  const reviewed = await review(siteId, removal());
  const applied = await json(await admin('POST', `/sites/${siteId}/edit/apply`, { token: reviewed.body.token, timeLimitSeconds: 180 }));
  await drive(60);
  const done = edit(applied.body.edit.id);
  assert.equal(done.result, 'applied'); assert.deepEqual(done.changes.env.removed, ['DB_PASSWORD']); assert.equal(done.time_limit_seconds, 180);
  assert.equal(undoRow(done.id), undefined, 'an environment-only change has no Compose undo');
  assert.equal((await detail(done.id)).undo, null);
});

// ---------- undo of a Compose replace ----------
test('undo: the newest applied replace can be undone; the undo is its own applied edit with a backup first', async () => {
  const { siteId } = site();
  const first = await replaceCompose(siteId, COMPOSE, NEW);
  assert.ok(undoRow(first).payload); assert.doesNotMatch(undoRow(first).payload, /shop:1\.0/, 'sealed');
  assert.deepEqual((await detail(first)).undo, { available: true }); assert.equal((await detail(first)).actions.undo, true);
  assert.equal((await detail(first, operator)).undo, null, 'operators only read');

  calls = []; answers['edit-check'] = () => checked(NEW, COMPOSE);
  const reviewed = await undoReview(first);
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.equal(reviewed.body.undoOf, first);
  assert.deepEqual(reviewed.body.diff.files[0].hunks[0].lines.filter(line => line.type !== 'context').map(line => [line.type, line.text]), [['remove', '    image: shop:1.1'], ['add', '    image: shop:1.0']]);
  const check = calls.find(call => call.operation === 'edit-check');
  assert.deepEqual(check.files, [{ path: FILE, sha256: sha(NEW), text: COMPOSE }], 'the same guarded request as a Replace: the file the edit wrote, to what it was');

  const applied = await json(await admin('POST', `/sites/${siteId}/edit/apply`, { token: reviewed.body.token }));
  assert.equal(applied.status, 202);
  await drive(60);
  const undo = edit(applied.body.edit.id);
  assert.equal(undo.result, 'applied'); assert.equal(undo.changes.undoOf, first); assert.ok(undo.backup_id, 'backup first');
  assert.deepEqual(steps(undo.id), { backup: 'done', prepare: 'done', apply: 'done', check_health: 'done', roll_back: 'skipped', finish: 'done' });
  assert.equal((await detail(undo.id)).undoOf, first);
  // History: the first edit can no longer be undone ("a newer change"), the undo itself can (redo).
  serve(COMPOSE);
  const older = await detail(first);
  assert.equal(older.undo.available, false); assert.equal(older.undo.newerAt, edit(undo.id).finished_at); assert.equal(older.actions.undo, false);
  assert.equal(undoRow(first).payload, null, 'the copy of the older edit is emptied');
  assert.deepEqual((await detail(undo.id)).undo, { available: true });
  const refused = await undoReview(first);
  assert.equal(refused.status, 409); assert.equal(refused.body.code, 'UNDO_NEWER'); assert.equal(refused.body.error, 'A newer change was made. Undo that one first.');
});

test('undo is refused when the Compose file changed outside DockNest; nothing is sent to the server for checking', async () => {
  const { siteId } = site();
  const first = await replaceCompose(siteId, COMPOSE, NEW);
  serve(NEW + '# edited by hand\n');
  calls = [];
  const refused = await undoReview(first);
  assert.equal(refused.status, 409); assert.equal(refused.body.code, 'UNDO_CHANGED');
  assert.equal(refused.body.error, 'The Compose file changed outside DockNest since this edit. Undoing now would overwrite those changes.');
  assert.equal(calls.some(call => call.operation === 'edit-check'), false);
  assert.equal(tokens.tokenCount(), 0);
  // A file too large to read has no hash: refused too.
  answers['edit-load'] = () => ({ ...loadAnswer(NEW), files: [{ path: FILE, inode: 1, sha256: null, text: null }] });
  assert.equal((await undoReview(first)).body.code, 'UNDO_CHANGED');
  assert.equal(edit(first).result, 'applied');
});

test('undo is only for the newest applied edit: after another edit, the older one says a newer change was made', async () => {
  const { siteId } = site();
  const first = await replaceCompose(siteId, COMPOSE, NEW);
  const second = await replaceCompose(siteId, NEW, NEWER);
  const older = await detail(first);
  assert.deepEqual(older.undo, { available: false, newerAt: edit(second).finished_at });
  assert.equal((await undoReview(first)).body.code, 'UNDO_NEWER');
  answers['edit-check'] = () => checked(NEWER, NEW);
  assert.equal((await undoReview(second)).status, 200);
});

test('edits that did not end applied, and older edits, have no undo', async () => {
  const { siteId } = site();
  // A change that does not come up is rolled back: nothing to undo.
  answers['edit-check'] = () => checked(COMPOSE, NEW);
  const reviewed = await review(siteId, replaceBody(COMPOSE, NEW));
  const applied = await json(await admin('POST', `/sites/${siteId}/edit/apply`, { token: reviewed.body.token }));
  answers['edit-poll'] = () => (calls.some(call => call.operation === 'edit-rollback') ? { state: 'healthy', healthSeconds: 61 } : { state: 'waiting' });
  await drive(8);
  now += 121_000;
  await drive(40);
  const rolled = edit(applied.body.edit.id);
  assert.equal(rolled.result, 'rolled_back'); assert.equal(undoRow(rolled.id), undefined);
  assert.equal((await detail(rolled.id)).undo, null); assert.equal((await undoReview(rolled.id)).body.code, 'UNDO_UNAVAILABLE');
  // An edit from before this feature (applied, no undo copy) shows no undo button.
  delete answers['edit-poll'];
  const old = await replaceCompose(siteId, COMPOSE, NEW);
  db.prepare('DELETE FROM site_edit_undo WHERE edit_id=?').run(old);
  assert.equal((await detail(old)).undo, null);
  assert.equal((await undoReview(old)).status, 409);
  assert.equal((await undoReview(randomUUID())).status, 404);
});

test('undo needs an administrator with a recent re-verification and CSRF, and takes no body', async () => {
  const { siteId } = site();
  const first = await replaceCompose(siteId, COMPOSE, NEW);
  assert.equal((await undoReview(first, operator)).body.code, 'ADMIN_REQUIRED');
  assert.equal((await undoReview(first, staleAdmin)).body.code, 'REAUTH_REQUIRED');
  assert.equal((await noCsrf('POST', `/site-edits/${first}/undo/review`, {})).status, 403);
  assert.equal((await json(await admin('POST', `/site-edits/${first}/undo/review`, { files: [] }))).body.code, 'INVALID');
});

test('an undo reviewed before another edit was applied is refused at apply', async () => {
  const { siteId } = site();
  const first = await replaceCompose(siteId, COMPOSE, NEW);
  answers['edit-check'] = () => checked(NEW, COMPOSE);
  const reviewed = await undoReview(first);
  assert.equal(reviewed.status, 200);
  await replaceCompose(siteId, NEW, NEWER, otherAdmin);
  const applied = await json(await admin('POST', `/sites/${siteId}/edit/apply`, { token: reviewed.body.token }));
  assert.equal(applied.status, 409); assert.equal(applied.body.code, 'REVIEW_EXPIRED');
});

test('an undo that does not come up rolls back like any edit and the first edit stays undoable', async () => {
  const { siteId } = site();
  const first = await replaceCompose(siteId, COMPOSE, NEW);
  answers['edit-check'] = () => checked(NEW, COMPOSE);
  const reviewed = await undoReview(first);
  const applied = await json(await admin('POST', `/sites/${siteId}/edit/apply`, { token: reviewed.body.token }));
  answers['edit-poll'] = () => (calls.some(call => call.operation === 'edit-rollback') ? { state: 'healthy', healthSeconds: 61 } : { state: 'waiting' });
  await drive(8);
  now += 121_000;
  await drive(40);
  const undo = edit(applied.body.edit.id);
  assert.equal(undo.result, 'rolled_back'); assert.equal(undo.changes.undoOf, first);
  assert.equal(undoRow(undo.id), undefined);
  assert.ok(ops().includes('edit-rollback'));
  assert.deepEqual((await detail(first)).undo, { available: true });
});

test('undo keeps the guards of a Replace: a busy site refuses it and the token is kept for a moment', async () => {
  const { siteId } = site();
  const first = await replaceCompose(siteId, COMPOSE, NEW);
  answers['edit-check'] = () => checked(NEW, COMPOSE);
  const reviewed = await undoReview(first);
  enqueueBackup(siteId, 'test');
  const busy = await json(await admin('POST', `/sites/${siteId}/edit/apply`, { token: reviewed.body.token }));
  assert.equal(busy.status, 409); assert.equal(busy.body.code, 'SITE_BUSY');
  assert.equal(tokens.tokenCount(), 1, 'put back for a busy site');
});
