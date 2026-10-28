// Incremental backups, upgrade safety (docs/incremental-backups.md "Upgrade safety"): migration 13 is additive, a
// 2.11.1 database keeps working unchanged until the owner turns the option on, and 2.11.1 code keeps running on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrations, migrate, schemaVersion, compatFloor, reservedMigrationVersions } from '../src/migrations.js';

const quiet = () => {};
const temporary = async fn => { const directory = await mkdtemp(join(tmpdir(), 'docknest-incremental-migration-')); try { return await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); } };
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const released = (tag, file) => { try { return execFileSync('git', ['show', `${tag}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }); } catch (error) { if (process.env.CI) throw new Error(`${tag}:${file} is not available; fetch the release tags`, { cause: error }); return null; } };
const v2111 = released('v2.11.1', 'src/migrations.js'), noTag = !v2111 && 'v2.11.1 tag not fetched';
const v2111Migrations = directory => { const file = join(directory, 'migrations-v2.11.1.mjs'); return writeFile(file, v2111).then(() => import(pathToFileURL(file).href)); };
const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(row => ({ ...row }));
const contents = (db, tables) => Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map(row => ({ ...row }))]));

test('migration versions are unique and increasing, contiguous apart from the reserved radar version 12', () => {
  const versions = migrations.map(migration => migration.version);
  assert.deepEqual([...versions].sort((a, b) => a - b), versions, 'increasing');
  assert.equal(new Set(versions).size, versions.length, 'unique');
  const missing = [];
  for (let version = 1; version <= versions.at(-1); version++) if (!versions.includes(version)) missing.push(version);
  // Version 12 belongs to the radar (merged in parallel); once it lands there is no gap at all.
  assert.ok(missing.every(version => reservedMigrationVersions.includes(version)), `only reserved versions may be missing: ${missing}`);
  assert.ok(missing.length <= reservedMigrationVersions.length);
  const incremental = migrations.find(migration => migration.name === 'incremental-backups');
  assert.equal(incremental.version, 13); assert.equal(incremental.compatible, true);
  assert.equal(schemaVersion, versions.at(-1)); assert.equal(compatFloor(migrations), 1, 'every migration since 1 stays compatible');
});

test('migration 13 adds only its two tables and indexes, and the 2.11 positional inserts still work on it', () => temporary(async directory => {
  const file = join(directory, 'state.sqlite'), db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    migrate(db, { file, list: migrations.filter(migration => migration.version <= 11), log: quiet });
    const before = schema(db);
    migrate(db, { file, log: quiet });
    const added = schema(db).filter(row => !before.some(item => item.name === row.name)).map(row => row.name).sort();
    assert.deepEqual(added, ['backup_chain_links', 'backup_chain_links_chain', 'backup_chain_links_parent', 'site_incremental']);
    for (const row of before) assert.deepEqual(schema(db).find(item => item.name === row.name), row, 'unchanged: ' + row.name);
    // 2.11 (src/server.js, scripts and tests) inserts positionally into these tables.
    db.exec("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('server','Server','host.invalid',22,'root','sealed','" + 'a'.repeat(64) + "','2026-10-28')");
    db.prepare('INSERT INTO sites VALUES (?,?,?,?,?)').run('site', 'server', 'Site', '{}', '2026-10-28');
    db.prepare('INSERT INTO policies VALUES (?,0,?,?,7,NULL)').run('site', '0 2 * * *', 'UTC');
    db.exec("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES('job','site','backup','completed','completed','2026-10-28')");
    db.exec("INSERT INTO backups VALUES('full','site','job','2026-10-28','fixture/full.enc',10,'" + 'b'.repeat(64) + "','{}',0,1,'2026-10-28')");
    db.exec("INSERT INTO backups VALUES('increment','site','job','2026-10-29','fixture/increment.enc',10,'" + 'c'.repeat(64) + "','{}',0,1,'2026-10-29')");
    db.exec("INSERT INTO backup_chain_links VALUES('full','full','chain',NULL,0),('increment','incremental','chain','full',1)");
    // 2.11 retention deletes a row as it always did: the link row follows, and deleting a parent never fails.
    db.exec("DELETE FROM backups WHERE id='full'");
    assert.deepEqual(db.prepare('SELECT backup_id FROM backup_chain_links').all().map(row => row.backup_id), ['increment']);
    db.exec("DELETE FROM backups WHERE id='increment'");
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backup_chain_links').get().n, 0);
    // The constraints of the new tables.
    assert.throws(() => db.exec("INSERT INTO site_incremental(site_id,enabled,interval) VALUES('site',1,31)"), /CHECK/);
    assert.throws(() => db.exec("INSERT INTO site_incremental(site_id,enabled,interval) VALUES('site',1,0)"), /CHECK/);
    db.exec("INSERT INTO site_incremental(site_id) VALUES('site')");
    assert.deepEqual({ ...db.prepare('SELECT enabled,interval,force_full FROM site_incremental').get() }, { enabled: 0, interval: 6, force_full: 0 }, 'off by default, one full every 7 backups');
  } finally { db.close(); }
}));

test('a real 2.11.1 database upgrades with every row unchanged and no chain, and 2.11.1 code keeps running on schema 13', { skip: noTag }, () => temporary(async directory => {
  const old = await v2111Migrations(directory), file = join(directory, 'state.sqlite'), db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    assert.equal(old.migrate(db, { file, log: quiet }).to, 11);
    db.exec(`INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('server','Server','host.invalid',22,'root','sealed','${'a'.repeat(64)}','2026-10-28');
      INSERT INTO sites VALUES('site','server','Site','{}','2026-10-28');
      INSERT INTO policies VALUES('site',1,'0 2 * * *','UTC',7,NULL);
      INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES('job','site','backup','completed','completed','2026-10-28');
      INSERT INTO backups VALUES('backup','site','job','2026-10-28','fixture/site.enc',1024,'${'d'.repeat(64)}','{"formatVersion":1}',1,1,'2026-10-28');`);
    const tables = schema(db).filter(row => row.type === 'table').map(row => row.name), rows = contents(db, tables);
    const result = migrate(db, { file, log: quiet });
    assert.equal(result.from, 11); assert.equal(result.to, schemaVersion);
    assert.deepEqual(contents(db, tables.filter(name => name !== 'settings')), Object.fromEntries(Object.entries(rows).filter(([name]) => name !== 'settings')), 'no existing row changes');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM site_incremental').get().n, 0, 'the option stays off for every site');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backup_chain_links').get().n, 0, 'existing backups are full packages outside any chain');
    // Rolling back to 2.11.1: its migrate() accepts the newer, compatible schema and changes nothing.
    const after = schema(db), messages = [];
    assert.deepEqual(old.migrate(db, { file, log: message => messages.push(message) }), { from: schemaVersion, to: schemaVersion, snapshot: null });
    assert.match(messages.join('\n'), /only adds compatible objects/);
    assert.deepEqual(schema(db), after);
    db.exec(`INSERT INTO backups VALUES('backup-2','site','job','2026-10-29','fixture/site-2.enc',1024,'${'e'.repeat(64)}','{}',0,1,'2026-10-29')`);
    db.prepare('INSERT INTO sites VALUES (?,?,?,?,?)').run('site-2', 'server', 'Site 2', '{}', '2026-10-29');
    db.prepare('INSERT INTO policies VALUES (?,0,?,?,7,NULL)').run('site-2', '0 2 * * *', 'UTC');
  } catch (error) { if (/FOREIGN KEY/.test(error.message)) assert.fail('2.11 inserts must not hit the new tables: ' + error.message); throw error; }
  finally { db.close(); }
}));
