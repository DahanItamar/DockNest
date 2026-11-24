// Client reports (docs/client-reports.md): migration 27 and its upgrade path, period maths, the report numbers, the PDF
// privacy guard (decision 4: a fixture full of hosts, addresses, users, paths and secrets, none of which may appear in
// the PDF text), the API (roles, sealed and masked recipients, re-verification), the MIME attachment builder, and the
// schedule with retries and the report.failed alert. All data is fake (example.com, documentation addresses).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readText } from './pdf-text.js';

const root = await mkdtemp(join(tmpdir(), 'docknest-client-reports-'));
Object.assign(process.env, { DATA_DIR: root, MASTER_KEY_FILE: join(root, 'master.key'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured', SECURE_COOKIES: 'false', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js');
const { db, id } = await import('../src/db.js');
const { digest, seal } = await import('../src/crypto.js');
const { migrations, migrate, schemaVersion, compatFloor } = await import('../src/migrations.js');
const period = await import('../src/reports/period.js');
const { buildReport, reportPdf } = await import('../src/reports/client.js');
const { buildMessage, smtpLimits, smtpIo, smtpPolicy, sendMail } = await import('../src/alerts/smtp.js');
const send = await import('../src/reports/send.js');
const { openRecipients, digest: auditDigest } = await import('../src/reports/store.js');
const { createHash } = await import('node:crypto');

const now = () => new Date().toISOString();
const NOV = { from: '2026-11-01', to: '2026-11-30' };

test('migration 27 is additive and compatible: a 2.16 database upgrades in place and keeps its rows', () => {
  assert.ok(schemaVersion >= 27);
  const m27 = migrations.find(item => item.version === 27); assert.deepEqual(m27, { version: 27, name: 'client-reports', compatible: true, up: m27.up });
  assert.equal(compatFloor(migrations, 27), compatFloor(migrations, 26), 'compat floor is unchanged, so 2.16 code keeps running on a v27 database');
  const old = new DatabaseSync(':memory:');
  old.exec('PRAGMA foreign_keys=ON');
  migrate(old, { file: join(root, 'old.sqlite'), list: migrations.filter(item => item.version <= 26), now: () => new Date('2026-11-01T00:00:00Z'), log: () => {} });
  old.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('s','fixture','host.example.invalid',22,'root','sealed','SHA256:x','2026-01-01')").run();
  old.prepare("INSERT INTO sites VALUES('a','s','App','{}','2026-01-01')").run();
  migrate(old, { file: join(root, 'old.sqlite'), list: migrations.filter(item => item.version <= 27), now: () => new Date('2026-11-02T00:00:00Z'), log: () => {} });
  assert.equal(old.prepare('PRAGMA user_version').get().user_version, 27);
  assert.equal(old.prepare('SELECT COUNT(*) AS n FROM sites').get().n, 1);
  for (const table of ['clients', 'client_apps', 'client_reports']) assert.equal(old.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE name=?').get(table).n, 1, table);
  old.prepare("INSERT INTO clients(id,name,created_at,updated_at) VALUES('c','Client','x','x')").run();
  old.prepare("INSERT INTO client_apps VALUES('c','a')").run();
  old.prepare("DELETE FROM sites WHERE id='a'").run();
  assert.equal(old.prepare('SELECT COUNT(*) AS n FROM client_apps').get().n, 0, 'a deleted app drops out of its clients');
  assert.throws(() => old.prepare("INSERT INTO clients(id,name,created_at,updated_at) VALUES('d','','x','x')").run(), /CHECK/);
});

test('periods: previous month and the 08:00 day-1 schedule follow the client time zone; custom ranges are bounded', () => {
  assert.deepEqual(period.previousMonth(Date.parse('2026-01-15T10:00:00Z'), 'UTC'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(period.previousMonth(Date.parse('2026-03-01T09:00:00Z'), 'America/Los_Angeles'), { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(period.nextDueAt(Date.parse('2026-11-14T00:00:00Z'), 'UTC'), '2026-12-01T08:00:00.000Z');
  assert.equal(period.nextDueAt(Date.parse('2026-12-01T07:59:00Z'), 'UTC'), '2026-12-01T08:00:00.000Z');
  assert.equal(period.nextDueAt(Date.parse('2026-12-01T08:00:00Z'), 'UTC'), '2027-01-01T08:00:00.000Z');
  assert.equal(period.nextDueAt(Date.parse('2026-11-14T00:00:00Z'), 'Asia/Jerusalem'), '2026-12-01T06:00:00.000Z');
  assert.equal(period.nextDueAt(Date.parse('2026-06-14T00:00:00Z'), 'Asia/Jerusalem'), '2026-07-01T05:00:00.000Z', 'summer time');
  assert.equal(period.resolvePeriod('2026-11-01', '2026-11-30', { now: Date.parse('2026-12-01T00:00:00Z') }).label, 'November 2026');
  assert.equal(period.resolvePeriod('2026-11-03', '2026-11-20', { now: Date.parse('2026-12-01T00:00:00Z') }).label, '3 Nov 2026 to 20 Nov 2026');
  const at = Date.parse('2026-12-31T00:00:00Z');
  assert.throws(() => period.resolvePeriod('2026-01-01', '2026-04-03', { now: at }), /at most 92/);
  assert.ok(period.resolvePeriod('2026-01-01', '2026-04-02', { now: at }));
  assert.throws(() => period.resolvePeriod('2026-11-10', '2026-11-09', { now: at }), /before/);
  assert.throws(() => period.resolvePeriod('2027-02-01', '2027-02-10', { now: at }), /future/);
  assert.throws(() => period.resolvePeriod('2026-02-30', '2026-03-01', { now: at }), /Choose/);
});

// ---- A fixture full of things that must never reach a client ------------------------------------------------------------
const HOST = 'ops-box-7.internal.example.net', ADDRESS = '203.0.113.77', SSH_USER = 'deploy-root-user', STORE_HOST = 'vault.storage.example.org', BUCKET = 'private-bucket-name-91', STORE_PATH = '/srv/secret-backups/client-a', CONTAINER = 'shop-db-container-7f3', ENV_SECRET = 'S3cr3t-Env-Value-4411', KEY_TEXT = 'AAAAB3NzaC1yc2EAAAADAQABAAABgQ-fake-key', OWNER_EMAIL = 'owner.person@example.com', RECIPIENT = 'client.contact@example.com';
const server = id();
db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,status,created_at) VALUES(?,?,?,24681,?,?,?,'connected',?)").run(server, 'Rack One', HOST, SSH_USER, seal(KEY_TEXT), 'ab'.repeat(32), now());
const storageSftp = id(), storageS3 = id();
db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(storageSftp, 'Off-site box', STORE_HOST, 22, SSH_USER, 'ab'.repeat(32), 'password', seal(ENV_SECRET), STORE_PATH, 0, 'connected', now(), null);
db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(storageS3, 'Cloud copies', 'https://s3.example.org', 443, 'key-id', 'ab'.repeat(32), 's3-access-key', seal(ENV_SECRET), STORE_PATH, 0, 'connected', now(), null);
let added = Date.parse('2026-10-01T00:00:00Z');
const site = (name, config = {}) => { const siteId = id(); db.prepare('INSERT INTO sites(id,server_id,name,config,created_at) VALUES(?,?,?,?,?)').run(siteId, server, name, JSON.stringify({ kind: 'docker', containers: [CONTAINER], composeFiles: [`${STORE_PATH}/compose.yaml`], env: { SECRET: ENV_SECRET }, ...config }), new Date(added++).toISOString()); return siteId; };
const shop = site('Client Shop'), blog = site('בלוג הלקוח'), idle = site('Idle App'), other = site('Other Client App');
const job = (siteId, status, at, type = 'backup') => { const jobId = id(); db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,finished_at,error) VALUES(?,?,?,?,?,?,?,?)").run(jobId, siteId, type, status, status, at, at, status === 'failed' ? `ssh ${SSH_USER}@${ADDRESS} failed ${STORE_PATH}` : null); return jobId; };
const kept = (siteId, jobId, at, size) => { const backupId = id(); db.prepare('INSERT INTO backups(id,site_id,job_id,captured_at,path,size,checksum,manifest,pinned,verified,created_at) VALUES(?,?,?,?,?,?,?,?,0,1,?)').run(backupId, siteId, jobId, at, `sftp:${storageSftp}:${STORE_PATH}/b.tar.gz.enc`, size, 'c'.repeat(64), '{}', at); return backupId; };
// Shop: 3 good backups in November, one failed, one earlier backup pruned by retention (job kept, backup gone).
const shopJobs = ['2026-11-03T03:00:00Z', '2026-11-10T03:00:00Z', '2026-11-24T03:00:00Z'].map(at => job(shop, 'completed', at));
job(shop, 'failed', '2026-11-17T03:00:00Z'); job(shop, 'completed', '2026-10-30T03:00:00Z');
const shopBackup = kept(shop, shopJobs[2], '2026-11-24T03:00:00Z', 5 * 1024 * 1024);
db.prepare("INSERT INTO backup_copies(backup_id,target_id,path,status,created_at,updated_at,verified_at) VALUES(?,?,?, 'verified',?,?,?)").run(shopBackup, storageSftp, `${STORE_PATH}/x`, now(), now(), now());
db.prepare("INSERT INTO backup_copies(backup_id,target_id,path,status,created_at,updated_at) VALUES(?,?,?, 'failed',?,?)").run(shopBackup, storageS3, `${STORE_PATH}/y`, now(), now());
db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?)").run(id(), 'scheduler', 'backup.missed', shop, '{}', '2026-11-20T03:00:00Z');
// Blog (Hebrew name): two good backups.
job(blog, 'completed', '2026-11-05T03:00:00Z'); job(blog, 'completed', '2026-11-12T03:00:00Z');
// Idle app: no backup in the period at all.
const testRow = (siteId, result, finished, seconds) => { const testId = id(); db.prepare("INSERT INTO restore_tests(id,site_id,backup_captured_at,server_id,trigger,result,restore_seconds,limits,created_by,created_at,finished_at,cleanup) VALUES(?,?,?,?,'manual',?,?,'{}','owner',?,?,'done')").run(testId, siteId, finished, server, result, seconds, finished, finished); if (seconds) db.prepare("INSERT INTO restore_test_steps(test_id,step,state,started_at,finished_at) VALUES(?,'restore_copy','done',?,?)").run(testId, '2026-11-20T03:48:00Z', new Date(Date.parse('2026-11-20T03:48:00Z') + seconds * 1000).toISOString()); };
testRow(shop, 'passed', '2026-11-20T04:00:00Z', 720); testRow(blog, 'failed', '2026-11-21T04:00:00Z', null);
db.prepare('INSERT INTO site_certificates(site_id,source,name,serial,not_after,expired,renewal,checked_at) VALUES(?,?,?,?,?,0,?,?)').run(shop, 'tls', HOST, 'AB12', '2027-02-01T00:00:00Z', 'ok', now());
db.prepare('INSERT INTO domain_checks(domain,server_id,site_id,hops,checked_at,trigger) VALUES(?,?,?,?,?,?)').run('shop.example.com', server, shop, JSON.stringify({ dns: { state: 'ok', reason: 'ok', params: { address: ADDRESS } }, proxy: { state: 'ok' }, app: { state: 'ok' }, certificate: { state: 'ok' } }), now(), 'manual');
db.prepare('INSERT INTO site_hardening(site_id,checked_at,facts) VALUES(?,?,?)').run(shop, now(), JSON.stringify([{ format: 1, name: CONTAINER, image: 'nginx:1.27', privileged: true, dockerSocket: false, rootUser: true, hostNetwork: false, publishAll: false, memoryLimit: false, healthcheck: false, noNewPrivileges: false, rootless: null, imagePin: 'tag', publicPorts: [], extraCapabilities: [] }]));
const client = id();
db.prepare("INSERT INTO clients(id,name,agency,contact,include,timezone,created_at,updated_at) VALUES(?,?,?,?,'{}','UTC',?,?)").run(client, 'Example Client Ltd', 'Studio Example', 'https://studio.example.com', now(), now());
for (const siteId of [shop, blog, idle]) db.prepare('INSERT INTO client_apps VALUES(?,?)').run(client, siteId);
const row = () => db.prepare('SELECT * FROM clients WHERE id=?').get(client);
const NOV_PERIOD = () => period.resolvePeriod(NOV.from, NOV.to, { now: Date.parse('2026-12-02T00:00:00Z') });
const FORBIDDEN = [HOST, 'internal.example.net', ADDRESS, SSH_USER, STORE_HOST, 'storage.example.org', BUCKET, STORE_PATH, 'secret-backups', CONTAINER, ENV_SECRET, KEY_TEXT, OWNER_EMAIL, RECIPIENT, 'Rack One', 'Off-site box', 'Cloud copies', 's3.example.org', '24681', 'nginx:1.27', 'privileged', 'Privileged mode'];

test('report numbers come from jobs (pruned backups still counted), per app and in the period', () => {
  const report = buildReport(row(), NOV_PERIOD(), Date.parse('2026-12-02T00:00:00Z'));
  assert.equal(report.apps.length, 3);
  const byName = Object.fromEntries(report.apps.map(app => [app.name, app]));
  assert.deepEqual(byName['Client Shop'].backups, { taken: 3, due: 5, failed: 1, missed: 1, newest: '2026-11-24T03:00:00Z', keptCount: 1, keptSize: '5.0 MB' });
  assert.deepEqual(byName['Client Shop'].copies, { verified: 1, failed: 1, kinds: ['S3-compatible storage', 'SFTP server'] });
  assert.equal(byName['Client Shop'].state, 'Needs attention');
  assert.equal(byName['Client Shop'].recovery, 'Back in about 12 min, proven 11 days ago');
  assert.equal(byName['Client Shop'].hardening.grade, 'F');
  assert.equal(byName['Client Shop'].hardening.titles, undefined, 'finding titles are off by default');
  assert.equal(byName['Client Shop'].server, undefined, 'server names are off by default');
  assert.deepEqual(byName['Client Shop'].domains, [{ name: 'shop.example.com', pointsHere: true, httpsOk: true, state: 'ok' }]);
  assert.equal(byName['Idle App'].state, 'Not protected');
  assert.equal(byName['בלוג הלקוח'].state, 'Needs attention', 'a failed restore test needs attention');
  assert.deepEqual(report.summary, { good: 0, attention: 2, unprotected: 1 });
  assert.equal(report.apps.some(app => app.name === 'Other Client App'), false, 'an app of another client is not included');
});

test('privacy: no host, address, user, path, bucket, container, secret, key or owner address in the PDF (decision 4)', () => {
  const report = buildReport(row(), NOV_PERIOD(), Date.parse('2026-12-02T00:00:00Z'));
  const pdf = reportPdf(report), body = readText(pdf), json = JSON.stringify(report);
  assert.ok(pdf.subarray(0, 5).toString() === '%PDF-' && body.includes('Example Client Ltd') && body.includes('Prepared by Studio Example') && body.includes('Made with DockNest') && body.includes('Client Shop'));
  assert.ok(body.includes('Back in about 12 min'), 'the recovery sentence is in the PDF');
  for (const secret of FORBIDDEN) { assert.equal(body.includes(secret), false, `PDF text must not hold ${secret}`); assert.equal(json.includes(secret), false, `preview JSON must not hold ${secret}`); assert.equal(pdf.includes(Buffer.from(secret)), false, `PDF bytes must not hold ${secret}`); }
  assert.equal(/\/JS|\/JavaScript|\/OpenAction|\/EmbeddedFile/.test(pdf.toString('latin1')), false, 'no scripts, actions or embedded files');
  assert.ok(body.includes('בלוג הלקוח') || body.includes('הלקוח'), 'Hebrew app names render');
  assert.equal(JSON.stringify(report.apps.map(app => app.copies.kinds)).includes('Off-site'), false, 'storage is named by provider kind only');
});

test('privacy: the two opt-in ticks add exactly server names and finding titles, nothing else', () => {
  db.prepare("UPDATE clients SET include=? WHERE id=?").run(JSON.stringify({ serverNames: true, findingTitles: true }), client);
  const report = buildReport(row(), NOV_PERIOD(), Date.parse('2026-12-02T00:00:00Z')), body = readText(reportPdf(report));
  assert.ok(body.includes('Rack One'), 'server name appears when ticked');
  assert.ok(report.apps.find(app => app.name === 'Client Shop').hardening.titles.length > 0);
  for (const secret of FORBIDDEN.filter(item => item !== 'Rack One' && item !== 'Privileged mode')) assert.equal(body.includes(secret), false, `still not ${secret}`);
  db.prepare("UPDATE clients SET include='{}' WHERE id=?").run(client);
});

test('names that try to break out are plain text: bidi overrides and control characters are dropped, long names are cut', () => {
  const tricky = id();
  db.prepare("INSERT INTO clients(id,name,created_at,updated_at) VALUES(?,?,?,?)").run(tricky, 'Evil‮\u0007 Name\r\nBcc: x@example.com', now(), now());
  const report = buildReport(db.prepare('SELECT * FROM clients WHERE id=?').get(tricky), NOV_PERIOD());
  assert.equal(report.client, 'Evil Name Bcc: x@example.com');
  assert.deepEqual(report.apps, []);
  assert.ok(readText(reportPdf(report)).includes('No apps are included'));
});

test('MIME: one fixed text part and one base64 PDF attachment; no header injection; file name is plain ASCII', () => {
  const data = Buffer.alloc(5000, 7);
  const message = buildMessage({ from: 'a@example.com', to: ['b@example.com'], subject: 'Backup report: Evil\r\nBcc: x@example.com, May 2026', text: 'Hello', id: 'x1', attachment: { filename: '../evil"\r\nname.pdf', type: 'application/pdf', data } });
  const [head, ...rest] = message.split('\r\n\r\n'), headers = head.split('\r\n');
  assert.ok(headers.some(line => /^Content-Type: multipart\/mixed; boundary="docknest-[0-9a-f]{36}"$/.test(line)));
  assert.equal(headers.some(line => line.startsWith('Bcc:')), false);
  assert.equal(headers.filter(line => line.startsWith('Content-Transfer-Encoding')).length, 0);
  const boundary = /boundary="([^"]+)"/.exec(head)[1], parts = message.split(`--${boundary}`);
  assert.equal(parts.length, 4); assert.ok(parts[3].startsWith('--'));
  assert.ok(/Content-Disposition: attachment; filename="[A-Za-z0-9._-]+"/.test(parts[2]) && !/evil"/.test(parts[2].split('\r\n\r\n')[0]));
  const lines = parts[2].split('\r\n\r\n')[1].split('\r\n').filter(Boolean);
  assert.ok(lines.every(line => line.length <= 76), 'base64 lines are at most 76 characters');
  assert.deepEqual(Buffer.from(lines.join(''), 'base64'), data);
  assert.equal(buildMessage({ from: 'a@example.com', to: ['b@example.com'], subject: 's', text: 'Hello', id: 'x2' }).includes('multipart'), false, 'the text-only path is unchanged');
  assert.equal(smtpLimits.attachmentBytes, 8 * 1024 * 1024);
});

// ---- API ----------------------------------------------------------------------------------------------------------------
const [administrator, viewer, stale] = [id(), id(), id()], csrf = 'fixture-csrf', tokens = [0, 1, 2].map(() => randomBytes(32).toString('base64url'));
for (const [index, [user, role]] of [[administrator, 'admin'], [viewer, 'viewer'], [stale, 'admin']].entries()) {
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(user, `user${index}@example.com`, 'fixture', seal('JBSWY3DPEHPK3PXP'), '[]', now(), `User ${index}`, role);
  const verified = index === 2 ? Date.now() - 3600_000 : Date.now();
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(tokens[index]), user, csrf, Date.now() + 3600_000, Date.now(), verified, verified);
}
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
test.after(() => listener.close());
const call = (method, route, { index = 0, body } = {}) => fetch(`http://127.0.0.1:${listener.address().port}/api${route}`, { method, headers: { Cookie: 'dbm_session=' + tokens[index], Origin: process.env.APP_ORIGIN, 'x-csrf-token': csrf, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const emailConnection = id();
db.prepare("INSERT INTO connections(id,provider,name,secret,settings,created_at,updated_at) VALUES(?,'email','Reports mail',?,?,?,?)").run(emailConnection, seal(JSON.stringify({ host: 'smtp.example.com', port: 587, security: 'starttls', username: 'mailer', password: 'mail-pass-fake', from: 'reports@example.com' })), JSON.stringify({ to: ['alerts@example.com'] }), now(), now());

test('API: administrators create clients; recipients need re-verification, are sealed at rest and masked in every response', async () => {
  const body = { name: 'API Client', agency: 'Studio Example', apps: [shop, other], include: { serverNames: true } };
  assert.equal((await call('POST', '/clients', { index: 1, body })).status, 403, 'a viewer cannot create');
  const created = await call('POST', '/clients', { body });
  assert.equal(created.status, 201); const made = await created.json();
  assert.deepEqual([made.name, made.apps.length, made.include, made.recipients, made.schedule.enabled], ['API Client', 2, { serverNames: true, findingTitles: false }, [], false]);
  const url = `/clients/${made.id}`;
  assert.equal((await call('PUT', url, { index: 2, body: { recipients: [RECIPIENT] } })).status, 403, 'a stale session cannot change recipients');
  assert.equal((await (await call('PUT', url, { index: 2, body: { recipients: [RECIPIENT] } })).json()).code, 'REAUTH_REQUIRED');
  assert.equal((await call('PUT', url, { body: { recipients: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'] } })).status, 400, 'at most 3');
  assert.equal((await call('PUT', url, { body: { recipients: ['not an address'] } })).status, 400);
  assert.equal((await call('PUT', url, { body: { scheduleEnabled: true } })).status, 400, 'a schedule needs a Connection and a recipient');
  const set = await call('PUT', url, { body: { recipients: [RECIPIENT, RECIPIENT.toUpperCase(), 'second.person@example.com'], connectionId: emailConnection, scheduleEnabled: true, timezone: 'Asia/Jerusalem' } });
  assert.equal(set.status, 200); const view = await set.json();
  assert.deepEqual(view.recipients, ['c***@example.com', 's***@example.com']);
  assert.equal(view.schedule.enabled, true); assert.match(view.schedule.nextDueAt, /T0[5-6]:00:00\.000Z$/);
  const stored = db.prepare('SELECT recipients FROM clients WHERE id=?').get(made.id).recipients;
  assert.equal(stored.includes('example.com'), false, 'sealed at rest'); assert.deepEqual(openRecipients(db.prepare('SELECT * FROM clients WHERE id=?').get(made.id)), [RECIPIENT, 'second.person@example.com']);
  for (const response of [await call('GET', url), await call('GET', '/clients')]) assert.equal((await response.text()).includes('client.contact'), false, 'never the full address');
  const audit = db.prepare("SELECT detail FROM audit_events WHERE action='client.update' AND target=?").all(made.id).map(item => item.detail).join();
  assert.equal(audit.includes('example.com'), false, 'audit holds hashes only'); assert.match(audit, /"recipients":\["[0-9a-f]{16}","[0-9a-f]{16}"\]/);
  const asViewer = await (await call('GET', url, { index: 1 })).json();
  assert.equal(asViewer.recipients, undefined); assert.equal(asViewer.schedule, undefined); assert.equal(asViewer.name, 'API Client');
  assert.equal((await call('PUT', url, { index: 1, body: { name: 'x' } })).status, 403);
  assert.equal((await call('PUT', url, { body: { connectionId: id() } })).status, 400, 'a Connection that does not exist is refused');
  assert.equal((await call('PUT', url, { body: { apps: [id()] } })).status, 400);
  assert.equal((await call('PUT', url, { body: { name: 'Renamed', recipients: [] , scheduleEnabled: false} })).status, 200);
  assert.deepEqual((await (await call('GET', url)).json()).recipients, []);
  assert.equal((await call('DELETE', url)).status, 200); assert.equal((await call('GET', url)).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client_apps WHERE client_id=?').get(made.id).n, 0);
});

test('API: preview JSON and PDF download for any signed-in role, no-store, audited, recorded without the content', async () => {
  const preview = await call('GET', `/clients/${client}/report?from=${NOV.from}&to=${NOV.to}`, { index: 1 });
  assert.equal(preview.status, 200); assert.equal(preview.headers.get('cache-control'), 'no-store');
  assert.equal((await preview.json()).period.label, 'November 2026');
  assert.equal((await call('GET', `/clients/${client}/report?from=2026-01-01&to=2026-12-31`)).status, 400, 'over 92 days');
  const download = await call('POST', `/clients/${client}/report.pdf`, { index: 1, body: NOV });
  assert.equal(download.status, 200); assert.equal(download.headers.get('cache-control'), 'no-store'); assert.match(download.headers.get('content-type'), /application\/pdf/); assert.match(download.headers.get('content-disposition'), /docknest-report-2026-11\.pdf/);
  const bytes = Buffer.from(await download.arrayBuffer()), text = readText(bytes);
  for (const secret of FORBIDDEN) assert.equal(text.includes(secret), false, secret);
  const recorded = db.prepare("SELECT status,trigger,size,sha256 FROM client_reports WHERE client_id=? AND trigger='manual' ORDER BY created_at DESC LIMIT 1").get(client);
  assert.deepEqual([recorded.status, recorded.size, recorded.sha256], ['made', bytes.length, send.sha256(bytes)]);
  assert.match(db.prepare("SELECT detail FROM audit_events WHERE action='client.report' AND target=?").get(client).detail, /"from":"2026-11-01"/);
  assert.equal((await call('POST', `/clients/${id()}/report.pdf`, { body: NOV })).status, 404);
});

// ---- Schedule, retries, alert --------------------------------------------------------------------------------------------
test('schedule: a due client gets last month queued once; failures retry after 1, 2 and 3 hours, then report.failed fires once', async () => {
  const scheduled = id();
  db.prepare("INSERT INTO clients(id,name,include,schedule_enabled,timezone,connection_id,recipients,next_due_at,created_at,updated_at) VALUES(?,?,'{}',1,'UTC',?,?,?,?,?)").run(scheduled, 'Scheduled Client', emailConnection, JSON.stringify({ sealed: seal(JSON.stringify([RECIPIENT])) }), '2026-12-01T08:00:00.000Z', now(), now());
  db.prepare('INSERT INTO client_apps VALUES(?,?)').run(scheduled, shop);
  // An alert rule so report.failed has somewhere to go.
  const node = id(); db.prepare("INSERT INTO alert_nodes(id,provider,name,connection_id,created_at,updated_at) VALUES(?,'email','Mail',?,?,?)").run(node, emailConnection, now(), now());
  db.prepare("INSERT INTO alert_lines(id,node_id,source_kind,source_id,events,enabled,created_at,updated_at) VALUES(?,?,'docknest',NULL,?,1,?,?)").run(id(), node, JSON.stringify(['report.failed']), now(), now());
  const outbox = () => db.prepare("SELECT COUNT(*) AS n FROM alert_outbox WHERE event='report.failed'").get().n;
  const connects = []; const original = { connect: smtpIo.connect, resolve: smtpIo.resolve }; smtpIo.resolve = async () => '127.0.0.1'; smtpPolicy.allowLoopback = true; smtpIo.connect = async () => { connects.push(1); throw new Error('refused by test'); };
  try {
    const t0 = Date.parse('2026-12-01T08:05:00Z');
    assert.equal(send.queueDueReports(Date.parse('2026-12-01T07:00:00Z')), 0, 'not due yet');
    assert.equal(send.queueDueReports(t0), 1);
    assert.equal(send.queueDueReports(t0), 0, 'once per period');
    assert.equal(db.prepare('SELECT next_due_at FROM clients WHERE id=?').get(scheduled).next_due_at, '2027-01-01T08:00:00.000Z');
    const queued = () => db.prepare("SELECT * FROM client_reports WHERE client_id=?").get(scheduled);
    assert.deepEqual([queued().period_start, queued().period_end, queued().status], ['2026-11-01', '2026-11-30', 'sending']);
    for (const [index, hours] of [1, 2, 3].entries()) {
      const at = Date.parse(queued().next_attempt_at); assert.equal(await send.attempt(queued(), { now: at }), 'retry');
      assert.equal(queued().attempts, index + 1); assert.equal(Date.parse(queued().next_attempt_at) - at, hours * 3600_000);
      assert.equal(outbox(), 0, 'no alert while retries remain');
    }
    assert.equal(await send.attempt(queued(), { now: Date.parse(queued().next_attempt_at) }), 'failed');
    assert.equal(queued().status, 'failed'); assert.equal(queued().next_attempt_at, null); assert.equal(queued().attempts, 4);
    assert.equal(queued().error.includes('example.com'), false); assert.equal(queued().error.includes('mail-pass'), false);
    assert.equal(outbox(), 1, 'one report.failed alert'); assert.equal(connects.length, 4);
    assert.equal(send.queueDueReports(t0 + 1000), 0);
    const alert = db.prepare("SELECT message FROM alert_outbox WHERE event='report.failed'").get().message;
    assert.match(alert, /Scheduled Client/); assert.equal(alert.includes('example.com'), false);
  } finally { Object.assign(smtpIo, original); smtpPolicy.allowLoopback = false; }
});

test('audit digest is keyed (HMAC under a master-key-derived key), stable and not a plain SHA-256', () => {
  const a = auditDigest('Person@Example.com');
  assert.match(a, /^[0-9a-f]{16}$/); assert.equal(a, auditDigest('person@example.com'));
  assert.notEqual(a, createHash('sha256').update('person@example.com').digest('hex').slice(0, 16));
});

test('a queued scheduled report is not sent once the schedule is off', async () => {
  const off = id(); db.prepare("INSERT INTO clients(id,name,include,schedule_enabled,timezone,connection_id,recipients,created_at,updated_at) VALUES(?,?,'{}',0,'UTC',?,?,?,?)").run(off, 'Off Client', emailConnection, JSON.stringify({ sealed: seal(JSON.stringify([RECIPIENT])) }), now(), now());
  const rowId = id(); db.prepare("INSERT INTO client_reports(id,client_id,period_start,period_end,trigger,status,attempts,next_attempt_at,created_at) VALUES(?,?,?,?,'schedule','sending',1,?,?)").run(rowId, off, NOV.from, NOV.to, now(), '2026-12-01T00:00:00Z');
  assert.equal(await send.attempt(db.prepare('SELECT * FROM client_reports WHERE id=?').get(rowId)), 'failed');
  assert.equal(db.prepare('SELECT error FROM client_reports WHERE id=?').get(rowId).error, 'The schedule was turned off.');
});

test('schedule: no Connection or recipient fails at once with a fixed sentence; an oversize PDF is refused with the documented text', async () => {
  const bare = id();
  db.prepare("INSERT INTO clients(id,name,include,schedule_enabled,timezone,created_at,updated_at) VALUES(?,?,'{}',1,'UTC',?,?)").run(bare, 'Bare Client', now(), now());
  const rowId = id();
  db.prepare("INSERT INTO client_reports(id,client_id,period_start,period_end,trigger,status,attempts,next_attempt_at,created_at) VALUES(?,?,?,?,'schedule','sending',0,?,?)").run(rowId, bare, NOV.from, NOV.to, now(), '2026-12-01T00:00:00Z');
  assert.equal(await send.attempt(db.prepare('SELECT * FROM client_reports WHERE id=?').get(rowId)), 'failed');
  assert.match(db.prepare('SELECT error FROM client_reports WHERE id=?').get(rowId).error, /No email Connection or recipient/);
  await assert.rejects(sendMail({ host: 'smtp.example.com', port: 587, security: 'starttls', from: 'a@example.com', to: ['b@example.com'] }, { subject: 's', text: 't', attachment: { filename: 'x.pdf', type: 'application/pdf', data: Buffer.alloc(smtpLimits.attachmentBytes + 1) } }), error => error.message === 'Report too large to email, download it instead.' && error.code === 'too-large');
});

test('a successful send is recorded with size and hash, never alerted; the PDF is the only attachment', async () => {
  const sent = id();
  db.prepare("INSERT INTO clients(id,name,include,schedule_enabled,timezone,connection_id,recipients,created_at,updated_at) VALUES(?,?,'{}',1,'UTC',?,?,?,?)").run(sent, 'Sent Client', emailConnection, JSON.stringify({ sealed: seal(JSON.stringify([RECIPIENT])) }), now(), now());
  db.prepare('INSERT INTO client_apps VALUES(?,?)').run(sent, shop);
  const rowId = id(); db.prepare("INSERT INTO client_reports(id,client_id,period_start,period_end,trigger,status,attempts,next_attempt_at,created_at) VALUES(?,?,?,?,'schedule','sending',0,?,?)").run(rowId, sent, NOV.from, NOV.to, now(), '2026-12-01T00:00:00Z');
  let transcript = '', original = { ...smtpIo };
  const { createServer } = await import('node:net');
  const fake = createServer(socket => {
    socket.setEncoding('utf8'); socket.write('220 fake\r\n'); let data = false, buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      if (data) { if (buffer.endsWith('\r\n.\r\n')) { transcript = buffer; data = false; buffer = ''; socket.write('250 ok\r\n'); } return; }
      for (const line of buffer.split('\r\n').slice(0, -1)) {
        if (line.startsWith('EHLO')) socket.write('250-fake\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n'); else if (line === 'STARTTLS') socket.write('220 go\r\n'); else if (line.startsWith('AUTH PLAIN')) socket.write('235 ok\r\n'); else if (line.startsWith('MAIL') || line.startsWith('RCPT')) socket.write('250 ok\r\n'); else if (line === 'DATA') { socket.write('354 go\r\n'); data = true; buffer = ''; return; } else if (line === 'QUIT') socket.end();
      }
      buffer = buffer.slice(buffer.lastIndexOf('\r\n') + 2);
    });
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  // The fake server speaks plain SMTP and offers no real TLS: the test swaps the transport and answers STARTTLS with the same socket.
  smtpIo.resolve = async () => '127.0.0.1';
  smtpIo.connect = async () => (await import('node:net')).connect({ host: '127.0.0.1', port: fake.address().port });
  smtpIo.upgrade = async socket => socket;
  smtpPolicy.allowLoopback = true;
  try {
    assert.equal(await send.attempt(db.prepare('SELECT * FROM client_reports WHERE id=?').get(rowId)), 'sent');
  } finally { Object.assign(smtpIo, original); smtpPolicy.allowLoopback = false; fake.close(); }
  const after = db.prepare('SELECT * FROM client_reports WHERE id=?').get(rowId);
  assert.deepEqual([after.status, after.attempts, after.error], ['sent', 1, null]); assert.match(after.sha256, /^[0-9a-f]{64}$/); assert.ok(after.size > 1000 && after.sent_at);
  assert.match(transcript, /Content-Type: application\/pdf; name="docknest-report-2026-11\.pdf"/);
  const encoded = transcript.split('Content-Disposition: attachment; filename="docknest-report-2026-11.pdf"\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, '');
  const attachment = Buffer.from(encoded, 'base64'); assert.equal(send.sha256(attachment), after.sha256);
  for (const secret of FORBIDDEN) assert.equal(readText(attachment).includes(secret), false, secret);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alert_outbox WHERE event LIKE 'report.%' AND message LIKE '%Sent Client%'").get().n, 0, 'success is never alerted');
});
