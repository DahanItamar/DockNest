// Linked apps per server (docs/linked-apps.md): the migration is one additive table, facts are cleaned on arrival and on
// read, a scan replaces the row, and /api/state shows {checkedAt, partial, links, unowned} on every server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const directory = await mkdtemp(join(tmpdir(), 'docknest-server-links-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const { migrations, migrate, compatFloor } = await import('../src/migrations.js');
const { cleanContainerLinks, cleanScan, recordDiscoveredLinks, serverLinksView, LIMITS } = await import('../src/server-links.js');
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
test.after(() => listener.close());

function user(role) {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId, userId + '@example.invalid', 'fixture', 'fixture', '[]', new Date().toISOString(), role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), userId, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), Date.now());
  return route => fetch(base + route, { headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN } }).then(async response => ({ status: response.status, body: await response.json() }));
}
const admin = user('admin'), operator = user('operator');

const links = (fields = {}) => ({ format: 1, project: null, service: null, networks: [], volumes: [], binds: [], links: [], dependsOn: [], ...fields });
const container = (name, fields = {}, image = 'demo/app:1') => ({ id: 'f'.repeat(64), name, image, labels: { secret: 'label-secret' }, links: links(fields) });
const at = '2026-11-19T08:00:00.000Z';
const server = id => db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,'192.0.2.10',22,'root','unused',?,?)").run(id, id, 'a'.repeat(64), at);
const site = (id, serverId, config) => db.prepare('INSERT INTO sites(id,server_id,name,config,created_at) VALUES(?,?,?,?,?)').run(id, serverId, id, JSON.stringify(config), at);

const migration = migrations.find(item => item.name === 'server-app-links');
const objects = database => database.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all().map(row => ({ ...row }));

test('the migration is the last one, compatible, adds only server_app_links, keeps every row and restarts as a no-op', async () => {
  assert.equal(migration.version, migrations.at(-1).version); assert.equal(migration.compatible, true); assert.equal(compatFloor(migrations), 1);
  const folder = await mkdtemp(join(tmpdir(), 'docknest-links-migration-')), file = join(folder, 'state.sqlite'), database = new DatabaseSync(file);
  try {
    database.exec('PRAGMA foreign_keys=ON');
    const before = migrations.filter(item => item.version < migration.version), quiet = () => {};
    migrate(database, { file, list: before, log: quiet });
    database.exec(`INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('srv','Server','192.0.2.20',22,'root','sealed','${'a'.repeat(64)}','${at}')`);
    const old = objects(database), servers = database.prepare('SELECT * FROM servers').all().map(row => ({ ...row }));
    const result = migrate(database, { file, list: migrations, log: quiet });
    assert.equal(result.to, migration.version); assert.ok(result.snapshot);
    for (const row of old) assert.deepEqual(objects(database).find(item => item.name === row.name), row, 'unchanged: ' + row.name);
    assert.deepEqual(objects(database).map(row => row.name).filter(name => !old.some(row => row.name === name)), ['server_app_links']);
    assert.deepEqual(database.prepare('SELECT * FROM servers').all().map(row => ({ ...row })), servers);
    const after = objects(database);
    assert.deepEqual(migrate(database, { file, list: migrations, log: quiet }), { from: migration.version, to: migration.version, snapshot: null });
    migration.up(database); assert.deepEqual(objects(database), after);
    // Older code accepts the newer, compatible schema.
    assert.deepEqual(migrate(database, { file, list: before, log: quiet }), { from: migration.version, to: migration.version, snapshot: null });
    // Limits and the cascade from servers.
    const insert = database.prepare('INSERT OR REPLACE INTO server_app_links VALUES(?,?,1,?,?)');
    insert.run('srv', '[]', at, 0);
    assert.throws(() => insert.run('srv', '[]', at, 2), /CHECK/);
    assert.throws(() => insert.run('srv', 'x'.repeat(2097153), at, 0), /CHECK/);
    assert.throws(() => insert.run('missing', '[]', at, 0), /FOREIGN KEY/);
    database.prepare("DELETE FROM servers WHERE id='srv'").run();
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM server_app_links').get().n, 0, 'deleting a server deletes its facts');
  } finally { database.close(); await rm(folder, { recursive: true, force: true }); }
});

test('facts are cleaned: unexpected values are dropped and mark the scan partial, unreadable containers are left out', () => {
  assert.deepEqual(cleanContainerLinks(container('web', { project: 'demo-shop', networks: ['shop-net'], binds: ['/srv/demo shop/media'] })), {
    facts: { name: 'web', image: 'demo/app:1', project: 'demo-shop', service: null, networks: ['shop-net'], volumes: [], binds: ['/srv/demo shop/media'], links: [], dependsOn: [] }, dropped: false });
  for (const bad of [{ volumes: ['ok', '../x'] }, { binds: ['relative/path'] }, { binds: ['/srv/\u0007bell'] }, { links: [42] }, { networks: ['bad network'] },
    { networks: 'shop-net' }, { project: 'bad project' }, { volumes: Array.from({ length: LIMITS.volumes + 1 }, (_, index) => 'v' + index) }]) {
    const cleaned = cleanContainerLinks(container('web', bad));
    assert.ok(cleaned && cleaned.dropped, JSON.stringify(bad));
  }
  assert.equal(cleanContainerLinks(container('web', { volumes: Array(LIMITS.volumes + 1).fill('v') })).facts.volumes.length, LIMITS.volumes);
  assert.equal(cleanContainerLinks(container('web', {}, 'bad image\n')).facts.image, '');
  for (const bad of [{ ...container('web'), links: null }, { ...container('web'), links: { ...links(), format: 2 } }, container('-bad'), null]) assert.equal(cleanContainerLinks(bad), null);
  assert.deepEqual(cleanScan({ containers: [container('a'), container('a'), { name: 'b' }] }), { facts: [cleanContainerLinks(container('a')).facts], partial: true });
  assert.deepEqual(cleanScan({ containers: [] }), { facts: [], partial: false });
  assert.equal(cleanScan({}), null); assert.equal(cleanScan(null), null);
});

test('a scan replaces the row, a non-scan keeps the previous one, and the view computes links from the current apps', () => {
  server('srv-a'); site('shop', 'srv-a', { containers: ['shop-web'] }); site('data', 'srv-a', { containers: ['pg'], services: [{ container: 'pg', engine: 'postgres' }] });
  site('static', 'srv-a', { kind: 'static', containers: [] });
  assert.deepEqual(serverLinksView('srv-a'), { checkedAt: null, partial: false, links: [], unowned: [] }, 'not scanned yet');
  const scan = { containers: [container('shop-web', { networks: ['data-net'], links: ['cache'] }), container('pg', { networks: ['data-net'] }, 'custom/db:2'), container('cache')] };
  assert.equal(recordDiscoveredLinks('srv-a', scan, at), true);
  const stored = db.prepare("SELECT facts FROM server_app_links WHERE server_id='srv-a'").get().facts;
  assert.doesNotMatch(stored, /label-secret|"id"/, 'only the cleaned facts are stored');
  assert.deepEqual(serverLinksView('srv-a'), {
    checkedAt: at, partial: false,
    links: [{ appIds: ['data', 'shop'], kind: 'database', via: 'pg', details: [{ kind: 'database', via: 'pg', containers: ['pg', 'shop-web'] }] }],
    unowned: [{ container: 'cache', appIds: ['shop'], kind: 'link', via: 'cache', details: [{ kind: 'link', via: 'cache', containers: ['cache', 'shop-web'] }] }],
  }, 'the engine chosen in the app makes pg a database although its image name does not say so');
  assert.equal(recordDiscoveredLinks('srv-a', { error: 'nope' }, '2026-11-20T00:00:00.000Z'), false);
  assert.equal(serverLinksView('srv-a').checkedAt, at, 'the last good scan stays with its time');
  // Archiving an app drops its links at once: links are computed on read.
  db.prepare("INSERT INTO site_archives VALUES('data',?)").run(at);
  assert.deepEqual(serverLinksView('srv-a').links, []);
  assert.deepEqual(serverLinksView('srv-a').unowned.map(entry => entry.container), ['cache'], 'without the archived app, nothing says pg is a database');
  db.prepare("DELETE FROM site_archives WHERE site_id='data'").run();
  // A partial scan says so; damaged or future stored facts read as not scanned.
  recordDiscoveredLinks('srv-a', { containers: [container('shop-web'), { name: 'broken', links: 'x' }] }, at);
  assert.equal(serverLinksView('srv-a').partial, true);
  db.prepare("UPDATE server_app_links SET facts='not json' WHERE server_id='srv-a'").run();
  assert.equal(serverLinksView('srv-a').checkedAt, null);
  db.prepare("UPDATE server_app_links SET facts='[]',format=2 WHERE server_id='srv-a'").run();
  assert.equal(serverLinksView('srv-a').checkedAt, null);
});

test('GET /api/state gives every signed-in role appLinks on each server, never the raw facts', async () => {
  server('srv-b'); site('blog', 'srv-b', { containers: ['blog-web'] }); site('wiki', 'srv-b', { containers: ['wiki-web'] });
  recordDiscoveredLinks('srv-b', { containers: [container('blog-web', { volumes: ['media'] }), container('wiki-web', { volumes: ['media'] })] }, at);
  for (const as of [admin, operator]) {
    const { status, body } = await as('/state');
    assert.equal(status, 200);
    const entry = body.servers.find(item => item.id === 'srv-b');
    assert.deepEqual(entry.appLinks, { checkedAt: at, partial: false, links: [{ appIds: ['blog', 'wiki'], kind: 'volume', via: 'media', details: [{ kind: 'volume', via: 'media', containers: ['blog-web', 'wiki-web'] }] }], unowned: [] });
    assert.equal(body.servers.find(item => item.id === 'srv-a').appLinks.checkedAt, null);
    assert.doesNotMatch(JSON.stringify(body), /"facts"|label-secret/);
  }
});
