// Linked apps (docs/linked-apps.md): links between apps computed from discovery facts, strongest kind per pair, the
// containers no app backs up, and the database rule shared with the remote helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeAppLinks, linksOfApp, LINK_KINDS } from '../shared/app-links.js';
import { imageLooksLikeDatabase, containerIsDatabase } from '../shared/database-image.js';

const fact = (name, fields = {}) => ({ name, image: 'demo/app:1', project: null, service: null, networks: [], volumes: [], binds: [], links: [], dependsOn: [], ...fields });
const on = (...names) => names.map(name => ({ name, aliases: [] }));
// Owners by container name, as the server's lookup returns them.
const owners = map => name => (map[name] ? { siteId: map[name], name: map[name] } : null);
const byImage = container => imageLooksLikeDatabase(container.image);
const compute = (facts, map) => computeAppLinks(facts, owners(map), byImage);

test('kinds are ordered strongest first', () => assert.deepEqual(LINK_KINDS, ['volume', 'link', 'database', 'network']));

test('empty, missing and single-app facts give no links', () => {
  assert.deepEqual(computeAppLinks([], owners({}), byImage), { links: [], unowned: [] });
  assert.deepEqual(computeAppLinks(undefined, owners({}), byImage), { links: [], unowned: [] });
  const facts = [fact('web', { networks: on('shop-net'), volumes: ['uploads'] }), fact('db', { image: 'postgres:16', networks: on('shop-net'), volumes: ['uploads'] })];
  assert.deepEqual(compute(facts, { web: 'shop', db: 'shop' }), { links: [], unowned: [] }, 'containers of one app never link it to itself');
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
  assert.deepEqual(compute(facts, { a: 'app-a', b: 'app-b', c: 'app-c' }).links.map(link => [link.appIds, link.kind, link.via]), [], 'paths must match exactly');
  facts[1].binds[0] = '/srv/media';
  assert.deepEqual(compute(facts, { a: 'app-a', b: 'app-b', c: 'app-c' }).links.map(link => [link.appIds, link.kind, link.via]), [[['app-a', 'app-b'], 'volume', '/srv/media']]);
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
  assert.deepEqual(linksOfApp(view, 'other'), { links: [], unowned: [] });
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
  assert.deepEqual(linksOfApp(null, 'x'), { links: [], unowned: [] });
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
