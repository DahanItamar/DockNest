// Domains on the Map: the tree (subdomain -> root domain -> server), moves that carry domains, and the drop rules
// (docs/domains.md, "Moving apps from the Map"). Named use cases first, then a seeded random run over many maps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutDomains, groupDomains, ownersOf, registrableOf } from '../web/map/domains-model.js';
import { dropVerdict, moveState, HINT } from '../web/map/domain-moves.js';
import { layoutMap, domainTree } from '../web/map/layout.js';

const server = (id, status = 'connected') => ({ id, name: id, status });
const site = (id, serverId, domains = []) => ({ id, name: id, serverId, config: { domains } });
const row = (domain, siteId = null) => ({ domain, siteId });
const view = (rows, place) => ({ domains: rows, groups: { servers: place, pointsNowhere: [], unplaced: [] } });
const SERVERS = [server('A'), server('B')], IDS = new Set(['A', 'B']);
const by = (list, id) => list.find(item => item.id === id);

test('1. root and www of one app on one server are one node', () => {
  const sites = [site('shop', 'A', ['example.com', 'www.example.com'])];
  const l = layoutDomains(view([row('example.com', 'shop'), row('www.example.com', 'shop')], { A: ['example.com', 'www.example.com'] }), IDS, { sites });
  assert.equal(l.length, 1);
  assert.deepEqual(l[0].aliases, ['www.example.com']);
  assert.equal(l[0].ownerSiteId, 'shop');
});

test('2. root on server A and subdomain on server B: no tree line, a caption instead', () => {
  const sites = [site('main', 'A', ['example.com']), site('leads', 'B', ['leads.example.com'])];
  const l = layoutDomains(view([row('example.com', 'main'), row('leads.example.com', 'leads')], { A: ['example.com'], B: ['leads.example.com'] }), IDS, { sites });
  assert.equal(by(l, 'leads.example.com').parentId, null);
  assert.equal(by(l, 'leads.example.com').partOf, 'example.com');
  const map = layoutMap(SERVERS, [], { domains: l });
  assert.ok(map.domainPaths.every(path => !path.parentId), 'only lines to servers');
  assert.equal(map.domainPaths.length, 2);
});

test('3. dragging a subdomain moves only its app; it leaves the tree while pending and rejoins when it is done', () => {
  const sites = [site('main', 'B', ['example.com']), site('leads', 'A', ['leads.example.com', 'www.leads.example.com'])];
  const rows = [row('example.com', 'main'), row('leads.example.com', 'leads'), row('www.leads.example.com', 'leads')], place = { B: ['example.com'], A: ['leads.example.com', 'www.leads.example.com'] };
  const verdict = dropVerdict({ domain: 'leads.example.com', rows, sites, servers: SERVERS, targetServerId: 'B', moves: [] });
  assert.deepEqual(verdict, { ok: true, siteId: 'leads' });
  const at = ctx => by(layoutDomains(view(rows, place), IDS, { sites, ...ctx }), 'leads.example.com');
  assert.equal(at({}).partOf, 'example.com');
  const moving = at(moveState([{ siteId: 'leads', targetServerId: 'B', state: 'running' }]));
  assert.deepEqual([moving.serverId, moving.pending, moving.parentId], ['B', true, null], 'dashed to the new server, outside the tree');
  const moved = [{ ...sites[0] }, { ...sites[1], serverId: 'B' }];
  const finished = at({ ...moveState([{ siteId: 'leads', targetServerId: 'B', state: 'done' }]), sites: moved });
  assert.deepEqual([finished.serverId, finished.pending, finished.parentId], ['B', false, 'example.com'], 'back in the tree once both are on one server');
});

test('4. dragging a root moves only its own app; subdomains of other apps stay and rewire', () => {
  const sites = [site('main', 'A', ['example.com']), site('docs', 'A', ['docs.example.com'])];
  const rows = [row('example.com', 'main'), row('docs.example.com', 'docs')], place = { A: ['example.com', 'docs.example.com'] };
  assert.deepEqual(dropVerdict({ domain: 'example.com', rows, sites, servers: SERVERS, targetServerId: 'B', moves: [] }), { ok: true, siteId: 'main' });
  const l = layoutDomains(view(rows, place), IDS, { sites, ...moveState([{ siteId: 'main', targetServerId: 'B', state: 'running' }]) });
  assert.deepEqual([by(l, 'example.com').serverId, by(l, 'example.com').pending], ['B', true]);
  assert.deepEqual([by(l, 'docs.example.com').serverId, by(l, 'docs.example.com').parentId, by(l, 'docs.example.com').partOf], ['A', null, 'example.com']);
  assert.equal(by(layoutDomains(view(rows, place), IDS, { sites }), 'docs.example.com').parentId, 'example.com', 'before the move it hangs under the root');
});

test('5. a www alias that belongs to another app is not merged', () => {
  const sites = [site('main', 'A', ['example.com']), site('promo', 'A', ['www.example.com'])];
  const l = layoutDomains(view([row('example.com', 'main'), row('www.example.com', 'promo')], { A: ['example.com', 'www.example.com'] }), IDS, { sites });
  assert.deepEqual(l.map(d => d.id).sort(), ['example.com', 'www.example.com']);
  assert.deepEqual(l.map(d => d.aliases), [[], []]);
});

test('6. a nested subdomain hangs under the nearest ancestor on the same server', () => {
  const names = ['a.b.example.com', 'b.example.com', 'example.com'], rows = names.map(name => row(name));
  const same = layoutDomains(view(rows, { A: names }), IDS);
  assert.equal(by(same, 'a.b.example.com').parentId, 'b.example.com');
  assert.equal(by(same, 'b.example.com').parentId, 'example.com');
  const split = layoutDomains(view(rows, { A: ['a.b.example.com', 'example.com'], B: ['b.example.com'] }), IDS);
  assert.equal(by(split, 'a.b.example.com').parentId, 'example.com', 'skips the ancestor on another server');
  const alone = layoutDomains(view(rows.slice(0, 1), { A: ['a.b.example.com'] }), IDS);
  assert.equal(alone[0].parentId, null);
  const tree = layoutMap(SERVERS, [], { domains: same });
  const xs = names.map(name => by(tree.domains, name).x);
  assert.ok(xs[0] < xs[1] && xs[1] < xs[2], 'one column per level, deepest on the left');
});

test('7. a co.il domain is a root; the suffix is never a parent', () => {
  assert.equal(registrableOf('shop.example.co.il'), 'example.co.il');
  const names = ['co.il', 'example.co.il', 'shop.example.co.il', 'www.example.co.il'], l = layoutDomains(view(names.map(name => row(name)), { A: names }), IDS);
  assert.equal(by(l, 'example.co.il').parentId, null, 'example.co.il is the root');
  assert.equal(by(l, 'shop.example.co.il').parentId, 'example.co.il');
  assert.equal(by(l, 'co.il').parentId, null);
  assert.ok(!l.some(d => d.parentId === 'co.il'));
  assert.deepEqual(by(l, 'example.co.il').aliases, ['www.example.co.il']);
});

test('8. every refused drop says why and changes nothing', () => {
  const sites = [site('one', 'A', ['solo.example.com', 'shared.example.com']), site('two', 'A', ['shared.example.com']), site('three', 'A', ['three.example.com'])];
  const rows = [row('solo.example.com', 'one'), row('shared.example.com', 'one'), row('free.example.com'), row('three.example.com', 'three')];
  const servers = [server('A'), server('B'), server('C', 'unreachable')], moves = [{ siteId: 'three', targetServerId: 'B', state: 'switching' }];
  const input = { rows, sites, servers, moves }, before = JSON.stringify(input);
  const ask = (domain, targetServerId) => dropVerdict({ ...input, domain, targetServerId });
  assert.deepEqual(ask('free.example.com', 'B'), { ok: false, reason: 'none', hint: 'This domain moves with its app. Add the app first.' });
  assert.deepEqual(ask('shared.example.com', 'B'), { ok: false, reason: 'several', hint: 'Used by several apps; move the app instead.' });
  assert.equal(ask('solo.example.com', 'A').reason, 'same');
  assert.equal(ask('solo.example.com', 'C').reason, 'offline');
  assert.equal(ask('three.example.com', 'B').reason, 'running');
  assert.equal(dropVerdict({ ...input, siteId: 'three', targetServerId: 'B' }).reason, 'running', 'an app drag is refused the same way');
  assert.deepEqual(ask('solo.example.com', 'B'), { ok: true, siteId: 'one' });
  assert.equal(JSON.stringify(input), before, 'nothing was changed');
  assert.ok(Object.values(HINT).every(text => text.length > 8 && text.length < 80), 'hints are short');
});

test('9. a domain with a static route and no app cannot be dragged', () => {
  const rows = [row('static.example.com')];
  assert.deepEqual(ownersOf('static.example.com', rows, [site('x', 'A')]), []);
  assert.equal(dropVerdict({ domain: 'static.example.com', rows, sites: [site('x', 'A')], servers: SERVERS, targetServerId: 'B' }).hint, HINT.none);
});

test('10. a cancelled or switched-back move puts the domains back', () => {
  const sites = [site('shop', 'A', ['example.com'])], rows = [row('example.com', 'shop')], v = view(rows, { A: ['example.com'] });
  for (const state of ['cancelled', 'switched_back', 'rolled_back', 'failed']) {
    const l = layoutDomains(v, IDS, { sites, ...moveState([{ siteId: 'shop', targetServerId: 'B', state }]) });
    assert.deepEqual([l[0].serverId, l[0].pending], ['A', false], state);
  }
  assert.equal(layoutDomains(v, IDS, { sites, ...moveState([{ siteId: 'shop', targetServerId: 'B', state: 'cancelled' }], null) })[0].serverId, 'A');
});

test('11. a finished move leaves the domains at the new server', () => {
  const sites = [site('shop', 'B', ['example.com', 'www.example.com'])], rows = [row('example.com', 'shop'), row('www.example.com', 'shop')];
  const l = layoutDomains(view(rows, { A: ['example.com', 'www.example.com'] }), IDS, { sites, ...moveState([{ siteId: 'shop', targetServerId: 'B', state: 'done' }]) });
  assert.deepEqual([l[0].serverId, l[0].pending, l[0].aliases], ['B', false, ['www.example.com']]);
  const map = layoutMap(SERVERS, [], { domains: l });
  assert.equal(map.domainPaths[0].serverId, 'B');
});

test('12. no domains', () => {
  assert.deepEqual(layoutDomains({ domains: [] }, IDS), []);
  assert.deepEqual(layoutDomains(null, IDS), []);
  const map = layoutMap(SERVERS, [], { domains: [] });
  assert.deepEqual([map.domains.length, map.domainPaths.length], [0, 0]);
  assert.equal(map.servers[0].in, undefined, 'no input dot without domains');
});

test('13. fifty domains on one server stay readable', () => {
  const names = Array.from({ length: 40 }, (_, i) => `site${i}.example.net`).concat(Array.from({ length: 10 }, (_, i) => `s${i}.site0.example.net`));
  const l = layoutDomains(view(names.map(name => row(name)), { A: names }), IDS), map = layoutMap(SERVERS, [], { domains: l });
  assert.equal(map.domains.length, 50);
  const boxes = map.domains.map(n => n.block);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlap(boxes[i], boxes[j]), `${i} overlaps ${j}`);
  assert.ok(map.domains.every(n => n.block.x >= 0 && n.block.y >= 0 && n.block.y + n.block.h <= map.height + 1), 'inside the canvas');
  assert.equal(map.domainPaths.filter(path => path.serverId).length, 40, 'only roots reach the server');
  assert.deepEqual(layoutMap(SERVERS, [], { domains: l }), map, 'the same input gives the same map');
});

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ---- Random maps. Seeded, so a failure can be repeated: DOMAIN_FUZZ_SEED=<seed> node --test tests/domains-moves.test.js ----
const rng = seed => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const BASES = ['example.com', 'test.co.il', 'mysite.org', 'brand.co.uk', 'shop.com.au', 'x.io'], PREFIXES = ['', 'www', 'a', 'b', 'a.b', 'www.a', 'docs', 'leads', 'c.a.b'];
const STATES = ['running', 'waiting_dns', 'done', 'cancelled', 'switched_back', 'failed', 'cleaned', 'needs_attention'];

function generate(seed) {
  const r = rng(seed), pick = list => list[Math.floor(r() * list.length)], int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const servers = Array.from({ length: int(1, 6) }, (_, i) => server('s' + i, r() < 0.15 ? 'unreachable' : 'connected'));
  const names = [...new Set(Array.from({ length: int(0, 30) }, () => [pick(PREFIXES), pick(BASES)].filter(Boolean).join('.')))];
  const sites = Array.from({ length: int(0, 8) }, (_, i) => ({ id: 'app' + i, name: 'App ' + i, serverId: r() < 0.1 ? null : pick(servers).id, config: { domains: names.filter(() => r() < 0.25) } }));
  const rows = names.map(name => ({ domain: name, siteId: r() < 0.6 && sites.length ? pick(sites).id : null }));
  const place = {}, nowhere = [];
  for (const name of names) { const k = r(); if (k < 0.8) (place[pick(servers).id] ||= []).push(name); else if (k < 0.9) nowhere.push(name); }
  const moves = Array.from({ length: int(0, 4) }, (_, i) => ({ id: 'm' + i, siteId: sites.length ? pick(sites).id : 'gone', targetServerId: pick(servers).id, state: pick(STATES) }));
  const edit = r() < 0.2 && sites.length ? { siteId: pick(sites).id, targetId: pick(servers).id } : null;
  return { seed, servers, sites, rows, place, nowhere, moves, edit };
}
function build(c) {
  const ids = new Set(c.servers.map(s => s.id)), v = { domains: c.rows, groups: { servers: c.place, pointsNowhere: c.nowhere, unplaced: [] } };
  const domains = layoutDomains(v, ids, { sites: c.sites, ...moveState(c.moves, c.edit) });
  return { domains, map: layoutMap(c.servers, c.sites, { domains }) };
}
// Returns a sentence for the first broken rule, or ''.
function broken(c) {
  let built;
  try { built = build(c); } catch (error) { return 'threw: ' + (error.stack || error); }
  const { domains, map } = built, node = Object.fromEntries(map.domains.map(n => [n.id, n]));
  for (const path of map.domainPaths) {
    if (/NaN|undefined|Infinity/.test(path.d) || path.points.some(p => !p.every(Number.isFinite))) return 'bad path ' + path.id;
    const from = node[path.id];
    if (!from) return 'a line without a node ' + path.id;
    if (path.points[0][0] !== from.out.x || path.points[0][1] !== from.out.y) return 'a line does not start on the output dot of ' + path.id;
    const last = path.points.at(-1);
    if (path.stub) continue;
    const target = path.parentId ? node[path.parentId] : map.servers.find(s => s.id === path.serverId);
    if (!target || !target.in) return 'a line ends nowhere ' + path.id;
    if (last[0] !== target.in.x || last[1] !== target.in.y) return 'a line does not end on an input dot ' + path.id;
    if (path.parentId) { const child = domains.find(d => d.id === path.id), parent = domains.find(d => d.id === path.parentId), side = d => d.serverId || 'loose:' + d.loose; if (side(child) !== side(parent)) return 'a line crosses to another server ' + path.id; }
  }
  const lines = {};
  for (const path of map.domainPaths) { lines[path.id] = (lines[path.id] || 0) + 1; if (lines[path.id] > 1) return 'two outgoing lines ' + path.id; }
  for (const d of domains) { let p = d.parentId, steps = 0; while (p) { if (++steps > 100) return 'cycle at ' + d.id; p = domains.find(x => x.id === p)?.parentId; } }
  const boxes = [...map.domains.map(n => [n.id, n.block]), ...map.servers.map(n => [n.id, n.block]), ...map.sites.map(n => [n.id, n.block])];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlap(boxes[i][1], boxes[j][1])) return `overlap ${boxes[i][0]} ${boxes[j][0]}`;
  if (JSON.stringify(build(c).map) !== JSON.stringify(map)) return 'not deterministic';
  for (const name of c.rows.map(r => r.domain).slice(0, 6)) for (const target of c.servers.slice(0, 3)) {
    const input = { domain: name, rows: c.rows, sites: c.sites, servers: c.servers, targetServerId: target.id, moves: c.moves }, before = JSON.stringify(input), v = dropVerdict(input);
    if (JSON.stringify(input) !== before) return 'a drop changed its input';
    if (!v.ok && !(typeof v.hint === 'string' && v.hint)) return 'a refusal without a hint';
    if (v.ok) { const s = c.sites.find(x => x.id === v.siteId); if (!s || s.serverId === target.id || target.status !== 'connected') return 'an accepted drop that should be refused ' + name; }
  }
  return '';
}
function shrink(c) {
  let cur = c;
  for (let pass = 0; pass < 3; pass++) for (const key of ['rows', 'sites', 'moves']) for (let i = cur[key].length - 1; i >= 0; i--) {
    const next = { ...cur, [key]: cur[key].filter((_, k) => k !== i) };
    if (broken(next)) cur = next;
  }
  return cur;
}

test('random maps keep every rule (seeded, 600 cases)', () => {
  const start = process.env.DOMAIN_FUZZ_SEED ? Number(process.env.DOMAIN_FUZZ_SEED) : 20261122, count = process.env.DOMAIN_FUZZ_SEED ? 1 : 600;
  for (let i = 0; i < count; i++) {
    const seed = start + i, c = generate(seed), problem = broken(c);
    if (problem) assert.fail(`seed ${seed}: ${problem}\nrepeat: DOMAIN_FUZZ_SEED=${seed} node --test tests/domains-moves.test.js\nsmallest case: ${JSON.stringify(shrink(c))}`);
  }
});

test('the tree helper never loops, whatever the parents say', () => {
  const doms = [{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'c' }, { id: 'd', parentId: 'missing' }];
  const { par, maxDepth } = domainTree(doms);
  assert.deepEqual(par, { a: null, b: null, c: null, d: null });
  assert.equal(maxDepth, 0);
  assert.deepEqual(groupDomains([]).nodes, []);
});
