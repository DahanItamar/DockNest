// Migration 17 (launch a new site, docs/launch-site.md "Data model" and "Upgrade safety"): compatible, keeps every row,
// adds only the launch and deploy key objects, widens server_installs to allow 'git' without touching its rows, and the
// constraints that back up the engine: one queued or running launch per server, one live slug per server, append-only
// history, a failure written once.
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
  const directory = await mkdtemp(join(tmpdir(), 'docknest-launch-migration-')); let db;
  try {
    const file = join(directory, 'state.sqlite'); db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;');
    migrate(db, { file, list: migrations.slice(0, upTo), log: quiet });
    await work(db, file);
  } finally { db?.close(); await rm(directory, { recursive: true, force: true }); }
}
const NEW_OBJECTS = ['deploy_keys', 'site_launch_steps', 'site_launch_steps_jobs', 'site_launch_steps_no_delete', 'site_launches', 'site_launches_no_delete', 'site_launches_reason_once', 'site_launches_server_active', 'site_launches_server_created', 'site_launches_server_slug'];

test('migrations 15 and 16 are reserved no-ops for 2.15 and 17 is one compatible site-launches line; the floor stays 1', async () => {
  const source = (await readFile(new URL('../src/migrations.js', import.meta.url), 'utf8')).split(/\r?\n/);
  for (const version of [15, 16]) {
    const lines = source.filter(line => new RegExp(`^\\s*\\{\\s*version:\\s*${version}\\b`).test(line));
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`^ {2}\\{ version: ${version}, name: 'reserved-2\\.15', compatible: true, up: \\(\\) => \\{\\} \\},$`));
  }
  assert.match(source.filter(line => /^\s*\{\s*version:\s*17\b/.test(line))[0], /^ {2}\{ version: 17, name: 'site-launches', compatible: true, up: siteLaunches \},$/);
  assert.ok(schemaVersion >= 17); assert.equal(compatFloor(migrations), 1);
  assert.deepEqual(migrations.slice(0, 17).map(migration => migration.version), Array.from({ length: 17 }, (_, index) => index + 1), 'versions stay contiguous');
});

test('a 14-schema (2.14.x) database gains only the launch objects, keeps every row and its installs, and restarts as a no-op', () => withDatabase(14, async (db, file) => {
  db.prepare("INSERT INTO settings VALUES('probe','kept')").run();
  db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('s','n','h',22,'root','k','f','2026-01-01')").run();
  db.prepare("INSERT INTO sites VALUES('site','s','shop','{}','2026-01-01')").run();
  for (const [installId, pkg, status] of [['i1', 'nginx', 'completed'], ['i2', 'certbot', 'failed'], ['i3', 'docker', 'queued']]) db.prepare("INSERT INTO server_installs(id,server_id,package,status,stage,steps,actor,error,created_at) VALUES(?,?,?,?,?,'[]','admin',?,'2026-01-02')").run(installId, 's', pkg, status, status, status === 'failed' ? 'reason' : null);
  assert.throws(() => db.prepare("INSERT INTO server_installs(id,server_id,package,status,stage,steps,actor,created_at) VALUES('x','s','git','queued','queued','[]','a','x')").run(), /CHECK constraint failed/, '2.14 refuses git');
  const before = schema(db), installs = db.prepare('SELECT * FROM server_installs ORDER BY id').all().map(row => ({ ...row }));
  const result = migrate(db, { file, list: migrations.slice(0, 17), now: () => new Date('2026-11-02T08:00:00.000Z'), log: quiet });
  assert.equal(result.from, 14); assert.equal(result.to, 17); assert.match(result.snapshot, /state-v14-to-v17-/);
  for (const row of before.filter(item => !item.name.startsWith('server_installs'))) assert.deepEqual(schema(db).find(item => item.name === row.name), row, `${row.name} keeps its definition`);
  assert.deepEqual(schema(db).map(row => row.name).filter(name => !before.some(row => row.name === name)).sort(), NEW_OBJECTS);
  assert.deepEqual(db.prepare('SELECT * FROM server_installs ORDER BY id').all().map(row => ({ ...row })), installs, 'install rows are copied unchanged');
  assert.deepEqual(db.prepare('PRAGMA table_info(server_installs)').all().map(row => row.name), ['id', 'server_id', 'package', 'status', 'stage', 'steps', 'actor', 'error', 'created_at', 'started_at', 'finished_at']);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='server_installs_status'").get(), 'the install index is kept');
  db.prepare("INSERT INTO server_installs(id,server_id,package,status,stage,steps,actor,created_at) VALUES('g','s','git','queued','queued','[]','a','x')").run();
  assert.throws(() => db.prepare("INSERT INTO server_installs(id,server_id,package,status,stage,steps,actor,created_at) VALUES('y','s','curl','queued','queued','[]','a','x')").run(), /CHECK constraint failed/);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='probe'").get().value, 'kept');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='schema_compat_floor'").get().value, '1');
  for (const table of ['deploy_keys', 'site_launches', 'site_launch_steps']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} starts empty`);
  assert.deepEqual(migrate(db, { file, list: migrations.slice(0, 17), log: quiet }), { from: 17, to: 17, snapshot: null }, 'restarting is a no-op');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}));

test('2.15-era code can keep using the database: the reserved versions are no-ops and a schema at 17 is compatible', () => withDatabase(16, async (db, file) => {
  assert.deepEqual(schema(db).filter(row => NEW_OBJECTS.includes(row.name)), [], 'nothing launch-related before 17');
  migrate(db, { file, list: migrations.slice(0, 17), log: quiet });
  // An older list (up to 16) on a 17 database continues without changes because 17 is compatible.
  const messages = []; const result = migrate(db, { file, list: migrations.slice(0, 16), log: message => messages.push(message) });
  assert.deepEqual(result, { from: 17, to: 17, snapshot: null });
  assert.match(messages.join('\n'), /only adds compatible objects/);
}));

test('launch constraints: one queued or running launch per server, one live slug per server, append-only, failure once', () => withDatabase(17, db => {
  db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('s','n','h',22,'root','k','f','x'),('t','t','h',22,'root','k','f','x')").run();
  const insert = (launchId, values = {}) => db.prepare('INSERT INTO site_launches(id,server_id,slug,source,domain,state,created_by,created_at,updated_at,repo_url,web_port,loopback_port) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(launchId, values.server ?? 's', values.slug ?? launchId, values.source ?? 'compose', values.domain ?? `${launchId}.example.com`, values.state ?? 'queued', 'admin', 'x', 'x', values.repo ?? null, values.webPort ?? null, values.loopback ?? null);
  insert('a');
  assert.throws(() => insert('b'), /UNIQUE constraint failed: site_launches\.server_id/, 'one queued launch per server');
  insert('b', { server: 't' });
  db.prepare("UPDATE site_launches SET state='done' WHERE id='a'").run();
  insert('c', { state: 'running' });
  insert('d', { slug: 'a', state: 'failed' }); // ended launches do not hold their slug
  assert.throws(() => insert('e', { slug: 'a', state: 'done' }), /UNIQUE constraint failed: site_launches\.server_id, site_launches\.slug/, 'a live slug is unique per server');
  insert('f', { slug: 'b', state: 'cancelled', server: 't' }); // an ended launch frees its slug
  for (const values of [{ source: 'svn' }, { state: 'paused' }, { slug: 'x'.repeat(41) }, { domain: 'a'.repeat(254) }, { repo: 'x'.repeat(513) }, { webPort: 0 }, { webPort: 65536 }, { loopback: 80 }, { webPort: 8.5 }]) assert.throws(() => insert('z' + Math.random(), { server: 't', state: 'done', ...values }), /CHECK constraint failed/, JSON.stringify(values));
  db.prepare("UPDATE site_launches SET state='failed',failed_step='build',reason='The build failed.' WHERE id='c'").run();
  assert.throws(() => db.prepare("UPDATE site_launches SET reason='Something else.' WHERE id='c'").run(), /a launch failure is written once/);
  assert.throws(() => db.prepare("UPDATE site_launches SET failed_step='start' WHERE id='c'").run(), /a launch failure is written once/);
  db.prepare("UPDATE site_launches SET state='needs_attention' WHERE id='c'").run(); // the state may still change
  assert.throws(() => db.prepare("DELETE FROM site_launches WHERE id='a'").run(), /append-only/);
  const step = (step, state = 'pending') => db.prepare('INSERT INTO site_launch_steps(launch_id,step,state) VALUES(?,?,?)').run('a', step, state);
  for (const name of ['check', 'fetch', 'build', 'start', 'check_health', 'web', 'certificate', 'save', 'first_backup', 'teardown']) step(name, name === 'check' ? 'launch_queued' : 'pending');
  assert.throws(() => step('deploy'), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE site_launch_steps SET state='queued' WHERE launch_id='a' AND step='fetch'").run(), /CHECK constraint failed/, 'job statuses are launch_queued/launch_running');
  assert.throws(() => db.prepare("UPDATE site_launch_steps SET detail=? WHERE launch_id='a' AND step='fetch'").run('x'.repeat(501)), /CHECK constraint failed/);
  assert.throws(() => db.prepare("DELETE FROM site_launch_steps WHERE launch_id='a'").run(), /append-only/);
  db.prepare("INSERT INTO deploy_keys(id,name,git_host,host_key_line,host_key_sha256,public_key,fingerprint,sealed_private_key,pinned_from_server_id,pinned_at,created_by,created_at) VALUES('k','Key','github.com','github.com ssh-ed25519 AAAA','SHA256:x','ssh-ed25519 AAAA c','SHA256:y','sealed','s','x','admin','x')").run();
  db.prepare("UPDATE site_launches SET deploy_key_id='k' WHERE id='b'").run();
  db.prepare("DELETE FROM deploy_keys WHERE id='k'").run();
  assert.equal(db.prepare("SELECT deploy_key_id FROM site_launches WHERE id='b'").get().deploy_key_id, null, 'deleting a key leaves the launch history');
}));

// ---- server_installs rebuild hardening (upgrade notes in docs/upgrading.md, "Launching sites in 2.16") ----
const tableShape = (db, table) => ({
  columns: db.prepare('SELECT cid,name,type,"notnull",dflt_value,pk FROM pragma_table_info(?)').all(table).map(row => ({ ...row })),
  foreignKeys: db.prepare('SELECT id,seq,"table","from","to",on_update,on_delete,"match" FROM pragma_foreign_key_list(?)').all(table).map(row => ({ ...row })),
  indexes: db.prepare("SELECT name,\"unique\",origin,partial FROM pragma_index_list(?) ORDER BY name").all(table).map(row => ({ ...row, columns: db.prepare('SELECT name FROM pragma_index_info(?)').all(row.name).map(item => item.name) })),
  triggers: db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table).map(row => row.name),
});
const allRows = (db, tables) => Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map(row => ({ ...row })).filter(row => name !== 'settings' || row.key !== 'schema_compat_floor')]));
const T = '2026-10-30T10:00:00.000Z', HEX = ch => ch.repeat(64);

test('a 2.14.0-shaped database with rows across its tables migrates to 17 with every row, value and install link intact', () => withDatabase(14, async (db, file) => {
  const run = (sql, ...values) => db.prepare(sql).run(...values);
  run("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES('u','admin@example.invalid','h','t','[]',1,?,'Admin','admin')", T);
  run("INSERT INTO servers(id,name,host,port,username,private_key,host_key,capabilities,status,created_at) VALUES('s1','web-1','198.51.100.7',22,'root','sealed',?,'{\"cpus\":2}','ok',?),('s2','web-2','198.51.100.8',2222,'docknest','sealed',?,NULL,'unchecked',?)", HEX('a'), T, HEX('b'), T);
  run("INSERT INTO sites VALUES('site1','s1','Shop',?,?),('site2','s2','Blog','{\"kind\":\"static\"}',?)", JSON.stringify({ kind: 'docker', containers: ['shop-app-1'], domains: ['shop.example.com'] }), T, T);
  run("INSERT INTO policies(site_id,enabled,schedule,timezone,retention,next_run) VALUES('site1',1,'0 3 * * *','Asia/Jerusalem',14,?),('site2',0,'0 2 * * *','UTC',7,NULL)", T);
  run("INSERT INTO jobs(id,site_id,type,status,stage,created_at,started_at,finished_at,error,details) VALUES('j1','site1','backup','completed','completed',?,?,?,NULL,'{}'),('j2','site2','backup','failed','failed',?,?,?,'The server connection failed.','{\"failure\":{\"code\":\"x\"}}')", T, T, T, T, T, T);
  run("INSERT INTO backups(id,site_id,job_id,captured_at,path,size,checksum,manifest,pinned,verified,created_at) VALUES('b1','site1','j1',?,'sftp:t:/x.enc',123456,?,'{}',1,1,?)", T, HEX('c'), T);
  run("INSERT INTO site_moves(id,site_id,source_server_id,target_server_id,state,options,preflight,preflight_hash,actor,created_at,updated_at) VALUES('m1','site1','s1','s2','cleaned','{}','{}','h','u',?,?)", T, T);
  run("INSERT INTO site_move_steps(move_id,step,attempt,state) VALUES('m1','preflight',1,'done')");
  run("INSERT INTO restore_tests(id,site_id,backup_id,backup_captured_at,server_id,trigger,result,limits,cleanup,created_by,created_at,started_at,finished_at) VALUES('rt1','site1','b1',?,'s2','manual','passed','{}','done','u',?,?,?)", T, T, T, T);
  run("INSERT INTO site_certificates(site_id,source,name,checked_at) VALUES('site1','certbot','shop.example.com',?)", T);
  run("INSERT INTO site_hardening(site_id,checked_at,facts) VALUES('site1',?,'{}')", T);
  run("INSERT INTO settings VALUES('maintenance','{\"title\":\"Back soon\"}')");
  run("INSERT INTO settings VALUES('shared_password_hash','h')"); // a real 2.14 start already wrote it (repeatable baseline)
  const installs = [['i1', 's1', 'nginx', 'completed', 'completed', '[{"name":"Connected","status":"done"}]', 'u', null, T, T, T], ['i2', 's1', 'certbot', 'failed', 'failed', '[]', 'u', 'Installing certbot failed. Nothing else was changed by DockNest.', T, T, T], ['i3', 's2', 'docker', 'queued', 'queued', '[]', 'u', null, T, null, null], ['i4', 's2', 'compose', 'running', 'install', '[]', 'u', null, T, T, null]];
  for (const row of installs) run('INSERT INTO server_installs(id,server_id,package,status,stage,steps,actor,error,created_at,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', ...row);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
  const before = allRows(db, tables), shapeBefore = tableShape(db, 'server_installs');
  assert.ok(Object.values(before).filter(rows => rows.length).length >= 12, 'the fixture has rows in most tables');
  migrate(db, { file, list: migrations.slice(0, 17), log: quiet });
  assert.deepEqual(allRows(db, tables), before, 'no row of any 2.14 table changes, server_installs included (ids and every value)');
  assert.deepEqual(tableShape(db, 'server_installs'), shapeBefore, 'same columns, foreign key (servers, ON DELETE CASCADE), indexes and triggers');
  assert.equal(shapeBefore.foreignKeys[0].on_delete, 'CASCADE');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  // The kept foreign key still works: an install for an unknown server is refused, and git is now accepted.
  assert.throws(() => run("INSERT INTO server_installs(id,server_id,package,status,stage,steps,actor,created_at) VALUES('x','missing','git','queued','queued','[]','u','x')"), /FOREIGN KEY constraint failed/);
  run("INSERT INTO server_installs(id,server_id,package,status,stage,steps,actor,created_at) VALUES('g','s1','git','queued','queued','[]','u','x')");
}));

test('the rebuild refuses, changing nothing, when an install row lost its server or another table references server_installs', async () => {
  await withDatabase(14, async (db, file) => {
    db.exec("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('s','n','h',22,'root','k','f','x')");
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec("INSERT INTO server_installs(id,server_id,package,status,stage,steps,actor,created_at) VALUES('orphan','gone','nginx','completed','completed','[]','u','x')");
    db.exec('PRAGMA foreign_keys=ON');
    const before = schema(db);
    assert.throws(() => migrate(db, { file, list: migrations.slice(0, 17), log: quiet }), /server_installs has rows whose server no longer exists/);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 14, 'the schema stays at 14');
    assert.deepEqual(schema(db), before);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM server_installs WHERE id='orphan'").get().n, 1, 'the row is not dropped');
  });
  await withDatabase(14, async (db, file) => {
    db.exec('CREATE TABLE install_notes (install_id TEXT REFERENCES server_installs(id))');
    assert.throws(() => migrate(db, { file, list: migrations.slice(0, 17), log: quiet }), /server_installs is referenced by install_notes/);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 14);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='site_launches'").get(), undefined, 'nothing of migration 17 is left');
  });
  // A view or a trigger on another table that names server_installs would break on the rename: refused, nothing changed.
  for (const sql of ['CREATE VIEW install_view AS SELECT id,package FROM server_installs', "CREATE TRIGGER server_note AFTER INSERT ON servers BEGIN INSERT INTO server_installs(id,server_id,package,status,stage,steps,actor,created_at) VALUES(NEW.id,NEW.id,'nginx','queued','queued','[]','x','x'); END"]) {
    await withDatabase(14, async (db, file) => {
      db.exec(sql);
      const before = schema(db);
      assert.throws(() => migrate(db, { file, list: migrations.slice(0, 17), log: quiet }), /server_installs is used by (view install_view|trigger server_note)/);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 14);
      assert.deepEqual(schema(db), before);
    });
  }
});
