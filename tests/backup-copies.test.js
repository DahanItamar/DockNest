// Storage per site and backup copies (docs/backup-copies.md): destination resolution, the copy step and its journal,
// the retry schedule, per-copy retention, pins and Object Lock, restore fallback, the API and the alerts. The main copy
// is on local disk or a synthetic S3 bucket; copies go to synthetic S3 buckets (tests/s3-fixture.js) and to an SFTP
// address nothing answers on. Real SFTP and S3 copies and restores are validated only by the Linux integration suite.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { startS3Fixture } from './s3-fixture.js';

const root = await mkdtemp(join(tmpdir(), 'docknest-copies-'));
Object.assign(process.env, { DATA_DIR: root, BACKUP_DIR: join(root, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(root, 'master.key'), SETUP_TOKEN_FILE: join(root, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { seal, digest } = await import('../src/crypto.js');
const engine = await import('../src/engine.js');
const journal = await import('../src/artifact-journal.js');
const copies = await import('../src/backup-copies.js');
const siteStorage = await import('../src/site-storage.js');
const storage = await import('../src/storage.js');
const { backupFilename } = await import('../src/backup-layout.js');
const store = await import('../src/alerts/store.js'), detect = await import('../src/alerts/detect.js'), events = await import('../src/alerts/events.js');
const report = await import('../src/storage-report.js');
const r2 = await startS3Fixture({ bucket: 'docknest-r2' }), locked = await startS3Fixture({ bucket: 'docknest-locked', objectLock: true });
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
after(async () => { listener.close(); await r2.close(); await locked.close(); db.close(); await rm(root, { recursive: true, force: true }); });

const stamp = () => new Date().toISOString();
function s3Target(fixture, { name = 'R2 bucket', prefix = 'docknest', objectLock = null } = {}) {
  const targetId = randomUUID(), url = new URL(fixture.options.endpoint);
  db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(targetId, name, url.hostname, Number(url.port), fixture.options.bucket, '', 's3-access-key', seal(JSON.stringify(fixture.credentials)), '/' + prefix, 0, 'connected', stamp(), stamp());
  db.prepare("INSERT INTO storage_target_settings VALUES(?,'s3',?)").run(targetId, JSON.stringify({ endpoint: fixture.options.endpoint, region: fixture.options.region, bucket: fixture.options.bucket, pathStyle: true, objectLock }));
  return targetId;
}
// An SFTP destination on a port nothing listens on: every connection is refused at once.
function deadSftpTarget(name = 'Offsite SFTP') {
  const targetId = randomUUID();
  db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(targetId, name, '127.0.0.1', 1, 'docknest', 'a'.repeat(64), 'password', seal('fixture-password'), '/home/docknest', 1e12, 'connected', stamp(), stamp());
  return targetId;
}
function site(name, { retention = 7 } = {}) {
  const serverId = randomUUID(), siteId = randomUUID();
  db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(serverId, 'Server ' + name, '192.0.2.10', 22, 'root', 'fixture', '0'.repeat(64), stamp());
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, serverId, name, '{}', stamp());
  db.prepare("INSERT INTO policies VALUES(?,0,'0 2 * * *','UTC',?,NULL)").run(siteId, retention);
  return { siteId, serverId };
}
const setCopies = (siteId, list, mainTargetId = null) => siteStorage.updateSiteStorage(siteId, { mainTargetId, copies: list }, 'test');
// Publishes a backup exactly like the engine: to the site's main destination, through the publication journal.
async function publish(siteId, capturedAt = stamp(), body = randomBytes(3000)) {
  const backupId = randomUUID(), jobId = randomUUID(), siteRow = db.prepare('SELECT * FROM sites WHERE id=?').get(siteId), server = db.prepare('SELECT id,name FROM servers WHERE id=?').get(siteRow.server_id);
  const directory = storage.backupDirectory(server, { id: siteId, name: siteRow.name }, siteStorage.siteMainStorage(siteId));
  await storage.makeDirectory(directory);
  const published = storage.storageJoin(directory, backupFilename(backupId, new Date(capturedAt))), temporary = published + '.partial';
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','running','verifying',?)").run(jobId, siteId, capturedAt);
  await engine.encryptStream(Readable.from([body]), await storage.openWrite(temporary)); await storage.syncFile(temporary);
  journal.preparePublication({ backupId, jobId, siteId, temporary, published, manifest: { consistency: { status: 'declared' } }, capturedAt });
  journal.authenticatePublication(backupId, await engine.verifyEncrypted(temporary), (await storage.statFile(temporary)).size);
  await storage.renameFile(temporary, published);
  journal.finalizePublication(backupId);
  return backupId;
}
async function runCopies(at = Date.now()) { const results = []; for (let copy; (copy = journal.claimCopy(at));) results.push(await copies.executeCopy(copy, engine.verifyEncrypted)); return results; }
const copyRow = (backupId, targetId) => db.prepare('SELECT * FROM backup_copies WHERE backup_id=? AND target_id=?').get(backupId, targetId);
const readAll = async stream => { const parts = []; for await (const chunk of stream) parts.push(chunk); return Buffer.concat(parts); };
const day = n => new Date(Date.parse('2026-10-01T02:00:00Z') + n * 86400000).toISOString();
function session(role = 'admin', { recent = true } = {}) {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId, userId + '@example.invalid', 'fixture', 'fixture', '[]', stamp(), role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), userId, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), recent ? Date.now() : Date.now() - 3600000);
  return async (method, route, body) => { const response = await fetch(base + route, { method, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, 'x-csrf-token': 'csrf', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json().catch(() => null) }; };
}

test('destination resolution: default, a site override, and a removed destination fails closed', async () => {
  const { siteId } = site('resolve.example');
  assert.equal(siteStorage.siteMainStorage(siteId).id, 'env', 'no row: the default destination, exactly as before');
  assert.equal(siteStorage.siteMainStorage(siteId).mode, 'local');
  const bucket = s3Target(r2, { name: 'Main bucket', prefix: 'override' });
  setCopies(siteId, [], bucket);
  assert.equal(siteStorage.siteMainStorage(siteId).id, bucket);
  const backupId = await publish(siteId);
  assert.match(db.prepare('SELECT path FROM backups WHERE id=?').get(backupId).path, new RegExp(`^s3:${bucket}:/override/BACKUP/`), 'the override writes to its own destination');
  setCopies(siteId, [], null);
  assert.equal(siteStorage.siteMainStorage(siteId).id, 'env', 'back to the default');
  db.prepare('UPDATE site_storage SET main_target_id=? WHERE site_id=?').run('gone-destination', siteId);
  assert.throws(() => siteStorage.siteMainStorage(siteId), error => error.code === 'destination_missing' && error.status === 409, 'never falls back to a destination the owner did not choose');
  assert.equal(siteStorage.siteStorageView(siteId).main.effective.name, 'Removed destination');
  db.prepare('DELETE FROM site_storage WHERE site_id=?').run(siteId);
});

test('retry schedule: 5 min, 30 min, 2 h, then every 6 h, and gave_up after 7 days', () => {
  const first = Date.parse('2026-10-01T00:00:00Z'), min = 60_000, hour = 60 * min;
  assert.deepEqual(journal.copyRetryPlan(1, first, first), { status: 'failed', nextAttemptAt: first + 5 * min });
  assert.equal(journal.copyRetryPlan(2, first, first + 5 * min).nextAttemptAt, first + 35 * min);
  assert.equal(journal.copyRetryPlan(3, first, first + 35 * min).nextAttemptAt, first + 35 * min + 2 * hour);
  assert.equal(journal.copyRetryPlan(4, first, first + 3 * hour).nextAttemptAt, first + 9 * hour);
  assert.equal(journal.copyRetryPlan(30, first, first + 165 * hour).nextAttemptAt, first + 7 * 24 * hour, 'the last try is when the 7 days end');
  assert.deepEqual(journal.copyRetryPlan(31, first, first + 7 * 24 * hour), { status: 'gave_up', nextAttemptAt: null });
});

test('a copy is the same encrypted package, byte for byte, published through the journal; the backup never waits for it', async () => {
  const { siteId } = site('copy.example');
  const bucket = s3Target(r2, { name: 'Cloudflare R2' });
  setCopies(siteId, [{ targetId: bucket, retention: null }]);
  const backupId = await publish(siteId);
  const backup = db.prepare('SELECT * FROM backups WHERE id=?').get(backupId);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(backup.job_id).status, 'completed', 'the backup is complete before any copy');
  assert.equal(copyRow(backupId, bucket).status, 'pending');
  const [result] = await runCopies();
  assert.equal(result.status, 'verified');
  const row = copyRow(backupId, bucket);
  assert.equal(row.status, 'verified'); assert.ok(row.verified_at); assert.equal(row.last_error, null);
  assert.match(row.path, new RegExp(`^s3:${bucket}:/docknest/BACKUP/server-copy-example--[0-9a-f-]+/copy-example--${siteId}/backup_.*--${backupId}\\.tar\\.gz\\.enc$`));
  assert.deepEqual(await readAll(await storage.openRead(row.path)), await readFile(backup.path), 'byte for byte: no re-encryption');
  assert.equal(await engine.verifyEncrypted(row.path), backup.checksum, 'same SHA-256, same master key');
  assert.ok(![...r2.objects.keys()].some(key => key.endsWith('.partial')), 'no .partial left behind');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='backup.copy_verified' AND target=?").get(backupId).n, 1);
  // A second copy step of the same row is never claimed again, and a retry of a verified copy is refused.
  assert.equal(journal.claimCopy(), null);
  assert.deepEqual(journal.retryCopy(backupId, bucket), { found: true, refused: 'verified' });
});

test('a different file at the copy path is never overwritten; a matching one is adopted', async () => {
  const { siteId } = site('conflict.example');
  const bucket = s3Target(r2, { name: 'Conflict bucket', prefix: 'conflict' });
  setCopies(siteId, [{ targetId: bucket, retention: null }]);
  const first = await publish(siteId), second = await publish(siteId);
  const copyA = copyRow(first, bucket), copyB = copyRow(second, bucket);
  await pipeline(Readable.from([randomBytes(5000)]), await storage.openWrite(copyA.path));
  await pipeline(await storage.openRead(db.prepare('SELECT path FROM backups WHERE id=?').get(second).path), await storage.openWrite(copyB.path));
  const before = await readAll(await storage.openRead(copyA.path));
  await runCopies();
  assert.equal(copyRow(first, bucket).status, 'failed'); assert.match(copyRow(first, bucket).last_error, /never overwrites/);
  assert.deepEqual(await readAll(await storage.openRead(copyA.path)), before, 'the other file is untouched');
  assert.equal(copyRow(second, bucket).status, 'verified', 'the exact package already there is adopted after authentication');
  assert.equal(db.prepare("SELECT json_extract(detail,'$.adopted') AS adopted FROM audit_events WHERE action='backup.copy_verified' AND target=?").get(second).adopted, 1);
});

test('destination unreachable for days: retries on schedule, one alert, then gave_up; the backup stays complete; names only', async () => {
  const { siteId } = site('unreachable.example');
  const dead = deadSftpTarget('Hetzner box');
  setCopies(siteId, [{ targetId: dead, retention: null }]);
  const backupId = await publish(siteId), start = Date.now();
  const first = (await runCopies(start))[0];
  assert.equal(first.status, 'failed');
  let row = copyRow(backupId, dead);
  assert.equal(row.attempts, 1); assert.ok(row.next_attempt_at - start >= 5 * 60_000 - 2000 && row.next_attempt_at - start <= 5 * 60_000 + 60_000);
  assert.equal(row.last_error, journal.COPY_ERRORS.unreachable);
  assert.doesNotMatch(row.last_error, /127\.0\.0\.1|password|ECONNREFUSED/);
  assert.ok(row.next_attempt_at > start + 60_000, 'not before its time');
  // Days of failures, driven through the journal with a moving clock (each round is one claimed copy step).
  let at = row.next_attempt_at, rounds = 0;
  const claim = () => db.prepare("UPDATE backup_copies SET status='copying' WHERE backup_id=? AND target_id=? AND status='failed' AND next_attempt_at<=?").run(backupId, dead, at).changes;
  for (; claim(); rounds++) { const plan = journal.failCopy({ backup_id: backupId, target_id: dead }, 'unreachable', at); if (plan.status === 'gave_up') break; at = plan.nextAttemptAt; }
  row = copyRow(backupId, dead);
  assert.equal(row.status, 'gave_up'); assert.equal(row.next_attempt_at, null);
  assert.ok(rounds > 25 && rounds < 35, `about 28 retries in 7 days (${rounds})`);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='backup.copy_failed' AND target=?").get(backupId).n, 1, 'one alert for the copy, not one per retry');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='backup.copy_gave_up' AND target=?").get(backupId).n, 1);
  assert.equal(db.prepare('SELECT verified FROM backups WHERE id=?').get(backupId).verified, 1, 'a failed copy never fails the backup');
  assert.equal(siteStorage.copyMissing(siteId), true, 'the site shows Copy missing');
  // The next backup tries again; the owner can also retry this one with a fresh window.
  const next = await publish(siteId);
  assert.equal(copyRow(next, dead).status, 'pending');
  assert.equal(journal.retryCopy(backupId, dead).found, true);
  assert.equal(copyRow(backupId, dead).status, 'pending');
});

test('alerts: backup.copy_failed once and backup.copy_recovered, with the destination name only', async () => {
  db.exec("DELETE FROM alert_outbox;DELETE FROM alert_lines;DELETE FROM alert_nodes;DELETE FROM connections;DELETE FROM settings WHERE key='alerts_cursor'");
  const { siteId } = site('alerts.example');
  const credential = store.createCredential({ kind: 'telegram', name: 'Bot', config: { token: '123456789:' + 'AbCdEf_-12'.repeat(4).slice(0, 35) } }, 'test');
  const channel = store.createChannel({ kind: 'telegram', name: 'Phone', credentialId: credential.id, config: { chatId: '-1001234567890' } }, 'test');
  store.createRule({ channelId: channel.id, sourceKind: 'site', sourceId: siteId, events: ['backup.copy_failed', 'backup.copy_recovered', 'backup.copy_gave_up'] }, 'test');
  db.prepare("INSERT INTO settings VALUES('alerts_cursor',?)").run(JSON.stringify({ jobs: stamp(), moves: stamp(), tests: stamp(), testCleanups: stamp() }));
  assert.equal(detect.detectJobsAndMoves(), 0, 'a cursor from 2.10 starts the copy cursor now');
  const bucket = s3Target(r2, { name: 'Backblaze B2', prefix: 'alerts' });
  setCopies(siteId, [{ targetId: bucket, retention: null }]);
  const backupId = await publish(siteId);
  r2.faults.status = { status: 503, code: 'SlowDown' };
  try { await runCopies(); } finally { r2.faults.status = null; }
  assert.equal(copyRow(backupId, bucket).status, 'failed');
  db.prepare('UPDATE backup_copies SET next_attempt_at=0 WHERE backup_id=?').run(backupId);
  await runCopies();
  assert.equal(copyRow(backupId, bucket).status, 'verified');
  assert.equal(detect.detectJobsAndMoves(), 2); assert.equal(detect.detectJobsAndMoves(), 0, 'seen once');
  const rows = db.prepare("SELECT event,message,payload FROM alert_outbox WHERE event LIKE 'backup.copy%' ORDER BY event").all();
  assert.deepEqual(rows.map(row => row.event), ['backup.copy_failed', 'backup.copy_recovered']);
  assert.match(rows[0].message, /^Backup copy failed: alerts\.example to Backblaze B2 at \d\d:\d\d UTC\. DockNest retries automatically\.$/);
  assert.equal(JSON.parse(rows[1].payload).reason, 'The copy to Backblaze B2 is saved now.');
  assert.doesNotMatch(JSON.stringify(rows), /127\.0\.0\.1|AKIA|docknest-r2|BACKUP\//, 'no host, key, bucket or path');
  assert.ok(events.EVENTS.includes('backup.copy_failed') && events.EVENTS.includes('backup.copy_recovered') && events.EVENTS.includes('backup.copy_gave_up'));
  // 7 days of failures end in backup.copy_gave_up, once.
  db.prepare("UPDATE backup_copies SET status='copying',attempts=30,first_failed_at=? WHERE backup_id=?").run(Date.now() - 8 * 86400000, backupId);
  assert.equal(journal.failCopy({ backup_id: backupId, target_id: bucket }, 'unreachable').status, 'gave_up');
  assert.equal(detect.detectJobsAndMoves(), 2, 'a new failure after the recovery, then gave_up');
  assert.match(db.prepare("SELECT message FROM alert_outbox WHERE event='backup.copy_gave_up'").get().message, /^Backup copy stopped: alerts\.example to Backblaze B2 failed for 7 days/);
});

test('copy target == main is refused, also through the default and through a second row for the same bucket', async () => {
  const { siteId } = site('same.example');
  const main = s3Target(r2, { name: 'Bucket A', prefix: 'same' }), twin = s3Target(r2, { name: 'Bucket A again', prefix: 'same' }), nested = s3Target(r2, { name: 'Bucket A nested', prefix: 'same/inner' }), other = s3Target(r2, { name: 'Bucket A other folder', prefix: 'other' });
  const code = fn => { try { fn(); return null; } catch (error) { return error.code; } };
  assert.equal(code(() => setCopies(siteId, [{ targetId: main }], main)), 'copy_equals_main');
  assert.equal(code(() => setCopies(siteId, [{ targetId: twin }], main)), 'copy_equals_main', 'same bucket and folder under another name');
  assert.equal(code(() => setCopies(siteId, [{ targetId: nested }], main)), 'copy_equals_main', 'a folder inside the main one');
  assert.equal(code(() => setCopies(siteId, [{ targetId: other }, { targetId: other }], main)), 'duplicate_copy');
  assert.equal(code(() => setCopies(siteId, [{ targetId: twin }, { targetId: main }], null)), 'duplicate_copy', 'the same bucket twice as copies');
  assert.equal(code(() => setCopies(siteId, [{ targetId: other }], main)), null, 'another folder of the same bucket is a different place');
  db.prepare("INSERT INTO settings VALUES('backup_storage_target',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(main);
  try {
    assert.equal(code(() => setCopies(siteId, [{ targetId: twin }], null)), 'copy_equals_main', 'through the default destination');
    // The default changes after copies were configured: the backup lands on the copy's place, so no copy is made there.
    db.prepare('DELETE FROM site_storage_copies WHERE site_id=?').run(siteId); db.prepare('INSERT INTO site_storage_copies VALUES(?,?,NULL,?)').run(siteId, twin, stamp());
    db.prepare('UPDATE site_storage SET main_target_id=NULL WHERE site_id=?').run(siteId);
    const backupId = await publish(siteId);
    assert.equal(copyRow(backupId, twin), undefined);
    assert.equal(db.prepare("SELECT json_extract(detail,'$.reason') AS reason FROM audit_events WHERE action='backup.copy_skipped' AND target=?").get(backupId).reason, 'same_destination');
  } finally { db.prepare("DELETE FROM settings WHERE key='backup_storage_target'").run(); db.prepare('DELETE FROM site_storage_copies WHERE site_id=?').run(siteId); }
  assert.equal(code(() => setCopies(siteId, [{ targetId: other }, { targetId: twin }, { targetId: nested }, { targetId: deadSftpTarget() }])), 'too_many_copies');
  assert.equal(code(() => setCopies(siteId, [{ targetId: other, retention: 0 }])), 'invalid_retention');
  assert.equal(code(() => setCopies(siteId, [{ targetId: other, retention: 366 }])), 'invalid_retention');
  assert.equal(code(() => setCopies(siteId, [{ targetId: 'nope' }])), 'unknown_destination');
});

test('per-copy retention and pins: 1 copy on one destination, 3 on another, 30 main packages', async () => {
  const { siteId } = site('retention.example', { retention: 30 });
  const fast = s3Target(r2, { name: 'Fast copy', prefix: 'fast' }), cheap = s3Target(r2, { name: 'Cheap copy', prefix: 'cheap' });
  setCopies(siteId, [{ targetId: fast, retention: 1 }, { targetId: cheap, retention: 3 }]);
  const ids = [];
  // Retention runs after every copy step, as in the worker. The first backup is pinned before later copies arrive.
  for (let n = 0; n < 5; n++) { ids.push(await publish(siteId, day(n))); if (n === 0) db.prepare('UPDATE backups SET pinned=1 WHERE id=?').run(ids[0]); await runCopies(); }
  await engine.retain(siteId);
  const status = targetId => ids.map(backupId => copyRow(backupId, targetId).status);
  assert.deepEqual(status(fast), ['verified', 'deleted', 'deleted', 'deleted', 'verified'], 'the newest copy, plus the pinned one');
  assert.deepEqual(status(cheap), ['verified', 'deleted', 'verified', 'verified', 'verified']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backups WHERE site_id=?').get(siteId).n, 5, 'all 5 main packages stay (count 30)');
  for (const backupId of ids.slice(1, 4)) await assert.rejects(storage.statFile(copyRow(backupId, fast).path), 'the deleted copies are gone from the bucket');
  assert.ok(await storage.statFile(copyRow(ids[0], fast).path), 'pins apply to every copy');
});

test('the main copy ages out while a copy keeps the backup: restore falls back to it, newest verified first', async () => {
  const { siteId, serverId } = site('fallback.example', { retention: 1 });
  const keep = s3Target(r2, { name: 'Keeper', prefix: 'keeper' }), second = s3Target(r2, { name: 'Second keeper', prefix: 'second' });
  setCopies(siteId, [{ targetId: keep, retention: 3 }, { targetId: second, retention: 3 }]);
  const old = await publish(siteId, day(1)); await runCopies();
  const original = db.prepare('SELECT path FROM backups WHERE id=?').get(old).path;
  await publish(siteId, day(2)); await runCopies();
  await engine.retain(siteId);
  const backup = db.prepare('SELECT * FROM backups WHERE id=?').get(old);
  assert.ok(backup, 'the backup lives on its copies');
  await assert.rejects(readFile(original), 'its main package is gone');
  assert.equal(db.prepare('SELECT original_path FROM backup_main_removed WHERE backup_id=?').get(old).original_path, original);
  assert.equal(backup.path, original, 'backups.path always names the main package');
  assert.ok([copyRow(old, keep).path, copyRow(old, second).path].includes(journal.packagePath(backup)), 'reads go to a verified copy');
  const sources = engine.restoreSources(backup);
  assert.deepEqual(sources.map(source => [source.role, source.status]), [['main', 'missing'], ['copy', 'verified'], ['copy', 'verified']]);
  assert.ok(sources[1].verifiedAt >= sources[2].verifiedAt, 'newest verified first');
  // Restore (here the restore-test upload, the same authenticated source choice) reads the copy.
  const received = [];
  const saved = engine.transport.uploadStream;
  engine.transport.uploadStream = async (_server, stream) => { await pipeline(stream, new Writable({ write(chunk, _e, cb) { received.push(chunk); cb(); } })); };
  try {
    const result = await engine.uploadBackupTo({ id: serverId }, old, randomUUID(), { prepare: async () => ({ remotePath: '/tmp/x' }) });
    assert.equal(result.source.role, 'copy'); assert.ok(received.length);
    // The owner can pick a copy directly.
    const views = copies.backupCopyViews([backup]).get(old);
    assert.equal(views.mainRemoved, true); assert.equal(views.mainTarget.id, 'env');
    assert.deepEqual(views.copies.map(copy => copy.status), ['verified', 'verified']);
  } finally { engine.transport.uploadStream = saved; }
  // A damaged first copy: the next verified copy is used.
  const firstCopy = sources[1];
  const damaged = copyRow(old, firstCopy.targetId).path;
  await storage.removeFile(damaged);
  await pipeline(Readable.from([randomBytes(backup.size)]), await storage.openWrite(damaged));
  engine.transport.uploadStream = async (_server, stream) => { await pipeline(stream, new Writable({ write(_c, _e, cb) { cb(); } })); };
  try {
    const result = await engine.uploadBackupTo({ id: serverId }, old, randomUUID(), { prepare: async () => ({ remotePath: '/tmp/x' }) });
    assert.equal(result.source.targetId, sources[2].targetId, 'a copy that fails authentication is skipped');
  } finally { engine.transport.uploadStream = saved; }
});

test('a damaged main copy falls back to a verified copy; a backup without copies keeps today\'s error', async () => {
  const { siteId, serverId } = site('damaged.example');
  const bucket = s3Target(r2, { name: 'Rescue bucket', prefix: 'rescue' });
  setCopies(siteId, [{ targetId: bucket, retention: null }]);
  const backupId = await publish(siteId); await runCopies();
  const backup = db.prepare('SELECT * FROM backups WHERE id=?').get(backupId);
  await writeFile(backup.path, randomBytes(backup.size));
  const saved = engine.transport.uploadStream;
  engine.transport.uploadStream = async (_server, stream) => { await pipeline(stream, new Writable({ write(_c, _e, cb) { cb(); } })); };
  try {
    assert.equal((await engine.uploadBackupTo({ id: serverId }, backupId, randomUUID(), { prepare: async () => ({ remotePath: '/tmp/x' }) })).source.targetId, bucket);
    const lone = site('lone.example'), loneId = await publish(lone.siteId), loneBackup = db.prepare('SELECT * FROM backups WHERE id=?').get(loneId);
    await writeFile(loneBackup.path, randomBytes(loneBackup.size));
    await assert.rejects(engine.uploadBackupTo({ id: lone.serverId }, loneId, randomUUID(), { prepare: async () => ({ remotePath: '/tmp/x' }) }), /checksum differs/);
  } finally { engine.transport.uploadStream = saved; }
});

test('Object Lock on the copy only: the copy deletion is deferred per copy, the main package goes', async () => {
  const { siteId } = site('locked.example', { retention: 1 });
  const vault = s3Target(locked, { name: 'Locked vault', objectLock: { mode: 'COMPLIANCE', days: 1 } });
  setCopies(siteId, [{ targetId: vault, retention: 1 }]);
  const first = await publish(siteId, day(1)); await runCopies();
  const copy = copyRow(first, vault), key = copy.path.replace(/^s3:[^:]+:\//, '');
  assert.equal(locked.objects.get(key).lockMode, 'COMPLIANCE', 'the copy is locked');
  const mainPath = db.prepare('SELECT path FROM backups WHERE id=?').get(first).path;
  assert.ok(!mainPath.startsWith('s3:'), 'the main copy is on another destination, without a lock');
  await publish(siteId, day(2)); await runCopies();
  await engine.retain(siteId);
  const row = copyRow(first, vault);
  assert.equal(row.delete_state, 'deferred'); assert.equal(row.status, 'verified'); assert.ok(row.delete_after > Date.now());
  await assert.rejects(readFile(mainPath), 'the unlocked main package is deleted');
  assert.equal(db.prepare('SELECT path FROM backups WHERE id=?').get(first).path, mainPath, 'backups.path keeps the main path');
  assert.equal(journal.packagePath(db.prepare('SELECT * FROM backups WHERE id=?').get(first)), copy.path, 'the backup stays usable on its locked copy');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM retention_deferrals WHERE backup_id=?').get(first).n, 0, 'no backup-wide deferral');
  // When the lock ends the copy goes, and with it the backup.
  locked.objects.get(key).retainUntil = new Date(Date.now() - 1000).toISOString();
  db.prepare('UPDATE backup_copies SET delete_after=0 WHERE backup_id=?').run(first);
  await copies.maintainCopies();
  assert.equal(copyRow(first, vault).status, 'deleted');
  assert.equal(db.prepare('SELECT 1 FROM backups WHERE id=?').get(first), undefined);
});

test('worker restart mid-copy: the journal adopts an authenticated file and retries anything else', async () => {
  const { siteId } = site('restart.example');
  const bucket = s3Target(r2, { name: 'Restart bucket', prefix: 'restart' });
  setCopies(siteId, [{ targetId: bucket, retention: null }]);
  const ids = [await publish(siteId), await publish(siteId), await publish(siteId)];
  const source = backupId => db.prepare('SELECT path FROM backups WHERE id=?').get(backupId).path;
  // 1: authenticated .partial, not renamed. 2: a truncated .partial. 3: nothing written yet.
  await pipeline(await storage.openRead(source(ids[0])), await storage.openWrite(copyRow(ids[0], bucket).path + '.partial'));
  await pipeline(Readable.from([randomBytes(100)]), await storage.openWrite(copyRow(ids[1], bucket).path + '.partial'));
  db.prepare("UPDATE backup_copies SET status='copying' WHERE backup_id IN (?,?,?)").run(...ids);
  assert.equal(journal.claimDeletion(ids[0]), false, 'a copy step holds a lease: retention cannot delete what it reads');
  const result = await journal.recoverInterruptedCopies(engine.verifyEncrypted);
  assert.deepEqual(result, { adopted: 1, retried: 2, failed: 0 });
  assert.equal(copyRow(ids[0], bucket).status, 'verified');
  assert.equal(await engine.verifyEncrypted(copyRow(ids[0], bucket).path), db.prepare('SELECT checksum FROM backups WHERE id=?').get(ids[0]).checksum);
  await assert.rejects(storage.statFile(copyRow(ids[1], bucket).path + '.partial'), 'the broken partial is removed');
  assert.deepEqual([copyRow(ids[1], bucket).status, copyRow(ids[2], bucket).status], ['pending', 'pending']);
  await runCopies();
  assert.deepEqual(ids.map(backupId => copyRow(backupId, bucket).status), ['verified', 'verified', 'verified']);
});

test('site moved to another server: old copies stay where they are, new ones follow the new layout', async () => {
  const { siteId } = site('moved.example');
  const bucket = s3Target(r2, { name: 'Move bucket', prefix: 'moved' });
  setCopies(siteId, [{ targetId: bucket, retention: 5 }]);
  const before = await publish(siteId); await runCopies();
  const newServer = randomUUID();
  db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(newServer, 'New home', '192.0.2.20', 22, 'root', 'fixture', '0'.repeat(64), stamp());
  db.prepare('UPDATE sites SET server_id=? WHERE id=?').run(newServer, siteId);
  const afterMove = await publish(siteId); await runCopies();
  assert.match(copyRow(before, bucket).path, /\/server-moved-example--/);
  assert.match(copyRow(afterMove, bucket).path, new RegExp(`/new-home--${newServer}/`));
  assert.deepEqual([copyRow(before, bucket).status, copyRow(afterMove, bucket).status], ['verified', 'verified']);
  assert.ok(await storage.statFile(copyRow(before, bucket).path));
});

test('API: site storage, copies in /api/state and history, retry, restore sources, and a destination with copies cannot be removed', async () => {
  const admin = session('admin'), operator = session('operator'), stale = session('admin', { recent: false });
  const { siteId } = site('api.example');
  const bucket = s3Target(r2, { name: 'API copies', prefix: 'api' }), dead = deadSftpTarget('API dead box');
  let response = await admin('GET', `/sites/${siteId}/storage`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { siteId, main: { targetId: null, effective: { id: 'env', name: 'Local disk', mode: 'local' } }, default: { id: 'env', name: 'Local disk', mode: 'local' }, copies: [], maxCopies: 3, copyMissing: false });
  assert.equal((await operator('PUT', `/sites/${siteId}/storage`, { mainTargetId: null, copies: [] })).status, 403);
  assert.equal((await stale('PUT', `/sites/${siteId}/storage`, { mainTargetId: null, copies: [] })).body.code, 'REAUTH_REQUIRED');
  response = await admin('PUT', `/sites/${siteId}/storage`, { mainTargetId: null, copies: [{ targetId: bucket, retention: 14 }, { targetId: dead, retention: null }] });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.copies, [{ targetId: bucket, name: 'API copies', mode: 's3', retention: 14, effectiveRetention: 14 }, { targetId: dead, name: 'API dead box', mode: 'sftp', retention: null, effectiveRetention: 7 }]);
  for (const [body, code] of [[{ mainTargetId: null, copies: [{ targetId: bucket }, { targetId: bucket }] }, 'duplicate_copy'], [{ mainTargetId: bucket, copies: [{ targetId: bucket }] }, 'copy_equals_main'], [{ mainTargetId: 'missing', copies: [] }, 'unknown_destination'], [{ mainTargetId: null, copies: [{ targetId: bucket, retention: 1.5 }] }, 'invalid_retention']]) {
    response = await admin('PUT', `/sites/${siteId}/storage`, body); assert.equal(response.status, 400); assert.equal(response.body.code, code);
  }
  const backupId = await publish(siteId); await runCopies();
  const state = (await admin('GET', '/state')).body;
  assert.deepEqual(state.sites.find(item => item.id === siteId).storage, { mainTargetId: null, copyTargetIds: [bucket, dead], copyMissing: true });
  const listed = state.backups.find(item => item.id === backupId);
  assert.deepEqual(listed.mainTarget, { id: 'env', name: 'Local disk', mode: 'local' });
  assert.deepEqual(listed.copies.map(copy => [copy.name, copy.status, copy.attempts, copy.lastError]), [['API copies', 'verified', 0, null], ['API dead box', 'failed', 1, 'Could not reach the copy destination or write to it.']]);
  assert.ok(listed.copies[1].nextAttemptAt && listed.copies[0].verifiedAt);
  assert.equal(listed.path, undefined);
  const history = (await admin('GET', '/backups?limit=200')).body.items.find(item => item.id === backupId);
  assert.deepEqual(history.copies.map(copy => copy.status), ['verified', 'failed']);
  const old = (await admin('GET', '/state')).body.backups.find(item => item.copies.length === 0);
  assert.ok(old, 'backups without copies carry an empty list');
  assert.doesNotMatch(JSON.stringify(state), /fixture-password|AKIAFIXTURE|BACKUP\/server-/, 'names only: no credential or storage path');
  // Retry.
  response = await admin('POST', `/backups/${backupId}/copies/${dead}/retry`);
  assert.equal(response.status, 202); assert.equal(response.body.status, 'pending'); assert.ok(Date.parse(response.body.nextAttemptAt));
  assert.equal((await admin('POST', `/backups/${backupId}/copies/${bucket}/retry`)).status, 409);
  assert.equal((await admin('POST', `/backups/${backupId}/copies/nowhere/retry`)).status, 404);
  // Restore from a chosen source: only a verified copy (checked before any server is contacted).
  response = await admin('POST', `/backups/${backupId}/restore-plan`, { serverId: randomUUID(), sourceTargetId: dead });
  assert.equal(response.status, 409); assert.equal(response.body.code, 'source_unavailable');
  assert.deepEqual(engine.restoreSources(db.prepare('SELECT * FROM backups WHERE id=?').get(backupId)).map(source => [source.name, source.role, source.status]), [['Local disk', 'main', 'verified'], ['API copies', 'copy', 'verified'], ['API dead box', 'copy', 'pending']]);
  // A destination holding copies or used by a site cannot be removed.
  response = await admin('DELETE', `/storage-targets/${bucket}`);
  assert.equal(response.status, 409); assert.equal(response.body.code, 'destination_in_use');
  assert.equal(response.body.copies, 1); assert.equal(response.body.copyBackups, 1); assert.ok(response.body.bytes > 0);
  assert.deepEqual(response.body.copyForSites, [{ id: siteId, name: 'api.example' }]); assert.deepEqual(response.body.mainForSites, []);
  assert.match(response.body.error, /delete these copies first/);
  assert.deepEqual((await admin('GET', `/storage-targets/${bucket}/usage`)).body.copies, 1);
  // "Delete these copies": pinned copies need a confirmation; then the worker removes them and the destination is free.
  db.prepare('UPDATE backups SET pinned=1 WHERE id=?').run(backupId);
  // A backup whose main package aged out and that exists only here: deleting the copies needs its own confirmation.
  db.prepare('INSERT INTO backup_main_removed VALUES(?,?,?)').run(backupId, db.prepare('SELECT path FROM backups WHERE id=?').get(backupId).path, stamp());
  assert.equal((await admin('GET', `/storage-targets/${bucket}/usage`)).body.onlyPackageBackups, 1);
  response = await admin('POST', `/storage-targets/${bucket}/copies/delete`, { includePinned: true });
  assert.equal(response.status, 409); assert.equal(response.body.code, 'last_packages'); assert.equal(response.body.lastPackages, 1);
  db.prepare('DELETE FROM backup_main_removed WHERE backup_id=?').run(backupId);
  response = await admin('POST', `/storage-targets/${bucket}/copies/delete`, {});
  assert.equal(response.status, 409); assert.equal(response.body.code, 'pinned_copies');
  assert.equal((await stale('POST', `/storage-targets/${bucket}/copies/delete`, { includePinned: true })).status, 403);
  response = await admin('POST', `/storage-targets/${bucket}/copies/delete`, { includePinned: true });
  assert.equal(response.status, 202); assert.deepEqual(response.body, { deleting: 1 });
  const copyPath = copyRow(backupId, bucket).path;
  await copies.maintainCopies();
  await assert.rejects(storage.statFile(copyPath));
  assert.equal(copyRow(backupId, bucket).status, 'deleted');
  assert.ok(db.prepare('SELECT 1 FROM backups WHERE id=?').get(backupId), 'deleting copies never deletes the backup');
  assert.equal(db.prepare('SELECT pinned FROM backups WHERE id=?').get(backupId).pinned, 1, 'and the confirmed pinned copy went too');
  response = await admin('DELETE', `/storage-targets/${bucket}`);
  assert.equal(response.status, 200); assert.equal(response.body.removed, true);
  assert.equal((await admin('GET', `/storage-targets/${bucket}/usage`)).status, 404);
  // A destination that is a site's main destination is refused too.
  const mainOnly = s3Target(r2, { name: 'Main only', prefix: 'mainonly' });
  db.prepare('INSERT INTO site_storage VALUES(?,?,?) ON CONFLICT(site_id) DO UPDATE SET main_target_id=excluded.main_target_id').run(siteId, mainOnly, stamp());
  response = await admin('DELETE', `/storage-targets/${mainOnly}`);
  assert.equal(response.status, 409); assert.deepEqual(response.body.mainForSites, [{ id: siteId, name: 'api.example' }]);
});

test('storage report: bytes per destination include copies, listed apart from main packages', async () => {
  report.capacityTestHooks.read = async () => null;
  const { siteId } = site('report.example');
  const bucket = s3Target(r2, { name: 'Report copies', prefix: 'report' });
  setCopies(siteId, [{ targetId: bucket, retention: null }]);
  const backupId = await publish(siteId); await runCopies();
  const size = db.prepare('SELECT size FROM backups WHERE id=?').get(backupId).size;
  const built = await report.storageReport();
  const row = built.storages.find(entry => entry.id === bucket);
  assert.deepEqual({ targetId: row.targetId, name: row.name, mode: row.mode, mainBytes: row.mainBytes, copyBytes: row.copyBytes, copyCount: row.copyCount, chainBytes: row.chainBytes, bytes: row.bytes }, { targetId: bucket, name: 'Report copies', mode: 's3', mainBytes: 0, copyBytes: size, copyCount: 1, chainBytes: 0, bytes: size });
  const local = built.storages.find(entry => entry.id === 'local');
  assert.ok(local.mainBytes >= size && local.copyBytes === 0);
});

test('2.10 retention on a backup whose main package aged out removes the row but never its copy files', async () => {
  const { siteId } = site('downgrade.example', { retention: 1 });
  const bucket = s3Target(r2, { name: 'Downgrade copies', prefix: 'downgrade' });
  setCopies(siteId, [{ targetId: bucket, retention: 5 }]);
  const old = await publish(siteId, day(1)); await runCopies(); await publish(siteId, day(2)); await runCopies();
  await engine.retain(siteId);
  assert.ok(journal.mainRemoved(old));
  // Exactly what 2.10 finishDeletion does with backups.path (the main path, already gone) and the row.
  const backup = db.prepare('SELECT * FROM backups WHERE id=?').get(old);
  if (await journal.fileExists(backup.path)) await storage.removeFile(backup.path);
  db.prepare('DELETE FROM backups WHERE id=?').run(old);
  assert.ok(await storage.statFile(copyRow(old, bucket).path), 'its copy file is left alone');
});

test('finishDeletion removes the main package first: an Object-Locked main keeps every copy', async () => {
  const { siteId } = site('mainlock.example', { retention: 1 });
  const vault = s3Target(locked, { name: 'Locked main', prefix: 'mainlock', objectLock: { mode: 'COMPLIANCE', days: 1 } }), bucket = s3Target(r2, { name: 'Unlocked copy', prefix: 'mainlock' });
  setCopies(siteId, [{ targetId: bucket, retention: 1 }], vault);
  const first = await publish(siteId, day(1)); await runCopies();
  await publish(siteId, day(2));
  assert.equal(journal.claimDeletion(first), true);
  assert.deepEqual(await journal.finishDeletion(first), { deferred: true });
  assert.equal(copyRow(first, bucket).status, 'verified', 'nothing of the backup goes while its main package is locked');
  assert.ok(await storage.statFile(copyRow(first, bucket).path));
  assert.equal(journal.mainRemoved(first), false);
});

test('a destination removed from the site list: unmade copies are cancelled, made ones keep the site count and are not retried', async () => {
  const { siteId } = site('unlisted.example', { retention: 1 });
  const bucket = s3Target(r2, { name: 'Unlisted later', prefix: 'unlisted' }), dead = deadSftpTarget('Unlisted dead');
  setCopies(siteId, [{ targetId: bucket, retention: 10 }, { targetId: dead, retention: null }]);
  const a = await publish(siteId, day(1)); await runCopies();
  const b = await publish(siteId, day(2));
  setCopies(siteId, []);
  assert.equal(copyRow(b, bucket).status, 'deleted', 'a pending copy to a removed destination is cancelled');
  assert.equal(copyRow(a, dead).status, 'deleted', 'and so is a failed one');
  db.prepare("UPDATE backup_copies SET status='failed',next_attempt_at=0 WHERE backup_id=? AND target_id=?").run(b, bucket);
  const claimed = journal.claimCopy();
  assert.equal([a, b].includes(claimed?.backup_id), false, 'claimCopy checks the site list');
  if (claimed) db.prepare("UPDATE backup_copies SET status='pending' WHERE backup_id=? AND target_id=?").run(claimed.backup_id, claimed.target_id);
  await copies.retainCopies(siteId);
  assert.equal(copyRow(a, bucket).status, 'verified', 'the newest made copy stays under the site count (1)');
});

test('a long copy steps aside for a queued site job without counting an attempt', async () => {
  const { siteId } = site('yield.example');
  const bucket = s3Target(r2, { name: 'Yield bucket', prefix: 'yield' });
  setCopies(siteId, [{ targetId: bucket, retention: null }]);
  const backupId = await publish(siteId);
  db.prepare("UPDATE backup_copies SET next_attempt_at=? WHERE status IN ('pending','failed') AND backup_id<>?").run(Date.now() + 86400000, backupId);
  const job = randomUUID(); db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','queued','queued',?)").run(job, siteId, stamp());
  const saved = copies.copyHooks.yieldCheckBytes; copies.copyHooks.yieldCheckBytes = 1;
  try {
    const copy = journal.claimCopy();
    assert.equal(copy.backup_id, backupId);
    assert.deepEqual(await copies.executeCopy(copy, engine.verifyEncrypted), { status: 'yielded' });
  } finally { copies.copyHooks.yieldCheckBytes = saved; db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(job); }
  const row = copyRow(backupId, bucket);
  assert.deepEqual([row.status, row.attempts, row.alerted], ['pending', 0, 0]);
  await assert.rejects(storage.statFile(row.path + '.partial'));
  await copies.executeCopy(journal.claimCopy(Date.now() + 5000), engine.verifyEncrypted);
  assert.equal(copyRow(backupId, bucket).status, 'verified');
});

test('copy recovery waits while the deployment hold is set', async () => {
  const { siteId } = site('held.example');
  const bucket = s3Target(r2, { name: 'Held bucket', prefix: 'held' });
  setCopies(siteId, [{ targetId: bucket, retention: null }]);
  const backupId = await publish(siteId);
  db.prepare("UPDATE backup_copies SET status='copying' WHERE backup_id=?").run(backupId);
  db.prepare("INSERT INTO settings VALUES('deployment_hold','true')").run();
  try { assert.equal((await journal.recoverInterruptedCopies(engine.verifyEncrypted)).held, true); assert.equal(copyRow(backupId, bucket).status, 'copying'); }
  finally { db.prepare("DELETE FROM settings WHERE key='deployment_hold'").run(); }
  await copies.maintainCopies(Date.now(), engine.verifyEncrypted);
  assert.equal(copyRow(backupId, bucket).status, 'pending', 'resumed by maintenance once the hold is released');
});

test('a copy never steps aside for a queued job that cannot start, and steps aside at most maxYields times', async () => {
  const { siteId } = site('blocked.example');
  const bucket = s3Target(r2, { name: 'Blocked-job bucket', prefix: 'blocked' });
  setCopies(siteId, [{ targetId: bucket, retention: null }]);
  const backupId = await publish(siteId);
  db.prepare("UPDATE backup_copies SET next_attempt_at=? WHERE status IN ('pending','failed') AND backup_id<>?").run(Date.now() + 86400000, backupId);
  // A queued backup on a server whose previous job needs recovery: claimJob would not start it.
  const stuck = randomUUID(), queued = randomUUID();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','recovery_required','recovery_required',?)").run(stuck, siteId, stamp());
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','queued','queued',?)").run(queued, siteId, stamp());
  const saved = copies.copyHooks.yieldCheckBytes; copies.copyHooks.yieldCheckBytes = 1;
  try {
    assert.equal((await import('../src/job-claim.js')).claimableJobExists(), false, 'the queued job is blocked');
    const copy = journal.claimCopy(); assert.equal(copy.backup_id, backupId);
    assert.equal((await copies.executeCopy(copy, engine.verifyEncrypted)).status, 'verified', 'the copy completes instead of looping');
    // A claimable job: the copy steps aside, waits for the next tick, and after maxYields finishes regardless.
    db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(stuck);
    const other = await publish(siteId);
    db.prepare("UPDATE backup_copies SET next_attempt_at=? WHERE status IN ('pending','failed') AND backup_id<>?").run(Date.now() + 86400000, other);
    const results = [];
    for (let round = 0; round < 6; round++) {
      const next = journal.claimCopy(Date.now() + 3600000); if (!next) break;
      results.push((await copies.executeCopy(next, engine.verifyEncrypted)).status);
      if (results.at(-1) === 'yielded') assert.ok(copyRow(other, bucket).next_attempt_at > Date.now(), 'due at the next tick, not at once');
      if (results.at(-1) === 'verified') break;
    }
    assert.deepEqual(results, ['yielded', 'yielded', 'yielded', 'verified']);
    assert.equal(copyRow(other, bucket).attempts, 0);
  } finally { copies.copyHooks.yieldCheckBytes = saved; db.prepare("UPDATE jobs SET status='failed' WHERE id IN (?,?)").run(stuck, queued); }
});
