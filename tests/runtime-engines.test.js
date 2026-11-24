import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runtimeSchema, cleanEngines, runtimeRefusal, appRuntime, isRootfulDocker, cleanDiscovered, cleanEngineErrors, hasForeignRuntime, manifestRuntime, restoreRuntimeProblem } from '../src/runtime.js';
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

const entry = (extra = {}) => ({ hardening: null, links: null, runtime: alice, id: 'aabbccddeeff', name: 'shop', image: 'registry.invalid/shop:1', state: 'running', running: true, health: null, labels: { a: 'b' },
  mounts: [{ Type: 'volume', Name: 'data', Source: '/x', Destination: '/data', RW: true, Extra: 'dropped' }], temporaryMemoryFolders: ['/tmp'], ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080', Junk: 1 }] }, webHints: [{ evil: 1 }], backupConfiguration: { configFiles: ['/etc/passwd'] }, ...extra });

test('discovered containers of other engines are rebuilt, capped and only kept for engines the server reported', () => {
  const rootful = { id: 'x', name: 'web', anything: ['kept as is'] };
  const clean = cleanDiscovered([rootful, entry(), entry({ id: 'ffeeddccbbaa', name: 'worker', runtime: { ...alice, uid: 1002 } })], { engines: reported });
  assert.equal(clean.length, 2); assert.equal(clean[0], rootful);
  assert.deepEqual(clean[1].mounts, [{ Type: 'volume', Name: 'data', Source: '/x', Destination: '/data', RW: true }]);
  assert.deepEqual(clean[1].ports, { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] });
  assert.deepEqual(clean[1].webHints, []); assert.deepEqual(clean[1].backupConfiguration, { composeFiles: [], configFiles: [], directory: '' });
  for (const bad of [{ name: '../x' }, { name: 5 }, { id: 'zz' }, { id: 'a'.repeat(65) }, { runtime: 'podman' }, { runtime: { engine: 'lxc', rootless: false } }])
    assert.equal(cleanDiscovered([entry(bad)], { engines: reported }).length, 0, JSON.stringify(bad));
  const long = cleanDiscovered([entry({ image: 'i'.repeat(600), labels: { ['k'.repeat(300)]: 'v', fine: 'v'.repeat(2000), ok: 'v' } })], { engines: reported })[0];
  assert.equal(long.image, null); assert.deepEqual(long.labels, { ok: 'v' });
  assert.equal(cleanDiscovered(Array.from({ length: 500 }, (_, n) => entry({ name: 'c' + n })), { engines: reported }).length, 200);
  assert.equal(cleanDiscovered([entry()], {}).length, 0, 'no reported engines keeps nothing foreign');
  assert.equal(hasForeignRuntime({ runtime: alice }) && hasForeignRuntime(JSON.stringify({ runtime: alice })) && !hasForeignRuntime({}) && !hasForeignRuntime({ runtime: { engine: 'docker', rootless: false } }) && !hasForeignRuntime('{bad'), true);
});

const idMap = { uid: 1001, gid: 1001, subuid: [100000, 65536], subgid: [100000, 65536] };
test('format 3 backups record the engine and ID map, and only when they match the app', () => {
  assert.deepEqual(manifestRuntime({}, undefined), {});
  assert.deepEqual(manifestRuntime({ formatVersion: 1 }, { engine: 'docker', rootless: false }), {});
  assert.deepEqual(manifestRuntime({ formatVersion: 3, runtime: alice, idMap }, alice), { formatVersion: 3, runtime: alice, idMap });
  assert.deepEqual(manifestRuntime({ formatVersion: 3, runtime: { engine: 'podman', rootless: false } }, { engine: 'podman', rootless: false }), { formatVersion: 3, runtime: { engine: 'podman', rootless: false } });
  for (const [manifest, saved] of [[{}, alice], [{ formatVersion: 3, runtime: alice }, alice], [{ formatVersion: 3, runtime: alice, idMap: { ...idMap, uid: 0 } }, alice], [{ formatVersion: 3, runtime: alice, idMap: { ...idMap, subuid: [0, 5] } }, alice],
    [{ formatVersion: 3, runtime: alice, idMap }, { ...alice, uid: 1002 }], [{ formatVersion: 3, runtime: alice, idMap }, undefined], [{ formatVersion: 1, runtime: alice, idMap }, alice], [{ formatVersion: 3, runtime: { engine: 'docker', rootless: false } }, undefined],
    [{ formatVersion: 3, runtime: { engine: 'podman', rootless: false }, idMap }, { engine: 'podman', rootless: false }], [{ formatVersion: 3, runtime: 'x' }, alice]])
    assert.ok(manifestRuntime(manifest, saved).error, JSON.stringify(manifest));
});

test('a restore target must be the same engine kind, rootless-ness and one container, and be reported by the server', () => {
  const caps = { engines: reported };
  assert.equal(restoreRuntimeProblem(alice, undefined, caps), '');
  assert.equal(restoreRuntimeProblem(alice, alice, caps), '');
  assert.equal(restoreRuntimeProblem(undefined, undefined, caps), '');
  assert.match(restoreRuntimeProblem(undefined, alice, caps), /rootful Docker/);
  assert.match(restoreRuntimeProblem(alice, { engine: 'docker', rootless: true, user: 'alice', uid: 1001 }, caps), /same container engine/);
  assert.match(restoreRuntimeProblem(alice, { engine: 'podman', rootless: false }, caps), /rootless/);
  assert.match(restoreRuntimeProblem(alice, { ...alice, uid: 1002 }, caps), /does not have that container engine/);
  assert.match(restoreRuntimeProblem(alice, alice, {}), /Test connection/);
  assert.match(restoreRuntimeProblem(alice, alice, caps, { containers: 2 }), /several containers/);
  assert.match(restoreRuntimeProblem(alice, alice, caps, { chainLength: 2 }), /not incremental/);
  assert.match(restoreRuntimeProblem(alice, 'junk', caps), /not valid/);
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

test('API: operations that would use rootful Docker refuse the containers of a Podman or rootless app', async () => {
  const site = await (await call('/sites', 'POST', body(withEngines, alice))).json();
  const described = await call(`/servers/${withEngines}/describe-containers?containers=shop`, 'GET');
  assert.equal(described.status, 409); assert.match(JSON.stringify(await described.json()), /Podman or a rootless engine/);
  assert.equal((await call(`/servers/${withEngines}/project-files?containers=shop`, 'GET')).status, 409);
  const heal = await call(`/sites/${site.id}/self-heal`, 'PUT', { enabled: true, maxRestarts: 3, windowMinutes: 60 });
  assert.equal(heal.status, 409); assert.match(JSON.stringify(await heal.json()), /rootful Docker only/);
});

test('restore tests send the engine of a Podman or rootless backup with every step, and nothing for rootful Docker', async () => {
  const { testRuntime } = await import('../src/restore-tests/engine.js');
  db.pragma ? db.pragma('foreign_keys = OFF') : db.exec('PRAGMA foreign_keys = OFF');
  const backup = (manifest, name) => { const row = id(); db.prepare('INSERT INTO backups(id,site_id,job_id,captured_at,path,size,checksum,manifest,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(row, name, name, 'x', '/x', 1, 'x', JSON.stringify(manifest), 'x'); return row; };
  assert.deepEqual(testRuntime({ backup_id: backup({ formatVersion: 3, runtime: alice, idMap }, 'a') }), alice);
  for (const manifest of [{}, { formatVersion: 1 }, { runtime: { engine: 'docker', rootless: false } }, { runtime: { engine: 'lxc', rootless: false } }, { runtime: 'x' }])
    assert.equal(testRuntime({ backup_id: backup(manifest, 'b') }), null, JSON.stringify(manifest));
  assert.equal(testRuntime({ backup_id: null }), null); assert.equal(testRuntime({ backup_id: 'missing' }), null);
});

test('move preflight: engine kinds, reported target engine, privileged ports, linger and owners are judged, and the move stays blocked', async () => {
  const { runtimeMoveChecks, RUNTIME_MOVES_EXECUTABLE } = await import('../src/moves/preflight.js');
  const run = (site, target) => { const found = []; runtimeMoveChecks({ site: { ports: [], ...site }, target: { name: 'Target', ...target } }, (id, status, title, text) => found.push({ id, status, text })); return found; };
  assert.deepEqual(run({}, {}), [], 'an ordinary move gets no new check');
  assert.deepEqual(run({ runtime: { engine: 'docker', rootless: false } }, { runtime: { engine: 'docker', rootless: false } }), []);
  assert.equal(RUNTIME_MOVES_EXECUTABLE, false);
  const bob = { engine: 'podman', rootless: true, user: 'bob', uid: 1002 }, floor = { portFloor: 1024, linger: { bob: true } };
  const podmanEngines = [{ ...bob, version: '5.2.1', cgroupDelegated: true }, { engine: 'podman', rootless: false, version: '5.2.1', cgroupDelegated: true }];
  assert.deepEqual(run({ runtime: alice }, { runtime: { engine: 'docker', rootless: false } }).map(item => item.id), ['runtime-kind']);
  assert.deepEqual(run({ runtime: { engine: 'docker', rootless: false } }, { runtime: alice, engines: reported }).map(item => item.id).slice(0, 1), ['runtime-kind']);
  const ok = run({ runtime: alice, ports: [{ hostPort: 8080 }] }, { runtime: bob, engines: podmanEngines, runtimeFacts: floor });
  assert.deepEqual(ok.map(item => item.id), ['runtime-owners', 'runtime-move']); assert.equal(ok.at(-1).status, 'block');
  assert.ok(run({ runtime: alice }, { runtime: bob, engines: [], runtimeFacts: floor }).some(item => item.id === 'runtime-target' && item.status === 'block'));
  const low = run({ runtime: alice, ports: [{ hostPort: 443 }, { hostPort: 80 }, { hostPort: 8080 }] }, { runtime: bob, engines: podmanEngines, runtimeFacts: floor }).find(item => item.id === 'runtime-ports');
  assert.equal(low.status, 'block'); assert.match(low.text, /ports 80, 443/);
  assert.equal(run({ runtime: alice, ports: [{ hostPort: 80 }] }, { runtime: bob, engines: podmanEngines, runtimeFacts: { portFloor: 80, linger: { bob: true } } }).some(item => item.id === 'runtime-ports'), false);
  assert.ok(run({ runtime: alice }, { runtime: bob, engines: podmanEngines, runtimeFacts: { linger: { bob: true } } }).some(item => item.id === 'runtime-ports' && /could not check/.test(item.text)));
  for (const facts of [{ portFloor: 1024, linger: { bob: false } }, { portFloor: 1024, linger: {} }, { portFloor: 1024 }, undefined])
    assert.ok(run({ runtime: alice }, { runtime: bob, engines: podmanEngines, runtimeFacts: facts }).some(item => item.id === 'runtime-linger' && item.status === 'warn'), JSON.stringify(facts));
  assert.deepEqual(run({ runtime: alice }, { engines: [{ ...alice, version: '5.2.1', cgroupDelegated: true }], runtimeFacts: { portFloor: 1024, linger: { alice: true } } }).map(item => item.id), ['runtime-move'], 'the same user needs no translation');
});

test('server cleanup knows the Podman and rootless kinds', async () => {
  const { CLEANUP_KINDS } = await import('../src/server-cleanup.js');
  for (const kind of ['containers', 'images', 'volumes', 'buildCache', 'runtimeData', 'runtimeContainers']) assert.ok(CLEANUP_KINDS.includes(kind), kind);
});

test('engines whose container list failed are reported with a fixed reason, only for reported engines', () => {
  const caps = { engines: reported };
  assert.deepEqual(cleanEngineErrors([{ runtime: alice, reason: 'failed' }], caps), [{ runtime: alice, reason: 'failed' }]);
  for (const bad of [{ runtime: alice, reason: 'the engine said secret things' }, { runtime: { ...alice, uid: 1003 }, reason: 'failed' }, { runtime: { engine: 'docker', rootless: false }, reason: 'failed' }, { runtime: 'x', reason: 'failed' }, null, 5])
    assert.deepEqual(cleanEngineErrors([bad], caps), [], JSON.stringify(bad));
  assert.deepEqual(cleanEngineErrors([{ runtime: alice, reason: 'timeout' }, { runtime: alice, reason: 'failed' }], caps), [{ runtime: alice, reason: 'timeout' }], 'one entry per engine');
  assert.deepEqual(cleanEngineErrors('x', caps), []); assert.deepEqual(cleanEngineErrors([{ runtime: alice, reason: 'failed' }], {}), []);
});

test.after(() => http.close());
