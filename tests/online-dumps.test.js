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
