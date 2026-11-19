// Coverage view (docs/coverage-and-restore-check.md A4): classification, the skip list routes, audit, migration 19
// and the Move refusal for a container an app on the new server already backs up. Discover is stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const directory = await mkdtemp(join(tmpdir(), 'docknest-coverage-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const { transport } = await import('../src/engine.js');
const { classifyCoverage, dockNestOwn } = await import('../src/server-coverage.js');
const { previewMove, startMove } = await import('../src/moves/engine.js');
const { migrate, migrations } = await import('../src/migrations.js');
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
test.after(() => listener.close());
const base = `http://127.0.0.1:${listener.address().port}/api`, at = new Date().toISOString();
const sessions = {};
for (const role of ['admin', 'operator']) {
  sessions[role] = randomBytes(32).toString('base64url');
  db.prepare("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)").run(role, role + '@example.com', 'fixture', 'fixture', '[]', at, 'Demo ' + role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(sessions[role]), role, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), Date.now());
}
for (const [id, host] of [['srv-a', '192.0.2.10'], ['srv-b', '198.51.100.20']]) db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, 'Demo ' + id, host, 22, 'root', 'fixture', '0'.repeat(64), at);
const site = (id, server, containers) => db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(id, server, 'Demo ' + id, JSON.stringify({ containers }), at);
site('shop', 'srv-a', ['shop-web', 'shop-db']); site('blog', 'srv-a', ['blog-web']); site('old', 'srv-a', ['old-web']); site('target-shop', 'srv-b', ['shop-web']);
db.prepare("INSERT INTO site_archives(site_id,archived_at) VALUES('old',?)").run(at);
db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES('job-1','shop','backup','completed','completed',?)").run(at);
db.prepare("INSERT INTO backups VALUES('backup-1','shop','job-1',?,'demo.enc',1,?,'{}',0,1,?)").run(at, 'a'.repeat(64), at);

const container = (name, extra = {}) => ({ name, image: 'demo/' + name + ':1', state: 'running', labels: {}, mounts: [], ...extra });
const scan = {
  containers: [container('shop-web', { mounts: [{ Type: 'volume', Name: 'shop_data' }] }), container('shop-db'), container('blog-web', { mounts: [{ Type: 'volume', Name: 'blog_data' }] }),
    container('loose'), container('old-web'), container('dbm-restore-0123456789ab'), container('move-copy', { labels: { 'docknest.move': 'm', 'docknest.move.mode': 'test' } }),
    container('moved-live', { labels: { 'docknest.move': 'm', 'docknest.move.mode': 'live' } }), container('rt-copy', { labels: { 'docknest.restore-test': 't' } })],
  volumes: [{ name: 'shop_data', driver: 'local', labels: {} }, { name: 'blog_data', driver: 'local', labels: {} }, { name: 'spare', driver: 'local', labels: {} },
    { name: 'restore-volume', driver: 'local', labels: { 'docker-backup-manager.restore': 'job' } }],
  uninspected: 0,
};
const get = (route, role = 'operator') => fetch(base + route, { headers: role ? { Cookie: 'dbm_session=' + sessions[role], Origin: process.env.APP_ORIGIN } : {} });
const send = (method, route, body, role = 'operator') => fetch(base + route, { method, headers: { Cookie: 'dbm_session=' + sessions[role], Origin: process.env.APP_ORIGIN, 'x-csrf-token': 'csrf', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const byName = result => Object.fromEntries(result.items.map(item => [item.kind + ':' + item.name, item]));
transport.remote = async () => structuredClone(scan);

test('an app with a verified backup is backed up, one without is pending, and a volume belongs to the app that mounts it', async () => {
  const response = await get('/servers/srv-a/coverage'); assert.equal(response.status, 200);
  const result = await response.json(), items = byName(result);
  assert.equal(result.complete, true); assert.deepEqual(result.problems, []);
  assert.deepEqual(items['container:shop-web'], { kind: 'container', name: 'shop-web', image: 'demo/shop-web:1', state: 'running', status: 'backed-up', app: { id: 'shop', name: 'Demo shop' } });
  assert.equal(items['container:blog-web'].status, 'pending');
  assert.deepEqual(items['volume:shop_data'], { kind: 'volume', name: 'shop_data', usedBy: ['shop-web'], status: 'backed-up', app: { id: 'shop', name: 'Demo shop' } });
  assert.equal(items['volume:blog_data'].status, 'pending');
  assert.equal(items['container:old-web'].status, 'not-backed-up', 'a removed app covers nothing');
  assert.deepEqual(items['volume:spare'], { kind: 'volume', name: 'spare', usedBy: [], status: 'not-backed-up' });
});

test('DockNest\'s own copies are left out, but a moved app\'s live copy is listed', async () => {
  const names = (await (await get('/servers/srv-a/coverage')).json()).items.map(item => item.name);
  for (const own of ['dbm-restore-0123456789ab', 'move-copy', 'rt-copy', 'restore-volume']) assert.ok(!names.includes(own), own);
  assert.ok(names.includes('moved-live'));
  assert.equal(dockNestOwn('demo', { 'docknest.edit.hold': '1' }), true); assert.equal(dockNestOwn('demo', { 'docknest.launch': 'x' }), false);
});

test('an incomplete scan is never all clear', () => {
  const missing = classifyCoverage({ ...scan, volumes: null, uninspected: 2 }, [], 'srv-a');
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.problems, ['DockNest could not list the volumes on this server, so volumes are missing from this list.', 'DockNest could not read 2 containers on this server. Scan again.']);
  assert.equal(classifyCoverage({ containers: [], volumes: [] }, [], 'srv-a').complete, true);
});

test('skipping an item: any signed-in role, strict body, audited without the note, shown only while nothing backs it up', async () => {
  for (const [body, why] of [[{ kind: 'image', name: 'loose' }, 'kind'], [{ kind: 'container', name: '../etc' }, 'name'], [{ kind: 'container', name: 'loose', extra: 1 }, 'strict'], [{ kind: 'container', name: 'loose', note: 'x'.repeat(201) }, 'note']]) {
    assert.equal((await send('PUT', '/servers/srv-a/coverage/ignores', body)).status, 400, why);
  }
  assert.equal((await send('PUT', '/servers/unknown/coverage/ignores', { kind: 'container', name: 'loose' })).status, 404);
  const saved = await send('PUT', '/servers/srv-a/coverage/ignores', { kind: 'container', name: 'loose', note: 'Scratch container' });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).note, 'Scratch container');
  assert.equal((await send('PUT', '/servers/srv-a/coverage/ignores', { kind: 'container', name: 'shop-web' }, 'admin')).status, 200);
  const items = byName(await (await get('/servers/srv-a/coverage')).json());
  assert.equal(items['container:loose'].status, 'skipped'); assert.equal(items['container:loose'].note, 'Scratch container'); assert.equal(items['container:loose'].skippedBy, 'Demo operator'); assert.ok(items['container:loose'].skippedAt);
  assert.equal(items['container:shop-web'].status, 'backed-up', 'a covered item is never shown as skipped'); assert.equal(items['container:shop-web'].note, undefined);
  const audits = db.prepare("SELECT action,detail FROM audit_events WHERE action LIKE 'coverage.%' ORDER BY rowid").all();
  assert.deepEqual(audits.map(row => [row.action, JSON.parse(row.detail)]), [['coverage.skip', { kind: 'container', name: 'loose' }], ['coverage.skip', { kind: 'container', name: 'shop-web' }]]);
  assert.ok(!audits.some(row => row.detail.includes('Scratch')));
  assert.equal((await send('DELETE', '/servers/srv-a/coverage/ignores/container/loose')).status, 204);
  assert.equal((await send('DELETE', '/servers/srv-a/coverage/ignores/container/loose')).status, 404);
  assert.equal((await send('DELETE', '/servers/srv-a/coverage/ignores/image/loose')).status, 400);
  assert.equal(byName(await (await get('/servers/srv-a/coverage')).json())['container:loose'].status, 'not-backed-up');
  assert.equal(db.prepare("SELECT action FROM audit_events WHERE action='coverage.unskip'").all().length, 1);
  assert.equal((await get('/servers/srv-a/coverage', null)).status, 401);
});

test('a move to a server whose apps already back up one of its containers is refused, at preview and at start', async () => {
  const message = 'shop-web is already backed up in Demo target-shop. Edit that app instead.';
  await assert.rejects(previewMove({ siteId: 'shop', targetServerId: 'srv-b', options: {} }, 'admin'), error => error.status === 409 && error.code === 'CONTAINER_ALREADY_BACKED_UP' && error.message === message);
  db.prepare("INSERT INTO site_moves(id,site_id,source_server_id,target_server_id,state,options,preflight,preflight_hash,actor,created_at,updated_at) VALUES('move-1','shop','srv-a','srv-b','draft','{}','{}','hash','admin',?,?)").run(at, at);
  await assert.rejects(startMove('move-1', { preflightHash: 'hash' }, 'admin'), error => error.status === 409 && error.code === 'CONTAINER_ALREADY_BACKED_UP');
});

test('migration 19 adds only server_coverage_ignores, compatible with 2.16.4, with its limits', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'docknest-coverage-migration-')); const file = join(folder, 'state.sqlite'); const database = new DatabaseSync(file);
  try {
    database.exec('PRAGMA foreign_keys=ON');
    const entry = migrations.find(item => item.name === 'server-coverage-ignores');
    assert.equal(entry.version, 19); assert.equal(entry.compatible, true);
    migrate(database, { file, list: migrations.filter(item => item.version < 19), log: () => {} });
    const tables = () => database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
    const before = tables();
    migrate(database, { file, list: migrations.filter(item => item.version <= 19), log: () => {} });
    assert.deepEqual(tables().filter(name => !before.includes(name)), ['server_coverage_ignores']);
    database.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('s','Demo','192.0.2.1',22,'root','k','0',?)").run(at);
    const insert = (kind, name, note = null) => database.prepare('INSERT INTO server_coverage_ignores VALUES(?,?,?,?,?,?)').run('s', kind, name, note, null, at);
    insert('volume', 'demo');
    for (const [kind, name, note] of [['image', 'x', null], ['container', '', null], ['container', 'y'.repeat(256), null], ['container', 'z', 'n'.repeat(201)], ['volume', 'demo', null]]) assert.throws(() => insert(kind, name, note), kind + name.length);
    assert.throws(() => database.prepare('INSERT INTO server_coverage_ignores VALUES(?,?,?,?,?,?)').run('missing', 'volume', 'v', null, null, at), /FOREIGN KEY/);
  } finally { database.close(); await rm(folder, { recursive: true, force: true }); }
});
