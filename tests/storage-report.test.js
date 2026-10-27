// Storage report (docs/restore-tests.md, "Storage report"): estimate rules, storage and site grouping, 30-day growth,
// roles, and that the report never exposes paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-storage-report-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const report = await import('../src/storage-report.js');
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;

const GB = 1e9, NOW = Date.parse('2026-11-02T12:00:00Z');
const daysAgo = n => new Date(NOW - n * 86400000).toISOString();

test('estimate: only growth is new data; shrinking and flat packages can be saved', () => {
  assert.deepEqual(report.siteEstimate([]), { stored: 0, needed: 0, upToBytes: 0, upToPercent: 0, growthPerBackupBytes: 0 });
  assert.equal(report.siteEstimate([5 * GB]).upToBytes, 0);
  assert.equal(report.siteEstimate([10, 10, 10, 10]).upToBytes, 30);
  assert.equal(report.siteEstimate([10, 10, 10, 10]).upToPercent, 75);
  const growing = report.siteEstimate([10, 11, 13]); // needed = 10 + 1 + 2 = 13, stored 34
  assert.equal(growing.needed, 13); assert.equal(growing.upToBytes, 21); assert.equal(growing.growthPerBackupBytes, 2);
  const shrinking = report.siteEstimate([20, 10, 10]); // never below the largest package
  assert.equal(shrinking.needed, 20); assert.equal(shrinking.upToBytes, 20);
  assert.ok(report.siteEstimate([1, 1000, 1, 1000]).upToBytes >= 0);
});

test('storage ids come from the path reference', () => {
  assert.equal(report.storageIdOf('sftp:abc:/x/y.enc'), 'abc');
  assert.equal(report.storageIdOf('s3:def:k/y.enc'), 'def');
  assert.equal(report.storageIdOf('sftp:/legacy/y.enc'), 'env');
  assert.equal(report.storageIdOf('/data/backups/y.enc'), 'local');
  assert.equal(report.storageIdOf('C:\\data\\y.enc'), 'local');
});

test('growth series is cumulative over the last 30 days and ignores bad dates', () => {
  const series = report.growthSeries([{ capturedAt: daysAgo(40), size: 100 }, { capturedAt: daysAgo(10), size: 50 }, { capturedAt: 'nope', size: 9 }, { capturedAt: daysAgo(0), size: 25 }], NOW);
  assert.equal(series.points.length, 30);
  assert.equal(series.fromBytes, 100); assert.equal(series.toBytes, 175); assert.equal(series.changeBytes, 75);
  assert.deepEqual(report.growthSeries([], NOW).points, new Array(30).fill(0));
});

test('buildReport groups by site and by storage and totals them', () => {
  const sites = [{ id: 'a', name: 'shop' }, { id: 'b', name: 'blog' }], targets = [{ id: 't1', name: 'Offsite' }];
  const backups = [
    { id: '1', siteId: 'a', capturedAt: daysAgo(3), path: 'sftp:t1:/a/1', size: 10 }, { id: '2', siteId: 'a', capturedAt: daysAgo(2), path: 'sftp:t1:/a/2', size: 12 },
    { id: '3', siteId: 'b', capturedAt: daysAgo(1), path: '/local/3', size: 4 }, { id: '4', siteId: 'gone', capturedAt: daysAgo(1), path: 'sftp:old:/x', size: 1 }];
  const built = report.buildReport({ backups, sites, targets, capacities: { t1: 1000 }, nowMs: NOW });
  assert.deepEqual(built.sites.map(row => [row.name, row.packages, row.bytes]), [['shop', 2, 22], ['blog', 1, 4], ['Removed site', 1, 1]]);
  assert.deepEqual(built.storages.map(row => [row.name, row.bytes, row.capacityBytes]), [['Offsite', 22, 1000], ['Local disk', 4, null], ['Removed destination', 1, null]]);
  assert.equal(built.totals.bytes, 27); assert.equal(built.totals.packages, 4);
  assert.equal(built.sites[0].estimate.upToBytes, 10); // 22 stored, needs 12
  assert.equal(built.totals.estimateUpToBytes, 10); assert.equal(built.totals.estimateUpToPercent, 37);
  assert.match(built.method, /estimate/);
});

function user(role) {
  const id = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(id, id + '@example.invalid', 'fixture', 'fixture', '[]', new Date().toISOString(), role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), id, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), Date.now());
  return path => fetch(base + path, { headers: { Cookie: 'dbm_session=' + token } });
}

test('API: administrators read it, operators do not, retention-held packages and paths stay out', async () => {
  report.capacityTestHooks.read = async id => id === 'local' ? 500 * GB : null;
  const stamp = new Date().toISOString(), serverId = randomUUID(), siteId = randomUUID();
  db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(serverId, 's', '192.0.2.10', 22, 'root', 'fixture', '0'.repeat(64), stamp);
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, serverId, 'reportsite', '{}', stamp);
  const ids = [];
  for (const [i, size] of [100, 120, 120].entries()) {
    const jobId = randomUUID(), backupId = randomUUID(); ids.push(backupId);
    db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,started_at,finished_at) VALUES(?,?,'backup','completed','completed',?,?,?)").run(jobId, siteId, stamp, stamp, stamp);
    db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(backupId, siteId, jobId, new Date(Date.now() - (3 - i) * 86400000).toISOString(), join(directory, 'secret-folder', backupId + '.enc'), size, 'a'.repeat(64), '{}', 0, 1, stamp);
  }
  db.prepare("INSERT INTO retention_operations VALUES(?,'deleting',?)").run(ids[2], stamp);
  const forbidden = await user('operator')('/storage-report');
  assert.equal(forbidden.status, 403);
  const response = await user('admin')('/storage-report'), body = await response.json();
  assert.equal(response.status, 200);
  const row = body.sites.find(entry => entry.siteId === siteId);
  assert.deepEqual([row.packages, row.bytes, row.newestBytes, row.estimate.upToBytes], [2, 220, 120, 100]);
  assert.equal(body.storages.find(entry => entry.id === 'local').capacityBytes, 500 * GB);
  assert.equal(body.growth.points.length, 30);
  assert.doesNotMatch(JSON.stringify(body), /secret-folder|\.enc/);
});

test.after(() => listener.close());
