import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, migrations, compatFloor } from '../src/migrations.js';

const quiet = () => {};
const schema = db => db.prepare('SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all().map(row => ({ ...row }));

test('the alerts migration only adds its own tables and indexes to a schema 6 database and keeps every row', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'docknest-alerts-migration-')); let db;
  try {
    const file = join(directory, 'state.sqlite'); db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;');
    migrate(db, { file, list: migrations.slice(0, 6), log: quiet });
    db.prepare("INSERT INTO settings VALUES('probe','kept')").run();
    db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('s','n','h',22,'root','k','f','2026-01-01')").run();
    const before = schema(db), settings = db.prepare('SELECT key,value FROM settings WHERE key<>? ORDER BY key').all('schema_compat_floor').map(row => ({ ...row }));
    const result = migrate(db, { file, now: () => new Date('2026-10-23T08:00:00.000Z'), log: quiet });
    assert.equal(result.from, 6); assert.equal(result.to, migrations.at(-1).version);
    assert.equal(migrations.find(item => item.name === 'alerts').compatible, true);
    for (const row of before) assert.deepEqual(schema(db).find(item => item.name === row.name), row, 'existing objects keep their definition');
    assert.deepEqual(schema(db).map(row => row.name).filter(name => !before.some(row => row.name === name)), ['alert_channels', 'alert_credentials', 'alert_legacy_import', 'alert_lines', 'alert_lines_node', 'alert_nodes', 'alert_nodes_connection', 'alert_outbox', 'alert_outbox_dedupe', 'alert_outbox_due', 'alert_queue', 'alert_queue_dedupe', 'alert_queue_due', 'alert_rules', 'alert_rules_channel', 'backup_copies', 'backup_copies_due', 'backup_copies_target', 'backup_main_removed', 'connections', 'connections_origin', 'manager_backup_copies', 'radar_advisories', 'radar_findings', 'radar_findings_server', 'radar_findings_site', 'radar_inventory', 'radar_preferences', 'radar_scans', 'radar_scans_active', 'radar_scans_server', 'restore_test_settings', 'restore_test_settings_due', 'restore_test_steps', 'restore_test_steps_no_delete', 'restore_tests', 'restore_tests_backup', 'restore_tests_no_delete', 'restore_tests_result_once', 'restore_tests_server_active', 'restore_tests_site_active', 'restore_tests_site_created', 'server_installs', 'server_installs_status', 'site_storage', 'site_storage_copies', 'site_storage_copies_target', 'site_storage_main']);
    assert.deepEqual(db.prepare('SELECT key,value FROM settings WHERE key<>? ORDER BY key').all('schema_compat_floor').map(row => ({ ...row })), settings);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM servers').get().n, 1);
    assert.equal(compatFloor(migrations), 1);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');

  } finally { db?.close(); await rm(directory, { recursive: true, force: true }); }
});
