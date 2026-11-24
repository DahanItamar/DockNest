// Measured recovery time (docs/recovery-time-adr.md): the pure definition and the read model over restore test rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { recoveryTime, formatRecoveryTime } from '../shared/recovery-time.js';

const T0 = Date.parse('2026-11-20T10:00:00.000Z'), iso = ms => new Date(ms).toISOString();
const step = (name, seconds, state = 'done', offset = 0) => ({ step: name, state, started_at: iso(T0 + offset * 1000), finished_at: iso(T0 + (offset + seconds) * 1000) });
const fullSteps = [step('check_space', 50), step('copy_backup', 60), step('restore_copy', 120), step('start_containers', 30), step('check_health', 15), step('clean_up', 99)];
const passed = { result: 'passed', finished_at: iso(T0 + 600_000) };
const now = T0 + 600_000 + 3 * 86_400_000;

test('definition: copy + restore + start + health, no space check or clean-up', () => {
  const value = recoveryTime(fullSteps, passed, null, 'weekly', now);
  assert.equal(value.seconds, 225);
  assert.deepEqual(value.phases, { copy: 60, restore: 120, start: 45 });
  assert.equal(value.provenAt, passed.finished_at);
  assert.equal(value.stale, false);
  assert.equal(value.mayBeLow, false);
});
test('static sites skip start and health', () => {
  const value = recoveryTime([step('copy_backup', 10), step('restore_copy', 20), step('start_containers', 0, 'skipped'), { step: 'check_health', state: 'skipped', started_at: null, finished_at: null }], passed, null, null, now);
  assert.deepEqual(value.phases, { copy: 10, restore: 20, start: 0 });
});
test('only passed tests produce a time', () => {
  for (const result of ['failed', 'cancelled', 'couldnt_run', null]) assert.equal(recoveryTime(fullSteps, { ...passed, result }, null, null, now), null);
  assert.equal(recoveryTime(fullSteps, null), null);
});
test('missing step rows and clock skew never go negative', () => {
  assert.equal(recoveryTime([], passed, null, null, now), null);
  assert.equal(recoveryTime([step('copy_backup', -30)], passed, null, null, now), null);
  const value = recoveryTime([step('copy_backup', 40), step('restore_copy', -5)], passed, null, null, now);
  assert.deepEqual(value.phases, { copy: 40, restore: 0, start: 0 });
});
test('stale: two cadence periods or 35 days, whichever is shorter', () => {
  const at = days => T0 + 600_000 + days * 86_400_000 + 1000;
  assert.equal(recoveryTime(fullSteps, passed, null, 'daily', at(2)).stale, true);
  assert.equal(recoveryTime(fullSteps, passed, null, 'daily', at(1.9)).stale, false);
  assert.equal(recoveryTime(fullSteps, passed, null, 'weekly', at(13)).stale, false);
  assert.equal(recoveryTime(fullSteps, passed, null, 'weekly', at(15)).stale, true);
  assert.equal(recoveryTime(fullSteps, passed, null, 'monthly', at(34)).stale, false);
  assert.equal(recoveryTime(fullSteps, passed, null, 'monthly', at(36)).stale, true);
  assert.equal(recoveryTime(fullSteps, passed, null, null, at(34)).stale, false);
  assert.equal(recoveryTime(fullSteps, passed, null, null, at(36)).stale, true);
});
test('may be low only when the newest backup is more than 50% larger', () => {
  assert.equal(recoveryTime(fullSteps, passed, { size: 1500 }, 'weekly', now, { size: 1000 }).mayBeLow, false);
  assert.equal(recoveryTime(fullSteps, passed, { size: 1501 }, 'weekly', now, { size: 1000 }).mayBeLow, true);
  assert.equal(recoveryTime(fullSteps, passed, { size: 9000 }, 'weekly', now, null).mayBeLow, false);
});
test('rounding', () => {
  assert.equal(formatRecoveryTime(119), 'under 2 min');
  assert.equal(formatRecoveryTime(120), '2 min');
  assert.equal(formatRecoveryTime(121), '3 min');
  assert.equal(formatRecoveryTime(5400), '90 min');
  assert.equal(formatRecoveryTime(5401), '1.5 h');
  assert.equal(formatRecoveryTime(7200), '2.0 h');
  assert.equal(formatRecoveryTime(0), null);
});

const directory = await mkdtemp(join(tmpdir(), 'docknest-recovery-time-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { db } = await import('../src/db.js');
const { recoveryBySite, cardFor } = await import('../src/restore-tests/views.js');

const serverId = randomUUID();
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(serverId, 'test-server', '192.0.2.10', 22, 'root', 'fixture', '0'.repeat(64), iso(T0));
function site(label) { const id = randomUUID(); db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(id, serverId, label, '{"containers":["web"]}', iso(T0)); return id; }
function backup(siteId, size, capturedAt) {
  const jobId = randomUUID(), id = randomUUID();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','completed','completed',?)").run(jobId, siteId, iso(T0));
  db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, siteId, jobId, capturedAt, '/x/' + id, size, 'a'.repeat(64), '{}', 0, 1, iso(T0));
  return id;
}
function testRow(siteId, backupId, result, finishedMs, stepSeconds = { copy_backup: 30, restore_copy: 60, start_containers: 20, check_health: 10 }) {
  const id = randomUUID();
  db.prepare("INSERT INTO restore_tests(id,site_id,backup_id,backup_captured_at,server_id,trigger,result,limits,created_by,created_at,finished_at) VALUES(?,?,?,?,?,'manual',?,'{}','u',?,?)").run(id, siteId, backupId, iso(T0), serverId, result, iso(finishedMs), iso(finishedMs));
  let offset = 0;
  for (const [name, seconds] of Object.entries(stepSeconds)) {
    db.prepare("INSERT INTO restore_test_steps VALUES(?,?,'done',?,?,NULL)").run(id, name, iso(finishedMs + offset * 1000), iso(finishedMs + (offset + seconds) * 1000));
    offset += seconds;
  }
  return id;
}

test('read model: newest passed test per site, failed ignored, grown backups flagged', () => {
  const a = site('shop'), b = site('blog'), c = site('none');
  const small = backup(a, 1000, iso(T0));
  backup(a, 2000, iso(T0 + 1000));
  testRow(a, small, 'passed', T0 + 10_000, { copy_backup: 600 });
  testRow(a, small, 'passed', T0 + 20_000);
  testRow(a, small, 'failed', T0 + 30_000);
  testRow(b, backup(b, 500, iso(T0)), 'failed', T0 + 10_000);
  const map = recoveryBySite(null, T0 + 40_000);
  assert.equal(map.get(a).seconds, 120);
  assert.equal(map.get(a).mayBeLow, true);
  assert.equal(map.has(b), false);
  assert.equal(map.has(c), false);
  assert.equal(recoveryBySite(a, T0 + 40_000).size, 1);
  assert.equal(recoveryBySite(b).size, 0);
});

test('read model: a fixed number of statements however many sites', () => {
  const count = () => {
    let n = 0;
    const original = db.prepare.bind(db);
    db.prepare = sql => { n += 1; return original(sql); };
    try { recoveryBySite(); } finally { db.prepare = original; }
    return n;
  };
  const before = count();
  for (let index = 0; index < 5; index++) { const id = site('extra' + index); testRow(id, backup(id, 100, iso(T0)), 'passed', T0 + 50_000); }
  assert.equal(count(), before);
});

test('card: last.recovery and items[].recoverySeconds', () => {
  const id = site('card'), backupId = backup(id, 100, iso(T0));
  const passedId = testRow(id, backupId, 'passed', T0 + 10_000);
  const failedId = testRow(id, backupId, 'failed', T0 + 20_000);
  const card = cardFor(id);
  assert.equal(card.last.result, 'failed');
  assert.equal(card.last.recovery.seconds, 120);
  assert.equal(card.items.find(item => item.id === passedId).recoverySeconds, 120);
  assert.equal(card.items.find(item => item.id === failedId).recoverySeconds, null);
  assert.equal(cardFor(site('empty')).last, null);
});
