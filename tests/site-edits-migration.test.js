// Migration 15 (Safe Edit, docs/safe-edit.md "Data model"): additive only, no rows, floor unchanged, idempotent, from a
// real 2.14.0 database (schema 14: site-certificates 13, site-hardening 14), and the constraints that back up the engine:
// one unfinished edit per site, append-only history, the outcome written once, the CHECK limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, migrations, compatFloor, schemaVersion } from '../src/migrations.js';

const quiet = () => {};
const schema = db => db.prepare('SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all().map(row => ({ ...row }));
const upTo = version => migrations.filter(migration => migration.version <= version);
async function withDatabase(work) {
  const directory = await mkdtemp(join(tmpdir(), 'docknest-safe-edits-migration-')); let db;
  try {
    const file = join(directory, 'state.sqlite'); db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;');
    await work(db, file);
  } finally { db?.close(); await rm(directory, { recursive: true, force: true }); }
}
// A 2.14.0 database: every released migration up to 14 (site-certificates, site-hardening), with rows in both.
function database214(db, file) {
  migrate(db, { file, list: upTo(14), log: quiet });
  db.prepare("INSERT INTO settings VALUES('probe','kept')").run();
  db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('s','n','h',22,'root','k','f','2026-01-01')").run();
  db.prepare("INSERT INTO sites VALUES('site','s','shop','{\"containers\":[\"shop-web\"]}','2026-01-01'),('other','s','blog','{}','2026-01-01')").run();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES('j','site','backup','completed','completed','2026-01-01')").run();
  db.prepare("INSERT INTO site_certificates(site_id,source,name,not_after,checked_at) VALUES('site','tls','shop.example.invalid','2027-01-01T00:00:00.000Z','2026-11-01')").run();
  db.prepare("INSERT INTO site_hardening VALUES('site','2026-11-01','{}')").run();
}

test('migration 15 is one compatible `{ version: 15,` line named safe-edits, so the floor stays 1', async () => {
  const source = (await readFile(new URL('../src/migrations.js', import.meta.url), 'utf8')).split(/\r?\n/), lines = source.filter(line => /^\s*\{\s*version:\s*15\b/.test(line));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ {2}\{ version: 15, name: 'safe-edits', compatible: true, up: db => \{ .*db\.exec\(safeEditsSchema\); \} \},$/);
  assert.ok(schemaVersion >= 15); assert.equal(compatFloor(migrations), 1);
  assert.equal(migrations.some(migration => migration.name === 'reserved-2.14'), false, 'the pre-release placeholder is gone');
});

test('a 2.14.0 database (schema 14) gains only the Safe Edit objects, keeps every row and object, and restarts as a no-op', () => withDatabase((db, file) => {
  database214(db, file);
  const before = schema(db), rows = table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map(row => ({ ...row }));
  const kept = { settings: rows('settings').filter(row => row.key !== 'schema_compat_floor'), servers: rows('servers'), sites: rows('sites'), jobs: rows('jobs'), site_certificates: rows('site_certificates'), site_hardening: rows('site_hardening') };
  const result = migrate(db, { file, list: upTo(15), now: () => new Date('2026-11-02T08:00:00.000Z'), log: quiet });
  assert.equal(result.from, 14); assert.equal(result.to, 15); assert.match(result.snapshot, /state-v14-to-v15-/);
  for (const row of before) assert.deepEqual(schema(db).find(item => item.name === row.name), row, `${row.name} keeps its definition`);
  assert.deepEqual(schema(db).map(row => row.name).filter(name => !before.some(row => row.name === name)).sort(), ['site_compose_invocations', 'site_edit_steps', 'site_edit_steps_no_delete', 'site_edits', 'site_edits_no_delete', 'site_edits_result_once', 'site_edits_site_active', 'site_edits_site_created']);
  assert.deepEqual({ settings: rows('settings').filter(row => row.key !== 'schema_compat_floor'), servers: rows('servers'), sites: rows('sites'), jobs: rows('jobs'), site_certificates: rows('site_certificates'), site_hardening: rows('site_hardening') }, kept, 'every row exactly as before');
  for (const table of ['site_edits', 'site_edit_steps', 'site_compose_invocations']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} starts empty`);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='schema_compat_floor'").get().value, '1');
  const after = schema(db);
  assert.deepEqual(migrate(db, { file, list: upTo(15), log: quiet }), { from: 15, to: 15, snapshot: null }, 'restarting is a no-op');
  assert.deepEqual(schema(db), after);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
}));

test('a 2.13 database (schema 12) upgrades straight to 15; 2.13 and 2.14 can still open it (compatible objects only)', () => withDatabase((db, file) => {
  migrate(db, { file, list: upTo(12), log: quiet });
  assert.equal(migrate(db, { file, list: upTo(15), log: quiet }).to, 15);
  for (const name of ['site_certificates', 'site_hardening', 'site_edits']) assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name), name);
  // 2.13 code (list up to 12) and 2.14 code (up to 14) on the newer database: continue without changes, the floor is 1.
  assert.deepEqual(migrate(db, { file, list: upTo(12), log: quiet }), { from: 15, to: 15, snapshot: null });
  assert.deepEqual(migrate(db, { file, list: upTo(14), log: quiet }), { from: 15, to: 15, snapshot: null });
}));

test('Safe Edit constraints: one unfinished edit per site, CHECK limits, append-only history, outcome written once', () => withDatabase((db, file) => {
  database214(db, file);
  migrate(db, { file, list: upTo(15), log: quiet });
  db.prepare("INSERT INTO site_edits(id,site_id,server_id,state,created_by,created_at) VALUES('1','site','s','queued','a','x')").run();
  assert.throws(() => db.prepare("INSERT INTO site_edits(id,site_id,server_id,state,created_by,created_at) VALUES('2','site','s','queued','a','x')").run(), /UNIQUE constraint failed: site_edits\.site_id/, 'one unfinished edit per site');
  db.prepare("INSERT INTO site_edits(id,site_id,server_id,state,created_by,created_at) VALUES('3','other','s','needs_attention','a','x')").run();
  assert.throws(() => db.prepare("INSERT INTO site_edits(id,site_id,server_id,state,created_by,created_at) VALUES('4','other','s','queued','a','x')").run(), /UNIQUE/, 'needs_attention still holds the site');
  for (const [column, value] of [['state', "'paused'"], ['result', "'maybe'"], ['failed_step', "'deploy'"], ['time_limit_seconds', '59'], ['time_limit_seconds', '601'], ['time_limit_seconds', '90.5'], ['data_rollback', '2'], ['reason', `'${'x'.repeat(301)}'`], ['changes', `'${'x'.repeat(4097)}'`]]) {
    assert.throws(() => db.exec(`UPDATE site_edits SET ${column}=${value} WHERE id='1'`), /CHECK constraint failed/, `${column}=${value.slice(0, 12)}`);
  }
  assert.throws(() => db.exec("UPDATE site_edits SET result='applied' WHERE id='1'"), /CHECK constraint failed/, 'a result needs a final state');
  db.exec("UPDATE site_edits SET state='checking',reason='r',changes='{\"tabs\":[\"image\"]}' WHERE id='1'");
  db.exec("UPDATE site_edits SET state='done',result='applied',finished_at='y' WHERE id='1'");
  db.prepare("INSERT INTO site_edits(id,site_id,server_id,state,created_by,created_at) VALUES('2','site','s','queued','a','x')").run(); // the slot is free again
  for (const change of ["result='failed'", "reason='other'", "changes='{}'", "failed_step='apply'"]) assert.throws(() => db.exec(`UPDATE site_edits SET ${change} WHERE id='1'`), /a safe edit result is written once/, change);
  db.exec("UPDATE site_edits SET health_seconds=health_seconds WHERE id='1'");
  assert.throws(() => db.exec("DELETE FROM site_edits WHERE id='1'"), /append-only/);
  db.prepare("INSERT INTO site_edit_steps(edit_id,step,state) VALUES('1','backup','done')").run();
  assert.throws(() => db.prepare("INSERT INTO site_edit_steps(edit_id,step,state) VALUES('1','launch','done')").run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare("INSERT INTO site_edit_steps(edit_id,step,state) VALUES('1','apply','undone')").run(), /CHECK constraint failed/);
  assert.throws(() => db.exec("DELETE FROM site_edit_steps WHERE edit_id='1'"), /append-only/);
  db.prepare("INSERT INTO site_compose_invocations VALUES('site','compose','{}','labels','x')").run();
  assert.throws(() => db.prepare("INSERT INTO site_compose_invocations VALUES('other','swarm','{}','labels','x')").run(), /CHECK constraint failed/);
}));
