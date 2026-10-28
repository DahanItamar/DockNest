// The Connections store under the 2.8 views (the 2.8 routes themselves are gone) (docs/alert-channels.md, "API" adapter rules, "Rollback", "Sealed storage",
// "Delivery"). The database starts as a 2.9.0 one with 2.8 alerts sealed by the real master key, so the upgrade copy runs
// when the API starts. Fake tokens and passwords only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { legacyCalls } from './fixtures/legacy-alert-calls.js';

const directory = await mkdtemp(join(tmpdir(), 'docknest-alert-connections-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });

const TOKEN = '123456789:' + 'AbCdEf_-12'.repeat(4).slice(0, 35), NEW_TOKEN = '987654321:' + 'ZyXwVu_-98'.repeat(4).slice(0, 35), PASSWORD = 'fixture-password-not-real';
const LEGACY = { bot: randomUUID(), mail: randomUUID(), family: randomUUID(), work: randomUUID(), inbox: randomUUID() };
// A 2.9.0 database (schema 9) with one bot shared by two chats and one SMTP account, sealed with this master key.
const { migrate, migrations } = await import('../src/migrations.js');
const { seal, open, digest } = await import('../src/crypto.js');
const sealedBot = seal(JSON.stringify({ token: TOKEN })), sealedMail = seal(JSON.stringify({ host: 'smtp.example.com', port: 587, security: 'starttls', username: 'bot', password: PASSWORD, from: 'docknest@example.com' }));
{
  const file = join(directory, 'state.sqlite'), seed = new DatabaseSync(file);
  seed.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;');
  migrate(seed, { file, list: migrations.slice(0, 9), log: () => {} });
  const at = '2026-10-20T00:00:00.000Z';
  seed.prepare("INSERT INTO alert_credentials(id,kind,name,config,created_at,updated_at) VALUES(?,'telegram','Bot',?,?,?),(?,'smtp','Mail',?,?,?)").run(LEGACY.bot, sealedBot, at, at, LEGACY.mail, sealedMail, at, at);
  seed.prepare("INSERT INTO alert_channels(id,kind,name,config,credential_id,created_at,updated_at) VALUES(?,'telegram','Family',?,?,?,?),(?,'telegram','Work',?,?,?,?),(?,'email','Inbox',?,?,?,?)").run(LEGACY.family, '{"chatId":"-1001"}', LEGACY.bot, at, at, LEGACY.work, '{"chatId":"-1002"}', LEGACY.bot, '2026-10-20T00:00:01.000Z', '2026-10-20T00:00:01.000Z', LEGACY.inbox, '{"to":["me@example.com"],"subjectPrefix":""}', LEGACY.mail, at, at);
  seed.prepare("INSERT INTO alert_rules(id,channel_id,source_kind,source_id,events,enabled,created_at,updated_at) VALUES(?,?,'docknest',NULL,'[\"backup.failed\"]',1,?,?)").run(randomUUID(), LEGACY.family, at, at);
  seed.close();
}
const logs = [], capture = (...args) => logs.push(args.map(String).join(' '));
const originals = { log: console.log, error: console.error, warn: console.warn };
console.log = capture; console.error = capture; console.warn = capture;
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const delivery = await import('../src/alerts/delivery.js');
const store = await import('../src/alerts/store.js');
const connections = await import('../src/alerts/connections.js');
const { providerList, provider } = await import('../src/alerts/providers/index.js');
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;

function user(role) {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId, userId + '@example.invalid', 'fixture', 'fixture', '[]', new Date().toISOString(), role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), userId, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), Date.now());
  return (route, options = {}) => fetch(base + route, { ...options, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, 'x-csrf-token': 'csrf', 'Content-Type': 'application/json' } });
}
const admin = user('admin');
// The 2.8 routes are gone (the Map uses /api/connections and /api/alerts/nodes); their store functions are the 2.8 view
// these upgrade tests check, called the way the old routes did (tests/fixtures/legacy-alert-calls.js).
const responses = [];
const call = legacyCalls({ store, delivery, actor: 'admin-test', record: text => responses.push(text) });
const http = async (method, route, body) => { const response = await admin(route, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const text = await response.text(); responses.push(text); return { status: response.status, body: text ? JSON.parse(text) : null }; };
const mockFetch = handler => { const calls = []; delivery.alertHttp.fetch = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); }; return calls; };
const ok = () => new Response('{"ok":true,"result":{}}', { status: 200 });
const group = credentialId => db.prepare('SELECT * FROM connections WHERE origin=? ORDER BY created_at,id').all(`legacy:${credentialId}`);
const tgNode = (name, chatId, credentialId = LEGACY.bot) => ({ kind: 'telegram', name, credentialId, config: { chatId } });

test('the upgrade copied the 2.8 alerts and the 2.8 routes show them exactly as before', async () => {
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, migrations.at(-1).version);
  const { body } = await call('GET', '/alerts');
  assert.deepEqual(body.credentials.map(item => [item.id, item.kind, item.name]), [[LEGACY.bot, 'telegram', 'Bot'], [LEGACY.mail, 'smtp', 'Mail']].sort((a, b) => a[0].localeCompare(b[0])), 'credential ids kept, in the 2.8 order (created_at, id)');
  const bot = body.credentials.find(item => item.id === LEGACY.bot);
  assert.deepEqual(bot.config, { tokenSet: true }); assert.equal(bot.configReadable, true);
  assert.deepEqual(bot.usedBy.map(item => item.name), ['Family', 'Work'], 'usedBy combines both chats');
  assert.deepEqual(body.credentials.find(item => item.id === LEGACY.mail).config, { host: 'smtp.example.com', port: 587, security: 'starttls', username: 'bot', passwordSet: true, from: 'docknest@example.com' });
  assert.deepEqual(body.channels.map(item => [item.id, item.credentialId, item.config]), [[LEGACY.family, LEGACY.bot, { chatId: '-1001' }], [LEGACY.inbox, LEGACY.mail, { to: ['me@example.com'], subjectPrefix: '' }], [LEGACY.work, LEGACY.bot, { chatId: '-1002' }]].sort((a, b) => body.channels.findIndex(item => item.id === a[0]) - body.channels.findIndex(item => item.id === b[0])), 'node ids kept');
  assert.ok(body.channels.every(item => item.needsCredential === false));
  assert.equal(body.rules.length, 1); assert.equal(body.rules[0].channelId, LEGACY.family);
  assert.equal(group(LEGACY.bot).length, 2, 'two chats, two Connections');
  assert.ok(group(LEGACY.bot).every(row => row.secret === sealedBot), 'sealed bytes identical');
  assert.equal(connections.legacyChangedSinceImport(), false);
});

test('adapter: a new chat gets a new Connection with the sealed login copied as is; a known chat reuses its Connection', async () => {
  const created = await call('POST', '/alerts/channels', tgNode('Ops', '-1003'));
  assert.equal(created.status, 201); assert.equal(created.body.credentialId, LEGACY.bot); assert.equal(created.body.credentialName, 'Bot');
  const rows = group(LEGACY.bot);
  assert.equal(rows.length, 3); const ops = rows.find(row => row.settings === '{"chatId":"-1003"}');
  assert.equal(ops.secret, sealedBot, 'copied byte for byte, never opened and resealed'); assert.equal(ops.name, 'Bot (Ops)');
  const again = await call('POST', '/alerts/channels', tgNode('Family too', '-1001'));
  assert.equal(again.status, 201); assert.equal(group(LEGACY.bot).length, 3, 'same chat, same Connection');
  // Moving a node that is alone on its Connection to a new chat changes that Connection in place.
  const moved = await call('PATCH', `/alerts/channels/${created.body.id}`, { config: { chatId: '-1005' } });
  assert.deepEqual(moved.body.config, { chatId: '-1005' }); assert.equal(group(LEGACY.bot).length, 3);
  // Moving a shared node away leaves its old Connection to the others and needs a new one.
  const split = await call('PATCH', `/alerts/channels/${again.body.id}`, { config: { chatId: '-1006' } });
  assert.deepEqual(split.body.config, { chatId: '-1006' }); assert.equal(group(LEGACY.bot).length, 4);
  assert.deepEqual((await call('GET', '/alerts/credentials')).body.credentials.find(item => item.id === LEGACY.bot).usedBy.map(item => item.name), ['Family', 'Family too', 'Ops', 'Work']);
  // Deleting a node frees its Connection; the next new chat reuses it instead of piling up Connections.
  await call('DELETE', `/alerts/channels/${again.body.id}`);
  await call('POST', '/alerts/channels', tgNode('Reuse', '-1007'));
  assert.equal(group(LEGACY.bot).length, 4);
});

test('adapter: a node test and a queued alert go to the node’s own chat with the shared login', async () => {
  const calls = mockFetch(ok);
  const work = (await call('POST', `/alerts/channels/${LEGACY.work}/test`));
  assert.equal(work.status, 200);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { chat_id: '-1002', text: 'DockNest test message\nYour alerts are connected.', link_preview_options: { is_disabled: true } });
  assert.equal((await call('GET', '/alerts/channels')).body.channels.find(item => item.id === LEGACY.work).lastResult, 'ok');
});

test('adapter: replacing the secret updates every Connection, removes the frozen 2.8 row with secure_delete and a WAL checkpoint', async () => {
  const before = db.prepare('PRAGMA secure_delete').get().secure_delete;
  const renamed = await call('PATCH', `/alerts/credentials/${LEGACY.bot}`, { name: 'Home bot' });
  assert.equal(renamed.status, 200); assert.equal(renamed.body.name, 'Home bot');
  assert.ok(group(LEGACY.bot).every(row => row.name === 'Home bot' || row.name.startsWith('Home bot (')));
  assert.ok(db.prepare('SELECT 1 FROM alert_credentials WHERE id=?').get(LEGACY.bot), 'a rename keeps the 2.8 row');
  const replaced = await call('PATCH', `/alerts/credentials/${LEGACY.bot}`, { config: { token: NEW_TOKEN } });
  assert.equal(replaced.status, 200); assert.deepEqual(replaced.body.config, { tokenSet: true });
  const rows = group(LEGACY.bot), secrets = new Set(rows.map(row => row.secret));
  assert.equal(secrets.size, 1, 'one new sealed value for all'); assert.equal(JSON.parse(open([...secrets][0])).token, NEW_TOKEN);
  assert.equal(db.prepare('SELECT 1 FROM alert_credentials WHERE id=?').get(LEGACY.bot), undefined, 'the 2.8 row with the old token is gone');
  assert.equal(db.prepare('SELECT credential_id FROM alert_channels WHERE id=?').get(LEGACY.family).credential_id, null, '2.8 nodes need a credential after a downgrade');
  assert.equal(db.prepare('PRAGMA secure_delete').get().secure_delete, before, 'secure_delete restored');
  const bytes = Buffer.concat([await readFile(join(directory, 'state.sqlite')), await readFile(join(directory, 'state.sqlite-wal')).catch(() => Buffer.alloc(0))]);
  assert.ok(!bytes.includes(Buffer.from(sealedBot)), 'the old sealed token is not left in the database or WAL file');
  const calls = mockFetch(ok);
  assert.equal((await call('POST', `/alerts/channels/${LEGACY.family}/test`)).status, 200);
  assert.ok(calls[0].url.includes(NEW_TOKEN));
});

test('adapter: delete is refused while any node of any of its Connections exists, then removes them all', async () => {
  const refused = await call('DELETE', `/alerts/credentials/${LEGACY.bot}`);
  assert.equal(refused.status, 409); assert.equal(refused.body.code, 'CREDENTIAL_IN_USE');
  assert.deepEqual(refused.body.nodes, ['Family', 'Ops', 'Reuse', 'Work']);
  for (const node of (await call('GET', '/alerts/channels')).body.channels.filter(item => item.credentialId === LEGACY.bot)) await call('DELETE', `/alerts/channels/${node.id}`);
  assert.equal((await call('DELETE', `/alerts/credentials/${LEGACY.bot}`)).status, 200);
  assert.equal(group(LEGACY.bot).length, 0);
  assert.equal((await call('GET', '/alerts/credentials')).body.credentials.some(item => item.id === LEGACY.bot), false);
});

test('a credential made after the upgrade, and an email-only setup with two inboxes, through the 2.8 routes', async () => {
  const mail = await call('POST', '/alerts/credentials', { kind: 'smtp', name: 'Relay', config: { host: 'mail.example.net', port: 465, security: 'tls', username: 'u', password: PASSWORD, from: 'a@example.net' } });
  assert.equal(mail.status, 201); assert.deepEqual(mail.body.usedBy, []);
  const [row] = group(mail.body.id);
  assert.equal(row.id, mail.body.id); assert.equal(row.settings, '{}'); assert.equal(row.private_ok, 1);
  const a = await call('POST', '/alerts/channels', { kind: 'email', name: 'Ops inbox', credentialId: mail.body.id, config: { to: ['ops@example.net'] } });
  const b = await call('POST', '/alerts/channels', { kind: 'email', name: 'CEO inbox', credentialId: mail.body.id, config: { to: ['ceo@example.net'], subjectPrefix: '[DockNest]' } });
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  const rows = group(mail.body.id);
  assert.equal(rows.length, 2, 'the unused Connection took the first inbox; the second got its own');
  assert.equal(rows[0].settings, '{"to":["ops@example.net"],"subjectPrefix":""}');
  assert.equal(rows[1].secret, rows[0].secret);
  assert.deepEqual(b.body.config, { to: ['ceo@example.net'], subjectPrefix: '[DockNest]' });
  assert.equal((await call('PATCH', `/alerts/credentials/${mail.body.id}`, { config: { host: 'mail.other.example' } })).status, 400, 'a new mail server needs the password again');
});

test('unicode and very long names stay within 80 characters and never split a character', async () => {
  const name = '🚀'.repeat(40);
  const bot = await call('POST', '/alerts/credentials', { kind: 'telegram', name, config: { token: TOKEN } });
  await call('POST', '/alerts/channels', tgNode('Équipe ✉', '-2001', bot.body.id));
  await call('POST', '/alerts/channels', tgNode('Ünïcödé '.repeat(10).slice(0, 80), '-2002', bot.body.id));
  for (const row of group(bot.body.id)) { assert.ok(row.name.isWellFormed(), row.name); assert.ok(db.prepare('SELECT length(name) AS n FROM connections WHERE id=?').get(row.id).n <= 80); }
});

test('a corrupt or truncated sealed value: no crash, a clear error, and other nodes keep working', async () => {
  const good = await call('POST', '/alerts/credentials', { kind: 'telegram', name: 'Good', config: { token: TOKEN } });
  const bad = await call('POST', '/alerts/credentials', { kind: 'telegram', name: 'Bad', config: { token: TOKEN } });
  const goodNode = (await call('POST', '/alerts/channels', tgNode('Good node', '-3001', good.body.id))).body;
  const badNode = (await call('POST', '/alerts/channels', tgNode('Bad node', '-3002', bad.body.id))).body;
  for (const node of [goodNode, badNode]) store.createRule({ channelId: node.id, sourceKind: 'docknest', events: ['server.disk_low'] }, 'test');
  const [badRow] = group(bad.body.id);
  for (const corrupt of [badRow.secret.slice(0, 20), 'not-base64-at-all!', badRow.secret.slice(0, -4) + 'AAAA']) {
    db.prepare('UPDATE connections SET secret=? WHERE id=?').run(corrupt, badRow.id);
    const view = (await call('GET', '/alerts/credentials')).body.credentials.find(item => item.id === bad.body.id);
    assert.equal(view.configReadable, false); assert.equal(view.config, null);
    assert.equal((await call('GET', '/alerts/channels')).status, 200);
    const test = await call('POST', `/alerts/channels/${badNode.id}/test`);
    assert.equal(test.status, 502); assert.equal(test.body.error, 'The saved settings cannot be read. Enter them again.');
  }
  db.exec("DELETE FROM alert_outbox");
  const calls = mockFetch(ok), t0 = Date.parse('2026-10-28T03:00:00Z');
  assert.equal(delivery.emit({ type: 'server.disk_low', key: 'server:x', serverName: 'srv', freeBytes: 1, usedPercent: 99 }, { at: t0 }), 2);
  assert.equal(await delivery.deliverDue({ at: t0 }), 1, 'the healthy node still sends');
  assert.equal(calls.length, 1); assert.equal(JSON.parse(calls[0].init.body).chat_id, '-3001');
  assert.equal(db.prepare('SELECT last_error FROM connections WHERE id=?').get(badRow.id).last_error, 'The saved settings cannot be read. Enter them again.');
  assert.equal(db.prepare("SELECT status FROM alert_outbox WHERE connection_id=?").get(badRow.id).status, 'pending', 'retried later, as any failure');
});

test('dedup per Connection: two nodes on one chat get one message; other chats and windows behave as in 2.8', async () => {
  db.exec('DELETE FROM alert_outbox');
  const bot = (await call('POST', '/alerts/credentials', { kind: 'telegram', name: 'Dedup', config: { token: TOKEN } })).body;
  const one = (await call('POST', '/alerts/channels', tgNode('One', '-4001', bot.id))).body, two = (await call('POST', '/alerts/channels', tgNode('Two', '-4001', bot.id))).body, other = (await call('POST', '/alerts/channels', tgNode('Other', '-4002', bot.id))).body;
  for (const node of [one, two, other]) store.createRule({ channelId: node.id, sourceKind: 'docknest', events: ['backup.succeeded'] }, 'test');
  const event = key => ({ type: 'backup.succeeded', key, siteName: 's', serverName: 'v' }), t0 = Date.parse('2026-10-28T05:00:00Z');
  assert.equal(delivery.emit(event('site:a'), { at: t0 }), 2, 'chat -4001 once, chat -4002 once');
  assert.equal(delivery.emit(event('site:a'), { at: t0 + 10 * 60_000 }), 0, 'exactly at the 10-minute boundary it is still a repeat');
  assert.equal(delivery.emit(event('site:a'), { at: t0 + 10 * 60_000 + 1 }), 2, 'one millisecond later it may repeat');
  assert.equal(delivery.emit({ ...event('occ:release:1') }, { at: t0 }), 2);
  assert.equal(delivery.emit({ ...event('occ:release:1') }, { at: t0 + 30 * 86400_000 }), 0, 'an occurrence is never sent twice');
  db.prepare('UPDATE alert_lines SET enabled=0 WHERE node_id IN (?,?,?)').run(one.id, two.id, other.id);
  assert.equal(delivery.emit(event('site:b'), { at: t0 }), 0, 'disabled lines send nothing');
  db.prepare('UPDATE alert_lines SET enabled=1 WHERE node_id IN (?,?,?)').run(one.id, two.id, other.id);
  // Lines to sites or servers that no longer exist never match and never fail.
  store.updateRule(db.prepare('SELECT id FROM alert_lines WHERE node_id=?').get(one.id).id, { events: ['backup.succeeded', 'backup.failed'] }, 'test');
  db.prepare("INSERT INTO alert_lines(id,node_id,source_kind,source_id,events,enabled,created_at,updated_at) VALUES(?,?,'site',?,'[\"backup.failed\"]',1,'x','x')").run(randomUUID(), other.id, randomUUID());
  assert.equal(delivery.emit({ type: 'backup.failed', key: 'site:gone', siteId: randomUUID(), siteName: 'gone', serverName: 'v' }, { at: t0 }), 1);
});

test('cap: 50 pending per Connection, then one "N more alerts" item updated in place; maximum age 24 hours', async () => {
  db.exec('DELETE FROM alert_outbox;UPDATE alert_lines SET enabled=0'); // only this test’s lines speak
  const bot = (await call('POST', '/alerts/credentials', { kind: 'telegram', name: 'Cap', config: { token: TOKEN } })).body;
  const node = (await call('POST', '/alerts/channels', tgNode('Cap', '-5001', bot.id))).body;
  store.createRule({ channelId: node.id, sourceKind: 'docknest', events: ['backup.failed'] }, 'test');
  const t0 = Date.parse('2026-10-29T00:00:00Z'), connectionId = group(bot.id)[0].id;
  const emit = index => delivery.emit({ type: 'backup.failed', key: `site:${index}`, siteName: `s${index}`, serverName: 'v' }, { at: t0 });
  for (let index = 0; index < 49; index++) emit(index);
  const pending = () => db.prepare("SELECT COUNT(*) AS n FROM alert_outbox WHERE connection_id=? AND status='pending'").get(connectionId).n;
  assert.equal(pending(), 49); emit(49); assert.equal(pending(), 50, 'the 50th is still stored');
  emit(50); assert.equal(pending(), 51);
  const collapsed = () => db.prepare('SELECT message,payload FROM alert_outbox WHERE dedupe_key=?').get(delivery.COLLAPSE_KEY);
  assert.equal(collapsed().message, '1 more alert. Open DockNest to see it.');
  emit(51); emit(52); assert.equal(pending(), 51, 'folded, not stored one by one');
  assert.equal(collapsed().message, '3 more alerts. Open DockNest to see them.'); assert.deepEqual(JSON.parse(collapsed().payload), { collapsed: 3 });
  // Maximum age: one millisecond before it the item is sent; at it, it is failed without sending.
  db.exec('DELETE FROM alert_outbox');
  emit('young'); emit('old');
  db.prepare("UPDATE alert_outbox SET expires_at=? WHERE dedupe_key='backup.failed:site:old'").run(t0 + 1000);
  db.prepare("UPDATE alert_outbox SET expires_at=? WHERE dedupe_key='backup.failed:site:young'").run(t0 + 1001);
  const calls = mockFetch(ok);
  assert.equal(await delivery.deliverDue({ at: t0 + 1000 }), 1);
  assert.equal(calls.length, 1); assert.match(JSON.parse(calls[0].init.body).text, /^Backup failed\nsyoung on v/);
  assert.equal(db.prepare("SELECT status FROM alert_outbox WHERE dedupe_key='backup.failed:site:old'").get().status, 'failed');
  assert.equal(delivery.deliveryPolicy.maxAgeMs, 24 * 3600_000); assert.equal(delivery.deliveryPolicy.pendingCap, 50);
});

test('a deleted node keeps its outbox history (node_id NULL); a Connection no node uses sends nothing; a rejected login is final', async () => {
  db.exec('DELETE FROM alert_outbox;UPDATE alert_lines SET enabled=0');
  const bot = (await call('POST', '/alerts/credentials', { kind: 'telegram', name: 'Gone', config: { token: TOKEN } })).body;
  const node = (await call('POST', '/alerts/channels', tgNode('Gone', '-6001', bot.id))).body;
  store.createRule({ channelId: node.id, sourceKind: 'docknest', events: ['backup.failed'] }, 'test');
  const t0 = Date.parse('2026-10-30T00:00:00Z');
  delivery.emit({ type: 'backup.failed', key: 'site:z', siteName: 's', serverName: 'v' }, { at: t0 });
  await call('DELETE', `/alerts/channels/${node.id}`);
  const connectionId = group(bot.id)[0].id, item = db.prepare('SELECT * FROM alert_outbox WHERE connection_id=?').get(connectionId);
  assert.equal(item.node_id, null); assert.equal(item.status, 'pending');
  const calls = mockFetch(ok);
  db.exec("DELETE FROM alert_outbox WHERE connection_id<>'" + connectionId + "'");
  await delivery.deliverDue({ at: t0 }); assert.equal(calls.length, 0); assert.equal(db.prepare('SELECT status FROM alert_outbox').get().status, 'failed');
  const again = (await call('POST', '/alerts/channels', tgNode('Back', '-6001', bot.id))).body;
  store.createRule({ channelId: again.id, sourceKind: 'docknest', events: ['backup.failed'] }, 'test');
  assert.equal(delivery.emit({ type: 'backup.failed', key: 'site:z', siteName: 's', serverName: 'v' }, { at: t0 + 60_000 }), 0, 'dedup history survived the deleted node');
  db.exec('DELETE FROM alert_outbox');
  mockFetch(() => new Response('{"ok":false}', { status: 401 }));
  delivery.emit({ type: 'backup.failed', key: 'site:final', siteName: 's', serverName: 'v' }, { at: t0 });
  await delivery.deliverDue({ at: t0 });
  assert.deepEqual({ ...db.prepare('SELECT status,attempts FROM alert_outbox WHERE connection_id=?').get(connectionId) }, { status: 'failed', attempts: 1 }, 'a rejected bot token is not retried');
});

test('a new destination starts with no dedup history: a real alert to the new chat or inbox is never suppressed', async () => {
  db.exec('DELETE FROM alert_outbox;UPDATE alert_lines SET enabled=0');
  const bot = (await call('POST', '/alerts/credentials', { kind: 'telegram', name: 'Moving', config: { token: TOKEN } })).body;
  const node = (await call('POST', '/alerts/channels', tgNode('Moving', '-7001', bot.id))).body;
  store.createRule({ channelId: node.id, sourceKind: 'docknest', events: ['backup.failed'] }, 'test');
  const connectionId = group(bot.id)[0].id, t0 = Date.parse('2026-10-31T00:00:00Z'), failed = { type: 'backup.failed', key: 'site:m', siteName: 's', serverName: 'v' };
  const calls = mockFetch(ok);
  assert.equal(delivery.emit(failed, { at: t0 }), 1); await delivery.deliverDue({ at: t0 });
  assert.equal(delivery.emit(failed, { at: t0 + 60_000 }), 0, 'a repeat to the same chat inside the window is dropped');
  await call('PATCH', `/alerts/channels/${node.id}`, { config: { chatId: '-7002' } });
  assert.equal(group(bot.id).length, 1, 'the Connection moved in place');
  assert.equal(delivery.emit(failed, { at: t0 + 120_000 }), 1, 'the new chat gets it');
  await delivery.deliverDue({ at: t0 + 120_000 });
  assert.deepEqual(calls.map(item => JSON.parse(item.init.body).chat_id), ['-7001', '-7002']);
  // Pending items are kept and go to the new destination; only finished history is cleared.
  delivery.emit({ ...failed, key: 'site:p' }, { at: t0 + 180_000 });
  await call('PATCH', `/alerts/channels/${node.id}`, { config: { chatId: '-7003' } });
  assert.deepEqual(db.prepare('SELECT status,dedupe_key FROM alert_outbox WHERE connection_id=?').all(connectionId).map(row => `${row.status}:${row.dedupe_key}`), ['pending:backup.failed:site:p']);
  // Email: changing the recipients clears the history the same way.
  const mail = (await call('POST', '/alerts/credentials', { kind: 'smtp', name: 'Moving mail', config: { host: 'smtp.example.com', port: 587, security: 'starttls', username: '', password: '', from: 'a@example.com' } })).body;
  const inbox = (await call('POST', '/alerts/channels', { kind: 'email', name: 'Moving inbox', credentialId: mail.id, config: { to: ['old@example.com'] } })).body;
  store.createRule({ channelId: inbox.id, sourceKind: 'docknest', events: ['backup.succeeded'] }, 'test');
  const done = { type: 'backup.succeeded', key: 'site:e', siteName: 's', serverName: 'v' }, mailConnection = group(mail.id)[0].id;
  delivery.emit(done, { at: t0 }); db.prepare("UPDATE alert_outbox SET status='sent',finished_at='x' WHERE connection_id=?").run(mailConnection);
  assert.equal(delivery.emit(done, { at: t0 + 60_000 }), 0);
  await call('PATCH', `/alerts/channels/${inbox.id}`, { config: { to: ['new@example.com'] } });
  assert.equal(delivery.emit(done, { at: t0 + 60_000 }), 1, 'the new inbox gets it');
});

test('a node moved to another Connection takes its pending items along; an unused Connection taken over keeps none', async () => {
  db.exec('DELETE FROM alert_outbox;UPDATE alert_lines SET enabled=0');
  const first = (await call('POST', '/alerts/credentials', { kind: 'telegram', name: 'Old bot', config: { token: TOKEN } })).body;
  const second = (await call('POST', '/alerts/credentials', { kind: 'telegram', name: 'New bot', config: { token: NEW_TOKEN } })).body;
  const node = (await call('POST', '/alerts/channels', tgNode('Switching', '-8001', first.id))).body;
  store.createRule({ channelId: node.id, sourceKind: 'docknest', events: ['backup.failed'] }, 'test');
  const t0 = Date.parse('2026-11-02T00:00:00Z'), failed = key => ({ type: 'backup.failed', key, siteName: 's', serverName: 'v' });
  assert.equal(delivery.emit(failed('site:w'), { at: t0 }), 1);
  // The bot is replaced by another credential before the retry: the waiting alert goes out with the new bot, once.
  assert.equal((await call('PATCH', `/alerts/channels/${node.id}`, { credentialId: second.id })).status, 200);
  const calls = mockFetch(ok);
  assert.equal(await delivery.deliverDue({ at: t0 }), 1, 'the pending alert is not lost');
  assert.equal(calls.length, 1); assert.ok(calls[0].url.includes(NEW_TOKEN)); assert.equal(JSON.parse(calls[0].init.body).chat_id, '-8001');
  // Moving into a destination that already has the same event pending sends it once, not twice.
  const other = (await call('POST', '/alerts/channels', tgNode('Other', '-8002', second.id))).body;
  store.createRule({ channelId: other.id, sourceKind: 'docknest', events: ['backup.failed'] }, 'test');
  assert.equal(delivery.emit(failed('site:dup'), { at: t0 + 1000 }), 2);
  await call('PATCH', `/alerts/channels/${node.id}`, { config: { chatId: '-8002' } });
  calls.length = 0; await delivery.deliverDue({ at: t0 + 1000 });
  assert.deepEqual(calls.map(item => JSON.parse(item.init.body).chat_id), ['-8002'], 'one message to the shared chat');
  // A deleted node's waiting item never reaches the next destination of its Connection.
  await call('DELETE', `/alerts/channels/${other.id}`); await call('DELETE', `/alerts/channels/${node.id}`);
  const gone = (await call('POST', '/alerts/channels', tgNode('Gone soon', '-8003', first.id))).body;
  store.createRule({ channelId: gone.id, sourceKind: 'docknest', events: ['backup.failed'] }, 'test');
  assert.equal(delivery.emit(failed('site:left'), { at: t0 + 2000 }), 1);
  await call('DELETE', `/alerts/channels/${gone.id}`);
  await call('POST', '/alerts/channels', tgNode('Newcomer', '-8004', first.id));
  calls.length = 0; await delivery.deliverDue({ at: t0 + 2000 });
  assert.equal(calls.length, 0, 'nothing meant for -8003 goes to -8004');
});

test('cap: events folded into "N more alerts" keep their dedup entry, so a repeat inside the window is not counted again', async () => {
  db.exec('DELETE FROM alert_outbox;UPDATE alert_lines SET enabled=0');
  const bot = (await call('POST', '/alerts/credentials', { kind: 'telegram', name: 'Fold', config: { token: TOKEN } })).body;
  const node = (await call('POST', '/alerts/channels', tgNode('Fold', '-8001', bot.id))).body;
  store.createRule({ channelId: node.id, sourceKind: 'docknest', events: ['backup.failed'] }, 'test');
  const t0 = Date.parse('2026-11-01T00:00:00Z'), emit = (key, at = t0) => delivery.emit({ type: 'backup.failed', key, siteName: 's', serverName: 'v' }, { at });
  for (let index = 0; index < 50; index++) emit(`site:${index}`);
  const collapsed = () => JSON.parse(db.prepare('SELECT payload FROM alert_outbox WHERE dedupe_key=?').get(delivery.COLLAPSE_KEY).payload).collapsed;
  assert.equal(emit('site:x'), 1); assert.equal(collapsed(), 1);
  assert.equal(emit('site:x', t0 + 10 * 60_000), 0, 'a repeat at exactly the 10-minute boundary is dropped'); assert.equal(collapsed(), 1);
  assert.equal(emit('site:x', t0 + 10 * 60_000 + 1), 1, 'one millisecond later it counts again'); assert.equal(collapsed(), 2);
  assert.equal(emit('occ:release:9'), 1); assert.equal(emit('occ:release:9', t0 + 86400_000), 0, 'a folded occurrence is never counted twice'); assert.equal(collapsed(), 3);
  // The entries are never delivered on their own: one send per stored item plus one for the folded count. Each round
  // starts a new rate window (20 messages per Connection per 10 minutes).
  const calls = mockFetch(ok);
  for (let round = 0; round < 4; round++) await delivery.deliverDue({ at: t0 + round * delivery.deliveryPolicy.rateWindowMs });
  assert.equal(calls.length, 51); assert.equal(JSON.parse(calls.at(-1).init.body).text, '3 more alerts. Open DockNest to see them.');
});

test('secrets never appear in views, API answers, logs, audit rows, outbox rows or errors', async () => {
  for (const route of ['/alerts', '/alerts/credentials', '/alerts/channels', '/alerts/rules']) await call('GET', route);
  for (const route of ['/alerts', '/alerts/nodes', '/alerts/rules', '/connections', '/connections/providers']) assert.equal((await http('GET', route)).status, 200, route);
  const views = JSON.stringify(connections.listConnections()) + JSON.stringify(store.listCredentials()) + JSON.stringify(store.listChannels()) + JSON.stringify(providerList());
  const stored = JSON.stringify(db.prepare('SELECT * FROM audit_events').all()) + JSON.stringify(db.prepare('SELECT * FROM alert_outbox').all()) + JSON.stringify(db.prepare('SELECT id,name,settings,origin,last_error FROM connections').all()) + JSON.stringify(db.prepare('SELECT * FROM alert_nodes').all());
  for (const secret of [TOKEN, NEW_TOKEN, PASSWORD, '123456789:', sealedBot, sealedMail]) {
    for (const [label, text] of [['views', views], ['responses', responses.join('\n')], ['logs', logs.join('\n')], ['stored', stored]]) assert.ok(!text.includes(secret), `${label} hold ${secret.slice(0, 6)}...`);
  }
  assert.ok(connections.listConnections().every(view => !('secret' in view)));
  assert.ok(provider('telegram').fields.find(field => field.key === 'token').secret);
});

test('the provider registry lists every provider, and unknown ids are refused', () => {
  assert.deepEqual(providerList().map(item => item.id), ['telegram', 'email', 'whatsapp', 'discord', 'slack', 'teams', 'googlechat', 'mattermost', 'ntfy', 'gotify', 'pushover', 'matrix', 'webhook']);
  assert.equal(provider('aim'), null); assert.equal(provider('__proto__'), null); assert.equal(provider('constructor'), null);
});

test('an older DockNest changing the frozen 2.8 tables after the upgrade is detected for the Connections page warning', () => {
  assert.equal(connections.legacyChangedSinceImport(), false);
  db.prepare("UPDATE alert_channels SET updated_at='2999-01-01T00:00:00.000Z' WHERE id=?").run(LEGACY.inbox);
  assert.equal(connections.legacyChangedSinceImport(), true);
});

test.after(() => { Object.assign(console, originals); listener.close(); listener.closeAllConnections?.(); });
