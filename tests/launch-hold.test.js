// Launch hold and claim (docs/launch-site.md, "Locks" and "Security review changes" items 11, 12 and 15): every claim
// (CLAIMABLE_JOB_SQL, claimInstall, the restore test start) treats a launch as a hold on its server; scheduled backups
// of other sites queue behind it and run once it is released (before the first backup); claimLaunch waits for other
// work on the server and starts the hold in the same transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-launch-hold-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { db } = await import('../src/db.js');
const { claimJob, tickScheduler } = await import('../src/engine.js');
const { claimInstall, serverBusy } = await import('../src/installs.js');
const { advanceRestoreTest } = await import('../src/restore-tests/engine.js');
const { busyReason } = await import('../src/server-cleanup.js');
const { launchHeld, launchActive } = await import('../src/launches/hold.js');
const { claimLaunch, interruptLaunchSteps } = await import('../src/launches/claim.js');
const at = () => new Date().toISOString();

const serverRow = name => { const serverId = randomUUID(); db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(serverId, name, 'h', 22, 'root', 'k', '0'.repeat(64), at()); return serverId; };
const siteRow = (serverId, name) => { const siteId = randomUUID(); db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, serverId, name, JSON.stringify({ kind: 'compose', containers: ['app'] }), at()); return siteId; };
const STEPS = ['check', 'fetch', 'build', 'start', 'check_health', 'web', 'certificate', 'save', 'maintenance', 'first_backup', 'teardown'];
function launch(serverId, { state = 'queued', steps = { check: 'launch_queued' } } = {}) {
  const launchId = randomUUID();
  db.prepare("INSERT INTO site_launches(id,server_id,slug,source,domain,state,created_by,created_at,updated_at) VALUES(?,?,?,'compose',?,?,'admin',?,?)").run(launchId, serverId, 'site-' + launchId.slice(0, 8), launchId.slice(0, 8) + '.example.com', state, at(), at());
  for (const step of STEPS) db.prepare('INSERT INTO site_launch_steps(launch_id,step,state) VALUES(?,?,?)').run(launchId, step, steps[step] ?? 'pending');
  return launchId;
}
const setStep = (launchId, step, state) => db.prepare('UPDATE site_launch_steps SET state=? WHERE launch_id=? AND step=?').run(state, launchId, step);
const setLaunch = (launchId, state) => db.prepare('UPDATE site_launches SET state=? WHERE id=?').run(state, launchId);
const job = (siteId, status = 'queued', type = 'backup', details = {}) => { const jobId = randomUUID(); db.prepare('INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,?,?,?,?,?)').run(jobId, siteId, type, status, status, at(), JSON.stringify(details)); return jobId; };
const finish = jobId => db.prepare("UPDATE jobs SET status='completed',stage='completed',finished_at=? WHERE id=?").run(at(), jobId);
const reset = () => { db.exec("UPDATE jobs SET status='completed' WHERE status NOT IN ('completed','failed'); UPDATE server_installs SET status='completed' WHERE status IN ('queued','running'); UPDATE site_launch_steps SET state='done' WHERE state IN ('launch_queued','launch_running'); UPDATE site_launches SET state='failed' WHERE state IN ('queued','running','needs_attention')"); };

test('a running launch step holds its server for site jobs, the install claim and the restore test start; other servers run', () => {
  reset();
  const server = serverRow('launch-srv'), free = serverRow('free-srv'), siteA = siteRow(server, 'a'), siteB = siteRow(free, 'b');
  const launchId = launch(server, { state: 'running', steps: { check: 'done', fetch: 'launch_running' } });
  assert.equal(launchHeld(server), true); assert.equal(launchHeld(free), false); assert.equal(serverBusy(server), true);
  assert.equal(busyReason(server), 'A new site is being launched on this server.', 'a server cleanup waits too');
  const backup = job(siteA), other = job(siteB);
  assert.equal(claimJob()?.id, other, 'only the job on the other server starts'); finish(other);
  assert.equal(claimJob() ?? null, null, 'the backup on the launch server waits');
  // A restore test step on the held server (as its test server) waits too, and a site move job that targets it.
  const moveJob = job(siteB, 'move_queued', 'site-move', { moveId: 'm', sourceServerId: free, targetServerId: server });
  assert.equal(claimJob() ?? null, null);
  db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(moveJob);
  const install = randomUUID(); db.prepare("INSERT INTO server_installs(id,server_id,package,status,stage,steps,actor,created_at) VALUES(?,?,'git','queued','queued','[]','admin',?)").run(install, server, at());
  assert.equal(claimInstall(), undefined, 'the install waits');
  const testId = randomUUID();
  db.prepare("INSERT INTO restore_tests(id,site_id,backup_captured_at,server_id,trigger,limits,created_by,created_at) VALUES(?,?,?,?,'manual',?,'admin',?)").run(testId, siteB, at(), server, JSON.stringify({ timeLimitMinutes: 30, memoryMb: 1024, cpus: 1 }), at());
  assert.equal(advanceRestoreTest(testId), null, 'the restore test does not start');
  // Between steps (the step finished, the next is queued) the launch still holds until its site is saved.
  setStep(launchId, 'fetch', 'done'); setStep(launchId, 'build', 'launch_queued');
  assert.equal(launchHeld(server), true); assert.equal(claimJob() ?? null, null);
  // Waiting between health checks (nothing running) still holds.
  setStep(launchId, 'build', 'done'); setStep(launchId, 'start', 'done'); setStep(launchId, 'check_health', 'waiting');
  assert.equal(claimJob() ?? null, null);
  // Saved: the hold is released before the first backup, so the waiting backup (and the first backup) can run.
  for (const step of ['check_health', 'web', 'certificate', 'save']) setStep(launchId, step, 'done');
  assert.equal(launchHeld(server), false);
  assert.equal(claimJob()?.id, backup); finish(backup);
  assert.equal(claimInstall()?.id, install);
  db.prepare("UPDATE server_installs SET status='completed' WHERE id=?").run(install);
  assert.ok(advanceRestoreTest(testId), 'the restore test starts after the launch');
  db.prepare("UPDATE jobs SET status='completed' WHERE type='restore-test'").run();
  db.prepare("UPDATE restore_tests SET result='cancelled',cleanup='done' WHERE id=?").run(testId);
});

test('Check again on a saved site and a failed teardown hold the server; a queued launch does not until it starts', () => {
  reset();
  const server = serverRow('saved-srv'), site = siteRow(server, 'c');
  const launchId = launch(server, { state: 'waiting_dns', steps: Object.fromEntries(STEPS.map(step => [step, step === 'teardown' ? 'pending' : step === 'certificate' ? 'waiting' : 'done'])) });
  assert.equal(launchHeld(server), false, 'waiting for DNS holds nothing');
  setStep(launchId, 'certificate', 'launch_queued');
  assert.equal(launchHeld(server), false, 'a queued certificate step holds nothing yet');
  setStep(launchId, 'certificate', 'launch_running');
  const backup = job(site);
  assert.equal(claimJob() ?? null, null, 'a running certificate step holds the server');
  setStep(launchId, 'certificate', 'done'); setLaunch(launchId, 'done');
  assert.equal(claimJob()?.id, backup); finish(backup);
  const broken = launch(server, { state: 'needs_attention', steps: { check: 'done', fetch: 'failed', teardown: 'failed' } });
  assert.equal(launchHeld(server), true, 'needs_attention keeps the hold'); assert.equal(launchActive(server), broken);
  const later = job(site);
  assert.equal(claimJob() ?? null, null);
  setLaunch(broken, 'failed');
  const queued = launch(server);
  assert.equal(launchHeld(server), false, 'a queued launch does not hold before it starts');
  assert.equal(launchActive(server), queued, 'but it counts as the one launch of this server');
  assert.equal(claimJob()?.id, later); finish(later);
});

test('first_backup never holds the server, so the first backup job (and others) can run while it is open', () => {
  reset();
  const server = serverRow('first-backup-srv'), site = siteRow(server, 'launched');
  const launchId = launch(server, { state: 'running', steps: Object.fromEntries(STEPS.map(step => [step, step === 'first_backup' ? 'launch_running' : step === 'teardown' ? 'pending' : 'done'])) });
  assert.equal(launchHeld(server), false, 'even a first_backup step marked running holds nothing');
  const backup = job(site);
  assert.equal(claimJob()?.id, backup, 'the first backup runs'); finish(backup);
  setStep(launchId, 'first_backup', 'done'); setLaunch(launchId, 'done');
});

test('scheduled backups of other sites queue behind the hold instead of being skipped, then run', () => {
  reset();
  const server = serverRow('sched-srv'), site = siteRow(server, 'scheduled');
  db.prepare("INSERT INTO policies(site_id,enabled,schedule,timezone,retention,next_run) VALUES(?,1,'0 3 * * *','UTC',7,?)").run(site, new Date(Date.now() - 60_000).toISOString());
  launch(server, { state: 'running', steps: { check: 'launch_running' } });
  tickScheduler();
  const queued = db.prepare("SELECT id,status FROM jobs WHERE site_id=? AND type='backup'").get(site);
  assert.equal(queued?.status, 'queued', 'the due backup is queued, not skipped');
  assert.equal(claimJob() ?? null, null, 'and waits');
  db.exec("UPDATE site_launch_steps SET state='failed' WHERE state='launch_running'; UPDATE site_launches SET state='failed' WHERE state='running'");
  assert.equal(claimJob()?.id, queued.id, 'it runs once the hold is gone'); finish(queued.id);
});

test('claimLaunch waits for other work on the server, starts the hold atomically and runs one launch step per server', () => {
  reset();
  const server = serverRow('claim-srv'), other = serverRow('claim-other'), site = siteRow(server, 'busy');
  const running = job(site, 'running');
  const first = launch(server);
  assert.equal(claimLaunch(), null, 'a running backup on the server comes first');
  finish(running);
  db.prepare("INSERT INTO settings(key,value) VALUES('deployment_hold','true')").run();
  assert.equal(claimLaunch(), null, 'no new work during a deployment hold');
  db.prepare("DELETE FROM settings WHERE key='deployment_hold'").run();
  const claimed = claimLaunch();
  assert.deepEqual({ ...claimed, serverId: undefined }, { launchId: first, step: 'check', attempt: 1, serverId: undefined });
  const row = db.prepare('SELECT state,started_at FROM site_launches WHERE id=?').get(first);
  assert.equal(row.state, 'running'); assert.ok(row.started_at);
  assert.equal(db.prepare("SELECT state FROM site_launch_steps WHERE launch_id=? AND step='check'").get(first).state, 'launch_running');
  assert.equal(claimLaunch(), null, 'nothing else queued');
  // A saved launch's certificate retry on the same server waits for the running step of another launch there.
  const saved = launch(server, { state: 'waiting_dns', steps: { certificate: 'launch_queued', save: 'done' } });
  const elsewhere = launch(other);
  assert.equal(claimLaunch()?.launchId, elsewhere, 'another server is free');
  assert.equal(claimLaunch(), null, 'one launch step per server at a time');
  setStep(first, 'check', 'done');
  assert.equal(claimLaunch()?.launchId, saved);
  // Worker restart: running steps are marked failed (the engine then reads launch-status); the hold stays.
  assert.equal(interruptLaunchSteps(), 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM site_launch_steps WHERE state='launch_running'").get().n, 0);
  assert.equal(JSON.parse(db.prepare("SELECT result FROM site_launch_steps WHERE launch_id=? AND step='check'").get(elsewhere).result).interrupted, 1);
  assert.equal(launchHeld(other), true, 'the interrupted launch still holds its server');
});

test('a started restore test or an active move keeps claimLaunch away from that server', () => {
  reset();
  const server = serverRow('test-srv'), live = serverRow('live-srv'), site = siteRow(live, 'tested');
  const testId = randomUUID();
  db.prepare("INSERT INTO restore_tests(id,site_id,backup_captured_at,server_id,trigger,limits,created_by,created_at,started_at) VALUES(?,?,?,?,'manual','{}','admin',?,?)").run(testId, site, at(), server, at(), at());
  launch(server);
  assert.equal(claimLaunch(), null);
  db.prepare("UPDATE restore_tests SET result='passed',cleanup='done' WHERE id=?").run(testId);
  const moveId = randomUUID();
  db.prepare("INSERT INTO site_moves(id,site_id,source_server_id,target_server_id,state,options,preflight,preflight_hash,actor,created_at,updated_at) VALUES(?,?,?,?,'running','{}','{}','h','admin',?,?)").run(moveId, site, live, server, at(), at());
  assert.equal(claimLaunch(), null);
  db.prepare("UPDATE site_moves SET state='failed' WHERE id=?").run(moveId);
  assert.ok(claimLaunch());
});

// Rollback safety (docs/upgrading.md, "Launching sites in 2.16"): the install readers of 2.14 and 2.15 are the ones in
// src/installs.js minus the launch hold clauses, so this is what an older release does with git rows: it lists them and,
// for one still queued, its helper answers UNKNOWN_PACKAGE and the job fails with a fixed sentence. Nothing is installed.
test('git install rows are read like any install, and a queued one fails plainly on a helper without git', async () => {
  reset();
  const { transport } = await import('../src/engine.js');
  const { findInstall, executeInstall } = await import('../src/installs.js');
  const server = serverRow('rollback-srv'), done = randomUUID(), queued = randomUUID();
  db.prepare("INSERT INTO server_installs(id,server_id,package,status,stage,steps,actor,created_at,finished_at) VALUES(?,?,'git','completed','completed','[{\"name\":\"Installing Git\",\"status\":\"done\"}]','admin',?,?)").run(done, server, at(), at());
  db.prepare("INSERT INTO server_installs(id,server_id,package,status,stage,steps,actor,created_at) VALUES(?,?,'git','queued','queued','[{\"name\":\"Connected\",\"status\":\"queued\"}]','admin',?)").run(queued, server, at());
  assert.deepEqual(findInstall(done).details, { serverId: server, package: 'git', steps: [{ name: 'Installing Git', status: 'done' }] });
  const original = transport.remote;
  transport.remote = async () => { throw Object.assign(new Error('UNKNOWN_PACKAGE'), { remoteReported: true }); };
  try { const job = claimInstall(); assert.equal(job.id, queued); await executeInstall(job); }
  finally { transport.remote = original; }
  const row = findInstall(queued);
  assert.equal(row.status, 'failed'); assert.equal(row.error, 'DockNest cannot install that.');
});

test('a self-heal restart is claimable while a launch step runs on the same server (a launch can build for 30 minutes)', async () => {
  const { CLAIMABLE_HEAL_SQL } = await import('../src/job-claim.js');
  reset();
  const server = serverRow('heal-srv'), site = siteRow(server, 'healed');
  const launchId = launch(server, { state: 'running', steps: { check: 'done', fetch: 'done', build: 'launch_running' } });
  assert.equal(launchHeld(server), true, 'the launch holds the server for every other job');
  const backup = job(site);
  assert.equal(claimJob() ?? null, null, 'a backup waits behind the launch');
  const heal = job(site, 'heal_queued', 'self-heal');
  db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(backup);
  assert.equal(db.prepare(CLAIMABLE_HEAL_SQL).get()?.id, heal, 'the restart is not held by the launch');
  setLaunch(launchId, 'needs_attention');
  assert.equal(db.prepare(CLAIMABLE_HEAL_SQL).get()?.id, heal, 'nor by a launch that needs attention');
});

test('claimLaunch waits for a running Safe Edit step, a Safe Edit between health polls and a running self-heal restart on its server', () => {
  for (const status of ['edit_running', 'edit_waiting', 'heal_running']) {
    reset();
    const server = serverRow('claim-' + status), site = siteRow(server, 'busy');
    const first = launch(server);
    const busy = job(site, status, status === 'heal_running' ? 'self-heal' : 'site-edit');
    assert.equal(claimLaunch(), null, `a ${status} job holds the launch`);
    finish(busy);
    assert.equal(claimLaunch()?.launchId, first, `the launch starts once ${status} has ended`);
  }
});
