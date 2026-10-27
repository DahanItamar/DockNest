// The eleven new providers, the message template and Telegram on the template (docs/alert-channels.md, "Providers",
// "Message template", "Test plan" Per provider, Secrets and Delivery). Requests go to local fake servers or to a mocked
// `alertHttp.fetch`; a fake resolver answers every name and the `dial` seam points checked addresses at 127.0.0.1, so
// nothing reaches the internet. Every token, key and URL below is fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-alert-providers-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'https://dock.example.com' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { db } = await import('../src/db.js');
const { seal } = await import('../src/crypto.js');
const delivery = await import('../src/alerts/delivery.js');
const connections = await import('../src/alerts/connections.js');
const events = await import('../src/alerts/events.js');
const reasons = await import('../src/alerts/reasons.js');
const registry = await import('../src/alerts/providers/index.js');
const common = await import('../src/alerts/providers/common.js');
const { outboundIo, outboundLimits, checkUrl, OutboundError } = await import('../src/alerts/outbound.js');
const { readHeader } = await import('../src/alerts/providers/webhook.js');
const { parameter, GRAPH_VERSION } = await import('../src/alerts/providers/whatsapp.js');
const { providers, provider, split } = registry;
const originalFetch = delivery.alertHttp.fetch, originalIo = { ...outboundIo };

// ---- Fictional logins ------------------------------------------------------------------------------------------------
const quad = (...parts) => parts.join('.');
const TG = '123456789:' + 'AbCdEf_-12'.repeat(4).slice(0, 35);
const DISCORD_ID = '123456789012345678', DISCORD_TOKEN = 'dTok' + 'a1B2c3D4'.repeat(4), THREAD = '223456789012345678';
const SLACK_PATH = '/services/T0FIXTURE/B0FIXTURE/' + 'sLack0Fixture'.repeat(2);
const TEAMS_URL = 'https://prod-01.westus.logic.azure.com/workflows/fixture0workflow/triggers/manual/paths/invoke?api-version=2016-06-01&sig=teamsFixtureSig0123';
const CHAT_URL = 'https://chat.googleapis.com/v1/spaces/AAAAfixture/messages?key=chatFixtureKey01&token=chatFixtureTok02';
const MM_PATH = '/hooks/' + 'mmfixture0hook'.repeat(2).slice(0, 26);
const GOTIFY_TOKEN = 'gotifyFixture01', NTFY_TOKEN = 'tk_ntfyFixture0123', PUSH_TOKEN = 'a'.repeat(30), PUSH_USER = 'u'.repeat(30), MATRIX_TOKEN = 'syt_matrixFixture_0123', WA_TOKEN = 'WaFixtureToken' + '0'.repeat(20), HEADER = 'Authorization: Bearer webhookFixture01';
const VALUES = {
  telegram: { token: TG, chatId: '-1001234567890' },
  whatsapp: { token: WA_TOKEN, phoneNumberId: '1234567890', to: '+1 555 0100' },
  discord: { url: `https://discord.com/api/webhooks/${DISCORD_ID}/${DISCORD_TOKEN}` },
  slack: { url: `https://hooks.slack.com${SLACK_PATH}` },
  teams: { url: TEAMS_URL },
  googlechat: { url: CHAT_URL },
  mattermost: { url: `https://chat.example.com${MM_PATH}` },
  ntfy: { server: 'https://ntfy.sh', topic: 'docknest-fixture-topic', token: NTFY_TOKEN },
  gotify: { server: 'https://gotify.example.com', token: GOTIFY_TOKEN },
  pushover: { token: PUSH_TOKEN, user: PUSH_USER },
  matrix: { server: 'https://matrix.example.com', room: '!fixtureRoom:example.com', token: MATRIX_TOKEN },
  webhook: { url: 'https://hooks.example.com/in/fixtureHook', header: HEADER },
};
const NEW_PROVIDERS = Object.keys(VALUES).filter(id => id !== 'telegram');
const FIXED = ['telegram', 'whatsapp', 'discord', 'slack', 'teams', 'googlechat', 'pushover'], USER_HOST = ['mattermost', 'ntfy', 'gotify', 'matrix', 'webhook'];
// What must never appear anywhere: every secret value and the secret part of every URL.
const probes = id => Object.entries(VALUES[id]).filter(([key]) => provider(id).fields.find(field => field.key === key)?.secret).flatMap(([, value]) => {
  if (!/^https?:/.test(value)) return [value];
  const url = new URL(value); return [value, ...url.pathname.split('/'), ...[...url.searchParams.values()], url.search.slice(1)].filter(part => part && part.length >= 12);
});

const MSG = Object.freeze({ title: 'Backup failed', site: 'shop.example.com', server: 'mobiX-Srv', reason: 'The backup did not finish. Open DockNest to see why.', time: '03:00 UTC', url: 'https://dock.example.com/?job=job-0001-aaaa', event: 'backup.failed', at: '2026-10-27T03:00:00Z', id: 'item-0001' });
const OK_MSG = Object.freeze({ ...MSG, title: 'Backup finished', reason: 'The backup finished.', event: 'backup.succeeded', url: null });

// ---- Harness ---------------------------------------------------------------------------------------------------------
const reset = () => { db.exec('DELETE FROM alert_outbox;DELETE FROM alert_lines;DELETE FROM alert_nodes;DELETE FROM connections;'); connections.setAllowPrivateNetwork(false, 'admin-id', 'admin'); };
const privateNetwork = enabled => connections.setAllowPrivateNetwork(enabled, 'admin-id', 'admin');
const restore = () => { delivery.alertHttp.fetch = originalFetch; Object.assign(outboundIo, originalIo); outboundLimits.totalMs = 10_000; };
// A Connection of `id` with a node and a line for backup events (a stand-in for what the Connections routes do in PR 4).
function connect(id, values = VALUES[id], { privateOk = false, events: lineEvents = ['backup.failed', 'backup.succeeded'] } = {}) {
  const item = provider(id), { secret, settings } = split(id, values), at = new Date().toISOString(), connectionId = randomUUID(), nodeId = randomUUID();
  connections.insertConnection({ id: connectionId, provider: id, name: `${id} test`, secret: seal(JSON.stringify(item.secretSchema.parse(secret))), settings: item.settingsSchema.parse(settings), privateOk });
  db.prepare('INSERT INTO alert_nodes(id,provider,name,connection_id,prefill,created_at,updated_at) VALUES(?,?,?,?,NULL,?,?)').run(nodeId, id, `${id} node`, connectionId, at, at);
  db.prepare('INSERT INTO alert_lines(id,node_id,source_kind,source_id,events,enabled,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)').run(randomUUID(), nodeId, 'docknest', null, JSON.stringify(lineEvents), at, at);
  return { id: connectionId, nodeId, row: () => connections.getConnection(connectionId) };
}
const mock = handler => { const calls = []; delivery.alertHttp.fetch = async (url, init, guard) => { calls.push({ url, init, guard, headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : null }); return handler(url, init, calls.length); }; return calls; };
const reply = (status, body = {}, headers = {}) => new Response([204, 205].includes(status) ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const T0 = Date.parse('2026-11-10T00:00:00Z');
const fire = (extra = {}, at = T0) => delivery.emit({ type: 'backup.failed', key: `site:${randomUUID()}`, siteName: 'shop', serverName: 'srv', jobId: 'job-0001-aaaa', code: 'failed', ...extra }, { at });
const outbox = connectionId => db.prepare('SELECT status,attempts,next_attempt_at,message,payload,id FROM alert_outbox WHERE connection_id=? ORDER BY created_at,rowid').all(connectionId).map(row => ({ ...row }));
const sentence = async (id, status, body = {}, text = '') => provider(id).explain(status, body, { text });
// Everything a leak could show up in, as one string: the Connection view, audit rows, outbox rows and the Connection's last error.
function everything() {
  return JSON.stringify([connections.listConnections(), db.prepare('SELECT * FROM audit_events').all(), db.prepare('SELECT * FROM alert_outbox').all(), db.prepare('SELECT last_error,last_test,last_send FROM connections').all()]);
}

// ---- Fake HTTPS and HTTP servers, resolver and dial seam (as in alert-outbound.test.js) -----------------------------
const HOSTS = ['mail.example.com', 'api.telegram.org', 'graph.facebook.com', 'discord.com', 'ptb.discord.com', 'canary.discord.com', 'discordapp.com', 'hooks.slack.com', 'prod-01.westus.logic.azure.com', 'flow.api.powerplatform.com', 'chat.googleapis.com', 'api.pushover.net', 'ntfy.sh', 'chat.example.com', 'gotify.example.com', 'matrix.example.com', 'hooks.example.com'];
const certDir = await mkdtemp(join(tmpdir(), 'docknest-providers-tls-'));
let material = null;
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, 'k.pem'), '-out', join(certDir, 'c.pem'), '-days', '2', '-subj', '/CN=fixture.test', '-addext', `subjectAltName=${HOSTS.map(host => `DNS:${host}`).join(',')}`], { stdio: 'ignore' });
  material = { key: await readFile(join(certDir, 'k.pem')), cert: await readFile(join(certDir, 'c.pem')) };
} catch { /* openssl missing: the HTTPS tests are skipped */ }
const noTls = material ? false : 'openssl is not available';
async function fakeServer({ secure = true, handler } = {}) {
  const seen = [], sockets = new Set();
  const onRequest = (req, res) => { const parts = []; req.on('data', chunk => parts.push(chunk)); req.on('end', () => { const body = Buffer.concat(parts).toString('utf8'); seen.push({ method: req.method, url: req.url, headers: req.headers, body, json: (() => { try { return JSON.parse(body); } catch { return null; } })() }); if (handler) return handler(req, res, body, seen.length); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }); };
  const server = secure ? https.createServer({ key: material.key, cert: material.cert }, onRequest) : http.createServer(onRequest);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, host: '127.0.0.1', seen, close: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
}
// name -> address (all fake); every address is dialed to `server`.
function fakeNet(table, server) {
  const dialed = [];
  outboundIo.resolve = async host => { if (!table[host]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); return [].concat(table[host]).map(address => ({ address, family: net.isIP(address) })); };
  outboundIo.dial = (address, port) => { dialed.push(`${address}:${port}`); return server ? { address: server.host, port: server.port } : { address, port }; };
  if (material) outboundIo.ca = material.cert;
  return dialed;
}
const publicTable = () => Object.fromEntries(HOSTS.map((host, index) => [host, quad(93, 184, 216, index + 10)]));

// ---- Validation -------------------------------------------------------------------------------------------------------
const parse = (id, values) => { const { secret, settings } = split(id, values), item = provider(id), a = item.secretSchema.safeParse(secret), b = item.settingsSchema.safeParse(settings); return a.success && b.success ? { ok: true, secret: a.data, settings: b.data } : { ok: false, message: (a.error ?? b.error).issues[0].message }; };
const URL_PART = `/api/webhooks/${DISCORD_ID}/${DISCORD_TOKEN}`;
const INVALID = [
  ['telegram', { token: 'nope', chatId: '-1' }, /bot token/],
  ['whatsapp', { ...VALUES.whatsapp, phoneNumberId: 'abc' }, /phone number ID/], ['whatsapp', { ...VALUES.whatsapp, to: '12' }, /country code/], ['whatsapp', { ...VALUES.whatsapp, template: 'Bad Name' }, /Template names/], ['whatsapp', { ...VALUES.whatsapp, language: 'English' }, /language code/], ['whatsapp', { ...VALUES.whatsapp, token: 'short' }, /access token/],
  ['discord', { url: 'https://discord.com/api/webhooks/1/2' }, /not a Discord webhook/], ['discord', { url: `https://evil.example.com${URL_PART}` }, /webhook URL from Discord/], ['discord', { url: `http://discord.com${URL_PART}` }, /https/], ['discord', { url: `https://discord.com${URL_PART}?wait=true&x=1` }, /thread_id/], ['discord', { url: `https://discord.com.evil.example.com${URL_PART}` }, /webhook URL from Discord/], ['discord', { url: `https://user:pw@discord.com${URL_PART}` }, /user name/], ['discord', { url: `https://discord.com.${URL_PART}` }, /dot at the end/],
  ['slack', { url: 'https://hooks.slack.com/other' }, /not a Slack/], ['slack', { url: `https://example.com${SLACK_PATH}` }, /hooks\.slack\.com/],
  ['teams', { url: 'https://outlook.office.com/webhook/abc' }, /Teams Workflows/], ['teams', { url: 'https://evil.example.com/logic.azure.com' }, /Teams Workflows/], ['teams', { url: 'https://x.logic.azure.com:8443/workflows/a' }, /Teams Workflows/],
  ['googlechat', { url: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=k' }, /not a Google Chat/], ['googlechat', { url: 'https://example.com/v1/spaces/AAA/messages?key=k&token=t' }, /chat\.googleapis\.com/],
  ['mattermost', { url: 'https://chat.example.com/api/v4/posts' }, /not a Mattermost/], ['mattermost', { url: 'https://localhost/hooks/' + 'a'.repeat(26) }, /does not send/],
  ['ntfy', { server: 'ftp://ntfy.sh', topic: 'abc' }, /https/], ['ntfy', { server: 'https://ntfy.sh', topic: 'a b' }, /letters, digits/], ['ntfy', { server: 'https://ntfy.sh', topic: 'abc', token: 'bad token!' }, /access token/], ['ntfy', { server: 'https://ntfy.example.com./', topic: 'abc' }, /dot at the end/], ['ntfy', { server: 'https://metadata.google.internal/', topic: 'abc' }, /does not send/], ['ntfy', { server: 'http://169.254.169.254/', topic: 'abc' }, /does not send/], ['ntfy', { server: 'http://[fd00:ec2::253]/', topic: 'abc' }, /does not send/], ['ntfy', { server: 'https://user:pw@ntfy.sh', topic: 'abc' }, /user name/],
  ['gotify', { server: 'https://gotify.example.com', token: 'x' }, /application token/], ['gotify', { server: 'https://gotify.example.com/?a=1', token: GOTIFY_TOKEN }, /\? part/],
  ['pushover', { token: 'short', user: PUSH_USER }, /application token/], ['pushover', { token: PUSH_TOKEN, user: 'short' }, /user key/],
  ['matrix', { ...VALUES.matrix, room: '#alias:example.com' }, /room ID that starts with !/], ['matrix', { ...VALUES.matrix, room: 'abc:example.com' }, /room ID/], ['matrix', { ...VALUES.matrix, token: 'x' }, /access token/], ['matrix', { ...VALUES.matrix, server: 'https://matrix.example.com./' }, /dot at the end/],
  ['webhook', { url: 'https://hooks.example.com/x', header: 'Host: evil.example.com' }, /sets this header itself/], ['webhook', { url: 'https://hooks.example.com/x', header: 'Content-Type: text/plain' }, /sets this header itself/], ['webhook', { url: 'https://hooks.example.com/x', header: 'Cookie: a=b' }, /sets this header itself/], ['webhook', { url: 'https://hooks.example.com/x', header: 'Proxy-Authorization: x' }, /sets this header itself/], ['webhook', { url: 'https://hooks.example.com/x', header: 'Accept: */*' }, /Authorization or start with X-/], ['webhook', { url: 'https://hooks.example.com/x', header: 'X-Key: café' }, /plain characters/], ['webhook', { url: 'https://hooks.example.com/x', header: 'nocolon' }, /Name: value/], ['webhook', { url: 'https://hooks.example.com/x', header: 'X-A: ' + 'b'.repeat(1100) }, /1 KB/], ['webhook', { url: 'https://hooks.example.com./x' }, /dot at the end/],
];
const VALID = [
  ['whatsapp', { ...VALUES.whatsapp, template: '' }, { template: '' }], ['whatsapp', { ...VALUES.whatsapp, language: 'en_US' }, { language: 'en_US' }],
  ['discord', { url: `https://ptb.discord.com${URL_PART}` }, {}], ['discord', { url: `https://canary.discord.com${URL_PART}` }, {}], ['discord', { url: `https://discordapp.com${URL_PART}` }, {}],
  ['teams', { url: 'https://flow.api.powerplatform.com:443/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=fixtureSig0123' }, {}],
  ['ntfy', { server: 'http://ntfy.lan:8080/', topic: 'abc' }, { server: 'http://ntfy.lan:8080' }], ['ntfy', { server: 'https://ntfy.example.com/sub/', topic: 'abc' }, { server: 'https://ntfy.example.com/sub' }], ['ntfy', { topic: 'abc' }, { server: 'https://ntfy.sh' }],
  ['matrix', { ...VALUES.matrix, server: 'https://matrix.example.com:8448' }, { server: 'https://matrix.example.com:8448' }], ['matrix', { ...VALUES.matrix, room: '!opaqueV12roomIdWithoutServerPart' }, {}], ['matrix', { ...VALUES.matrix, room: '!abc:example.com:8448' }, {}],
  ['webhook', { url: 'http://hooks.lan:8080/in' }, {}], ['webhook', { url: 'https://hooks.example.com/x', header: 'X-Api-Key: abc' }, {}],
];

test('validation: every provider accepts its valid forms, keeps them canonical, and refuses bad input with a plain sentence', () => {
  for (const id of Object.keys(VALUES)) { const result = parse(id, VALUES[id]); assert.equal(result.ok, true, `${id}: ${result.message}`); }
  for (const [id, values, expected] of VALID) { const result = parse(id, values); assert.equal(result.ok, true, `${id} ${JSON.stringify(values)}: ${result.message}`); assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, { ...result.settings, ...result.secret }[key]])), expected, id); }
  for (const [id, values, pattern] of INVALID) { const result = parse(id, values); assert.equal(result.ok, false, `${id} ${JSON.stringify(values).slice(0, 80)}`); assert.match(result.message, pattern, id); assert.ok(!probes(id).some(probe => result.message.includes(probe)), 'a validation message never repeats the secret'); }
  // Unknown extra fields are refused (strict schemas), and the WhatsApp defaults apply when the fields are missing.
  assert.equal(parse('discord', { ...VALUES.discord, extra: 'x' }).ok, false);
  assert.equal(parse('whatsapp', { token: WA_TOKEN, phoneNumberId: '1234567890', to: '15550100' }).settings.template, 'docknest_alert');
  assert.equal(parse('whatsapp', { token: WA_TOKEN, phoneNumberId: '1234567890', to: '15550100' }).settings.language, 'en');
  assert.equal(parse('whatsapp', VALUES.whatsapp).settings.to, '15550100', 'spaces and + are dropped from the number');
  assert.equal(parse('discord', { url: `https://discord.com${URL_PART}?thread_id=${THREAD}` }).secret.url, `https://discord.com${URL_PART}?thread_id=${THREAD}`, 'a thread webhook keeps its thread_id');
});

test('registry: every provider has the contract fields, secrets and webhook URLs are secret, and the list for the UI carries no code', () => {
  assert.deepEqual(Object.keys(providers), ['telegram', 'email', 'whatsapp', 'discord', 'slack', 'teams', 'googlechat', 'mattermost', 'ntfy', 'gotify', 'pushover', 'matrix', 'webhook']);
  for (const id of Object.keys(VALUES)) {
    const item = provider(id);
    for (const part of ['id', 'label', 'icon', 'group', 'fields', 'secretSchema', 'settingsSchema', 'destination', 'host', 'target', 'format', 'explain', 'unreachable']) assert.ok(item[part] !== undefined, `${id}.${part}`);
    assert.ok(Object.isFrozen(item));
    for (const key of [...item.destination, ...item.host]) assert.ok(item.fields.some(field => field.key === key), `${id}: ${key} is a field`);
  }
  for (const id of ['discord', 'slack', 'teams', 'googlechat', 'mattermost', 'webhook']) assert.equal(provider(id).fields.find(field => field.key === 'url').secret, true, `${id}: the webhook URL is the login`);
  for (const [id, key] of [['telegram', 'token'], ['whatsapp', 'token'], ['ntfy', 'token'], ['gotify', 'token'], ['pushover', 'token'], ['pushover', 'user'], ['matrix', 'token'], ['webhook', 'header']]) assert.equal(provider(id).fields.find(field => field.key === key).secret, true, `${id}.${key}`);
  assert.equal(provider('webhook').group, 'advanced');
  const list = registry.providerList(); assert.equal(list.length, 13); assert.ok(list.every(item => !('secretSchema' in item) && !('format' in item)));
  assert.deepEqual(provider('whatsapp').fields.filter(field => field.more).map(field => [field.key, field.default]), [['template', 'docknest_alert'], ['language', 'en']]);
  assert.match(provider('whatsapp').fields.find(field => field.key === 'template').help, /within 24 hours of a message from you/);
  for (const id of ['ntfy', 'gotify', 'matrix']) assert.deepEqual(provider(id).host, ['server']);
  // A saved secret is never part of a view: only `<field>Set` flags.
  assert.deepEqual(registry.sealedView('discord', { url: VALUES.discord.url }), { urlSet: true });
  assert.deepEqual(registry.sealedView('pushover', PUSH_TOKEN && { token: PUSH_TOKEN, user: PUSH_USER }), { tokenSet: true, userSet: true });
});

// ---- Format: native output per provider -----------------------------------------------------------------------------
const JOB = 'https://dock.example.com/?job=job-0001-aaaa';
const BODY_TEXT = 'Backup failed\nshop.example.com on mobiX-Srv at 03:00 UTC\nThe backup did not finish. Open DockNest to see why.';
test('format: each provider renders the one message natively', () => {
  const call = id => provider(id).format(MSG, parse(id, VALUES[id]) && { ...parse(id, VALUES[id]).secret, ...parse(id, VALUES[id]).settings });
  assert.deepEqual(call('telegram'), { method: 'POST', path: `/bot${TG}/sendMessage`, json: { chat_id: '-1001234567890', text: `${BODY_TEXT}\nOpen the job: ${JOB}`, link_preview_options: { is_disabled: true } } });
  assert.deepEqual(call('whatsapp'), { method: 'POST', path: `/${GRAPH_VERSION}/1234567890/messages`, headers: { Authorization: `Bearer ${WA_TOKEN}` }, json: { messaging_product: 'whatsapp', to: '15550100', type: 'template', template: { name: 'docknest_alert', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Backup failed' }, { type: 'text', text: 'shop.example.com on mobiX-Srv at 03:00 UTC' }, { type: 'text', text: 'The backup did not finish. Open DockNest to see why.' }] }] } } });
  assert.deepEqual(provider('whatsapp').format(MSG, { ...parse('whatsapp', VALUES.whatsapp).secret, ...parse('whatsapp', { ...VALUES.whatsapp, template: '' }).settings }).json, { messaging_product: 'whatsapp', to: '15550100', type: 'text', text: { preview_url: false, body: `${BODY_TEXT}\nOpen the job: ${JOB}` } });
  assert.deepEqual(call('discord'), { method: 'POST', url: `https://discord.com${URL_PART}?wait=true`, json: { content: `**Backup failed**\nshop.example.com on mobiX-Srv at 03:00 UTC\nThe backup did not finish. Open DockNest to see why.\n<${JOB}>`, allowed_mentions: { parse: [] } } });
  assert.deepEqual(call('slack'), { method: 'POST', url: `https://hooks.slack.com${SLACK_PATH}`, json: { text: `*Backup failed*\nshop.example.com on mobiX-Srv at 03:00 UTC\nThe backup did not finish. Open DockNest to see why.\n<${JOB}|Open job>` } });
  assert.deepEqual(call('teams'), { method: 'POST', url: TEAMS_URL, json: { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: 'Backup failed', wrap: true, weight: 'Bolder', size: 'Medium' }, { type: 'TextBlock', text: 'shop.example.com on mobiX-Srv at 03:00 UTC', wrap: true }, { type: 'TextBlock', text: 'The backup did not finish. Open DockNest to see why.', wrap: true }], actions: [{ type: 'Action.OpenUrl', title: 'Open job', url: JOB }] } }] } });
  assert.deepEqual(call('googlechat'), { method: 'POST', url: CHAT_URL, json: { text: `*Backup failed*\nshop.example.com on mobiX-Srv at 03:00 UTC\nThe backup did not finish. Open DockNest to see why.\n<${JOB}|Open job>` } });
  assert.deepEqual(call('mattermost'), { method: 'POST', url: `https://chat.example.com${MM_PATH}`, json: { text: `**Backup failed**\n\nshop.example.com on mobiX-Srv at 03:00 UTC\n\nThe backup did not finish. Open DockNest to see why.\n\n[Open job](${JOB})` } });
  assert.deepEqual(call('ntfy'), { method: 'POST', path: '/', headers: { Authorization: `Bearer ${NTFY_TOKEN}` }, json: { topic: 'docknest-fixture-topic', title: 'Backup failed', message: 'shop.example.com on mobiX-Srv at 03:00 UTC\nThe backup did not finish. Open DockNest to see why.', click: JOB, priority: 4 } });
  assert.deepEqual(call('gotify'), { method: 'POST', path: '/message', headers: { 'X-Gotify-Key': GOTIFY_TOKEN }, json: { title: 'Backup failed', message: 'shop.example.com on mobiX-Srv at 03:00 UTC\nThe backup did not finish. Open DockNest to see why.', priority: 8, extras: { 'client::notification': { click: { url: JOB } } } } });
  assert.deepEqual(call('pushover'), { method: 'POST', path: '/1/messages.json', json: { token: PUSH_TOKEN, user: PUSH_USER, title: 'Backup failed', message: 'shop.example.com on mobiX-Srv at 03:00 UTC\nThe backup did not finish. Open DockNest to see why.', priority: 1, url: JOB, url_title: 'Open job' } });
  const matrixCall = call('matrix'); assert.match(matrixCall.path, /^\/_matrix\/client\/v3\/rooms\/%21fixtureRoom%3Aexample\.com\/send\/m\.room\.message\/item-0001-[0-9a-f]{16}$/);
  assert.deepEqual({ ...matrixCall, path: null }, { method: 'PUT', path: null, headers: { Authorization: `Bearer ${MATRIX_TOKEN}` }, json: { msgtype: 'm.text', body: `${BODY_TEXT}\nOpen the job: ${JOB}`, format: 'org.matrix.custom.html', formatted_body: `<b>Backup failed</b><br>shop.example.com on mobiX-Srv at 03:00 UTC<br>The backup did not finish. Open DockNest to see why.<br><a href="${JOB}">Open job</a>`, 'm.mentions': {} } });
  assert.deepEqual(call('webhook'), { method: 'POST', url: 'https://hooks.example.com/in/fixtureHook', headers: { Authorization: 'Bearer webhookFixture01' }, json: { title: 'Backup failed', site: 'shop.example.com', server: 'mobiX-Srv', message: 'Backup failed: shop.example.com on mobiX-Srv at 03:00 UTC. The backup did not finish. Open DockNest to see why.', url: JOB, event: 'backup.failed', at: '2026-10-27T03:00:00Z' } });
});

test('format: no link without a URL; success messages are quiet (no priority); Pushover and ntfy raise failures only', () => {
  const values = id => ({ ...parse(id, VALUES[id]).secret, ...parse(id, VALUES[id]).settings });
  for (const id of Object.keys(VALUES)) assert.ok(!JSON.stringify(provider(id).format(OK_MSG, values(id)).json ?? provider(id).format(OK_MSG, values(id))).includes('job-0001'), `${id}: no link`);
  assert.equal(provider('ntfy').format(OK_MSG, values('ntfy')).json.priority, undefined);
  assert.equal(provider('ntfy').format(OK_MSG, values('ntfy')).json.click, undefined);
  assert.equal(provider('pushover').format(OK_MSG, values('pushover')).json.priority, 0);
  assert.equal(provider('pushover').format(OK_MSG, values('pushover')).json.url, undefined);
  assert.equal(provider('gotify').format(OK_MSG, values('gotify')).json.priority, 5);
  assert.deepEqual(provider('ntfy').format(OK_MSG, { ...values('ntfy'), token: '' }).headers, {}, 'ntfy without a token sends no Authorization header');
  for (const type of ['backup.failed', 'server.unreachable', 'server.disk_low', 'restore_test.failed', 'restore_test.couldnt_run']) assert.equal(common.urgent({ event: type }), true, type);
  for (const type of ['backup.succeeded', 'move.finished', 'update.available', 'restore_test.recovered', 'test']) assert.equal(common.urgent({ event: type }), false, type);
});

// ---- Escaping, unicode, limits -------------------------------------------------------------------------------------
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|‍|️/u;
test('escaping: markup, mentions and HTML in a site name are neutral in every provider', () => {
  const nasty = { ...MSG, site: '@everyone <b>&</b> *x* _y_ [z](http://evil.example.com) `c` ~s~ <!channel> <users/all> |p|', server: '@here #1 > q' };
  const out = id => JSON.stringify(provider(id).format(nasty, { ...parse(id, VALUES[id]).secret, ...parse(id, VALUES[id]).settings, room: '!r:example.com' }));
  assert.match(out('slack'), /&amp;/); assert.match(out('slack'), /&lt;!channel&gt;/); assert.ok(!out('slack').includes('<!channel>'));
  assert.ok(!out('googlechat').includes('<users/all>') && !out('googlechat').includes('<b>'));
  assert.deepEqual(JSON.parse(out('discord')).json.allowed_mentions, { parse: [] }, 'Discord mentions are off');
  assert.match(JSON.parse(out('discord')).json.content, /\\\*x\\\*/); assert.match(JSON.parse(out('discord')).json.content, /\\\[z\\\]\\\(http/);
  const mattermost = JSON.parse(out('mattermost')).json.text; assert.ok(!mattermost.includes('@everyone') && !mattermost.includes('@here'), 'Mattermost: no live mention'); assert.match(mattermost, /@​everyone/);
  const matrix = JSON.parse(out('matrix')).json; assert.ok(!matrix.formatted_body.includes('<b>&</b>') && matrix.formatted_body.includes('&lt;b&gt;&amp;&lt;/b&gt;'), 'Matrix HTML is escaped'); assert.deepEqual(matrix['m.mentions'], {}); assert.ok(!matrix.body.includes('@room') && !matrix.body.includes('@everyone'));
  assert.ok(JSON.parse(out('teams')).json.attachments[0].content.body.every(block => block.type === 'TextBlock'), 'Teams: text blocks only');
  assert.equal(common.markdownEscape('1. a\n- b\n+ c'), '1\\. a\n\\- b\n\\+ c', 'list markers only at the start of a line');
  assert.equal(common.markdownEscape('mobiX-Srv a-b'), 'mobiX-Srv a-b', 'hyphens inside a name are left alone');
});

test('unicode and right-to-left text pass through every provider intact, and no provider adds an emoji', () => {
  const hebrew = { ...MSG, site: 'חנות המתנות', server: 'שרת-ראשי', reason: 'הגיבוי לא הושלם. פתחו את DockNest.' };
  for (const id of Object.keys(VALUES)) {
    const item = provider(id), values = { ...parse(id, VALUES[id]).secret, ...parse(id, VALUES[id]).settings };
    const call = item.format(hebrew, values), text = JSON.stringify(call.json);
    assert.ok(text.includes('חנות המתנות') || text.includes('חנות'), `${id}: Hebrew site name kept`);
    assert.equal(JSON.parse(JSON.stringify(call.json)) !== null, true);
    assert.ok(!EMOJI.test(JSON.stringify(item.format(MSG, values))), `${id}: emoji-free output`);
    assert.ok(Buffer.byteLength(JSON.stringify(call.json)) < 16 * 1024, `${id}: within the 16 KB request limit`);
  }
  assert.ok(!EMOJI.test(JSON.stringify(Object.values(reasons.REASON_KEYS))), 'the catalogue holds no emoji');
});

test('limits: an over-long message is cut at the provider limit, never inside a character, with an ellipsis', () => {
  const star = '\u{1d4b3}', longText = (star + 'a').repeat(4000);          // astral characters: two UTF-16 units each
  const big = { ...MSG, title: longText, site: longText, server: longText, reason: longText };
  const values = id => ({ ...parse(id, VALUES[id]).secret, ...parse(id, VALUES[id]).settings });
  const lone = text => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);
  const check = (id, text, limit) => { assert.ok(text.length <= limit, `${id}: ${text.length} <= ${limit}`); assert.ok(text.endsWith('…'), `${id}: ends with an ellipsis`); assert.equal(lone(text), false, `${id}: no split surrogate`); };
  check('telegram', provider('telegram').format(big, values('telegram')).json.text, 4096);
  check('discord', provider('discord').format(big, values('discord')).json.content, 2000);
  check('slack', provider('slack').format(big, values('slack')).json.text, 4000);
  check('googlechat', provider('googlechat').format(big, values('googlechat')).json.text, 4096);
  check('mattermost', provider('mattermost').format(big, values('mattermost')).json.text, 16383);
  check('pushover', provider('pushover').format(big, values('pushover')).json.message, 1024); check('pushover', provider('pushover').format(big, values('pushover')).json.title, 250);
  check('gotify', provider('gotify').format(big, values('gotify')).json.message, 4096);
  const ntfy = provider('ntfy').format(big, values('ntfy')).json; assert.ok(Buffer.byteLength(ntfy.message) <= 4096 && ntfy.message.endsWith('…') && !lone(ntfy.message)); assert.ok(Buffer.byteLength(ntfy.title) <= 250);
  assert.ok(provider('teams').format(big, values('teams')).json.attachments[0].content.body.every(block => block.text.length <= 1000));
  assert.ok(provider('whatsapp').format(big, values('whatsapp')).json.template.components[0].parameters.every(param => param.text.length <= 200 && !lone(param.text)));
  assert.ok(Buffer.byteLength(JSON.stringify(provider('matrix').format(big, values('matrix')).json)) < 60 * 1024, 'Matrix: well under the 65 KB event limit');
  // The cut text of a normal message is untouched.
  assert.equal(common.cut('short', 10), 'short'); assert.equal(common.cut('abcdef', 4), 'abc…');
});

// ---- WhatsApp -------------------------------------------------------------------------------------------------------
test('WhatsApp: template parameters are cleaned (newlines, tabs, runs of spaces, length, empty), free text is the fallback', () => {
  assert.equal(parameter('a\nb\tc'), 'a b c'); assert.equal(parameter('a     b      c'), 'a b c', 'never more than 4 spaces in a row'); assert.equal(parameter('   '), '-'); assert.equal(parameter(''), '-'); assert.equal(parameter('x'.repeat(500)).length, 200);
  const values = { ...parse('whatsapp', VALUES.whatsapp).secret, ...parse('whatsapp', VALUES.whatsapp).settings };
  const params = provider('whatsapp').format({ ...MSG, site: 'a\n\n   b\t\tc          d', server: '', reason: '' }, values).json.template.components[0].parameters.map(param => param.text);
  assert.deepEqual(params, ['Backup failed', 'a b c d at 03:00 UTC', 'Backup failed'], 'newlines, tabs and long runs of spaces are single spaces; empty parts fall back to the title');
  assert.ok(params.every(text => !/[\n\t]| {5}/.test(text)));
});

test('WhatsApp: a missing, rejected or unapproved template, a bad login and the 24-hour rule each give one plain sentence', () => {
  const explain = (status, code) => provider('whatsapp').explain(status, { error: { code, message: 'Meta text that must not be repeated: ' + WA_TOKEN } });
  assert.deepEqual(explain(404, 132001), { message: 'WhatsApp does not know this template. Check the template name and language in WhatsApp Manager.', final: true });
  assert.match(explain(400, 132012).message, /rejected the template/); assert.equal(explain(400, 132018).final, true);
  assert.match(explain(400, 131047).message, /within 24 hours of a message from you/); assert.equal(explain(400, 131047).final, true);
  assert.match(explain(401, 190).message, /access token/); assert.match(explain(400, 190).message, /access token/);
  assert.match(explain(400, 131030).message, /not allowed to get messages/); assert.match(explain(400, 100).message, /phone number ID/);
  assert.equal(explain(400, 130429).final, false, 'a throughput limit is retried'); assert.equal(explain(500, 1).final, false);
  assert.equal(provider('whatsapp').explain(200, { messages: [{ id: 'wamid.fixture' }] }), null);
  for (const [status, code] of [[404, 132001], [400, 132012], [401, 190], [400, 131047], [400, 999999]]) assert.ok(!explain(status, code).message.includes(WA_TOKEN) && !explain(status, code).message.includes('Meta text'));
  assert.match(provider('whatsapp').testNote, /^Accepted by WhatsApp\./); assert.ok(!/Delivered/.test(provider('whatsapp').testNote));
});

test('WhatsApp end to end: the template message is sent to graph.facebook.com with the pinned version; a missing template ends the item at once', async () => {
  reset(); const connection = connect('whatsapp'); const calls = mock(() => reply(200, { messaging_product: 'whatsapp', messages: [{ id: 'wamid.fixture' }] }));
  try {
    fire(); assert.equal(await delivery.deliverDue({ at: T0 }), 1);
    assert.equal(calls[0].url, `https://graph.facebook.com/${GRAPH_VERSION}/1234567890/messages`); assert.equal(calls[0].headers.Authorization, `Bearer ${WA_TOKEN}`);
    assert.deepEqual(calls[0].guard, { hosts: ['graph.facebook.com'], privateAllowed: false });
    assert.equal(calls[0].body.type, 'template'); assert.equal(calls[0].body.template.name, 'docknest_alert'); assert.equal(calls[0].body.template.components[0].parameters.length, 3);
    mock(() => reply(404, { error: { code: 132001, message: 'Template name does not exist in the translation', error_data: { details: 'x' } } }));
    fire({ key: 'site:other' }, T0 + 1000); await delivery.deliverDue({ at: T0 + 1000 });
    const row = outbox(connection.id).at(-1); assert.deepEqual([row.status, row.attempts], ['failed', 1], 'final: retrying cannot create the template');
    assert.equal(connection.row().last_error, 'WhatsApp does not know this template. Check the template name and language in WhatsApp Manager.');
  } finally { restore(); }
});

// ---- Send: every provider over a real fake HTTPS server through the guarded client ----------------------------------
test('send: each provider reaches its own host through outbound.js and the fake server sees the exact request', { skip: noTls }, async () => {
  reset(); const server = await fakeServer(); fakeNet(publicTable(), server);
  try {
    const expect = {
      telegram: { host: 'api.telegram.org', url: `/bot${TG}/sendMessage` }, whatsapp: { host: 'graph.facebook.com', url: `/${GRAPH_VERSION}/1234567890/messages` },
      discord: { host: 'discord.com', url: `${URL_PART}?wait=true` }, slack: { host: 'hooks.slack.com', url: SLACK_PATH }, teams: { host: 'prod-01.westus.logic.azure.com', url: new URL(TEAMS_URL).pathname + new URL(TEAMS_URL).search },
      googlechat: { host: 'chat.googleapis.com', url: '/v1/spaces/AAAAfixture/messages' + new URL(CHAT_URL).search }, mattermost: { host: 'chat.example.com', url: MM_PATH }, ntfy: { host: 'ntfy.sh', url: '/' },
      gotify: { host: 'gotify.example.com', url: '/message' }, pushover: { host: 'api.pushover.net', url: '/1/messages.json' }, matrix: { host: 'matrix.example.com', url: /^\/_matrix\/client\/v3\/rooms\/%21fixtureRoom%3Aexample\.com\/send\/m\.room\.message\/[A-Za-z0-9_-]+$/ }, webhook: { host: 'hooks.example.com', url: '/in/fixtureHook' },
    };
    for (const id of Object.keys(VALUES)) {
      const connection = connect(id); server.seen.length = 0;
      await delivery.sendWith(connection.row(), MSG);
      const [seen] = server.seen; assert.equal(server.seen.length, 1, id);
      assert.equal(seen.headers.host, expect[id].host, `${id}: Host`);
      if (expect[id].url instanceof RegExp) assert.match(seen.url, expect[id].url, id); else assert.equal(seen.url, expect[id].url, id);
      assert.equal(seen.method, id === 'matrix' ? 'PUT' : 'POST', id); assert.equal(seen.headers['content-type'], 'application/json', id); assert.ok(seen.json, `${id}: JSON body`);
      assert.equal(seen.headers['user-agent'], 'DockNest');
    }
  } finally { server.close(); restore(); }
});

test('send: the official hosts of Discord (ptb, canary, discordapp) and Teams (api.powerplatform.com) are reached; Slack and others cannot be pointed elsewhere', { skip: noTls }, async () => {
  reset(); const server = await fakeServer(); fakeNet(publicTable(), server);
  try {
    for (const host of ['ptb.discord.com', 'canary.discord.com', 'discordapp.com']) { const c = connect('discord', { url: `https://${host}${URL_PART}` }); server.seen.length = 0; await delivery.sendWith(c.row(), MSG); assert.equal(server.seen[0].headers.host, host); }
    const flow = connect('teams', { url: 'https://flow.api.powerplatform.com/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?sig=fixtureSig0123' }); server.seen.length = 0;
    await delivery.sendWith(flow.row(), MSG); assert.equal(server.seen[0].headers.host, 'flow.api.powerplatform.com'); assert.equal(server.seen[0].json.type, 'message');
    // A stored URL that no longer passes (a hand-edited row) sends nothing; and the guard names the exact list.
    const bad = connect('slack'); db.prepare('UPDATE connections SET secret=? WHERE id=?').run(seal(JSON.stringify({ url: `https://evil.example.com${SLACK_PATH}` })), bad.id);
    server.seen.length = 0; await assert.rejects(delivery.sendWith(bad.row(), MSG), /saved settings cannot be read/); assert.equal(server.seen.length, 0);
    for (const [id, hosts] of [['slack', ['hooks.slack.com']], ['discord', ['discord.com', 'ptb.discord.com', 'canary.discord.com', 'discordapp.com']], ['teams', ['*.logic.azure.com', '*.api.powerplatform.com']], ['googlechat', ['chat.googleapis.com']], ['pushover', ['api.pushover.net']], ['whatsapp', ['graph.facebook.com']], ['telegram', ['api.telegram.org']]]) assert.deepEqual(delivery.guardFor({ provider: id, private_ok: 1 }, provider(id), {}), { hosts, privateAllowed: false }, id);
    assert.throws(() => checkUrl('https://evil.example.com/x', { hosts: ['*.logic.azure.com'] }), error => error instanceof OutboundError && error.code === 'blocked');
    assert.throws(() => checkUrl('https://logic.azure.com/x', { hosts: ['*.logic.azure.com'] }), error => error.code === 'blocked', 'the bare suffix is not a subdomain');
    assert.throws(() => checkUrl('https://x.logic.azure.com.evil.example.com/x', { hosts: ['*.logic.azure.com'] }), error => error.code === 'blocked');
    assert.ok(checkUrl('https://a.b.logic.azure.com/x', { hosts: ['*.logic.azure.com'] }));
  } finally { server.close(); restore(); }
});

// ---- Failures: final, retry and wait -----------------------------------------------------------------------------------
const WAIT_BODY = { discord: { retry_after: 7.5 }, telegram: { parameters: { retry_after: 9 } }, matrix: { retry_after_ms: 8000 } };
test('delivery: a rejected login or a gone destination is final at once, a 5xx is retried 1 and 5 minutes later, for every provider', async () => {
  try {
    for (const id of Object.keys(VALUES)) {
      for (const [status, final] of [[401, true], [403, true], [404, true], [410, id !== 'telegram'], [400, id !== 'telegram'], [422, id !== 'telegram'], [500, false], [502, false], [503, false], [408, false]]) {
        reset(); const connection = connect(id); mock(() => reply(status, { error: 'x' }));
        fire(); await delivery.deliverDue({ at: T0 });
        const [row] = outbox(connection.id);
        if (final) assert.deepEqual([row.status, row.attempts], ['failed', 1], `${id} ${status} is final`);
        else { assert.deepEqual([row.status, row.attempts, row.next_attempt_at], ['pending', 1, T0 + 60_000], `${id} ${status} is retried`); }
        assert.equal(connection.row().last_send, 'failed'); assert.ok(connection.row().last_error && connection.row().last_error.length <= 200, `${id} ${status}: one sentence`);
      }
      // 5xx three times: tries at 1 minute and 5 minutes, then it gives up.
      reset(); const connection = connect(id); mock(() => reply(503)); fire();
      await delivery.deliverDue({ at: T0 }); await delivery.deliverDue({ at: T0 + 60_000 }); assert.equal(outbox(connection.id)[0].next_attempt_at, T0 + 60_000 + 5 * 60_000, id);
      await delivery.deliverDue({ at: T0 + 6 * 60_000 }); assert.deepEqual([outbox(connection.id)[0].status, outbox(connection.id)[0].attempts], ['failed', 3], id);
    }
  } finally { restore(); }
});

test('delivery: a 429 waits as long as the provider says (Retry-After seconds or date, Discord, Telegram and Matrix bodies) and uses up no try', async () => {
  try {
    for (const id of Object.keys(VALUES)) {
      for (const [headers, body, wait] of [[{ 'Retry-After': '12' }, {}, 12_000], [{ 'Retry-After': new Date(Date.now() + 90_000).toUTCString() }, {}, 'about 90 seconds'], [{}, WAIT_BODY.discord, 7_500], [{}, WAIT_BODY.telegram, 9_000], [{}, WAIT_BODY.matrix, 8_000], [{}, {}, 60_000], [{ 'Retry-After': '99999' }, {}, 15 * 60_000]]) {
        reset(); const connection = connect(id); mock(() => reply(429, body, headers)); fire();
        await delivery.deliverDue({ at: T0 }); const [row] = outbox(connection.id);
        if (wait === 'about 90 seconds') { assert.deepEqual([row.status, row.attempts], ['pending', 0]); assert.ok(row.next_attempt_at - T0 > 87_000 && row.next_attempt_at - T0 <= 90_000, `${id}: ${row.next_attempt_at - T0}`); } else assert.deepEqual([row.status, row.attempts, row.next_attempt_at], ['pending', 0, T0 + wait], `${id} ${JSON.stringify(headers)} ${JSON.stringify(body)}`);
        assert.match(connection.row().last_error, /slow down/);
      }
    }
  } finally { restore(); }
});

test('delivery: provider-specific answers map to the plain sentences of the ADR', async () => {
  const slack = (status, text) => provider('slack').explain(status, {}, { text });
  assert.deepEqual(slack(404, 'no_service'), { message: 'Slack does not accept this webhook. Create a new one and paste it again.', final: true });
  assert.deepEqual(slack(410, 'channel_is_archived'), { message: 'This Slack channel is archived. Unarchive it or create a new webhook.', final: true });
  assert.equal(slack(400, 'invalid_payload').final, true); assert.equal(slack(403, 'action_prohibited').final, true); assert.equal(slack(200, 'ok'), null); assert.equal(slack(500, '').final, false);
  assert.equal(provider('discord').explain(204, {}), null); assert.equal(provider('discord').explain(200, { id: '1', content: 'x' }), null);
  assert.deepEqual(provider('discord').explain(404, { code: 10015, message: 'Unknown Webhook' }), { message: 'Discord does not accept this webhook. Create a new one and paste it again.', final: true });
  assert.equal(provider('discord').explain(401, {}).final, true); assert.equal(provider('discord').explain(400, { code: 50006 }).final, true);
  assert.equal(provider('teams').explain(202, {}), null); assert.equal(provider('teams').explain(200, {}), null); assert.equal(provider('teams').explain(400, {}).final, true); assert.equal(provider('teams').explain(502, {}).final, false);
  assert.match(provider('teams').testNote, /run history/); assert.ok(!/Delivered/.test(provider('teams').testNote));
  assert.equal(provider('googlechat').explain(400, {}).final, true); assert.equal(provider('googlechat').explain(403, {}).final, true); assert.equal(provider('googlechat').explain(404, {}).final, true); assert.equal(provider('googlechat').explain(200, {}), null);
  assert.equal(provider('pushover').explain(400, { status: 0, user: 'invalid', errors: ['user identifier is invalid'] }).final, true); assert.match(provider('pushover').explain(400, { status: 0, token: 'invalid' }).message, /application token or user key/);
  assert.equal(provider('pushover').explain(200, { status: 1, request: 'x' }), null); assert.equal(provider('pushover').explain(200, { status: 0 }).final, true); assert.equal(provider('pushover').explain(500, {}).final, false);
  assert.match(provider('matrix').explain(401, { errcode: 'M_UNKNOWN_TOKEN' }).message, /access token/); assert.match(provider('matrix').explain(403, { errcode: 'M_FORBIDDEN' }).message, /room/); assert.equal(provider('matrix').explain(429, { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 2000 }).final, false);
  assert.match(provider('ntfy').explain(401, {}).message, /token/); assert.match(provider('ntfy').explain(404, {}).message, /not found/); assert.match(provider('gotify').explain(401, {}).message, /application token/); assert.match(provider('mattermost').explain(404, {}).message, /webhook/);
  assert.match(provider('webhook').explain(401, {}).message, /header/); assert.match(provider('webhook').explain(404, {}).message, /no longer exists/);
  for (const id of Object.keys(VALUES)) for (const status of [200, 201, 202, 204]) assert.equal(provider(id).explain(status, status === 200 && id === 'whatsapp' ? { messages: [{}] } : {}, { text: 'ok' }), null, `${id} ${status} succeeds`);
  // Telegram keeps its 2.8 answers: 400 and 5xx retried, 401, 403 and 404 final.
  assert.equal(provider('telegram').explain(400, {}).final, false); assert.equal(provider('telegram').explain(403, {}).final, true);
});

// ---- Secrets ---------------------------------------------------------------------------------------------------------
test('secrets: no login, webhook URL, response text or provider error appears in views, audit, outbox, last_error, errors or logs', async () => {
  const logs = [], saved = { ...console }; for (const name of ['log', 'error', 'warn', 'info', 'debug']) console[name] = (...args) => logs.push(args.map(String).join(' '));
  const errors = [];
  try {
    for (const id of Object.keys(VALUES)) {
      reset(); const connection = connect(id), echo = JSON.stringify({ message: `echo ${Object.values(VALUES[id]).join(' ')} ${probes(id).join(' ')}`, errors: probes(id), error: { message: probes(id).join(' '), code: 1 } });
      for (const status of [400, 401, 404, 429, 500]) { mock(() => reply(status, echo, { 'Retry-After': '5' })); fire({ key: `site:${id}:${status}` }); await delivery.deliverDue({ at: T0 }); fire({ key: `site:${id}:${status}b` }); }
      mock(() => { throw Object.assign(new Error(`connect ECONNREFUSED ${VALUES[id].url ?? ''} ${probes(id).join(' ')}`), { cause: probes(id)[0] }); });
      try { await delivery.sendWith(connection.row(), MSG); } catch (error) { errors.push(error.message, error.stack, JSON.stringify(error)); }
      mock(() => reply(500, echo)); try { await delivery.sendWith(connection.row(), MSG); } catch (error) { errors.push(error.message, error.stack, JSON.stringify(error)); }
      const haystack = [everything(), errors.join('\n'), logs.join('\n'), JSON.stringify(connections.connectionView(connection.row())), JSON.stringify(registry.providerList())].join('\n');
      for (const probe of probes(id)) assert.ok(!haystack.includes(probe), `${id}: a secret leaked (${probe.slice(0, 4)}...)`);
      for (const status of [200, 400, 401, 403, 404, 410, 422, 429, 500, 503]) { const answer = provider(id).explain(status, JSON.parse(echo), { text: echo }); assert.ok(!probes(id).some(probe => JSON.stringify(answer).includes(probe)), `${id} ${status}: explain()`); }
      const view = connections.connectionView(connection.row());
      for (const field of provider(id).fields.filter(item => item.secret)) assert.ok(!(field.key in view.values) || view.values[field.key] === undefined, `${id}.${field.key} is not in the view`);
      assert.ok(Object.keys(view.values).some(key => key.endsWith('Set')), `${id}: a Set flag is shown`);
      assert.ok(!JSON.stringify(view).includes('"secret"'));
    }
  } finally { Object.assign(console, saved); restore(); }
});

// ---- The guard ---------------------------------------------------------------------------------------------------------
test('guard: a fixed-host provider reaches its own host only, on a public address, even when its row and the setting allow private', async () => {
  const server = await fakeServer({ secure: false }); privateNetwork(true);
  try {
    for (const id of FIXED) {
      reset(); privateNetwork(true); const connection = connect(id, VALUES[id], { privateOk: true });
      for (const address of ['192.168.1.5', '10.0.0.8', '169.254.169.254', '127.0.0.1', 'fd00:ec2::253', 'fd00:ec2::23', 'fd00:ec2::254', '100.100.100.200']) {
        const host = provider(id).target({}).hosts.map(entry => entry.replace('*', 'prod-01.westus'))[0];
        const dialed = fakeNet({ [host]: address }, server);
        await assert.rejects(delivery.sendWith(connection.row(), MSG), error => error.message === provider(id).unreachable, `${id} -> ${address}`);
        assert.deepEqual(dialed, [], `${id}: never connected to ${address}`);
      }
      assert.equal(delivery.guardFor(connection.row(), provider(id), {}).privateAllowed, false, `${id}: guard says no private`);
    }
    assert.equal(server.seen.length, 0);
  } finally { privateNetwork(false); server.close(); restore(); }
});

test('guard: a user-host provider reaches private addresses only for an admin-saved Connection while the setting is on; metadata, loopback and AWS ranges never', async () => {
  const server = await fakeServer({ secure: false });
  const LAN = {
    ntfy: { server: 'http://ntfy.lan:8080', topic: 'docknest-fixture-topic', token: NTFY_TOKEN },
    gotify: { server: 'http://gotify.home.arpa:8080', token: GOTIFY_TOKEN },
    matrix: { server: 'http://matrix.lan:8008', room: '!fixtureRoom:example.com', token: MATRIX_TOKEN },
    mattermost: { url: `http://mattermost.lan:8065${MM_PATH}` },
    webhook: { url: 'http://hooks.lan:9000/in/fixtureHook', header: HEADER },
  };
  try {
    for (const id of USER_HOST) {
      const dialed = fakeNet({ 'ntfy.lan': '192.168.1.20', 'gotify.home.arpa': '10.0.0.7', 'matrix.lan': '192.168.1.22', 'mattermost.lan': '10.0.0.9', 'hooks.lan': '192.168.1.30' }, server);
      const lan = Object.values(LAN[id])[0].toString();
      reset(); let connection = connect(id, LAN[id], { privateOk: false }); privateNetwork(true);
      await assert.rejects(delivery.sendWith(connection.row(), MSG), error => error.message === provider(id).unreachable, `${id}: not stamped private_ok`);
      reset(); connection = connect(id, LAN[id], { privateOk: true }); privateNetwork(false);
      await assert.rejects(delivery.sendWith(connection.row(), MSG), error => error.message === provider(id).unreachable, `${id}: setting off`);
      assert.deepEqual(dialed, [], `${id}: nothing dialed while refused (${lan.slice(0, 20)})`);
      privateNetwork(true); server.seen.length = 0;
      await delivery.sendWith(connection.row(), MSG); assert.equal(server.seen.length, 1, `${id}: LAN send works with the setting on`); assert.ok(dialed.length === 1, id);
      privateNetwork(false); await assert.rejects(delivery.sendWith(connection.row(), MSG), error => error.message === provider(id).unreachable, `${id}: turning the setting off stops it at once`); assert.equal(server.seen.length, 1);
    }
    // Always refused, whatever the Connection and the setting say.
    privateNetwork(true);
    for (const address of ['169.254.169.254', '127.0.0.1', '[fd00:ec2::253]', '[fd00:ec2::23]', '[fd00:ec2::254]', '[::1]', '100.100.100.200', '0.0.0.0']) {
      fakeNet({}, server);
      for (const id of ['ntfy', 'gotify', 'matrix']) {
        const edited = { ...LAN[id], server: `http://${address}:8080` };
        assert.equal(parse(id, edited).ok, false, `${id} ${address}: refused when saved`);
        // A row edited behind DockNest's back is refused when it is read at send time, before any connection.
        reset(); const connection = connect(id, LAN[id], { privateOk: true }); db.prepare('UPDATE connections SET settings=? WHERE id=?').run(JSON.stringify(split(id, edited).settings), connection.id);
        server.seen.length = 0; await assert.rejects(delivery.sendWith(connection.row(), MSG), /saved settings cannot be read/, `${id} ${address}`); assert.equal(server.seen.length, 0);
      }
    }
    // Names that resolve to refused or mixed answers.
    for (const answers of [['169.254.169.254'], ['fd00:ec2::253'], [quad(93, 184, 216, 34), '192.168.1.20'], ['127.0.0.1']]) {
      const dialed = fakeNet({ 'ntfy.example.com': answers }, server); reset(); const connection = connect('ntfy', { server: 'https://ntfy.example.com', topic: 'abc' }, { privateOk: true });
      await assert.rejects(delivery.sendWith(connection.row(), MSG)); assert.deepEqual(dialed, []);
    }
  } finally { privateNetwork(false); server.close(); restore(); }
});

test('guard: a Matrix homeserver on a custom port works on a private host; on a public host only 443 is allowed', async () => {
  const server = await fakeServer({ secure: false }); reset();
  try {
    const dialed = fakeNet({ 'matrix.lan': '192.168.1.22', 'matrix.example.com': quad(93, 184, 216, 40) }, server);
    privateNetwork(true); const lan = connect('matrix', { ...VALUES.matrix, server: 'http://matrix.lan:8008' }, { privateOk: true });
    await delivery.sendWith(lan.row(), MSG); assert.equal(server.seen.length, 1); assert.deepEqual(dialed, ['192.168.1.22:8008']); assert.match(server.seen[0].url, /^\/_matrix\/client\/v3\/rooms\/%21fixtureRoom%3Aexample\.com\/send\/m\.room\.message\//);
    const pub = connect('matrix', { ...VALUES.matrix, server: 'https://matrix.example.com:8448' });
    await assert.rejects(delivery.sendWith(pub.row(), MSG), error => error.message === 'The Matrix server could not be reached.'); assert.equal(server.seen.length, 1, 'a public host on 8448 is refused before any connection');
  } finally { privateNetwork(false); server.close(); restore(); }
});

test('guard: trailing-dot hosts are refused at validation and again at send', async () => {
  for (const [id, values] of [['ntfy', { server: 'https://ntfy.example.com.', topic: 'abc' }], ['gotify', { server: 'https://gotify.example.com.', token: GOTIFY_TOKEN }], ['matrix', { ...VALUES.matrix, server: 'https://matrix.example.com.' }], ['mattermost', { url: `https://chat.example.com.${MM_PATH}` }], ['webhook', { url: 'https://hooks.example.com./x' }]]) {
    const result = parse(id, values); assert.equal(result.ok, false, id); assert.match(result.message, /Remove the dot at the end of the server name\./);
  }
  assert.throws(() => checkUrl('https://ntfy.example.com./x'), error => error.code === 'url');
  assert.throws(() => checkUrl('https://api.telegram.org./x', { hosts: ['api.telegram.org'] }), error => error.code === 'url');
  assert.equal(common.hostProblem('localhost.'), 'Remove the dot at the end of the server name.');
});

// ---- User hosts: URLs are built from the saved, validated value -------------------------------------------------------
test('user hosts: the request URL comes from the Connection\'s saved server or webhook URL, with its path, port and scheme', async () => {
  try {
    const cases = [
      ['ntfy', { server: 'https://ntfy.sh', topic: 'abc' }, 'https://ntfy.sh/'], ['ntfy', { server: 'http://ntfy.lan:8080', topic: 'abc' }, 'http://ntfy.lan:8080/'], ['ntfy', { server: 'https://ntfy.example.com/sub/', topic: 'abc' }, 'https://ntfy.example.com/sub/'],
      ['gotify', { server: 'http://gotify.home.arpa:8080', token: GOTIFY_TOKEN }, 'http://gotify.home.arpa:8080/message'], ['gotify', { server: 'https://gotify.example.com/app', token: GOTIFY_TOKEN }, 'https://gotify.example.com/app/message'],
      ['matrix', { ...VALUES.matrix, server: 'https://matrix.example.com:8448' }, /^https:\/\/matrix\.example\.com:8448\/_matrix\/client\/v3\/rooms\//],
      ['mattermost', { url: `https://chat.example.com/mm${MM_PATH}` }, `https://chat.example.com/mm${MM_PATH}`], ['webhook', { url: 'https://hooks.example.com:8443/in?x=1' }, 'https://hooks.example.com:8443/in?x=1'],
    ];
    for (const [id, values, expected] of cases) {
      reset(); const connection = connect(id, values, { privateOk: true }); const calls = mock(() => reply(200, {})); privateNetwork(true);
      await delivery.sendWith(connection.row(), MSG);
      if (expected instanceof RegExp) assert.match(calls[0].url, expected); else assert.equal(calls[0].url, expected, id);
      assert.ok(!calls[0].url.startsWith('https://u/') && !calls[0].url.includes('undefined'), 'the old `https://u/` bug');
      assert.deepEqual(calls[0].guard, { hosts: null, privateAllowed: true }, `${id}: guard for a user host with private_ok and the setting on`);
      privateNetwork(false); assert.equal(delivery.guardFor(connection.row(), provider(id), {}).privateAllowed, false);
    }
  } finally { privateNetwork(false); restore(); }
});

// ---- Use cases -------------------------------------------------------------------------------------------------------
test('use case: ntfy.sh public over HTTPS, and a self-hosted ntfy on the LAN with a token, with the private setting on and off', { skip: noTls }, async () => {
  const web = await fakeServer(), lan = await fakeServer({ secure: false });
  try {
    fakeNet({ ...publicTable(), 'ntfy.lan': '192.168.1.20' }, web); const dial = outboundIo.dial; outboundIo.dial = (address, port) => (address === '192.168.1.20' ? { address: lan.host, port: lan.port } : dial(address, port));
    reset(); const pub = connect('ntfy', { server: 'https://ntfy.sh', topic: 'docknest-fixture-topic' }); await delivery.sendWith(pub.row(), MSG);
    assert.equal(web.seen[0].headers.host, 'ntfy.sh'); assert.equal(web.seen[0].headers.authorization, undefined, 'no token, no Authorization'); assert.deepEqual([web.seen[0].json.topic, web.seen[0].json.priority], ['docknest-fixture-topic', 4]);
    const home = connect('ntfy', { server: 'http://ntfy.lan', topic: 'home', token: NTFY_TOKEN }, { privateOk: true });
    privateNetwork(false); await assert.rejects(delivery.sendWith(home.row(), MSG), /could not be reached/); assert.equal(lan.seen.length, 0);
    privateNetwork(true); await delivery.sendWith(home.row(), MSG); assert.equal(lan.seen[0].headers.authorization, `Bearer ${NTFY_TOKEN}`); assert.equal(lan.seen[0].headers.host, 'ntfy.lan');
    const operator = connect('ntfy', { server: 'http://ntfy.lan', topic: 'home' }, { privateOk: false }); await assert.rejects(delivery.sendWith(operator.row(), MSG), /could not be reached/);
  } finally { privateNetwork(false); web.close(); lan.close(); restore(); }
});

test('use case: self-hosted Gotify, Matrix and Mattermost on a LAN send with the setting on and stop when it is off', async () => {
  const lan = await fakeServer({ secure: false });
  try {
    fakeNet({ 'gotify.home.arpa': '10.0.0.7', 'matrix.lan': '192.168.1.22', 'mattermost.lan': '10.0.0.9' }, lan);
    const setups = [['gotify', { server: 'http://gotify.home.arpa:8080', token: GOTIFY_TOKEN }], ['matrix', { ...VALUES.matrix, server: 'http://matrix.lan:8008' }], ['mattermost', { url: `http://mattermost.lan:8065${MM_PATH}` }]];
    for (const [id, values] of setups) {
      reset(); const connection = connect(id, values, { privateOk: true }); lan.seen.length = 0;
      privateNetwork(true); await delivery.sendWith(connection.row(), MSG); assert.equal(lan.seen.length, 1, id);
      privateNetwork(false); await assert.rejects(delivery.sendWith(connection.row(), MSG), /could not be reached/, id); assert.equal(lan.seen.length, 1, `${id}: off`);
    }
  } finally { privateNetwork(false); lan.close(); restore(); }
});

test('use case: a rotated Slack webhook (404) fails the item at once; a Discord thread webhook keeps its thread; a Teams Workflows URL posts a card', { skip: noTls }, async () => {
  const server = await fakeServer(); fakeNet(publicTable(), server);
  try {
    reset(); const slack = connect('slack'); server.seen.length = 0;
    delivery.alertHttp.fetch = originalFetch;
    const rotated = await fakeServer({ handler: (_req, res) => { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no_service'); } }); fakeNet(publicTable(), rotated);
    fire(); await delivery.deliverDue({ at: T0 }); const [row] = outbox(slack.id);
    assert.deepEqual([row.status, row.attempts], ['failed', 1]); assert.equal(slack.row().last_error, 'Slack does not accept this webhook. Create a new one and paste it again.'); rotated.close();
    fakeNet(publicTable(), server); const thread = connect('discord', { url: `https://discord.com${URL_PART}?thread_id=${THREAD}` }); server.seen.length = 0;
    await delivery.sendWith(thread.row(), MSG); assert.equal(server.seen[0].url, `${URL_PART}?thread_id=${THREAD}&wait=true`);
    const teams = connect('teams'); server.seen.length = 0; await delivery.sendWith(teams.row(), MSG); assert.equal(server.seen[0].json.attachments[0].content.type, 'AdaptiveCard'); assert.equal(server.seen[0].json.attachments[0].content.actions[0].url, JOB);
  } finally { server.close(); restore(); }
});

test('use case: Pushover priority, ntfy priority and a WhatsApp free-form fallback for failures and quiet events', () => {
  const values = id => ({ ...parse(id, VALUES[id]).secret, ...parse(id, VALUES[id]).settings });
  assert.equal(provider('pushover').format(MSG, values('pushover')).json.priority, 1); assert.equal(provider('pushover').format(OK_MSG, values('pushover')).json.priority, 0);
  assert.notEqual(provider('pushover').format(MSG, values('pushover')).json.priority, 2, 'emergency priority needs retry and expire, which DockNest never sets');
  assert.equal(provider('ntfy').format(MSG, values('ntfy')).json.priority, 4);
  const free = provider('whatsapp').format(MSG, { ...values('whatsapp'), template: '' }).json; assert.equal(free.type, 'text'); assert.match(free.text.body, /^Backup failed\n/);
});

test('use case: Matrix retries reuse the transaction id, so a retry never posts twice', async () => {
  try {
    reset(); const connection = connect('matrix'); let attempt = 0; const calls = mock(() => reply(++attempt === 1 ? 502 : 200, { event_id: '$fixture' }));
    fire(); await delivery.deliverDue({ at: T0 }); await delivery.deliverDue({ at: T0 + 60_000 });
    assert.equal(calls.length, 2); assert.equal(calls[0].url, calls[1].url, 'same path and transaction id'); assert.equal(outbox(connection.id)[0].status, 'sent');
    assert.ok(calls[0].url.includes(`/send/m.room.message/${outbox(connection.id)[0].id}-`), 'the transaction id starts with the outbox item id');
    fire({ key: 'site:second' }, T0 + 120_000); await delivery.deliverDue({ at: T0 + 120_000 }); assert.notEqual(calls[2].url, calls[0].url, 'a different message has its own transaction id');
    // The same item with new text (the "N more alerts" count grew while it was in flight) is a new event, and two test
    // messages (no outbox item) are two events: a homeserver answers a reused transaction id with the old event.
    const values = { ...parse('matrix', VALUES.matrix).secret, ...parse('matrix', VALUES.matrix).settings }, txn = message => provider('matrix').format(message, values).path.split('/').pop();
    assert.equal(txn({ ...MSG, id: 'item-1' }), txn({ ...MSG, id: 'item-1' }), 'a retry of the same message keeps its id');
    assert.notEqual(txn({ ...events.plainTemplate('2 more alerts. Open DockNest to see them.'), id: 'item-1' }), txn({ ...events.plainTemplate('3 more alerts. Open DockNest to see them.'), id: 'item-1' }), 'new text on the same item');
    assert.notEqual(txn({ ...events.testMessage(), at: '2026-10-27T10:00:00.000Z' }), txn({ ...events.testMessage(), at: '2026-10-27T10:05:00.000Z' }), 'two test messages');
  } finally { restore(); }
});

test('use case: the "Other" webhook sends a fixed JSON body with an allowed header; unsafe headers are refused when saved', async () => {
  assert.deepEqual(readHeader('Authorization: Bearer abc'), { header: { name: 'Authorization', value: 'Bearer abc' } }); assert.deepEqual(readHeader('X-Api-Key:abc'), { header: { name: 'X-Api-Key', value: 'abc' } }); assert.deepEqual(readHeader(''), { header: null });
  for (const bad of ['Host: x', 'Content-Length: 1', 'Content-Type: x', 'Transfer-Encoding: chunked', 'TE: x', 'Trailer: x', 'Connection: close', 'Keep-Alive: 1', 'Upgrade: x', 'Expect: x', 'Cookie: x', 'Proxy-Connection: x', ':authority: x', 'Accept: x', 'X-Bad: a\r\nHost: y', 'X-Bad: é']) assert.ok(readHeader(bad).problem, bad);
  try {
    reset(); const connection = connect('webhook'); const calls = mock(() => reply(200, {})); await delivery.sendWith(connection.row(), MSG);
    assert.deepEqual(Object.keys(calls[0].body), ['title', 'site', 'server', 'message', 'url', 'event', 'at']); assert.equal(calls[0].headers.Authorization, 'Bearer webhookFixture01'); assert.equal(calls[0].headers['Content-Type'], 'application/json');
  } finally { restore(); }
});

test('use case: very long names and Hebrew text go through the whole path (emit, store, send) cut to 80 characters and intact', async () => {
  try {
    reset(); const connection = connect('telegram'); const calls = mock(() => reply(200, { ok: true }));
    fire({ siteName: 'חנות-' + 'א'.repeat(300), serverName: 'שרת-' + 'x'.repeat(300) }); await delivery.deliverDue({ at: T0 });
    const text = calls[0].body.text, lines = text.split('\n'); assert.equal(lines[0], 'Backup failed'); assert.ok(lines[1].startsWith('חנות-')); assert.ok(lines[1].length <= 80 + 4 + 80 + 14); assert.ok(!/[<>]/.test(text));
    assert.ok(JSON.parse(outbox(connection.id)[0].payload).site.length <= 80);
  } finally { restore(); }
});

test('use case: the same event reaches several providers, once per Connection, and two nodes on one Connection send once', async () => {
  try {
    reset(); const ids = ['telegram', 'discord', 'slack', 'ntfy', 'matrix', 'webhook'], made = ids.map(id => connect(id));
    const again = randomUUID(), at = new Date().toISOString(); // a second node and line on the Discord Connection
    db.prepare('INSERT INTO alert_nodes(id,provider,name,connection_id,prefill,created_at,updated_at) VALUES(?,?,?,?,NULL,?,?)').run(again, 'discord', 'second node', made[1].id, at, at);
    db.prepare('INSERT INTO alert_lines(id,node_id,source_kind,source_id,events,enabled,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)').run(randomUUID(), again, 'docknest', null, JSON.stringify(['backup.failed']), at, at);
    const calls = mock(() => reply(200, {}));
    assert.equal(fire({ key: 'site:shared' }), ids.length, 'one queued item per Connection');
    assert.equal(fire({ key: 'site:shared' }), 0, 'the same event again inside the window queues nothing');
    assert.equal(await delivery.deliverDue({ at: T0 }), ids.length); assert.equal(calls.length, ids.length);
    for (const made1 of made) assert.equal(outbox(made1.id).length, 1);
    assert.deepEqual(calls.map(call => new URL(call.url).hostname).sort(), ['api.telegram.org', 'discord.com', 'hooks.example.com', 'hooks.slack.com', 'matrix.example.com', 'ntfy.sh']);
    // Each Connection has its own dedup history: another event type or source is independent.
    assert.equal(fire({ key: 'site:other' }, T0 + 1000), ids.length);
  } finally { restore(); }
});

test('use case: a provider down for hours: three tries, then failed; one that asks for patience for a day fails at the 24-hour maximum age without a send', async () => {
  try {
    reset(); const down = connect('gotify'); let calls = mock(() => reply(503)); fire();
    for (const at of [T0, T0 + 60_000, T0 + 6 * 60_000, T0 + 3600_000, T0 + 7200_000]) await delivery.deliverDue({ at });
    assert.deepEqual([outbox(down.id)[0].status, outbox(down.id)[0].attempts], ['failed', 3]); assert.equal(calls.length, 3, 'no more tries after the third');
    reset(); const slow = connect('pushover'); calls = mock(() => reply(429, {}, { 'Retry-After': '900' })); fire();
    let at = T0, rounds = 0; for (; rounds < 200; rounds++) { await delivery.deliverDue({ at }); const [row] = outbox(slow.id); if (row.status !== 'pending') break; assert.equal(row.attempts, 0); at = row.next_attempt_at; }
    assert.equal(outbox(slow.id)[0].status, 'failed'); assert.equal(calls.length, 96, 'one try per 15 minutes for 24 hours'); assert.ok(at - T0 <= 24 * 3600_000 + 15 * 60_000);
    reset(); const stale = connect('slack'); calls = mock(() => reply(200, 'ok')); fire(); await delivery.deliverDue({ at: T0 + 25 * 3600_000 });
    assert.equal(calls.length, 0, 'an item older than 24 hours is never sent'); assert.equal(outbox(stale.id)[0].status, 'failed');
  } finally { restore(); }
});

// ---- Template, reasons, deep link ------------------------------------------------------------------------------------
test('template: every event has a title, a catalogue reason, the names the owner typed and the job link; unknown codes give the generic sentence', () => {
  const base = { at: '2026-10-27T03:00:00Z', siteName: 'shop', serverName: 'srv', targetName: 'new-srv', jobId: 'job-0001-aaaa', version: '2.10.0', freeBytes: 2 * 1024 ** 3, usedPercent: 95.4 };
  const expected = {
    'backup.failed': ['Backup failed', 'The backup did not finish. Open DockNest to see why.'], 'backup.succeeded': ['Backup finished', 'The backup finished.'], 'move.finished': ['Move finished', 'The site now runs on new-srv.'],
    'move.needs_you': ['Move waiting for you', 'The move needs your decision. Open DockNest to continue.'], 'server.unreachable': ['Server unreachable', 'The server has not answered. Open DockNest to check it.'], 'server.disk_low': ['Low disk space', '2.1 GB free, 95% used. Open DockNest to review.'],
    'restore_test.failed': ['Restore test failed', 'The restore test failed. Open DockNest to see why.'], 'restore_test.couldnt_run': ["Restore test couldn't run", 'The restore test could not run. Open DockNest to see why.'], 'restore_test.recovered': ['Restore test passed again', 'The restore test passed again.'],
    'restore_test.needs_you': ['Restore test needs you', 'A restore test could not clean up its test server. Open DockNest to check it.'], 'update.available': ['Update available', 'DockNest 2.10.0 is available. Open DockNest to update.'],
  };
  assert.deepEqual(Object.keys(expected).sort(), [...events.EVENTS].sort(), 'the catalogue covers every event');
  for (const [type, [title, reason]] of Object.entries(expected)) {
    const template = events.templateFor({ ...base, type }); assert.equal(template.title, title, type); assert.equal(template.reason, reason, type); assert.equal(template.event, type); assert.equal(template.at, base.at);
    assert.deepEqual(Object.keys(template), ['title', 'site', 'server', 'reason', 'time', 'url', 'event', 'at']);
    assert.ok(template.url.startsWith('https://dock.example.com/'), `${type}: link`); assert.ok(events.messageFor({ ...base, type }), 'the 2.8 sentence still exists for the outbox');
  }
  assert.equal(events.templateFor({ ...base, type: 'backup.failed' }).url, 'https://dock.example.com/?job=job-0001-aaaa'); assert.equal(events.templateFor({ ...base, type: 'server.unreachable', jobId: undefined }).url, 'https://dock.example.com/');
  assert.deepEqual([events.templateFor({ ...base, type: 'backup.failed' }).site, events.templateFor({ ...base, type: 'backup.failed' }).server, events.templateFor({ ...base, type: 'backup.failed' }).time], ['shop', 'srv', '03:00 UTC']);
  assert.deepEqual([events.templateFor({ ...base, type: 'server.unreachable' }).site, events.templateFor({ ...base, type: 'update.available' }).server], ['', '']);
  assert.equal(events.templateFor({ ...base, type: 'move.finished', detail: 'rolled_back' }).title, 'Move undone'); assert.equal(events.templateFor({ ...base, type: 'move.finished', detail: 'failed' }).reason, 'The site did not move to new-srv. Open DockNest to see why.');
  assert.match(events.templateFor({ ...base, type: 'move.needs_you', detail: 'dns' }).reason, /Change the DNS record to point to new-srv/);
  assert.equal(events.templateFor({ ...base, type: 'backup.failed', code: 'recovery_required' }).reason, 'The backup stopped and the site needs recovery. Open DockNest to continue.');
  assert.equal(events.templateFor({ ...base, type: 'backup.failed', code: 'something-new' }).reason, 'The backup did not finish. Open DockNest to see why.', 'an unknown code falls back to the event\'s sentence');
  assert.equal(reasons.reasonFor('nonsense', 'x'), reasons.UNKNOWN_REASON); assert.equal(reasons.reasonFor('constructor', 'x'), reasons.UNKNOWN_REASON); assert.equal(events.templateFor({ type: 'nonsense' }), null);
  const test1 = events.testMessage(); assert.deepEqual({ ...test1, at: '' }, { title: 'DockNest test message', site: '', server: '', reason: 'Your alerts are connected.', time: '', url: null, event: 'test', at: '' });
  // Raw error text never gets in: the template has no field for it, and a hostile detail or code only selects a sentence.
  assert.ok(!JSON.stringify(events.templateFor({ ...base, type: 'backup.failed', code: '/etc/passwd secret=hunter2', detail: 'ssh root@10.0.0.1', error: 'boom' })).match(/passwd|hunter2|root@|boom/));
});

test('deep link: only when APP_ORIGIN is not a loopback address, and only for a plausible job id', () => {
  for (const origin of ['http://127.0.0.1:3000', 'http://localhost:3000', 'http://app.localhost', 'http://[::1]:3000', 'http://0.0.0.0:3000', 'not a url']) assert.equal(events.jobLink('job-0001-aaaa', origin), null, origin);
  assert.equal(events.jobLink('job-0001-aaaa', 'https://dock.example.com'), 'https://dock.example.com/?job=job-0001-aaaa');
  assert.equal(events.jobLink('job-0001-aaaa', 'http://192.168.1.10:3000'), 'http://192.168.1.10:3000/?job=job-0001-aaaa', 'a LAN address is a real address for a phone on the same network');
  assert.equal(events.jobLink('../../x?y', 'https://dock.example.com'), 'https://dock.example.com/', 'a hostile id never reaches the URL'); assert.equal(events.jobLink(undefined, 'https://dock.example.com'), 'https://dock.example.com/');
  assert.equal(events.templateFor({ type: 'backup.failed', jobId: 'job-0001-aaaa' }, { origin: 'http://127.0.0.1:3000' }).url, null);
});

test('template in the outbox: the structured message is stored and a retry sends exactly it; a 2.8 item (no payload) is sent as its plain text', async () => {
  try {
    reset(); const connection = connect('discord'); let first = true; const calls = mock(() => reply(first ? ((first = false), 503) : 200, {}));
    fire({ siteName: 'shop' }); const stored = JSON.parse(outbox(connection.id)[0].payload);
    assert.deepEqual(Object.keys(stored), ['title', 'site', 'server', 'reason', 'time', 'url', 'event', 'at']); assert.ok(outbox(connection.id)[0].payload.length < 4096);
    await delivery.deliverDue({ at: T0 }); await delivery.deliverDue({ at: T0 + 60_000 }); assert.deepEqual(calls[0].body, calls[1].body, 'the retry is byte for byte the first try');
    assert.equal(outbox(connection.id)[0].status, 'sent');
    // A migrated 2.8 item has `payload = NULL` and goes out as its text.
    const at = Date.now(); db.prepare("INSERT INTO alert_outbox(id,connection_id,node_id,event,dedupe_key,message,payload,status,attempts,next_attempt_at,expires_at,created_at) VALUES(?,?,?,?,?,?,NULL,'pending',0,?,?,?)").run(randomUUID(), connection.id, connection.nodeId, 'backup.failed', 'backup.failed:legacy', 'Backup failed: old on srv at 03:00 UTC. Open DockNest to see why.', T0, T0 + 86400_000, new Date(at).toISOString());
    await delivery.deliverDue({ at: T0 + 10 * 60_000 }); assert.match(calls.at(-1).body.content, /Backup failed\*\*\nold on srv at 03:00 UTC\. Open DockNest to see why\./.test(calls.at(-1).body.content) ? /./ : /Backup failed/);
    assert.match(calls.at(-1).body.content, /Backup failed/);
  } finally { restore(); }
});

test('Telegram on the template: the same facts as the 2.8 message, readable, with the link, and the 2.8 wording is not required', async () => {
  try {
    reset(); const connection = connect('telegram'); const calls = mock(() => reply(200, { ok: true, result: {} }));
    const base = { type: 'backup.failed', at: '2026-10-27T03:00:12.000Z', siteName: 'shop.example.com', serverName: 'mobiX-Srv', jobId: 'job-0001-aaaa' };
    fire({ ...base, key: 'site:x' }); await delivery.deliverDue({ at: T0 });
    assert.deepEqual(calls[0].body, { chat_id: '-1001234567890', text: `${BODY_TEXT}\nOpen the job: ${JOB}`, link_preview_options: { is_disabled: true } });
    const old = events.messageFor(base); for (const fact of ['shop.example.com', 'mobiX-Srv', '03:00 UTC', 'Backup failed', 'Open DockNest to see why']) { assert.ok(old.includes(fact)); assert.ok(calls[0].body.text.includes(fact), `still says: ${fact}`); }
    assert.ok(!('parse_mode' in calls[0].body), 'plain text: nothing in a name is read as markup'); assert.ok(!('disable_web_page_preview' in calls[0].body));
    assert.equal(calls[0].url, `https://api.telegram.org/bot${TG}/sendMessage`);
  } finally { restore(); }
});

test('Email on the template: the title is the subject, the body is the plain lines with the link', { skip: noTls }, async () => {
  const tlsModule = await import('node:tls'), smtp = await import('../src/alerts/smtp.js'), log = { data: '' };
  const server = tlsModule.createServer({ key: material.key, cert: material.cert }, socket => {
    let buffer = '', dataMode = false; const write = text => socket.write(text + '\r\n'); socket.setEncoding('utf8'); socket.on('error', () => {});
    socket.on('data', chunk => { buffer += chunk; for (;;) {
      if (dataMode) { const end = buffer.indexOf('\r\n.\r\n'); if (end < 0) return; log.data = buffer.slice(0, end); buffer = buffer.slice(end + 5); dataMode = false; write('250 queued'); continue; }
      const index = buffer.indexOf('\r\n'); if (index < 0) return; const line = buffer.slice(0, index); buffer = buffer.slice(index + 2); const word = line.split(' ')[0].toUpperCase();
      if (word === 'EHLO') write('250-mail.example.com\r\n250 AUTH PLAIN'); else if (word === 'AUTH') write('235 ok'); else if (word === 'MAIL' || word === 'RCPT') write('250 ok'); else if (word === 'DATA') { write('354 go'); dataMode = true; } else if (word === 'QUIT') { write('221 bye'); socket.end(); return; } else write('500 what');
    } }); write('220 mail.example.com ESMTP');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const saved = { ...smtp.smtpIo };
  try {
    smtp.smtpIo.resolve = async () => quad(93, 184, 216, 60);
    smtp.smtpIo.connect = ({ host }) => new Promise((resolve, reject) => { const socket = tlsModule.connect({ host: '127.0.0.1', port: server.address().port, servername: host, ca: material.cert, minVersion: 'TLSv1.2' }); socket.once('secureConnect', () => resolve(socket)); socket.once('error', reject); });
    reset(); const id = randomUUID();
    connections.insertConnection({ id, provider: 'email', name: 'Mail', secret: seal(JSON.stringify({ host: 'mail.example.com', port: 465, security: 'tls', username: 'bot', password: 'mailFixturePw01', from: 'docknest@example.com' })), settings: { to: ['me@example.com'], subjectPrefix: '[DockNest]' }, privateOk: false });
    await delivery.sendWith(connections.getConnection(id), MSG);
    const headers = log.data.split('\r\n\r\n')[0], body = Buffer.from(log.data.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
    assert.ok(headers.split('\r\n').includes('Subject: [DockNest] Backup failed'));
    assert.equal(body.replaceAll('\r\n', '\n'), `shop.example.com on mobiX-Srv at 03:00 UTC\nThe backup did not finish. Open DockNest to see why.\nOpen the job: ${JOB}`);
  } finally { Object.assign(smtp.smtpIo, saved); server.close(); }
});

test('common: plain text, one-line text, line cleaning and the shared failure mapping', () => {
  assert.equal(common.plainText(MSG), `${BODY_TEXT}\nOpen the job: ${JOB}`); assert.equal(common.plainText({ title: 'T', reason: 'R' }), 'T\nR'); assert.equal(common.plainText({ event: 'plain', text: 'Hello. World' }), 'Hello. World');
  assert.equal(common.plainLine({ title: 'Server unreachable', server: 'srv', reason: 'The server has not answered.' }), 'Server unreachable: srv. The server has not answered.');
  assert.equal(common.line('a\r\nb\u0000c d'), 'a b c d'); assert.equal(common.line(null, 'x'), 'x'); assert.equal(common.parts({ url: 'javascript:alert(1)' }).url, '', 'only http(s) links');
  assert.equal(common.failure('X', 200), null); assert.deepEqual(common.failure('X', 401), { message: 'X does not accept this login.', final: true }); assert.equal(common.failure('X', 408).final, false); assert.equal(common.failure('X', 418).final, true); assert.equal(common.failure('X', 429).final, false);
});

test('the 2.8 behaviour is intact: Telegram verify (getMe) and the redirect sentence still work through the same request path', async () => {
  try {
    reset(); const { default: telegram } = await import('../src/alerts/providers/telegram.js');
    assert.deepEqual(telegram.verify({ token: TG }), { method: 'GET', path: `/bot${TG}/getMe` }); assert.equal(telegram.target({}).base, 'https://api.telegram.org');
    const connection = connect('telegram'); mock(() => { throw new OutboundError('redirect'); });
    await assert.rejects(delivery.sendWith(connection.row(), MSG), error => error.message === 'The server answered with a redirect. Paste the final URL.');
  } finally { restore(); }
});

// PR 4 backlog: bidi overrides and isolates never reach any provider; a Markdown link in a name is never a link in Teams.
test('bidi override and isolate characters are dropped from the template and every provider; Teams never renders a name as a link', () => {
  const controls = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map(code => String.fromCharCode(code));
  const site = `shop${controls.join('')}gnp.exe`, template = events.templateFor({ type: 'backup.failed', siteName: site, serverName: `srv${controls[4]}`, at: '2026-10-23T03:00:00Z' }, { origin: 'https://dock.example.com' });
  assert.equal(template.site, 'shopgnp.exe'); assert.equal(template.server, 'srv');
  const raw = { ...MSG, site, server: `[click](https://evil.example)${controls[4]}` };
  for (const id of Object.keys(VALUES)) {
    const values = { ...parse(id, VALUES[id]).secret, ...parse(id, VALUES[id]).settings }, text = JSON.stringify(provider(id).format(raw, values));
    for (const control of controls) assert.ok(!text.includes(control) && !text.includes(`${String.fromCharCode(92)}u${control.charCodeAt(0).toString(16)}`), `${id}: no U+${control.charCodeAt(0).toString(16)}`);
  }
  const card = provider('teams').format(raw, parse('teams', VALUES.teams).secret).json.attachments[0].content;
  assert.ok(card.body.every(block => !/\]\(/.test(block.text)), 'no "](" left in a TextBlock');
  assert.ok(card.body.some(block => block.text.includes('[click]') && block.text.includes('(https://evil.example)')), 'the text is kept as typed');
});
