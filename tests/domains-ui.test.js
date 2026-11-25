import test from 'node:test';
import assert from 'node:assert/strict';
import { registrableOf, groupDomains, groupStatus, hopText, pathRows, domainStatus, layoutDomains, lineState, checkedText, isDomainWarning } from '../web/map/domains-model.js';
import { layoutMap } from '../web/map/layout.js';
import { cleanPositions } from '../web/map/saved-layout.js';

const hop = (state, reason, params) => ({ state, reason, ...(params ? { params } : {}) });
const ctx = { serverName: id => ({ s1: 'Server 1', s2: 'Server 2' }[id] || 'the server'), siteName: 'Shop' };
const row = (hops, extra = {}) => ({ domain: 'shop.example.invalid', serverId: 's1', siteId: 'a', hops, checkedAt: '2026-11-21T09:00:00Z', trigger: 'backup', ...extra });

test('every failing or amber reason says what to do', () => {
  const cases = [['dns', hop('fail', 'no-record')], ['dns', hop('fail', 'wrong-record', { address: '192.0.2.99' })], ['dns', hop('warn', 'cloudflare-proxied')],
    ['dns', hop('warn', 'cloudflare-token-expired')], ['dns', hop('warn', 'cloudflare-token-limited', { missing: ['Zone.DNS:Read'] })], ['dns', hop('warn', 'cgnat', { address: '198.51.100.7' })],
    ['proxy', hop('fail', 'no-route')], ['proxy', hop('fail', 'routes-elsewhere', { proxy: 'nginx', upstream: 'http://x:1' })], ['proxy', hop('fail', 'proxy-stopped', { proxy: 'caddy' })], ['proxy', hop('warn', 'route-unknown')], ['proxy', hop('warn', 'static-no-app', { proxy: 'nginx', root: '/var/www/site' })], ['proxy', hop('warn', 'incomplete', { proxy: 'traefik' })],
    ['app', hop('fail', 'stopped', { container: 'web' })], ['app', hop('fail', 'unhealthy', { container: 'web' })], ['app', hop('fail', 'missing', { container: 'web' })],
    ['certificate', hop('fail', 'expired', { name: 'a', notAfter: '2026-01-01T00:00:00Z' })], ['certificate', hop('fail', 'not-covered', { name: 'a' })], ['certificate', hop('fail', 'no-certificate')],
    ['certificate', hop('warn', 'renewal-port80', { name: 'a', notAfter: '2027-01-01T00:00:00Z' })], ['certificate', hop('warn', 'renewal-dns', { name: 'a' })], ['certificate', hop('warn', 'expires-soon', { name: 'a', days: 3 })]];
  for (const [name, h] of cases) {
    const t = hopText(name, h, ctx);
    assert.ok(t.next, `${name} ${h.reason} has a next step`);
    assert.notEqual(t.state, 'success');
    assert.ok(!/undefined|\[object/.test(JSON.stringify(t)), `${h.reason} has no stray values`);
  }
});
test('hops that are fine or skipped need no next step', () => {
  assert.equal(hopText('dns', hop('ok', 'points-to-server', { addresses: ['192.0.2.10'], serverId: 's1' }), ctx).detail, '192.0.2.10 (Server 1), the same on both public resolvers.');
  assert.equal(hopText('proxy', hop('unknown', 'skipped'), ctx).state, 'queued');
  assert.equal(hopText('certificate', hop('unknown', 'managed-by-proxy', { proxy: 'caddy' }), ctx).detail, 'Caddy keeps its own certificates, so DockNest does not read them.');
  assert.equal(hopText('dns', null, ctx).detail, 'Not checked yet');
});
test('the path always has the domain row and four steps; a never-checked domain has none checked', () => {
  const rows = pathRows(row(null), ctx);
  assert.deepEqual(rows.map(r => r.k), ['domain', 'dns', 'proxy', 'app', 'certificate']);
  assert.deepEqual(rows.slice(1).map(r => r.state), ['queued', 'queued', 'queued', 'queued']);
});
test('a domain status is its worst step; checking and an error override', () => {
  const good = { dns: hop('ok', 'points-to-server'), proxy: hop('ok', 'routed'), app: hop('ok', 'running'), certificate: hop('ok', 'valid') };
  assert.equal(domainStatus(row(good)), 'success');
  assert.equal(domainStatus(row({ ...good, certificate: hop('warn', 'expires-soon') })), 'needs-review');
  assert.equal(domainStatus(row({ ...good, dns: hop('fail', 'no-record'), proxy: hop('unknown', 'skipped') })), 'failed');
  assert.equal(domainStatus(row(null)), 'queued');
  assert.equal(domainStatus(row(good), { checking: true }), 'running');
  assert.equal(domainStatus(row(good), { error: 'x' }), 'needs-review');
  assert.equal(lineState('failed'), 'er');
});
test('the time of a check is shown with what started it', () => {
  const now = Date.parse('2026-11-21T12:00:00Z');
  assert.equal(checkedText(row({}), now), 'Checked 3 hours ago, during a backup');
  assert.equal(checkedText({ checkedAt: '2026-11-21T11:59:40Z', trigger: 'manual' }, now), 'Checked just now, when you checked');
  assert.equal(checkedText({ checkedAt: null }, now), '');
});
test('domain warnings of a move are told apart from the others', () => {
  assert.equal(isDomainWarning({ id: 'domains', advanced: false }), true);
  assert.equal(isDomainWarning({ id: 'dns', advanced: true }), false);
});
test('layout input follows the API groups', () => {
  const view = { domains: [{ domain: 'a.example.invalid' }, { domain: 'b.example.invalid' }, { domain: 'c.example.invalid' }], groups: { servers: { s1: ['a.example.invalid'] }, pointsNowhere: ['b.example.invalid'], unplaced: ['c.example.invalid'] } };
  assert.deepEqual(layoutDomains(view, new Set(['s1'])), [{ id: 'a.example.invalid', aliases: [], parentId: null, partOf: null, serverId: 's1', loose: 'unplaced', pending: false, ownerSiteId: null }, { id: 'b.example.invalid', aliases: [], parentId: null, partOf: null, serverId: null, loose: 'nowhere', pending: false, ownerSiteId: null }, { id: 'c.example.invalid', aliases: [], parentId: null, partOf: null, serverId: null, loose: 'unplaced', pending: false, ownerSiteId: null }]);
  assert.deepEqual(layoutDomains(view, new Set()).map(d => d.serverId), [null, null, null]);
});

const servers = [{ id: 's1', name: 'One' }, { id: 's2', name: 'Two' }];
const sites = [{ id: 'a', serverId: 's1', name: 'A' }, { id: 'b', serverId: 's2', name: 'B' }];
const domains = ['a', 'b', 'c', 'd', 'e'].map((c, i) => ({ id: c + '.example.invalid', serverId: i < 3 ? 's1' : i === 3 ? 's2' : null, loose: i === 4 ? 'nowhere' : 'unplaced' })).concat([{ id: 'f.example.invalid', serverId: null, loose: 'unplaced' }]);
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
test('layout without domains is unchanged', () => {
  assert.deepEqual(layoutMap(servers, sites, { domains: [] }), layoutMap(servers, sites, {}));
  assert.deepEqual(layoutMap(servers, sites).domains, []);
});
test('domains sit left of their servers, never overlap and every line ends at its server', () => {
  const l = layoutMap(servers, sites, { domains });
  assert.equal(l.domains.length, 6);
  const all = [...l.servers, ...l.sites, ...l.domains];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) assert.ok(!overlap(all[i].block, all[j].block), `${all[i].id} overlaps ${all[j].id}`);
  for (const n of l.domains) assert.ok(n.block.x >= 0 && n.x + n.w < l.servers[0].x, 'left of the servers, inside the canvas');
  assert.equal(l.domainPaths.filter(p => p.serverId).length, 4);
  assert.deepEqual(l.domainPaths.filter(p => p.stub).map(p => p.stub).sort(), ['nowhere', 'unplaced']);
  assert.deepEqual(l.nowhere.map(h => h.title), ['Points nowhere', 'Not placed yet']);
  for (const p of l.domainPaths.filter(p => p.serverId)) {
    const s = l.servers.find(x => x.id === p.serverId), end = p.points.at(-1);
    assert.ok(end[0] <= s.x && end[1] >= s.y && end[1] <= s.y + s.h, 'enters its own server');
  }
  assert.equal(layoutMap(servers, sites, { domains: [...domains].reverse() }).domainPaths.length, l.domainPaths.length);
});
test('a moved domain node keeps its place and its line follows; its group title goes', () => {
  const free = layoutMap(servers, sites, { domains, positions: { 'domain:a.example.invalid': { x: 400, y: 20 }, 'domain:e.example.invalid': { x: 0, y: 900 } } });
  assert.ok(free.custom);
  assert.equal(free.keys['domain:a.example.invalid'].x, 400);
  const moved = free.keys['domain:a.example.invalid'].out;
  assert.deepEqual(free.domainPaths.find(p => p.id === 'a.example.invalid').points[0], [moved.x, moved.y]);
  assert.deepEqual(free.nowhere.map(h => h.kind), ['unplaced']);
});
test('saved domain positions are kept and bad ones are dropped', () => {
  assert.deepEqual(cleanPositions({ 'domain:a.example.invalid': { x: 1, y: 2 }, 'thing:x': { x: 1, y: 2 } }), { 'domain:a.example.invalid': { x: 1, y: 2 } });
});

test('registrable domain handles two-part suffixes', () => {
  assert.equal(registrableOf('leads.example.com'), 'example.com');
  assert.equal(registrableOf('a.b.example.com'), 'example.com');
  assert.equal(registrableOf('example.com'), 'example.com');
  assert.equal(registrableOf('shop.example.co.il'), 'example.co.il');
  assert.equal(registrableOf('www.example.co.uk'), 'example.co.uk');
  assert.equal(registrableOf('example.co.il'), 'example.co.il');
});
test('www merges into its root, subdomains hang under the root domain', () => {
  const rows = ['www.example.com', 'example.com', 'leads.example.com', 'www.leads.example.com', 'www.solo.invalid', 'x.other.invalid'].map(domain => ({ domain }));
  const g = groupDomains(rows);
  assert.deepEqual(g.nodes.map(n => n.id), ['example.com', 'leads.example.com', 'www.solo.invalid', 'x.other.invalid']);
  assert.deepEqual(g.nodes[0].aliases, ['www.example.com']);
  assert.deepEqual(g.nodes[1].names, ['leads.example.com', 'www.leads.example.com']);
  assert.deepEqual(g.parentOf, { 'leads.example.com': 'example.com' }, 'a subdomain whose parent is not on the Map goes straight to the server');
  assert.equal(g.nodeOf['www.example.com'], 'example.com');
  const view = { domains: rows, groups: { servers: { s1: rows.map(r => r.domain) }, pointsNowhere: [] } };
  const l = layoutDomains(view, new Set(['s1']));
  assert.equal(l.length, 4); assert.equal(l[1].parentId, 'example.com'); assert.equal(l[0].serverId, 's1');
});
test('a merged node shows the worst status of its names', () => {
  const rows = { a: { s: 'success' }, b: { s: 'failed' } };
  assert.equal(groupStatus(['a', 'b'], rows, r => r.s), 'failed');
  assert.equal(groupStatus(['a'], rows, r => r.s), 'success');
  assert.equal(groupStatus(['a', 'b'], rows, r => (r === rows.b ? 'running' : 'success')), 'running');
});
test('tree layout: subdomains left of the root, one input dot on the server, no per-line arrowhead data', () => {
  const doms = [{ id: 'example.com', serverId: 's1', parentId: null }, ...['a', 'b', 'c'].map(n => ({ id: n + '.example.com', serverId: 's1', parentId: 'example.com' })), { id: 'solo.example.net', serverId: 's1', parentId: null }];
  const l = layoutMap([{ id: 's1', name: 'S' }], [], { domains: doms });
  const byId = Object.fromEntries(l.domains.map(n => [n.id, n])), server = l.servers[0];
  assert.deepEqual(server.in, { x: server.x, y: server.y + server.h / 2 });
  for (const s of ['a', 'b', 'c']) assert.ok(byId[s + '.example.com'].x + byId[s + '.example.com'].w < byId['example.com'].x, 'subdomains left of the root');
  const root = byId['example.com'], mid = (byId['a.example.com'].cy + byId['c.example.com'].cy) / 2;
  assert.equal(root.cy, mid, 'the root is centred on its subdomains');
  assert.deepEqual(root.in, { x: root.x, y: root.cy });
  const serverLines = l.domainPaths.filter(p => p.serverId), subLines = l.domainPaths.filter(p => p.parentId);
  assert.deepEqual(serverLines.map(p => p.id).sort(), ['example.com', 'solo.example.net'], 'only root domains reach the server');
  assert.equal(subLines.length, 3);
  for (const p of serverLines) assert.deepEqual(p.points.at(-1), [server.in.x, server.in.y], 'every line ends at the dot');
  for (const p of subLines) assert.deepEqual(p.points.at(-1), [root.in.x, root.in.y]);
  const moved = layoutMap([{ id: 's1', name: 'S' }], [], { domains: doms, positions: { 'domain:example.com': { x: root.x + 40, y: root.y + 80 } } });
  const p = moved.domainPaths.find(q => q.id === 'a.example.com'), r2 = moved.domains.find(n => n.id === 'example.com');
  assert.deepEqual(p.points.at(-1), [r2.in.x, r2.in.y], 'lines follow a moved root');
});
