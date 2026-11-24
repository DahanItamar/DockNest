import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

// The client report carries the same caveats as the screens (docs/recovery-time-adr.md, decision 5): a number from an old
// test says "not recent", and a number from before the backups grew says it "may be low". Fake rows only.
const directory = await mkdtemp(join(tmpdir(), 'docknest-report-caveats-'));
Object.assign(process.env, { DATA_DIR: directory, MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured', SECURE_COOKIES: 'false', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { db } = await import('../src/db.js');
const { buildReport, reportPdf, recoveryCaveats } = await import('../src/reports/client.js');
const { resolvePeriod } = await import('../src/reports/period.js');

const DAY = 86_400_000, now = Date.now(), iso = ms => new Date(ms).toISOString();
const server = randomUUID();
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(server, 'Server', 'host.example.invalid', 22, 'fixture', 'fixture', '0'.repeat(64), iso(now - 90 * DAY));
function backup(site, ms, size) { const job = randomUUID(), id = randomUUID(); db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,started_at,finished_at) VALUES(?,?,'backup','completed','completed',?,?,?)").run(job, site, iso(ms), iso(ms), iso(ms + 60_000)); db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, site, job, iso(ms), '/x/' + id, size, 'a'.repeat(64), '{}', 0, 1, iso(ms)); return id; }
function passed(site, backupId, ms) {
  const id = randomUUID();
  db.prepare("INSERT INTO restore_tests(id,site_id,backup_id,backup_captured_at,server_id,trigger,result,limits,created_by,created_at,finished_at,restore_seconds) VALUES(?,?,?,?,?,'manual','passed','{}','u',?,?,360)").run(id, site, backupId, iso(ms - 3_600_000), server, iso(ms), iso(ms));
  let offset = 0;
  for (const [step, seconds] of Object.entries({ copy_backup: 240, restore_copy: 360, start_containers: 90, check_health: 30 })) { db.prepare("INSERT INTO restore_test_steps VALUES(?,?,'done',?,?,NULL)").run(id, step, iso(ms - 3_600_000 + offset * 1000), iso(ms - 3_600_000 + (offset + seconds) * 1000)); offset += seconds; }
}
const names = ['חנות הספרים', 'בלוג המשפחה', 'מערכת חשבונות', 'App fresh'], ids = names.map(() => randomUUID());
names.forEach((name, i) => db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(ids[i], server, name, '{"containers":["web"]}', iso(now - 90 * DAY)));
const small = ids.map((id, i) => backup(id, now - 5 * DAY, 1e8));
passed(ids[0], small[0], now - 40 * DAY);                       // not recent
passed(ids[1], small[1], now - 2 * DAY); backup(ids[1], now - DAY, 2e8); // grew: may be low
passed(ids[2], small[2], now - 40 * DAY); backup(ids[2], now - DAY, 2e8); // both
passed(ids[3], small[3], now - 2 * DAY);                        // neither
const clientId = randomUUID(), at = iso(now);
db.prepare("INSERT INTO clients(id,name,agency,contact,accent,include,schedule_enabled,timezone,recipients,created_at,updated_at) VALUES(?,?,?,?,?,'{}',0,'UTC','[]',?,?)").run(clientId, 'לקוח לדוגמה', null, null, 'default', at, at);
for (const id of ids) db.prepare('INSERT INTO client_apps(client_id,site_id) VALUES(?,?)').run(clientId, id);
const client = db.prepare('SELECT * FROM clients WHERE id=?').get(clientId);
const today = new Date(now).toISOString().slice(0, 10), period = resolvePeriod(today.slice(0, 8) + '01', today, { timeZone: 'UTC' });
const report = buildReport(client, period, now), byName = Object.fromEntries(report.apps.map(app => [app.name, app.recovery]));

test('wording of the caveats', () => {
  assert.equal(recoveryCaveats(null), '');
  assert.equal(recoveryCaveats({ stale: false, mayBeLow: false }), '');
  assert.equal(recoveryCaveats({ stale: true, mayBeLow: false }), ' (not recent)');
  assert.equal(recoveryCaveats({ stale: false, mayBeLow: true }), ' (backups grew since the test, so this may be low)');
  assert.equal(recoveryCaveats({ stale: true, mayBeLow: true }), ' (not recent; backups grew since the test, so this may be low)');
});

test('the report text says not recent and may be low, as the screens do, and nothing when neither applies', () => {
  assert.equal(byName['חנות הספרים'], 'Back in about 12 min, proven 40 days ago (not recent)');
  assert.equal(byName['בלוג המשפחה'], 'Back in about 12 min, proven 2 days ago (backups grew since the test, so this may be low)');
  assert.equal(byName['מערכת חשבונות'], 'Back in about 12 min, proven 40 days ago (not recent; backups grew since the test, so this may be low)');
  assert.equal(byName['App fresh'], 'Back in about 12 min, proven 2 days ago');
});

test('the PDF is still made for Hebrew names with the caveats in it', () => {
  const pdf = reportPdf(report, { timeZone: 'UTC' });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length < 8 * 1024 * 1024);
});
