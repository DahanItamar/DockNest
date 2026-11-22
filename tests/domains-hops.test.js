// The domain path reasoner (docs/domains.md): every reason code from fixed facts, CGNAT versus Tailscale, the Points
// nowhere grouping and the Move listing. Pure functions; no server, resolver or Cloudflare is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-domains-hops-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'unconfigured', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { domainPath, dnsHop, groupDomains, movedDomains, worstState, publicAddress } = await import('../src/domains/hops.js');
const { evaluateMove } = await import('../src/moves/preflight.js');

const AT = Date.parse('2026-11-19T12:00:00.000Z'), DAY = 86400_000, iso = ms => new Date(ms).toISOString();
const clone = value => structuredClone(value);
function base() {
  const facts = {
    routes: [{ proxy: 'nginx', domains: ['shop.example.com'], upstreams: ['http://127.0.0.1:8080'], containers: ['shop-web'], static: false, understood: true, listen: [80, 443], certificates: ['shop.example.com'] }],
    notUnderstood: [], proxies: [{ proxy: 'nginx', container: null, running: true }],
    containers: [{ name: 'shop-web', running: true, health: 'healthy', published: [] }],
    certificates: [{ source: 'certbot', name: 'shop.example.com', domains: ['shop.example.com', '*.shop.example.com'], notAfter: iso(AT + 60 * DAY), expired: false, renewal: 'ok' }],
    addresses: ['203.0.113.10'], port80: true, incomplete: false,
  };
  return {
    sites: [{ id: 'shop', serverId: 'a', kind: 'docker', domains: ['shop.example.com'], containers: ['shop-web'] }],
    servers: [{ id: 'a', addresses: ['203.0.113.10'], interfaces: ['203.0.113.10'], facts }, { id: 'b', addresses: ['198.51.100.20'], interfaces: ['198.51.100.20'], facts: null }],
    lookup: { at: iso(AT), resolvers: 2, addresses: ['203.0.113.10'], proxied: false, cloudflare: null },
    at: AT, certificateDays: 14,
  };
}
const facts = context => context.servers[0].facts, route = context => facts(context).routes[0], cert = context => facts(context).certificates[0];
const path = (change = () => {}, domain = 'shop.example.com') => { const context = base(); change(context); return domainPath(domain, context); };
const reason = ({ state, reason: code }) => `${state}:${code}`;

test('the healthy path is green on every hop, placed on its server and app', () => {
  const result = path();
  assert.deepEqual(Object.fromEntries(Object.entries(result.hops).map(([name, value]) => [name, reason(value)])), { dns: 'ok:points-to-server', proxy: 'ok:routed', app: 'ok:running', certificate: 'ok:valid' });
  assert.equal(result.serverId, 'a'); assert.equal(result.siteId, 'shop'); assert.equal(worstState(result.hops), 'ok');
  assert.deepEqual(result.hops.proxy.params, { proxy: 'nginx', serverId: 'a', upstream: 'http://127.0.0.1:8080' });
});

const cases = [
  // DNS
  ['dns', 'unknown:not-checked', c => { c.lookup = null; }],
  ['dns', 'unknown:dns-unreachable', c => { c.lookup.resolvers = 0; }],
  ['dns', 'fail:no-record', c => { c.lookup.addresses = []; }],
  ['dns', 'fail:wrong-record', c => { c.lookup.addresses = ['192.0.2.99']; }, hop => assert.deepEqual(hop.params, { address: '192.0.2.99' })],
  ['dns', 'fail:wrong-record', c => { c.lookup.addresses = ['203.0.113.10', '2001:db8::99']; }],
  ['dns', 'warn:cloudflare-proxied', c => { Object.assign(c.lookup, { addresses: ['192.0.2.200'], proxied: true }); }],
  ['dns', 'warn:cloudflare-token-expired', c => { Object.assign(c.lookup, { addresses: ['192.0.2.200'], proxied: true, cloudflare: { token: 'expired', missing: [], origin: null } }); }],
  ['dns', 'warn:cloudflare-token-limited', c => { Object.assign(c.lookup, { addresses: ['192.0.2.200'], proxied: true, cloudflare: { token: 'active', missing: ['Zone.DNS:Read'], origin: null } }); }, hop => assert.deepEqual(hop.params, { missing: ['Zone.DNS:Read'] })],
  ['dns', 'ok:cloudflare-origin', c => { Object.assign(c.lookup, { addresses: ['192.0.2.200'], proxied: true, cloudflare: { token: 'active', missing: [], origin: '203.0.113.10' } }); }],
  ['dns', 'fail:wrong-record', c => { Object.assign(c.lookup, { addresses: ['192.0.2.200'], proxied: true, cloudflare: { token: 'active', missing: [], origin: '192.0.2.77' } }); }],
  ['dns', 'warn:cgnat', c => { c.lookup.addresses = ['192.0.2.99']; c.servers[0].interfaces = ['192.168.1.20', '100.100.1.2']; }],
  // Proxy
  ['proxy', 'unknown:not-checked', c => { c.servers[0].facts = null; }],
  ['proxy', 'fail:no-route', c => { facts(c).routes = []; }],
  ['proxy', 'warn:route-unknown', c => { facts(c).routes = []; facts(c).notUnderstood = [{ proxy: 'traefik', container: 'forum-web', router: 'api' }]; }],
  ['proxy', 'warn:route-unknown', c => { facts(c).routes = []; facts(c).incomplete = true; }],
  ['proxy', 'ok:routed', c => { facts(c).notUnderstood = [{ proxy: 'traefik', container: 'forum-web', router: 'api' }]; }],
  ['proxy', 'fail:proxy-stopped', c => { facts(c).proxies[0].running = false; }],
  ['proxy', 'fail:routes-elsewhere', c => { route(c).containers = ['other-web']; }],
  ['proxy', 'fail:routes-elsewhere', c => { route(c).containers = []; }],
  ['proxy', 'warn:route-unknown', c => { route(c).upstreams = []; route(c).understood = false; }],
  ['proxy', 'warn:incomplete', c => { facts(c).incomplete = true; }],
  ['proxy', 'warn:no-app', c => { c.sites = []; }],
  ['proxy', 'ok:static', c => { Object.assign(route(c), { static: true, upstreams: [], containers: [] }); Object.assign(c.sites[0], { kind: 'static', containers: [] }); }],
  ['proxy', 'fail:routes-elsewhere', c => { Object.assign(route(c), { static: true, upstreams: [], containers: [] }); }],
  // App
  ['app', 'unknown:skipped', c => { route(c).containers = ['other-web']; }],
  ['app', 'unknown:no-app', c => { c.sites = []; }],
  ['app', 'ok:static', c => { Object.assign(route(c), { static: true, upstreams: [], containers: [] }); Object.assign(c.sites[0], { kind: 'static', containers: [] }); }],
  ['app', 'fail:missing', c => { facts(c).containers = []; }],
  ['app', 'fail:stopped', c => { facts(c).containers[0].running = false; }, hop => assert.deepEqual(hop.params, { container: 'shop-web' })],
  ['app', 'fail:unhealthy', c => { facts(c).containers[0].health = 'unhealthy'; }],
  ['app', 'warn:starting', c => { facts(c).containers[0].health = 'starting'; }],
  // Certificate
  ['certificate', 'unknown:skipped', c => { facts(c).routes = []; }],
  ['certificate', 'unknown:managed-by-proxy', c => { route(c).proxy = 'traefik'; facts(c).proxies[0].proxy = 'traefik'; }],
  ['certificate', 'unknown:not-readable', c => { facts(c).certificates = []; route(c).certificates = ['custom-chain.pem']; }],
  ['certificate', 'unknown:not-readable', c => { facts(c).certificates = []; route(c).certificates = []; }],
  ['certificate', 'fail:no-certificate', c => { facts(c).certificates = []; Object.assign(route(c), { certificates: [], listen: [80] }); }],
  ['certificate', 'fail:not-covered', c => { cert(c).domains = ['other.example.com']; }],
  ['certificate', 'fail:expired', c => { cert(c).notAfter = iso(AT - DAY); }],
  ['certificate', 'warn:expires-soon', c => { cert(c).notAfter = iso(AT + 3 * DAY + 1000); }, hop => assert.equal(hop.params.days, 3)],
  ['certificate', 'warn:renewal-port80', c => { Object.assign(cert(c), { renewal: 'failed', renewalCategory: 'connection-refused' }); facts(c).port80 = false; }],
  ['certificate', 'warn:renewal-failed', c => { Object.assign(cert(c), { renewal: 'failed', renewalCategory: 'timeout' }); facts(c).port80 = true; }, hop => assert.equal(hop.params.category, 'timeout')],
  ['certificate', 'warn:renewal-dns', c => { Object.assign(cert(c), { renewal: 'failed', renewalCategory: 'dns' }); }],
  ['certificate', 'warn:renewal-rate-limited', c => { Object.assign(cert(c), { renewal: 'failed', renewalCategory: 'rate-limited' }); }],
  ['certificate', 'warn:renewal-failed', c => { cert(c).renewal = 'failed'; }],
  ['certificate', 'ok:valid', c => { route(c).certificates = []; }],
  ['certificate', 'fail:expired', c => { facts(c).certificates.unshift({ source: 'tls', name: 'shop.example.com', domains: [], notAfter: null, expired: true, renewal: null }); }],
];
for (const [name, expected, change, extra] of cases) {
  test(`${name} hop: ${expected}`, () => {
    const hop = path(change).hops[name];
    assert.equal(reason(hop), expected);
    extra?.(hop);
  });
}

test('a wildcard certificate covers exactly one more label', () => {
  assert.equal(reason(path(c => { route(c).domains = ['api.shop.example.com']; route(c).certificates = []; c.sites[0].domains = ['api.shop.example.com']; }, 'api.shop.example.com').hops.certificate), 'ok:valid');
  assert.equal(reason(path(c => { route(c).domains = ['a.b.shop.example.com']; c.sites[0].domains = ['a.b.shop.example.com']; }, 'a.b.shop.example.com').hops.certificate), 'fail:not-covered');
  assert.equal(reason(path(c => { route(c).domains = ['a.b.shop.example.com']; route(c).certificates = []; c.sites[0].domains = ['a.b.shop.example.com']; }, 'a.b.shop.example.com').hops.certificate), 'unknown:not-readable', 'a certificate the route does not name may still cover it');
});

test('a proxy on one server can route to an app published on another connected server', () => {
  const result = path(c => {
    route(c).containers = []; route(c).upstreams = ['http://198.51.100.20:8080'];
    c.servers[1].facts = { ...clone(facts(c)), routes: [], containers: [{ name: 'shop-web', running: true, health: null, published: [8080] }], addresses: ['198.51.100.20'] };
    c.sites[0].serverId = 'b';
  });
  assert.equal(reason(result.hops.proxy), 'ok:routed'); assert.equal(result.hops.proxy.params.appServerId, 'b');
  assert.equal(reason(result.hops.app), 'ok:running'); assert.equal(result.siteId, 'shop'); assert.equal(result.serverId, 'a');
});

test('CGNAT versus Tailscale: a private or 100.64/10-only server is amber "may", never red; one public address keeps the red', () => {
  const servers = [{ id: 'home', addresses: ['192.168.1.20', '100.100.1.2'], interfaces: ['192.168.1.20', '100.100.1.2'], facts: null }];
  const lookup = { at: iso(AT), resolvers: 2, addresses: ['198.51.100.77'], proxied: false, cloudflare: null };
  assert.equal(reason(dnsHop(lookup, servers, 'home').hop), 'warn:cgnat');
  assert.equal(dnsHop(lookup, servers, 'home').serverId, 'home');
  // Tailscale only: still never red.
  servers[0].interfaces = ['100.101.102.103'];
  assert.equal(reason(dnsHop(lookup, servers, 'home').hop), 'warn:cgnat');
  // Tailscale beside a public address: DNS naming something else is wrong.
  servers[0].interfaces = ['100.101.102.103', '203.0.113.40'];
  assert.equal(reason(dnsHop(lookup, servers, 'home').hop), 'fail:wrong-record');
  // DNS that names the Tailscale address itself names this server.
  servers[0].addresses = ['100.101.102.103'];
  assert.equal(reason(dnsHop({ ...lookup, addresses: ['100.101.102.103'] }, servers, 'home').hop), 'ok:points-to-server');
  // Without any address facts DockNest cannot say the server hides behind NAT.
  assert.equal(reason(dnsHop(lookup, [{ id: 'home', addresses: [], interfaces: [], facts: null }], 'home').hop), 'fail:wrong-record');
  assert.equal(publicAddress('100.64.0.1'), false); assert.equal(publicAddress('203.0.113.40'), true); assert.equal(publicAddress('fd00::1'), false);
});

test('Points nowhere: domains whose DNS reaches no connected server are grouped apart, others by their server', () => {
  const rows = [
    { domain: 'shop.example.com', serverId: 'a', hops: path().hops },
    { domain: 'gone.example.com', serverId: null, hops: path(c => { c.lookup.addresses = ['192.0.2.99']; }, 'gone.example.com').hops },
    { domain: 'none.example.net', serverId: null, hops: path(c => { c.lookup.addresses = []; }, 'none.example.net').hops },
    { domain: 'new.example.net', serverId: null, hops: null },
  ];
  assert.deepEqual(groupDomains(rows), { servers: { a: ['shop.example.com'] }, pointsNowhere: ['gone.example.com', 'none.example.net'], unplaced: ['new.example.net'] });
  assert.equal(path(c => { c.lookup.addresses = ['192.0.2.99']; }).serverId, 'a', 'a red DNS hop still keeps the proxy server for the stepper');
});

test('Move listing: own domains, domains the source proxy routes to the app, and other servers proxies apart', () => {
  const context = base();
  facts(context).routes.push({ proxy: 'nginx', domains: ['www.shop.example.com'], upstreams: ['http://127.0.0.1:8080'], containers: ['shop-web'], static: false, understood: true, listen: [80], certificates: [] });
  facts(context).routes.push({ proxy: 'nginx', domains: ['blog.example.com'], upstreams: ['http://127.0.0.1:9000'], containers: ['blog-web'], static: false, understood: true, listen: [80], certificates: [] });
  context.servers[0].facts.containers.push({ name: 'shop-web', running: true, health: null, published: [8080] });
  context.servers.push({ id: 'edge', addresses: ['192.0.2.5'], interfaces: ['192.0.2.5'], facts: { ...clone(facts(context)), routes: [{ proxy: 'caddy', container: 'caddy', domains: ['shop.example.net'], upstreams: ['http://203.0.113.10:8080'], containers: [], static: false, understood: true, listen: [443], certificates: [] }], containers: [] } });
  context.servers[0].facts.containers = [{ name: 'shop-web', running: true, health: null, published: [8080] }];
  const site = context.sites[0];
  assert.deepEqual(movedDomains(site, 'a', context.servers, context.sites), { own: ['shop.example.com', 'www.shop.example.com'], viaProxy: [{ domain: 'shop.example.net', serverId: 'edge' }] });
});

const moveFacts = domainPaths => ({ site: { id: 's', name: 'Shop', kind: 'container', domains: ['shop.example.com'], packageBytes: 1, domainPaths }, source: { id: 'a', name: 'Server 1', ownership: { engine: { mode: 'none' }, modes: { checked: true, scanned: 1, truncated: false, findings: [] } } }, target: { id: 'b', name: 'Server 2', reachable: true, ownership: { engine: { mode: 'none' }, filesystem: { mounts: [], features: { setid: true, xattr: true } } }, uid: 0, freeBytes: 1e12, dockerVersion: '27.0.1', nginx: { installed: true, configOk: true, running: true, serverNames: [] }, certbot: { installed: true, account: true } }, dns: { mode: 'manual', records: [{ type: 'A', name: 'shop.example.com', value: '203.0.113.10' }] } });
test('the Move preview lists every domain that stops working as a warning, never a block', () => {
  const many = evaluateMove(moveFacts({ stopping: ['shop.example.com', 'www.shop.example.com', 'api.shop.example.com'], viaProxy: [{ domain: 'shop.example.net', proxy: 'Edge' }] }));
  const domains = many.details.checks.filter(check => check.id === 'domains');
  assert.deepEqual(domains.map(check => [check.status, check.text]), [
    ['warn', '3 domains stop working until DNS points to Server 2: shop.example.com, www.shop.example.com, api.shop.example.com.'],
    ['warn', 'shop.example.net reaches Shop through the proxy on Edge. The move does not change that proxy, so point it to Server 2 after the move.']]);
  assert.equal(many.canStart, true);
  const one = evaluateMove(moveFacts({ stopping: ['shop.example.com'], viaProxy: [] }));
  assert.deepEqual(one.details.checks.filter(check => check.id === 'domains').map(check => check.text), ['shop.example.com stops working until DNS points to Server 2.']);
  assert.equal(evaluateMove(moveFacts(undefined)).details.checks.some(check => check.id === 'domains'), false, 'no paths given, no listing');
});
