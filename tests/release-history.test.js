import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { migrate, schemaVersion } from '../src/migrations.js';
import { recordRelease } from '../src/updates/release-history.js';

const run = promisify(execFile), root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const quiet = () => {}, rows = db => db.prepare('SELECT * FROM release_history ORDER BY version').all().map(row => ({ ...row }));
async function temporary(t, prefix) { const directory = await mkdtemp(join(tmpdir(), prefix)); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }
async function database(t) { const file = join(await temporary(t, 'docknest-release-history-'), 'state.sqlite'), db = new DatabaseSync(file); migrate(db, { file, log: quiet }); return db; }

test('recording the running release is idempotent: restarts only move last_started_at', async t => {
  const db = await database(t), first = new Date('2026-10-22T08:00:00.000Z'), later = new Date('2026-10-23T09:30:00.000Z');
  assert.deepEqual({ ...recordRelease(db, { version: '2.2.0', schemaVersion: 5 }, first) }, { version: '2.2.0', schema_version: 5, first_started_at: first.toISOString(), last_started_at: first.toISOString() });
  recordRelease(db, { version: '2.2.0', schemaVersion: 5 }, first);
  recordRelease(db, { version: '2.2.0', schemaVersion: 5 }, later);
  assert.deepEqual(rows(db), [{ version: '2.2.0', schema_version: 5, first_started_at: first.toISOString(), last_started_at: later.toISOString() }]);
  // A command-line rollback to 2.1.0 and an upgrade again keep 2.2.0's first start, which What's new compares with users.created_at.
  recordRelease(db, { version: '2.1.0', schemaVersion: 4 }, later);
  recordRelease(db, { version: '2.2.0', schemaVersion: 5 }, new Date('2026-10-24T00:00:00.000Z'));
  assert.deepEqual(rows(db).map(row => [row.version, row.schema_version, row.first_started_at]), [['2.1.0', 4, later.toISOString()], ['2.2.0', 5, first.toISOString()]]);
  db.close();
});

test('recording never throws: a read-only, failing or invalid write logs one line and returns null', async t => {
  const db = await database(t), file = db.prepare('PRAGMA database_list').get().file, messages = [], log = message => messages.push(message);
  const readOnly = new DatabaseSync(file, { readOnly: true });
  assert.equal(recordRelease(readOnly, { version: '2.2.0', schemaVersion: 5 }, new Date(), log), null);
  assert.equal(recordRelease({ prepare: () => { throw new Error('disk I/O error'); } }, { version: '2.2.0', schemaVersion: 5 }, new Date(), log), null);
  assert.equal(recordRelease(db, { version: 'x'.repeat(33), schemaVersion: 5 }, new Date(), log), null, 'version is capped at 32 characters');
  assert.equal(recordRelease(db, { version: '2.2.0', schemaVersion: -1 }, new Date(), log), null, 'schema_version is never negative');
  assert.equal(recordRelease(db, { version: '2.2.0', schemaVersion: 'five' }, new Date(), log), null, 'schema_version is an integer');
  assert.equal(messages.length, 5);
  assert.match(messages[0], /^Could not record the running release: .*readonly/i);
  assert.equal(messages[1], 'Could not record the running release: disk I/O error');
  assert.deepEqual(rows(db), []);
  readOnly.close(); db.close();
});

const environment = directory => ({ ...process.env, DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });

test('the API still loads when the release cannot be recorded', async t => {
  const directory = await temporary(t, 'docknest-release-history-blocked-'), env = environment(directory), file = join(directory, 'state.sqlite');
  await writeFile(env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
  const db = new DatabaseSync(file); migrate(db, { file, log: quiet });
  db.exec("CREATE TRIGGER block_release_history BEFORE INSERT ON release_history BEGIN SELECT RAISE(ABORT,'blocked by fixture'); END"); db.close();
  const { stdout, stderr } = await run(process.execPath, ['--no-addons', '--input-type=module', '-e', "const {app}=await import('./src/server.js');console.log(typeof app);process.exit(0);"], { cwd: root, env });
  assert.equal(stdout.trim(), 'function');
  assert.match(stderr, /^Could not record the running release: blocked by fixture$/m);
});

test('the API records the version and schema this database runs when it starts', async t => {
  const directory = await temporary(t, 'docknest-release-history-api-');
  Object.assign(process.env, environment(directory));
  await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const [row] = rows(db);
  assert.deepEqual([rows(db).length, row.version, row.schema_version, row.first_started_at], [1, version, schemaVersion, row.last_started_at]);
  assert.match(row.first_started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  db.close();
});
