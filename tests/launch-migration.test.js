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
