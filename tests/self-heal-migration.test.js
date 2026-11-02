// Self-heal, upgrade safety (docs/self-heal.md "Upgrade safety"): migration 15 is additive, a 2.14-shaped database keeps
// every row exactly, the option stays off for every site, a second start changes nothing, and older code keeps running
// on the newer schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrations, migrate, schemaVersion, compatFloor } from '../src/migrations.js';

const quiet = () => {};
const temporary = async fn => { const directory = await mkdtemp(join(tmpdir(), 'docknest-self-heal-migration-')); try { return await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); } };
const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(row => ({ ...row }));
const contents = (db, tables) => Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map(row => ({ ...row }))]));
// Everything before self-heal: the schema a 2.14 install has on this branch (13 and 14 merge from parallel branches).
const before = migrations.filter(migration => migration.version < 15);
const added = ['self_heal_events', 'self_heal_events_at', 'self_heal_events_keep_recent', 'self_heal_events_no_update', 'self_heal_events_site', 'self_heal_settings'];

function fixture(db) {
  db.exec(`INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('server','Server','host.invalid',22,'root','sealed','${'a'.repeat(64)}','2026-10-28');
    INSERT INTO sites VALUES('site','server','Shop','{"containers":["shop-web-1"]}','2026-10-28');
    INSERT INTO policies VALUES('site',1,'0 2 * * *','UTC',7,NULL);
    INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES('job','site','backup','completed','completed','2026-10-28','{}'),('queued','site','backup','queued','queued','2026-10-29','{}');
    INSERT INTO backups VALUES('backup','site','job','2026-10-28','fixture/site.enc',1024,'${'d'.repeat(64)}','{"formatVersion":1}',1,1,'2026-10-28');
    INSERT INTO audit_events VALUES('audit','admin','site.created','site','{}','2026-10-28');
    INSERT INTO settings VALUES('worker_heartbeat','{"running":true}');`);
}

test('migration 15 is self-heal, compatible, and adds only its tables, indexes and triggers', () => {
  const migration = migrations.find(item => item.version === 15);
  assert.equal(migration.name, 'self-heal'); assert.equal(migration.compatible, true);
  assert.equal(schemaVersion, 15); assert.equal(compatFloor(migrations), 1, 'self-heal does not raise the compatibility floor');
});

test('a 2.14-shaped database upgrades with every row unchanged, self-heal off, and a second start is a no-op', () => temporary(async directory => {
  const file = join(directory, 'state.sqlite'), db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    migrate(db, { file, list: before, log: quiet });
    fixture(db);
    const old = schema(db), tables = old.filter(row => row.type === 'table').map(row => row.name), rows = contents(db, tables);
    const result = migrate(db, { file, log: quiet });
    assert.equal(result.to, 15); assert.ok(result.snapshot, 'a pre-upgrade snapshot is taken');
    const withoutFloor = value => Object.fromEntries(Object.entries(value).map(([name, list]) => [name, name === 'settings' ? list.filter(row => row.key !== 'schema_compat_floor') : list]));
    assert.deepEqual(withoutFloor(contents(db, tables)), withoutFloor(rows), 'no existing row changes');
    for (const row of old) assert.deepEqual(schema(db).find(item => item.name === row.name), row, 'unchanged: ' + row.name);
    assert.deepEqual(schema(db).map(row => row.name).filter(name => !old.some(row => row.name === name)).sort(), added);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM self_heal_settings').get().n, 0, 'off for every site');
    // Idempotent: a restart migrates nothing, and re-running the DDL changes nothing.
    const after = schema(db);
    assert.deepEqual(migrate(db, { file, log: quiet }), { from: 15, to: 15, snapshot: null });
    migrations.find(item => item.version === 15).up(db);
    assert.deepEqual(schema(db), after);
    // Rolling back: older code accepts the newer, compatible schema without touching it.
    const messages = [];
    assert.deepEqual(migrate(db, { file, list: before, log: message => messages.push(message) }), { from: 15, to: 15, snapshot: null });
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
