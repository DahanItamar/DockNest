// The Connections and alert node API (docs/alert-channels.md, "API", "Who may do what", "Test plan", Permissions and
// Secrets): administrators always; operators only while "Operators can manage alerts" is on; re-verification for
// Connection writes and destination changes; admin-only Other and settings; one fixed sentence at a fixed time for every
// failed operator test; no secret in any answer, audit row or log. Fake tokens only; every provider is a mocked fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-alert-permissions-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'https://docknest.example.net' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const logs = [], capture = (...args) => logs.push(args.map(String).join(' ')), originals = { log: console.log, error: console.error, warn: console.warn };
console.log = capture; console.error = capture; console.warn = capture;
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { digest, open } = await import('../src/crypto.js');
const delivery = await import('../src/alerts/delivery.js');
const routes = await import('../src/alerts/routes.js');
const { OutboundError } = await import('../src/alerts/outbound.js');
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
const responses = [];

function user(role, authenticatedAt = Date.now()) {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId, userId + '@example.invalid', 'fixture', 'fixture', '[]', new Date().toISOString(), role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), userId, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), authenticatedAt);
  const call = async (method, route, body) => {
    const started = Date.now(), response = await fetch(base + route, { method, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, 'x-csrf-token': 'csrf', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); responses.push(text);
    return { status: response.status, body: text ? JSON.parse(text) : null, ms: Date.now() - started };
  };
  return Object.assign(call, { id: userId });
}
const admin = user('admin'), staleAdmin = user('admin', Date.now() - 3600000), operator = user('operator'), staleOperator = user('operator', Date.now() - 3600000), viewer = user('viewer');
const TOKEN = '123456789:' + 'AbCdEf_-12'.repeat(4).slice(0, 35), NEW_TOKEN = '987654321:' + 'ZyXwVu_-98'.repeat(4).slice(0, 35), NTFY_TOKEN = 'tk_fixtureNtfyToken0123456789', PASSWORD = 'fixture-pass-not-real';
const DISCORD = 'https://discord.com/api/webhooks/123456789012345678/Fixture_Discord-Token_0123456789', HOOK = 'https://hooks.example.net/docknest/fixture-0123', WA_TOKEN = 'EAAGfixtureWhatsAppToken0123456789';
const SECRETS = [TOKEN, NEW_TOKEN, NTFY_TOKEN, PASSWORD, DISCORD, 'Fixture_Discord-Token', HOOK, WA_TOKEN, 'Bearer fixture-header'];
const telegram = (name = 'Ops bot', chatId = '-1001234567890') => ({ provider: 'telegram', name, values: { token: TOKEN, chatId } });
const mockFetch = handler => { const calls = []; delivery.alertHttp.fetch = async (url, init, guard) => { calls.push({ url, init, guard }); return handler(url, init, calls.length); }; return calls; };
const ok = () => new Response('{"ok":true,"result":{}}', { status: 200 });
const setting = (key, value) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value ? 'true' : 'false');
const operatorsOn = on => setting('alerts_operators_manage', on);
const reset = () => { db.exec("DELETE FROM alert_outbox;DELETE FROM alert_lines;DELETE FROM alert_nodes;DELETE FROM connections;DELETE FROM rate_limits;DELETE FROM settings WHERE key IN ('alerts_operators_manage','alerts_private_network');"); routes.operatorPolicy.failMs = 300; };
const audits = action => db.prepare('SELECT * FROM audit_events WHERE action=? ORDER BY created_at').all(action).map(row => ({ ...row, detail: JSON.parse(row.details ?? row.detail ?? '{}') }));
const auditColumn = () => Object.keys(db.prepare('SELECT * FROM audit_events LIMIT 1').get() ?? { details: 1 }).find(key => /detail/.test(key));

test('setting off: operators and other roles get 403 ALERTS_ADMIN_REQUIRED on every alert and Connection route, and no alert data', async () => {
  reset();
  const made = (await admin('POST', '/connections', telegram())).body;
  const node = (await admin('POST', '/alerts/nodes', { name: 'Phone', provider: 'telegram', connectionId: made.id })).body;
  const calls = [['GET', '/alerts'], ['GET', '/alerts/nodes'], ['GET', '/alerts/rules'], ['GET', '/connections'], ['GET', '/connections/providers'], ['POST', '/connections', telegram()], ['PATCH', `/connections/${made.id}`, { name: 'x' }], ['DELETE', `/connections/${made.id}`], ['POST', `/connections/${made.id}/test`], ['POST', '/connections/test', telegram()], ['PUT', '/connections/settings', { operatorsManage: true }], ['POST', '/alerts/nodes', { name: 'x', provider: 'telegram' }], ['PATCH', `/alerts/nodes/${node.id}`, { name: 'x' }], ['DELETE', `/alerts/nodes/${node.id}`], ['POST', `/alerts/nodes/${node.id}/test`], ['POST', '/alerts/rules', { nodeId: node.id, sourceKind: 'docknest', events: ['backup.failed'] }]];
  for (const who of [operator, viewer]) for (const [method, route, body] of calls) {
    const answer = await who(method, route, body);
    assert.equal(answer.status, 403, `${method} ${route}`);
    assert.ok(['ALERTS_ADMIN_REQUIRED', 'ADMIN_REQUIRED'].includes(answer.body.code), `${method} ${route} ${answer.body.code}`);
    assert.ok(!JSON.stringify(answer.body).includes('Phone') && !JSON.stringify(answer.body).includes('Ops bot'), 'no alert data in a refusal');
  }
  const state = (await operator('GET', '/state')).body;
  assert.equal(state.alertsAccess, false);
  for (const key of ['nodes', 'connections', 'rules', 'alerts']) assert.equal(key in state, false, `no ${key} in the Map payload`);
  assert.equal((await admin('GET', '/state')).body.alertsAccess, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM alert_nodes').get().n, 1, 'nothing changed');
});

test('only an administrator turns the operator setting on or off, with re-verification and an audit event; the role never comes from the body', async () => {
  reset();
  assert.equal((await operator('PUT', '/connections/settings', { operatorsManage: true })).status, 403);
  assert.equal((await operator('PUT', '/connections/settings', { operatorsManage: true, role: 'admin' })).status, 403, 'a role in the body changes nothing');
  operatorsOn(true);
  assert.equal((await operator('PUT', '/connections/settings', { operatorsManage: false })).status, 403, 'operators cannot change it even with access');
  assert.equal((await operator('PUT', '/connections/settings', { allowPrivateNetwork: true })).status, 403, 'nor Allow private network');
  operatorsOn(false);
  const stale = await staleAdmin('PUT', '/connections/settings', { operatorsManage: true });
  assert.equal(stale.status, 403); assert.equal(stale.body.code, 'REAUTH_REQUIRED');
  assert.equal((await admin('PUT', '/connections/settings', { operatorsManage: true, role: 'operator' })).status, 400, 'unknown fields are refused');
  assert.equal((await admin('PUT', '/connections/settings', {})).status, 400);
  const on = await admin('PUT', '/connections/settings', { operatorsManage: true });
  assert.equal(on.status, 200); assert.deepEqual(on.body.settings, { allowPrivateNetwork: false, operatorsManage: true });
  const [event] = audits('alerts.operators_manage');
  assert.equal(event.actor, admin.id); assert.equal(event.detail.enabled, true); assert.equal(event.detail.role, 'admin');
  assert.equal((await operator('GET', '/connections')).status, 200, 'applies at once');
  assert.equal((await admin('PUT', '/connections/settings', { allowPrivateNetwork: true })).status, 200);
  assert.equal(audits('alerts.private_network').at(-1).detail.role, 'admin');
});

test('setting on: an operator lists, creates (with re-verification), edits, tests and deletes nodes and Connections', async () => {
  reset(); operatorsOn(true); mockFetch(ok);
  const stale = await staleOperator('POST', '/connections', telegram('Mine'));
  assert.equal(stale.status, 403); assert.equal(stale.body.code, 'REAUTH_REQUIRED', 'the same re-verification as an administrator');
  const made = await operator('POST', '/connections', telegram('Mine'));
  assert.equal(made.status, 201); assert.equal(made.body.editable, true); assert.deepEqual(made.body.values, { tokenSet: true, chatId: '-1001234567890' });
  const node = await operator('POST', '/alerts/nodes', { name: 'Operator phone', provider: 'telegram', connectionId: made.body.id });
  assert.equal(node.status, 201); assert.equal(node.body.connectionName, 'Mine'); assert.equal(node.body.needsConnection, false);
  const line = await operator('POST', '/alerts/rules', { nodeId: node.body.id, sourceKind: 'docknest', events: ['backup.failed'] });
  assert.equal(line.status, 201); assert.equal(line.body.nodeId, node.body.id); assert.equal(line.body.channelId, node.body.id, 'the 2.8 name stays for one release');
  assert.equal((await staleOperator('PATCH', `/connections/${made.body.id}`, { name: 'Mine renamed' })).status, 200, 'a rename needs no re-verification');
  assert.equal((await staleOperator('PATCH', `/connections/${made.body.id}`, { values: { chatId: '-1009' } })).body.code, 'REAUTH_REQUIRED');
  assert.equal((await operator('PATCH', `/connections/${made.body.id}`, { values: { chatId: '-1009' } })).status, 200);
  assert.equal((await operator('POST', `/connections/${made.body.id}/test`)).status, 200);
  assert.equal((await operator('POST', `/alerts/nodes/${node.body.id}/test`)).status, 200);
  assert.equal((await operator('PATCH', `/alerts/rules/${line.body.id}`, { events: ['backup.failed', 'server.unreachable'] })).status, 200);
  const inUse = await operator('DELETE', `/connections/${made.body.id}`);
  assert.equal(inUse.status, 409); assert.equal(inUse.body.code, 'CONNECTION_IN_USE'); assert.deepEqual(inUse.body.nodes, ['Operator phone']);
  assert.equal((await operator('DELETE', `/alerts/nodes/${node.body.id}`)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM alert_lines').get().n, 0, 'lines go with their node');
  assert.equal((await staleOperator('DELETE', `/connections/${made.body.id}`)).body.code, 'REAUTH_REQUIRED');
  assert.equal((await operator('DELETE', `/connections/${made.body.id}`)).status, 200);
  for (const action of ['connection.create', 'connection.update', 'connection.test', 'connection.delete', 'alert.node.create', 'alert.node.test', 'alert.node.delete', 'alert.rule.create', 'alert.rule.update']) {
    const rows = audits(action).filter(row => [operator.id, staleOperator.id].includes(row.actor));
    assert.ok(rows.length && rows.every(row => row.detail.role === 'operator'), `${action} carries the operator role`);
  }
  assert.deepEqual(audits('connection.update').filter(row => [operator.id, staleOperator.id].includes(row.actor)).map(row => row.detail.fields), [['name'], ['chatId']], 'field names only');
});

test('Other (webhook URL) and private addresses stay admin-only; an operator may pick and test an Other an admin saved', async () => {
  reset(); operatorsOn(true); const calls = mockFetch(() => new Response('{}', { status: 200 }));
  const other = { provider: 'webhook', name: 'Home hook', values: { url: HOOK, header: 'Authorization: Bearer fixture-header' } };
  assert.equal((await operator('POST', '/connections', other)).status, 403);
  assert.equal((await operator('POST', '/connections/test', other)).status, 403, 'nor an unsaved test of one');
  const saved = (await admin('POST', '/connections', other)).body;
  assert.equal(saved.editable, true); assert.deepEqual(saved.values, { urlSet: true, headerSet: true });
  const asOperator = (await operator('GET', '/connections')).body.connections.find(item => item.id === saved.id);
  assert.equal(asOperator.editable, false, 'shown, not editable');
  assert.equal((await operator('PATCH', `/connections/${saved.id}`, { name: 'Mine now' })).status, 403);
  assert.equal((await operator('DELETE', `/connections/${saved.id}`)).status, 403);
  const node = (await operator('POST', '/alerts/nodes', { name: 'Hook node', provider: 'webhook', connectionId: saved.id })).body;
  assert.equal((await operator('POST', `/alerts/nodes/${node.id}/test`)).status, 200);
  assert.equal(calls.at(-1).url, HOOK, 'only the URL the administrator saved');
  assert.equal((await operator('PUT', '/connections/settings', { allowPrivateNetwork: true })).status, 403);
});

test('private_ok follows who last set the host: an operator setting a host makes it public-only, a rename keeps it', async () => {
  reset(); operatorsOn(true); setting('alerts_private_network', true);
  const ntfy = (await admin('POST', '/connections', { provider: 'ntfy', name: 'Home ntfy', values: { server: 'https://ntfy.home.example', topic: 'docknest-alerts-long-topic', token: NTFY_TOKEN } })).body;
  const row = () => db.prepare('SELECT * FROM connections WHERE id=?').get(ntfy.id);
  assert.equal(row().private_ok, 1, 'saved by an administrator while the setting is on');
  assert.equal((await operator('PATCH', `/connections/${ntfy.id}`, { name: 'Renamed by operator' })).status, 200);
  assert.equal((await operator('PATCH', `/connections/${ntfy.id}`, { values: { topic: 'another-long-topic-name' } })).status, 200);
  assert.equal(row().private_ok, 1, 'a rename and a new topic keep the admin server reachable');
  const refused = await operator('PATCH', `/connections/${ntfy.id}`, { values: { server: 'https://ntfy.other.example' } });
  assert.equal(refused.status, 400); assert.match(refused.body.error, /access token again/); assert.equal(refused.body.field, 'token');
  assert.equal((await operator('PATCH', `/connections/${ntfy.id}`, { values: { server: 'https://ntfy.other.example', token: NTFY_TOKEN } })).status, 200);
  assert.equal(row().private_ok, 0, 'the operator set the host');
  const theirs = (await operator('POST', '/connections', { provider: 'gotify', name: 'Op gotify', values: { server: 'https://gotify.home.example', token: 'AbCdEfGhIjKlMnO' } })).body;
  assert.equal(db.prepare('SELECT private_ok FROM connections WHERE id=?').get(theirs.id).private_ok, 0, 'an operator never saves a private Connection');
  const mail = (await operator('POST', '/connections', { provider: 'email', name: 'Op mail', values: { host: 'smtp.example.com', port: 587, security: 'starttls', username: 'u', password: PASSWORD, from: 'a@example.com', to: ['me@example.com'] } })).body;
  assert.equal(db.prepare('SELECT private_ok FROM connections WHERE id=?').get(mail.id).private_ok, 0, 'an operator-set SMTP host must be public');
});

test('secrets are write-only: omitted secrets stay, a new server needs them again, a destination change needs re-verification', async () => {
  reset();
  const mail = (await admin('POST', '/connections', { provider: 'email', name: 'Mail', values: { host: 'smtp.example.com', port: 587, security: 'starttls', username: 'bot', password: PASSWORD, from: 'docknest@example.com', to: ['me@example.com'], subjectPrefix: '[Home]' } })).body;
  assert.deepEqual(mail.values, { host: 'smtp.example.com', port: 587, security: 'starttls', username: 'bot', passwordSet: true, from: 'docknest@example.com', to: ['me@example.com'], subjectPrefix: '[Home]' });
  const sealed = () => JSON.parse(open(db.prepare('SELECT secret FROM connections WHERE id=?').get(mail.id).secret));
  assert.equal((await admin('PATCH', `/connections/${mail.id}`, { values: { subjectPrefix: '[Ops]', password: '' } })).status, 200);
  assert.equal(sealed().password, PASSWORD, 'an empty or missing secret keeps the saved one');
  for (const change of [{ host: 'smtp.other.example' }, { port: 25 }, { username: 'other' }, { security: 'tls' }]) {
    const answer = await admin('PATCH', `/connections/${mail.id}`, { values: change });
    assert.equal(answer.status, 400, JSON.stringify(change)); assert.match(answer.body.error, /password again/);
  }
  const stale = await staleAdmin('PATCH', `/connections/${mail.id}`, { values: { to: ['someone@example.org'] } });
  assert.equal(stale.body.code, 'REAUTH_REQUIRED', 'recipients decide who reads the alerts');
  assert.equal((await admin('PATCH', `/connections/${mail.id}`, { values: { to: ['someone@example.org'] } })).status, 200);
  assert.deepEqual(audits('connection.update').at(-1).detail.fields, ['to']);
  assert.equal((await admin('POST', '/connections', { provider: 'telegram', name: 'Bad', values: { token: 'short', chatId: '1' } })).body.field, 'token');
  assert.equal((await admin('POST', '/connections', { provider: 'aim', name: 'x', values: {} })).status, 400);
  assert.equal((await admin('POST', '/connections', { provider: 'telegram', name: 'x', values: { token: TOKEN, chatId: '1', extra: 'no' } })).status, 400, 'unknown fields');
  assert.equal((await admin('POST', '/connections', { ...telegram(), secret: 'x' })).status, 400, 'strict body');
});

test('names: unicode and right-to-left kept, bidi overrides dropped, 80 characters at most', async () => {
  reset();
  const rtl = 'התראות צוות ' + String.fromCharCode(0x202e) + 'gnp.exe', made = (await admin('POST', '/connections', telegram(rtl))).body;
  assert.equal(made.name, 'התראות צוות gnp.exe');
  assert.equal((await admin('POST', '/connections', telegram('x'.repeat(81)))).status, 400);
  const long = 'Ünïcödé 🚀 '.repeat(8).slice(0, 80);
  assert.equal((await admin('POST', '/connections', telegram(long))).body.name, long.trim());
  assert.equal((await admin('POST', '/alerts/nodes', { name: '  \n ', provider: 'telegram' })).status, 400);
});

test('every failed test says why to an administrator, by error class, and never leaks the token', async () => {
  reset();
  const made = (await admin('POST', '/connections', telegram())).body;
  const cases = [
    [() => new Response('{"ok":false}', { status: 401 }), /does not accept this bot token/],
    [() => new Response('{"ok":false}', { status: 403 }), /Open the bot in Telegram/],
    [() => new Response('{"ok":false}', { status: 400 }), /Open the bot in Telegram/],
    [() => new Response('{"ok":false}', { status: 500 }), /refused the message/],
    [() => new Response('{"ok":false,"parameters":{"retry_after":5}}', { status: 429 }), /slow down/],
    [() => { throw new OutboundError('redirect'); }, /redirect/],
    [() => { throw new OutboundError('blocked'); }, /could not be reached/],
    [() => { throw new OutboundError('timeout'); }, /could not be reached/],
    [() => { throw Object.assign(new Error(`getaddrinfo ENOTFOUND https://api.telegram.org/bot${TOKEN}`), { code: 'ENOTFOUND' }); }, /could not be reached/],
  ];
  for (const [handler, sentence] of cases) {
    db.exec('DELETE FROM rate_limits');
    mockFetch(handler);
    const answer = await admin('POST', `/connections/${made.id}/test`);
    assert.equal(answer.status, 502); assert.match(answer.body.error, sentence); assert.equal(answer.body.code, 'TEST_FAILED');
    assert.ok(!JSON.stringify(answer.body).includes(TOKEN));
  }
  const view = (await admin('GET', '/connections')).body.connections[0];
  assert.equal(view.lastTest, 'failed'); assert.match(view.testError, /could not be reached/); assert.equal(view.sendError, null);
});

test('an operator\'s failed test is one sentence at one fixed time, for a refusal and a timeout alike', async () => {
  reset(); operatorsOn(true); routes.operatorPolicy.failMs = 600;
  const made = (await operator('POST', '/connections', telegram())).body;
  const times = [];
  for (const handler of [() => { throw new OutboundError('blocked'); }, () => new Response('{}', { status: 401 }), async () => { await new Promise(resolve => setTimeout(resolve, 250)); throw new OutboundError('timeout'); }]) {
    mockFetch(handler);
    for (const route of [`/connections/${made.id}/test`, '/connections/test']) {
      const answer = await operator('POST', route, route.endsWith('/test') && route.startsWith('/connections/test') ? telegram() : undefined);
      assert.equal(answer.status, 502); assert.deepEqual(answer.body, { error: 'DockNest could not deliver to this address.', code: 'TEST_FAILED' });
      times.push(answer.ms);
    }
  }
  assert.ok(times.every(ms => ms >= 590 && ms < 900), `fixed answer time: ${times.join(', ')}`);
  const view = (await operator('GET', '/connections')).body.connections[0];
  assert.equal(view.testError, 'DockNest could not deliver to this address.', 'the operator view holds the same sentence');
  mockFetch(ok);
  const passed = await operator('POST', `/connections/${made.id}/test`);
  assert.equal(passed.status, 200); assert.ok(passed.ms < 590, 'a success answers at once');
});

test('an operator test still running at the fixed time (a slow or silent host) is answered as failed at that time', async () => {
  reset(); operatorsOn(true); routes.operatorPolicy.failMs = 400;
  const made = (await operator('POST', '/connections', telegram())).body;
  let release; const pending = new Promise(resolve => { release = resolve; });
  mockFetch(async () => { await pending; return ok(); });
  for (const [route, body] of [[`/connections/${made.id}/test`, undefined], ['/connections/test', telegram()]]) {
    const answer = await operator('POST', route, body);
    assert.equal(answer.status, 502, route); assert.deepEqual(answer.body, { error: 'DockNest could not deliver to this address.', code: 'TEST_FAILED' });
    assert.ok(answer.ms >= 390 && answer.ms < 700, `answered after ${answer.ms} ms`);
  }
  release(); await new Promise(resolve => setTimeout(resolve, 50));
  routes.operatorPolicy.failMs = 300;
});

test('a test that sends a saved login to a new destination needs the same re-verification as saving it', async () => {
  reset(); operatorsOn(true); mockFetch(ok);
  const made = (await admin('POST', '/connections', telegram())).body;
  for (const who of [staleAdmin, staleOperator]) {
    const moved = await who('POST', '/connections/test', { provider: 'telegram', connectionId: made.id, values: { chatId: '-1004242' } });
    assert.equal(moved.status, 403); assert.equal(moved.body.code, 'REAUTH_REQUIRED');
    assert.equal((await who('POST', '/connections/test', { provider: 'telegram', connectionId: made.id, values: { chatId: '-1001234567890' } })).status, 200, 'the saved destination needs none');
  }
  assert.equal((await operator('POST', '/connections/test', { provider: 'telegram', connectionId: made.id, values: { chatId: '-1004242' } })).status, 200);
});

test('a viewer is refused with the setting on too; writes have their own limit and sentence', async () => {
  reset(); operatorsOn(true);
  for (const [method, route, body] of [['GET', '/alerts'], ['GET', '/connections'], ['POST', '/connections', telegram()], ['POST', '/connections/test', telegram()], ['PUT', '/connections/settings', { operatorsManage: false }]]) {
    const answer = await viewer(method, route, body);
    assert.equal(answer.status, 403, `${method} ${route}`); assert.ok(['ALERTS_ADMIN_REQUIRED', 'ADMIN_REQUIRED'].includes(answer.body.code));
  }
  assert.equal((await viewer('GET', '/state')).body.alertsAccess, false);
  db.prepare('INSERT INTO rate_limits VALUES (?,?,?)').run(`alert-write:user:${operator.id}`, routes.alertRateLimits.writes, Date.now() + 600_000);
  const limited = await operator('POST', '/alerts/nodes', { name: 'One more', provider: 'telegram' });
  assert.equal(limited.status, 429); assert.match(limited.body.error, /Too many changes/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM alert_nodes').get().n, 0);
});

test('the operator answer time is the 10 second request limit by default', { timeout: 30_000 }, async () => {
  reset(); operatorsOn(true); routes.operatorPolicy.failMs = 10_000;
  const made = (await operator('POST', '/connections', telegram())).body;
  mockFetch(() => { throw new OutboundError('blocked'); });
  const answer = await operator('POST', `/connections/${made.id}/test`);
  assert.equal(answer.status, 502); assert.ok(answer.ms >= 9_950 && answer.ms < 11_000, `answered after ${answer.ms} ms`);
  routes.operatorPolicy.failMs = 300;
});

test('an operator losing permission mid-session: the next request is refused and nothing is kept', async () => {
  reset(); operatorsOn(true);
  const made = (await operator('POST', '/connections', telegram())).body;
  assert.equal((await operator('GET', '/alerts')).status, 200);
  assert.equal((await admin('PUT', '/connections/settings', { operatorsManage: false })).status, 200);
  assert.equal((await operator('GET', '/alerts')).status, 403);
  assert.equal((await operator('PATCH', `/connections/${made.id}`, { name: 'late' })).status, 403);
  assert.equal((await operator('GET', '/state')).body.alertsAccess, false);
  assert.equal(db.prepare('SELECT name FROM connections WHERE id=?').get(made.id).name, 'Ops bot');
});

test('unsaved test values: sent once, stored nowhere; editing merges the saved secret by the save rules', async () => {
  reset();
  const calls = mockFetch(ok);
  const unsaved = await admin('POST', '/connections/test', telegram());
  assert.equal(unsaved.status, 200); assert.equal(unsaved.body.delivered, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM connections').get().n, 0, 'nothing stored');
  const made = (await admin('POST', '/connections', telegram())).body;
  assert.equal((await admin('POST', '/connections/test', { provider: 'telegram', connectionId: made.id, values: { chatId: '-1005' } })).status, 200);
  assert.equal(calls.at(-1).url, `https://api.telegram.org/bot${TOKEN}/sendMessage`); assert.equal(JSON.parse(calls.at(-1).init.body).chat_id, '-1005');
  assert.equal(db.prepare('SELECT settings FROM connections WHERE id=?').get(made.id).settings, '{"chatId":"-1001234567890"}', 'the saved destination is unchanged');
  const ntfy = (await admin('POST', '/connections', { provider: 'ntfy', name: 'n', values: { server: 'https://ntfy.sh', topic: 'long-topic-name-0123', token: NTFY_TOKEN } })).body;
  assert.equal((await admin('POST', '/connections/test', { provider: 'ntfy', connectionId: ntfy.id, values: { server: 'https://ntfy.evil.example' } })).status, 400, 'a saved token never goes to a new server');
  assert.equal((await admin('POST', '/connections/test', { provider: 'telegram', connectionId: ntfy.id, values: {} })).status, 400);
  mockFetch(() => new Response('{"messaging_product":"whatsapp","messages":[{"id":"wamid.x"}]}', { status: 200 }));
  const wa = await admin('POST', '/connections/test', { provider: 'whatsapp', name: 'x', values: { token: WA_TOKEN, phoneNumberId: '104829371650', to: '+1 555 0142' } });
  assert.equal(wa.body.delivered, false); assert.match(wa.body.note, /Accepted by WhatsApp/);
});

test('deleting while in use is refused with the node names; a Connection used by many nodes lists them all', async () => {
  reset();
  const made = (await admin('POST', '/connections', telegram())).body;
  for (let index = 0; index < 30; index++) await admin('POST', '/alerts/nodes', { name: `Node ${String(index).padStart(2, '0')}`, provider: 'telegram', connectionId: made.id });
  const view = (await admin('GET', '/connections')).body.connections[0];
  assert.equal(view.usedBy.length, 30); assert.equal(view.usedBy[0].name, 'Node 00');
  const refused = await admin('DELETE', `/connections/${made.id}`);
  assert.equal(refused.status, 409); assert.equal(refused.body.nodes.length, 30);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM connections').get().n, 1);
});

test('many Connections: 60 at most, listed in order', async () => {
  reset();
  const at = new Date().toISOString(), { seal } = await import('../src/crypto.js'), sealed = seal(JSON.stringify({ token: TOKEN }));
  for (let index = 0; index < 59; index++) db.prepare("INSERT INTO connections(id,provider,name,secret,settings,private_ok,created_at,updated_at) VALUES(?,'telegram',?,?,?,0,?,?)").run(randomUUID(), `Bot ${String(index).padStart(2, '0')}`, sealed, '{"chatId":"-1"}', new Date(Date.parse(at) - 60000 + index).toISOString(), at);
  assert.equal((await admin('POST', '/connections', telegram('Sixtieth'))).status, 201);
  const full = await admin('POST', '/connections', telegram('One too many'));
  assert.equal(full.status, 409); assert.match(full.body.error, /up to 60/);
  const list = (await admin('GET', '/connections')).body.connections;
  assert.equal(list.length, 60); assert.equal(list[0].name, 'Bot 00'); assert.equal(list.at(-1).name, 'Sixtieth');
});

test('replacing a secret while sends are pending: the pending items stay and go out with the new login', async () => {
  reset();
  const made = (await admin('POST', '/connections', telegram())).body;
  const node = (await admin('POST', '/alerts/nodes', { name: 'Phone', provider: 'telegram', connectionId: made.id })).body;
  await admin('POST', '/alerts/rules', { nodeId: node.id, sourceKind: 'docknest', events: ['backup.failed'] });
  assert.equal(delivery.emit({ type: 'backup.failed', key: 'site:pending', siteName: 'shop', serverName: 'srv', jobId: randomUUID() }), 1);
  assert.equal((await staleAdmin('PATCH', `/connections/${made.id}`, { values: { token: NEW_TOKEN } })).body.code, 'REAUTH_REQUIRED');
  assert.equal((await admin('PATCH', `/connections/${made.id}`, { values: { token: NEW_TOKEN } })).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alert_outbox WHERE status='pending'").get().n, 1, 'still pending');
  const calls = mockFetch(ok);
  assert.equal(await delivery.deliverDue(), 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${NEW_TOKEN}/sendMessage`);
  assert.ok(JSON.parse(calls[0].init.body).text.includes('https://docknest.example.net/?job='), 'the job link');
  assert.deepEqual(audits('connection.update').at(-1).detail.fields, ['token']);
});

test('nodes: a provider change clears the Connection, a Connection of another provider is refused, prefill stays secret-free', async () => {
  reset();
  const made = (await admin('POST', '/connections', telegram())).body;
  const ntfy = (await admin('POST', '/connections', { provider: 'ntfy', name: 'Phone push', values: { server: 'https://ntfy.sh', topic: 'long-topic-name-0123' } })).body;
  const node = (await admin('POST', '/alerts/nodes', { name: 'Ops', provider: 'telegram', connectionId: made.id })).body;
  assert.equal((await admin('POST', '/alerts/nodes', { name: 'Wrong', provider: 'telegram', connectionId: ntfy.id })).status, 400);
  assert.equal((await admin('POST', '/alerts/nodes', { name: 'Gone', provider: 'telegram', connectionId: randomUUID() })).status, 404);
  const switched = (await admin('PATCH', `/alerts/nodes/${node.id}`, { provider: 'ntfy' })).body;
  assert.equal(switched.provider, 'ntfy'); assert.equal(switched.connectionId, null); assert.equal(switched.needsConnection, true);
  assert.equal((await admin('POST', `/alerts/nodes/${node.id}/test`)).status, 400, 'nothing to send through');
  assert.equal((await admin('PATCH', `/alerts/nodes/${node.id}`, { connectionId: ntfy.id })).body.connectionName, 'Phone push');
  db.prepare("UPDATE alert_nodes SET connection_id=NULL,provider='telegram',prefill=? WHERE id=?").run('{"chatId":"-1007"}', node.id);
  const legacy = (await admin('GET', '/alerts/nodes')).body.nodes.find(item => item.id === node.id);
  assert.deepEqual(legacy.prefill, { chatId: '-1007' }); assert.equal(legacy.needsConnection, true);
});

test('test and send results each keep their own sentence; a migrated failure without one says so plainly', async () => {
  reset();
  const made = (await admin('POST', '/connections', telegram())).body, connections = await import('../src/alerts/connections.js');
  connections.recordConnectionSend(made.id, false, 'Telegram refused the message.');
  connections.recordConnectionTest(made.id, true);
  let view = (await admin('GET', '/connections')).body.connections[0];
  assert.equal(view.lastTest, 'ok'); assert.equal(view.sendError, 'Telegram refused the message.', 'a passing test keeps the failed send sentence');
  connections.recordConnectionTest(made.id, false, 'Telegram does not accept this bot token.');
  connections.recordConnectionSend(made.id, true);
  view = (await admin('GET', '/connections')).body.connections[0];
  assert.equal(view.testError, 'Telegram does not accept this bot token.'); assert.equal(view.sendError, null);
  db.prepare("UPDATE connections SET last_test='failed',last_error=NULL WHERE id=?").run(made.id); // a 2.8 credential's error is not copied
  view = (await admin('GET', '/connections')).body.connections[0];
  assert.equal(view.testError, 'The last test did not go through.');
});

test('tests are limited to 10 per 10 minutes per user', async () => {
  reset(); mockFetch(ok);
  const made = (await admin('POST', '/connections', telegram())).body;
  for (let index = 0; index < 10; index++) assert.equal((await admin('POST', `/connections/${made.id}/test`)).status, 200);
  assert.equal((await admin('POST', `/connections/${made.id}/test`)).status, 429);
  assert.equal((await staleAdmin('POST', `/connections/${made.id}/test`)).status, 200, 'another user has their own budget');
});

test('the Map summary and the provider list carry no schema code and no secrets', async () => {
  reset();
  await admin('POST', '/connections', telegram());
  await admin('POST', '/connections', { provider: 'discord', name: 'Team Discord', values: { url: DISCORD } });
  const summary = (await admin('GET', '/alerts')).body;
  assert.deepEqual(Object.keys(summary).sort(), ['connections', 'diskLow', 'events', 'limits', 'nodes', 'providers', 'role', 'rules', 'settings', 'sourceKinds']);
  assert.equal(summary.providers.length, 13); assert.ok(summary.providers.every(item => !('secretSchema' in item) && !('format' in item)));
  assert.equal(summary.providers.find(item => item.id === 'webhook').adminOnly, true);
  assert.deepEqual(summary.connections.find(item => item.provider === 'discord').values, { urlSet: true });
});

test('no secret in any API answer, audit row, outbox row, stored error or log line', () => {
  const column = auditColumn();
  const stored = JSON.stringify(db.prepare('SELECT * FROM audit_events').all()) + JSON.stringify(db.prepare('SELECT * FROM alert_outbox').all()) + JSON.stringify(db.prepare('SELECT id,name,settings,last_error FROM connections').all()) + JSON.stringify(db.prepare('SELECT * FROM alert_nodes').all());
  for (const secret of SECRETS) for (const [label, text] of [['answers', responses.join('\n')], ['stored', stored], ['logs', logs.join('\n')]]) assert.ok(!text.includes(secret), `${label} hold ${secret.slice(0, 8)}...`);
  assert.ok(column, 'audit rows have a detail column');
});

test.after(() => { Object.assign(console, originals); listener.close(); listener.closeAllConnections?.(); });
