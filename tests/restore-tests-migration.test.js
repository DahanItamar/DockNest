// Migration 9 (restore tests, docs/restore-tests.md "Data model"): additive only, no rows, floor unchanged, idempotent,
// and the constraints that back up the engine: limit ranges, one unfinished test per site, one started test per test
// server (queued ones wait), results written once, append-only history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, migrations, compatFloor, schemaVersion } from '../src/migrations.js';

const quiet = () => {};
const schema = db => db.prepare('SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all().map(row => ({ ...row }));
async function withDatabase(upTo, work) {
  const directory = await mkdtemp(join(tmpdir(), 'docknest-restore-tests-migration-')); let db;
  try {
    const file = join(directory, 'state.sqlite'); db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;');
    migrate(db, { file, list: migrations.slice(0, upTo), log: quiet });
    await work(db, file);
  } finally { db?.close(); await rm(directory, { recursive: true, force: true }); }
}

test('migration 9 is one compatible `{ version: 9,` line named restore-tests, so the floor stays 1', async () => {
  const source = (await readFile(new URL('../src/migrations.js', import.meta.url), 'utf8')).split(/\r?\n/), lines = source.filter(line => /^\s*\{\s*version:\s*9\b/.test(line));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ {2}\{ version: 9, name: 'restore-tests', compatible: true, up: db => db\.exec\(restoreTestsSchema\) \},$/);
  assert.equal(schemaVersion, 9); assert.equal(compatFloor(migrations), 1);
});

test('an 8-schema (2.8.x) database gains only the restore test objects, keeps every row and upgrades with tests off', () => withDatabase(8, async (db, file) => {
  db.prepare("INSERT INTO settings VALUES('probe','kept')").run();
  db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('s','n','h',22,'root','k','f','2026-01-01')").run();
  db.prepare("INSERT INTO sites VALUES('site','s','shop','{}','2026-01-01')").run();
  const before = schema(db), settings = db.prepare('SELECT key,value FROM settings WHERE key<>? ORDER BY key').all('schema_compat_floor').map(row => ({ ...row }));
  const result = migrate(db, { file, now: () => new Date('2026-10-26T08:00:00.000Z'), log: quiet });
  assert.equal(result.from, 8); assert.equal(result.to, 9); assert.match(result.snapshot, /state-v8-to-v9-/);
  for (const row of before) assert.deepEqual(schema(db).find(item => item.name === row.name), row, 'existing objects keep their definition');
  assert.deepEqual(schema(db).map(row => row.name).filter(name => !before.some(row => row.name === name)).sort(), ['restore_test_settings', 'restore_test_settings_due', 'restore_test_steps', 'restore_test_steps_no_delete', 'restore_tests', 'restore_tests_backup', 'restore_tests_no_delete', 'restore_tests_result_once', 'restore_tests_server_active', 'restore_tests_site_active', 'restore_tests_site_created']);
  assert.deepEqual(db.prepare('SELECT key,value FROM settings WHERE key<>? ORDER BY key').all('schema_compat_floor').map(row => ({ ...row })), settings);
  for (const table of ['restore_test_settings', 'restore_tests', 'restore_test_steps']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} starts empty: tests are off`);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='schema_compat_floor'").get().value, '1');
  assert.deepEqual(migrate(db, { file, log: quiet }), { from: 9, to: 9, snapshot: null }, 'restarting is a no-op');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
}));

test('restore test constraints: limit ranges, one active test per site and per started server, results once, no deletes', () => withDatabase(9, db => {
  db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('s','n','h',22,'root','k','f','2026-01-01'),('t','t','h',22,'root','k','f','2026-01-01')").run();
  db.prepare("INSERT INTO sites VALUES('a','s','a','{}','x'),('b','s','b','{}','x'),('c','s','c','{}','x')").run();
  const settings = (values = {}) => db.prepare('INSERT OR REPLACE INTO restore_test_settings(site_id,time_limit_minutes,memory_mb,cpus,updated_at) VALUES(?,?,?,?,?)').run('a', values.time ?? 30, values.memory ?? 1024, values.cpus ?? 1, 'x');
  for (const values of [{}, { time: 10 }, { time: 120 }, { time: 45 }, { memory: 256 }, { memory: 16384 }, { memory: 700 }, { cpus: 0.5 }, { cpus: 0.75 }, { cpus: 16 }]) settings(values);
  for (const values of [{ time: 9 }, { time: 121 }, { time: 30.5 }, { memory: 255 }, { memory: 16385 }, { memory: 1024.5 }, { cpus: 0.25 }, { cpus: 16.25 }, { cpus: 1.1 }]) assert.throws(() => settings(values), /CHECK constraint failed/, JSON.stringify(values));
  assert.deepEqual({ ...db.prepare("SELECT enabled,cadence,allow_live_server,allow_internet FROM restore_test_settings WHERE site_id='a'").get() }, { enabled: 0, cadence: 'weekly', allow_live_server: 0, allow_internet: 0 });
  const insert = (id, site, extra = '') => db.prepare(`INSERT INTO restore_tests(id,site_id,backup_captured_at,server_id,trigger,limits,created_by,created_at${extra ? ',' + extra.split('=')[0] : ''}) VALUES(?,?,?,?,?,?,?,?${extra ? ',?' : ''})`).run(...[id, site, 'x', 't', 'manual', '{}', 'a', 'x', ...(extra ? [extra.split('=')[1]] : [])]);
  insert('1', 'a');
  assert.throws(() => insert('2', 'a'), /UNIQUE constraint failed: restore_tests\.site_id/, 'one unfinished test per site');
  insert('3', 'b'); insert('4', 'c');
  db.prepare("UPDATE restore_tests SET started_at='x' WHERE id='1'").run();
  assert.throws(() => db.prepare("UPDATE restore_tests SET started_at='x' WHERE id='3'").run(), /UNIQUE constraint failed: restore_tests\.server_id/, 'one started test per test server; queued ones wait');
  db.prepare("UPDATE restore_tests SET result='passed',cleanup='pending' WHERE id='1'").run();
  assert.throws(() => db.prepare("UPDATE restore_tests SET started_at='x' WHERE id='3'").run(), /UNIQUE/, 'a pending clean-up still holds the server');
  assert.throws(() => insert('5', 'a'), /UNIQUE/, 'a pending clean-up still counts for the site');
  db.prepare("UPDATE restore_tests SET cleanup='failed' WHERE id='1'").run();
  assert.throws(() => db.prepare("UPDATE restore_tests SET started_at='x' WHERE id='3'").run(), /UNIQUE/, 'a failed clean-up still holds the server');
  db.prepare("UPDATE restore_tests SET cleanup='acknowledged' WHERE id='1'").run();
  db.prepare("UPDATE restore_tests SET started_at='x' WHERE id='3'").run();
  insert('6', 'a');
  for (const change of ["result='failed'", "result=NULL", "failed_step='check_space'", "reason='x'", "checks='[1]'", 'restore_seconds=5', 'total_seconds=5']) assert.throws(() => db.prepare(`UPDATE restore_tests SET ${change} WHERE id='1'`).run(), /written once/, change);
  db.prepare("UPDATE restore_tests SET cleanup='acknowledged',finished_at='y' WHERE id='1'").run();
  assert.throws(() => db.prepare("DELETE FROM restore_tests WHERE id='1'").run(), /append-only/);
  db.prepare("INSERT INTO restore_test_steps(test_id,step,state) VALUES('1','check_space','done')").run();
  assert.throws(() => db.prepare("INSERT INTO restore_test_steps(test_id,step,state) VALUES('1','unknown','done')").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO restore_test_steps(test_id,step,state,detail) VALUES('1','copy_backup','done',?)").run('x'.repeat(501)), /CHECK/);
  assert.throws(() => db.prepare("DELETE FROM restore_test_steps WHERE test_id='1'").run(), /append-only/);
  assert.throws(() => db.prepare("UPDATE restore_tests SET result='odd' WHERE id='4'").run(), /CHECK/);
  assert.throws(() => db.prepare('UPDATE restore_tests SET reason=? WHERE id=?').run('x'.repeat(301), '4'), /CHECK/);
}));
