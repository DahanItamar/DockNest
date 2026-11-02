// Self-heal (docs/self-heal.md) against a fake helper, a fake SSH client and a fake clock: event validation, episodes,
// the window, gap and limit, dedupe and throttle, the busy/maintenance/move/settle skips, claim ordering and the
// queued-backup yield (no deadlock), restart outcomes, alerts, recovery after a worker restart, the purge, the stream
// lifecycle with reconnect backoff (fake timers), and the API. Real Docker is covered by scripts/integration-self-heal.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-self-heal-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const { claimJob, executeJob } = await import('../src/engine.js');
const heal = await import('../src/self-heal/engine.js');
const streams = await import('../src/self-heal/streams.js');
const limits = await import('../src/self-heal/limits.js');
const routes = await import('../src/self-heal/routes.js');
const store = await import('../src/alerts/store.js');
const { CLAIMABLE_JOB_SQL } = await import('../src/job-claim.js');
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
test.after(() => { streams.stopStreams(); listener.close(); });

let now = Date.parse('2026-11-02T08:00:00.000Z');
heal.healClock.now = () => now;
const at = (ms = now) => new Date(ms).toISOString();
const ID = c => c.repeat(64);
let restartAnswer = () => ({ outcome: 'restarted' });
const restarts = [];
heal.healTransport.remote = async (server, request) => { restarts.push(request); return restartAnswer(request); };

function serverRow(label = 'host') {
  const serverId = randomUUID();
  db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(serverId, label, '192.0.2.10', 22, 'root', 'fixture', '0'.repeat(64), at());
  return serverId;
}
function siteRow(serverId, label = 'shop', containers = ['shop-web-1', 'shop-db-1']) {
  const siteId = randomUUID();
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, serverId, label, JSON.stringify({ containers, maintenance: { required: true, directory: '/var/lib/docknest/maintenance/' + label } }), at());
  return siteId;
}
function enable(siteId, { max = 3, window = 60, watched = [{ name: 'shop-web-1', project: 'shop', service: 'web' }, { name: 'shop-db-1', project: 'shop', service: 'db' }] } = {}) {
  db.prepare('INSERT INTO self_heal_settings(site_id,enabled,max_restarts,window_minutes,watched,updated_at,updated_by) VALUES(?,1,?,?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET enabled=1,max_restarts=excluded.max_restarts,window_minutes=excluded.window_minutes,watched=excluded.watched')
    .run(siteId, max, window, JSON.stringify(watched), at(), 'admin');
}
function fixture(label) { const serverId = serverRow(label + '-host'), siteId = siteRow(serverId, label); enable(siteId); return { serverId, siteId }; }
const history = siteId => db.prepare('SELECT kind,reason,container FROM self_heal_events WHERE site_id=? ORDER BY at,rowid').all(siteId).map(row => row.reason ? `${row.container}:${row.kind}:${row.reason}` : `${row.container}:${row.kind}`);
const unhealthy = (f, container = 'shop-web-1', id = ID('a')) => heal.recordHealth({ siteId: f.siteId, serverId: f.serverId, container, status: 'unhealthy', id });
const healthy = (f, container = 'shop-web-1', id = ID('a')) => heal.recordHealth({ siteId: f.siteId, serverId: f.serverId, container, status: 'healthy', id });
const jobsOf = siteId => db.prepare("SELECT status,stage FROM jobs WHERE site_id=? AND type='self-heal' ORDER BY created_at,rowid").all(siteId).map(row => `${row.status}/${row.stage}`);
async function work() { let ran = 0; for (let job = claimJob(); job; job = claimJob()) { await executeJob(job); ran++; } return ran; }
function queueJob(siteId, { type = 'backup', status = 'queued', finishedAt = null, details = {} } = {}) {
  const jobId = randomUUID();
  db.prepare('INSERT INTO jobs(id,site_id,type,status,stage,created_at,finished_at,details) VALUES(?,?,?,?,?,?,?,?)').run(jobId, siteId, type, status, status, at(), finishedAt, JSON.stringify(details));
  return jobId;
}
test.beforeEach(() => { restarts.length = 0; restartAnswer = () => ({ outcome: 'restarted' }); now += 3600_000; });

test('limits: defaults 3 per hour, 60 s apart; backoff 5 s doubling to 5 minutes with jitter', () => {
  assert.deepEqual(limits.LIMITS, { maxRestarts: { min: 1, max: 10, default: 3 }, windowMinutes: { min: 10, max: 1440, default: 60 } });
  assert.equal(limits.MIN_GAP_MS, 60_000); assert.equal(limits.THROTTLE_MS, 10_000); assert.equal(limits.SETTLE_MS, 120_000);
  const middle = () => 0.5;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 20].map(n => limits.backoffMs(n, middle)), [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
  assert.equal(limits.backoffMs(0, () => 0), 4000); assert.equal(limits.backoffMs(0, () => 1), 6000);
  assert.equal(limits.backoffMs(10, () => 1), 300000, 'never above 5 minutes');
  assert.equal(limits.backoffMs(10, () => 0), 240000);
});

test('event validation keeps exactly the five fields with known values', () => {
  const good = { container: 'shop-web-1', status: 'unhealthy', at: 1762070400.1, id: ID('a'), timeNano: 1762070400123456789 };
  assert.deepEqual(streams.validEvent(good), good);
  assert.deepEqual(streams.validEvent({ ...good, timeNano: 0 }), { ...good, timeNano: 0 }, 'the connect snapshot');
  for (const bad of [null, [], 'x', { ...good, labels: { a: 1 } }, { ...good, status: 'dead' }, { ...good, container: 'a b' }, { ...good, container: '-x' }, { ...good, id: 'abc' }, { ...good, id: ID('A') }, { ...good, at: '1' }, { ...good, timeNano: '1' }, { ...good, timeNano: -1 }, (({ at: _a, ...rest }) => rest)(good)])
    assert.equal(streams.validEvent(bad), null, JSON.stringify(bad)?.slice(0, 80));
});

test('an unhealthy container is restarted once per episode; healthy closes it; starting is ignored', async () => {
  const f = fixture('episode');
  assert.ok(unhealthy(f));
  assert.equal(unhealthy(f), null, 'a second unhealthy while the episode is open adds nothing');
  assert.deepEqual(jobsOf(f.siteId), ['heal_queued/queued']);
  assert.equal(await work(), 1);
  assert.deepEqual(restarts.map(r => [r.operation, r.name, r.project, r.service, r.containerId, r.siteKey, r.maintenanceDirectory]), [['self-heal-restart', 'shop-web-1', 'shop', 'web', ID('a'), f.siteId, '/var/lib/docknest/maintenance/episode']]);
  assert.deepEqual(jobsOf(f.siteId), ['completed/completed']);
  assert.equal(heal.recordHealth({ siteId: f.siteId, serverId: f.serverId, container: 'shop-web-1', status: 'starting', id: ID('a') }), null);
  healthy(f);
  assert.equal(healthy(f), null, 'only one recovered per episode');
  assert.deepEqual(history(f.siteId), ['shop-web-1:unhealthy', 'shop-web-1:restarted', 'shop-web-1:recovered']);
  // Unknown containers and other sites' names never record anything.
  assert.equal(unhealthy(f, 'other'), null);
  assert.equal(heal.recordHealth({ siteId: f.siteId, serverId: f.serverId, container: 'shop-web-1', status: 'unhealthy', id: 'nope' }), null);
});

test('window, 60 s gap and limit: exactly N restarts, then limit_reached and one gave_up per window', async () => {
  const f = fixture('limits'); enable(f.siteId, { max: 2, window: 10 });
  for (let round = 0; round < 4; round++) {
    unhealthy(f); heal.tickSelfHeal(); await work();
    now += 20_000; heal.tickSelfHeal(); await work(); // inside the gap: nothing
    now += 45_000; heal.tickSelfHeal(); await work();
  }
  assert.equal(restarts.length, 2, 'exactly N restarts');
  const kinds = history(f.siteId);
  assert.deepEqual(kinds.slice(0, 4), ['shop-web-1:unhealthy', 'shop-web-1:restarted', 'shop-web-1:unhealthy', 'shop-web-1:restarted']);
  assert.deepEqual(kinds.slice(4), ['shop-web-1:unhealthy', 'shop-web-1:limit_reached:limit', 'shop-web-1:unhealthy', 'shop-web-1:limit_reached:limit']);
  const audits = db.prepare("SELECT action,detail FROM audit_events WHERE target=? AND action LIKE 'self_heal.%' ORDER BY created_at,rowid").all(f.siteId).map(row => [row.action, JSON.parse(row.detail)]);
  assert.deepEqual(audits.map(([action, detail]) => [action, detail.firstInWindow ?? detail.reason]), [['self_heal.restarted', true], ['self_heal.restarted', false], ['self_heal.gave_up', 'limit']]);
  // A new window: restarts again.
  now += 11 * 60_000; unhealthy(f); heal.tickSelfHeal(); await work();
  assert.equal(restarts.length, 3);
  assert.equal(JSON.parse(db.prepare("SELECT detail FROM audit_events WHERE target=? AND action='self_heal.restarted' ORDER BY created_at DESC,rowid DESC").get(f.siteId).detail).firstInWindow, true);
});

test('busy, queued work, maintenance, move and settle make a restart wait (recorded once), then it happens', async () => {
  const f = fixture('skips');
  const running = queueJob(f.siteId, { status: 'running' });
  unhealthy(f); heal.tickSelfHeal(); heal.tickSelfHeal();
  assert.deepEqual(history(f.siteId), ['shop-web-1:unhealthy', 'shop-web-1:skipped:site_busy'], 'recorded once');
  assert.deepEqual(jobsOf(f.siteId), [], 'no restart job while the site is busy');
  db.prepare("UPDATE jobs SET status='completed',finished_at=? WHERE id=?").run(at(), running);
  now += 30_000; heal.tickSelfHeal();
  assert.equal(heal.blockReason(f.siteId), 'settling'); assert.deepEqual(jobsOf(f.siteId), []);
  now += 91_000; heal.tickSelfHeal(); await work();
  assert.equal(restarts.length, 1, 'restarted after the settle time');
  // Maintenance as DockNest last set it.
  db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?)').run(randomUUID(), 'admin', 'maintenance.set', f.siteId, JSON.stringify({ enabled: true }), at());
  assert.equal(heal.blockReason(f.siteId), 'maintenance');
  now += 1000;
  db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?)').run(randomUUID(), 'admin', 'maintenance.set', f.siteId, JSON.stringify({ enabled: false }), at());
  assert.equal(heal.blockReason(f.siteId), null);
  // An unfinished move.
  const target = serverRow('skips-target');
  db.prepare("INSERT INTO site_moves(id,site_id,source_server_id,target_server_id,state,options,preflight,preflight_hash,actor,created_at,updated_at) VALUES(?,?,?,?,'copying','{}','{}','x','admin',?,?)").run(randomUUID(), f.siteId, f.serverId, target, at(), at());
  assert.equal(heal.blockReason(f.siteId), 'moving');
  // Safe Edit: queued, running, resting between health polls, and an unfinished edit between its steps.
  const g = fixture('skips-edit');
  for (const [status, reason] of [['edit_queued', 'work_queued'], ['edit_running', 'site_busy'], ['edit_waiting', 'site_busy']]) {
    const jobId = queueJob(g.siteId, { type: 'site-edit', status });
    assert.equal(heal.blockReason(g.siteId), reason, status);
    db.prepare("UPDATE jobs SET status='completed',finished_at=? WHERE id=?").run(at(now - 600_000), jobId);
  }
  assert.equal(heal.blockReason(g.siteId), null);
  const editId = randomUUID();
  db.prepare("INSERT INTO site_edits(id,site_id,server_id,state,created_by,created_at) VALUES(?,?,?,'running','admin',?)").run(editId, g.siteId, g.serverId, at());
  assert.equal(heal.blockReason(g.siteId), 'site_busy');
});

test('claim: heal jobs go first, are site-scoped, block their own site and never deadlock with a queued backup', async () => {
  const serverId = serverRow('claim-host'), a = siteRow(serverId, 'claim-a'), b = siteRow(serverId, 'claim-b');
  enable(a); enable(b);
  const fa = { serverId, siteId: a }, fb = { serverId, siteId: b };
  // A backup of site B runs on the shared server: site A still heals (site-scoped), but B's restart waits.
  const backupB = queueJob(b, { status: 'running' });
  unhealthy(fa); unhealthy(fb);
  assert.deepEqual(jobsOf(a), ['heal_queued/queued']); assert.deepEqual(jobsOf(b), [], 'B is busy');
  const olderBackup = queueJob(siteRow(serverRow('other'), 'claim-other'), { status: 'queued' }); // older work on another server
  db.prepare("UPDATE jobs SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(olderBackup);
  const first = claimJob();
  assert.equal(first.type, 'self-heal', 'heal jobs sort before older queued work'); assert.equal(first.site_id, a);
  // While A's restart runs, a backup of A waits; site B's work and other servers are unaffected.
  const backupA = queueJob(a);
  assert.notEqual(db.prepare(CLAIMABLE_JOB_SQL).get()?.id, backupA);
  const editA = queueJob(a, { type: 'site-edit', status: 'edit_queued' });
  assert.notEqual(db.prepare(CLAIMABLE_JOB_SQL).get()?.id, editA, 'a running restart holds a Safe Edit of its site');
  db.prepare('DELETE FROM jobs WHERE id=?').run(editA);
  await executeJob({ ...first, status: 'heal_running' });
  db.prepare("UPDATE jobs SET status='completed',finished_at=? WHERE id IN (?,?)").run(at(), backupB, olderBackup);
  // Queued heal plus queued backup for the same site: the heal yields (skipped), then the backup is claimed.
  db.prepare("DELETE FROM jobs WHERE id=? AND status='queued'").run(backupA);
  now += 200_000; unhealthy(fb); heal.tickSelfHeal();
  const healB = db.prepare("SELECT id FROM jobs WHERE site_id=? AND status='heal_queued'").get(b);
  assert.ok(healB, 'B has a queued restart');
  const backupQueued = queueJob(b);
  const next = claimJob();
  assert.equal(next.id, backupQueued, 'the backup starts; the restart stepped aside');
  assert.equal(db.prepare('SELECT status,stage FROM jobs WHERE id=?').get(healB.id).stage, 'skipped');
  assert.match(history(b).at(-1), /skipped:work_queued$/);
  db.prepare("UPDATE jobs SET status='completed',finished_at=? WHERE id=?").run(at(), next.id);
});

test('restart outcomes: failure counts and alerts as restarted, refusals are skipped, recreated gives up, SSH errors restart nothing', async () => {
  db.exec("DELETE FROM alert_outbox;DELETE FROM alert_lines;DELETE FROM alert_nodes;DELETE FROM connections");
  const f = fixture('outcomes');
  db.prepare("UPDATE servers SET name='Ashburn-1' WHERE id=?").run(f.serverId);
  const credential = store.createCredential({ kind: 'telegram', name: 'Bot', config: { token: '123456789:' + 'AbCdEf_-12'.repeat(4).slice(0, 35) } }, 'test');
  const channel = store.createChannel({ kind: 'telegram', name: 'Phone', credentialId: credential.id, config: { chatId: '-1001234567890' } }, 'test');
  store.createRule({ channelId: channel.id, sourceKind: 'site', sourceId: f.siteId, events: ['self_heal.restarted', 'self_heal.gave_up'] }, 'test');
  const clock = () => new Date(now).toISOString().slice(11, 16) + ' UTC';
  restartAnswer = () => ({ outcome: 'failed', code: 'exit_1', exitCode: 1, message: 'Docker could not restart the container.' });
  const failedAt = clock(); unhealthy(f); await work();
  assert.match(history(f.siteId).at(-1), /restart_failed:exit_1$/);
  assert.equal(db.prepare("SELECT error FROM jobs WHERE site_id=? AND type='self-heal'").get(f.siteId).error, 'Docker could not restart the container.');
  now += 61_000; restartAnswer = () => ({ outcome: 'restarted' }); unhealthy(f); await work();
  now += 61_000; restartAnswer = () => ({ outcome: 'refused', code: 'not_unhealthy' }); unhealthy(f); await work();
  now += 61_000; restartAnswer = () => ({ outcome: 'refused', code: 'recreated' }); const recreatedAt = clock(); unhealthy(f); await work();
  now += 61_000; restartAnswer = () => { throw new Error('connect ECONNREFUSED 192.0.2.10:22'); }; unhealthy(f); await work();
  now += 61_000; restartAnswer = () => ({ outcome: 'refused', code: 'something-new' }); unhealthy(f); await work();
  now += 61_000; restartAnswer = () => ({ outcome: 'refused', code: 'busy' }); unhealthy(f); await work();
  const asked = jobsOf(f.siteId).length; heal.tickSelfHeal(); await work();
  assert.equal(jobsOf(f.siteId).length, asked, 'a server-side refusal is not re-asked every tick');
  assert.deepEqual(history(f.siteId).filter(item => !item.endsWith(':unhealthy')), ['shop-web-1:restart_failed:exit_1', 'shop-web-1:restarted', 'shop-web-1:skipped:not_unhealthy', 'shop-web-1:skipped:recreated', 'shop-web-1:skipped:unreachable', 'shop-web-1:skipped:unavailable', 'shop-web-1:skipped:locked']);
  const outbox = db.prepare('SELECT event,message FROM alert_outbox ORDER BY created_at,rowid').all().map(row => `${row.event}|${row.message}`);
  assert.deepEqual(outbox, [
    `self_heal.restarted|Self-heal could not restart a container of outcomes on Ashburn-1 at ${failedAt}. Open DockNest to see why.`,
    `self_heal.gave_up|Self-heal stopped: a watched container of outcomes on Ashburn-1 was recreated at ${recreatedAt}. Open DockNest to check it.`,
  ], 'only the first restart of the window and the gave_up alert; never stderr or hosts');
  for (const row of db.prepare('SELECT message,payload FROM alert_outbox').all()) assert.doesNotMatch(row.message + row.payload, /192\.0\.2|ECONNREFUSED|shop-web-1/);
});

test('an existing alert line does not gain the new events', () => {
  db.exec("DELETE FROM alert_outbox;DELETE FROM alert_lines;DELETE FROM alert_nodes;DELETE FROM connections");
  const f = fixture('lines');
  const credential = store.createCredential({ kind: 'telegram', name: 'Bot', config: { token: '123456789:' + 'AbCdEf_-12'.repeat(4).slice(0, 35) } }, 'test');
  const channel = store.createChannel({ kind: 'telegram', name: 'Phone', credentialId: credential.id, config: { chatId: '-1001234567890' } }, 'test');
  store.createRule({ channelId: channel.id, sourceKind: 'docknest', sourceId: null, events: ['backup.failed', 'backup.succeeded', 'server.unreachable'] }, 'test');
  assert.equal(heal.gaveUp(f.siteId, 'shop-web-1', 'limit'), true);
  assert.equal(heal.gaveUp(f.siteId, 'shop-web-1', 'limit'), false, 'once per window');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM alert_outbox').get().n, 0);
});

test('worker restart: an interrupted restart is failed, counts, and is not retried; old history is purged', async () => {
  const f = fixture('interrupted');
  unhealthy(f);
  const job = claimJob();
  assert.equal(job.type, 'self-heal');
  heal.recoverInterruptedHeals();
  assert.deepEqual(jobsOf(f.siteId), ['failed/failed']);
  assert.match(history(f.siteId).at(-1), /restart_failed:interrupted$/);
  assert.ok(!claimJob(), 'nothing is retried');
  db.prepare("INSERT INTO self_heal_events(id,site_id,server_id,container,kind,at) VALUES(?,?,?,?,'unhealthy',?)").run(randomUUID(), f.siteId, f.serverId, 'old', new Date(Date.now() - 91 * 86_400_000).toISOString());
  heal.healClock.now = () => Date.now();
  try { assert.ok(heal.purgeSelfHealEvents() >= 1); } finally { heal.healClock.now = () => now; }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM self_heal_events WHERE container='old'").get().n, 0);
});

test('a disabled site, a removed site and a container no longer watched never restart', async () => {
  const f = fixture('disabled');
  unhealthy(f);
  db.prepare('UPDATE self_heal_settings SET enabled=0 WHERE site_id=?').run(f.siteId);
  await work();
  assert.equal(restarts.length, 0); assert.match(history(f.siteId).at(-1), /skipped:disabled$/);
  assert.equal(unhealthy(f, 'shop-db-1'), null, 'disabled: nothing recorded');
  enable(f.siteId, { watched: [{ name: 'shop-db-1', project: 'shop', service: 'db' }] });
  assert.equal(unhealthy(f), null, 'not watched any more');
  db.prepare('INSERT INTO site_archives VALUES(?,?)').run(f.siteId, at());
  assert.equal(heal.blockReason(f.siteId), 'removed');
});

test('a restart queued by an event starts at once beside a long job of another site, never on a busy site', async () => {
  const serverId = serverRow('now-host'), a = siteRow(serverId, 'now-a'), b = siteRow(serverId, 'now-b');
  enable(a); enable(b);
  const longBackup = queueJob(b, { status: 'running' }); // the worker loop is busy with site B's backup
  heal.healRunner.active = () => true;
  try {
    unhealthy({ serverId, siteId: a });
    await heal.healRunner.running;
    assert.equal(restarts.length, 1, 'site A healed while site B backup runs');
    assert.deepEqual(jobsOf(a), ['completed/completed']);
    unhealthy({ serverId, siteId: b });
    await heal.healRunner.running;
    assert.equal(restarts.length, 1, 'site B is busy: no restart');
    assert.match(history(b).at(-1), /skipped:site_busy$/);
    // The gap: a second unhealthy inside 60 s schedules one re-check when the gap ends.
    const timers = []; heal.healClock.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.at(-1); }; heal.healClock.clearTimeout = () => {};
    now += 20_000; healthy({ serverId, siteId: a }); unhealthy({ serverId, siteId: a });
    assert.equal(timers.length, 1); assert.ok(timers[0].ms > 39_000 && timers[0].ms < 41_000, String(timers[0].ms));
    now += 41_000; timers[0].fn(); await heal.healRunner.running;
    assert.equal(restarts.length, 2, 'restarted when the gap ended');
  } finally { heal.healRunner.active = () => false; heal.cancelRechecks(); db.prepare("UPDATE jobs SET status='completed',finished_at=? WHERE id=?").run(at(), longBackup); }
});

// ---------- streams ----------
class FakeChannel extends EventEmitter {
  constructor() { super(); this.stderr = new EventEmitter(); this.written = ''; this.closed = false; }
  write(text) { this.written += text; }
  close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
  send(value) { this.emit('data', Buffer.from((typeof value === 'string' ? value : JSON.stringify(value)) + '\n')); }
}
class FakeClient extends EventEmitter {
  constructor() { super(); this.channel = new FakeChannel(); this.ended = false; }
  exec(command, options, callback) { this.command = command; callback(null, this.channel); }
  end() { if (!this.ended) { this.ended = true; this.emit('close'); } }
}
const timers = [];
const connects = [];
let connectAnswer = () => new FakeClient();
streams.streamTransport.connect = async server => { const value = connectAnswer(server); connects.push({ server, client: value }); if (value instanceof Error) throw value; return value; };
streams.streamTransport.setTimeout = (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; };
streams.streamTransport.clearTimeout = timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); };
streams.streamTransport.random = () => 0.5;
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); };
const fire = async () => { const timer = timers.shift(); timer.fn(); await tick(); return timer.ms; };
const runtime = () => JSON.parse(db.prepare("SELECT value FROM settings WHERE key='self_heal_runtime'").get()?.value ?? '{}');

test('streams: one per server, opened and reopened on the tick when the fingerprint changes, closed when off', async () => {
  streams.stopStreams(); connects.length = 0; timers.length = 0;
  db.exec('UPDATE self_heal_settings SET enabled=0');
  const serverId = serverRow('stream-host'), a = siteRow(serverId, 'stream-a'), b = siteRow(serverId, 'stream-b', ['blog']);
  enable(a); enable(b, { watched: [{ name: 'blog', project: null, service: null }] });
  streams.syncStreams(); await tick();
  assert.equal(connects.length, 1, 'two sites, one server, one stream');
  const client = connects[0].client;
  assert.match(client.command, /^python3 -c /);
  const [, request] = client.channel.written.trim().split('\n');
  const sent = JSON.parse(request), key = item => item.name;
  assert.equal(sent.operation, 'health-events');
  assert.deepEqual(sent.watch.map(key).sort(), ['blog', 'shop-db-1', 'shop-web-1']);
  assert.deepEqual(sent.watch.find(item => item.name === 'blog'), { name: 'blog', project: null, service: null });
  assert.equal(client.ended, false, 'stdin stays open');
  streams.syncStreams(); await tick();
  assert.equal(connects.length, 1, 'nothing changed: nothing reopens');
  // A host-key re-pin (or a credential change) reopens it.
  db.prepare('UPDATE servers SET host_key=? WHERE id=?').run('1'.repeat(64), serverId);
  streams.syncStreams(); await tick();
  assert.equal(client.ended, true); assert.equal(connects.length, 2);
  // A finished site job (backup, Safe Edit) reopens it, so the watched containers are re-resolved on connect.
  queueJob(a, { status: 'completed', finishedAt: at() });
  streams.syncStreams(); await tick();
  assert.equal(connects.length, 3);
  // Turning both off closes it.
  db.prepare('UPDATE self_heal_settings SET enabled=0 WHERE site_id IN (?,?)').run(a, b);
  streams.syncStreams(); await tick();
  assert.equal(connects[2].client.ended, true); assert.equal(streams.openStreams().size, 0);
});

test('streams: snapshot, validation, dedupe, throttle, reconnect backoff on close, fail closed on a pin mismatch', async () => {
  streams.stopStreams(); connects.length = 0; timers.length = 0;
  db.exec('UPDATE self_heal_settings SET enabled=0');
  const f = fixture('stream-flow');
  streams.syncStreams(); await tick();
  const first = connects[0].client;
  assert.equal(runtime().servers[f.serverId].state, 'connecting');
  first.channel.send({ watching: [{ name: 'shop-web-1', id: ID('a') }, null] });
  assert.equal(runtime().servers[f.serverId].state, 'connected');
  assert.deepEqual(runtime().sites[f.siteId].missing, ['shop-db-1']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE target=? AND action='self_heal.gave_up' AND json_extract(detail,'$.reason')='recreated'").get(f.siteId).n, 1, 'a watched service that disappeared gives up with that reason');
  const event = { container: 'shop-web-1', status: 'unhealthy', at: 1, id: ID('a'), timeNano: 1762070400123456789 };
  first.channel.send({ ...event, labels: { x: 1 } }); // unknown field: dropped
  first.channel.send({ ...event, container: 'not-watched' }); // not watched: dropped
  first.channel.send('not json');
  assert.deepEqual(history(f.siteId), []);
  first.channel.send(event);
  first.channel.send(event); // same (ID, timeNano): deduped
  assert.deepEqual(history(f.siteId), ['shop-web-1:unhealthy']);
  // Flapping: healthy then unhealthy inside 10 s are held, and only the latest acts when the window ends.
  first.channel.send({ ...event, status: 'healthy', timeNano: event.timeNano + 1e9 });
  first.channel.send({ ...event, status: 'unhealthy', timeNano: event.timeNano + 2e9 });
  assert.deepEqual(history(f.siteId), ['shop-web-1:unhealthy']);
  assert.equal(timers.length, 1);
  now += 10_000; await fire();
  assert.deepEqual(history(f.siteId), ['shop-web-1:unhealthy'], 'the latest state (unhealthy) was already open');
  // A line over 4 KB closes the stream; the close schedules a reconnect with backoff.
  first.channel.send('{"x":"' + 'y'.repeat(5000) + '"}');
  assert.equal(first.ended, true);
  assert.equal(runtime().servers[f.serverId].state, 'connecting');
  assert.deepEqual(timers.map(timer => timer.ms), [5000]);
  connectAnswer = () => new Error('connect ETIMEDOUT');
  await fire(); assert.deepEqual(timers.map(timer => timer.ms), [10000]);
  await fire(); assert.deepEqual(timers.map(timer => timer.ms), [20000]);
  assert.equal(runtime().servers[f.serverId].reason, 'unreachable');
  // Pin mismatch: off, never retried.
  connectAnswer = () => Object.assign(new Error('Handshake failed'), { hostKeyRejected: true });
  await fire();
  assert.equal(timers.length, 0); assert.deepEqual([runtime().servers[f.serverId].state, runtime().servers[f.serverId].reason], ['off', 'host_key']);
  connectAnswer = () => new FakeClient();
  streams.stopStreams();
});

// ---------- API ----------
function user(role) {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId, userId + '@example.invalid', 'fixture', 'fixture', '[]', new Date().toISOString(), role + ' user', role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), userId, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), Date.now());
  return (method, route, body, csrf = true) => fetch(base + route, { method, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, ...(csrf ? { 'x-csrf-token': 'csrf' } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then(async response => ({ status: response.status, body: await response.json() }));
}

test('API: read for everyone, change for administrators with CSRF, 422 NO_HEALTHCHECK, history pages', async () => {
  const admin = user('admin'), operator = user('operator');
  const serverId = serverRow('api-host'), siteId = siteRow(serverId, 'api-site');
  let resolveAnswer = () => ({ containers: [{ name: 'shop-web-1', project: 'shop', service: 'web', healthcheck: true, running: true, health: 'healthy' }, { name: 'shop-db-1', project: 'shop', service: 'db', healthcheck: false, running: true, health: null }] });
  const resolved = [];
  routes.healApi.resolve = async (server, names) => { resolved.push(names); return resolveAnswer(); };
  const off = await operator('GET', `/sites/${siteId}/self-heal`);
  assert.equal(off.status, 200);
  assert.deepEqual({ ...off.body, events: undefined, limits: undefined }, { siteId, available: true, enabled: false, maxRestarts: 3, windowMinutes: 60, minGapSeconds: 60, canEdit: false, updatedAt: null, updatedBy: null, lastEventAt: null, watched: [], stream: { state: 'off', reason: null, notWatching: null }, note: 'Works while DockNest is running.', events: undefined, limits: undefined });
  assert.equal((await operator('PUT', `/sites/${siteId}/self-heal`, { enabled: true })).status, 403);
  assert.equal((await admin('PUT', `/sites/${siteId}/self-heal`, { enabled: true }, false)).status, 403, 'CSRF');
  assert.equal((await admin('PUT', `/sites/${siteId}/self-heal`, { enabled: true, maxRestarts: 11 })).body.code, 'INVALID');
  assert.equal((await admin('PUT', `/sites/${siteId}/self-heal`, { enabled: true, windowMinutes: 5 })).body.code, 'INVALID');
  assert.equal((await admin('PUT', `/sites/${siteId}/self-heal`, { enabled: true, extra: 1 })).body.code, 'INVALID');
  resolveAnswer = () => ({ containers: [{ name: 'shop-web-1', project: 'shop', service: 'web', healthcheck: false }] });
  const none = await admin('PUT', `/sites/${siteId}/self-heal`, { enabled: true });
  assert.deepEqual([none.status, none.body.code, none.body.error], [422, 'NO_HEALTHCHECK', 'No container in this site has a health check.']);
  resolveAnswer = () => { throw new Error('ssh: connect to host 192.0.2.10 port 22: refused'); };
  const down = await admin('PUT', `/sites/${siteId}/self-heal`, { enabled: true });
  assert.equal(down.status, 502); assert.doesNotMatch(JSON.stringify(down.body), /192\.0\.2/);
  resolveAnswer = () => ({ containers: [{ name: 'shop-web-1', project: 'shop', service: 'web', healthcheck: true }, { name: 'shop-db-1', project: 'shop', service: 'db', healthcheck: false }, { name: 'injected', project: 'x', service: 'y', healthcheck: true }] });
  const on = await admin('PUT', `/sites/${siteId}/self-heal`, { enabled: true, maxRestarts: 5, windowMinutes: 120 });
  assert.equal(on.status, 200);
  assert.deepEqual(resolved.at(-1), ['shop-web-1', 'shop-db-1']);
  assert.deepEqual([on.body.enabled, on.body.maxRestarts, on.body.windowMinutes, on.body.canEdit, on.body.updatedBy], [true, 5, 120, true, 'admin user']);
  assert.deepEqual(on.body.watched, [{ name: 'shop-web-1', project: 'shop', service: 'web', health: null, found: true }], 'only containers of the site that have a health check');
  assert.deepEqual(on.body.stream, { state: 'off', reason: 'worker_offline', notWatching: 'Not watching: the DockNest worker is not running' });
  db.prepare("INSERT INTO settings VALUES('worker_heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ running: true, lastSeen: new Date().toISOString() }));
  db.prepare("INSERT INTO settings VALUES('self_heal_runtime',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ servers: { [serverId]: { state: 'connecting', reason: 'docker_events' } }, sites: {} }));
  assert.deepEqual((await operator('GET', `/sites/${siteId}/self-heal`)).body.stream, { state: 'connecting', reason: 'docker_events', notWatching: 'Not watching: Docker events could not be read on the server' });
  db.prepare("UPDATE settings SET value=? WHERE key='self_heal_runtime'").run(JSON.stringify({ servers: { [serverId]: { state: 'connected', reason: null } }, sites: { [siteId]: { missing: [], health: { 'shop-web-1': 'healthy' } } } }));
  const live = (await operator('GET', `/sites/${siteId}/self-heal`)).body;
  assert.deepEqual([live.stream.state, live.watched[0].health], ['connected', 'healthy']);
  // Changing limits keeps the watched list (no server call); turning off needs no server.
  const calls = resolved.length;
  assert.equal((await admin('PUT', `/sites/${siteId}/self-heal`, { enabled: true, maxRestarts: 2, windowMinutes: 60 })).status, 200);
  assert.equal((await admin('PUT', `/sites/${siteId}/self-heal`, { enabled: false })).status, 200);
  assert.equal(resolved.length, calls);
  const audit = db.prepare("SELECT action,actor FROM audit_events WHERE target=? AND action LIKE 'self_heal.%' ORDER BY created_at,rowid").all(siteId).map(row => row.action);
  assert.deepEqual(audit, ['self_heal.enabled', 'self_heal.changed', 'self_heal.disabled']);
  // History: newest first, keyset pages, plain sentences.
  for (let index = 0; index < 5; index++) db.prepare("INSERT INTO self_heal_events(id,site_id,server_id,container,kind,reason,at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), siteId, serverId, 'shop-web-1', index % 2 ? 'skipped' : 'unhealthy', index % 2 ? 'maintenance' : null, at(now + index * 1000));
  const page1 = await operator('GET', `/self-heal/events?siteId=${siteId}&limit=2`);
  assert.equal(page1.body.items.length, 2); assert.ok(page1.body.nextCursor);
  assert.deepEqual(Object.keys(page1.body.items[0]).sort(), ['at', 'container', 'id', 'jobId', 'kind', 'reason', 'reasonCode', 'siteId', 'siteName']);
  assert.equal(page1.body.items.find(item => item.kind === 'skipped').reason, 'The site was in maintenance.');
  const page2 = await operator('GET', `/self-heal/events?siteId=${siteId}&limit=2&after=${page1.body.nextCursor}`);
  const page3 = await operator('GET', `/self-heal/events?siteId=${siteId}&limit=2&after=${page2.body.nextCursor}`);
  assert.deepEqual([page2.body.items.length, page3.body.items.length, page3.body.nextCursor], [2, 1, null]);
  assert.equal(new Set([...page1.body.items, ...page2.body.items, ...page3.body.items].map(item => item.id)).size, 5);
  assert.equal((await operator('GET', '/self-heal/events?after=bad')).status, 400);
  assert.equal((await operator('GET', `/sites/${siteId}/self-heal?limit=3`)).body.events.items.length, 3);
  assert.equal((await operator('GET', '/sites/00000000-0000-4000-8000-000000000000/self-heal')).status, 404);
  // Self-heal jobs stay out of the site job lists.
  queueJob(siteId, { type: 'self-heal', status: 'completed' });
  const state = await operator('GET', '/jobs?limit=200');
  assert.equal(state.body.items.some(item => item.type === 'self-heal'), false);
});
