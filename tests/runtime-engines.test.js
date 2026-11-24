import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runtimeSchema, cleanEngines, runtimeRefusal, appRuntime, isRootfulDocker } from '../src/runtime.js';
// The container engine of an app (docs/podman-rootless.md): saved only when the server reported it, never changed by an edit.
const alice = { engine: 'podman', rootless: true, user: 'alice', uid: 1001 };
const reported = [{ engine: 'docker', rootless: false, version: '28.0.1', cgroupDelegated: true }, { ...alice, version: '5.2.1', cgroupDelegated: false }];

test('the runtime schema is strict and needs a user for rootless only', () => {
  assert.ok(runtimeSchema.safeParse(alice).success);
  assert.ok(runtimeSchema.safeParse({ engine: 'docker', rootless: false }).success);
  for (const bad of [{ engine: 'lxc', rootless: false }, { engine: 'podman', rootless: true }, { engine: 'podman', rootless: false, user: 'alice', uid: 1001 },
    { ...alice, uid: 0 }, { ...alice, uid: 999 }, { ...alice, user: 'Alice' }, { ...alice, user: 'a;b' }, { ...alice, extra: 1 }, { ...alice, rootless: 'yes' }, 'podman', null])
    assert.equal(runtimeSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test('engines a server reports are cleaned: odd shapes, versions, duplicates and long lists are dropped', () => {
  assert.deepEqual(cleanEngines(reported), reported);
  assert.deepEqual(cleanEngines('x'), []);
  assert.deepEqual(cleanEngines([{ ...alice, version: '5.2.1$(x)', cgroupDelegated: true }, { ...alice, version: '5.2.1' }, { ...alice, version: '5.2.1', cgroupDelegated: 'yes' },
    { engine: 'docker', rootless: false, version: '28', cgroupDelegated: true, extra: 'ignored' }, { engine: 'docker', rootless: false, version: '29', cgroupDelegated: true }, null, 5]),
  [{ engine: 'docker', rootless: false, version: '28', cgroupDelegated: true }]);
  assert.equal(cleanEngines(Array.from({ length: 100 }, (_, index) => ({ engine: 'podman', rootless: true, user: 'u' + index, uid: 2000 + index, version: '5', cgroupDelegated: true }))).length, 32);
});

test('a runtime is refused unless the server reported that exact engine; rootful Docker is always allowed', () => {
  assert.equal(runtimeRefusal(undefined, {}), '');
  assert.equal(runtimeRefusal({ engine: 'docker', rootless: false }, {}), '');
  assert.equal(runtimeRefusal(alice, { engines: reported }), '');
  assert.match(runtimeRefusal(alice, {}), /Test connection/);
  assert.match(runtimeRefusal(alice, { engines: [reported[0]] }), /does not have that container engine/);
  assert.match(runtimeRefusal({ ...alice, uid: 1002 }, { engines: reported }), /does not have that container engine/);
  assert.match(runtimeRefusal({ engine: 'podman', rootless: false }, { engines: reported }), /does not have that container engine/);
  assert.equal(isRootfulDocker(undefined) && isRootfulDocker({ engine: 'docker', rootless: false }) && !isRootfulDocker(alice), true);
});

test('one app, one engine: containers from two engines are refused with the plain message', () => {
  assert.deepEqual(appRuntime([{}, { runtime: { engine: 'docker', rootless: false } }]), { runtime: { engine: 'docker', rootless: false } });
  assert.deepEqual(appRuntime([{ runtime: alice }, { runtime: alice }]), { runtime: alice });
  assert.match(appRuntime([{ runtime: alice }, {}]).error, /two engines\. Make two apps/);
  assert.match(appRuntime([{ runtime: alice }, { runtime: { ...alice, uid: 1002 } }]).error, /two engines/);
  assert.match(appRuntime([{ runtime: { engine: 'lxc', rootless: false } }]).error, /does not understand/);
  assert.deepEqual(appRuntime([]), { runtime: { engine: 'docker', rootless: false } });
});

const directory = await mkdtemp(join(tmpdir(), 'docknest-runtime-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js');
const { db, id } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const http = app.listen(0, '127.0.0.1'); await new Promise(resolve => http.once('listening', resolve));
const base = `http://127.0.0.1:${http.address().port}/api`;
const token = randomBytes(32).toString('base64url'), csrf = 'fixture-csrf', user = id(), withEngines = id(), without = id();
db.prepare("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)").run(user, 'runtime@example.invalid', 'fixture', 'fixture', '[]', new Date().toISOString(), 'Runtime', 'admin');
db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), user, csrf, Date.now() + 3600000, Date.now(), Date.now(), Date.now());
for (const [server, capabilities] of [[withEngines, JSON.stringify({ engines: reported })], [without, null]])
  db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,capabilities,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(server, 'Fixture', '127.0.0.1', 1, 'root', 'fixture', '0'.repeat(64), capabilities, new Date().toISOString());
const call = (route, method, body) => fetch(base + route, { method, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, 'x-csrf-token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
test.beforeEach(() => db.prepare('INSERT OR IGNORE INTO site_archives(site_id,archived_at) SELECT id,? FROM sites').run(new Date().toISOString()));
const body = (serverId, runtime) => ({ serverId, name: 'Shop', config: { containers: ['shop'], ...(runtime ? { runtime } : {}) } });

test('API: an app with an engine the server reported is saved; others are refused', async () => {
  const created = await call('/sites', 'POST', body(withEngines, alice));
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json()).config.runtime, alice);
  db.prepare('INSERT OR IGNORE INTO site_archives(site_id,archived_at) SELECT id,? FROM sites').run(new Date().toISOString());
  for (const [server, runtime] of [[without, alice], [withEngines, { ...alice, uid: 1002 }], [withEngines, { engine: 'podman', rootless: false }], [withEngines, { ...alice, extra: 1 }]])
    assert.equal((await call('/sites', 'POST', body(server, runtime))).status, 400, JSON.stringify(runtime));
  const plain = await call('/sites', 'POST', body(without));
  assert.equal(plain.status, 201); assert.equal((await plain.json()).config.runtime, undefined);
});

test('API: an edit keeps the engine, cannot change it, and a rootful app cannot become a rootless one', async () => {
  const site = await (await call('/sites', 'POST', body(withEngines, alice))).json();
  const patch = (serverId, config) => call('/sites/' + site.id, 'PATCH', { serverId, name: 'Shop', config });
  const { runtime: _kept, ...withoutRuntime } = site.config;
  assert.equal((await patch(withEngines, withoutRuntime)).status, 200);
  assert.deepEqual(JSON.parse(db.prepare('SELECT config FROM sites WHERE id=?').get(site.id).config).runtime, alice, 'an omitted runtime keeps the saved one');
  assert.equal((await patch(withEngines, { ...withoutRuntime, runtime: { engine: 'docker', rootless: false } })).status, 400);
  assert.equal((await patch(withEngines, { ...withoutRuntime, runtime: { ...alice, uid: 1002 } })).status, 400);
  assert.equal((await patch(withEngines, { ...withoutRuntime, runtime: alice })).status, 200);
  db.prepare('INSERT OR IGNORE INTO site_archives(site_id,archived_at) SELECT id,? FROM sites').run(new Date().toISOString());
  const rootful = await (await call('/sites', 'POST', body(withEngines))).json();
  const upgrade = await call('/sites/' + rootful.id, 'PATCH', { serverId: withEngines, name: 'Shop', config: { ...rootful.config, runtime: alice } });
  assert.equal(upgrade.status, 400); assert.match(JSON.stringify(await upgrade.json()), /keeps its container engine/);
  assert.equal((await call('/sites/' + rootful.id, 'PATCH', { serverId: withEngines, name: 'Shop', config: { ...rootful.config, runtime: { engine: 'docker', rootless: false } } })).status, 200);
});

test.after(() => http.close());
