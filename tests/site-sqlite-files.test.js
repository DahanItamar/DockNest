import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
// The site form edits SQLite file lists per service; the API keeps its own rules.
const directory = await mkdtemp(join(tmpdir(), 'docknest-sqlite-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js');
const { db, id } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
const token = randomBytes(32).toString('base64url'), csrf = 'fixture-csrf', user = id(), host = id(), other = id();
db.prepare("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)").run(user, 'sqlite@example.invalid', 'fixture', 'fixture', '[]', new Date().toISOString(), 'Sqlite', 'admin');
db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), user, csrf, Date.now() + 3600000, Date.now(), Date.now(), Date.now());
// The private key is not a sealed value, so discovery fails without contacting anything: no path is confirmed.
for (const server of [host, other]) db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(server, 'Fixture', '127.0.0.1', 1, 'root', 'fixture', '0'.repeat(64), new Date().toISOString());
const role = value => db.prepare('UPDATE users SET role=? WHERE id=?').run(value, user);
const call = (route, method, body) => fetch(base + route, { method, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, 'x-csrf-token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const service = (container, extra = {}) => ({ container, engine: 'generic', sqliteVersion: '3.45.1', sqliteFiles: ['/data/app.db'], ...extra });
const body = (services, name = 'Edit fixture') => ({ serverId: host, name, config: { containers: ['web', 'worker'], services } });

test('SQLite file lists save per service and keep version, engine and SIGTERM confirmation', async () => {
  const created = await call('/sites', 'POST', body([service('web', { sqliteSigtermConfirmed: true }), service('worker')]));
  assert.equal(created.status, 201);
  const site = await created.json();
  const next = site.config.services.map(item => ({ ...item, sqliteFiles: ['/data/app.db', '/data/other.db'] }));
  const saved = await call('/sites/' + site.id, 'PATCH', { serverId: host, name: 'Edit fixture', config: { ...site.config, services: next } });
  assert.equal(saved.status, 200);
  const config = JSON.parse(db.prepare('SELECT config FROM sites WHERE id=?').get(site.id).config);
  assert.deepEqual(config.services.map(item => item.sqliteFiles), [['/data/app.db', '/data/other.db'], ['/data/app.db', '/data/other.db']]);
  assert.equal(config.services[0].sqliteSigtermConfirmed, true);
  assert.equal(config.services[0].sqliteVersion, '3.45.1');
});

test('relative paths, duplicate files, and an empty list under SIGTERM acceptance are refused with a clear message', async () => {
  const site = await (await call('/sites', 'POST', body([service('web', { sqliteSigtermConfirmed: true }), service('worker')]))).json();
  const patch = services => call('/sites/' + site.id, 'PATCH', { serverId: host, name: 'Edit fixture', config: { ...site.config, services } });
  assert.equal((await patch([service('web', { sqliteFiles: ['data/app.db'] }), service('worker')])).status, 400);
  const twice = await patch([service('web', { sqliteFiles: ['/data/a.db', '/data/a.db'] }), service('worker')]);
  assert.equal(twice.status, 400); assert.match(JSON.stringify(await twice.json()), /listed twice/);
  const empty = await patch([service('web', { sqliteFiles: [], sqliteSigtermConfirmed: true }), service('worker')]);
  assert.equal(empty.status, 400); assert.match(JSON.stringify(await empty.json()), /SIGTERM acceptance requires explicit SQLite file checks/);
  assert.equal((await patch([service('web', { sqliteFiles: [] }), service('worker')])).status, 200, 'an empty list is fine without SIGTERM acceptance');
});

test.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); await rm(directory, { recursive: true, force: true }); });
