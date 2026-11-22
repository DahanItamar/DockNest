import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const temporary = await mkdtemp(join(tmpdir(), 'dbm-dumps-'));
process.env.DATA_DIR = join(temporary, 'data');
process.env.BACKUP_DIR = temporary;
process.env.BACKUP_STORAGE = 'local';
process.env.NODE_ENV = 'test';
const { onlineDumpWarnings } = await import('../src/engine.js');
const { restoreCommands, revealer } = await import('../src/runbook/commands.js');
const { helperSource } = await import('../src/helper-bundle.js');

test('online dump warnings: only for apps that asked, one per database that kept the stopped copy', () => {
  const fallbacks = [{ container: 'shop-db', engine: 'mysql', reason: 'tables that are not InnoDB (1) cannot be read in one transaction' }];
  assert.deepEqual(onlineDumpWarnings({}, { fallbacks }), [], 'an upgraded app without the option is unchanged');
  assert.deepEqual(onlineDumpWarnings({ onlineDumps: true }, { fallbacks: [] }), []);
  assert.deepEqual(onlineDumpWarnings({ onlineDumps: true }, { fallbacks }), ['Online dumps: shop-db stopped for a file copy because tables that are not InnoDB (1) cannot be read in one transaction.']);
  assert.deepEqual(onlineDumpWarnings({ onlineDumps: true }, { incremental: true, fallbacks }), ['Online dumps: incremental backups are on, so every database stopped for a file copy.']);
  assert.deepEqual(onlineDumpWarnings({ onlineDumps: true }, { move: true, fallbacks }), [], 'a move always takes a stopped copy');
  assert.deepEqual(onlineDumpWarnings({ onlineDumps: true }, { fallbacks: [{ container: 1 }, null] }), [], 'malformed helper records are ignored');
});

test('the Recovery Guide tells how to load a dump before the app starts', () => {
  const app = { folder: 'shop', name: 'Shop', kind: 'docker', composeFiles: [], configFiles: [] };
  const backup = { location: { targetId: 't', path: '/srv/backups/shop/backup_1.tar.gz.enc' }, fileName: 'backup_1.tar.gz.enc', containers: [{ name: 'shop-db', image: 'postgres:16', mounts: [{ type: 'volume', destination: '/var/lib/postgresql/data' }] }], chain: null };
  const storage = { mode: 'sftp', name: 'Home storage', host: '192.0.2.10', port: 22, username: 'backup', hostKey: 'ab'.repeat(32), auth: 'password', password: 'example', root: '/srv/backups' }, reveal = revealer({});
  const plain = restoreCommands({ app, backup, storage, reveal });
  assert.ok(!plain.some(step => step.text.includes('online dump')));
  const steps = restoreCommands({ app, backup: { ...backup, dumps: ['shop-db'] }, storage, reveal });
  const index = steps.findIndex(step => step.text.includes('saved shop-db as an online dump'));
  assert.ok(index > 0 && index === steps.length - 2, 'right before the app starts');
  assert.match(steps[index].command, /^sed -n '\/\^# Database dumps\/,\$p' package\/restore-guide\.md$/);
  const sh = spawnSync('sh', ['-n', '-c', steps[index].command]);
  if (!sh.error) assert.equal(sh.status, 0);
});

test('the helper carries the dumps module and its restore guide section', () => {
  const source = helperSource().toString();
  assert.match(source, /^def load_dumps\(/m);
  assert.match(source, /^# Database dumps$/m);
  assert.ok(source.indexOf('def dump_candidates(') > source.indexOf("ENGINES={'postgres'"), 'after the engine registry');
});

test('the engine capability list is the one the helper follows, and Redis/Mongo text is driven by it', async () => {
  const { DATABASE_ENGINES, engineCapabilities } = await import('../shared/database-engines.js');
  const { readFileSync } = await import('node:fs');
  // Drift guard: an engine reports an online copy exactly when its helper module sets dump_format.
  const byFile = { postgres: 'engine_postgres.py', mysql: 'engine_mysql.py', mariadb: 'engine_mysql.py', redis: 'engine_redis.py', mongo: 'engine_mongo.py' };
  for (const engine of DATABASE_ENGINES) {
    const source = readFileSync(new URL('../remote/helper/' + byFile[engine.id], import.meta.url), 'utf8');
    assert.equal(engine.onlineCopy, /^\s+dump_format\s*=\s*'/m.test(source), engine.id + ' capability matches its helper module');
  }
  const list = engineCapabilities();
  assert.deepEqual(list.filter(item => item.onlineCopy).map(item => item.id), ['postgres', 'mysql', 'mariadb']);
  assert.equal(list.find(item => item.id === 'mongo').onlineCopy, false);
  assert.equal(list.find(item => item.id === 'redis').reason, 'has no online copy yet');
  const { detectDatabases, rowState, rowText, switchDisabled, covers } = await import('../web/online-dumps.js');
  const services = [{ container: 'shop-db', engine: 'postgres', version: '16.2' }, { container: 'shop-cache', engine: 'redis' }];
  const text = engines => detectDatabases({ selected: ['shop-db', 'shop-cache'], services, engines }).map(db => rowText(db, rowState(db, { on: true })));
  assert.deepEqual(text(list), ['Online copy, stays running', 'Always stopped for a file copy. Redis has no online copy yet.']);
  // When the Redis/Valkey change flips the capability, the same screen says online copy without any change of its own.
  const flipped = list.map(item => item.id === 'redis' ? { id: item.id, label: item.label, onlineCopy: true } : item);
  assert.deepEqual(text(flipped), ['Online copy, stays running', 'Online copy, stays running']);
  const onlyRedisMongo = detectDatabases({ selected: ['c', 'm'], services: [{ container: 'c', engine: 'redis' }, { container: 'm', engine: 'mongo' }], engines: list });
  assert.equal(switchDisabled(onlyRedisMongo, false), true);
  assert.equal(switchDisabled(onlyRedisMongo, true), false, 'a saved on can still be turned off');
  assert.equal(switchDisabled(detectDatabases({ selected: ['c'], services: [{ container: 'c', engine: 'redis' }], engines: flipped }), false), false);
  assert.equal(rowState(detectDatabases({ selected: ['shop-db'], services, engines: list })[0], { on: true, incremental: true }), 'stopped-see');
  assert.equal(covers(list), 'PostgreSQL, MySQL and MariaDB');
  assert.equal(detectDatabases({ selected: ['x'], containers: [{ name: 'x', image: 'redis:7' }], services: [], engines: list })[0].engine, 'redis', 'engine from the image when none is declared');
  assert.deepEqual(detectDatabases({ selected: ['x'], containers: [{ name: 'x', image: 'oliver006/redis_exporter' }], services: [], engines: list }), [], 'tools are not databases');
});
