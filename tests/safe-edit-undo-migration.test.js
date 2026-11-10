// Migration 18 (Undo of a Safe Edit Replace): one additive, compatible table and index; a 2.16 database upgrades with every
// row and object kept, restarting is a no-op, and the table follows the rules of the undo copy (docs/safe-edit.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, migrations, compatFloor, schemaVersion } from '../src/migrations.js';

const quiet = () => {};
const schema = db => db.prepare('SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all().map(row => ({ ...row }));
async function withDatabase(work) {
  const directory = await mkdtemp(join(tmpdir(), 'docknest-edit-undo-migration-')); let db;
  try {
    const file = join(directory, 'state.sqlite'); db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;');
    await work(db, file);
  } finally { db?.close(); await rm(directory, { recursive: true, force: true }); }
}

test('migration 18 is one compatible `{ version: 18,` line named safe-edit-undo and the floor stays 1', async () => {
  const lines = (await readFile(new URL('../src/migrations.js', import.meta.url), 'utf8')).split(/\r?\n/).filter(line => /^\s*\{\s*version:\s*18\b/.test(line));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ {2}\{ version: 18, name: 'safe-edit-undo', compatible: true, up: db => db\.exec\(safeEditUndoSchema\) \},$/);
  assert.ok(schemaVersion >= 18); assert.equal(compatFloor(migrations), 1);
  assert.deepEqual(migrations.slice(0, 18).map(migration => migration.version), Array.from({ length: 18 }, (_, index) => index + 1), 'versions stay contiguous');
});

test('a 2.16 database (schema 17) gains only the undo table and index, keeps every row and object, and restarts as a no-op', () => withDatabase((db, file) => {
  migrate(db, { file, list: migrations.slice(0, 17), log: quiet });
  db.prepare("INSERT INTO settings VALUES('probe','kept')").run();
  db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('s','n','h',22,'root','k','f','2026-01-01')").run();
  db.prepare("INSERT INTO sites VALUES('site','s','shop','{}','2026-01-01')").run();
  db.prepare("INSERT INTO site_edits(id,site_id,server_id,state,result,created_by,created_at) VALUES('e','site','s','done','applied','u','2026-01-01')").run();
  const before = schema(db), rows = table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map(row => ({ ...row }));
  const kept = { settings: rows('settings').filter(row => row.key !== 'schema_compat_floor'), sites: rows('sites'), site_edits: rows('site_edits') };
  const result = migrate(db, { file, list: migrations.slice(0, 18), now: () => new Date('2026-11-09T08:00:00.000Z'), log: quiet });
  assert.equal(result.from, 17); assert.equal(result.to, 18); assert.match(result.snapshot, /state-v17-to-v18-/);
  for (const row of before) assert.deepEqual(schema(db).find(item => item.name === row.name), row, `${row.name} keeps its definition`);
  assert.deepEqual(schema(db).map(row => row.name).filter(name => !before.some(row => row.name === name)).sort(), ['site_edit_undo', 'site_edit_undo_site']);
  assert.deepEqual({ settings: rows('settings').filter(row => row.key !== 'schema_compat_floor'), sites: rows('sites'), site_edits: rows('site_edits') }, kept, 'every row exactly as before');
  assert.deepEqual(migrate(db, { file, list: migrations.slice(0, 18), log: quiet }), { from: 18, to: 18, snapshot: null });
  // The undo copy belongs to an edit and a site; a payload is bounded; no row is needed for old edits.
  db.prepare("INSERT INTO site_edit_undo VALUES('e','site','sealed','2026-11-09')").run();
  db.prepare("UPDATE site_edit_undo SET payload=NULL WHERE edit_id='e'").run();
  assert.throws(() => db.prepare("INSERT INTO site_edit_undo VALUES('nope','site',NULL,'x')").run(), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO site_edit_undo VALUES('e2','site',?,'x')").run('x'.repeat(4194305)), /CHECK|FOREIGN/);
}));
