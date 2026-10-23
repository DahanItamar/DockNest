import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const root = await mkdtemp(join(tmpdir(), 'docknest-radar-'));
Object.assign(process.env, { DATA_DIR: root, MASTER_KEY_FILE: join(root, 'master.key'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured', SECURE_COOKIES: 'false', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js');
const { db, id } = await import('../src/db.js');
const { digest, seal } = await import('../src/crypto.js');
const radar = await import('../src/radar/scan.js');
const { tickRadar, claimScan, requestScan, recordScan, componentsOf, imageTagVersion, lastSlot, DAY_MS } = radar;

const users = [id(), id()], csrf = 'fixture-csrf', tokens = users.map(() => randomBytes(32).toString('base64url'));
for (const [index, user] of users.entries()) {
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(user, `${user}@example.invalid`, 'fixture', seal('JBSWY3DPEHPK3PXP'), '[]', new Date().toISOString(), `User ${index}`, index ? 'operator' : 'admin');
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(tokens[index]), user, csrf, Date.now() + 3600000, Date.now(), Date.now(), Date.now());
}
const serverA = id(), serverB = id(), site = id(), other = id();
for (const [server, name] of [[serverA, 'alpha'], [serverB, 'beta']]) db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,'host.example.invalid',22,'root','sealed','SHA256:x','2026-01-01')").run(server, name);
db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(site, serverA, 'Shop', JSON.stringify({ containers: ['shop-web'] }), '2026-01-01');
db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(other, serverB, 'Blog', JSON.stringify({ containers: ['blog'] }), '2026-01-01');
const listen = app.listen(0, '127.0.0.1'); await new Promise(resolve => listen.once('listening', resolve));
test.after(() => listen.close());
const request = (route, { as = 0, method = 'GET', body } = {}) => fetch(`http://127.0.0.1:${listen.address().port}/api/radar${route}`, { method, headers: { Cookie: 'dbm_session=' + tokens[as], Origin: process.env.APP_ORIGIN, 'x-csrf-token': csrf, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const inventory = (php = '8.3.10') => ({ helperVersion: 1, probes: true, containers: [
  { id: 'a'.repeat(64), name: 'shop-web', image: 'php:8.3-apache', imageCreated: '2026-09-01T00:00:00Z', running: true, own: false, labels: { composeProject: 'shop', composeService: 'web' }, runtime: php ? { php, node: null, os: null } : null },
  { id: 'b'.repeat(64), name: 'docknest-api', image: 'docknest:2.5.0', running: true, own: true, labels: {}, runtime: null },
] });

test('components come from the runtime probe first, then the official image tag', () => {
  assert.equal(imageTagVersion('php:8.3-apache', 'php'), '8.3');
  assert.equal(imageTagVersion('docker.io/library/node:22.11.0-alpine', 'node'), '22.11.0');
  assert.equal(imageTagVersion('acme/php:8.3', 'php'), null, 'only official images');
  assert.equal(imageTagVersion('php:latest', 'php'), null);
  assert.deepEqual(componentsOf({ image: 'php:8.3-apache', runtime: { php: '8.3.10' } }), [{ product: 'php', version: '8.3.10', source: 'runtime' }]);
  assert.deepEqual(componentsOf({ image: 'node:20', imageCreated: '2026-01-01', runtime: null }), [{ product: 'node', version: '20', source: 'image-tag', imageCreated: '2026-01-01' }]);
});

test('the daily slot uses the per-install jitter', () => {
  const day = Date.parse('2026-10-23T00:00:00Z');
  assert.equal(lastSlot(day + 5000, 1000), day + 1000);
  assert.equal(lastSlot(day + 500, 1000), day + 1000 - DAY_MS);
});

test('a scan maps containers to sites, upserts findings, keeps dismissals and resolves vanished ones', async () => {
  const calls = [], remote = async (server, req) => { calls.push([server.id, req]); return inventory(); };
  const now = Date.parse('2026-10-23T12:00:00Z');
  let running = tickRadar({ db, remote, now: () => now, log: () => {} });
  assert.ok(running); assert.equal(tickRadar({ db, remote, now: () => now, log: () => {} }), null, 'one server at a time');
  await running;
  assert.deepEqual(calls[0][1], { operation: 'inventory', probes: true });
  const open = db.prepare("SELECT * FROM radar_findings WHERE server_id=?").all(calls[0][0]);
  if (calls[0][0] === serverA) {
    assert.equal(open.length, 1); assert.equal(open[0].site_id, site); assert.equal(open[0].kind, 'vulnerable'); assert.equal(open[0].container_key, `${serverA}:compose:shop/web`);
  }
  await tickRadar({ db, remote, now: () => now + 1000, log: () => {} });
  assert.equal(tickRadar({ db, remote, now: () => now + 2000, log: () => {} }), null, 'each server once per daily slot');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM radar_scans WHERE status='completed'").get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM radar_inventory WHERE name='docknest-api'").get().n, 0, 'DockNest itself is not inventoried');
  const finding = db.prepare('SELECT * FROM radar_findings WHERE server_id=?').get(serverA);
  db.prepare("UPDATE radar_findings SET dismissed_at='x',dismissed_by=? WHERE id=?").run(users[0], finding.id);
  const scan = { id: id(), server_id: serverA };
  db.prepare("INSERT INTO radar_scans(id,server_id,reason,status,requested_at) VALUES(?,?,'manual','running','2026-10-23')").run(scan.id, serverA);
  recordScan(db, scan, inventory(), { now: now + 3000 });
  assert.equal(db.prepare('SELECT dismissed_at FROM radar_findings WHERE id=?').get(finding.id).dismissed_at, 'x', 'same finding keeps its dismissal');
  const fixed = { id: id(), server_id: serverA };
  db.prepare("INSERT INTO radar_scans(id,server_id,reason,status,requested_at) VALUES(?,?,'manual','running','2026-10-23')").run(fixed.id, serverA);
  recordScan(db, fixed, inventory('8.3.40'), { now: now + 4000 });
  const resolved = db.prepare('SELECT * FROM radar_findings WHERE id=?').get(finding.id);
  assert.ok(resolved.resolved_at, 'vanished finding is resolved, row kept as history');
  const back = { id: id(), server_id: serverA };
  db.prepare("INSERT INTO radar_scans(id,server_id,reason,status,requested_at) VALUES(?,?,'manual','running','2026-10-23')").run(back.id, serverA);
  recordScan(db, back, inventory('8.3.11'), { now: now + 5000 });
  const reopened = db.prepare('SELECT * FROM radar_findings WHERE id=?').get(finding.id);
  assert.equal(reopened.resolved_at, null); assert.equal(reopened.dismissed_at, null, 'a different version clears the dismissal'); assert.equal(reopened.first_seen_at, finding.first_seen_at);
});

test('busy servers are skipped, manual scans are rate limited and failures keep secrets out of logs', async () => {
  db.prepare('DELETE FROM radar_scans').run();
  const job = id(), now = Date.parse('2026-10-24T12:00:00Z');
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','running','running','2026-10-24')").run(job, site);
  requestScan(db, { serverIds: [serverA], reason: 'manual', now });
  assert.throws(() => requestScan(db, { serverIds: [serverB], reason: 'manual', now: now + 30000 }), /less than a minute/);
  const claimed = claimScan(db, now);
  assert.equal(claimed.server_id, serverB, 'the requested scan waits while server A runs a backup; B gets its daily scan');
  db.prepare("UPDATE radar_scans SET status='completed' WHERE id=?").run(claimed.id);
  assert.equal(claimScan(db, now), null);
  db.prepare('DELETE FROM jobs WHERE id=?').run(job);
  const logs = [];
  await tickRadar({ db, remote: async () => { throw new Error('ssh: password=hunter2'); }, now: () => now, log: message => logs.push(message) });
  const failed = db.prepare("SELECT * FROM radar_scans WHERE server_id=? AND reason='manual'").get(serverA);
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /Could not read the server inventory/);
  assert.ok(logs.every(line => !line.includes('hunter2')), 'remote error text never reaches the log');
});

test('API: operators view and request scans, admins dismiss and set preferences, all audited and uncached', async () => {
  db.prepare('DELETE FROM radar_scans').run();
  const summary = await request('/summary', { as: 1 });
  assert.equal(summary.status, 200); assert.equal(summary.headers.get('cache-control'), 'no-store');
  const body = await summary.json();
  assert.equal(body.sites.find(item => item.id === other).status, 'not_checked', 'never a false all-clear');
  assert.equal(body.feed.serial, 1);
  const findings = await (await request(`/findings?site=${site}&state=all`, { as: 1 })).json();
  assert.ok(findings.findings.length >= 1);
  const first = findings.findings[0];
  assert.match(first.headline, /Shop/); assert.match(first.advice, /will not change anything/);
  assert.equal((await request('/findings?state=bogus', { as: 1 })).status, 400);
  assert.equal((await request(`/findings/${first.id}/dismiss`, { as: 1, method: 'POST', body: {} })).status, 403);
  assert.equal((await request('/preferences', { as: 1, method: 'PUT', body: { containerProbes: false } })).status, 403);
  const scan = await request('/scan', { as: 1, method: 'POST', body: { serverId: serverA } });
  assert.equal(scan.status, 202);
  assert.equal((await request('/scan', { as: 1, method: 'POST', body: {} })).status, 429);
  assert.equal((await request(`/findings/${first.id}/dismiss`, { method: 'POST', body: { reason: 'Accepted until rebuild' } })).status, 200);
  const prefs = await request('/preferences', { method: 'PUT', body: { containerProbes: false } });
  assert.deepEqual((({ containerProbes, feedRefresh, notifyCritical }) => ({ containerProbes, feedRefresh, notifyCritical }))(await prefs.json()), { containerProbes: false, feedRefresh: null, notifyCritical: true });
  const actions = db.prepare("SELECT action FROM audit_events WHERE action LIKE 'radar.%' ORDER BY created_at").all().map(row => row.action);
  assert.deepEqual(actions.sort(), ['radar.finding_dismissed', 'radar.preferences_changed', 'radar.scan_requested']);
  db.prepare("UPDATE radar_scans SET status='completed' WHERE status='requested'").run();
  const calls = [];
  await tickRadar({ db, remote: async (_server, req) => { calls.push(req); return inventory(); }, now: () => Date.parse('2026-10-26T12:00:00Z'), log: () => {} });
  assert.equal(calls[0].probes, false, 'the admin switch turns docker exec probes off');
});
