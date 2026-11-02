// Server cleanup API (docs/server-cleanup.md): admin only with CSRF, what DockNest sends as protected, the busy rules,
// one-use previews that cannot be widened, the audit record and the result summary. The helper is faked; its own
// protection rules are in remote/test_cleanup.py and real Docker runs in scripts/integration-cleanup.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-cleanup-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const { transport } = await import('../src/engine.js');
const { protectionFor, manifestVolumes, manifestProjects, setCleanupTestMinAge } = await import('../src/server-cleanup.js');
const { claimJob, enqueueBackup } = await import('../src/engine.js');
const { cleanupHeld, takeCleanupHold, releaseCleanupHold, HOLD_MS } = await import('../src/cleanup-hold.js');
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
const at = (offset = 0) => new Date(Date.now() - 86400000 + offset).toISOString();

function user(role, csrf = 'csrf') {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId, userId + '@example.invalid', 'fixture', 'fixture', '[]', at(), role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), userId, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), Date.now());
  const call = (route, body) => fetch(base + route, { method: 'POST', body: JSON.stringify(body ?? {}), headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, ...(csrf ? { 'x-csrf-token': csrf } : {}), 'Content-Type': 'application/json' } });
  call.id = userId;
  return call;
}
const admin = user('admin'), otherAdmin = user('admin'), operator = user('operator'), noCsrf = user('admin', null);
function serverRow(name) {
  const serverId = randomUUID();
  db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(serverId, name, '203.0.113.' + Math.floor(Math.random() * 200 + 1), 22, 'root', 'fixture', '0'.repeat(64), at());
  return serverId;
}
function siteRow(serverId, name, config) {
  const siteId = randomUUID();
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, serverId, name, JSON.stringify({ kind: 'docker', composeFiles: [], ...config }), at());
  return siteId;
}
function backupRow(siteId, manifest, offset = 0) {
  const jobId = randomUUID();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','completed','completed',?)").run(jobId, siteId, at(offset));
  db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), siteId, jobId, at(offset), '/data/x.enc', 1, 'a'.repeat(64), JSON.stringify(manifest), 0, 1, at(offset));
  return jobId;
}

const calls = [];
let scanReply = null, applyReply = null, fault = null;
transport.remote = async (server, request) => {
  calls.push({ server: server.id, request: structuredClone(request) });
  if (fault) throw fault;
  if (request.operation === 'cleanup-scan') return structuredClone(scanReply);
  if (request.operation === 'cleanup-apply') return applyReply ? applyReply(request) : { results: request.items.map(item => ({ ...item, status: 'removed' })) };
  throw new Error('unexpected operation ' + request.operation);
};
const preview = () => ({
  items: [
    { kind: 'containers', id: 'c'.repeat(64), name: 'old-job', bytes: 100, fingerprint: 'f1' },
    { kind: 'images', id: 'sha256:' + 'd'.repeat(64), name: 'dddddddddddd', bytes: 2000, fingerprint: 'f2' },
    { kind: 'volumes', id: 'e'.repeat(64), name: 'eeeeeeeeeeee', bytes: 300, fingerprint: 'f3' },
    { kind: 'buildCache', id: 'build-cache', name: 'Unused build cache', bytes: 5000, fingerprint: 'build-cache' },
  ],
  protected: [{ kind: 'volumes', id: 'shop_data', name: 'shop_data', bytes: null, fingerprint: 'x', reason: 'site' }, { kind: 'containers', id: 'z', name: 'z', reason: 'made-up' }],
  busy: null,
});
const json = async response => ({ status: response.status, body: await response.json() });
const audits = serverId => db.prepare("SELECT * FROM audit_events WHERE action='server.cleanup' AND target=? ORDER BY created_at,rowid").all(serverId).map(row => ({ ...row, detail: JSON.parse(row.detail) }));

test('protection lists: every site container, the volumes recent backups list, archived and moved-away sites, staging roots', () => {
  const server = serverRow('prod'), other = serverRow('other');
  const shop = siteRow(server, 'shop', { containers: ['shop-web', 'shop-db'], stagingRoot: '/srv/docknest-staging' });
  backupRow(shop, { containers: [{ Config: { Labels: { 'com.docker.compose.project': 'shop' } }, Mounts: [{ Type: 'volume', Name: 'shop_data' }, { Type: 'bind', Source: '/srv/shop' }] }] });
  const archived = siteRow(server, 'old blog', { containers: ['blog'] });
  db.prepare('INSERT INTO site_archives VALUES(?,?)').run(archived, at());
  // Moved to `other`: the site row points there now, its stopped old copy stays here until the move ends.
  const moved = siteRow(other, 'moved', { containers: ['moved-app'] });
  backupRow(moved, { containers: [{ Mounts: [{ Type: 'volume', Name: 'moved_data' }] }] });
  db.prepare("INSERT INTO site_moves(id,site_id,source_server_id,target_server_id,state,options,preflight,preflight_hash,actor,created_at,updated_at,retain_until) VALUES(?,?,?,?,'completed','{}','{}','h','qa',?,?,?)").run(randomUUID(), moved, server, other, at(), at(), new Date(Date.now() + 6 * 86400000).toISOString());
  const protect = protectionFor(server);
  assert.deepEqual(new Set(protect.containers), new Set(['shop-web', 'shop-db', 'blog', 'moved-app']));
  assert.deepEqual(new Set(protect.volumes), new Set(['shop_data', 'moved_data']));
  assert.deepEqual(protect.stagingRoots, ['/srv/docknest-staging']);
  assert.deepEqual(protect.projects, ['shop'], 'Compose projects from the backups: their anonymous volumes stay even when every container is gone');
  assert.deepEqual(manifestProjects({ containers: [{ Config: { Labels: {} } }, {}] }), []);
  assert.deepEqual(manifestVolumes(null), []);
  assert.deepEqual(new Set(protectionFor(other).containers), new Set(['moved-app']));
});

test('scan and clean need an administrator and the CSRF token', async () => {
  const server = serverRow('auth'); scanReply = preview();
  assert.equal((await operator(`/servers/${server}/cleanup/scan`)).status, 403);
  assert.equal((await noCsrf(`/servers/${server}/cleanup/scan`)).status, 403);
  assert.equal((await operator(`/servers/${server}/cleanup`, { token: 'x', items: [{ kind: 'images', id: 'x' }] })).status, 403);
  assert.equal((await admin(`/servers/${randomUUID()}/cleanup/scan`)).status, 404);
  assert.equal(calls.filter(call => call.server === server).length, 0);
});

test('scan sends protection, returns a preview with sizes and plain reasons, and clean removes only chosen preview items', async () => {
  const server = serverRow('main'); siteRow(server, 'shop', { containers: ['shop-web'] }); scanReply = preview();
  const scan = await json(await admin(`/servers/${server}/cleanup/scan`));
  assert.equal(scan.status, 200);
  assert.deepEqual(calls.at(-1).request.protect.containers, ['shop-web']);
  assert.equal(scan.body.items.length, 4); assert.equal(scan.body.totalBytes, 7400); assert.equal(scan.body.busy, null);
  assert.ok(scan.body.items.every(item => !('fingerprint' in item)), 'fingerprints stay on the server side');
  assert.deepEqual(scan.body.protected.map(item => item.reason), ['site', 'unknown'], 'a reason this release does not know reads as unknown, and the item stays kept');

  // Not in the preview: refused before anything runs.
  const before = calls.length;
  const widened = await json(await admin(`/servers/${server}/cleanup`, { token: scan.body.token, items: [{ kind: 'volumes', id: 'shop_data' }] }));
  assert.equal(widened.status, 400); assert.equal(widened.body.code, 'NOT_IN_PREVIEW'); assert.equal(calls.length, before);
  // Another admin cannot use this admin's preview.
  assert.equal((await json(await otherAdmin(`/servers/${server}/cleanup`, { token: scan.body.token, items: [{ kind: 'images', id: scan.body.items[1].id }] }))).body.code, 'PREVIEW_EXPIRED');

  const chosen = scan.body.items.filter(item => item.kind !== 'containers').map(({ kind, id }) => ({ kind, id }));
  applyReply = request => ({ results: request.items.map(item => item.kind === 'volumes' ? { ...item, status: 'skipped', reason: 'inUse' } : { ...item, status: 'removed', ...(item.kind === 'buildCache' ? { bytes: 4200 } : {}) }) });
  const clean = await json(await admin(`/servers/${server}/cleanup`, { token: scan.body.token, items: chosen }));
  assert.equal(clean.status, 200);
  const sent = calls.at(-1).request;
  assert.equal(sent.operation, 'cleanup-apply');
  assert.deepEqual(sent.items, [{ kind: 'images', id: 'sha256:' + 'd'.repeat(64), fingerprint: 'f2' }, { kind: 'volumes', id: 'e'.repeat(64), fingerprint: 'f3' }, { kind: 'buildCache', id: 'build-cache', fingerprint: 'build-cache' }], 'the preview fingerprints go with each item');
  assert.deepEqual(sent.protect.containers, ['shop-web'], 'protection is read again at clean time');
  assert.deepEqual({ result: clean.body.result, removed: clean.body.removed, skipped: clean.body.skipped, failed: clean.body.failed, bytes: clean.body.bytes }, { result: 'partial', removed: 2, skipped: 1, failed: 0, bytes: 2000 + 4200 });
  const [entry] = audits(server);
  assert.equal(entry.actor, admin.id);
  assert.deepEqual({ ...entry.detail, items: entry.detail.items.length }, { result: 'partial', requested: 3, removed: 2, skipped: 1, failed: 0, bytes: 6200, items: 2 });
  // A preview is used once.
  assert.equal((await json(await admin(`/servers/${server}/cleanup`, { token: scan.body.token, items: chosen }))).body.code, 'PREVIEW_EXPIRED');
  applyReply = null;
});

test('clean refuses while a backup, restore, restore test or running move uses the server, but not for a completed move', async () => {
  const server = serverRow('busy'), other = serverRow('busy-other'), site = siteRow(server, 'shop', { containers: ['shop-web'] });
  const attempt = async () => { scanReply = preview(); const scan = await json(await admin(`/servers/${server}/cleanup/scan`)); return { scan: scan.body, clean: await json(await admin(`/servers/${server}/cleanup`, { token: scan.body.token, items: [{ kind: 'images', id: scan.body.items[1].id }] })) }; };
  const job = randomUUID();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','running','copying',?)").run(job, site, at());
  let { scan, clean } = await attempt();
  assert.equal(scan.busy, 'A backup is running on this server.');
  assert.equal(clean.status, 409); assert.equal(clean.body.code, 'SERVER_BUSY');
  db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(job);
  // A restore onto this server from a site that lives elsewhere.
  const elsewhere = siteRow(other, 'elsewhere', { containers: ['x'] }), restore = randomUUID();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,'restore','queued','queued',?,?)").run(restore, elsewhere, at(), JSON.stringify({ targetServerId: server }));
  ({ clean } = await attempt()); assert.equal(clean.body.error, 'A restore is running on this server. Clean up after it finishes.');
  db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(restore);
  // A restore test that started on this server holds it until its clean-up is done.
  const testRow = randomUUID();
  db.prepare("INSERT INTO restore_tests(id,site_id,backup_captured_at,server_id,trigger,limits,created_by,created_at,started_at) VALUES(?,?,?,?,'manual','{}','qa',?,?)").run(testRow, elsewhere, at(), server, at(), at());
  ({ clean } = await attempt()); assert.equal(clean.body.error, 'A restore test is running on this server. Clean up after it finishes.');
  db.prepare("UPDATE restore_tests SET result='passed',cleanup='done' WHERE id=?").run(testRow);
  const move = randomUUID();
  db.prepare("INSERT INTO site_moves(id,site_id,source_server_id,target_server_id,state,options,preflight,preflight_hash,actor,created_at,updated_at) VALUES(?,?,?,?,'running','{}','{}','h','qa',?,?)").run(move, site, server, other, at(), at());
  ({ clean } = await attempt()); assert.equal(clean.body.code, 'SERVER_BUSY');
  db.prepare("UPDATE site_moves SET state='completed' WHERE id=?").run(move);
  ({ clean } = await attempt()); assert.equal(clean.status, 200, 'a completed move keeps only its old copy, which is protected');
  const refused = audits(server).filter(row => row.detail.result === 'refused');
  assert.equal(refused.length, 4, 'every refused clean is audited');
});

test('helper refusals and unreachable servers are reported plainly and audited', async () => {
  const server = serverRow('faulty'); scanReply = preview();
  const scan = await json(await admin(`/servers/${server}/cleanup/scan`));
  fault = Object.assign(new Error('A backup is running on this server. Clean up after it finishes.'), { remoteReported: true });
  const refused = await json(await admin(`/servers/${server}/cleanup`, { token: scan.body.token, items: [{ kind: 'images', id: scan.body.items[1].id }] }));
  assert.equal(refused.status, 409); assert.equal(refused.body.code, 'CLEANUP_REFUSED');
  fault = new Error('connect ECONNREFUSED 203.0.113.9:22');
  const offline = await json(await admin(`/servers/${server}/cleanup/scan`));
  assert.equal(offline.status, 502); assert.doesNotMatch(offline.body.error, /203\.0\.113|ECONNREFUSED/, 'no address or socket error in the message');
  fault = null;
  assert.deepEqual(audits(server).map(row => row.detail.result), ['refused']);
});

test('protection that cannot be sent whole blocks the scan', async () => {
  const server = serverRow('odd'); siteRow(server, 'odd', { containers: ['bad name with spaces'] });
  const scan = await json(await admin(`/servers/${server}/cleanup/scan`));
  assert.equal(scan.status, 409); assert.equal(scan.body.code, 'PROTECTION_UNAVAILABLE');
});

test('a scheduled backup cannot be claimed while a clean runs, and runs right after it', async () => {
  const server = serverRow('held'), site = siteRow(server, 'held site', { containers: ['held-web'] }); scanReply = preview();
  const scan = await json(await admin(`/servers/${server}/cleanup/scan`));
  let claimedDuring = 'not tried', queued = null;
  applyReply = request => {
    // The worker's scheduler queues a backup mid-clean; the claim must defer it, not fail it.
    assert.equal(cleanupHeld(server), true, 'the hold is in the database, visible to the worker process');
    queued = enqueueBackup(site, 'scheduler');
    claimedDuring = claimJob();
    return { results: request.items.map(item => ({ ...item, status: 'removed' })) };
  };
  const clean = await json(await admin(`/servers/${server}/cleanup`, { token: scan.body.token, items: [{ kind: 'images', id: scan.body.items[1].id }] }));
  applyReply = null;
  assert.equal(clean.status, 200);
  assert.equal(claimedDuring ?? null, null, 'nothing was claimed on the held server');
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(queued.id).status, 'queued', 'the backup waited, it did not fail');
  assert.equal(cleanupHeld(server), false, 'released when the clean ended');
  assert.equal(claimJob()?.id, queued.id, 'and it starts right after');
  db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(queued.id);
});

test('the hold is released when the clean fails, and a hold left by a crash goes stale', async () => {
  const server = serverRow('crash'); scanReply = preview();
  const scan = await json(await admin(`/servers/${server}/cleanup/scan`));
  fault = new Error('connection reset');
  assert.equal((await admin(`/servers/${server}/cleanup`, { token: scan.body.token, items: [{ kind: 'images', id: scan.body.items[1].id }] })).status, 502);
  fault = null;
  assert.equal(cleanupHeld(server), false);
  assert.equal(takeCleanupHold(server, 'qa', () => null), null);
  assert.equal(takeCleanupHold(server, 'qa', () => (cleanupHeld(server) ? 'held' : null)), 'held', 'a second clean is refused while the first holds');
  db.prepare("UPDATE settings SET value=? WHERE key=?").run(JSON.stringify({ actor: 'qa', expiresAt: Date.now() - 5000 }), 'cleanup_hold:' + server);
  assert.equal(cleanupHeld(server), false, `a hold older than ${HOLD_MS / 60000} minutes no longer blocks the server`);
  releaseCleanupHold(server);
});

test('the integration-only minimum age is a checked number, sent only when set', async () => {
  const server = serverRow('age'); scanReply = preview();
  assert.throws(() => setCleanupTestMinAge(-1)); assert.throws(() => setCleanupTestMinAge('0'));
  await admin(`/servers/${server}/cleanup/scan`);
  assert.equal('minAgeSeconds' in calls.at(-1).request, false);
  setCleanupTestMinAge(0); await admin(`/servers/${server}/cleanup/scan`); setCleanupTestMinAge(null);
  assert.equal(calls.at(-1).request.minAgeSeconds, 0);
});

test.after(() => new Promise(resolve => listener.close(resolve)));
