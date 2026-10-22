import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { migrate, schemaVersion } from '../src/migrations.js';
import { recordRelease } from '../src/updates/release-history.js';

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

test('the API records the version and schema this database runs when it starts', async t => {
  const directory = await temporary(t, 'docknest-release-history-api-');
  Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
  await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const [row] = rows(db);
  assert.deepEqual([rows(db).length, row.version, row.schema_version, row.first_started_at], [1, version, schemaVersion, row.last_started_at]);
  assert.match(row.first_started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  db.close();
});
