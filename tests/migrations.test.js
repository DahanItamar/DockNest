import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, migrations, schemaVersion, listSnapshots, SchemaTooNewError } from '../src/migrations.js';

const run = promisify(execFile), quiet = () => {};
// Objects created by numbered migrations after the v2.0.0 baseline, sorted by name.
const addedSinceV2 = ['boot_recovery_installs'];
const fixture = await readFile(new URL('./fixtures/v2.0.0-schema.sql', import.meta.url), 'utf8');
const schema = db => db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all().map(row => ({ ...row }));
const version = db => db.prepare('PRAGMA user_version').get().user_version;
async function temporary(fn) { const directory = await mkdtemp(join(tmpdir(), 'docknest-migrations-')); try { return await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); } }
function open(file) { const db = new DatabaseSync(file); db.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;'); return db; }
// A v2.0.0 metadata database: v2.0.0 schema, user_version 0 and synthetic rows only.
function legacy(file) {
  const db = open(file); db.exec(fixture);
  db.exec(`
    INSERT INTO settings VALUES('auth_epoch','0');
    INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES('user','admin@example.invalid','fixture-hash','fixture-totp','[]',1,'2026-01-01','Admin','admin');
    INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES('session','user','csrf',9999999999999,1,1,1);
    INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('server','fixture','host.example.invalid',22,'root','sealed-fixture','SHA256:fixture','2026-01-01');
    INSERT INTO sites VALUES('site','server','fixture','{"domains":["site.example.invalid"]}','2026-01-01');
    INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES('job','site','backup','completed','completed','2026-01-01');
    INSERT INTO backups VALUES('backup','site','job','2026-01-01','fixture.enc',10,'fixture','{}',0,1,'2026-01-01');
  `);
  return db;
}

test('fresh database gets the exact v2.0.0 schema and the current schema version without a snapshot', () => temporary(async directory => {
  const file = join(directory, 'state.sqlite'), db = open(file), result = migrate(db, { file, log: quiet });
  const reference = new DatabaseSync(':memory:'); reference.exec(fixture);
  assert.deepEqual(result, { from: 0, to: schemaVersion, snapshot: null });
  assert.equal(version(db), schemaVersion);
  for (const row of schema(reference)) assert.deepEqual(schema(db).find(item => item.name === row.name), row, 'baseline keeps the v2.0.0 definition of ' + row.name);
  assert.deepEqual(schema(db).map(row => row.name).filter(name => !schema(reference).some(row => row.name === name)), addedSinceV2);
  assert.deepEqual(listSnapshots(join(directory, 'upgrade-snapshots')), []);
  // Restarting the current release is a no-op that keeps the version.
  assert.deepEqual(migrate(db, { file, log: quiet }), { from: schemaVersion, to: schemaVersion, snapshot: null });
  db.close(); reference.close();
}));

test('v2.0.0 database is migrated in place with data intact after a private consistent snapshot', () => temporary(async directory => {
  const file = join(directory, 'state.sqlite'), db = legacy(file), before = schema(db);
  const result = migrate(db, { file, now: () => new Date('2026-10-21T08:00:00.000Z'), log: quiet });
  assert.equal(result.from, 0); assert.equal(result.to, schemaVersion);
  assert.match(result.snapshot, /upgrade-snapshots[\\/]state-v0-to-v\d+-20261021T080000000Z\.sqlite$/);
  if (process.platform !== 'win32') assert.equal((await stat(result.snapshot)).mode & 0o777, 0o600);
  assert.equal(version(db), schemaVersion);
  for (const row of before) assert.deepEqual(schema(db).find(item => item.name === row.name), row, 'v2.0.0 objects keep their definition');
  assert.equal(db.prepare('SELECT email FROM users').get().email, 'admin@example.invalid');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1, 'current sessions survive the upgrade');
  assert.equal(db.prepare('SELECT host FROM servers').get().host, 'host.example.invalid');
  assert.equal(JSON.parse(db.prepare('SELECT config FROM sites').get().config).domains[0], 'site.example.invalid');
  assert.equal(db.prepare('SELECT path FROM backups').get().path, 'fixture.enc');
  db.close();
  const copy = new DatabaseSync(result.snapshot, { readOnly: true });
  assert.equal(version(copy), 0); assert.equal(copy.prepare('SELECT COUNT(*) AS count FROM backups').get().count, 1); assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  copy.close();
  assert.deepEqual((await readdir(join(directory, 'upgrade-snapshots'))).filter(name => name.endsWith('.partial')), []);
}));

test('a newer schema refuses to start, names the rollback snapshot and changes nothing', () => temporary(async directory => {
  const file = join(directory, 'state.sqlite'), db = legacy(file), newer = schemaVersion + 1;
  migrate(db, { file, list: [...migrations, { version: newer, name: 'future', up: target => target.exec('CREATE TABLE future_feature (id TEXT)') }], now: () => new Date('2026-10-21T09:00:00.000Z'), log: quiet });
  assert.throws(() => migrate(db, { file, log: quiet }), error => error instanceof SchemaTooNewError && error.message.includes(`schema v${newer} is newer`) && error.message.includes(`state-v0-to-v${newer}-20261021T090000000Z.sqlite`) && error.message.includes('docs/upgrading.md'));
  assert.equal(version(db), newer); assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='future_feature'").get());
  db.close();
}));

test('a failing migration rolls back the version and schema but keeps its snapshot', () => temporary(async directory => {
  const file = join(directory, 'state.sqlite'), db = legacy(file);
  assert.throws(() => migrate(db, { file, list: [...migrations, { version: schemaVersion + 1, name: 'broken', up: target => { target.exec('CREATE TABLE half_done (id TEXT)'); throw new Error('broken migration'); } }], log: quiet }), /broken migration/);
  assert.equal(version(db), 0); assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='half_done'").get(), undefined);
  assert.equal(listSnapshots(join(directory, 'upgrade-snapshots')).length, 1);
  db.close();
}));

test('snapshot rotation keeps the newest five and ignores unrelated files', () => temporary(async directory => {
  const file = join(directory, 'state.sqlite'), db = legacy(file), snapshots = join(directory, 'upgrade-snapshots');
  migrate(db, { file, now: () => new Date('2026-10-21T09:00:00.000Z'), log: quiet });
  await writeFile(join(snapshots, 'operator-notes.txt'), 'keep');
  for (let index = 0; index < 7; index++) { db.exec('PRAGMA user_version=0'); migrate(db, { file, now: () => new Date(Date.UTC(2026, 9, 21, 10, index)), log: quiet }); }
  const kept = listSnapshots(snapshots);
  assert.equal(kept.length, 5);
  assert.deepEqual(kept.map(item => item.at), [2, 3, 4, 5, 6].map(minute => `20261021T10${String(minute).padStart(2, '0')}00000Z`));
  assert.ok((await readdir(snapshots)).includes('operator-notes.txt'));
  db.close();
}));

test('API and worker starting together on a v2.0.0 database migrate once with one snapshot', () => temporary(async directory => {
  legacy(join(directory, 'state.sqlite')).close();
  const env = { ...process.env, DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), NODE_ENV: 'test' };
  const start = () => run(process.execPath, ['--input-type=module', '-e', "const {db}=await import('./src/db.js');console.log(db.prepare('PRAGMA user_version').get().user_version);db.close();"], { env });
  const outputs = await Promise.all([start(), start(), start()]);
  for (const { stdout } of outputs) assert.equal(Number(stdout.trim()), schemaVersion);
  assert.equal(listSnapshots(join(directory, 'upgrade-snapshots')).length, 1);
  const db = new DatabaseSync(join(directory, 'state.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM backups').get().count, 1); db.close();
}));
