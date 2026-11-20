// Linked apps (docs/linked-apps.md): links between apps computed from discovery facts, strongest kind per pair, the
// containers no app backs up, and the database rule shared with the remote helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeAppLinks, linksOfApp, LINK_KINDS, HUB_APPS, MAX_GROUP, MAX_EVIDENCE } from '../shared/app-links.js';
import { imageLooksLikeDatabase, containerIsDatabase } from '../shared/database-image.js';

const fact = (name, fields = {}) => ({ name, image: 'demo/app:1', project: null, service: null, networks: [], volumes: [], binds: [], links: [], dependsOn: [], ...fields });
const on = (...names) => names;
// Owners by container name, as the server's lookup returns them.
const owners = map => name => (map[name] ? { siteId: map[name], name: map[name] } : null);
const byImage = container => imageLooksLikeDatabase(container.image);
const compute = (facts, map) => computeAppLinks(facts, owners(map), byImage);

test('kinds are ordered strongest first', () => assert.deepEqual(LINK_KINDS, ['volume', 'link', 'database', 'network']));

test('empty, missing and single-app facts give no links', () => {
  assert.deepEqual(computeAppLinks([], owners({}), byImage), { links: [], unowned: [], hubs: [], partial: false });
  assert.deepEqual(computeAppLinks(undefined, owners({}), byImage), { links: [], unowned: [], hubs: [], partial: false });
  const facts = [fact('web', { networks: on('shop-net'), volumes: ['uploads'] }), fact('db', { image: 'postgres:16', networks: on('shop-net'), volumes: ['uploads'] })];
  assert.deepEqual(compute(facts, { web: 'shop', db: 'shop' }), { links: [], unowned: [], hubs: [], partial: false }, 'containers of one app never link it to itself');
});

test('default networks are ignored', () => {
  const facts = [fact('a', { networks: on('bridge', 'host', 'none') }), fact('b', { networks: on('bridge', 'host', 'none') })];
  assert.deepEqual(compute(facts, { a: 'shop', b: 'blog' }).links, []);
});

test('three apps on one network give three network links', () => {
  const facts = ['a', 'b', 'c'].map(name => fact(name, { networks: on('proxy') }));
  const { links } = compute(facts, { a: 'app-a', b: 'app-b', c: 'app-c' });
  assert.deepEqual(links.map(link => [link.appIds, link.kind, link.via]), [[['app-a', 'app-b'], 'network', 'proxy'], [['app-a', 'app-c'], 'network', 'proxy'], [['app-b', 'app-c'], 'network', 'proxy']]);
  assert.deepEqual(links[0].details, [{ kind: 'network', via: 'proxy', containers: ['a', 'b'] }]);
});

test('a database shared by three apps: the owner and two users', () => {
  const facts = [fact('pg', { image: 'postgres:16', networks: on('data') }), fact('shop-web', { networks: on('data') }), fact('blog-web', { networks: on('data') })];
  const view = compute(facts, { pg: 'db-app', 'shop-web': 'shop', 'blog-web': 'blog' });
  assert.deepEqual(view.links.map(link => [link.appIds, link.kind, link.via]), [
    [['blog', 'db-app'], 'database', 'pg'], [['blog', 'shop'], 'network', 'data'], [['db-app', 'shop'], 'database', 'pg']]);
  assert.deepEqual(view.unowned, []);
  assert.deepEqual(linksOfApp(view, 'db-app').links.map(link => link.otherAppId), ['blog', 'shop']);
  assert.deepEqual(linksOfApp(view, 'shop').links.map(link => [link.kind, link.otherAppId]), [['database', 'db-app'], ['network', 'blog']], 'strongest first');
});

test('the strongest kind wins and every reason stays in the details', () => {
  const facts = [fact('web', { networks: on('net'), volumes: ['media'], links: ['api'] }), fact('api', { image: 'mysql:8.4', networks: on('net'), volumes: ['media'] })];
  const [link] = compute(facts, { web: 'shop', api: 'blog' }).links;
  assert.equal(link.kind, 'volume'); assert.equal(link.via, 'media');
  assert.deepEqual(link.details.map(detail => [detail.kind, detail.via]), [['volume', 'media'], ['link', 'api'], ['database', 'api']]);
});

test('a shared bind folder links two apps; system files and the engine socket do not', () => {
  const system = ['/etc/localtime', '/etc/timezone', '/var/run/docker.sock', '/run/docker.sock', '/proc', '/dev/dri', '/', '/etc/ssl/certs'];
  const facts = [fact('a', { binds: ['/srv/media', ...system] }), fact('b', { binds: ['/srv/media/', '/srv/other', ...system] }), fact('c', { binds: system })];
  assert.deepEqual(compute(facts, { a: 'app-a', b: 'app-b', c: 'app-c' }).links.map(link => [link.appIds, link.kind, link.via]), [[['app-a', 'app-b'], 'volume', '/srv/media']], 'a trailing slash is the same folder');
});

test('same Compose project split over two apps: depends_on resolves by service within the project only', () => {
  const facts = [fact('shop-web-1', { project: 'shop', service: 'web', dependsOn: ['db'] }), fact('shop-db-1', { project: 'shop', service: 'db', image: 'redis:7' }),
    fact('blog-db-1', { project: 'blog', service: 'db' })];
  const view = compute(facts, { 'shop-web-1': 'shop-front', 'shop-db-1': 'shop-data', 'blog-db-1': 'blog' });
  assert.deepEqual(view.links.map(link => [link.appIds, link.kind, link.via]), [[['shop-data', 'shop-front'], 'link', 'shop-db-1']]);
  assert.deepEqual(compute([facts[0], fact('db', { service: 'db' })], { 'shop-web-1': 'a', db: 'b' }).links, [], 'no project: no depends_on match');
});

test('containers no app backs up are reported when an app depends on them', () => {
  const facts = [fact('web', { links: ['cache'], networks: on('net'), volumes: ['files'] }), fact('cache'), fact('pg', { image: 'postgres:16', networks: on('net') }),
    fact('sidecar', { volumes: ['files'] }), fact('stray', { networks: on('net') }), fact('watcher', { links: ['web'] })];
  const view = compute(facts, { web: 'shop' });
  assert.deepEqual(view.links, []);
  assert.deepEqual(view.unowned.map(entry => [entry.container, entry.appIds, entry.kind, entry.via]), [
    ['cache', ['shop'], 'link', 'cache'], ['pg', ['shop'], 'database', 'pg'], ['sidecar', ['shop'], 'volume', 'files']]);
  assert.deepEqual(linksOfApp(view, 'shop').unowned.map(entry => entry.container), ['cache', 'pg', 'sidecar']);
  assert.deepEqual(linksOfApp(view, 'other'), { links: [], unowned: [], hubs: [] });
});

test('a database app that reaches an unowned container is not that container\'s dependency', () => {
  const facts = [fact('pg', { image: 'postgres:16', networks: on('net') }), fact('tool', { networks: on('net') })];
  assert.deepEqual(compute(facts, { pg: 'db-app' }).unowned, []);
});

test('partial facts: a link to a container the scan did not read is skipped, the rest still links', () => {
  const facts = [fact('web', { links: ['missing'], networks: on('net') }), fact('api', { networks: on('net') })];
  assert.deepEqual(compute(facts, { web: 'shop', api: 'blog' }).links.map(link => link.kind), ['network']);
});

test('the result does not depend on the order of the facts', () => {
  const facts = [fact('a', { networks: on('n1', 'n2'), volumes: ['v'] }), fact('b', { networks: on('n2', 'n1') }), fact('c', { volumes: ['v'], image: 'mongo:7', networks: on('n1') })];
  const map = { a: 'x', b: 'y', c: 'z' };
  assert.deepEqual(compute([...facts].reverse(), map), compute(facts, map));
  assert.deepEqual(linksOfApp(null, 'x'), { links: [], unowned: [], hubs: [] });
});

test('a network more than four apps share is a hub: listed once, never as pairs, even with a database on it', () => {
  const apps = Array.from({ length: HUB_APPS + 1 }, (_, index) => 'app-' + index);
  const facts = [...apps.map(app => fact(app + '-web', { networks: on('proxy') })), fact('proxy-db', { image: 'postgres:16', networks: on('proxy') })];
  const view = compute(facts, Object.fromEntries([...apps.map(app => [app + '-web', app]), ['proxy-db', 'app-0']]));
  assert.deepEqual(view.links, []); assert.deepEqual(view.unowned, []);
  assert.deepEqual(view.hubs, [{ network: 'proxy', appIds: apps }]);
  assert.deepEqual(linksOfApp(view, 'app-1').hubs, [{ network: 'proxy', appIds: apps }]);
  const four = compute(facts.slice(0, HUB_APPS), Object.fromEntries(apps.map(app => [app + '-web', app])));
  assert.equal(four.links.length, 6); assert.deepEqual(four.hubs, [], 'four apps still link in pairs');
});

test('only volume, link and database links warn; a network-only link is for the Map', () => {
  const facts = [fact('a', { networks: on('net') }), fact('b', { networks: on('net') }), fact('c', { volumes: ['v'] }), fact('d', { volumes: ['v'] })];
  const view = compute(facts, { a: 'app-a', b: 'app-b', c: 'app-c', d: 'app-d' });
  assert.deepEqual(view.links.map(link => [link.kind, link.warns]), [['network', false], ['volume', true]]);
  assert.deepEqual(linksOfApp(view, 'app-a').links.map(link => [link.otherAppId, link.warns]), [['app-b', false]]);
});

test('a database link needs one side that is not a database', () => {
  const facts = [fact('pg', { image: 'postgres:16', networks: on('net') }), fact('cache', { image: 'redis:7', networks: on('net') })];
  assert.deepEqual(compute(facts, { pg: 'app-a', cache: 'app-b' }).links.map(link => link.kind), ['network']);
  facts.push(fact('worker', { networks: on('net') }));
  assert.deepEqual(compute(facts, { pg: 'app-a', cache: 'app-b', worker: 'app-b' }).links.map(link => [link.kind, link.via]), [['database', 'pg']]);
});

test('nested bind folders count as one shared folder', () => {
  const facts = [fact('a', { binds: ['/srv'] }), fact('b', { binds: ['/srv/media'] }), fact('c', { binds: ['/srv/media/photos/'] }), fact('d', { binds: ['/srv-other'] })];
  const view = compute(facts, { a: 'app-a', b: 'app-b', c: 'app-c', d: 'app-d' });
  assert.deepEqual(view.links.map(link => [link.appIds, link.via]), [[['app-a', 'app-b'], '/srv'], [['app-a', 'app-c'], '/srv'], [['app-b', 'app-c'], '/srv']]);
  assert.deepEqual(compute(facts.slice(1), { b: 'app-b', c: 'app-c', d: 'app-d' }).links.map(link => link.via), ['/srv/media']);
});

test('system folders never link: Docker data, logs and account files', () => {
  const system = ['/var/lib/docker/volumes/x/_data', '/var/lib/docker', '/var/log', '/var/log/nginx', '/etc/passwd', '/etc/group', '/etc/os-release'];
  const facts = [fact('a', { binds: system }), fact('b', { binds: system })];
  assert.deepEqual(compute(facts, { a: 'app-a', b: 'app-b' }).links, []);
});

test('a link to an unowned container of another project is reported as unowned', () => {
  const facts = [fact('shop-web-1', { project: 'shop', links: ['tools-cache-1'] }), fact('tools-cache-1', { project: 'tools', service: 'cache' })];
  assert.deepEqual(compute(facts, { 'shop-web-1': 'shop' }).unowned.map(entry => [entry.container, entry.kind]), [['tools-cache-1', 'link']]);
});

test('1000 containers sharing 32 networks and 32 volumes finish in well under 200 ms', () => {
  const nets = Array.from({ length: 32 }, (_, index) => 'net-' + index), vols = Array.from({ length: 32 }, (_, index) => 'vol-' + index);
  const facts = Array.from({ length: 1000 }, (_, index) => fact('c-' + index, { networks: nets, volumes: vols, image: index % 50 ? 'demo/app:1' : 'postgres:16' }));
  const map = Object.fromEntries(facts.map((item, index) => [item.name, 'app-' + (index % 100)]));
  const started = performance.now(), view = compute(facts, map), elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `took ${elapsed} ms`);
  assert.equal(view.hubs.length, 32); assert.equal(view.links.length, 4950, 'every pair of the 100 apps shares volumes');
  // 4950 pairs times 32 volumes is beyond the evidence budget: every pair is found, some details are left out.
  assert.equal(view.links[0].kind, 'volume'); assert.equal(view.partial, true);
});

test('the work budget: a group beyond MAX_GROUP members, or too much evidence, marks the result partial', () => {
  const crowd = Array.from({ length: MAX_GROUP + 1 }, (_, index) => fact('c-' + index, { networks: on('net') }));
  const view = compute(crowd, Object.fromEntries(crowd.map(item => [item.name, item.name])));
  assert.equal(view.partial, true); assert.deepEqual(view.hubs, [], 'a skipped group is not a hub either');
  const many = Array.from({ length: 1000 }, (_, index) => fact('c-' + index, { volumes: Array.from({ length: 64 }, (_, v) => 'v' + v) }));
  const started = performance.now(), budget = compute(many, Object.fromEntries(many.map((item, index) => [item.name, 'app-' + (index % 200)])));
  assert.equal(budget.partial, true); assert.ok(budget.links.length <= MAX_EVIDENCE); assert.ok(performance.now() - started < 1000);
});

test('the database rule: an engine chosen in the app decides, otherwise the image name, the same as the helper', () => {
  const images = JSON.parse(readFileSync(new URL('./fixtures/database-images.json', import.meta.url), 'utf8'));
  for (const image of images.databases) assert.equal(imageLooksLikeDatabase(image), true, image);
  for (const image of images.notDatabases) assert.equal(imageLooksLikeDatabase(image), false, image);
  assert.equal(imageLooksLikeDatabase(undefined), false);
  assert.equal(containerIsDatabase('postgres', 'demo/app:1'), true);
  assert.equal(containerIsDatabase('generic', 'postgres:16'), false);
  assert.equal(containerIsDatabase('auto', 'postgres:16'), true);
  assert.equal(containerIsDatabase(undefined, 'nginx:1.27'), false);
});
