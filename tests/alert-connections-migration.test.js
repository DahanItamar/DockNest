// Migration 10 (docs/alert-channels.md, "Data model" and "Migrating 2.8 alerts"): new tables only, the 2.8 tables frozen
// byte for byte, sealed values copied without opening them (these fixtures are not even valid ciphertext), ids kept,
// idempotent, an interrupted upgrade leaves 2.9 untouched, and 2.9 code still starts on the result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, migrations, compatFloor, schemaVersion, importLegacyAlerts } from '../src/migrations.js';

const quiet = () => {};
const schema = db => db.prepare('SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all().map(row => ({ ...row }));
const rows = (db, table, order = 'id') => db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map(row => ({ ...row }));
const legacyTables = ['alert_credentials', 'alert_channels', 'alert_rules', 'alert_queue'];
const newObjects = ['alert_legacy_import', 'alert_lines', 'alert_lines_node', 'alert_nodes', 'alert_nodes_connection', 'alert_outbox', 'alert_outbox_dedupe', 'alert_outbox_due', 'connections', 'connections_origin'];
async function withDatabase(upTo, work) {
  const directory = await mkdtemp(join(tmpdir(), 'docknest-alert-connections-')); let db;
  try {
    const file = join(directory, 'state.sqlite'); db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;');
    migrate(db, { file, list: migrations.slice(0, upTo), log: quiet });
    await work(db, file);
  } finally { db?.close(); await rm(directory, { recursive: true, force: true }); }
}
// Fake sealed values: never opened by the migration, so they need not decrypt.
const SEALED = { bot: 'c2VhbGVkLWZpeHR1cmUtYm90LW5vdC1hLXJlYWwtdG9rZW4=', spare: 'c2VhbGVkLWZpeHR1cmUtc3BhcmU=', mail: 'c2VhbGVkLWZpeHR1cmUtbWFpbC1hY2NvdW50' };
const credential = (db, id, kind, name, config, at = '2026-10-01T00:00:00.000Z', test = null) => db.prepare('INSERT INTO alert_credentials(id,kind,name,config,created_at,updated_at,last_test,last_test_at,last_error) VALUES(?,?,?,?,?,?,?,?,?)').run(id, kind, name, config, at, at, test, test ? at : null, test === 'failed' ? 'Telegram refused the check.' : null);
const channel = (db, id, kind, name, config, credentialId, at, result = null) => db.prepare('INSERT INTO alert_channels(id,kind,name,config,credential_id,created_at,updated_at,last_result,last_result_at,last_error) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, kind, name, typeof config === 'string' ? config : JSON.stringify(config), credentialId, at, at, result, result ? at : null, result === 'failed' ? 'Telegram refused the message.' : null);
const rule = (db, id, channelId, kind, sourceId, events, enabled = 1) => db.prepare('INSERT INTO alert_rules(id,channel_id,source_kind,source_id,events,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, channelId, kind, sourceId, JSON.stringify(events), enabled, '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z');
const queued = (db, id, channelId, key, status, created, finished = null) => db.prepare('INSERT INTO alert_queue(id,channel_id,event,dedupe_key,message,status,attempts,next_attempt_at,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, channelId, key.split(':')[0], key, `Backup failed: ${id}`, status, status === 'pending' ? 0 : 1, Date.parse(created), created, finished);

// A realistic 2.8/2.9 alert setup with every case the copy has to handle.
function realistic(db) {
  credential(db, 'cred-bot', 'telegram', 'Home bot', SEALED.bot, '2026-10-01T00:00:00.000Z', 'ok');
  credential(db, 'cred-spare', 'telegram', 'Spare bot', SEALED.spare, '2026-10-01T01:00:00.000Z');
  credential(db, 'cred-mail', 'smtp', 'Mail', SEALED.mail, '2026-10-01T02:00:00.000Z', 'failed');
  channel(db, 'node-family', 'telegram', 'Family', { chatId: '-1001' }, 'cred-bot', '2026-10-01T03:00:00.000Z', 'ok');
  channel(db, 'node-work', 'telegram', 'Work chat', { chatId: '-1002' }, 'cred-bot', '2026-10-01T04:00:00.000Z', 'failed');
  channel(db, 'node-family-2', 'telegram', 'Family again', { chatId: '-1001' }, 'cred-bot', '2026-10-01T05:00:00.000Z');
  channel(db, 'node-mail', 'email', 'Inbox', { to: ['me@example.com', 'ops@example.com'], subjectPrefix: '[Home]' }, 'cred-mail', '2026-10-01T06:00:00.000Z');
  channel(db, 'node-orphan', 'telegram', 'No credential', { chatId: '-1003' }, null, '2026-10-01T07:00:00.000Z');
  channel(db, 'node-mismatch', 'email', 'Wrong kind', { to: ['x@example.com'], subjectPrefix: '' }, 'cred-bot', '2026-10-01T08:00:00.000Z');
  channel(db, 'node-corrupt', 'telegram', 'Broken config', '{not json', 'cred-bot', '2026-10-01T09:00:00.000Z');
  channel(db, 'node-silent', 'telegram', 'No lines', { chatId: '-1004' }, 'cred-bot', '2026-10-01T10:00:00.000Z');
  rule(db, 'line-1', 'node-family', 'docknest', null, ['backup.failed', 'update.available']);
  rule(db, 'line-2', 'node-work', 'site', 'deleted-site-id', ['backup.failed']); // the site is gone: the line simply never matches
  rule(db, 'line-3', 'node-mail', 'server', 'deleted-server-id', ['server.unreachable'], 0); // disabled
  rule(db, 'line-4', 'node-orphan', 'docknest', null, ['backup.failed']);
  queued(db, 'q-sent', 'node-family', 'move.finished:occ:move:1:completed:', 'sent', '2026-10-26T08:00:00.000Z', '2026-10-26T08:00:01.000Z');
  queued(db, 'q-pending', 'node-work', 'backup.failed:site:x', 'pending', '2026-10-27T07:59:00.000Z');
  queued(db, 'q-orphan', 'node-orphan', 'backup.failed:site:y', 'pending', '2026-10-27T07:59:00.000Z');
}

test('migration 10 is one compatible line named alert-connections; 9 stays as released; the floor stays 1', async () => {
  const source = (await readFile(new URL('../src/migrations.js', import.meta.url), 'utf8')).split(/\r?\n/);
  assert.match(source.find(line => /^\s*\{\s*version:\s*10\b/.test(line)), /^ {2}\{ version: 10, name: 'alert-connections', compatible: true, up: /);
  assert.equal(schemaVersion, 10); assert.equal(compatFloor(migrations), 1);
  assert.deepEqual(migrations.map(item => item.version), migrations.map((_, index) => index + 1));
});

test('a fresh install gets the new tables, empty, and the import marker', () => withDatabase(10, async db => {
  for (const name of newObjects) assert.ok(schema(db).some(row => row.name === name), name);
  for (const table of ['connections', 'alert_nodes', 'alert_lines', 'alert_outbox']) assert.equal(rows(db, table).length, 0, table);
  assert.equal(rows(db, 'alert_legacy_import').length, 1);
}));

test('a 2.9.0 install with no alerts gains only the new objects and keeps every row and setting', () => withDatabase(9, async (db, file) => {
  db.prepare("INSERT INTO settings VALUES('probe','kept')").run();
  const before = schema(db), settings = rows(db, 'settings', 'key').filter(row => row.key !== 'schema_compat_floor');
  const result = migrate(db, { file, now: () => new Date('2026-10-27T08:00:00.000Z'), log: quiet });
  assert.equal(result.from, 9); assert.equal(result.to, 10); assert.match(result.snapshot, /state-v9-to-v10-/);
  for (const row of before) assert.deepEqual(schema(db).find(item => item.name === row.name), row, 'existing objects keep their definition');
  assert.deepEqual(schema(db).map(row => row.name).filter(name => !before.some(row => row.name === name)).sort(), newObjects);
  assert.deepEqual(rows(db, 'settings', 'key').filter(row => row.key !== 'schema_compat_floor'), settings);
  assert.equal(rows(db, 'connections').length, 0);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='schema_compat_floor'").get().value, '1');
  assert.deepEqual(migrate(db, { file, log: quiet }), { from: 10, to: 10, snapshot: null }, 'restarting is a no-op');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
}));

test('2.8 alerts are copied: grouped by destination, sealed bytes identical, ids kept, legacy tables frozen', () => withDatabase(9, async (db, file) => {
  realistic(db);
  const frozen = Object.fromEntries(legacyTables.map(table => [table, rows(db, table)]));
  migrate(db, { file, log: quiet });
  for (const table of legacyTables) assert.deepEqual(rows(db, table), frozen[table], `${table} is not changed`);
  const connections = rows(db, 'connections', 'created_at,id');
  const byId = Object.fromEntries(connections.map(row => [row.id, row]));
  // One bot, chats -1001 (two nodes) and -1002: two Connections. The first keeps the credential's id and name.
  assert.equal(byId['cred-bot'].name, 'Home bot'); assert.equal(byId['cred-bot'].settings, '{"chatId":"-1001"}');
  const work = connections.find(row => row.settings === '{"chatId":"-1002"}');
  assert.equal(work.name, 'Home bot (Work chat)'); assert.notEqual(work.id, 'cred-bot');
  const silent = connections.find(row => row.settings === '{"chatId":"-1004"}');
  assert.equal(silent.name, 'Home bot (No lines)', 'a node without lines still keeps its destination');
  for (const row of [byId['cred-bot'], work, silent]) { assert.equal(row.secret, SEALED.bot, 'sealed bytes copied as they are'); assert.equal(row.origin, 'legacy:cred-bot'); assert.equal(row.private_ok, 0); assert.equal(row.provider, 'telegram'); }
  assert.equal(byId['cred-bot'].last_test, 'ok', 'the credential test result is kept');
  assert.equal(byId['cred-bot'].last_send, 'ok'); assert.equal(work.last_send, 'failed'); assert.equal(work.last_error, 'Telegram refused the message.');
  // An unused credential: empty settings, sends nothing until completed.
  assert.deepEqual({ ...byId['cred-spare'], created_at: undefined, updated_at: undefined }, { id: 'cred-spare', provider: 'telegram', name: 'Spare bot', secret: SEALED.spare, settings: '{}', origin: 'legacy:cred-spare', private_ok: 0, created_by: null, updated_by: null, created_at: undefined, updated_at: undefined, last_test: null, last_test_at: null, last_send: null, last_send_at: null, last_error: null });
  // Email: the whole SMTP account stays the sealed value; recipients and prefix are plain settings; the relay rule is kept.
  assert.equal(byId['cred-mail'].provider, 'email'); assert.equal(byId['cred-mail'].secret, SEALED.mail); assert.equal(byId['cred-mail'].private_ok, 1);
  assert.deepEqual(JSON.parse(byId['cred-mail'].settings), { to: ['me@example.com', 'ops@example.com'], subjectPrefix: '[Home]' });
  assert.equal(connections.length, 5);
  const nodes = Object.fromEntries(rows(db, 'alert_nodes').map(row => [row.id, row]));
  assert.deepEqual(Object.keys(nodes).sort(), rows(db, 'alert_channels').map(row => row.id).sort(), 'every node keeps its id');
  assert.equal(nodes['node-family'].connection_id, 'cred-bot'); assert.equal(nodes['node-family-2'].connection_id, 'cred-bot', 'same chat, same Connection');
  assert.equal(nodes['node-work'].connection_id, work.id); assert.equal(nodes['node-mail'].connection_id, 'cred-mail');
  for (const id of ['node-orphan', 'node-mismatch', 'node-corrupt']) { assert.equal(nodes[id].connection_id, null, id); assert.equal(nodes[id].prefill, frozen.alert_channels.find(row => row.id === id).config, `${id} keeps its old destination as prefill`); }
  assert.ok(Object.values(nodes).every(node => node.prefill === null || !node.prefill.includes(SEALED.bot)));
  assert.deepEqual(rows(db, 'alert_lines').map(({ node_id, ...row }) => ({ ...row, channel_id: node_id })), frozen.alert_rules.map(row => ({ ...row })), 'lines keep ids, events, sources and enabled flags');
  const outbox = rows(db, 'alert_outbox');
  assert.deepEqual(outbox.map(row => row.id), ['q-pending', 'q-sent'], 'a node without a Connection could never send: its rows are not copied');
  assert.deepEqual({ ...outbox[1], expires_at: undefined }, { id: 'q-sent', connection_id: 'cred-bot', node_id: 'node-family', event: 'move.finished', dedupe_key: 'move.finished:occ:move:1:completed:', message: 'Backup failed: q-sent', payload: null, status: 'sent', attempts: 1, next_attempt_at: Date.parse('2026-10-26T08:00:00.000Z'), expires_at: undefined, created_at: '2026-10-26T08:00:00.000Z', finished_at: '2026-10-26T08:00:01.000Z' });
  assert.equal(outbox[0].connection_id, work.id); assert.equal(outbox[0].payload, null); assert.equal(outbox[0].expires_at, Date.parse('2026-10-28T07:59:00.000Z'));
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0); assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  // Idempotent: a second copy (or a repeated start) adds nothing.
  const snapshot = ['connections', 'alert_nodes', 'alert_lines', 'alert_outbox'].map(table => rows(db, table));
  importLegacyAlerts(db); migrate(db, { file, log: quiet });
  assert.deepEqual(['connections', 'alert_nodes', 'alert_lines', 'alert_outbox'].map(table => rows(db, table)), snapshot);
}));

test('an email-only setup, unicode and very long names, and split names cut to 80 characters', () => withDatabase(9, async (db, file) => {
  const long = 'Ünïcödé 𝔹ot ✉ '.repeat(10).slice(0, 78);
  credential(db, 'mail', 'smtp', long, SEALED.mail);
  channel(db, 'a', 'email', 'Équipe 🚀 on-call', { to: ['a@example.com'], subjectPrefix: '[Prod]' }, 'mail', '2026-10-01T01:00:00.000Z');
  channel(db, 'b', 'email', 'x'.repeat(80), { to: ['b@example.com'], subjectPrefix: '' }, 'mail', '2026-10-01T02:00:00.000Z');
  migrate(db, { file, log: quiet });
  const connections = rows(db, 'connections', 'created_at,id');
  assert.equal(connections.length, 2); assert.equal(connections.find(row => row.id === 'mail').name, long);
  const split = connections.find(row => row.id !== 'mail');
  assert.ok(db.prepare('SELECT length(name) AS n FROM connections WHERE id=?').get(split.id).n <= 80);
  assert.ok(split.name.startsWith(long.slice(0, 20)));
  assert.ok(!/[\uD800-\uDFFF]$/.test(split.name.at(-1)) || /[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(split.name), 'never cut inside a character');
  assert.ok(connections.every(row => row.provider === 'email' && row.secret === SEALED.mail && row.private_ok === 1));
}));

test('a large install (hundreds of nodes, lines and queue rows) is copied in one transaction', () => withDatabase(9, async (db, file) => {
  credential(db, 'bot', 'telegram', 'Bot', SEALED.bot);
  db.exec('BEGIN');
  for (let index = 0; index < 400; index++) {
    channel(db, `n${index}`, 'telegram', `Node ${index}`, { chatId: String(-1000 - (index % 50)) }, 'bot', `2026-10-01T00:00:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`);
    rule(db, `r${index}a`, `n${index}`, 'docknest', null, ['backup.failed']); rule(db, `r${index}b`, `n${index}`, 'site', `site-${index}`, ['backup.succeeded'], index % 2);
    queued(db, `q${index}`, `n${index}`, `backup.failed:site:${index}`, index % 3 ? 'sent' : 'pending', '2026-10-27T07:00:00.000Z', index % 3 ? '2026-10-27T07:00:01.000Z' : null);
  }
  db.exec('COMMIT');
  const started = Date.now();
  migrate(db, { file, log: quiet });
  assert.ok(Date.now() - started < 30_000, 'fast enough to run at start');
  assert.equal(rows(db, 'connections').length, 50, 'one Connection per distinct chat');
  assert.equal(rows(db, 'alert_nodes').length, 400); assert.equal(rows(db, 'alert_lines').length, 800); assert.equal(rows(db, 'alert_outbox').length, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM alert_nodes WHERE connection_id IS NULL').get().n, 0);
}));

test('an upgrade interrupted halfway changes nothing, and the next start completes it', () => withDatabase(9, async (db, file) => {
  realistic(db);
  const before = schema(db), frozen = legacyTables.map(table => rows(db, table));
  const broken = [...migrations, { version: 11, name: 'crash', compatible: true, up: () => { throw new Error('power cut'); } }];
  assert.throws(() => migrate(db, { file, list: broken, log: quiet }), /power cut/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9, 'still a 2.9.0 database');
  assert.deepEqual(schema(db), before, 'no half-made tables');
  assert.deepEqual(legacyTables.map(table => rows(db, table)), frozen);
  migrate(db, { file, log: quiet });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10);
  assert.equal(rows(db, 'alert_nodes').length, 8);
}));

test('2.9.0 code keeps running on a migrated database: its schema check passes and its tables answer as before', () => withDatabase(9, async (db, file) => {
  realistic(db);
  migrate(db, { file, log: quiet });
  db.prepare("INSERT INTO connections(id,provider,name,secret,settings,origin,created_at,updated_at) VALUES('new','telegram','Made after the upgrade','c2VhbGVk','{\"chatId\":\"-1009\"}',NULL,'2026-10-28','2026-10-28')").run();
  // The 2.9.0 list ends at migration 9: an additive newer schema is accepted without changes.
  const messages = [];
  assert.deepEqual(migrate(db, { file, list: migrations.slice(0, 9), log: message => messages.push(message) }), { from: 10, to: 10, snapshot: null });
  assert.match(messages[0], /only adds compatible objects/);
  // The exact queries 2.9.0's alert store and delivery run.
  assert.equal(db.prepare("SELECT * FROM alert_rules WHERE enabled=1").all().length, 3);
  assert.equal(db.prepare('SELECT id,name FROM alert_channels WHERE credential_id=? ORDER BY name').all('cred-bot').length, 6);
  assert.equal(db.prepare("SELECT * FROM alert_queue WHERE status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,created_at LIMIT ?").all(Date.now(), 20).length, 2);
  db.prepare("INSERT INTO alert_queue(id,channel_id,event,dedupe_key,message,status,attempts,next_attempt_at,created_at) VALUES('q-new','node-family','backup.failed','backup.failed:site:z','x','pending',0,0,'2026-10-28')").run();
}));
