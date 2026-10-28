// Vulnerability radar: worker scans, findings lifecycle, alerts and the /api/radar routes (docs/security.md
// "Vulnerability radar"). The helper is replaced by a synthetic inventory; the real helper runs only in the Linux suite.
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
const store = await import('../src/alerts/store.js'), detect = await import('../src/alerts/detect.js');
const { tickRadar, claimScan, requestScan, recordScan, componentsOf, imageTagVersion, lastSlot, resetRadarTick, DAY_MS } = radar;

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

const shop = (node = '20.11.0', extra = {}) => ({ id: 'a'.repeat(64), name: 'shop-web', image: 'node:20-alpine', imageCreated: '2024-01-01T00:00:00Z', running: true, own: false, labels: { composeProject: 'shop', composeService: 'web' }, runtime: node ? { php: null, node, os: null } : null, ...extra });
const inventory = (node = '20.11.0', more = []) => ({ helperVersion: 1, probes: true, truncated: false, containers: [shop(node), { id: 'b'.repeat(64), name: 'docknest-api', image: 'docknest:2.12.0', running: true, own: true, labels: {}, runtime: null }, ...more] });
const scanRow = (serverId, reason = 'manual') => { const scan = { id: id(), server_id: serverId }; db.prepare("INSERT INTO radar_scans(id,server_id,reason,status,requested_at) VALUES(?,?,?,'running','2026-10-23')").run(scan.id, serverId, reason); return scan; };
const findingsOf = (serverId, advisory = 'DN-2024-0001') => db.prepare('SELECT * FROM radar_findings WHERE server_id=? AND advisory_id=?').all(serverId, advisory);

test('components come from the runtime probe first, then the official image tag; digests and private registries give none', () => {
  assert.equal(imageTagVersion('php:8.3-apache', 'php'), '8.3');
  assert.equal(imageTagVersion('docker.io/library/node:22.11.0-alpine', 'node'), '22.11.0');
  assert.equal(imageTagVersion('acme/php:8.3', 'php'), null, 'only official images');
  assert.equal(imageTagVersion('registry.example.invalid:5000/php:8.3', 'php'), null, 'private registry: tag is not trusted');
  assert.equal(imageTagVersion('php@sha256:' + 'c'.repeat(64), 'php'), null, 'digest only: no tag');
  assert.equal(imageTagVersion('php:latest', 'php'), null);
  assert.deepEqual(componentsOf({ image: 'php:8.3-apache', runtime: { php: '8.3.10' } }), [{ product: 'php', version: '8.3.10', source: 'runtime' }]);
  assert.deepEqual(componentsOf({ image: 'node:20', imageCreated: '2026-01-01', runtime: null }), [{ product: 'node', version: '20', source: 'image-tag', imageCreated: '2026-01-01' }]);
  assert.deepEqual(componentsOf({ image: 'php@sha256:' + 'c'.repeat(64), repoTags: ['php:8.3.11-fpm'], runtime: null }), [{ product: 'php', version: '8.3.11', source: 'image-tag', imageCreated: null }], 'digest-only container: the image\'s own tag is used');
  assert.deepEqual(componentsOf({ image: 'registry.example.invalid/team/app:1', runtime: { php: '8.3.11', node: null } }), [{ product: 'php', version: '8.3.11', source: 'runtime' }], 'private registry: the runtime probe still works');
  assert.deepEqual(componentsOf({ image: 'busybox', runtime: { php: null, node: null, os: null } }), [], 'no shell, no php: nothing to match');
});

test('the daily slot uses the per-install jitter', () => {
  const day = Date.parse('2026-10-23T00:00:00Z');
  assert.equal(lastSlot(day + 5000, 1000), day + 1000);
  assert.equal(lastSlot(day + 500, 1000), day + 1000 - DAY_MS);
});

test('a scan maps containers to sites, upserts findings, keeps dismissals and resolves vanished ones', async () => {
  const calls = [], remote = async (server, req) => { calls.push([server.id, req]); return server.id === serverA ? inventory() : { helperVersion: 1, probes: true, truncated: false, containers: [] }; };
  const now = Date.parse('2026-10-23T12:00:00Z');
  resetRadarTick();
  const running = tickRadar({ db, remote, now: () => now, log: () => {} });
  assert.ok(running); assert.equal(tickRadar({ db, remote, now: () => now, log: () => {} }), null, 'one server at a time');
  await running;
  assert.deepEqual(calls[0][1], { operation: 'inventory', probes: true });
  resetRadarTick(); await tickRadar({ db, remote, now: () => now + 1000, log: () => {} });
  resetRadarTick(); assert.equal(tickRadar({ db, remote, now: () => now + 2000, log: () => {} }), null, 'each server once per daily slot');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM radar_scans WHERE status='completed'").get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM radar_findings WHERE server_id=?').get(serverB).n, 0, 'a server with no containers has no findings');
  const [finding] = findingsOf(serverA);
  assert.equal(finding.site_id, site); assert.equal(finding.kind, 'vulnerable'); assert.equal(finding.severity, 'high'); assert.equal(finding.container_key, `${serverA}:compose:shop/web`);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM radar_inventory WHERE name='docknest-api'").get().n, 0, 'DockNest itself is not inventoried');
  db.prepare("UPDATE radar_findings SET dismissed_at='x',dismissed_by=? WHERE id=?").run(users[0], finding.id);
  recordScan(db, scanRow(serverA), inventory(), { now: now + 3000 });
  assert.equal(db.prepare('SELECT dismissed_at FROM radar_findings WHERE id=?').get(finding.id).dismissed_at, 'x', 'same kind and version keep the dismissal');
  recordScan(db, scanRow(serverA), inventory('20.12.1'), { now: now + 4000 });
  const resolved = db.prepare('SELECT * FROM radar_findings WHERE id=?').get(finding.id);
  assert.ok(resolved.resolved_at, 'vanished finding is resolved, row kept as history');
  recordScan(db, scanRow(serverA), inventory('20.11.0'), { now: now + 4500 });
  assert.equal(db.prepare('SELECT dismissed_at FROM radar_findings WHERE id=?').get(finding.id).dismissed_at, 'x', 'it comes back as it was: same kind and version stay dismissed');
  recordScan(db, scanRow(serverA), inventory('20.10.0'), { now: now + 5000 });
  const reopened = db.prepare('SELECT * FROM radar_findings WHERE id=?').get(finding.id);
  assert.equal(reopened.resolved_at, null); assert.equal(reopened.dismissed_at, null, 'a different version clears the dismissal'); assert.equal(reopened.first_seen_at, finding.first_seen_at);
  db.prepare('DELETE FROM radar_findings').run();
});

test('a scan never downgrades what a better look found: stop/start, probes off and on, probe timeout, new image', () => {
  db.prepare('DELETE FROM radar_findings').run(); db.prepare("DELETE FROM audit_events WHERE action LIKE 'radar.%'").run();
  const now = Date.parse('2026-10-23T18:00:00Z'), image = 'sha256:' + '1'.repeat(64), withImage = (node, extra = {}) => ({ helperVersion: 1, probes: true, truncated: false, containers: [shop(node, { imageId: image, ...extra })] });
  const row = () => db.prepare("SELECT * FROM radar_findings WHERE server_id=? AND advisory_id='DN-2024-0001'").get(serverA);
  const alerts = action => db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE action=?').get(action).n;
  recordScan(db, scanRow(serverA), withImage('20.11.0'), { now });
  const first = row(); assert.equal(first.kind, 'vulnerable'); assert.equal(alerts('radar.finding_critical'), 1);
  db.prepare("UPDATE radar_findings SET dismissed_at='kept',dismissed_by=? WHERE id=?").run(users[0], first.id);
  const steps = [
    ['container stopped (not probed)', withImage(null, { running: false, state: 'exited' }), {}],
    ['probes switched off', { ...withImage(null), probes: false }, { probes: false }],
    ['probe timed out (no value)', withImage(null), {}],
    ['probe answered garbage', withImage('Segmentation fault <script>'), {}],
    ['container started again, probes on', withImage('20.11.0'), {}],
  ];
  for (const [index, [label, result, options]] of steps.entries()) {
    recordScan(db, scanRow(serverA), result, { now: now + (index + 1) * 1000, ...options });
    const current = row();
    assert.deepEqual([current.id, current.kind, current.version, current.source, current.resolved_at, current.dismissed_at], [first.id, 'vulnerable', '20.11.0', 'runtime', null, 'kept'], label);
    assert.equal(current.last_seen_at, new Date(now + (index + 1) * 1000).toISOString(), `${label}: seen`);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM radar_findings WHERE server_id=? AND kind='likely'").get(serverA).n, 0, `${label}: no floating-tag guess beside it`);
  }
  assert.equal(alerts('radar.finding_critical'), 1, 'no flapping alerts'); assert.equal(alerts('radar.finding_resolved'), 0);
  // A rebuilt container (new image) is judged afresh: its tag alone may not keep the old runtime finding open.
  recordScan(db, scanRow(serverA), { helperVersion: 1, probes: false, truncated: false, containers: [shop(null, { imageId: 'sha256:' + '2'.repeat(64), imageCreated: '2026-10-01T00:00:00Z' })] }, { now: now + 10000, probes: false });
  assert.ok(row().resolved_at, 'new image built after the advisory: the old finding resolves'); assert.equal(alerts('radar.finding_resolved'), 1);
  db.prepare('DELETE FROM radar_findings').run();
});

test('distribution builds, malformed answers and hostile names', () => {
  const now = Date.parse('2026-10-23T20:00:00Z');
  const php = (version, name = 'shop-web') => ({ helperVersion: 1, probes: true, truncated: false, containers: [{ ...shop(null), name, image: 'ubuntu:22.04', runtime: { php: version, node: null, os: null } }] });
  recordScan(db, scanRow(serverA), php('8.1.2-1ubuntu2.18'), { now });
  const distro = db.prepare("SELECT kind,severity,evidence FROM radar_findings WHERE server_id=? AND advisory_id='DN-2024-0002'").get(serverA);
  assert.deepEqual([distro.kind, distro.severity], ['likely', 'medium']); assert.match(distro.evidence, /distribution build; fixes may be backported/);
  assert.match(db.prepare("SELECT evidence FROM radar_findings WHERE server_id=? AND kind='eol'").get(serverA).evidence, /distribution build may still get fixes/);
  db.prepare('DELETE FROM radar_findings').run();
  const open = db.prepare('SELECT COUNT(*) AS n FROM radar_findings').get().n;
  const pending = scanRow(serverA);
  for (const bad of [null, {}, { containers: 'x' }, { containers: null }]) assert.throws(() => recordScan(db, pending, bad, { now: now + 1000 }), /no container list/);
  db.prepare("UPDATE radar_scans SET status='failed' WHERE id=?").run(pending.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM radar_findings').get().n, open, 'nothing resolved by a malformed answer');
  recordScan(db, scanRow(serverA), php('8.3.11', 'evil\u0000\u001b[31m\nname'), { now: now + 2000 });
  const stored = db.prepare('SELECT container_name FROM radar_findings WHERE server_id=? LIMIT 1').get(serverA).container_name;
  assert.doesNotMatch(stored, /[\u0000-\u001f]/);
  db.prepare('DELETE FROM radar_findings').run();
});

test('more than 500 containers: the capped inventory resolves nothing; garbage runtime output is ignored, not a crash', () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  recordScan(db, scanRow(serverA), inventory('20.11.0'), { now });
  const open = () => db.prepare('SELECT COUNT(*) AS n FROM radar_findings WHERE server_id=? AND resolved_at IS NULL').get(serverA).n;
  const before = open();
  const many = Array.from({ length: 500 }, (_, n) => ({ id: n.toString(16).padStart(64, '0'), name: `c${n}`, image: 'busybox', running: false, own: false, labels: {}, runtime: null }));
  const result = recordScan(db, scanRow(serverA), { helperVersion: 1, probes: true, truncated: true, containers: many }, { now: now + 1000 });
  assert.deepEqual(result, { containers: 500, findings: 0, carried: 0, truncated: true });
  assert.equal(open(), before, 'the shop finding is not resolved by an inventory that did not see every container');
  const weird = recordScan(db, scanRow(serverA), inventory('Segmentation fault <script>'), { now: now + 2000 });
  assert.ok(weird.carried >= 1, 'an unreadable probe keeps the earlier runtime findings');
  assert.ok(db.prepare("SELECT version FROM radar_findings WHERE server_id=? AND resolved_at IS NULL AND product='node'").all(serverA).every(row => row.version === '20.11.0'));
});

test('a site moved to another server between scans: findings follow the container and the old ones resolve', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  recordScan(db, scanRow(serverA), inventory('20.11.0'), { now });
  db.prepare('UPDATE sites SET server_id=? WHERE id=?').run(serverB, site);
  recordScan(db, scanRow(serverB), inventory('20.11.0'), { now: now + 1000 });
  recordScan(db, scanRow(serverA), { helperVersion: 1, probes: true, truncated: false, containers: [] }, { now: now + 2000 });
  const [onB] = findingsOf(serverB), onA = findingsOf(serverA);
  assert.equal(onB.site_id, site); assert.equal(onB.resolved_at, null);
  assert.ok(onA.every(row => row.resolved_at), 'old server findings resolved');
  db.prepare('UPDATE sites SET server_id=? WHERE id=?').run(serverA, site);
  db.prepare('DELETE FROM radar_findings').run();
});

test('alerts: radar.finding_critical once per finding, radar.finding_resolved once, names and product only, opt-in per line', () => {
  db.exec("DELETE FROM alert_outbox;DELETE FROM alert_lines;DELETE FROM alert_nodes;DELETE FROM connections;DELETE FROM settings WHERE key='alerts_cursor';DELETE FROM audit_events WHERE action LIKE 'radar.%'");
  const credential = store.createCredential({ kind: 'telegram', name: 'Bot', config: { token: '123456789:' + 'AbCdEf_-12'.repeat(4).slice(0, 35) } }, 'test');
  const channel = store.createChannel({ kind: 'telegram', name: 'Phone', credentialId: credential.id, config: { chatId: '-1001234567890' } }, 'test');
  const quiet = store.createChannel({ kind: 'telegram', name: 'Other', credentialId: credential.id, config: { chatId: '-1001234567891' } }, 'test');
  store.createRule({ channelId: channel.id, sourceKind: 'site', sourceId: site, events: ['radar.finding_critical', 'radar.finding_resolved'] }, 'test');
  store.createRule({ channelId: quiet.id, sourceKind: 'site', sourceId: site, events: ['backup.failed'] }, 'test');
  // A 2.11 cursor has no radar field: it starts now, so no history is replayed.
  const stamp = new Date(Date.now() - 1000).toISOString();
  db.prepare("INSERT INTO settings VALUES('alerts_cursor',?)").run(JSON.stringify({ jobs: stamp, moves: stamp, tests: stamp, testCleanups: stamp, copies: stamp }));
  assert.equal(detect.detectJobsAndMoves(), 0);
  const now = Date.parse('2026-10-26T12:00:00Z');
  recordScan(db, scanRow(serverA), inventory('20.11.0'), { now });
  recordScan(db, scanRow(serverA), inventory('20.11.0'), { now: now + 1000 });
  recordScan(db, scanRow(serverA), inventory('20.10.0'), { now: now + 2000 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='radar.finding_critical'").get().n, 1, 'one finding fires once, even when its version changes');
  recordScan(db, scanRow(serverA), inventory('20.12.1'), { now: now + 3000 });
  recordScan(db, scanRow(serverA), inventory('20.12.1'), { now: now + 4000 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='radar.finding_resolved'").get().n, 1);
  assert.equal(detect.detectJobsAndMoves(), 2); assert.equal(detect.detectJobsAndMoves(), 0, 'seen once');
  const rows = db.prepare("SELECT node_id,event,message,payload FROM alert_outbox WHERE event LIKE 'radar.%' ORDER BY created_at,event").all();
  assert.deepEqual(rows.map(row => row.event).sort(), ['radar.finding_critical', 'radar.finding_resolved']);
  assert.ok(rows.every(row => row.node_id === channel.id), 'only the line that opted in');
  const critical = rows.find(row => row.event === 'radar.finding_critical');
  assert.equal(critical.message, 'Security finding: Shop on alpha runs Node.js with a known serious flaw. Open DockNest to see what to do.');
  assert.deepEqual((({ title, site: s, server, reason }) => ({ title, site: s, server, reason }))(JSON.parse(critical.payload)), { title: 'Security finding', site: 'Shop', server: 'alpha', reason: 'A container runs a Node.js version with a known serious flaw. Open DockNest to see what to do.' });
  assert.doesNotMatch(JSON.stringify(rows), /20\.1[01]\.0|node:20|aaaaaaaa|host\.example|CVE-|DN-20/, 'no version, image, container id, host or advisory text');
  // Floating-tag and distribution-build guesses never alert.
  db.prepare('DELETE FROM audit_events').run(); db.prepare('DELETE FROM radar_findings').run();
  recordScan(db, scanRow(serverA), { ...inventory(null), probes: false }, { now: now + 5000, probes: false });
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM radar_findings WHERE kind='likely'").get().n >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='radar.finding_critical'").get().n, 0, 'likely (floating tag) never alerts');
  // The (created_at, id) cursor: 150 alert rows written in one millisecond are all delivered, across pages of 100.
  db.prepare('DELETE FROM audit_events').run(); db.exec('DELETE FROM alert_outbox');
  const at = new Date(Date.now() + 5000).toISOString(), finding = db.prepare('SELECT id FROM radar_findings LIMIT 1').get().id;
  const insert = db.prepare("INSERT INTO audit_events VALUES (?,'worker','radar.finding_critical',?,?,?)");
  for (let n = 0; n < 150; n += 1) insert.run(`burst-${String(n).padStart(3, '0')}`, finding, JSON.stringify({ product: 'node' }), at);
  assert.equal(detect.detectJobsAndMoves() + detect.detectJobsAndMoves() + detect.detectJobsAndMoves(), 150, 'no same-millisecond row is skipped');
  assert.equal(detect.detectJobsAndMoves(), 0);
  db.prepare('DELETE FROM radar_findings').run();
});

test('busy servers are skipped, manual scans are rate limited, an unreachable server keeps its findings and secrets stay out', async () => {
  db.prepare('DELETE FROM radar_scans').run();
  const job = id(), now = Date.parse('2026-10-27T12:00:00Z');
  recordScan(db, scanRow(serverA), inventory('20.11.0'), { now: now - 5000 });
  db.prepare('DELETE FROM radar_scans').run();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','running','running','2026-10-24')").run(job, site);
  requestScan(db, { serverIds: [serverA], reason: 'manual', now });
  assert.throws(() => requestScan(db, { serverIds: [serverB], reason: 'manual', now: now + 30000 }), /less than a minute/);
  const claimed = claimScan(db, now);
  assert.equal(claimed.server_id, serverB, 'the requested scan waits while server A runs a backup; B gets its daily scan');
  db.prepare("UPDATE radar_scans SET status='completed' WHERE id=?").run(claimed.id);
  assert.equal(claimScan(db, now), null);
  db.prepare('DELETE FROM jobs WHERE id=?').run(job);
  const logs = [], open = db.prepare('SELECT COUNT(*) AS n FROM radar_findings WHERE server_id=? AND resolved_at IS NULL').get(serverA).n;
  resetRadarTick();
  await tickRadar({ db, remote: async () => { throw new Error('ssh: connect ECONNREFUSED password=hunter2'); }, now: () => now, log: message => logs.push(message) });
  const failed = db.prepare("SELECT * FROM radar_scans WHERE server_id=? AND reason='manual'").get(serverA);
  assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'Could not read the server inventory. Check that the server is reachable, then scan again.');
  assert.ok(logs.every(line => !line.includes('hunter2')), 'remote error text never reaches the log');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM radar_findings WHERE server_id=? AND resolved_at IS NULL').get(serverA).n, open, 'a failed scan resolves nothing');
  resetRadarTick();
  assert.equal(tickRadar({ db, remote: async () => inventory(), now: () => now + 1000, log: () => {} }), null, 'between claims only a cheap read runs');
});

test('API: operators view and request scans, admins dismiss and set preferences, all audited and uncached', async () => {
  db.prepare('DELETE FROM radar_scans').run(); db.prepare('DELETE FROM audit_events').run();
  recordScan(db, scanRow(serverA), inventory('20.11.0'), { now: Date.parse('2026-10-28T10:00:00Z') });
  const summary = await request('/summary', { as: 1 });
  assert.equal(summary.status, 200); assert.equal(summary.headers.get('cache-control'), 'no-store');
  const body = await summary.json();
  assert.deepEqual(Object.keys(body), ['feed', 'preferences', 'open', 'totalOpen', 'dismissed', 'lastCheckedAt', 'servers', 'sites']);
  assert.equal(body.sites.find(item => item.id === other).status, 'not_checked', 'never a false all-clear');
  assert.equal(body.sites.find(item => item.id === site).status, 'high');
  assert.deepEqual(body.preferences, { containerProbes: true, changedBy: null, changedAt: null });
  assert.equal(body.feed.serial, 1);
  const findings = await (await request(`/findings?site=${site}&state=all`, { as: 1 })).json();
  const first = findings.findings.find(item => item.advisoryId === 'DN-2024-0001');
  assert.match(first.headline, /Shop/); assert.match(first.advice, /will not change anything/); assert.deepEqual(first.cve, ['CVE-2024-27983']);
  assert.equal((await request('/findings?state=bogus', { as: 1 })).status, 400);
  assert.equal((await request(`/findings/${first.id}/dismiss`, { as: 1, method: 'POST', body: {} })).status, 403);
  assert.equal((await request('/preferences', { as: 1, method: 'PUT', body: { containerProbes: false } })).status, 403);
  assert.equal((await request('/preferences', { method: 'PUT', body: { containerProbes: false, feedRefresh: true } })).status, 400, 'no feed refresh setting');
  assert.equal((await request('/preferences', { method: 'PUT', body: { notifyCritical: false } })).status, 400);
  const scan = await request('/scan', { as: 1, method: 'POST', body: { serverId: serverA } });
  assert.equal(scan.status, 202);
  assert.equal((await request('/scan', { as: 1, method: 'POST', body: {} })).status, 429);
  assert.equal((await request(`/findings/${first.id}/dismiss`, { method: 'POST', body: { reason: 'Accepted until rebuild' } })).status, 200);
  const prefs = await (await request('/preferences', { method: 'PUT', body: { containerProbes: false } })).json();
  assert.equal(prefs.containerProbes, false); assert.equal(prefs.changedBy, users[0]); assert.ok(prefs.changedAt);
  assert.deepEqual(Object.keys(prefs), ['containerProbes', 'changedBy', 'changedAt']);
  const actions = db.prepare("SELECT action,detail FROM audit_events WHERE action LIKE 'radar.%' AND action NOT LIKE 'radar.finding_c%' ORDER BY created_at").all();
  assert.deepEqual(actions.map(row => row.action).sort(), ['radar.finding_dismissed', 'radar.preferences_changed', 'radar.scan_requested']);
  assert.deepEqual(JSON.parse(actions.find(row => row.action === 'radar.preferences_changed').detail), { containerProbes: false, previous: true });
  db.prepare("UPDATE radar_scans SET status='completed' WHERE status='requested'").run();
  const calls = [];
  resetRadarTick();
  await tickRadar({ db, remote: async (_server, req) => { calls.push(req); return inventory(); }, now: () => Date.parse('2026-10-29T12:00:00Z'), log: () => {} });
  assert.deepEqual(calls[0], { operation: 'inventory', probes: false }, 'the admin switch: the helper is not asked to probe');
});
