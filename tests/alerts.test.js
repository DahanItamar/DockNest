// Alert engine: sealed write-only secrets, roles and re-verification, rule matching, dedupe, retry with backoff, the
// Telegram request shape (mocked fetch), the detector over the real tables and the SMTP client against local fake servers.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { legacyCalls } from './fixtures/legacy-alert-calls.js';

const directory = await mkdtemp(join(tmpdir(), 'docknest-alerts-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const delivery = await import('../src/alerts/delivery.js');
const detect = await import('../src/alerts/detect.js');
const store = await import('../src/alerts/store.js');
const events = await import('../src/alerts/events.js');
const smtp = await import('../src/alerts/smtp.js');
smtp.smtpPolicy.allowLoopback = true; // the fake servers listen on 127.0.0.1; production code never sets this
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
const at = () => new Date().toISOString();

function user(role, authenticatedAt = Date.now(), csrfHeader = true) {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId, userId + '@example.invalid', 'fixture', 'fixture', '[]', at(), role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), userId, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), authenticatedAt);
  return (route, options = {}) => fetch(base + route, { ...options, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, ...(csrfHeader ? { 'x-csrf-token': 'csrf' } : {}), 'Content-Type': 'application/json' } });
}
const admin = user('admin'), staleAdmin = user('admin', Date.now() - 3600000), operator = user('operator'), noCsrf = user('admin', Date.now(), false);
// The 2.8 credential and channel routes are gone; their store functions stay as the 2.8 view that these tests check,
// called the way the old routes did (tests/fixtures/legacy-alert-calls.js). Everything else goes over HTTP.
const legacy = legacyCalls({ store, delivery, actor: 'admin' }), legacyRoute = /^[/]alerts[/](credentials|channels)([/]|$)/;
const send = async (as, method, route, body) => {
  if ((as === admin || as === staleAdmin) && legacyRoute.test(route)) { const answer = await legacy(method, route, body); return { status: answer.status, json: async () => answer.body, text: async () => JSON.stringify(answer.body) }; }
  return as(route, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
};

const TOKEN = '123456789:' + 'AbCdEf_-12'.repeat(4).slice(0, 35), PASSWORD = 'hunter2-correct-horse';
const server = (name, host = '203.0.113.7') => { const serverId = randomUUID(); db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(serverId, name, host, 22, 'root', 'fixture', '0'.repeat(64), at()); return serverId; };
const site = (serverId, name) => { const siteId = randomUUID(); db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, serverId, name, '{}', at()); return siteId; };
const tgCredential = () => (store.listCredentials().find(item => item.kind === 'telegram') ?? store.createCredential({ kind: 'telegram', name: 'Bot', config: { token: TOKEN } }, 'test'));
const tgNode = (extra = {}) => ({ kind: 'telegram', name: 'Phone', credentialId: tgCredential().id, config: { chatId: '-1001234567890' }, ...extra });
const mockFetch = handler => { const calls = []; delivery.alertHttp.fetch = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); }; return calls; };
const ok = () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
// Alerts live in the Connections tables (docs/alert-channels.md); the 2.8 tables stay frozen and unused.
const reset = () => { db.exec('DELETE FROM alert_outbox;DELETE FROM alert_lines;DELETE FROM alert_nodes;DELETE FROM connections;'); };

const credBody = { kind: 'telegram', name: 'Bot', config: { token: TOKEN } };
const smtpBody = { kind: 'smtp', name: 'Mail account', config: { host: 'smtp.example.com', port: 587, security: 'starttls', username: 'bot', password: PASSWORD, from: 'docknest@example.com' } };

test('administrators reach the alert API, operators do not while the setting is off, writes need CSRF and Connection writes need a recent re-verification', async () => {
  reset();
  const connection = { provider: 'telegram', name: 'Bot', values: { token: TOKEN, chatId: '-1001234567890' } };
  assert.equal((await send(operator, 'GET', '/alerts')).status, 403);
  assert.equal((await send(operator, 'GET', '/connections')).status, 403);
  assert.equal((await send(operator, 'POST', '/connections', connection)).status, 403);
  assert.equal((await send(noCsrf, 'POST', '/connections', connection)).status, 403);
  const stale = await send(staleAdmin, 'POST', '/connections', connection);
  assert.equal(stale.status, 403); assert.equal((await stale.json()).code, 'REAUTH_REQUIRED');
  assert.equal((await send(staleAdmin, 'GET', '/alerts')).status, 200, 'reading is allowed without re-verification');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM connections').get().n, 0);
  const made = await (await send(admin, 'POST', '/connections', connection)).json();
  assert.equal((await send(staleAdmin, 'PATCH', `/connections/${made.id}`, { name: 'Renamed' })).status, 200, 'a rename needs no re-verification');
  assert.equal((await send(staleAdmin, 'PATCH', `/connections/${made.id}`, { values: { chatId: '-100999' } })).status, 403, 'a destination change does');
  assert.equal((await send(staleAdmin, 'DELETE', `/connections/${made.id}`)).status, 403);
  assert.equal((await send(operator, 'POST', '/alerts/nodes', { name: 'Phone', provider: 'telegram', connectionId: made.id })).status, 403);
  assert.equal((await send(staleAdmin, 'POST', '/alerts/nodes', { name: 'Phone', provider: 'telegram', connectionId: made.id })).status, 201, 'nodes hold no secret and need no re-verification');
});

test('credential secrets are sealed, never returned, never audited, and kept when an update omits them', async () => {
  reset();
  const created = await send(admin, 'POST', '/alerts/credentials', credBody), view = await created.json();
  assert.equal(created.status, 201); assert.deepEqual(view.config, { tokenSet: true });
  const row = db.prepare('SELECT * FROM connections WHERE id=?').get(view.id);
  assert.ok(!row.secret.includes(TOKEN) && !row.secret.includes('123456789'), 'stored sealed, not as text');
  const mail = await (await send(admin, 'POST', '/alerts/credentials', smtpBody)).json();
  assert.deepEqual(mail.config, { host: 'smtp.example.com', port: 587, security: 'starttls', username: 'bot', passwordSet: true, from: 'docknest@example.com' });
  const node = await (await send(admin, 'POST', '/alerts/channels', tgNode({ credentialId: view.id }))).json();
  for (const route of ['/alerts', '/alerts/credentials', '/alerts/channels']) { const text = await (await send(admin, 'GET', route)).text(); assert.ok(!text.includes(TOKEN) && !text.includes(PASSWORD), route); }
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM alert_nodes WHERE id=?').get(node.id)).includes(TOKEN) && !JSON.stringify(db.prepare('SELECT settings FROM connections').all()).includes(TOKEN), 'the node and the destination hold no secret');
  const renamed = await (await send(admin, 'PATCH', `/alerts/credentials/${view.id}`, { name: 'Renamed' })).json();
  assert.equal(renamed.name, 'Renamed'); assert.equal(renamed.config.tokenSet, true);
  const { open } = await import('../src/crypto.js');
  assert.equal(JSON.parse(open(db.prepare('SELECT secret FROM connections WHERE id=?').get(view.id).secret)).token, TOKEN, 'token survived the update');
  for (const change of [{ port: 25 }, { security: 'tls' }, { host: 'smtp.other.example' }]) assert.equal((await send(admin, 'PATCH', `/alerts/credentials/${mail.id}`, { config: change })).status, 400, 'needs the password again: ' + JSON.stringify(change));
  assert.equal((await send(admin, 'PATCH', `/alerts/credentials/${mail.id}`, { config: { port: 587, from: 'other@example.com' } })).status, 200, 'unchanged server values and other fields need no password');
  assert.equal((await send(admin, 'PATCH', `/alerts/credentials/${mail.id}`, { config: { host: 'smtp.other.example', password: PASSWORD } })).status, 200);
  const audit = JSON.stringify(db.prepare('SELECT * FROM audit_events WHERE action LIKE ?').all('alert.%'));
  assert.ok(audit.includes('alert.credential.create') && !audit.includes(TOKEN) && !audit.includes(PASSWORD) && !audit.includes('smtp.example.com'));
  assert.equal((await send(admin, 'POST', '/alerts/credentials', { ...credBody, config: { token: 'short' } })).status, 400);
  assert.equal((await send(admin, 'POST', '/alerts/credentials', { kind: 'webhook', name: 'x', config: { url: 'https://example.com' } })).status, 400, 'no webhooks');
  assert.equal((await send(admin, 'POST', '/alerts/credentials', { ...smtpBody, config: { ...smtpBody.config, security: 'none' } })).status, 400, 'no plaintext mode');
  assert.equal((await send(admin, 'POST', '/alerts/credentials', { ...smtpBody, config: { ...smtpBody.config, from: 'a@example.com\r\nBcc: x@example.com' } })).status, 400, 'header injection');
});

test('nodes need a matching credential, share one credential, and a credential in use cannot be deleted', async () => {
  reset();
  const bot = await (await send(admin, 'POST', '/alerts/credentials', credBody)).json(), mail = await (await send(admin, 'POST', '/alerts/credentials', smtpBody)).json();
  const emailNode = { kind: 'email', name: 'Me', credentialId: mail.id, config: { to: ['me@example.com'], subjectPrefix: '[Home]' } };
  assert.equal((await send(admin, 'POST', '/alerts/channels', { ...tgNode({ credentialId: mail.id }) })).status, 400, 'Telegram node with an SMTP credential');
  assert.equal((await send(admin, 'POST', '/alerts/channels', { ...emailNode, credentialId: bot.id })).status, 400);
  assert.equal((await send(admin, 'POST', '/alerts/channels', { ...emailNode, credentialId: randomUUID() })).status, 400);
  assert.equal((await send(admin, 'POST', '/alerts/channels', { ...emailNode, config: { to: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'e@example.com', 'f@example.com'] } })).status, 400, 'at most 5 recipients');
  assert.equal((await send(admin, 'POST', '/alerts/channels', { ...emailNode, config: { to: ['me@example.com'], subjectPrefix: 'a\r\nBcc: x' } })).status, 400);
  const one = await (await send(admin, 'POST', '/alerts/channels', tgNode({ name: 'Family chat', credentialId: bot.id }))).json();
  const two = await (await send(admin, 'POST', '/alerts/channels', tgNode({ name: 'Work chat', credentialId: bot.id, config: { chatId: '-1009876543210' } }))).json();
  const email = await (await send(admin, 'POST', '/alerts/channels', emailNode)).json();
  assert.equal(one.needsCredential, false); assert.equal(one.credentialName, 'Bot'); assert.deepEqual(two.config, { chatId: '-1009876543210' });
  assert.deepEqual(email.config, { to: ['me@example.com'], subjectPrefix: '[Home]' });
  assert.deepEqual((await (await send(admin, 'GET', '/alerts/credentials')).json()).credentials.find(item => item.id === bot.id).usedBy.map(item => item.name), ['Family chat', 'Work chat']);
  const refused = await send(admin, 'DELETE', `/alerts/credentials/${bot.id}`), body = await refused.json();
  assert.equal(refused.status, 409); assert.equal(body.code, 'CREDENTIAL_IN_USE'); assert.deepEqual(body.nodes, ['Family chat', 'Work chat']); assert.match(body.error, /Family chat/);
  assert.equal((await send(admin, 'DELETE', `/alerts/channels/${one.id}`)).status, 200);
  assert.equal((await send(admin, 'DELETE', `/alerts/channels/${two.id}`)).status, 200);
  assert.equal((await send(admin, 'DELETE', `/alerts/credentials/${bot.id}`)).status, 200);
  // A node whose credential is gone (for example changed directly in the database) is flagged and sends nothing.
  db.prepare('UPDATE alert_nodes SET connection_id=NULL WHERE id=?').run(email.id);
  const orphan = (await (await send(admin, 'GET', '/alerts/channels')).json()).channels.find(item => item.id === email.id);
  assert.equal(orphan.needsCredential, true);
  assert.equal((await send(admin, 'POST', `/alerts/channels/${email.id}/test`)).status, 502);
});

test('a node test sends through the credential with the exact Telegram request shape; failures never leak the token', async () => {
  reset();
  const node = await (await send(admin, 'POST', '/alerts/channels', tgNode())).json();
  let calls = mockFetch(ok);
  assert.equal((await send(admin, 'POST', `/alerts/channels/${node.id}/test`)).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { chat_id: '-1001234567890', text: 'DockNest test message\nYour alerts are connected.', link_preview_options: { is_disabled: true } });
  assert.equal(db.prepare('SELECT last_send AS last_result FROM connections').get().last_result, 'ok');
  calls = mockFetch(() => { throw Object.assign(new Error(`connect failed https://api.telegram.org/bot${TOKEN}/sendMessage`), { cause: TOKEN }); });
  const failed = await send(admin, 'POST', `/alerts/channels/${node.id}/test`), text = await failed.text();
  assert.equal(failed.status, 502); assert.ok(!text.includes(TOKEN));
  const stored = JSON.stringify(db.prepare('SELECT id,name,settings,last_error FROM connections').all()) + JSON.stringify(db.prepare('SELECT * FROM alert_nodes').all()) + JSON.stringify(db.prepare('SELECT * FROM audit_events').all());
  assert.ok(!stored.includes(TOKEN), 'last_error and audit never hold the token');
  assert.equal(db.prepare('SELECT last_send AS last_result FROM connections').get().last_result, 'failed');
  mockFetch(() => new Response('{"ok":false,"description":"Unauthorized"}', { status: 401 }));
  assert.match((await (await send(admin, 'POST', `/alerts/channels/${node.id}/test`)).json()).error, /bot token/);
});

test('a credential test verifies the login without sending: Telegram getMe, SMTP connect and sign in', async () => {
  reset();
  const bot = await (await send(admin, 'POST', '/alerts/credentials', credBody)).json();
  const calls = mockFetch(() => new Response('{"ok":true,"result":{"id":1}}', { status: 200 }));
  assert.equal((await send(admin, 'POST', `/alerts/credentials/${bot.id}/test`)).status, 200);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/getMe`); assert.equal(calls[0].init.method, 'GET');
  assert.equal(db.prepare('SELECT last_test FROM connections').get().last_test, 'ok');
  mockFetch(() => new Response('{}', { status: 401 }));
  const bad = await send(admin, 'POST', `/alerts/credentials/${bot.id}/test`); assert.equal(bad.status, 502); assert.ok(!(await bad.text()).includes(TOKEN));
  if (noTls) return;
  const fake = await fakeSmtp({ mode: 'starttls' });
  try {
    const original = smtp.smtpIo.upgrade;
    smtp.smtpIo.upgrade = (socket, options) => original(socket, { ...options, tlsOptions: { ca: material.cert } });
    const account = await (await send(admin, 'POST', '/alerts/credentials', { ...smtpBody, name: 'Local', config: { ...smtpBody.config, host: '127.0.0.1', port: fake.port } })).json();
    try { assert.equal((await send(admin, 'POST', `/alerts/credentials/${account.id}/test`)).status, 200); }
    finally { smtp.smtpIo.upgrade = original; }
    assert.ok(fake.log.secure && fake.log.lines.some(line => line.startsWith('AUTH')), 'signed in over TLS');
    assert.ok(!fake.log.lines.some(line => /^(MAIL|RCPT|DATA)/.test(line)), 'no message was sent');
  } finally { fake.close(); }
});

test('rules are validated and a line to a channel exists once per source', async () => {
  reset();
  const channel = await (await send(admin, 'POST', '/alerts/channels', tgNode())).json(), srv = server('rules-srv'), siteId = site(srv, 'rules-site');
  const rule = body => send(admin, 'POST', '/alerts/rules', { channelId: channel.id, events: ['backup.failed'], ...body });
  assert.equal((await rule({ sourceKind: 'docknest' })).status, 201);
  assert.equal((await rule({ sourceKind: 'docknest' })).status, 409);
  assert.equal((await rule({ sourceKind: 'docknest', sourceId: srv })).status, 400);
  assert.equal((await rule({ sourceKind: 'server' })).status, 400);
  assert.equal((await rule({ sourceKind: 'server', sourceId: randomUUID() })).status, 404);
  assert.equal((await rule({ sourceKind: 'site', sourceId: siteId, events: ['nope'] })).status, 400);
  assert.equal((await rule({ sourceKind: 'site', sourceId: siteId, events: [] })).status, 400);
  assert.equal((await send(admin, 'POST', '/alerts/rules', { channelId: randomUUID(), sourceKind: 'docknest', events: ['backup.failed'] })).status, 404);
  const made = await (await rule({ sourceKind: 'site', sourceId: siteId, events: ['backup.failed', 'backup.failed', 'backup.succeeded'] })).json();
  assert.deepEqual(made.events, ['backup.failed', 'backup.succeeded']);
  const patched = await (await send(admin, 'PATCH', `/alerts/rules/${made.id}`, { enabled: false })).json();
  assert.equal(patched.enabled, false); assert.deepEqual(patched.events, made.events);
  assert.equal((await send(operator, 'POST', '/alerts/rules', { channelId: channel.id, sourceKind: 'docknest', events: ['backup.failed'] })).status, 403);
  assert.equal((await send(admin, 'DELETE', `/alerts/rules/${made.id}`)).status, 200);
  assert.equal((await send(admin, 'DELETE', `/alerts/channels/${channel.id}`)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM alert_lines').get().n, 0, 'rules go with their channel');
});

test('rule matching: docknest lines match everything, server and site lines only their own, disabled never', () => {
  const rule = (source_kind, source_id, eventList = ['backup.failed'], enabled = true) => ({ source_kind, source_id, events: eventList, enabled });
  const event = { type: 'backup.failed', siteId: 's1', serverId: 'v1' };
  assert.ok(events.ruleMatches(rule('docknest', null), event));
  assert.ok(events.ruleMatches(rule('site', 's1'), event));
  assert.ok(!events.ruleMatches(rule('site', 's2'), event));
  assert.ok(events.ruleMatches(rule('server', 'v1'), event));
  assert.ok(!events.ruleMatches(rule('server', 'v2'), event));
  assert.ok(events.ruleMatches(rule('server', 'v9', ['move.finished']), { type: 'move.finished', serverId: 'v1', targetServerId: 'v9' }),'a move also concerns its target server');
  assert.ok(!events.ruleMatches(rule('docknest', null, ['backup.succeeded']), event));
  assert.ok(!events.ruleMatches(rule('docknest', null, ['backup.failed'], false), event));
  assert.ok(!events.ruleMatches(rule('site', 's1'), { type: 'update.available' }));
});

test('messages are short, plain and carry only the names the owner typed', () => {
  const text = events.messageFor({ type: 'backup.failed', at: '2026-10-23T03:00:12.000Z', siteName: 'shop.example.com', serverName: 'mobiX-Srv' });
  assert.equal(text, 'Backup failed: shop.example.com on mobiX-Srv at 03:00 UTC. Open DockNest to see why.');
  assert.equal(events.messageFor({ type: 'nonsense' }), null);
  assert.ok(!/[\r\n<>]/.test(events.messageFor({ type: 'backup.failed', at: '2026-10-23T03:00:00Z', siteName: 'a\r\nb<script>', serverName: 'x'.repeat(500) })));
  assert.ok(events.messageFor({ type: 'server.disk_low', serverName: 'srv', freeBytes: 2 * 1024 ** 3, usedPercent: 95.4 }).includes('2.1 GB free (95% used)'));
});

test('dedupe: one message per channel and event+source inside 10 minutes, occurrences never twice, other sources unaffected', async () => {
  reset();
  const channel = store.createChannel(tgNode(), 'test'), other = store.createChannel(tgNode({ name: 'Second', config: { chatId: '-1009876543210' } }), 'test'); // another chat: dedup is per Connection
  store.createRule({ channelId: channel.id, sourceKind: 'docknest', events: ['backup.failed', 'move.needs_you'] }, 'test');
  store.createRule({ channelId: other.id, sourceKind: 'docknest', events: ['backup.failed'] }, 'test');
  store.createRule({ channelId: other.id, sourceKind: 'site', sourceId: site(server('d-srv'), 'd-site'), events: ['backup.failed'] }, 'test');
  const t0 = Date.parse('2026-10-23T03:00:00Z'), failed = key => ({ type: 'backup.failed', key, siteName: 'shop', serverName: 'srv' });
  assert.equal(delivery.emit(failed('site:a'), { at: t0 }), 2, 'two channels, one message each');
  assert.equal(delivery.emit(failed('site:a'), { at: t0 + 9 * 60_000 }), 0, 'inside 10 minutes');
  assert.equal(delivery.emit(failed('site:b'), { at: t0 + 60_000 }), 2, 'another source is not deduped');
  assert.equal(delivery.emit(failed('site:a'), { at: t0 + 11 * 60_000 }), 2, 'after 10 minutes it may repeat');
  const move = { type: 'move.needs_you', detail: 'dns', key: 'occ:move:1:waiting:dns', siteName: 'shop', targetName: 'new' };
  assert.equal(delivery.emit(move, { at: t0 }), 1);
  assert.equal(delivery.emit(move, { at: t0 + 3 * 3600_000 }), 0, 'an occurrence never repeats');
  assert.equal(delivery.emit({ type: 'move.finished', key: 'x' }, { at: t0 }), 0, 'no rule listens to move.finished');
});

test('delivery retries with backoff three times, then gives up; success records ok and sends once', async () => {
  reset();
  const channel = store.createChannel(tgNode(), 'test');
  store.createRule({ channelId: channel.id, sourceKind: 'docknest', events: ['backup.failed'] }, 'test');
  const t0 = Date.parse('2026-10-23T03:00:00Z'); let healthy = false;
  const calls = mockFetch(() => healthy ? ok() : new Response('{}', { status: 500 }));
  delivery.emit({ type: 'backup.failed', key: 'site:r', siteName: 'shop', serverName: 'srv' }, { at: t0 });
  const state = () => db.prepare('SELECT status,attempts,next_attempt_at FROM alert_outbox').get();
  assert.equal(await delivery.deliverDue({ at: t0 }), 0); assert.deepEqual({ ...state() }, { status: 'pending', attempts: 1, next_attempt_at: t0 + 60_000 });
  await delivery.deliverDue({ at: t0 + 30_000 }); assert.equal(calls.length, 1, 'not before the backoff');
  await delivery.deliverDue({ at: t0 + 60_000 }); assert.deepEqual({ ...state() }, { status: 'pending', attempts: 2, next_attempt_at: t0 + 60_000 + 300_000 });
  await delivery.deliverDue({ at: t0 + 360_000 }); assert.equal(state().status, 'failed'); assert.equal(state().attempts, 3);
  await delivery.deliverDue({ at: t0 + 3600_000 }); assert.equal(calls.length, 3, 'no fourth try');
  assert.equal(db.prepare('SELECT last_send AS last_result FROM connections').get().last_result, 'failed');
  healthy = true;
  delivery.emit({ type: 'backup.failed', key: 'site:s', siteName: 'shop', serverName: 'srv' }, { at: t0 + 7200_000 });
  assert.equal(await delivery.deliverDue({ at: t0 + 7200_000 }), 1);
  assert.equal(calls.length, 4); assert.match(JSON.parse(calls[3].init.body).text, /^Backup failed\nshop on srv/);
  assert.equal(db.prepare("SELECT status FROM alert_outbox WHERE dedupe_key='backup.failed:site:s'").get().status, 'sent');
  assert.equal(db.prepare('SELECT last_send AS last_result FROM connections').get().last_result, 'ok');
  await delivery.deliverDue({ at: t0 + 7300_000 }); assert.equal(calls.length, 4, 'a sent message is never sent again');
});

test('the detector reads backups, moves, updates and disk without replaying history or touching those tables', () => {
  reset(); db.exec("DELETE FROM settings WHERE key IN ('alerts_cursor','alerts_update_notified')");
  const srv = server('mobiX-Srv', '203.0.113.9'), target = server('new-srv', '198.51.100.9'), siteId = site(srv, 'shop.example.com');
  const channel = store.createChannel(tgNode(), 'test');
  store.createRule({ channelId: channel.id, sourceKind: 'docknest', events: [...events.EVENTS] }, 'test');
  const job = (status, finished, details = '{}') => { const jobId = randomUUID(); db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,finished_at,details) VALUES(?,?,'backup',?,?,?,?,?)").run(jobId, siteId, status, status, finished, finished, details); return jobId; };
  job('failed', '2026-01-01T01:00:00.000Z');
  assert.equal(detect.detectJobsAndMoves('2026-01-01T02:00:00.000Z'), 0, 'first run only sets the cursor');
  job('failed', '2026-01-01T03:00:00.000Z'); job('completed', '2026-01-01T04:00:00.000Z'); job('failed', '2026-01-01T05:00:00.000Z', '{"moveId":"m"}'); job('running', '2026-01-01T06:00:00.000Z');
  const before = JSON.stringify(db.prepare('SELECT * FROM jobs ORDER BY id').all());
  assert.equal(detect.detectJobsAndMoves('2026-01-01T07:00:00.000Z'), 2);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM jobs ORDER BY id').all()), before, 'read only');
  assert.equal(detect.detectJobsAndMoves('2026-01-01T08:00:00.000Z'), 0, 'seen once');
  const messages = db.prepare('SELECT event,message FROM alert_outbox ORDER BY created_at').all().map(row => ({ ...row }));
  assert.deepEqual(messages.map(row => row.event).sort(), ['backup.failed', 'backup.succeeded']);
  assert.ok(messages.some(row => row.message === 'Backup failed: shop.example.com on mobiX-Srv at 03:00 UTC. Open DockNest to see why.'));
  assert.ok(!messages.some(row => /203\.0\.113|\d+\.\d+\.\d+\.\d+/.test(row.message)), 'no addresses');
  const move = (state, waiting, updated) => { const moveId = randomUUID(); db.prepare('INSERT INTO site_moves(id,site_id,source_server_id,target_server_id,state,waiting_for,options,preflight,preflight_hash,actor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(moveId, state === 'waiting' ? siteId : site(srv, 'shop.example.com'), srv, target, state, waiting, '{}', '{}', 'h', 'a', updated, updated); return moveId; };
  db.exec('DELETE FROM alert_outbox');
  const waiting = move('waiting', 'dns', '2026-01-01T09:00:00.000Z');
  move('running', null, '2026-01-01T09:30:00.000Z'); move('completed', null, '2026-01-01T10:00:00.000Z');
  assert.equal(detect.detectJobsAndMoves('2026-01-01T11:00:00.000Z'), 2);
  const texts = db.prepare('SELECT event,message FROM alert_outbox').all().map(row => `${row.event}|${row.message}`).sort();
  assert.deepEqual(texts, ['move.finished|Move finished: shop.example.com now runs on new-srv.', 'move.needs_you|Move waiting for you: change the DNS record for shop.example.com to new-srv. Open DockNest for the record.']);
  db.prepare("UPDATE site_moves SET updated_at='2026-01-01T12:00:00.000Z' WHERE id=?").run(waiting);
  assert.equal(detect.detectJobsAndMoves('2026-01-01T13:00:00.000Z'), 0, 'a touched row in the same state does not alert again');
  // Disk.
  db.exec('DELETE FROM alert_outbox');
  db.prepare('UPDATE servers SET capabilities=? WHERE id=?').run(JSON.stringify({ freeBytes: 2 * 1024 ** 3 }), srv);
  db.prepare('UPDATE servers SET capabilities=? WHERE id=?').run(JSON.stringify({ freeBytes: 500 * 1024 ** 3 }), target);
  assert.equal(detect.detectDisk(), 1); assert.equal(detect.detectDisk(), 0, 'once a day at most');
  assert.match(db.prepare('SELECT message FROM alert_outbox').get().message, /^Low disk space on mobiX-Srv: 2\.1 GB free/);
});

test('update.available fires once per new release, only when update checks are on', () => {
  reset(); db.exec("DELETE FROM settings WHERE key='alerts_update_notified'");
  const channel = store.createChannel(tgNode(), 'test'), owner = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  store.createRule({ channelId: channel.id, sourceKind: 'docknest', events: ['update.available'] }, 'test');
  db.prepare("INSERT OR REPLACE INTO update_checks(id,status,checked_at,next_check_at,latest_version) VALUES(1,'ok',?,0,'v99.1.0')").run(at());
  db.exec('DELETE FROM update_preferences');
  assert.equal(detect.detectUpdate(), 0, 'checks are not enabled');
  db.prepare('INSERT INTO update_preferences(id,check_enabled,decided_by,decided_at) VALUES(1,1,?,?)').run(owner, at());
  assert.equal(detect.detectUpdate(), 1); assert.equal(detect.detectUpdate(), 0);
  assert.equal(db.prepare('SELECT message FROM alert_outbox').get().message, 'DockNest 99.1.0 is available. Open DockNest to update.');
  db.prepare("UPDATE update_checks SET latest_version='v0.0.1' WHERE id=1").run();
  assert.equal(detect.detectUpdate(), 0, 'an older release is not news');
  db.exec('DELETE FROM update_preferences;DELETE FROM update_checks');
});

test('reachability needs two misses in a row, then alerts once per window', async () => {
  reset(); detect.resetProbeState();
  const srv = server('flaky-srv'), channel = store.createChannel(tgNode(), 'test');
  store.createRule({ channelId: channel.id, sourceKind: 'server', sourceId: srv, events: ['server.unreachable'] }, 'test');
  let up = false; const original = detect.probe.connect; detect.probe.connect = async () => up;
  try {
    assert.equal(await detect.detectUnreachable(), 0, 'first miss');
    up = true; assert.equal(await detect.detectUnreachable(), 0); up = false;
    assert.equal(await detect.detectUnreachable(), 0, 'the answer reset the count');
    assert.equal(await detect.detectUnreachable(), 1, 'second miss in a row');
    assert.equal(await detect.detectUnreachable(), 0, 'deduped');
    assert.match(db.prepare('SELECT message FROM alert_outbox').get().message, /^Server unreachable: flaky-srv has not answered/);
  } finally { detect.probe.connect = original; db.prepare('DELETE FROM servers WHERE id=?').run(srv); }
});

// ---- SMTP client against local fake servers --------------------------------------------------------------------------
const certDir = await mkdtemp(join(tmpdir(), 'docknest-alerts-tls-'));
let material = null;
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, 'k.pem'), '-out', join(certDir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  material = { key: await readFile(join(certDir, 'k.pem')), cert: await readFile(join(certDir, 'c.pem')) };
} catch { /* openssl missing: the TLS tests are skipped */ }
const noTls = material ? false : 'openssl is not available';

// A tiny SMTP server. mode: 'starttls' | 'implicit' | 'no-starttls'. Records what a client sent.
function fakeSmtp({ mode, password = PASSWORD, reply535 = false }) {
  const log = { lines: [], data: '', secure: false, authBeforeTls: false };
  const handle = (socket) => {
    let buffer = '', dataMode = false, secured = mode === 'implicit';
    const write = text => socket.write(text + '\r\n');
    const onData = chunk => {
      buffer += chunk;
      for (;;) {
        if (dataMode) { const end = buffer.indexOf('\r\n.\r\n'); if (end < 0) return; log.data = buffer.slice(0, end); buffer = buffer.slice(end + 5); dataMode = false; write('250 queued'); continue; }
        const index = buffer.indexOf('\r\n'); if (index < 0) return;
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2); log.lines.push(line);
        const word = line.split(' ')[0].toUpperCase();
        if (word === 'EHLO') write(['250-localhost', ...(mode === 'starttls' && !secured ? ['250-STARTTLS'] : []), '250 AUTH PLAIN LOGIN'].join('\r\n'));
        else if (word === 'STARTTLS') { write('220 go ahead'); socket.removeListener('data', onData); const secure = new tls.TLSSocket(socket, { isServer: true, key: material.key, cert: material.cert }); secured = true; log.secure = true; secure.setEncoding('utf8'); secure.on('data', onData); secure.on('error', () => {}); socket = secure; }
        else if (word === 'AUTH') { if (!secured) log.authBeforeTls = true; const given = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString().split('\0'); write(reply535 || given[2] !== password ? '535 nope' : '235 ok'); }
        else if (word === 'MAIL' || word === 'RCPT') write('250 ok');
        else if (word === 'DATA') { write('354 go'); dataMode = true; }
        else if (word === 'QUIT') { write('221 bye'); socket.end(); return; }
        else write('500 what');
      }
    };
    socket.setEncoding('utf8'); socket.on('data', onData); socket.on('error', () => {});
    write('220 localhost ESMTP');
  };
  const instance = mode === 'implicit' ? tls.createServer({ key: material.key, cert: material.cert }, handle) : net.createServer(handle);
  return new Promise(resolve => instance.listen(0, '127.0.0.1', () => resolve({ port: instance.address().port, log, close: () => instance.close() })));
}
const mail = (port, security, extra = {}) => ({ host: '127.0.0.1', port, security, username: 'bot', password: PASSWORD, from: 'docknest@example.com', to: ['me@example.com'], ...extra });
const trusted = () => ({ tlsOptions: { ca: material.cert } });
const decoded = data => Buffer.from(data.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');

test('SMTP over STARTTLS: encrypts before signing in, delivers a small plain message', { skip: noTls }, async () => {
  const fake = await fakeSmtp({ mode: 'starttls' });
  try {
    await smtp.sendMail(mail(fake.port, 'starttls'), { subject: 'Backup failed', text: 'Backup failed: shop on srv at 03:00 UTC.\n.dot line' }, trusted());
    assert.ok(fake.log.secure && !fake.log.authBeforeTls, 'TLS first');
    assert.deepEqual(fake.log.lines.filter(line => /^(MAIL|RCPT)/.test(line)), ['MAIL FROM:<docknest@example.com>', 'RCPT TO:<me@example.com>']);
    assert.match(fake.log.data, /^From: docknest@example\.com\r\nTo: me@example\.com\r\nSubject: Backup failed\r\n/);
    assert.equal(decoded(fake.log.data), 'Backup failed: shop on srv at 03:00 UTC.\r\n.dot line');
  } finally { fake.close(); }
});

test('SMTP over implicit TLS delivers the message', { skip: noTls }, async () => {
  const fake = await fakeSmtp({ mode: 'implicit' });
  try { await smtp.sendMail(mail(fake.port, 'tls'), { subject: 'Hi', text: 'Hello' }, trusted()); assert.equal(decoded(fake.log.data), 'Hello'); }
  finally { fake.close(); }
});

test('SMTP refuses a server that offers no encryption and never sends the password', { skip: noTls }, async () => {
  const fake = await fakeSmtp({ mode: 'no-starttls' });
  try {
    await assert.rejects(smtp.sendMail(mail(fake.port, 'starttls'), { subject: 's', text: 't' }, trusted()), error => error.code === 'no-tls');
    assert.ok(!fake.log.lines.some(line => /^AUTH|^MAIL/.test(line)), 'no credentials, no mail');
  } finally { fake.close(); }
});

test('SMTP verifies the certificate, reports a wrong password plainly and never returns server text', { skip: noTls }, async () => {
  const fake = await fakeSmtp({ mode: 'starttls' });
  try {
    await assert.rejects(smtp.sendMail(mail(fake.port, 'starttls'), { subject: 's', text: 't' }), error => error.code === 'tls', 'untrusted certificate');
    await assert.rejects(smtp.sendMail(mail(fake.port, 'starttls', { password: 'wrong' }), { subject: 's', text: 't' }, trusted()), error => error.code === 'auth' && !/nope|wrong/.test(error.message));
  } finally { fake.close(); }
});

test('SMTP refuses bad addresses, link-local targets and header injection before connecting', async () => {
  await assert.rejects(smtp.sendMail(mail(587, 'starttls', { to: ['a@example.com\r\nRCPT TO:<x@example.com>'] }), { subject: 's', text: 't' }), error => error.code === 'config');
  await assert.rejects(smtp.sendMail(mail(587, 'starttls', { host: '169.254.169.254' }), { subject: 's', text: 't' }), error => error.code === 'blocked');
  assert.equal(smtp.addressAllowed('::ffff:169.254.169.254'), false);
  assert.equal(smtp.addressAllowed('192.168.1.10', { privateOk: true }), true, 'a mail relay on the home network is allowed when an administrator set it');
  assert.equal(smtp.addressAllowed('192.168.1.10'), false, 'a relay host set by anyone else must be public');
  const message = smtp.buildMessage({ from: 'a@example.com', to: ['b@example.com'], subject: 'x\r\nBcc: evil@example.com', text: 't', id: '1' });
  assert.ok(!/\r\nBcc:/i.test(message), 'subject cannot add a header');
});

test('SMTP closes a server that streams endless reply lines or too many bytes, with one fixed sentence', async () => {
  const flood = net.createServer(socket => { socket.on('error', () => {}); socket.write('220 hi\r\n'); socket.once('data', () => { const timer = setInterval(() => socket.write('250-' + 'x'.repeat(200) + '\r\n', () => {}), 1); socket.on('close', () => clearInterval(timer)); }); });
  await new Promise(resolve => flood.listen(0, '127.0.0.1', resolve));
  const started = Date.now();
  try { await assert.rejects(smtp.sendMail(mail(flood.address().port, 'starttls'), { subject: 's', text: 't' }), error => error.message === 'The mail server could not be reached.' && error.code === 'protocol'); }
  finally { flood.close(); }
  assert.ok(Date.now() - started < 10_000, 'stopped long before the overall timeout');
  const lines = net.createServer(socket => { socket.on('error', () => {}); socket.write('220 hi\r\n'); socket.once('data', () => socket.write('250-a\r\n'.repeat(150))); });
  await new Promise(resolve => lines.listen(0, '127.0.0.1', resolve));
  try { await assert.rejects(smtp.sendMail(mail(lines.address().port, 'starttls'), { subject: 's', text: 't' }), error => error.code === 'protocol'); }
  finally { lines.close(); }
});

test('SMTP refuses loopback, metadata and link-local targets with the same sentence as any failure', async () => {
  smtp.smtpPolicy.allowLoopback = false;
  try {
    for (const host of ['127.0.0.1', '127.8.8.8', '::1', 'fd00:ec2::254', '169.254.169.254', 'fe80::1']) {
      assert.equal(smtp.addressAllowed(host), false, host);
      await assert.rejects(smtp.sendMail(mail(587, 'starttls', { host }), { subject: 's', text: 't' }), error => error.message === 'The mail server could not be reached.');
    }
    assert.equal(smtp.addressAllowed('::ffff:127.0.0.1'), false);
  } finally { smtp.smtpPolicy.allowLoopback = true; }
});

test('message times use the site schedule zone, then the self-backup zone, then UTC, with the zone abbreviation', () => {
  const base = { type: 'backup.failed', at: '2026-10-23T03:00:00Z', siteName: 'shop', serverName: 'srv' };
  assert.match(events.messageFor({ ...base, timeZone: 'Asia/Jerusalem' }), /^Backup failed: shop on srv at 06:00 GMT\+3\. Open/);
  assert.match(events.messageFor(base), /at 03:00 UTC\./);
  assert.match(events.messageFor({ ...base, timeZone: 'Not/AZone' }), /at 03:00 UTC\./);
  reset(); db.exec("DELETE FROM settings WHERE key IN ('alerts_cursor','manager_backup_config')");
  const srv = server('tz-srv'), siteId = site(srv, 'tz-site'), channel = store.createChannel(tgNode(), 'test');
  store.createRule({ channelId: channel.id, sourceKind: 'docknest', events: ['backup.failed'] }, 'test');
  const fail = finished => db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,finished_at,details) VALUES(?,?,'backup','failed','failed',?,?,'{}')").run(randomUUID(), siteId, finished, finished);
  detect.detectJobsAndMoves('2026-06-01T00:00:00.000Z');
  db.prepare("INSERT INTO policies(site_id,enabled,schedule,timezone) VALUES(?,1,'0 3 * * *','Asia/Jerusalem')").run(siteId);
  fail('2026-06-01T06:00:00.000Z'); detect.detectJobsAndMoves();
  assert.match(db.prepare('SELECT message FROM alert_outbox').get().message, /at 09:00 GMT\+3\./, 'site policy zone wins');
  db.prepare('DELETE FROM policies WHERE site_id=?').run(siteId); db.exec('DELETE FROM alert_outbox');
  db.prepare("INSERT INTO settings VALUES('manager_backup_config',?)").run(JSON.stringify({ timezone: 'America/New_York' }));
  fail('2026-06-01T07:00:00.000Z'); detect.detectJobsAndMoves();
  assert.match(db.prepare('SELECT message FROM alert_outbox').get().message, /at 03:00 (EDT|GMT-4)\./, 'self-backup zone next');
  db.exec("DELETE FROM settings WHERE key='manager_backup_config'");
});

test('migration versions are contiguous from 1 once version 7 exists', async () => {
  const { migrations } = await import('../src/migrations.js'), versions = migrations.map(item => item.version);
  // TODO(merge of #67 + #69): this branch has no migration 7 yet, so the gap at 7 is expected here. Delete the skip then.
  if (!versions.includes(7)) return void console.log('skipped: migration 7 (server_installs, PR #67) is not on this branch yet');
  assert.deepEqual(versions, versions.map((_, index) => index + 1));
});

test('a server line also carries the backups of the sites on that server, never those of other servers, and sends once', async () => {
  reset(); db.exec("DELETE FROM settings WHERE key='alerts_cursor'");
  const home = server('itamar-Srv'), away = server('other-Srv'), mine = site(home, 'mine'), theirs = site(away, 'theirs');
  const channel = store.createChannel(tgNode(), 'test');
  store.createRule({ channelId: channel.id, sourceKind: 'server', sourceId: home, events: ['server.unreachable', 'backup.failed'] }, 'test');
  store.createRule({ channelId: channel.id, sourceKind: 'site', sourceId: mine, events: ['backup.failed'] }, 'test');
  detect.detectJobsAndMoves('2026-07-01T00:00:00.000Z');
  const fail = (siteId, finished) => db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,finished_at,details) VALUES(?,?,'backup','failed','failed',?,?,'{}')").run(randomUUID(), siteId, finished, finished);
  fail(theirs, '2026-07-01T01:00:00.000Z'); fail(mine, '2026-07-01T02:00:00.000Z');
  assert.equal(detect.detectJobsAndMoves(), 1, 'one message even though the server line and the site line both match');
  assert.match(db.prepare('SELECT message FROM alert_outbox').get().message, /^Backup failed: mine on itamar-Srv/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM alert_outbox').get().n, 1);
});

test.after(() => { listener.close(); listener.closeAllConnections?.(); });
