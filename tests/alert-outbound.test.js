// The guarded outbound client and what rides on it (docs/alert-channels.md, "Outbound safety", "Delivery, dedup, rate
// limits and failures", "Test plan" SSRF and Delivery). Every request goes to local fake servers: a fake resolver answers
// names, and the `dial` seam points a checked public-looking address at 127.0.0.1, so nothing reaches the internet.
// Fake tokens and passwords only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFileSync, execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'docknest-alert-outbound-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { db } = await import('../src/db.js');
const outbound = await import('../src/alerts/outbound.js');
const { classify, nameRefused } = await import('../src/alerts/addresses.js');
const connections = await import('../src/alerts/connections.js');
const delivery = await import('../src/alerts/delivery.js');
const store = await import('../src/alerts/store.js');
const smtp = await import('../src/alerts/smtp.js');
const { outboundRequest, OutboundError, checkUrl, outboundIo, outboundLimits, parseRetryAfter, retryAfterMs, pinnedLookup } = outbound;
const originalFetch = delivery.alertHttp.fetch, originalIo = { ...outboundIo };
const TOKEN = '123456789:' + 'AbCdEf_-12'.repeat(4).slice(0, 35), GOTIFY_KEY = 'fixture-gotify-key-not-real';

// ---- Fixtures ----------------------------------------------------------------------------------------------------------
const certDir = await mkdtemp(join(tmpdir(), 'docknest-outbound-tls-'));
let material = null;
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, 'k.pem'), '-out', join(certDir, 'c.pem'), '-days', '2', '-subj', '/CN=hook.test', '-addext', 'subjectAltName=DNS:hook.test,DNS:api.telegram.org,DNS:rebind.test,DNS:v6only.test,DNS:dual.test,DNS:slow.test,DNS:silent.test,IP:127.0.0.1,IP:::1'], { stdio: 'ignore' });
  material = { key: await readFile(join(certDir, 'k.pem')), cert: await readFile(join(certDir, 'c.pem')) };
} catch { /* openssl missing: the HTTPS tests are skipped */ }
const noTls = material ? false : 'openssl is not available';

// A fake server that records each request and answers with `handler(req, res, body)` (default 200 {"ok":true}).
async function fakeServer({ secure = true, host = '127.0.0.1', handler } = {}) {
  const seen = [], sockets = new Set();
  const onRequest = (req, res) => { const parts = []; req.on('data', chunk => parts.push(chunk)); req.on('end', () => { const body = Buffer.concat(parts).toString('utf8'); seen.push({ method: req.method, url: req.url, headers: req.headers, body, servername: req.socket.servername ?? null }); if (handler) return handler(req, res, body); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true,"result":{}}'); }); };
  const server = secure ? https.createServer({ key: material.key, cert: material.cert }, onRequest) : http.createServer(onRequest);
  let connections = 0; server.on('connection', socket => { connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  return { port: server.address().port, host, seen, get connections() { return connections; }, close: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
}
// A fake resolver: name -> list of addresses (or a function of the call number). Records every lookup.
function fakeDns(table) {
  const calls = [];
  outboundIo.resolve = async host => {
    calls.push(host); const entry = table[host]; if (entry === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    const list = typeof entry === 'function' ? await entry(calls.filter(name => name === host).length) : entry;
    return list.map(address => ({ address, family: net.isIP(address) }));
  };
  return calls;
}
// Points checked addresses at local servers: address -> server. Records what the socket was told to connect to.
function fakeDial(map) {
  const dialed = [];
  outboundIo.dial = (address, port) => { dialed.push(`${address}:${port}`); const server = map[address]; return server ? { address: server.host, port: server.port } : { address, port }; };
  return dialed;
}
const restoreIo = () => { Object.assign(outboundIo, originalIo); outboundLimits.totalMs = 10_000; delivery.alertHttp.fetch = originalFetch; };
const refusedWith = code => error => error instanceof OutboundError && error.code === code;
// Public addresses are built at runtime, as in tests/audit-repository.test.js, so this file names none. They are only
// ever handed to the fake resolver and dialed to local fake servers.
const quad = (...parts) => parts.join('.');
const PUBLIC = quad(93, 184, 215, 14), SLOW = quad(93, 184, 215, 15), SILENT = quad(93, 184, 215, 16), TELEGRAM_IP = quad(149, 154, 167, 220), PUBLIC6 = '2606:4700::1111';

// ---- Address policy, no network -------------------------------------------------------------------------------------
const quadHex = quad => { const [a, b, c, d] = quad.split('.').map(Number); return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)]; };
// Every IPv6 form that carries an IPv4: mapped (dotted and hex), translated, NAT64 and 6to4.
const ipv6Forms = quad => { const [high, low] = quadHex(quad); return [`::ffff:${quad}`, `::ffff:${high}:${low}`, `0:0:0:0:0:ffff:${high}:${low}`, `::ffff:0:${high}:${low}`, `64:ff9b::${high}:${low}`, `64:ff9b::${quad}`, `2002:${high}:${low}::1`]; };
const ALWAYS_REFUSED_V4 = ['0.0.0.0', '0.1.2.3', '127.0.0.1', '127.255.255.254', '169.254.169.254', '169.254.0.1', '192.0.0.1', '192.0.0.192', '192.0.2.5', '198.51.100.7', '203.0.113.9', '198.18.0.1', '198.19.255.1', '192.88.99.1', '100.100.100.200', '100.100.100.100', '168.63.129.16', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255'];
const ALWAYS_REFUSED_V6 = ['::', '::1', '0:0:0:0:0:0:0:1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1', 'ff05::1:3', 'fd00:ec2::254', '2001:db8::1', '3fff::1', '2001::1', '2001:2::1', '2001:10::1', '2001:20::1', '100::1', '64:ff9b:1::a00:1', '::a00:1', '::127.0.0.1', '5f00::1', '4000::1'];
const PRIVATE = ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.20', '100.64.0.1', '100.127.255.254', 'fc00::1', 'fd12:3456::1'];
const PUBLICS = ['1.1.1.1', TELEGRAM_IP, quad(172, 15, 255, 255), quad(172, 32, 0, 1), quad(100, 63, 255, 255), quad(100, 128, 0, 1), quad(192, 0, 1, 1), quad(198, 20, 0, 1), PUBLIC6, '2001:67c:4e8::1', '2a00:1450:4001::1'];

test('every always-refused range is refused as IPv4 and in every IPv6 form, and stays refused with private allowed', () => {
  for (const address of ALWAYS_REFUSED_V4) {
    assert.equal(classify(address), 'refused', address);
    for (const form of ipv6Forms(address)) assert.equal(classify(form), 'refused', `${form} (${address})`);
  }
  for (const address of ALWAYS_REFUSED_V6) assert.equal(classify(address), 'refused', address);
  for (const address of [...ALWAYS_REFUSED_V4, ...ALWAYS_REFUSED_V6]) {
    const host = net.isIP(address) === 6 ? `[${address}]` : address;
    assert.throws(() => checkUrl(`https://${host}/`, { privateAllowed: true }), refusedWith('blocked'), address);
  }
});

test('private ranges are private in every form; public addresses are public; zone ids and non-literals are refused', () => {
  for (const address of PRIVATE) assert.equal(classify(address), 'private', address);
  for (const form of [...ipv6Forms('192.168.1.20'), ...ipv6Forms('10.1.2.3'), ...ipv6Forms('100.64.0.9')]) assert.equal(classify(form), 'private', form);
  for (const address of PUBLICS) assert.equal(classify(address), 'public', address);
  for (const form of ipv6Forms('1.1.1.1')) assert.equal(classify(form), 'public', form);
  for (const value of ['fe80::1%eth0', 'fd12::1%2', '2606:4700::1111%eth0', 'example.com', '', '1.2.3', '256.1.1.1', null]) assert.equal(classify(value), 'refused', String(value));
  assert.throws(() => checkUrl('https://[fe80::1%25eth0]/'), refusedWith('url'));
  assert.throws(() => checkUrl('https://[2606:4700::1111%25eth0]/'), refusedWith('url'));
});

test('IP literals in decimal, octal, hex and short notation are canonicalised and checked before any connection', () => {
  const metadata = ['https://2852039166/', 'https://0xa9fea9fe/', 'https://0251.0376.0251.0376/', 'https://0xa9.0xfe.0xa9.0xfe/', 'https://169.16689662/', 'https://[::ffff:169.254.169.254]/', 'https://[::ffff:a9fe:a9fe]/', 'https://[64:ff9b::a9fe:a9fe]/', 'https://[2002:a9fe:a9fe::]/'];
  const loopback = ['https://2130706433/', 'https://0x7f000001/', 'https://017700000001/', 'https://0177.0.0.1/', 'https://0x7f.0.0.1/', 'https://127.1/', 'https://127.0.1/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/', 'https://[0:0:0:0:0:ffff:7f00:1]/', 'https://[::1]/', 'https://0/'];
  for (const url of [...metadata, ...loopback]) assert.throws(() => checkUrl(url, { privateAllowed: true }), refusedWith('blocked'), url);
  // 192.168.1.20 written four ways: refused without permission, accepted with it.
  for (const url of ['https://3232235796/', 'https://0xc0a80114/', 'https://0300.0250.01.024/', 'https://192.168.276/']) {
    assert.throws(() => checkUrl(url), refusedWith('blocked'), url);
    assert.equal(checkUrl(url, { privateAllowed: true }).hostname, '192.168.1.20', url);
  }
  assert.equal(checkUrl('https://16843009/').hostname, '1.1.1.1', 'a public literal in decimal is fine');
  for (const url of ['https://1.2.3.4.5/', 'https://0x1g.1.1.1/', 'https://4294967296/']) assert.throws(() => checkUrl(url), refusedWith('url'), url);
});

test('URL rules: refused names, login details, fragments, length, schemes, ports and fixed hosts', () => {
  for (const name of ['localhost', 'LOCALHOST', 'localhost.', 'api.localhost', 'a.b.localhost', 'metadata', 'metadata.google.internal', 'Metadata.Google.Internal.', 'instance-data', 'instance-data.ec2.internal']) {
    assert.equal(nameRefused(name), true, name);
    assert.throws(() => checkUrl(`https://${name}/`, { privateAllowed: true }), refusedWith('blocked'), name);
  }
  assert.equal(nameRefused('localhost.example.com'), false);
  for (const url of ['https://user:pass@hook.test/', 'https://user@hook.test/', 'https://hook.test/#x', 'https://hook.test/' + 'a'.repeat(2048), 'ftp://hook.test/', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url']) assert.throws(() => checkUrl(url), refusedWith('url'), url.slice(0, 40));
  assert.throws(() => checkUrl('http://hook.test/'), refusedWith('blocked'), 'plain HTTP needs private permission');
  assert.throws(() => checkUrl('https://hook.test:8443/'), refusedWith('blocked'), 'another port needs private permission');
  assert.equal(checkUrl('https://hook.test:443/').port, '', 'the default port written out is fine');
  assert.ok(checkUrl('http://ntfy.lan:8080/x', { privateAllowed: true }));
  const telegram = { hosts: ['api.telegram.org'] };
  assert.ok(checkUrl(`https://api.telegram.org/bot${TOKEN}/sendMessage`, telegram));
  assert.ok(checkUrl('https://API.Telegram.org/x', telegram), 'host names compare without case');
  for (const url of ['https://api.telegram.org.evil.test/', 'https://evil.test/api.telegram.org', 'https://api.telegram.org./', 'https://telegram.org/', 'https://api-telegram.org/']) assert.throws(() => checkUrl(url, telegram), refusedWith('blocked'), url);
});

test('the pinned lookup answers only the checked addresses, honours all: true and family, and nothing else', async () => {
  const lookup = pinnedLookup('hook.test', [{ address: PUBLIC, family: 4 }, { address: PUBLIC6, family: 6 }]);
  const ask = (host, options) => new Promise(resolve => lookup(host, options, (error, address, family) => resolve({ error, address, family })));
  assert.deepEqual((await ask('hook.test', { all: true })).address, [{ address: PUBLIC, family: 4 }, { address: PUBLIC6, family: 6 }]);
  assert.deepEqual(await ask('hook.test', { family: 6 }), { error: null, address: PUBLIC6, family: 6 });
  assert.deepEqual(await ask('hook.test', 4), { error: null, address: PUBLIC, family: 4 });
  assert.equal((await ask('other.test', { all: true })).error.code, 'ENOTFOUND', 'another name gets nothing');
  assert.equal((await ask('hook.test', { family: 6, all: true })).address.length, 1);
});

test('Retry-After: seconds and HTTP dates, clamped to 1 second .. 15 minutes; Telegram and Discord bodies', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  assert.equal(parseRetryAfter('120', now), 120_000);
  assert.equal(parseRetryAfter(' 5 ', now), 5_000);
  assert.equal(parseRetryAfter('0', now), 1_000, 'never zero');
  assert.equal(parseRetryAfter('99999', now), 15 * 60_000, 'capped at 15 minutes');
  assert.equal(parseRetryAfter('Tue, 27 Oct 2026 12:05:00 GMT', now), 300_000, 'IMF-fixdate');
  assert.equal(parseRetryAfter('Tuesday, 27-Oct-26 12:02:00 GMT', now), 120_000, 'RFC 850 date');
  assert.equal(parseRetryAfter('Tue Oct 27 12:01:00 2026', now), 60_000, 'asctime date');
  assert.equal(parseRetryAfter('Tue, 27 Oct 2026 11:00:00 GMT', now), 1_000, 'a date in the past waits the minimum');
  assert.equal(parseRetryAfter('Fri, 27 Oct 2034 12:00:00 GMT', now), 15 * 60_000, 'a far date is capped');
  for (const value of [null, undefined, '', '-5', '1.5', 'soon', '12abc', '2026-10-27', '1e3']) assert.equal(parseRetryAfter(value, now), null, String(value));
  const headers = value => ({ headers: { get: name => (name === 'retry-after' ? value : null) } });
  assert.equal(retryAfterMs(headers('30'), {}, now), 30_000);
  assert.equal(retryAfterMs(headers(null), { ok: false, error_code: 429, parameters: { retry_after: 17 } }, now), 17_000, 'Telegram body');
  assert.equal(retryAfterMs(headers(null), { message: 'You are being rate limited.', retry_after: 1.5, global: false }, now), 1_500, 'Discord body');
  assert.equal(retryAfterMs(headers('60'), { retry_after: 1 }, now), 60_000, 'the header wins');
  assert.equal(retryAfterMs(headers('junk'), { retry_after: 'x' }, now), null);
  assert.equal(retryAfterMs(headers(null), { retry_after: 86400 }, now), 15 * 60_000);
});

// ---- Real connections to local fake servers ------------------------------------------------------------------------
test('a public host: one DNS answer, pinned to the socket, TLS name kept, exact request sent', { skip: noTls }, async () => {
  const server = await fakeServer();
  try {
    outboundIo.ca = material.cert; const lookups = fakeDns({ 'hook.test': [PUBLIC] }), dialed = fakeDial({ [PUBLIC]: server });
    const response = await outboundRequest('https://hook.test/path?x=1', { method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'evil.test', 'Content-Length': '1' }, body: '{"a":1}' });
    assert.equal(response.status, 200); assert.deepEqual(JSON.parse(await response.text()), { ok: true, result: {} });
    assert.deepEqual(lookups, ['hook.test'], 'resolved once'); assert.deepEqual(dialed, [`${PUBLIC}:443`]);
    assert.equal(server.seen.length, 1);
    const [seen] = server.seen;
    assert.equal(seen.method, 'POST'); assert.equal(seen.url, '/path?x=1'); assert.equal(seen.body, '{"a":1}');
    assert.equal(seen.headers.host, 'hook.test', 'the caller cannot set Host'); assert.equal(seen.headers['content-length'], '7');
    assert.equal(seen.servername, 'hook.test', 'SNI and certificate check use the host name');
  } finally { server.close(); restoreIo(); }
});

test('DNS rebinding across requests: each request checks its own answer; a flip to loopback or private is refused', { skip: noTls }, async () => {
  const server = await fakeServer(), internal = await fakeServer();
  try {
    outboundIo.ca = material.cert;
    // Public for the first request, loopback for the next: the second request is refused before it connects.
    const lookups = fakeDns({ 'rebind.test': call => (call === 1 ? [PUBLIC] : ['127.0.0.1']) }), dialed = fakeDial({ [PUBLIC]: server, '127.0.0.1': internal });
    assert.equal((await outboundRequest('https://rebind.test/')).status, 200);
    await assert.rejects(outboundRequest('https://rebind.test/'), refusedWith('blocked'));
    assert.deepEqual(lookups, ['rebind.test', 'rebind.test']); assert.deepEqual(dialed, [`${PUBLIC}:443`]);
    assert.equal(internal.connections, 0, 'the internal server was never reached');
    // Private at the check, public afterwards: refused, and nothing is dialed.
    const second = fakeDns({ 'rebind.test': call => (call === 1 ? ['10.0.0.5'] : [PUBLIC]) }), none = fakeDial({ [PUBLIC]: server, '10.0.0.5': internal });
    await assert.rejects(outboundRequest('https://rebind.test/'), refusedWith('blocked'));
    assert.deepEqual(second, ['rebind.test']); assert.deepEqual(none, []); assert.equal(internal.connections, 0);
  } finally { server.close(); internal.close(); restoreIo(); }
});

test('rebinding inside one request: Node never makes its own lookup; the socket connects to the checked address only', { skip: noTls }, async () => {
  const server = await fakeServer(), internal = await fakeServer();
  try {
    outboundIo.ca = material.cert;
    let answers = 0;
    outboundIo.resolve = async () => { answers++; return answers === 1 ? [{ address: PUBLIC, family: 4 }] : [{ address: '127.0.0.1', family: 4 }]; };
    const dialed = fakeDial({ [PUBLIC]: server, '127.0.0.1': internal });
    assert.equal((await outboundRequest('https://rebind.test/one')).status, 200);
    assert.equal(answers, 1, 'one answer for check and connect'); assert.deepEqual(dialed, [`${PUBLIC}:443`]);
    assert.equal(server.seen.length, 1); assert.equal(internal.connections, 0);
  } finally { server.close(); internal.close(); restoreIo(); }
});

test('names that resolve to private, loopback or metadata addresses, or to a mix, are refused before connecting', async () => {
  const lookups = fakeDns({
    'meta.test': ['169.254.169.254'], 'meta6.test': ['fd00:ec2::254'], 'mapped.test': ['::ffff:169.254.169.254'], 'loop.test': ['127.0.0.1'], 'loop6.test': ['::1'],
    'lan.test': ['192.168.1.20'], 'ula.test': ['fd12::5'], 'cgnat.test': ['100.64.1.1'], 'tailscale-dns.test': ['100.100.100.100'], 'nat64.test': ['64:ff9b::a9fe:a9fe'],
    'dual.test': [PUBLIC, '192.168.1.20'], 'dual6.test': [PUBLIC6, 'fd12::5'], 'mixmeta.test': [PUBLIC, '169.254.169.254'], 'empty.test': [],
  });
  const dialed = fakeDial({});
  try {
    for (const name of ['meta.test', 'meta6.test', 'mapped.test', 'loop.test', 'loop6.test', 'tailscale-dns.test', 'nat64.test', 'mixmeta.test']) {
      await assert.rejects(outboundRequest(`https://${name}/`), refusedWith('blocked'), name);
      await assert.rejects(outboundRequest(`https://${name}/`, {}, { privateAllowed: true }), refusedWith('blocked'), `${name} with private allowed`);
    }
    for (const name of ['lan.test', 'ula.test', 'cgnat.test']) await assert.rejects(outboundRequest(`https://${name}/`), refusedWith('blocked'), name);
    // A name with public and private answers is refused whatever the setting: a mixed answer is never "private".
    for (const name of ['dual.test', 'dual6.test']) {
      await assert.rejects(outboundRequest(`https://${name}/`), refusedWith('blocked'), name);
      await assert.rejects(outboundRequest(`https://${name}/`, {}, { privateAllowed: true }), refusedWith('blocked'), `${name} with private allowed`);
    }
    await assert.rejects(outboundRequest('https://empty.test/'), refusedWith('dns'));
    await assert.rejects(outboundRequest('https://unknown.test/'), refusedWith('dns'));
    assert.deepEqual(dialed, [], 'nothing was ever dialed');
    assert.ok(lookups.length > 0);
  } finally { restoreIo(); }
});

test('redirects are never followed, including one to an internal or metadata host', { skip: noTls }, async () => {
  const internal = await fakeServer({ secure: false });
  const server = await fakeServer({ handler: (req, res) => { res.writeHead(req.url === '/302' ? 302 : req.url === '/301' ? 301 : 307, { Location: req.url === '/302' ? 'http://169.254.169.254/latest/meta-data/' : req.url === '/301' ? `http://127.0.0.1:${internal.port}/` : 'https://hook.test/elsewhere' }); res.end(); } });
  try {
    outboundIo.ca = material.cert; fakeDns({ 'hook.test': [PUBLIC] }); fakeDial({ [PUBLIC]: server, '169.254.169.254': internal });
    for (const path of ['/302', '/301', '/307']) await assert.rejects(outboundRequest(`https://hook.test${path}`), error => refusedWith('redirect')(error) && error.message === 'The server answered with a redirect. Paste the final URL.', path);
    assert.equal(server.seen.length, 3, 'one request each, never a second one');
    assert.equal(internal.connections, 0, 'the redirect target was never reached');
  } finally { server.close(); internal.close(); restoreIo(); }
});

test('an oversized response is cut at 64 KB and the connection dropped; slow answers and slow DNS hit the 10 s limit', { skip: noTls }, async () => {
  const big = await fakeServer({ handler: (_req, res) => { res.writeHead(200); const chunk = Buffer.alloc(16 * 1024, 'x'); let sent = 0; const pump = () => { while (sent < 4 * 1024 * 1024) { sent += chunk.length; if (!res.write(chunk)) return res.once('drain', pump); } res.end(); }; res.on('error', () => {}); pump(); } });
  const slowBody = await fakeServer({ handler: (_req, res) => { res.writeHead(200); res.write('{'); } });
  const silent = await fakeServer({ handler: () => {} });
  try {
    outboundIo.ca = material.cert; fakeDns({ 'hook.test': [PUBLIC], 'slow.test': [SLOW], 'silent.test': [SILENT], 'slowdns.test': () => new Promise(resolve => setTimeout(() => resolve([PUBLIC]), 3_000)) });
    const dialed = fakeDial({ [PUBLIC]: big, [SLOW]: slowBody, [SILENT]: silent });
    let started = Date.now();
    const response = await outboundRequest('https://hook.test/');
    assert.equal(response.truncated, true); assert.equal((await response.text()).length, outboundLimits.responseBytes);
    assert.ok(Date.now() - started < 5_000, 'did not wait for the whole 4 MB');
    outboundLimits.totalMs = 400;
    for (const name of ['slow.test', 'silent.test']) {
      started = Date.now();
      await assert.rejects(outboundRequest(`https://${name}/`), refusedWith('timeout'), name);
      const took = Date.now() - started; assert.ok(took >= 350 && took < 2_500, `${name} took ${took} ms`);
    }
    dialed.length = 0; started = Date.now();
    await assert.rejects(outboundRequest('https://slowdns.test/'), refusedWith('timeout'), 'a resolver slower than the limit');
    assert.ok(Date.now() - started < 2_500, 'the limit includes DNS'); assert.deepEqual(dialed, [], 'nothing dialed after a slow DNS');
    outboundLimits.totalMs = 10_000;
    await assert.rejects(outboundRequest('https://hook.test/', { method: 'POST', body: 'x'.repeat(16 * 1024 + 1) }), refusedWith('too-large'), 'request body at most 16 KB');
  } finally { big.close(); slowBody.close(); silent.close(); restoreIo(); }
});

test('ports and schemes: public hosts on HTTPS 443 only; a private host with permission may use HTTP and its own port', { skip: noTls }, async () => {
  const lan = await fakeServer({ secure: false }), web = await fakeServer();
  try {
    outboundIo.ca = material.cert;
    const lookups = fakeDns({ 'hook.test': [PUBLIC], 'ntfy.lan': ['192.168.1.20'] }); fakeDial({ [PUBLIC]: web, '192.168.1.20': lan });
    await assert.rejects(outboundRequest('https://hook.test:8443/'), refusedWith('blocked'));
    await assert.rejects(outboundRequest('http://hook.test/'), refusedWith('blocked'));
    assert.deepEqual(lookups, [], 'refused without a lookup');
    // Even with private permission, a public answer keeps the public rules.
    await assert.rejects(outboundRequest('https://hook.test:8443/', {}, { privateAllowed: true }), refusedWith('blocked'));
    await assert.rejects(outboundRequest('http://hook.test/', {}, { privateAllowed: true }), refusedWith('blocked'));
    assert.equal(web.connections, 0);
    assert.equal((await outboundRequest('https://hook.test:443/')).status, 200);
    assert.equal((await outboundRequest('http://ntfy.lan:8080/alerts', { method: 'POST', body: 'hi' }, { privateAllowed: true })).status, 200);
    assert.equal(lan.seen[0].headers.host, 'ntfy.lan:8080');
  } finally { lan.close(); web.close(); restoreIo(); }
});

test('TLS: an untrusted or mismatched certificate fails with one fixed sentence; there is no skip', { skip: noTls }, async () => {
  const server = await fakeServer();
  try {
    fakeDns({ 'hook.test': [PUBLIC], 'wrong.test': [PUBLIC] }); fakeDial({ [PUBLIC]: server });
    await assert.rejects(outboundRequest('https://hook.test/'), error => refusedWith('tls')(error) && error.message === 'The server certificate could not be verified.', 'untrusted');
    outboundIo.ca = material.cert;
    await assert.rejects(outboundRequest('https://wrong.test/'), refusedWith('tls'), 'name not on the certificate');
    assert.equal(server.seen.length, 0, 'no request crossed an unverified connection');
  } finally { server.close(); restoreIo(); }
});

test('proxy variables are ignored: HTTPS_PROXY, HTTP_PROXY, ALL_PROXY and NODE_USE_ENV_PROXY never route a request', { skip: noTls }, async () => {
  const server = await fakeServer();
  let proxied = 0; const proxy = net.createServer(socket => { proxied++; socket.destroy(); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`, saved = {};
  const names = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  try {
    for (const name of names) { saved[name] = process.env[name]; process.env[name] = proxyUrl; }
    outboundIo.ca = material.cert; fakeDns({ 'hook.test': [PUBLIC] }); fakeDial({ [PUBLIC]: server });
    assert.equal((await outboundRequest('https://hook.test/')).status, 200);
    // A process started with NODE_USE_ENV_PROXY=1 (Node's own proxy support) still connects directly.
    const module = pathToFileURL(fileURLToPath(new URL('../src/alerts/outbound.js', import.meta.url))).href;
    const code = `const o = await import(${JSON.stringify(module)}); o.outboundIo.ca = process.env.TEST_CA; o.outboundIo.resolve = async () => [{ address: '${PUBLIC}', family: 4 }]; o.outboundIo.dial = () => ({ address: '127.0.0.1', port: ${server.port} }); const r = await o.outboundRequest('https://hook.test/child'); console.log(r.status);`;
    const output = await new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, NODE_USE_ENV_PROXY: '1', TEST_CA: material.cert.toString() }, timeout: 20_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
    assert.equal(output.trim().split('\n').at(-1), '200');
    assert.equal(server.seen.length, 2); assert.equal(server.seen[1].url, '/child');
    assert.equal(proxied, 0, 'the proxy never saw a connection');
  } finally { for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } proxy.close(); server.close(); restoreIo(); }
});

const ipv6Loopback = await new Promise(resolve => { const probe = net.createServer(); probe.once('error', () => resolve(false)); probe.listen(0, '::1', () => probe.close(() => resolve(true))); });
test('an IPv6-only host is reached over IPv6 through the pinned answer', { skip: noTls || (!ipv6Loopback && 'no IPv6 loopback here') }, async () => {
  const server = await fakeServer({ host: '::1' });
  try {
    outboundIo.ca = material.cert; fakeDns({ 'v6only.test': [PUBLIC6] }); const dialed = fakeDial({ [PUBLIC6]: server });
    const response = await outboundRequest('https://v6only.test/topic', { method: 'POST', body: 'x' });
    assert.equal(response.status, 200); assert.deepEqual(dialed, [`${PUBLIC6}:443`]); assert.equal(server.seen[0].servername, 'v6only.test');
    assert.equal(server.seen.length, 1);
  } finally { server.close(); restoreIo(); }
});

test('errors never carry the URL, the token or Node’s own error text', async () => {
  outboundIo.resolve = async () => { throw new Error(`getaddrinfo ENOTFOUND api.telegram.org /bot${TOKEN}/sendMessage`); };
  try {
    const error = await outboundRequest(`https://api.telegram.org/bot${TOKEN}/sendMessage`).catch(caught => caught);
    assert.ok(error instanceof OutboundError); assert.equal(error.message, 'The server name could not be found.');
    assert.ok(!JSON.stringify({ message: error.message, stack: error.stack, code: error.code }).includes(TOKEN));
    const refused = await outboundRequest(`https://127.0.0.1/bot${TOKEN}`).catch(caught => caught);
    assert.ok(!refused.message.includes(TOKEN) && !refused.stack.includes(TOKEN));
  } finally { restoreIo(); }
});

// ---- "Allow private network" and private_ok ----------------------------------------------------------------------
// A stand-in for an HTTP provider with a user host (ntfy, Gotify come in PR 3); the stamping rule reads only these.
const userHostProvider = Object.freeze({ id: 'ntfy', target: () => ({ hosts: 'user' }) });
const setting = enabled => connections.setAllowPrivateNetwork(enabled, 'admin-id', 'admin');

test('private_ok stamping: an admin save while the setting is on; operators and fixed hosts never; edits keep it', () => {
  setting(false);
  assert.equal(connections.allowPrivateNetwork(), false);
  db.prepare('DELETE FROM settings WHERE key=?').run(connections.PRIVATE_NETWORK_KEY);
  assert.equal(connections.allowPrivateNetwork(), false, 'a missing setting (every upgraded install) is off');
  const stamp = (role, extra = {}) => connections.privateOkFor({ provider: userHostProvider, role, ...extra });
  assert.equal(stamp('admin'), 0, 'admin, setting off');
  assert.equal(stamp('operator'), 0, 'operator, setting off');
  setting(true);
  assert.equal(stamp('admin'), 1, 'admin, setting on');
  assert.equal(stamp('operator'), 0, 'operator, setting on');
  assert.equal(stamp('operator', { hostChanged: false, previous: 1 }), 1, 'an operator renaming keeps an admin’s private server');
  assert.equal(stamp('operator', { hostChanged: true, previous: 1 }), 0, 'an operator changing the host drops it');
  assert.equal(stamp('admin', { hostChanged: false, previous: 0 }), 0, 'no host change: nothing new is granted');
  assert.equal(connections.privateOkFor({ provider: 'telegram', role: 'admin' }), 0, 'a fixed-host provider never needs it');
  assert.equal(connections.privateOkFor({ provider: 'email', role: 'admin' }), 1, 'Email: the 2.8 relay rule, set by an administrator');
  setting(false);
  assert.equal(connections.privateOkFor({ provider: 'email', role: 'admin' }), 1, 'Email does not depend on the setting');
  assert.equal(connections.privateOkFor({ provider: 'email', role: 'operator' }), 0, 'an operator-set relay host is public only');
  assert.equal(connections.privateOkFor({ provider: 'nope', role: 'admin' }), 0);
});

test('only an administrator changes "Allow private network"; it is audited with the role and never a value', () => {
  db.exec("DELETE FROM audit_events WHERE action='alerts.private_network'");
  assert.throws(() => connections.setAllowPrivateNetwork(true, 'op-id', 'operator'), error => error.status === 403 && error.code === 'ALERTS_ADMIN_REQUIRED');
  assert.equal(connections.allowPrivateNetwork(), false);
  assert.deepEqual(setting(true), { allowPrivateNetwork: true }); setting(false);
  const rows = db.prepare("SELECT actor,detail FROM audit_events WHERE action='alerts.private_network' ORDER BY rowid").all();
  assert.deepEqual(rows.map(row => [row.actor, JSON.parse(row.detail)]), [['admin-id', { enabled: true, role: 'admin' }], ['admin-id', { enabled: false, role: 'admin' }]]);
});

// Use cases: self-hosted ntfy (HTTP on port 80) and Gotify (HTTP on 8080 with an app token header) on the LAN.
test('ntfy and Gotify on the LAN: send with the setting on, refused at once when it is turned off, and for operators', async () => {
  const ntfy = await fakeServer({ secure: false }), gotify = await fakeServer({ secure: false });
  try {
    fakeDns({ 'ntfy.lan': ['192.168.1.20'], 'gotify.home.arpa': ['10.0.0.7'] }); const dialed = fakeDial({ '192.168.1.20': ntfy, '10.0.0.7': gotify });
    const sendNtfy = row => outboundRequest('http://ntfy.lan/docknest-alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: 'docknest-alerts', title: 'Backup failed', message: 'shop on srv' }) }, { privateAllowed: connections.privateAllowed(row) });
    const sendGotify = row => outboundRequest('http://gotify.home.arpa:8080/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gotify-Key': GOTIFY_KEY }, body: JSON.stringify({ title: 'Backup failed', message: 'shop on srv', priority: 8 }) }, { privateAllowed: connections.privateAllowed(row) });
    setting(true);
    const adminSaved = { private_ok: connections.privateOkFor({ provider: userHostProvider, role: 'admin' }) };
    const operatorSaved = { private_ok: connections.privateOkFor({ provider: userHostProvider, role: 'operator' }) };
    assert.equal((await sendNtfy(adminSaved)).status, 200); assert.equal((await sendGotify(adminSaved)).status, 200);
    assert.equal(ntfy.seen[0].url, '/docknest-alerts'); assert.equal(JSON.parse(ntfy.seen[0].body).title, 'Backup failed');
    assert.equal(gotify.seen[0].headers['x-gotify-key'], GOTIFY_KEY); assert.equal(gotify.seen[0].headers.host, 'gotify.home.arpa:8080');
    await assert.rejects(sendNtfy(operatorSaved), refusedWith('blocked'), 'an operator-saved Connection reaches public hosts only');
    setting(false);
    await assert.rejects(sendNtfy(adminSaved), refusedWith('blocked'), 'turned off: the very next send is refused');
    await assert.rejects(sendGotify(adminSaved), refusedWith('blocked'));
    const savedWhileOff = { private_ok: connections.privateOkFor({ provider: userHostProvider, role: 'admin' }) };
    setting(true);
    await assert.rejects(sendNtfy(savedWhileOff), refusedWith('blocked'), 'saved while off: turning it on later grants nothing');
    assert.equal((await sendNtfy(adminSaved)).status, 200, 'saved while on, and on again now');
    assert.equal(ntfy.seen.length, 2); assert.equal(gotify.seen.length, 1);
    assert.ok(dialed.every(entry => !entry.startsWith('127.')), 'only checked LAN addresses were dialed');
  } finally { setting(false); ntfy.close(); gotify.close(); restoreIo(); }
});

test('SMTP: a private relay set by an administrator or migrated keeps working; one set by anyone else must be public', async () => {
  smtp.smtpPolicy.allowLoopback = false;
  try {
    for (const host of ['192.168.1.10', '10.0.0.25', '172.20.0.5', 'fd12::25']) {
      assert.equal(smtp.addressAllowed(host, { privateOk: true }), true, host);
      assert.equal(smtp.addressAllowed(host, { privateOk: false }), false, host);
    }
    for (const host of ['127.0.0.1', '::1', '169.254.169.254', '::ffff:7f00:1', '::ffff:a9fe:a9fe', 'fd00:ec2::254', 'fe80::1', '0.0.0.0']) assert.equal(smtp.addressAllowed(host, { privateOk: true }), false, `${host} stays refused for every relay`);
    for (const host of ['100.100.100.200', '192.0.2.1', '64:ff9b::a9fe:a9fe']) assert.equal(smtp.addressAllowed(host, { privateOk: false }), false, `${host}: public means the outbound policy`);
    assert.equal(smtp.addressAllowed(TELEGRAM_IP, { privateOk: false }), true, 'a public relay works for anyone');
    const config = { host: '192.168.1.10', port: 587, security: 'starttls', username: '', password: '', from: 'docknest@example.com', to: ['me@example.com'] };
    await assert.rejects(smtp.sendMail(config, { subject: 's', text: 't' }), error => error.code === 'blocked' && error.message === 'The mail server could not be reached.', 'refused before connecting');
    const original = smtp.smtpIo.resolve; smtp.smtpIo.resolve = async () => '10.1.1.1';
    try { await assert.rejects(smtp.sendMail({ ...config, host: 'relay.lan' }, null), error => error.code === 'blocked', 'a name resolving to the LAN'); }
    finally { smtp.smtpIo.resolve = original; }
  } finally { smtp.smtpPolicy.allowLoopback = false; }
});

// ---- Delivery on top: Telegram through the guarded client, rate limit, 429, fold race, final failures -------------
const reset = () => db.exec('DELETE FROM alert_outbox;DELETE FROM alert_lines;DELETE FROM alert_nodes;DELETE FROM connections;');
function telegramSetup(chatId = '-1001234567890') {
  const credential = store.createCredential({ kind: 'telegram', name: 'Bot', config: { token: TOKEN } }, 'test');
  const node = store.createChannel({ kind: 'telegram', name: 'Phone', credentialId: credential.id, config: { chatId } }, 'test');
  store.createRule({ channelId: node.id, sourceKind: 'docknest', events: ['backup.failed'] }, 'test');
  return { credential, node, connectionId: db.prepare('SELECT connection_id FROM alert_nodes WHERE id=?').get(node.id).connection_id };
}
const mockFetch = handler => { const calls = []; delivery.alertHttp.fetch = async (url, init, guard) => { calls.push({ url, init, guard }); return handler(url, init, calls.length); }; return calls; };
const ok = () => new Response('{"ok":true,"result":{}}', { status: 200 });
const emitMany = (count, at, prefix = 'site') => { for (let index = 0; index < count; index++) delivery.emit({ type: 'backup.failed', key: `${prefix}:${index}`, siteName: `s${index}`, serverName: 'v' }, { at }); };
const items = connectionId => db.prepare('SELECT status,attempts,next_attempt_at,message FROM alert_outbox WHERE connection_id=? ORDER BY created_at,rowid').all(connectionId).map(row => ({ ...row }));

test('upgrade path: Telegram goes through the guarded client to api.telegram.org with the 2.8 request shape', { skip: noTls }, async () => {
  reset();
  const server = await fakeServer();
  try {
    outboundIo.ca = material.cert; const lookups = fakeDns({ 'api.telegram.org': [TELEGRAM_IP, '2001:67c:4e8:f004::9'] }); fakeDial({ [TELEGRAM_IP]: server, '2001:67c:4e8:f004::9': server });
    const { node, credential } = telegramSetup();
    assert.deepEqual(await delivery.sendTest(node.id, 'test'), { sent: true });
    assert.deepEqual(await delivery.verifyCredential(credential.id, 'test'), { verified: true });
    assert.equal(server.seen[0].url, `/bot${TOKEN}/sendMessage`); assert.equal(server.seen[0].method, 'POST');
    assert.equal(server.seen[0].headers.host, 'api.telegram.org'); assert.equal(server.seen[0].servername, 'api.telegram.org');
    assert.deepEqual(JSON.parse(server.seen[0].body), { chat_id: '-1001234567890', text: 'This is a test message from DockNest. Your alerts are connected.', disable_web_page_preview: true });
    assert.equal(server.seen[1].url, `/bot${TOKEN}/getMe`); assert.equal(server.seen[1].method, 'GET');
    assert.deepEqual(lookups, ['api.telegram.org', 'api.telegram.org'], 'one lookup per request');
    // A resolver that sends api.telegram.org to the LAN or to metadata is refused with the provider's plain sentence.
    for (const address of ['192.168.1.1', '169.254.169.254']) {
      fakeDns({ 'api.telegram.org': [address] });
      await assert.rejects(delivery.sendTest(node.id, 'test'), error => error.status === 502 && error.message === 'Telegram could not be reached.');
    }
    assert.equal(server.seen.length, 2);
  } finally { server.close(); restoreIo(); }
});

test('rate limit: at most 20 messages per Connection per 10 minutes; the rest wait for the next window, no try used', async () => {
  reset();
  const { connectionId } = telegramSetup();
  const t0 = Date.parse('2026-11-02T00:00:00Z'), calls = mockFetch(ok);
  emitMany(25, t0);
  assert.equal(await delivery.deliverDue({ at: t0 }), 20, 'the batch fills the window');
  assert.equal(await delivery.deliverDue({ at: t0 + 1_000 }), 0, 'over the limit: nothing more in this window'); assert.equal(calls.length, 20);
  const waiting = items(connectionId).filter(row => row.status === 'pending');
  assert.equal(waiting.length, 5); assert.ok(waiting.every(row => row.attempts === 0 && row.next_attempt_at === t0 + 10 * 60_000), 'they wait for the window, with no try used');
  // Another Connection is not held back by this one's limit.
  const other = telegramSetup('-1002');
  delivery.emit({ type: 'backup.failed', key: 'site:new', siteName: 'n', serverName: 'v' }, { at: t0 + 2_000 });
  assert.equal(await delivery.deliverDue({ at: t0 + 2_000 }), 1); assert.equal(calls.length, 21);
  assert.ok(items(other.connectionId).every(row => row.status === 'sent'));
  assert.equal(await delivery.deliverDue({ at: t0 + 10 * 60_000 - 1 }), 0);
  assert.equal(await delivery.deliverDue({ at: t0 + 10 * 60_000 }), 6); assert.equal(calls.length, 27);
});

test('429: Retry-After seconds, HTTP date, Telegram and Discord bodies; no try used; the whole Connection waits', async () => {
  reset();
  const { connectionId } = telegramSetup(), t0 = Date.parse('2026-11-03T00:00:00Z');
  const cases = [
    [() => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }), 120_000],
    [() => new Response('{}', { status: 429, headers: { 'Retry-After': new Date(Date.now() + 300_000).toUTCString() } }), 300_000],
    [() => new Response('{"ok":false,"error_code":429,"parameters":{"retry_after":33}}', { status: 429 }), 33_000],
    [() => new Response('{"retry_after":1.5,"global":false}', { status: 429 }), 1_500],
    [() => new Response('{}', { status: 429, headers: { 'Retry-After': '86400' } }), 15 * 60_000],
    [() => new Response('nope', { status: 429 }), delivery.deliveryPolicy.retryAfterMs],
  ];
  let at = t0;
  for (const [answer, wait] of cases) {
    db.exec('DELETE FROM alert_outbox'); emitMany(3, at, `r${at}`); mockFetch(answer);
    await delivery.deliverDue({ at });
    const rows = items(connectionId);
    assert.ok(rows.every(row => row.status === 'pending' && row.attempts === 0), 'no try used');
    for (const row of rows) assert.ok(Math.abs(row.next_attempt_at - (at + wait)) <= 1_000, `waits ${wait} ms (got ${row.next_attempt_at - at})`);
    at += 3600_000;
  }
});

test('a provider answering 429 again and again: never a used-up try, never more often than asked, failed at 24 hours', async () => {
  reset();
  const { connectionId } = telegramSetup(), t0 = Date.parse('2026-11-04T00:00:00Z');
  const calls = mockFetch(() => new Response('{"ok":false,"parameters":{"retry_after":900}}', { status: 429 }));
  emitMany(1, t0);
  let at = t0;
  for (let round = 0; round < 200; round++) { await delivery.deliverDue({ at }); const [row] = items(connectionId); if (row.status !== 'pending') break; assert.equal(row.attempts, 0); at = row.next_attempt_at; }
  const [row] = items(connectionId);
  assert.equal(row.status, 'failed', 'given up at the maximum age'); assert.equal(row.attempts, 0);
  assert.equal(calls.length, 96, 'one try per 15 minutes for 24 hours');
  assert.equal(db.prepare('SELECT last_send FROM connections WHERE id=?').get(connectionId).last_send, 'failed');
});

test('fold race: the "N more alerts" item growing while its send is in flight is marked sent only for what was sent', async () => {
  reset();
  const { connectionId } = telegramSetup(), t0 = Date.parse('2026-11-05T00:00:00Z');
  emitMany(53, t0); // 50 stored, 3 folded
  db.prepare("UPDATE alert_outbox SET next_attempt_at=? WHERE connection_id=? AND status='pending' AND dedupe_key<>?").run(t0 + 86400_000, connectionId, delivery.COLLAPSE_KEY);
  const collapsed = () => ({ ...db.prepare('SELECT status,message,payload,attempts FROM alert_outbox WHERE dedupe_key=? ORDER BY created_at DESC').get(delivery.COLLAPSE_KEY) });
  assert.equal(collapsed().message, '3 more alerts. Open DockNest to see them.');
  const calls = mockFetch((_url, init) => { if (JSON.parse(init.body).text.startsWith('3 more')) delivery.emit({ type: 'backup.failed', key: 'site:late', siteName: 'late', serverName: 'v' }, { at: t0 }); return ok(); });
  assert.equal(await delivery.deliverDue({ at: t0 }), 1);
  assert.equal(JSON.parse(calls[0].init.body).text, '3 more alerts. Open DockNest to see them.');
  assert.deepEqual({ status: collapsed().status, message: collapsed().message, payload: JSON.parse(collapsed().payload) }, { status: 'pending', message: '1 more alert. Open DockNest to see it.', payload: { collapsed: 1 } }, 'the late one is still to be told');
  assert.equal(await delivery.deliverDue({ at: t0 + 1 }), 1);
  assert.equal(JSON.parse(calls[1].init.body).text, '1 more alert. Open DockNest to see it.');
  assert.equal(collapsed().status, 'sent');
  // Without a race the item is simply sent.
  emitMany(1, t0 + 2, 'more'); assert.equal(collapsed().status, 'pending');
  mockFetch(ok); await delivery.deliverDue({ at: t0 + 2 }); assert.equal(collapsed().status, 'sent');
});

test('final failures: Telegram 401, 403 and 404 at once; 400 and 5xx retried; a redirect is a plain failure', async () => {
  reset();
  const { connectionId } = telegramSetup(), t0 = Date.parse('2026-11-06T00:00:00Z');
  for (const [status, final] of [[401, true], [403, true], [404, true], [400, false], [500, false], [502, false]]) {
    db.exec('DELETE FROM alert_outbox'); emitMany(1, t0, `f${status}`);
    mockFetch(() => new Response('{"ok":false}', { status }));
    await delivery.deliverDue({ at: t0 });
    const [row] = items(connectionId);
    assert.deepEqual({ status: row.status, attempts: row.attempts }, final ? { status: 'failed', attempts: 1 } : { status: 'pending', attempts: 1 }, String(status));
  }
  db.exec('DELETE FROM alert_outbox'); emitMany(1, t0, 'redirect');
  mockFetch(() => { throw new OutboundError('redirect'); });
  await delivery.deliverDue({ at: t0 });
  assert.equal(db.prepare('SELECT last_error FROM connections WHERE id=?').get(connectionId).last_error, 'The server answered with a redirect. Paste the final URL.');
});

// A tiny implicit-TLS SMTP server that answers AUTH with `authReply`.
function fakeSmtp(authReply) {
  const log = [];
  const server = tls.createServer({ key: material.key, cert: material.cert }, socket => {
    socket.setEncoding('utf8'); socket.on('error', () => {}); let buffer = '';
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf('\r\n'); end >= 0; end = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2); log.push(line.split(' ')[0]);
        const word = line.split(' ')[0].toUpperCase();
        if (word === 'EHLO') socket.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (word === 'AUTH') socket.write(`${authReply}\r\n`);
        else if (word === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, log, close: () => server.close() })));
}

test('final failures: an SMTP sign-in rejection (535, 534) is final at once; a temporary refusal is retried', { skip: noTls }, async () => {
  smtp.smtpPolicy.allowLoopback = true; // the fake server listens on 127.0.0.1; production code never sets this
  const original = smtp.smtpIo.connect;
  smtp.smtpIo.connect = options => original({ ...options, tlsOptions: { ca: material.cert } });
  try {
    for (const [reply, final] of [['535 5.7.8 nope', true], ['534 5.7.9 nope', true], ['454 4.7.0 try later', false]]) {
      reset();
      const fake = await fakeSmtp(reply);
      try {
        const account = store.createCredential({ kind: 'smtp', name: 'Mail', config: { host: '127.0.0.1', port: fake.port, security: 'tls', username: 'bot', password: 'fixture-password-not-real', from: 'docknest@example.com' } }, 'test');
        const node = store.createChannel({ kind: 'email', name: 'Inbox', credentialId: account.id, config: { to: ['me@example.com'] } }, 'test');
        store.createRule({ channelId: node.id, sourceKind: 'docknest', events: ['backup.failed'] }, 'test');
        const t0 = Date.parse('2026-11-07T00:00:00Z'); emitMany(1, t0, reply.slice(0, 3));
        await delivery.deliverDue({ at: t0 });
        const row = db.prepare('SELECT status,attempts FROM alert_outbox').get();
        assert.deepEqual({ ...row }, final ? { status: 'failed', attempts: 1 } : { status: 'pending', attempts: 1 }, reply);
        assert.ok(fake.log.includes('AUTH'), 'it reached the sign-in');
        if (final) assert.equal(db.prepare('SELECT last_error FROM connections').get().last_error, 'The mail server refused the user name or password.');
      } finally { fake.close(); }
    }
  } finally { smtp.smtpIo.connect = original; smtp.smtpPolicy.allowLoopback = false; }
});

test('guardFor: Telegram gets its fixed host and no private access, whatever its row says', () => {
  setting(true);
  try {
    const guard = delivery.guardFor({ provider: 'telegram', private_ok: 0 });
    assert.deepEqual(guard, { hosts: ['api.telegram.org'], privateAllowed: false });
    assert.equal(delivery.guardFor({ provider: 'telegram', private_ok: 1 }).privateAllowed, true, 'the flag decides, but the fixed host still binds it');
    setting(false);
    assert.equal(delivery.guardFor({ provider: 'telegram', private_ok: 1 }).privateAllowed, false, 'the setting off wins at once');
  } finally { setting(false); }
});
