// Automatic restore test engine (docs/restore-tests.md) against a fake helper and a fake clock: the step machine
// through the worker, verdicts, evidence rules, cancel, the time limit, clean-up retries, restarts, the server hold,
// busy() and claim ordering, and the retention lease. Real Docker is covered by scripts/integration-restore-test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-restore-tests-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { db } = await import('../src/db.js');
const { claimJob, executeJob, enqueueBackup, enqueueScrub } = await import('../src/engine.js');
const { deletionBlocked } = await import('../src/artifact-journal.js');
const { recordVerification, backupVerification } = await import('../src/recovery-evidence.js');
const installs = await import('../src/installs.js');
const rt = await import('../src/restore-tests/engine.js');
const { validateLimits, LIMIT_PRESETS, LIMIT_DEFAULTS, cpuProblem } = await import('../src/restore-tests/limits.js');

let now = Date.parse('2026-11-01T10:00:00.000Z');
rt.testTransport.now = () => now;
const at = () => new Date(now).toISOString();
const calls = [];
let answers = {};
const name = request => request.operation + (request.phase ? ':' + request.phase : '');
rt.testTransport.remote = async (server, request, options = {}) => {
  calls.push({ server: server.name, request, options });
  if (options.signal?.aborted) throw Object.assign(new Error('DockNest stopped waiting for this step.'), { aborted: true });
  if (answers[name(request)]) return answers[name(request)](request, options);
  switch (name(request)) {
    case 'restore-test-check': return { ok: true, problems: [], facts: { nproc: 4, probeTools: true } };
    case 'restore-test-prepare': return { root: '/var/lib/docker-backup-manager/restore/' + request.testId, remotePath: '/x/payload.tar.gz', reaper: true };
    case 'restore-test-run:restore': return { outcome: 'ok', kind: 'docker', containers: 2, running: 2, networkMode: 'isolated-internal', mailBlocked: false, checks: [{ name: 'Package complete', kind: 'package', target: null, status: 'passed', detail: null }] };
    case 'restore-test-run:start': return { outcome: 'ok', started: 2 };
    case 'restore-test-run:poll': return request.final ? { outcome: 'ok', healthy: true, running: 2, checks: [{ name: 'Containers running', kind: 'running', target: null, status: 'passed', detail: '2 running' }, { name: 'Still running', kind: 'stable', target: null, status: 'passed', detail: '60 seconds later' }, { name: 'Database checks', kind: 'database', target: 'db', status: 'passed', detail: 'Records' }] } : { outcome: 'ok', healthy: true, running: 2 };
    case 'restore-test-teardown': return { removed: true, counts: { containers: 2, networks: 1 }, keptImages: 0 };
    case 'restore-test-status': return { present: false, containers: 0, networks: 0, firewall: 0, staging: false, journal: false };
    default: throw new Error('unexpected operation ' + name(request));
  }
};
rt.testTransport.upload = async (server, backupId, jobId, { prepare, signal }) => {
  calls.push({ server: server.name, request: { operation: 'upload', backupId }, options: {} });
  if (answers.upload) return answers.upload({ prepare, signal });
  await prepare();
  return { plaintextChecksum: 'f'.repeat(64) };
};

function serverRow(label) {
  const serverId = randomUUID();
  db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(serverId, label, '192.0.2.' + (calls.length % 200 + 1), 22, 'root', 'fixture', '0'.repeat(64), at());
  return serverId;
}
function siteRow(serverId, label = 'shop') {
  const siteId = randomUUID();
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, serverId, label, JSON.stringify({ containers: ['web', 'db'] }), at());
  return siteId;
}
function backupRow(siteId, manifest = { kind: 'docker', architecture: 'x86_64', containers: [{ id: 'a' }, { id: 'b' }] }) {
  const jobId = randomUUID(), backupId = randomUUID();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,started_at,finished_at) VALUES(?,?,'backup','completed','completed',?,?,?)").run(jobId, siteId, at(), at(), at());
  db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(backupId, siteId, jobId, at(), join(directory, backupId + '.enc'), 4096, 'a'.repeat(64), JSON.stringify(manifest), 0, 1, at());
  return backupId;
}
function fixture(label = 'shop', manifest) {
  const live = serverRow(label + '-live'), testServer = serverRow(label + '-test'), siteId = siteRow(live, label), backupId = backupRow(siteId, manifest);
  return { live, testServer, siteId, backupId };
}
const row = testId => rt.loadTest(testId);
const steps = testId => rt.loadSteps(testId).map(step => [step.step, step.state]);
const finished = test => test.result !== null && ['done', 'failed', 'acknowledged'].includes(test.cleanup);
// Worker stand-in: tick, claim one job, run it; when idle, time moves on 11 seconds.
async function drive(testId, { until = finished, rounds = 200, onRound } = {}) {
  for (let round = 0; round < rounds; round++) {
    if (until(row(testId))) return row(testId);
    rt.tickRestoreTests();
    const job = claimJob();
    if (job) await executeJob(job); else now += 11000;
    await onRound?.(row(testId), job);
  }
  throw new Error('restore test did not settle: ' + JSON.stringify({ test: row(testId), steps: steps(testId) }));
}
const ops = testId => calls.filter(call => call.request.testId === testId || call.request.operation === 'upload').map(call => name(call.request));
test.beforeEach(() => { answers = {}; calls.length = 0; });

test('limits: presets and custom numbers in range are stored as numbers; everything else is a plain validation error', () => {
  assert.deepEqual(LIMIT_DEFAULTS, { timeLimitMinutes: 30, memoryMb: 1024, cpus: 1 });
  assert.deepEqual(LIMIT_PRESETS, { timeLimitMinutes: [15, 30, 60, 120], memoryMb: [512, 1024, 2048, 4096, 8192], cpus: [0.5, 1, 2, 4] });
  assert.deepEqual(validateLimits({}), LIMIT_DEFAULTS);
  for (const value of [...LIMIT_PRESETS.timeLimitMinutes, 10, 45, 120]) assert.equal(validateLimits({ timeLimitMinutes: value }).timeLimitMinutes, value);
  for (const value of [...LIMIT_PRESETS.memoryMb, 256, 700, 16384]) assert.equal(validateLimits({ memoryMb: value }).memoryMb, value);
  for (const value of [...LIMIT_PRESETS.cpus, 0.75, 3.25, 16]) assert.equal(validateLimits({ cpus: value }).cpus, value);
  for (const [field, value] of [['timeLimitMinutes', 9], ['timeLimitMinutes', 121], ['timeLimitMinutes', 30.5], ['timeLimitMinutes', '30'], ['memoryMb', 255], ['memoryMb', 16385], ['memoryMb', 1024.5], ['memoryMb', null], ['cpus', 0.25], ['cpus', 16.25], ['cpus', 1.1], ['cpus', '1'], ['cpus', Number.NaN]]) {
    assert.throws(() => validateLimits({ [field]: value }), error => error.status === 400 && error.code === 'INVALID' && error.field === field && /must be/.test(error.message), `${field}=${value}`);
  }
  assert.equal(cpuProblem(2, 4), null);
  assert.equal(cpuProblem(4, 2), 'The test server has 2 CPUs, so it cannot give each container 4. Lower the CPU limit.');
});

test('a Docker test runs every step as short jobs, passes, writes evidence and cleans up; the worker is never held across polls', async () => {
  const f = fixture('passing');
  const { id: testId } = rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'admin-1', probe: { service: 'web', port: 8080, path: '/' } });
  assert.equal(rt.testState(row(testId)), 'queued');
  let jobs = 0;
  const done = await drive(testId, { onRound: (_test, job) => { if (job) { jobs++; assert.equal(job.type, 'restore-test'); assert.equal(JSON.parse(job.details).targetServerId, f.testServer); } } });
  assert.equal(done.result, "passed", JSON.stringify([done.failed_step,done.reason])); assert.equal(done.cleanup, "done"); assert.equal(rt.testState(done), "finished");
  assert.deepEqual(steps(testId), rt.STEPS.map(step => [step, 'done']));
  const order = ops(testId);
  assert.deepEqual(order.slice(0, 6), ['restore-test-check', 'upload', 'restore-test-prepare', 'restore-test-run:restore', 'restore-test-run:start', 'restore-test-run:poll']);
  assert.ok(order.filter(item => item === 'restore-test-run:poll').length >= 6, 'health and stability are polled across ticks');
  assert.deepEqual(order.slice(-2), ['restore-test-teardown', 'restore-test-status']);
  assert.ok(jobs >= 10, 'every server step and every poll is its own job');
  const prepare = calls.find(call => call.request.operation === 'restore-test-prepare');
  assert.equal(prepare.request.reaper.length > 1000, true, 'the reaper source is sent'); assert.equal(prepare.options.keepStdinOpen, true); assert.equal(prepare.request.watchStdin, true);
  assert.deepEqual(calls.find(call => call.request.phase === 'restore').request.limits, { memoryMb: 1024, cpus: 1, internet: false });
  assert.deepEqual(calls.findLast(call => call.request.phase === 'poll').request.probe, { service: 'web', port: 8080, path: '/' });
  assert.ok(Number.isInteger(done.restore_seconds) && done.restore_seconds >= 0); assert.ok(done.total_seconds >= 60);
  assert.deepEqual(done.checks.map(check => check.kind), ['authentic', 'package', 'running', 'stable', 'database']);
  const evidence = backupVerification(f.backupId);
  for (const kind of ['integrity', 'isolatedRestore', 'application']) { assert.equal(evidence[kind].status, 'passed', kind); assert.equal(evidence[kind].method, 'automatic restore test'); assert.equal(evidence[kind].testId, testId); }
  const actions = db.prepare("SELECT action FROM audit_events WHERE action LIKE 'restore_test.%' AND (target=? OR target=?) ORDER BY rowid").all(f.siteId, testId).map(item => item.action);
  assert.deepEqual(actions, ['restore_test.enqueue', 'restore_test.started', 'restore_test.passed', 'restore_test.cleaned']);
  assert.throws(() => db.prepare("UPDATE restore_tests SET result='failed' WHERE id=?").run(testId), /written once/);
  assert.throws(() => db.prepare('UPDATE restore_tests SET reason=? WHERE id=?').run('changed', testId), /written once/);
  assert.throws(() => db.prepare('DELETE FROM restore_tests WHERE id=?').run(testId), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM restore_test_steps WHERE test_id=?').run(testId), /append-only/);
});

test('a static site passes on its digest and skips the container steps', async () => {
  const f = fixture('static', { kind: 'static', containers: [] });
  answers['restore-test-run:restore'] = () => ({ outcome: 'ok', kind: 'static', checks: [{ name: 'Static files', kind: 'static-files', target: null, status: 'passed', detail: '12 files match' }] });
  const { id: testId } = rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'admin-1' });
  const done = await drive(testId);
  assert.equal(done.result, 'passed');
  assert.deepEqual(steps(testId), [['check_space', 'done'], ['copy_backup', 'done'], ['restore_copy', 'done'], ['start_containers', 'skipped'], ['check_health', 'skipped'], ['clean_up', 'done']]);
  assert.equal(calls.find(call => call.request.operation === 'restore-test-check').request.need.kind, 'static');
  assert.throws(() => rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a', probe: { service: 'web', port: 80, path: '/' } }), error => error.code === 'PROBE_STATIC');
});

test('helper verdicts: failed writes backup evidence without downgrading a manual restore; couldnt_run and cancelled write none', async () => {
  const f = fixture('verdicts');
  recordVerification(f.backupId, 'isolatedRestore', { status: 'passed', method: 'fresh mounts and isolated networks' }, null);
  answers['restore-test-run:poll'] = request => request.final ? { outcome: 'failed', reason: 'web stopped after it started (exit code 3).', checks: [{ name: 'Still running', kind: 'stable', target: 'web', status: 'failed', detail: 'Stopped with exit code 3' }] } : { outcome: 'ok', healthy: true };
  const failed = await drive(rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a' }).id);
  assert.equal(failed.result, 'failed'); assert.equal(failed.failed_step, 'check_health'); assert.equal(failed.reason, 'web stopped after it started (exit code 3).'); assert.equal(failed.cleanup, 'done');
  const evidence = backupVerification(f.backupId);
  assert.equal(evidence.isolatedRestore.status, 'passed', 'a manual restore pass is never overwritten'); assert.equal(evidence.isolatedRestore.method, 'fresh mounts and isolated networks');
  const history = db.prepare("SELECT status,json_extract(evidence,'$.method') AS method FROM backup_verification_history WHERE backup_id=? AND kind='isolatedRestore' ORDER BY id").all(f.backupId).map(item => [item.status, item.method]);
  assert.deepEqual(history, [['passed', 'fresh mounts and isolated networks'], ['failed', 'automatic restore test']]);
  const before = db.prepare('SELECT COUNT(*) AS n FROM backup_verification_history WHERE backup_id=?').get(f.backupId).n;
  answers['restore-test-run:poll'] = () => ({ outcome: 'couldnt_run', reason: "Test couldn't finish: memory limit. Raise it in Advanced.", checks: [] });
  const limited = await drive(rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a' }).id);
  assert.equal(limited.result, 'couldnt_run'); assert.match(limited.reason, /memory limit/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backup_verification_history WHERE backup_id=?').get(f.backupId).n, before, 'couldnt_run writes no backup evidence');
  answers['restore-test-check'] = () => ({ ok: false, problems: ['The test server has 2 CPUs, so it cannot give each container 4. Lower the CPU limit.'], facts: { nproc: 2 } });
  const preflight = await drive(rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a', limits: { cpus: 4 } }).id);
  assert.equal(preflight.result, 'couldnt_run'); assert.equal(preflight.failed_step, 'check_space'); assert.equal(preflight.cleanup, 'done', 'nothing reached the server, nothing to clean');
  assert.match(preflight.reason, /has 2 CPUs/); assert.ok(!ops(preflight.id).includes('restore-test-teardown'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backup_verification_history WHERE backup_id=?').get(f.backupId).n, before);
});

test('a failed authentication is backup-side; a lost connection is not; reasons never carry paths or credentials', async () => {
  const f = fixture('copy');
  answers.upload = async () => { throw new Error('Encrypted backup checksum differs from stored checksum'); };
  const bad = await drive(rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a' }).id);
  assert.equal(bad.result, 'failed'); assert.equal(bad.failed_step, 'copy_backup');
  assert.equal(backupVerification(f.backupId).integrity.status, 'failed'); assert.equal(backupVerification(f.backupId).isolatedRestore.status, 'not-tested');
  answers.upload = async ({ prepare }) => { await prepare(); throw Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }); };
  const lost = await drive(rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a' }).id);
  assert.equal(lost.result, 'couldnt_run'); assert.equal(lost.reason, 'The backup could not be copied to the test server.'); assert.equal(lost.cleanup, 'done', 'clean-up ran after prepare');
  assert.ok(ops(lost.id).includes('restore-test-teardown'));
  answers.upload = undefined;
  answers['restore-test-run:restore'] = () => ({ outcome: 'failed', reason: 'Bad file /var/lib/docker-backup-manager/restore/x/unpacked/mount-0-0.tar from postgres://admin:hunter2@db:5432/app', checks: [] });
  const scrubbed = await drive(rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a' }).id);
  assert.equal(scrubbed.reason, 'The test could not finish.', 'a reason that looks like it holds a secret is replaced');
  assert.equal(rt.plainReason('Bad file /var/lib/x/y.tar at https://example.com/a'), 'Bad file [path] at [address]');
  assert.equal(rt.plainReason('x'.repeat(400)).length, 300);
});

test('cancel before start touches no server; cancel during the health checks stops and still cleans up', async () => {
  const f = fixture('cancel');
  const queued = rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a' }).id;
  rt.cancelRestoreTest(queued, 'operator-1');
  const early = await drive(queued);
  assert.equal(early.result, 'cancelled'); assert.equal(early.failed_step, null); assert.equal(early.cleanup, 'done'); assert.deepEqual(ops(queued), []);
  const running = rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a' }).id;
  const late = await drive(running, { onRound: test => { if (test.step === 'check_health' && !test.cancel_requested) rt.cancelRestoreTest(running, 'operator-1'); } });
  assert.equal(late.result, 'cancelled'); assert.equal(late.failed_step, 'check_health'); assert.equal(late.cleanup, 'done');
  assert.ok(ops(running).includes('restore-test-teardown'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM backup_verification_history WHERE backup_id=? AND json_extract(evidence,'$.method')='automatic restore test'").get(f.backupId).n, 0, 'cancelled writes no backup evidence');
});

test('cancel and the time limit abort a long helper call', async () => {
  const f = fixture('abort');
  rt.testTiming.cancelPollMs = 5;
  answers['restore-test-run:restore'] = (_request, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { aborted: true }))));
  const cancelled = rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a' }).id;
  setTimeout(() => rt.cancelRestoreTest(cancelled, 'a'), 30);
  const one = await drive(cancelled);
  assert.equal(one.result, 'cancelled'); assert.equal(one.failed_step, 'restore_copy'); assert.equal(one.cleanup, 'done');
  const timed = rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a', limits: { timeLimitMinutes: 10 } }).id;
  setTimeout(() => { now += 11 * 60000; }, 30);
  const two = await drive(timed);
  assert.equal(two.result, 'couldnt_run'); assert.equal(two.reason, "Test couldn't finish: time limit (10 minutes). Raise it in Advanced.");
  rt.testTiming.cancelPollMs = 1000;
});

test('the time limit also ends a test between polls', async () => {
  const f = fixture('deadline');
  answers['restore-test-run:poll'] = () => ({ outcome: 'ok', healthy: false });
  const testId = rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a', limits: { timeLimitMinutes: 10 } }).id;
  rt.testTiming.stableSeconds = 3600;
  const done = await drive(testId, { rounds: 400, onRound: () => { now += 20000; } });
  rt.testTiming.stableSeconds = 60;
  assert.equal(done.result, 'couldnt_run'); assert.equal(done.failed_step, 'check_health'); assert.match(done.reason, /time limit \(10 minutes\)/); assert.equal(done.cleanup, 'done');
});

test('clean-up retries after 5, 15 and 60 minutes, then needs you; only the test server stays blocked', async () => {
  const f = fixture('cleanup');
  const other = serverRow('other-srv'), otherSite = siteRow(other, 'other');
  answers['restore-test-teardown'] = () => { throw Object.assign(new Error('Clean-up left 1 networks on the test server.'), { remoteReported: true }); };
  answers['restore-test-run:poll'] = request => ({ outcome: 'ok', healthy: true, ...(request.final ? { checks: [{ name: 'Still running', kind: 'stable', target: null, status: 'passed', detail: null }] } : {}) });
  const testId = rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a' }).id;
  now += 1000; const liveSiteBackup = backupRow(f.siteId);
  const stuck = await drive(testId, { rounds: 2000, onRound: () => { now += 60000; } });
  assert.equal(stuck.result, 'passed', 'the verdict stands; clean-up is test-side'); assert.equal(stuck.cleanup, 'failed'); assert.equal(stuck.cleanup_attempts, 4);
  assert.equal(rt.testState(stuck), 'needs_cleanup');
  assert.deepEqual(rt.loadSteps(testId).find(step => step.step === 'clean_up').state, 'failed');
  assert.equal(ops(testId).filter(item => item === 'restore-test-teardown').length, 4);
  assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='restore_test.cleanup_failed' AND target=?").get(f.siteId));
  // The site is not busy: its backup on its own server is queued and claimed.
  const backup = enqueueBackup(f.siteId, 'qa');
  assert.equal(claimJob()?.id, backup.id, 'the tested site backs up on its own server');
  db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(backup.id);
  // Work on the test server waits; other servers do not.
  const testSite = siteRow(f.testServer, 'on-test-server'); backupRow(testSite);
  const blocked = enqueueBackup(testSite, 'qa'), free = enqueueBackup(otherSite, 'qa');
  assert.equal(claimJob()?.id, free.id); db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(free.id);
  assert.equal(claimJob(), undefined, 'a backup on the held test server waits');
  assert.equal(installs.serverBusy(f.testServer), true); assert.equal(installs.serverBusy(other), false);
  db.prepare("INSERT INTO server_installs(id,server_id,package,status,stage,steps,actor,created_at) VALUES(?,?,'nginx','queued','queued','[]','a',?)").run(randomUUID(), f.testServer, at());
  assert.equal(installs.claimInstall(), undefined, 'an install on the held test server waits');
  assert.equal(deletionBlocked(f.backupId), true, 'the lease holds the package until clean-up is resolved'); assert.equal(deletionBlocked(liveSiteBackup), false);
  // A new test for the site is refused while clean-up is unresolved; acknowledging needs a clean server.
  assert.throws(() => rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a' }), error => error.code === 'TEST_ACTIVE');
  answers['restore-test-status'] = () => ({ present: true });
  await assert.rejects(rt.acknowledgeRestoreTestCleanup(testId, 'admin'), error => error.code === 'LEFTOVERS');
  answers['restore-test-status'] = undefined;
  assert.deepEqual(await rt.acknowledgeRestoreTestCleanup(testId, 'admin'), { cleanup: 'acknowledged' });
  assert.equal(claimJob()?.id, blocked.id, 'acknowledged: the test server is free again'); db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(blocked.id);
  db.prepare("UPDATE server_installs SET status='completed' WHERE server_id=?").run(f.testServer);
  assert.equal(deletionBlocked(f.backupId), false);
});

test('retrying a failed clean-up runs teardown again', async () => {
  const f = fixture('retry');
  answers['restore-test-teardown'] = () => { throw Object.assign(new Error('Docker is not running.'), { remoteReported: true }); };
  const testId = rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a' }).id;
  await drive(testId, { rounds: 2000, onRound: () => { now += 60000; } });
  answers['restore-test-teardown'] = undefined;
  assert.deepEqual(rt.retryRestoreTestCleanup(testId, 'admin'), { cleanup: 'pending' });
  const done = await drive(testId);
  assert.equal(done.cleanup, 'done');
});

test('restore test jobs go after every other queued job, and a test waits for a backup due on its server', async () => {
  const f = fixture('order');
  const testId = rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a' }).id;
  rt.tickRestoreTests();
  const queuedTest = db.prepare("SELECT id FROM jobs WHERE type='restore-test' AND json_extract(details,'$.testId')=?").get(testId);
  assert.ok(queuedTest);
  now += 1000;
  const later = enqueueBackup(siteRow(serverRow('elsewhere'), 'later'), 'qa');
  assert.equal(claimJob().id, later.id, 'a backup queued after the test step still goes first');
  db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(later.id);
  assert.equal(claimJob().id, queuedTest.id); db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(queuedTest.id);
  // Backups go first: a policy on the test server due within the time limit keeps the next test from starting.
  const g = fixture('due'), testSite = siteRow(g.testServer, 'due-site');
  db.prepare("INSERT INTO policies(site_id,enabled,schedule,timezone,retention,next_run) VALUES(?,1,'0 3 * * *','UTC',7,?)").run(testSite, new Date(now + 20 * 60000).toISOString());
  const waiting = rt.createRestoreTest({ siteId: g.siteId, serverId: g.testServer, actor: 'a' }).id;
  rt.tickRestoreTests();
  assert.equal(db.prepare("SELECT 1 FROM jobs WHERE type='restore-test' AND json_extract(details,'$.testId')=?").get(waiting), undefined);
  db.prepare('UPDATE policies SET enabled=0 WHERE site_id=?').run(testSite);
  const done = await drive(waiting);
  assert.equal(done.result, 'passed');
  // Leave the first test settled for the next cases.
  db.prepare("UPDATE restore_tests SET cancel_requested=1 WHERE id=?").run(testId);
  await drive(testId);
});

test('one unfinished test per site and one started test per test server; a second server test waits in line', async () => {
  const f = fixture('serial'), second = siteRow(f.live, 'serial-2'); backupRow(second);
  const first = rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a' }).id;
  assert.throws(() => rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a' }), error => error.code === 'TEST_ACTIVE' && error.status === 409);
  const next = rt.createRestoreTest({ siteId: second, serverId: f.testServer, actor: 'a' }).id;
  const holds = test => !!test.started_at && (test.result === null || ['pending', 'failed'].includes(test.cleanup));
  let overlapped = false, waited = false;
  await drive(first, { until: () => finished(row(first)) && finished(row(next)), rounds: 400, onRound: () => { const a = row(first), b = row(next); if (holds(a) && holds(b)) overlapped = true; if ((holds(a) && !b.started_at) || (holds(b) && !a.started_at)) waited = true; } });
  assert.equal(overlapped, false, 'never two tests on one test server'); assert.equal(waited, true, 'the other test waited in line');
  assert.equal(row(first).result, 'passed'); assert.equal(row(next).result, 'passed');
  assert.throws(() => db.prepare("UPDATE restore_tests SET started_at=?,result=NULL WHERE id=?").run(at(), first), /written once/);
});

test('busy() ignores tests: the site backs up, scrubs and restores while its test runs on another server', async () => {
  const f = fixture('busy');
  answers['restore-test-run:poll'] = request => ({ outcome: 'ok', healthy: true, ...(request.final ? { checks: [{ name: 'Still running', kind: 'stable', target: null, status: 'passed', detail: null }] } : {}) });
  const testId = rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a' }).id;
  await drive(testId, { until: test => test.step === 'check_health' });
  const backup = enqueueBackup(f.siteId, 'qa');
  assert.equal(claimJob().id, backup.id); db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(backup.id);
  const scrub = enqueueScrub(f.backupId, 'qa');
  assert.ok(scrub.id); db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(scrub.id);
  assert.equal(deletionBlocked(f.backupId), true);
  const done = await drive(testId);
  assert.equal(done.result, 'passed'); assert.equal(deletionBlocked(f.backupId), false);
});

test('a worker restart ends an interrupted step couldnt_run and cleans up first; an interrupted clean-up runs again', async () => {
  const f = fixture('restart');
  const testId = rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a' }).id;
  await drive(testId, { until: test => test.step === 'restore_copy' });
  rt.tickRestoreTests();
  const job = claimJob(); assert.equal(job.status, 'test_queued'); assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status, 'test_running');
  rt.recoverInterruptedRestoreTests();
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status, 'failed');
  const stopped = row(testId);
  assert.equal(stopped.result, 'couldnt_run'); assert.equal(stopped.failed_step, 'restore_copy'); assert.equal(stopped.reason, 'DockNest restarted during this step, so the test stopped.'); assert.equal(stopped.cleanup, 'pending');
  rt.tickRestoreTests();
  const cleanup = claimJob(); assert.equal(JSON.parse(cleanup.details).step, 'clean_up');
  rt.recoverInterruptedRestoreTests();
  const done = await drive(testId);
  assert.equal(done.cleanup, 'done'); assert.equal(done.result, 'couldnt_run');
});

test('creating a test refuses unknown servers, the live server without opt-in, missing backups and external storage', () => {
  const f = fixture('create');
  assert.throws(() => rt.createRestoreTest({ siteId: f.siteId, serverId: randomUUID(), actor: 'a' }), error => error.code === 'NO_TEST_SERVER');
  assert.throws(() => rt.createRestoreTest({ siteId: f.siteId, serverId: f.live, actor: 'a' }), error => error.code === 'LIVE_SERVER_NOT_ALLOWED');
  assert.throws(() => rt.createRestoreTest({ siteId: f.siteId, serverId: f.testServer, actor: 'a', limits: { memoryMb: 100 } }), error => error.code === 'INVALID');
  const empty = siteRow(f.live, 'empty');
  assert.throws(() => rt.createRestoreTest({ siteId: empty, serverId: f.testServer, actor: 'a' }), error => error.code === 'NO_VERIFIED_BACKUP');
  const external = siteRow(f.live, 'external'); backupRow(external, { kind: 'docker', containers: [{}], excludedPaths: [{ path: '/mnt/media', requiredForRestore: true }] });
  assert.throws(() => rt.createRestoreTest({ siteId: external, serverId: f.testServer, actor: 'a' }), error => error.code === 'EXTERNAL_STORAGE');
  const live = rt.createRestoreTest({ siteId: f.siteId, serverId: f.live, liveServer: true, actor: 'a', limits: { memoryMb: 700, cpus: 0.75, timeLimitMinutes: 45 } }).id;
  assert.deepEqual(row(live).limits, { timeLimitMinutes: 45, memoryMb: 700, cpus: 0.75, internet: false, liveServer: true });
  db.prepare('UPDATE restore_tests SET cancel_requested=1 WHERE id=?').run(live); rt.tickRestoreTests();
});

test('upgrade safety: with no restore test rows the tick, claims and busy rules behave as before', () => {
  const live = serverRow('plain'), siteId = siteRow(live, 'plain');
  const before = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
  rt.tickRestoreTests();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM restore_test_settings').get().n, 0, 'tests are off for every site');
  const job = enqueueBackup(siteId, 'qa');
  assert.equal(claimJob().id, job.id); db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(job.id);
});
