// Self-heal, upgrade safety (docs/self-heal.md "Upgrade safety"): migration 16 is additive; a real 2.14.0 database
// (schema 14) upgrades through Safe Edit (15) and self-heal (16) with every row kept, the option off for every site, a
// second start changes nothing, and 2.14 code keeps running on the newer schema. Pre-release 2.15 databases that ran the
// removed placeholder 13 still end up with 2.14's tables.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrations, migrate, schemaVersion, compatFloor } from '../src/migrations.js';

const quiet = () => {};
const temporary = async fn => { const directory = await mkdtemp(join(tmpdir(), 'docknest-self-heal-migration-')); try { return await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); } };
const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(row => ({ ...row }));
const contents = (db, tables) => Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map(row => ({ ...row }))]));
// The released 2.14.0 schema: migrations 1 to 14 (13 site-certificates, 14 site-hardening).
const before = migrations.filter(migration => migration.version <= 14);
const selfHeal = ['self_heal_events', 'self_heal_events_at', 'self_heal_events_keep_recent', 'self_heal_events_no_update', 'self_heal_events_site', 'self_heal_settings'];
const safeEdits = ['site_compose_invocations', 'site_edit_steps', 'site_edit_steps_no_delete', 'site_edits', 'site_edits_no_delete', 'site_edits_result_once', 'site_edits_site_active', 'site_edits_site_created'];
const added = [...selfHeal, ...safeEdits].sort();
// 2.14.0's own migrations.js (main at the 2.14.0 merge, ab5122c), when the history holds it.
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const released214 = (() => { try { return execFileSync('git', ['show', 'ab5122c:src/migrations.js'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }); } catch { return null; } })();

function fixture(db) {
  db.exec(`INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('server','Server','host.invalid',22,'root','sealed','${'a'.repeat(64)}','2026-10-28');
    INSERT INTO sites VALUES('site','server','Shop','{"containers":["shop-web-1"]}','2026-10-28');
    INSERT INTO policies VALUES('site',1,'0 2 * * *','UTC',7,NULL);
    INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES('job','site','backup','completed','completed','2026-10-28','{}'),('queued','site','backup','queued','queued','2026-10-29','{}');
    INSERT INTO backups VALUES('backup','site','job','2026-10-28','fixture/site.enc',1024,'${'d'.repeat(64)}','{"formatVersion":1}',1,1,'2026-10-28');
    INSERT INTO audit_events VALUES('audit','admin','site.created','site','{}','2026-10-28');
    INSERT INTO settings VALUES('worker_heartbeat','{"running":true}');
    INSERT INTO site_certificates(site_id,source,name,not_after,checked_at) VALUES('site','tls','shop.example.invalid','2027-01-01T00:00:00.000Z','2026-11-01');
    INSERT INTO site_hardening VALUES('site','2026-11-01','{}');`);
}

test('migration 16 is self-heal, compatible, and the versions are 1..16 with 2.14.0 at 13 and 14', () => {
  const migration = migrations.find(item => item.version === 16);
  assert.equal(migration.name, 'self-heal'); assert.equal(migration.compatible, true);
  assert.deepEqual(migrations.filter(item => item.version >= 13).map(item => [item.version, item.name]), [[13, 'site-certificates'], [14, 'site-hardening'], [15, 'safe-edits'], [16, 'self-heal']]);
  assert.deepEqual(migrations.map(item => item.version), migrations.map((_, index) => index + 1));
  assert.equal(schemaVersion, 16); assert.equal(compatFloor(migrations), 1, 'self-heal does not raise the compatibility floor');
});

test('a 2.14.0 database (schema 14) upgrades with every row unchanged, self-heal off, and a second start is a no-op', () => temporary(async directory => {
  const file = join(directory, 'state.sqlite'), db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    migrate(db, { file, list: before, log: quiet });
    fixture(db);
    const old = schema(db), tables = old.filter(row => row.type === 'table').map(row => row.name), rows = contents(db, tables);
    const result = migrate(db, { file, log: quiet });
    assert.equal(result.from, 14); assert.equal(result.to, 16); assert.ok(result.snapshot, 'a pre-upgrade snapshot is taken');
    const withoutFloor = value => Object.fromEntries(Object.entries(value).map(([name, list]) => [name, name === 'settings' ? list.filter(row => row.key !== 'schema_compat_floor') : list]));
    assert.deepEqual(withoutFloor(contents(db, tables)), withoutFloor(rows), 'no existing row changes');
    for (const row of old) assert.deepEqual(schema(db).find(item => item.name === row.name), row, 'unchanged: ' + row.name);
    assert.deepEqual(schema(db).map(row => row.name).filter(name => !old.some(row => row.name === name)).sort(), added);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM self_heal_settings').get().n, 0, 'off for every site');
    // Idempotent: a restart migrates nothing, and re-running the DDL changes nothing.
    const after = schema(db);
    assert.deepEqual(migrate(db, { file, log: quiet }), { from: 16, to: 16, snapshot: null });
    migrations.find(item => item.version === 15).up(db); migrations.find(item => item.version === 16).up(db);
    assert.deepEqual(schema(db), after);
    // Rolling back: older code accepts the newer, compatible schema without touching it.
    const messages = [];
    assert.deepEqual(migrate(db, { file, list: before, log: message => messages.push(message) }), { from: 16, to: 16, snapshot: null });
    assert.match(messages.join('\n'), /only adds compatible objects/);
    assert.deepEqual(schema(db), after);
    // Older code's job queries still see their jobs; heal jobs use statuses older code never claims.
    db.exec("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES('heal','site','self-heal','heal_queued','queued','2026-10-30','{}')");
    assert.deepEqual(db.prepare("SELECT id FROM jobs WHERE status IN ('queued','move_queued','test_queued') ORDER BY created_at").all().map(row => row.id), ['queued']);
  } finally { db.close(); }
}));

test('the new tables enforce their limits and keep the history append-only for 90 days', () => temporary(async directory => {
  const file = join(directory, 'state.sqlite'), db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    migrate(db, { file, log: quiet });
    fixture(db);
    db.exec("INSERT INTO self_heal_settings(site_id,updated_at) VALUES('site','2026-11-01')");
    assert.deepEqual({ ...db.prepare('SELECT enabled,max_restarts,window_minutes,watched FROM self_heal_settings').get() }, { enabled: 0, max_restarts: 3, window_minutes: 60, watched: '[]' });
    for (const [column, value] of [['max_restarts', 0], ['max_restarts', 11], ['window_minutes', 9], ['window_minutes', 1441], ['enabled', 2], ['max_restarts', 2.5]])
      assert.throws(() => db.prepare(`UPDATE self_heal_settings SET ${column}=? WHERE site_id='site'`).run(value), /CHECK/, `${column}=${value}`);
    assert.throws(() => db.prepare("UPDATE self_heal_settings SET watched=? WHERE site_id='site'").run('x'.repeat(4097)), /CHECK/);
    const insert = db.prepare("INSERT INTO self_heal_events(id,site_id,server_id,container,kind,reason,at) VALUES(?,'site','server',?,?,?,?)");
    const recent = new Date(Date.now() - 86_400_000).toISOString(), old = new Date(Date.now() - 91 * 86_400_000).toISOString();
    insert.run('recent', 'shop-web-1', 'unhealthy', null, recent);
    insert.run('old', 'shop-web-1', 'restarted', null, old);
    assert.throws(() => insert.run('bad', 'shop-web-1', 'exploded', null, recent), /CHECK/);
    assert.throws(() => insert.run('long', 'x'.repeat(129), 'unhealthy', null, recent), /CHECK/);
    assert.throws(() => insert.run('reason', 'shop-web-1', 'skipped', 'x'.repeat(301), recent), /CHECK/);
    assert.throws(() => db.exec("UPDATE self_heal_events SET kind='recovered' WHERE id='recent'"), /append-only/);
    assert.throws(() => db.exec("DELETE FROM self_heal_events WHERE id='recent'"), /90 days/);
    db.exec("DELETE FROM self_heal_events WHERE id='old'");
    assert.deepEqual(db.prepare('SELECT id FROM self_heal_events').all().map(row => row.id), ['recent']);
  } finally { db.close(); }
}));

test('the real 2.14.0 code builds the schema-14 database, it upgrades to 16 unchanged, and 2.14.0 keeps running on it', { skip: !released214 && 'the 2.14.0 commit is not in this history' }, () => temporary(async directory => {
  const module = join(directory, 'migrations-2.14.0.mjs'); await writeFile(module, released214);
  const old = await import(pathToFileURL(module).href), file = join(directory, 'state.sqlite'), db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    assert.equal(old.migrate(db, { file, log: quiet }).to, 14);
    fixture(db);
    const oldSchema = schema(db), tables = oldSchema.filter(row => row.type === 'table').map(row => row.name), rows = contents(db, tables);
    assert.equal(migrate(db, { file, log: quiet }).to, 16);
    const strip = value => Object.fromEntries(Object.entries(value).map(([name, list]) => [name, name === 'settings' ? list.filter(row => row.key !== 'schema_compat_floor') : list]));
    assert.deepEqual(strip(contents(db, tables)), strip(rows));
    for (const row of oldSchema) assert.deepEqual(schema(db).find(item => item.name === row.name), row, 'unchanged: ' + row.name);
    const messages = [];
    assert.deepEqual(old.migrate(db, { file, log: message => messages.push(message) }), { from: 16, to: 16, snapshot: null });
    assert.match(messages.join('\n'), /only adds compatible objects/);
  } finally { db.close(); }
}));

test('a pre-release 2.15 database (placeholder 13, Safe Edit 14, self-heal 15) gains 2.14.0\'s tables on upgrade', () => temporary(async directory => {
  const file = join(directory, 'state.sqlite'), db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    const prerelease = [...migrations.filter(item => item.version <= 12), { version: 13, name: 'reserved-2.14', compatible: true, up: () => {} },
      { version: 14, name: 'safe-edits', compatible: true, up: () => {} },
      { version: 15, name: 'self-heal', compatible: true, up: () => {} }];
    for (const upTo of [14, 15]) {
      db.exec('PRAGMA user_version=0'); migrate(db, { file, list: prerelease.filter(item => item.version <= upTo), log: quiet });
      for (const name of ['site_certificates', 'site_hardening']) db.exec(`DROP TABLE IF EXISTS ${name}`);
      migrate(db, { file, log: quiet });
      for (const name of ['site_certificates', 'site_hardening', 'site_edits', 'self_heal_settings']) assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name), `${name} after a pre-release v${upTo}`);
    }
  } finally { db.close(); }
}));
