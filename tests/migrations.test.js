import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrate, migrations, schemaVersion, listSnapshots, compatFloor, SchemaTooNewError, SnapshotSpaceError } from '../src/migrations.js';

const run = promisify(execFile), quiet = () => {}, shell = spawnSync('sh', ['-c', 'exit 0']).status === 0;
// Objects created by numbered migrations after the v2.0.0 baseline, sorted by name.
// Sorted by name, matching schema().
const addedSinceV2 = ['alert_channels','alert_credentials','alert_queue','alert_queue_dedupe','alert_queue_due','alert_rules','alert_rules_channel','audit_created','backups_captured','boot_recovery_installs','jobs_created','release_history','restore_test_settings','restore_test_settings_due','restore_test_steps','restore_test_steps_no_delete','restore_tests','restore_tests_backup','restore_tests_no_delete','restore_tests_result_once','restore_tests_server_active','restore_tests_site_active','restore_tests_site_created','restores_created','retention_deferrals','server_installs','server_installs_status','site_move_steps','site_moves','site_moves_active','site_moves_created','storage_target_settings','update_checks','update_events','update_preferences','update_requests','update_requests_active','whats_new_seen','worker_lease'];
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

const future = (version, extra = {}) => ({ version, name: 'future' + version, up: target => target.exec(`CREATE TABLE IF NOT EXISTS future_${version} (id TEXT)`), ...extra });

test('a crash loop on a failing migration reuses one snapshot and never evicts older history', () => temporary(async directory => {
  const file = join(directory, 'state.sqlite'), db = legacy(file), snapshots = join(directory, 'upgrade-snapshots');
  const old = migrate(db, { file, now: () => new Date('2026-10-20T08:00:00.000Z'), log: quiet });
  db.exec('PRAGMA user_version=0');
  const broken = [...migrations, future(schemaVersion + 1, { up: () => { throw new Error('broken migration'); } })];
  for (let index = 0; index < 9; index++) assert.throws(() => migrate(db, { file, list: broken, now: () => new Date(Date.UTC(2026, 9, 21, 8, index)), log: quiet }), /broken migration/);
  const names = listSnapshots(snapshots).map(item => item.name);
  db.close();
  assert.ok(names.some(name => old.snapshot.endsWith(name)), 'the earlier snapshot survives');
  assert.equal(names.filter(name => name.includes(`-to-v${schemaVersion + 1}-`)).length, 1, 'identical-source failures reuse one snapshot');
}));

test('stale partial copies are removed and low disk space refuses before the database changes', () => temporary(async directory => {
  const file = join(directory, 'state.sqlite'), db = legacy(file), snapshots = join(directory, 'upgrade-snapshots');
  await mkdir(snapshots, { recursive: true }); await writeFile(join(snapshots, 'state-v0-to-v1-20200101T000000000Z.sqlite.partial'), 'stale');
  assert.throws(() => migrate(db, { file, space: () => ({ bavail: 1, bsize: 1 }), log: quiet }), error => error instanceof SnapshotSpaceError && /database was not changed/.test(error.message));
  assert.equal(version(db), 0); assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='boot_recovery_installs'").get(), undefined);
  assert.deepEqual((await readdir(snapshots)).filter(name => name.endsWith('.partial')), [], 'cleaned before the space check');
  migrate(db, { file, log: quiet });
  assert.equal(version(db), schemaVersion);
  db.close();
}));

test('older code keeps running on a database whose newer migrations are all compatible', () => temporary(async directory => {
  const file = join(directory, 'state.sqlite'), db = legacy(file), additive = [...migrations, future(schemaVersion + 1, { compatible: true })];
  migrate(db, { file, list: additive, log: quiet });
  assert.equal(version(db), schemaVersion + 1);
  assert.deepEqual(migrate(db, { file, log: quiet }), { from: schemaVersion + 1, to: schemaVersion + 1, snapshot: null });
  assert.equal(version(db), schemaVersion + 1);
  migrate(db, { file, list: [...additive, future(schemaVersion + 2)], log: quiet });
  assert.throws(() => migrate(db, { file, log: quiet }), SchemaTooNewError);
  db.close();
}));

// Migration 5 (docs/update-center.md section 3). The documented SQL is the contract: the migrated schema must equal it.
const updateCenter = ['release_history','update_checks','update_events','update_preferences','update_requests','update_requests_active','whats_new_seen'];
const documented = (await readFile(new URL('../docs/update-center.md', import.meta.url), 'utf8')).split(/\r?\n## 3\. Data\r?\n/)[1].split(/```sql\r?\n/)[1].split('```')[0];
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// Real released code from Git history. CI fetches every tag (fetch-depth 0), so there a missing tag fails instead of skipping.
const released = (tag, file) => { try { return execFileSync('git', ['show', `${tag}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }); } catch (error) { if (process.env.CI) throw new Error(`${tag}:${file} is not available; fetch the release tags`, { cause: error }); return null; } };
const v210 = released('v2.1.0', 'src/migrations.js'), noTag = !v210 && 'v2.1.0 tag not fetched';
const v210Migrations = () => temporary(async directory => { const file = join(directory, 'migrations-v2.1.0.mjs'); await writeFile(file, v210); return import(pathToFileURL(file).href); });
// A real 2.1.0 metadata database: the v2.0.0 rows above, migrated by 2.1.0's own src/migrations.js to schema 4.
function v210Database(file, v2) { const db = legacy(file); assert.equal(v2.migrate(db, { file, now: () => new Date('2026-10-20T08:00:00.000Z'), log: quiet }).to, 4); return db; }

test('migration 5 is one compatible `{ version: 5,` line, so upgrade.sh and 2.1.0 keep the floor at 1', async () => {
  const source = (await readFile(new URL('../src/migrations.js', import.meta.url), 'utf8')).split(/\r?\n/), lines = source.filter(line => /^\s*\{\s*version:\s*5\b/.test(line));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ {2}\{ version: 5, name: 'update-center', compatible: true, up: .*\) \},$/);
  assert.deepEqual(source.filter(line => /version:\s*5\b/.test(line)), lines, 'no other line names version 5');
  assert.equal(migrations.find(migration => migration.version === 5).compatible, true); assert.equal(compatFloor(migrations), 1);
});

test('a fresh database gets exactly the documented Update Center schema and no rows', () => temporary(async directory => {
  const file = join(directory, 'state.sqlite'), db = open(file), reference = new DatabaseSync(':memory:'), baselineOnly = new DatabaseSync(':memory:');
  migrate(db, { file, log: quiet });
  baselineOnly.exec(fixture); reference.exec(fixture); reference.exec(documented);
  const expected = schema(reference).filter(row => !schema(baselineOnly).some(item => item.name === row.name));
  assert.deepEqual(expected.map(row => row.name), updateCenter, 'the documented block creates exactly these objects');
  for (const row of expected) assert.deepEqual(schema(db).find(item => item.name === row.name), row, 'migration 5 matches the doc for ' + row.name);
  for (const table of updateCenter.filter(name => name !== 'update_requests_active')) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table + ' starts empty');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='schema_compat_floor'").get().value, '1');
  db.close(); reference.close(); baselineOnly.close();
}));

test('Update Center constraints: single rows, length limits, states, references and one active request', () => temporary(async directory => {
  const file = join(directory, 'state.sqlite'), db = open(file), long = length => 'x'.repeat(length), constraint = /constraint failed/i;
  migrate(db, { file, log: quiet });
  db.exec("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at) VALUES('admin','admin@example.invalid','fixture-hash','fixture-totp','[]',1,'2026-01-01')");
  db.exec("INSERT INTO update_preferences(id,check_enabled,decided_by,decided_at) VALUES(1,1,'admin','2026-10-22')");
  assert.throws(() => db.exec("INSERT INTO update_preferences(id,check_enabled,decided_by,decided_at) VALUES(2,1,'admin','2026-10-22')"), constraint);
  db.exec("UPDATE update_preferences SET check_enabled=0,changed_by='admin',changed_at='2026-10-23'");
  for (const value of [2, -1, "'yes'"]) assert.throws(() => db.exec(`UPDATE update_preferences SET check_enabled=${value}`), constraint, 'check_enabled is 0 or 1, not ' + value);
  assert.equal(db.prepare('SELECT check_enabled FROM update_preferences').get().check_enabled, 0);
  assert.throws(() => db.exec("UPDATE update_preferences SET changed_by='nobody'"), constraint, 'changed_by must be a user');
  const check = db.prepare("INSERT OR IGNORE INTO update_checks(id,status,checked_at,next_check_at) VALUES(1,'ok','2026-10-22',0)");
  check.run(); check.run();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM update_checks').get().count, 1, 'INSERT OR IGNORE keeps one check row');
  assert.throws(() => db.exec("INSERT INTO update_checks(id,status,checked_at,next_check_at) VALUES(2,'ok','2026-10-22',0)"), constraint);
  for (const status of ['failed', 'ok']) db.prepare('UPDATE update_checks SET status=?').run(status);
  for (const status of ['unknown', '', 'OK', 'checking']) assert.throws(() => db.prepare('UPDATE update_checks SET status=?').run(status), constraint, `status ${JSON.stringify(status)} is refused`);
  assert.throws(() => db.exec('UPDATE update_checks SET status=NULL'), constraint);
  for (const [column, max] of Object.entries({ latest_version: 32, manifest: 65536, release_notes: 65536, releases: 16384, etag: 256, error: 2048 })) {
    db.prepare(`UPDATE update_checks SET ${column}=?`).run(long(max));
    assert.throws(() => db.prepare(`UPDATE update_checks SET ${column}=?`).run(long(max + 1)), constraint, column + ' is capped at ' + max);
  }
  const request = db.prepare("INSERT INTO update_requests(id,from_version,to_version,from_schema,requested_by,requested_at,state,retry_of) VALUES(?,'2.2.0','2.2.1',5,'admin','2026-10-22',?,?)");
  request.run('first', 'submitted', null);
  assert.throws(() => request.run('second', 'submitted', null), constraint, 'only one active request');
  for (const state of ['running', 'needs_action']) { db.prepare("UPDATE update_requests SET state=? WHERE id='first'").run(state); assert.throws(() => request.run('second', 'submitted', null), constraint, state + ' stays active'); }
  db.exec("UPDATE update_requests SET state='resolved',accepted_at='2026-10-22',finished_at='2026-10-22',to_schema=5,exit_code=5 WHERE id='first'");
  request.run('second', 'rolled_back', 'first'); request.run('third', 'submitted', 'second');
  for (const state of ['succeeded', 'refused', 'busy', 'lost']) request.run(state, state, null);
  for (const state of ['unknown', 'zzz', '', 'Submitted', 'needs-action']) assert.throws(() => request.run('fourth', state, null), constraint, `state ${JSON.stringify(state)} is refused`);
  assert.throws(() => request.run('fourth', null, null), constraint);
  assert.throws(() => db.exec("UPDATE update_requests SET state='zzz' WHERE id='first'"), constraint);
  assert.throws(() => request.run('fourth', 'refused', 'missing'), constraint, 'retry_of names an earlier request');
  for (const [column, max] of Object.entries({ refusal: 64, warning: 1024, error: 2048, rollback_hint: 4096, reason: 64, updater_version: 32, env: 1024 })) {
    db.prepare(`UPDATE update_requests SET ${column}=? WHERE id='first'`).run(long(max));
    assert.throws(() => db.prepare(`UPDATE update_requests SET ${column}=? WHERE id='first'`).run(long(max + 1)), constraint, column + ' is capped at ' + max);
  }
  // The run's own report values (section 7.1) are optional: a run recorded before they were known keeps nulls.
  db.exec("UPDATE update_requests SET reason='health-timeout-api',install_mode='image',updater_version='1.4.0',env='{\"arch\":\"amd64\"}' WHERE id='second'");
  db.exec("UPDATE update_requests SET install_mode='source' WHERE id='third'");
  for (const mode of ['docker', '', 'Image']) assert.throws(() => db.prepare("UPDATE update_requests SET install_mode=? WHERE id='third'").run(mode), constraint, `install_mode ${JSON.stringify(mode)} is refused`);
  assert.deepEqual({ ...db.prepare("SELECT reason,install_mode,updater_version,env FROM update_requests WHERE id='succeeded'").get() }, { reason: null, install_mode: null, updater_version: null, env: null });
  const history = db.prepare('INSERT INTO release_history VALUES(?,?,?,?)');
  history.run(long(32), 0, '2026-10-22', '2026-10-22');
  assert.throws(() => history.run(long(33), 5, '2026-10-22', '2026-10-22'), constraint, 'release_history.version is capped at 32');
  for (const schemaValue of [-1, 'five', 4.5]) assert.throws(() => history.run('2.2.0', schemaValue, '2026-10-22', '2026-10-22'), constraint, `schema_version ${schemaValue} is refused`);
  const event = db.prepare("INSERT INTO update_events VALUES('third','2026-10-22T00:00:00.000Z',?)");
  event.run(long(32));
  assert.throws(() => event.run(long(32)), constraint, 'one row per phase and time');
  assert.throws(() => event.run(long(33)), constraint);
  assert.throws(() => db.exec("INSERT INTO update_events VALUES('missing','2026-10-22','idle')"), constraint);
  db.exec("INSERT INTO whats_new_seen VALUES('admin','2.2.0','2026-10-22')");
  assert.throws(() => db.exec("INSERT INTO whats_new_seen VALUES('nobody','2.2.0','2026-10-22')"), constraint);
  db.close();
}));

test('a real 2.1.0 database migrates to the current schema with its data intact, one v4 snapshot and floor 1', { skip: noTag }, () => temporary(async directory => {
  const v2 = await v210Migrations(), file = join(directory, 'state.sqlite'), db = v210Database(file, v2), before = schema(db);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='schema_compat_floor'").get().value, '1');
  db.exec(`INSERT INTO audit_events VALUES('audit','user','site.created','site','{}','2026-10-20');
    INSERT INTO worker_lease VALUES('worker','holder','2026-10-20','2026-10-20',1);
    INSERT INTO retention_deferrals VALUES('backup',1,NULL,1);`);
  // Every row of every pre-existing table, except the floor setting migrate() rewrites to its unchanged value.
  const contents = () => Object.fromEntries(before.filter(row => row.type === 'table').map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map(row => ({ ...row })).filter(row => name !== 'settings' || row.key !== 'schema_compat_floor')]));
  const rows = contents();
  assert.ok(Object.values(rows).filter(list => list.length).length >= 10, 'the fixture has rows in most tables');
  const result = migrate(db, { file, now: () => new Date('2026-10-22T08:00:00.000Z'), log: quiet });
  assert.deepEqual(contents(), rows, 'migrations 5 and 6 write no rows to existing tables');
  assert.equal(result.from, 4); assert.equal(result.to, schemaVersion);
  assert.match(result.snapshot, new RegExp(`state-v4-to-v${schemaVersion}-20261022T080000000Z\\.sqlite$`));
  for (const row of before) assert.deepEqual(schema(db).find(item => item.name === row.name), row, '2.1.0 objects keep their definition');
  assert.deepEqual(schema(db).map(row => row.name).filter(name => !before.some(row => row.name === name)), [...updateCenter, ...siteMoves, ...serverInstalls, 'alert_channels', 'alert_credentials', 'alert_queue', 'alert_queue_dedupe', 'alert_queue_due', 'alert_rules', 'alert_rules_channel', ...restoreTests].sort());
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='schema_compat_floor'").get().value, '1');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1, 'signed-in sessions survive');
  assert.equal(db.prepare("SELECT role FROM users WHERE id='user'").get().role, 'admin');
  assert.equal(db.prepare('SELECT path FROM backups').get().path, 'fixture.enc');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(migrate(db, { file, log: quiet }), { from: schemaVersion, to: schemaVersion, snapshot: null }, 'a restart migrates nothing and takes no snapshot');
  db.close();
  const copy = new DatabaseSync(result.snapshot, { readOnly: true });
  assert.equal(version(copy), 4); assert.equal(copy.prepare("SELECT 1 FROM sqlite_master WHERE name='update_requests'").get(), undefined);
  copy.close();
}));

test('the real 2.1.0 code starts on a current-schema database without changing it, and so does the 2.0.0 baseline', { skip: noTag }, () => temporary(async directory => {
  const v2 = await v210Migrations(), file = join(directory, 'state.sqlite'), db = v210Database(file, v2), snapshots = () => listSnapshots(join(directory, 'upgrade-snapshots')).map(item => item.name);
  try {
    migrate(db, { file, log: quiet });
    db.exec("INSERT INTO update_checks(id,status,checked_at,next_check_at) VALUES(1,'ok','2026-10-22',0)");
    const after = schema(db), taken = snapshots(), messages = [];
    assert.deepEqual(v2.migrate(db, { file, log: message => messages.push(message) }), { from: schemaVersion, to: schemaVersion, snapshot: null });
    assert.match(messages.join('\n'), new RegExp(`schema v${schemaVersion} is newer than this release \\(v4\\) but only adds compatible objects`));
    assert.equal(version(db), schemaVersion); assert.deepEqual(schema(db), after); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM update_checks').get().count, 1);
    assert.deepEqual(snapshots(), taken, 'the rollback takes no snapshot');
    // 2.1.0 keeps writing its own tables; 2.0.0 has no schema check and re-runs its baseline as CREATE ... IF NOT EXISTS.
    db.exec("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES('job-2','site','backup','queued','queued','2026-10-22')");
    db.exec(fixture.replace(/^CREATE (UNIQUE )?(TABLE|INDEX) /gm, 'CREATE $1$2 IF NOT EXISTS ')); assert.deepEqual(schema(db), after);
  } finally { db.close(); }
}));

test('the real 2.1.0 upgrade.sh and this one read this migrations file as the current schema, floor 1', { skip: (!shell && 'needs sh') || noTag }, () => temporary(async directory => {
  const script = join(directory, 'upgrade-v2.1.0.sh'); await writeFile(script, released('v2.1.0', 'scripts/upgrade.sh'));
  for (const candidate of [script, join(root, 'scripts/upgrade.sh')]) {
    const result = spawnSync('sh', [candidate, '--print-schema'], { cwd: root, encoding: 'utf8', env: { ...process.env, DOCKNEST_DIR: root } });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), `${schemaVersion} 1`, candidate);
  }
}));

// Migration 6 (docs/moving-sites.md): site moves and their per-step journal. Additive, so 2.4.x keeps running on it.
const siteMoves = ['site_move_steps','site_moves','site_moves_active','site_moves_created'];
const serverInstalls = ['server_installs','server_installs_status'];
const restoreTests = ['restore_test_settings','restore_test_settings_due','restore_test_steps','restore_test_steps_no_delete','restore_tests','restore_tests_backup','restore_tests_no_delete','restore_tests_result_once','restore_tests_server_active','restore_tests_site_active','restore_tests_site_created'];
const v241 = released('v2.4.1', 'src/migrations.js'), noTag241 = !v241 && 'v2.4.1 tag not fetched';
const v241Migrations = () => temporary(async directory => { const file = join(directory, 'migrations-v2.4.1.mjs'); await writeFile(file, v241); return import(pathToFileURL(file).href); });

test('migration 6 is one compatible `{ version: 6,` line and keeps the floor at 1', async () => {
  const source = (await readFile(new URL('../src/migrations.js', import.meta.url), 'utf8')).split(/\r?\n/), lines = source.filter(line => /^\s*\{\s*version:\s*6\b/.test(line));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ {2}\{ version: 6, name: 'site-moves', compatible: true, up: .*\) \},$/);
  assert.ok(schemaVersion >= 6); assert.equal(compatFloor(migrations), 1);
});

test('migration 7 is one compatible `{ version: 7,` line that only adds server_installs', async () => {
  const source = (await readFile(new URL('../src/migrations.js', import.meta.url), 'utf8')).split(/\r?\n/), lines = source.filter(line => /^\s*\{\s*version:\s*7\b/.test(line));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ {2}\{ version: 7, name: 'server-installs', compatible: true, up: .*\) \},$/);
  assert.ok(schemaVersion >= 7); assert.equal(migrations.find(item => item.version === 7).compatible, true); assert.equal(compatFloor(migrations), 1);
});

test('site move tables start empty and enforce one unfinished move per site, valid steps and cascading journals', () => temporary(async directory => {
  const file = join(directory, 'state.sqlite'), db = legacy(file), constraint = /constraint failed/i;
  migrate(db, { file, log: quiet });
  for (const table of ['site_moves', 'site_move_steps']) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
  db.exec("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('target','target','target.example.invalid',22,'root','sealed','SHA256:t','2026-01-01')");
  const insert = (id, state, changes = {}) => db.prepare('INSERT INTO site_moves(id,site_id,source_server_id,target_server_id,state,options,preflight,preflight_hash,actor,created_at,updated_at,cancel_requested) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, changes.site ?? 'site', 'server', changes.target ?? 'target', state, '{}', '{}', 'hash', 'user', '2026-10-23', '2026-10-23', changes.cancel ?? 0);
  insert('m1', 'running');
  assert.throws(() => insert('m2', 'queued'), constraint, 'a second unfinished move of the same site is refused');
  assert.throws(() => insert('m3', 'completed'), constraint, 'a completed move still holds the old copy and the slot');
  db.exec("UPDATE site_moves SET state='rolled_back' WHERE id='m1'");
  insert('m4', 'queued');
  assert.throws(() => insert('m5', 'cancelled', { target: 'server' }), constraint, 'source and target must differ');
  assert.throws(() => insert('m6', 'cancelled', { target: 'missing' }), constraint, 'target must be a known server');
  assert.throws(() => insert('m7', 'cancelled', { site: 'missing' }), constraint, 'site must exist');
  assert.throws(() => insert('m8', 'cancelled', { cancel: 2 }), constraint);
  const step = db.prepare('INSERT INTO site_move_steps(move_id,step,attempt,state) VALUES(?,?,?,?)');
  step.run('m4', 'preflight', 0, 'pending');
  assert.throws(() => step.run('m4', 'preflight', 1, 'running'), constraint, 'one journal row per step');
  assert.throws(() => step.run('m4', 'backup', 0, 'exploded'), constraint);
  assert.throws(() => step.run('m4', 'backup', -1, 'pending'), constraint);
  assert.throws(() => step.run('missing', 'backup', 0, 'pending'), constraint);
  assert.deepEqual({ ...db.prepare("SELECT resources,result FROM site_move_steps WHERE move_id='m4'").get() }, { resources: '{}', result: '{}' });
  db.exec("DELETE FROM site_moves WHERE id='m4'");
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM site_move_steps').get().count, 0, 'deleting a move removes its journal');
  // Existing behaviour is untouched: retention can still delete a backup a move refers to.
  insert('m9', 'running');
  db.exec("UPDATE site_moves SET backup_id='backup' WHERE id='m9'; DELETE FROM backups WHERE id='backup';");
  db.close();
}));

test('a real 2.4.1 database (schema 5) migrates to the current schema with its data intact and one v5-to-v7 snapshot', { skip: noTag241 }, () => temporary(async directory => {
  const v2 = await v241Migrations(), file = join(directory, 'state.sqlite'), db = legacy(file);
  assert.equal(v2.migrate(db, { file, now: () => new Date('2026-10-22T08:00:00.000Z'), log: quiet }).to, 5);
  db.exec("INSERT INTO update_checks(id,status,checked_at,next_check_at) VALUES(1,'ok','2026-10-22',0)");
  const before = schema(db), contents = () => Object.fromEntries(before.filter(row => row.type === 'table').map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map(row => ({ ...row })).filter(row => name !== 'settings' || row.key !== 'schema_compat_floor')]));
  const rows = contents(), result = migrate(db, { file, list: migrations.slice(0, 7), now: () => new Date('2026-10-23T08:00:00.000Z'), log: quiet });
  assert.deepEqual({ from: result.from, to: result.to }, { from: 5, to: 7 });
  assert.match(result.snapshot, /state-v5-to-v7-20261023T080000000Z\.sqlite$/);
  assert.deepEqual(contents(), rows, 'migrations 6 and 7 write no rows to existing tables');
  for (const row of before) assert.deepEqual(schema(db).find(item => item.name === row.name), row, '2.4.1 objects keep their definition');
  assert.deepEqual(schema(db).map(row => row.name).filter(name => !before.some(row => row.name === name)).sort(), [...siteMoves, ...serverInstalls].sort());
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='schema_compat_floor'").get().value, '1');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  db.close();
}));

test('the real 2.4.1 code starts on a schema 7 database without changing it', { skip: noTag241 }, () => temporary(async directory => {
  const v2 = await v241Migrations(), file = join(directory, 'state.sqlite'), db = legacy(file), messages = [];
  try {
    migrate(db, { file, list: migrations.slice(0, 7), log: quiet });
    const after = schema(db);
    assert.deepEqual(v2.migrate(db, { file, log: message => messages.push(message) }), { from: 7, to: 7, snapshot: null });
    assert.match(messages.join('\n'), /schema v7 is newer than this release \(v5\) but only adds compatible objects/);
    assert.equal(version(db), 7); assert.deepEqual(schema(db), after);
  } finally { db.close(); }
}));

// Migration 7: the optional install runs. One table and one index, nothing else touched.
const v260 = released('v2.6.0', 'src/migrations.js'), noTag260 = !v260 && 'v2.6.0 tag not fetched';
test('a real 2.6.0 database (schema 6) migrates to 7 adding only server_installs, and 2.6.0 code keeps running on it', { skip: noTag260 }, () => temporary(async directory => {
  const file260 = join(directory, 'migrations-v2.6.0.mjs'); await writeFile(file260, v260);
  const v2 = await import(pathToFileURL(file260).href), file = join(directory, 'state.sqlite'), db = legacy(file), messages = [];
  try {
    assert.equal(v2.migrate(db, { file, now: () => new Date('2026-10-23T08:00:00.000Z'), log: quiet }).to, 6);
    const before = schema(db), jobs = db.prepare('SELECT * FROM jobs').all().map(row => ({ ...row }));
    const result = migrate(db, { file, list: migrations.slice(0, 7), now: () => new Date('2026-10-24T08:00:00.000Z'), log: quiet });
    assert.deepEqual({ from: result.from, to: result.to }, { from: 6, to: 7 });
    for (const row of before) assert.deepEqual(schema(db).find(item => item.name === row.name), row, '2.6.0 objects keep their definition');
    assert.deepEqual(schema(db).map(row => row.name).filter(name => !before.some(row => row.name === name)).sort(), serverInstalls);
    assert.deepEqual(db.prepare('SELECT * FROM jobs').all().map(row => ({ ...row })), jobs);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(v2.migrate(db, { file, log: message => messages.push(message) }), { from: 7, to: 7, snapshot: null });
    assert.match(messages.join('\n'), /schema v7 is newer than this release \(v6\) but only adds compatible objects/);
  } finally { db.close(); }
}));
