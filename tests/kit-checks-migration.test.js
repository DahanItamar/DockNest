// The kit check and emergency key migration (docs/emergency-kit.md, "Data"): two additive, compatible tables; a 2.16.5-era
// database upgrades with every row and object kept, gets no emergency key row (the split stays off), and restarts as a no-op.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, migrations, compatFloor } from '../src/migrations.js';

const quiet = () => {}, ours = migrations.find(migration => migration.name === 'kit-checks-emergency-keys');
const upTo = version => migrations.filter(migration => migration.version <= version);
const previous = migrations[migrations.indexOf(ours) - 1];
const schema = db => db.prepare('SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all().map(row => ({ ...row }));
async function withDatabase(work) {
  const directory = await mkdtemp(join(tmpdir(), 'docknest-kit-checks-migration-')); let db;
  try {
    const file = join(directory, 'state.sqlite'); db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;');
    await work(db, file);
  } finally { db?.close(); await rm(directory, { recursive: true, force: true }); }
}

test('the migration is one compatible line named kit-checks-emergency-keys and the floor stays 1', async () => {
  const lines = (await readFile(new URL('../src/migrations.js', import.meta.url), 'utf8')).split(/\r?\n/).filter(line => line.includes("name: 'kit-checks-emergency-keys'"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ {2}\{ version: \d+, name: 'kit-checks-emergency-keys', compatible: true, up: db => db\.exec\(kitChecksSchema\) \},$/);
  assert.equal(ours.compatible, true); assert.equal(compatFloor(migrations), 1);
});

test('a 2.16.5-era database gains only the two tables and their indexes, keeps every row, and has no emergency key', () => withDatabase((db, file) => {
  migrate(db, { file, list: upTo(previous.version), log: quiet });
  db.prepare("INSERT INTO settings VALUES('manager_backup_config',?)").run(JSON.stringify({ enabled: true, schedule: '0 3 * * *', timezone: 'UTC', nextRun: null, passphrase: 'sealed-fixture' }));
  db.prepare("INSERT INTO manager_backups(id,status,created_at,finished_at,checksum,size,release) VALUES('kit','completed','2026-11-01','2026-11-01',?,1024,'2.16.5')").run('a'.repeat(64));
  const before = schema(db), rows = table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map(row => ({ ...row }));
  const kept = { settings: rows('settings').filter(row => row.key !== 'schema_compat_floor'), manager_backups: rows('manager_backups') };
  const result = migrate(db, { file, list: upTo(ours.version), log: quiet });
  assert.equal(result.from, previous.version); assert.equal(result.to, ours.version);
  for (const row of before) assert.deepEqual(schema(db).find(item => item.name === row.name), row, `${row.name} keeps its definition`);
  assert.deepEqual(schema(db).map(row => row.name).filter(name => !before.some(row => row.name === name)).sort(), ['emergency_keys', 'emergency_keys_active', 'kit_checks', 'kit_checks_active', 'kit_checks_created']);
  assert.deepEqual({ settings: rows('settings').filter(row => row.key !== 'schema_compat_floor'), manager_backups: rows('manager_backups') }, kept, 'every row exactly as before');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM emergency_keys').get().n, 0, 'one passphrase stays the default');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kit_checks').get().n, 0);
  assert.deepEqual(migrate(db, { file, list: upTo(ours.version), log: quiet }), { from: ours.version, to: ours.version, snapshot: null });
}));

test('the tables hold one active check and one active key at most, and only public key material', () => withDatabase((db, file) => {
  migrate(db, { file, list: upTo(ours.version), log: quiet });
  const check = db.prepare('INSERT INTO kit_checks(id,requested_by,created_at,result,reason) VALUES(?,?,?,?,?)');
  check.run('a', 'worker', '2026-11-19', 'queued', null);
  assert.throws(() => check.run('b', 'worker', '2026-11-19', 'running', null), /UNIQUE/);
  check.run('c', 'worker', '2026-11-19', 'failed', 'key_mismatch');
  assert.throws(() => check.run('d', 'worker', '2026-11-19', 'unknown', null), /CHECK/);
  assert.throws(() => check.run('e', 'worker', '2026-11-19', 'failed', 'x'.repeat(33)), /CHECK/);
  const key = db.prepare('INSERT INTO emergency_keys(id,public_key,digest,identifier,k,n,labels,created_by,created_at,retired_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  key.run('k1', 'A'.repeat(43), '1'.repeat(64), 7, 2, 3, '[]', 'admin', '2026-11-19', null);
  assert.throws(() => key.run('k2', 'B'.repeat(43), '2'.repeat(64), 7, 2, 3, '[]', 'admin', '2026-11-19', null), /UNIQUE/, 'one active key');
  key.run('k3', 'B'.repeat(43), '2'.repeat(64), 7, 2, 3, '[]', 'admin', '2026-11-19', '2026-11-19');
  for (const [k, n] of [[1, 3], [4, 3], [2, 17]]) assert.throws(() => key.run('k' + k + n, 'C'.repeat(43), '3'.repeat(64), 1, k, n, '[]', 'admin', 'x', 'x'), /CHECK/);
  assert.deepEqual(db.prepare('PRAGMA table_info(emergency_keys)').all().map(column => column.name), ['id', 'public_key', 'digest', 'identifier', 'k', 'n', 'labels', 'created_by', 'created_at', 'retired_at']);
}));
