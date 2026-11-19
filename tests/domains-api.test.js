// Domain path API and engine (docs/domains.md, "API", "When it runs", "Data"): roles, CSRF, validation, the per-user rate
// limit, the job queue for the helper part, the hourly DNS limit, routing facts riding on an operation's answer, the
// Cloudflare token check, the stored row limits, and that a secret from a proxy configuration or the Cloudflare token
// never reaches the API, the database, the audit trail or a job. The helper, the resolvers and Cloudflare are faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-domains-api-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { digest, seal } = await import('../src/crypto.js');
const { claimJob, executeJob, transport } = await import('../src/engine.js');
const { dnsResolver, setProxyRanges } = await import('../src/moves/dns.js');
const { cloudflareHttp } = await import('../src/moves/cloudflare.js');
const domains = await import('../src/domains/check.js');
const { recoverInterruptedDomainChecks } = await import('../src/domains/jobs.js');
const { domainCheckLimit } = await import('../src/domains/routes.js');
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
test.after(() => listener.close());

const SECRET = 'fixture-secret-do-not-leak', TOKEN = 'cf_' + 'k'.repeat(40);
let now = Date.parse('2026-11-19T12:00:00.000Z');
domains.domainClock.now = () => now;
domains.hostResolver.lookup = async host => [host];
const lookups = [];
let answers = { 'shop.example.com': ['203.0.113.10'], 'www.shop.example.com': ['203.0.113.10'], 'cf.example.com': ['192.0.2.200'], 'gone.example.net': ['192.0.2.99'] };
dnsResolver.resolve = async name => { lookups.push(name); return [{ A: answers[name] ?? [], AAAA: [] }, { A: answers[name] ?? [], AAAA: [] }]; };
setProxyRanges(['192.0.2.192/26']);

function user(role, csrfHeader = true) {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId, userId + '@example.invalid', 'fixture', 'fixture', '[]', new Date().toISOString(), role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), userId, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), Date.now());
  return async (method, route, body) => {
    const response = await fetch(base + route, { method, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, ...(csrfHeader ? { 'x-csrf-token': 'csrf' } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : null };
  };
}
const admin = user('admin'), operator = user('operator'), noCsrf = user('admin', false);

const serverId = randomUUID(), siteId = randomUUID(), at = () => new Date(now).toISOString();
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(serverId, 'Server 1', '203.0.113.10', 22, 'root', 'fixture', '0'.repeat(64), at());
db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, serverId, 'Shop', JSON.stringify({ containers: ['shop-web'], domains: ['shop.example.com', 'cf.example.com'] }), at());

// What the helper answers for domain-routes: routing facts plus fields the server must drop, each carrying a secret.
const helperAnswer = () => ({
  certificates: [{ source: 'certbot', name: 'shop.example.com', domains: ['shop.example.com', 'www.shop.example.com'], notAfter: Math.floor(now / 1000) + 60 * 86400, renewal: 'failed', renewalAt: Math.floor(now / 1000) - 3600, renewalCategory: 'connection-refused', log: SECRET }],
  routing: {
    format: 1, incomplete: false, port80: false, addresses: ['203.0.113.10', SECRET], config: SECRET,
    routes: [
      { proxy: 'nginx', domains: ['shop.example.com', 'www.shop.example.com', SECRET], upstreams: ['http://127.0.0.1:8080', `http://user:${SECRET}@127.0.0.1:8080`], containers: ['shop-web'], static: false, understood: true, listen: [80, 443], certificates: ['shop.example.com'], headers: { 'X-Api-Key': SECRET } },
      { proxy: 'nginx', domains: ['cf.example.com'], upstreams: ['http://127.0.0.1:8080'], containers: ['shop-web'], static: false, understood: true, listen: [80], certificates: [] },
      { proxy: 'apache', domains: ['other.example.com'], upstreams: [], containers: [] },
    ],
    notUnderstood: [{ proxy: 'traefik', container: 'forum-web', router: SECRET.replace(/-/g, ' ') }],
    proxies: [{ proxy: 'nginx', container: null, running: true }],
    containers: [{ name: 'shop-web', running: true, health: 'healthy', published: [8080], env: SECRET }],
  },
});
const requests = [];
transport.remote = async (server, request) => { requests.push(request.operation); if (request.operation === 'domain-routes') return helperAnswer(); throw new Error('unexpected ' + request.operation); };
const everything = () => JSON.stringify([db.prepare('SELECT * FROM domain_checks').all(), db.prepare("SELECT * FROM settings WHERE key LIKE 'domain_routes:%'").all(), db.prepare('SELECT * FROM audit_events').all(), db.prepare('SELECT * FROM jobs').all()]);
const runQueued = async () => { const job = claimJob(); assert.ok(job, 'a job is waiting'); assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status, 'domain_running'); await executeJob(job); return db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id); };

test('Check again for an app runs the helper part through the job queue and stores every hop without secrets', async () => {
  const queued = await operator('POST', '/domains/check', { siteId });
  assert.equal(queued.status, 202, queued.text); assert.equal(queued.body.status, 'queued');
  assert.equal((await admin('POST', '/domains/check', { siteId })).body.jobId, queued.body.jobId, 'a second request joins the waiting check');
  const job = await runQueued();
  assert.equal(job.status, 'completed', job.error); assert.equal(job.type, 'domain-check');
  assert.deepEqual(requests, ['domain-routes']);
  const view = await operator('GET', '/domains');
  assert.equal(view.status, 200);
  const shop = view.body.domains.find(row => row.domain === 'shop.example.com');
  assert.deepEqual(Object.fromEntries(Object.entries(shop.hops).map(([name, value]) => [name, `${value.state}:${value.reason}`])), { dns: 'ok:points-to-server', proxy: 'ok:routed', app: 'ok:running', certificate: 'warn:renewal-port80' });
  assert.equal(shop.serverId, serverId); assert.equal(shop.siteId, siteId); assert.equal(shop.trigger, 'manual'); assert.equal(shop.worst, 'warn');
  assert.ok(view.body.domains.some(row => row.domain === 'www.shop.example.com'), 'a domain the proxy routes to the app is checked with it');
  assert.ok(!view.body.domains.some(row => row.domain === 'other.example.com'), 'an unknown proxy kind is dropped');
  assert.deepEqual(view.body.groups.servers[serverId].sort(), ['cf.example.com', 'shop.example.com', 'www.shop.example.com']);
  assert.ok(!('lookup' in shop.hops), 'the raw lookup stays in the database');
  for (const text of [view.text, everything()]) assert.ok(!text.includes(SECRET) && !text.includes('fixture-secret'), 'no secret anywhere');
  const jobs = await admin('GET', '/jobs'), state = await admin('GET', '/state');
  assert.ok(Array.isArray(jobs.body.items) && !jobs.body.items.some(item => item.type === 'domain-check') && !state.body.jobs.some(item => item.type === 'domain-check'), 'domain checks stay out of the job history');
});

test('a domain is validated with the certificate NAME pattern, unknown domains are refused and CSRF is enforced', async () => {
  for (const body of [{ domain: 'Not A Domain!' }, { domain: '*.example.com' }, { domain: 'a'.repeat(250) + '.com' }, {}, { domain: 'shop.example.com', siteId }, { siteId: 'x' }, { domain: 'shop.example.com', extra: 1 }]) {
    const answer = await admin('POST', '/domains/check', body);
    assert.equal(answer.status, 400, JSON.stringify(body)); assert.ok(!answer.text.includes('Not A Domain'), 'the request is never echoed');
  }
  assert.equal((await admin('POST', '/domains/check', { domain: 'unknown.example.net' })).status, 404);
  assert.equal((await admin('POST', '/domains/check', { siteId: randomUUID() })).status, 404);
  assert.equal((await noCsrf('POST', '/domains/check', { siteId })).status, 403);
  const byDomain = await admin('POST', '/domains/check', { domain: 'SHOP.example.com' });
  assert.equal(byDomain.status, 202, byDomain.text);
  assert.equal(JSON.parse(db.prepare('SELECT details FROM jobs WHERE id=?').get(byDomain.body.jobId).details).domain, 'shop.example.com');
  assert.equal((await runQueued()).status, 'completed');
});

test('another role is refused, and operators have a per-user check budget', async () => {
  const guest = user('guest');
  assert.equal((await guest('GET', '/domains')).status, 403);
  assert.equal((await guest('POST', '/domains/check', { siteId })).status, 403);
  const busy = user('operator');
  for (let index = 0; index < domainCheckLimit.checks; index++) assert.notEqual((await busy('POST', '/domains/check', { siteId })).status, 429);
  const limited = await busy('POST', '/domains/check', { siteId });
  assert.equal(limited.status, 429); assert.ok(limited.text.includes('Too many checks'));
  assert.equal((await operator('POST', '/domains/check', { siteId })).status, 202, 'another person keeps their own budget');
  db.prepare("DELETE FROM jobs WHERE type='domain-check' AND status='domain_queued'").run();
});

test('a domain only a stored check knows is looked up again at once, DNS only', async () => {
  db.prepare("INSERT INTO domain_checks VALUES('gone.example.net',NULL,NULL,'{}',?,'discover')").run(at());
  const before = requests.length, answer = await admin('POST', '/domains/check', { domain: 'gone.example.net' });
  assert.equal(answer.status, 200, answer.text);
  assert.equal(answer.body.domain.hops.dns.reason, 'wrong-record'); assert.deepEqual(answer.body.domain.hops.dns.params, { address: '192.0.2.99' });
  assert.equal(requests.length, before, 'no helper call');
  assert.ok((await admin('GET', '/domains')).body.groups.pointsNowhere.includes('gone.example.net'));
});

test('routing facts ride on an operation answer, never reach the caller, and DNS is looked up at most once an hour', async () => {
  const answer = { ready: true, ...helperAnswer() };
  const rest = domains.takeRouting({ serverId }, answer, 'readiness');
  assert.equal('routing' in rest, false); assert.equal(rest.ready, true);
  assert.equal(domains.takeRouting({ serverId }, { ready: true }, 'readiness').ready, true, 'an answer without routing changes nothing');
  lookups.length = 0;
  await domains.checkDomains(['shop.example.com'], { trigger: 'backup' });
  assert.deepEqual(lookups, [], 'looked up within the hour already');
  await domains.checkDomains(['shop.example.com'], { trigger: 'manual', force: true });
  assert.deepEqual(lookups, ['shop.example.com'], 'a person asking looks again');
  now += domains.DNS_INTERVAL_MS + 1000;
  await domains.checkDomains(['shop.example.com'], { trigger: 'discover' });
  assert.deepEqual(lookups, ['shop.example.com', 'shop.example.com']);
  assert.equal(db.prepare("SELECT trigger FROM domain_checks WHERE domain='shop.example.com'").get().trigger, 'discover');
  await assert.rejects(domains.checkDomains(['shop.example.com'], { trigger: 'timer' }), /Unknown domain check trigger/);
});

test('Cloudflare: a proxied domain reads the token state and the origin; only the state and scope names are kept', async () => {
  db.prepare("INSERT INTO settings VALUES('cloudflare_dns',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ token: seal(TOKEN), zones: [{ id: 'f'.repeat(32), name: 'example.com' }], savedAt: at() }));
  const calls = [];
  let verify = { status: 'active' }, records = { ok: true, status: 200 };
  cloudflareHttp.fetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization === 'Bearer ' + TOKEN });
    const ok = result => ({ ok: true, status: 200, json: async () => ({ success: true, result }) });
    if (url.endsWith('/user/tokens/verify')) return verify ? ok(verify) : { ok: false, status: 401, json: async () => ({ success: false, errors: [{ message: 'Invalid API Token' }] }) };
    if (url.includes('/dns_records?')) return records.ok ? ok([{ id: 'r'.repeat(32), type: 'A', name: 'cf.example.com', content: '203.0.113.10', proxied: true, ttl: 1 }]) : { ok: false, status: 403, json: async () => ({ success: false }) };
    return { ok: false, status: 404, json: async () => ({ success: false }) };
  };
  const hop = async () => (await domains.checkDomains(['cf.example.com'], { trigger: 'manual', force: true }))[0].hops.dns;
  assert.deepEqual(await hop(), { state: 'ok', reason: 'cloudflare-origin', params: { address: '203.0.113.10', serverId } });
  verify = { status: 'expired' };
  assert.equal((await hop()).reason, 'cloudflare-token-expired');
  verify = null;
  assert.equal((await hop()).reason, 'cloudflare-token-expired', 'a refused token reads as expired');
  verify = { status: 'active' }; records = { ok: false };
  assert.deepEqual(await hop(), { state: 'warn', reason: 'cloudflare-token-limited', params: { missing: ['Zone.DNS:Read'] } });
  assert.ok(calls.every(call => call.method === 'GET' && call.auth), 'read calls only');
  db.prepare("DELETE FROM settings WHERE key='cloudflare_dns'").run();
  assert.equal((await hop()).reason, 'cloudflare-proxied', 'no token: amber');
  assert.ok(!everything().includes(TOKEN));
});

test('an interrupted check fails and can run again; a release without domain checks never claims one as a backup', async () => {
  const queued = await admin('POST', '/domains/check', { siteId });
  const job = claimJob(); assert.equal(job.id, queued.body.jobId);
  recoverInterruptedDomainChecks();
  assert.deepEqual({ ...db.prepare('SELECT status,stage FROM jobs WHERE id=?').get(job.id) }, { status: 'failed', stage: 'failed' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='domain-check' AND status IN ('queued','running')").get().n, 0);
  transport.remote = async () => { throw Object.assign(new Error(`ssh ${SECRET}`), { remoteReported: true }); };
  await admin('POST', '/domains/check', { siteId });
  const failed = await runQueued();
  assert.equal(failed.status, 'failed'); assert.ok(!failed.error.includes(SECRET), 'remote output never reaches the job');
});

test('the table refuses an uppercase or overlong domain, an unknown trigger and hops over 8 KB', () => {
  const insert = (domain, hops, trigger = 'manual') => db.prepare('INSERT INTO domain_checks VALUES(?,NULL,NULL,?,?,?)').run(domain, hops, at(), trigger);
  assert.throws(() => insert('Upper.example.com', '{}'), /CHECK/);
  assert.throws(() => insert('a'.repeat(254), '{}'), /CHECK/);
  assert.throws(() => insert('ok.example.com', '{}', 'timer'), /CHECK/);
  assert.throws(() => insert('ok.example.com', JSON.stringify({ x: 'y'.repeat(8200) })), /CHECK/);
  assert.throws(() => insert('ok.example.com', 'not json'), /CHECK/);
});
