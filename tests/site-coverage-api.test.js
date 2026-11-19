import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
// One container or static website folder belongs to one app: the API refuses a second app for it (409), and an edit
// only for overlaps it adds, so an install whose apps already overlap stays editable.
const directory = await mkdtemp(join(tmpdir(), 'docknest-coverage-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js');
const { db, id } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(() => server.close());
const token = randomBytes(32).toString('base64url'), csrf = 'fixture-csrf', user = id(), host = id(), other = id();
db.prepare("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)").run(user, 'coverage@example.invalid', 'fixture', 'fixture', '[]', new Date().toISOString(), 'Coverage', 'admin');
db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), user, csrf, Date.now() + 3600000, Date.now(), Date.now(), Date.now());
for (const server of [host, other]) db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(server, 'Fixture', '127.0.0.1', 1, 'root', 'fixture', '0'.repeat(64), new Date().toISOString());
const call = async (route, method, body) => { const response = await fetch(base + route, { method, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, 'x-csrf-token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
const docker = (name, containers, serverId = host) => ({ serverId, name, config: { containers } });
const sites = () => db.prepare('SELECT COUNT(*) AS n FROM sites').get().n;

test('a second app for a container is refused with 409 naming the container and its app', async () => {
  const media = await call('/sites', 'POST', docker('MediaHouse', ['mediahouse-web', 'mediahouse-db']));
  assert.equal(media.status, 201);
  const before = sites(), duplicate = await call('/sites', 'POST', docker('Copy', ['mediahouse-db', 'fresh']));
  assert.equal(duplicate.status, 409);
  assert.deepEqual(duplicate.body, { error: 'mediahouse-db is already backed up in MediaHouse. Edit that app instead.', code: 'CONTAINER_ALREADY_BACKED_UP' });
  assert.equal(sites(), before);
  assert.equal((await call('/sites', 'POST', docker('Elsewhere', ['mediahouse-db'], other))).status, 201, 'another server is another container');
});

test('a removed app no longer covers its containers', async () => {
  const old = await call('/sites', 'POST', docker('Old', ['old-web']));
  db.prepare('INSERT INTO site_archives(site_id,archived_at) VALUES(?,?)').run(old.body.id, new Date().toISOString());
  assert.equal((await call('/sites', 'POST', docker('New', ['old-web']))).status, 201);
});

test('a static website folder belongs to one app', async () => {
  const blog = { serverId: host, name: 'Blog', config: { kind: 'static', containers: [], documentRoot: '/var/www/blog' } };
  assert.equal((await call('/sites', 'POST', blog)).status, 201);
  const duplicate = await call('/sites', 'POST', { ...blog, name: 'Blog again' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, '/var/www/blog is already backed up in Blog. Edit that app instead.');
});

test('an edit keeps an overlap it already had and is refused only for one it adds', async () => {
  const paper = await call('/sites', 'POST', docker('Paperless', ['paper-web', 'paper-redis']));
  const legacy = await call('/sites', 'POST', docker('Legacy', ['legacy-web']));
  // An install from before this check: Legacy also backs up paper-redis.
  db.prepare('UPDATE sites SET config=? WHERE id=?').run(JSON.stringify({ ...legacy.body.config, containers: ['legacy-web', 'paper-redis'] }), legacy.body.id);
  const saved = JSON.parse(db.prepare('SELECT config FROM sites WHERE id=?').get(legacy.body.id).config);
  assert.equal((await call('/sites/' + legacy.body.id, 'PATCH', { serverId: host, name: 'Legacy renamed', config: saved })).status, 200);
  assert.equal((await call('/sites/' + paper.body.id, 'PATCH', { serverId: host, name: 'Paperless', config: paper.body.config })).status, 200, 'an app does not overlap itself');
  const added = await call('/sites/' + legacy.body.id, 'PATCH', { serverId: host, name: 'Legacy renamed', config: { ...saved, containers: [...saved.containers, 'paper-web'] } });
  assert.equal(added.status, 409);
  assert.deepEqual(added.body, { error: 'paper-web is already backed up in Paperless. Edit that app instead.', code: 'CONTAINER_ALREADY_BACKED_UP' });
  assert.deepEqual(JSON.parse(db.prepare('SELECT config FROM sites WHERE id=?').get(legacy.body.id).config).containers, ['legacy-web', 'paper-redis']);
});
