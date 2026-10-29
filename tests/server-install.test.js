// Install on server (docs/moving-sites.md): the allow-list, the preflight install field per distro, the API rules
// (admin only, CSRF, re-verification, busy, unsupported, installed, no command from the client) and the worker job
// against a fake helper. Real package installs are covered only by the Linux integration test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-install-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const { transport } = await import('../src/engine.js');
const installs = await import('../src/installs.js');
const plan = await import('../src/install-plan.js');
const { evaluateMove } = await import('../src/moves/preflight.js');
const { migrate, migrations } = await import('../src/migrations.js');
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
const at = () => new Date().toISOString();

function user(role, authenticatedAt = Date.now(), csrf = 'csrf') {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId, userId + '@example.invalid', 'fixture', 'fixture', '[]', at(), role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), userId, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), authenticatedAt);
  return (route, options = {}) => fetch(base + route, { ...options, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, ...(csrf ? { 'x-csrf-token': csrf } : {}), 'Content-Type': 'application/json' } });
}
const admin = user('admin'), staleAdmin = user('admin', Date.now() - 3600000), operator = user('operator'), noCsrf = user('admin', Date.now(), null);
const post = (as, route, body = {}) => as(route, { method: 'POST', body: JSON.stringify(body) });

function serverRow(name) {
  const serverId = randomUUID();
  db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(serverId, name, '203.0.113.' + Math.floor(Math.random() * 200 + 1), 22, 'root', 'fixture', '0'.repeat(64), at());
  return serverId;
}
const target = serverRow('new-srv');

// The fake helper: reports a system, records requests and plays the install stages.
const calls = [];
let system = { os: { id: 'ubuntu', versionId: '24.04' }, packageManager: 'apt', installed: { nginx: false, docker: false, compose: false, certbot: false } };
let installFault = null, offline = false;
const original = transport.remote;
transport.remote = async (server, request, onStage = () => {}) => {
  calls.push({ server: server.name, request });
  if (offline) throw new Error('connect ECONNREFUSED');
  if (request.operation === 'install-status') return structuredClone(system);
  if (request.operation === 'install') {
    for (const stage of ['connected', 'update', 'install', 'verify']) {
      onStage(stage);
      if (installFault && installFault.stage === stage) throw Object.assign(new Error(installFault.message), { remoteReported: true });
    }
    return { package: request.package, installed: true };
  }
  throw new Error('unexpected operation ' + request.operation);
};
test.after(() => { transport.remote = original; listener.close(); });
const installCalls = () => calls.filter(item => item.request.operation === 'install');

// ---------- the allow-list and the per-distro field ----------
test('the package table is distro packages only, and the helper has the identical table', async () => {
  const source = await readFile(new URL('../remote/helper.py', import.meta.url), 'utf8');
  const helperTable = JSON.parse(/INSTALL_PLAN_JSON=r'''(.*?)'''/s.exec(source)[1]);
  assert.deepEqual(helperTable, plan.PACKAGE_MAP);
  assert.deepEqual([...plan.INSTALL_PACKAGES], ['nginx', 'docker', 'compose', 'certbot']);
  for (const packages of Object.values(plan.PACKAGE_MAP)) for (const names of Object.values(packages)) for (const name of names) assert.match(name, /^[a-z0-9][a-z0-9.+-]*$/);
});

test('the helper maps the name to fixed argv and never runs a shell or a downloaded script', async () => {
  const source = await readFile(new URL('../remote/helper.py', import.meta.url), 'utf8');
  const section = source.slice(source.indexOf('# ---- Install on server'), source.indexOf('def place_tree(')).split(/\r?\n/).filter(line => !line.startsWith('#')).join('\n');
  assert.match(section, /'apt-get','-o','DPkg::Lock::Timeout=120','install','-y','--no-install-recommends','--no-remove']\+names/);
  assert.match(section, /command=\['dnf','install','-y'\]\+names/);
  assert.doesNotMatch(section, /shell=True|os\.system|curl|wget|add-apt-repository|apt-key|\.repo|'(auto)?remove'|'purge'|\bsed\b/);
  assert.doesNotMatch(section, /req\.get\('(command|argv|packages|args)'\)/);
});

const matrix = [
  // [os id, version, manager, package, supported, command]
  ['ubuntu', '24.04', 'apt', 'nginx', true, 'sudo apt-get update && sudo apt-get install -y --no-install-recommends nginx'],
  ['ubuntu', '24.04', 'apt', 'docker', true, 'sudo apt-get update && sudo apt-get install -y --no-install-recommends docker.io'],
  ['ubuntu', '24.04', 'apt', 'compose', true, 'sudo apt-get update && sudo apt-get install -y --no-install-recommends docker-compose-v2'],
  ['ubuntu', '24.04', 'apt', 'certbot', true, 'sudo apt-get update && sudo apt-get install -y --no-install-recommends certbot python3-certbot-nginx'],
  ['ubuntu', '20.04', 'apt', 'compose', false, 'sudo apt-get update && sudo apt-get install -y --no-install-recommends docker-compose-v2'],
  ['debian', '12', 'apt', 'nginx', true, 'sudo apt-get update && sudo apt-get install -y --no-install-recommends nginx'],
  ['debian', '12', 'apt', 'compose', false, 'sudo apt-get update && sudo apt-get install -y --no-install-recommends docker-compose-v2'],
  ['fedora', '41', 'dnf', 'nginx', true, 'sudo dnf install -y nginx'],
  ['fedora', '41', 'dnf', 'docker', true, 'sudo dnf install -y moby-engine'],
  ['fedora', '41', 'dnf', 'certbot', true, 'sudo dnf install -y certbot python3-certbot-nginx'],
  ['fedora', '41', 'dnf', 'compose', false, ''],
  ['rocky', '9.4', 'dnf', 'nginx', true, 'sudo dnf install -y nginx'],
  ['rocky', '9.4', 'dnf', 'certbot', false, ''],
  ['almalinux', '9.4', 'dnf', 'docker', false, ''],
  ['rhel', '9.4', 'dnf', 'compose', false, ''],
  ['alpine', '3.20', null, 'nginx', false, ''],
  ['linuxmint', '21', 'apt', 'nginx', false, ''],
  ['ubuntu', '24.04', null, 'nginx', false, ''],
];
test('install info per distro: supported only for apt (Debian/Ubuntu) and dnf (RHEL family/Fedora) with the fixed map', () => {
  for (const [id, versionId, manager, name, supported, command] of matrix) {
    assert.deepEqual(plan.installInfo({ os: { id, versionId }, packageManager: manager }, name), { package: name, command, supported }, `${id} ${versionId} ${name}`);
  }
});

test('odd operating system facts become unknown and never reach a command', () => {
  for (const os of [{ id: 'ubuntu; rm -rf /', versionId: '24.04' }, { id: '$(reboot)' }, { id: 'a'.repeat(80) }, null, undefined]) {
    const info = plan.installInfo({ os, packageManager: 'apt' }, 'nginx');
    assert.equal(info.supported, false); assert.equal(info.command, '');
  }
  assert.equal(plan.installInfo({ os: { id: 'ubuntu', versionId: '24.04' }, packageManager: 'zypper; id' }, 'nginx').supported, false);
});

const GiB = 1024 ** 3;
function moveFacts(change = () => {}) {
  const facts = {
    site: { id: 'site', name: 'Shop', kind: 'compose', domains: ['shop.example.com'], containerCount: 2, architecture: 'x86_64', packageBytes: GiB, ports: [], bindPaths: [], names: {}, nginxDirectives: [], maintenanceReady: true, env: [], timings: { backupSeconds: 20 } },
    source: { id: 'old', name: 'old-srv', addresses: ['203.0.113.7'] },
    target: { id: 'new', name: 'new-srv', reachable: true, hostKeyOk: true, uid: 0, architecture: 'x86_64', dockerVersion: null, composeVersion: null, freeBytes: 100 * GiB, totalBytes: 200 * GiB, usedPorts: [22], reservedPorts: [], existingPaths: [], conflicts: {},
      nginx: { installed: false }, webPortOwner: null, certbot: { installed: false, account: false }, stagingWritable: true, addresses: ['198.51.100.9'], os: { id: 'ubuntu', versionId: '24.04' }, packageManager: 'apt', candidates: { docker: '28.2' } },
    state: {}, backupStorage: { freeBytes: 50 * GiB }, dns: { mode: 'manual', records: [{ type: 'A', name: 'shop.example.com', value: '203.0.113.7' }] },
  };
  change(facts); return facts;
}
const checkFor = (result, id) => result.details.checks.filter(item => item.id === id);

test('preflight blocks carry the install field for nginx, Docker, Compose and certbot', () => {
  const result = evaluateMove(moveFacts());
  for (const [id, name] of [['nginx', 'nginx'], ['docker', 'docker'], ['compose', 'compose'], ['tls', 'certbot']]) {
    const [item] = checkFor(result, id);
    assert.ok(item, id); assert.deepEqual(item.install, plan.installInfo({ os: { id: 'ubuntu', versionId: '24.04' }, packageManager: 'apt' }, name));
    assert.equal(item.install.supported, true); assert.match(item.install.command, /^sudo apt-get update && sudo apt-get install -y /);
  }
  assert.equal(checkFor(result, 'nginx')[0].status, 'block');
});

test('preflight install field follows the distro, stays plain for unusual systems and is absent when nothing is missing', () => {
  const rocky = evaluateMove(moveFacts(f => { f.target.os = { id: 'rocky', versionId: '9.4' }; f.target.packageManager = 'dnf'; }));
  assert.deepEqual(checkFor(rocky, 'nginx')[0].install, { package: 'nginx', command: 'sudo dnf install -y nginx', supported: true });
  assert.deepEqual(checkFor(rocky, 'docker')[0].install, { package: 'docker', command: '', supported: false });
  const alpine = evaluateMove(moveFacts(f => { f.target.os = { id: 'alpine', versionId: '3.20' }; f.target.packageManager = null; }));
  assert.deepEqual(checkFor(alpine, 'nginx')[0].install, { package: 'nginx', command: '', supported: false });
  assert.match(checkFor(alpine, 'nginx')[0].text, /needs nginx/);
  const unread = evaluateMove(moveFacts(f => { delete f.target.os; delete f.target.packageManager; }));
  assert.equal(checkFor(unread, 'nginx')[0].install, undefined);
  const ready = evaluateMove(moveFacts(f => { Object.assign(f.target, { dockerVersion: '28.1.1', composeVersion: '2.29.1', nginx: { installed: true, configOk: true, serverNames: [] }, certbot: { installed: true, account: true }, webPortOwner: 'nginx' }); }));
  assert.ok(ready.details.checks.every(item => item.install === undefined));
  const oldCompose = evaluateMove(moveFacts(f => { f.target.dockerVersion = '28.1.1'; f.target.composeVersion = '1.29.2'; }));
  assert.equal(checkFor(oldCompose, 'compose')[0].install, undefined, 'an old Compose is updated by hand, never installed over');
});

// ---------- the API ----------
const url = `/servers/${target}/install`;
test.beforeEach(() => { calls.length = 0; installFault = null; offline = false; system = { os: { id: 'ubuntu', versionId: '24.04' }, packageManager: 'apt', installed: { nginx: false, docker: false, compose: false, certbot: false } }; db.prepare('DELETE FROM server_installs').run(); db.prepare('DELETE FROM rate_limits').run(); });

test('only administrators with a recent verification and a CSRF token may request an install', async () => {
  assert.equal((await post(operator, url, { package: 'nginx' })).status, 403);
  const stale = await post(staleAdmin, url, { package: 'nginx' });
  assert.equal(stale.status, 403); assert.equal((await stale.json()).code, 'REAUTH_REQUIRED');
  assert.equal((await post(noCsrf, url, { package: 'nginx' })).status, 403);
  assert.equal((await fetch(base + url, { method: 'POST', body: '{"package":"nginx"}', headers: { Origin: process.env.APP_ORIGIN, 'Content-Type': 'application/json' } })).status, 401);
  assert.equal(calls.length, 0, 'nothing reached a server');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM server_installs').get().n, 0);
});

test('a package outside the allow-list, and any command text from the client, is refused', async () => {
  for (const body of [{ package: 'bash' }, { package: 'nginx; reboot' }, { package: '' }, { package: ['nginx'] }, {}, { package: 'nginx', command: 'rm -rf /' }, { package: 'nginx', packages: ['evil'] }, { package: 'nginx', argv: ['sh'] }, { command: 'apt-get install nginx' }]) {
    db.prepare('DELETE FROM rate_limits').run();
    const response = await post(user('admin'), url, body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal((await post(user('admin'), `/servers/${randomUUID()}/install`, { package: 'nginx' })).status, 404);
  assert.equal((await post(user('admin'), '/servers/not-a-uuid/install', { package: 'nginx' })).status, 400);
  assert.equal(calls.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM server_installs').get().n, 0);
});

test('a supported, missing package is queued as a job and audited', async () => {
  const response = await post(user('admin'), url, { package: 'nginx' });
  assert.equal(response.status, 202);
  const { job } = await response.json();
  assert.deepEqual(Object.keys(job), ['id']);
  const row = db.prepare('SELECT * FROM server_installs WHERE id=?').get(job.id);
  assert.equal(row.status, 'queued'); assert.equal(row.package, 'nginx'); assert.equal(row.server_id, target);
  assert.deepEqual(JSON.parse(row.steps), [{ name: 'Connected', status: 'queued' }, { name: 'Package list updated', status: 'queued' }, { name: 'Installing nginx', status: 'queued' }, { name: 'Checking nginx works', status: 'queued' }]);
  assert.deepEqual(calls.map(item => item.request), [{ operation: 'install-status' }], 'the request only read the system; nothing was installed by the API');
  const audit = db.prepare("SELECT * FROM audit_events WHERE action='server.install.requested' AND target=?").all(target);
  assert.equal(audit.length, 1); assert.deepEqual(JSON.parse(audit[0].detail), { package: 'nginx', job: job.id });
  const view = await (await admin('/jobs/' + job.id)).json();
  assert.equal(view.type, 'install'); assert.equal(view.status, 'queued'); assert.equal(view.details.steps.length, 4); assert.equal(view.details.package, 'nginx');
});

test('the server is re-checked: unsupported, already installed and unreachable are refused with their codes', async () => {
  system.os = { id: 'rocky', versionId: '9.4' }; system.packageManager = 'dnf';
  let response = await post(user('admin'), url, { package: 'certbot' });
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'INSTALL_UNSUPPORTED');
  system.os = { id: 'ubuntu', versionId: '24.04' }; system.packageManager = 'apt'; system.installed.nginx = true;
  response = await post(user('admin'), url, { package: 'nginx' });
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'ALREADY_INSTALLED');
  offline = true;
  response = await post(user('admin'), url, { package: 'docker' });
  const unreachable = await response.json();
  assert.equal(response.status, 409); assert.equal(unreachable.code, 'SERVER_UNREACHABLE');
  assert.doesNotMatch(JSON.stringify(unreachable), /ECONNREFUSED/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM server_installs').get().n, 0);
  assert.equal(installCalls().length, 0);
});

test('a server with a running job, an active move or another install is busy', async () => {
  const siteId = randomUUID();
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, target, 'busy-site', '{}', at());
  const jobId = randomUUID();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','running','copying',?)").run(jobId, siteId, at());
  let response = await post(user('admin'), url, { package: 'nginx' });
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'SERVER_BUSY');
  db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(jobId);
  const other = serverRow('old-srv'), moveId = randomUUID();
  db.prepare("INSERT INTO site_moves(id,site_id,source_server_id,target_server_id,state,options,preflight,preflight_hash,actor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(moveId, siteId, other, target, 'testing', '{}', '{}', 'x', 'a', at(), at());
  response = await post(user('admin'), url, { package: 'nginx' });
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'SERVER_BUSY');
  db.prepare("UPDATE site_moves SET state='cleaned' WHERE id=?").run(moveId);
  assert.equal((await post(user('admin'), url, { package: 'nginx' })).status, 202);
  response = await post(user('admin'), url, { package: 'docker' });
  assert.equal(response.status, 409, 'a second install on the same server waits for the first');
  assert.equal(installCalls().length, 0);
  db.prepare('DELETE FROM site_moves WHERE site_id=?').run(siteId); db.prepare('DELETE FROM jobs WHERE site_id=?').run(siteId); db.prepare('DELETE FROM sites WHERE id=?').run(siteId);
});

// ---------- the worker ----------
test('the worker plays the stages into the four steps and finishes completed', async () => {
  const { job } = await (await post(user('admin'), url, { package: 'docker' })).json();
  const claimed = installs.claimInstall();
  assert.equal(claimed.id, job.id); assert.equal(installs.claimInstall(), undefined);
  const seen = [];
  const run = installs.executeInstall(claimed);
  await run;
  const done = installs.findInstall(job.id);
  assert.equal(done.status, 'completed'); assert.ok(done.finished_at); assert.equal(done.error, null);
  assert.deepEqual(done.details.steps, [{ name: 'Connected', status: 'done' }, { name: 'Package list updated', status: 'done' }, { name: 'Installing Docker', status: 'done' }, { name: 'Checking Docker works', status: 'done' }]);
  assert.deepEqual(installCalls().map(item => item.request), [{ operation: 'install', package: 'docker' }], 'the helper gets only the package name');
  assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='server.install.completed'").get()); seen.push(1);
});

test('a failed install marks the running step failed, keeps later steps queued and shows only plain text', async () => {
  installFault = { stage: 'install', message: 'PACKAGE_TOOL_BUSY' };
  const { job } = await (await post(user('admin'), url, { package: 'nginx' })).json();
  await installs.executeInstall(installs.claimInstall());
  const failed = installs.findInstall(job.id);
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /^Another package tool/);
  assert.deepEqual(failed.details.steps.map(step => step.status), ['done', 'done', 'failed', 'queued']);
  offline = false;
  const second = await (await post(user('admin'), url, { package: 'nginx' })).json();
  offline = true;
  await installs.executeInstall(installs.claimInstall());
  const lost = installs.findInstall(second.job.id);
  assert.equal(lost.status, 'failed'); assert.equal(lost.details.steps[0].status, 'failed');
  assert.doesNotMatch(lost.error, /ECONNREFUSED/); assert.match(lost.error, /connection to new-srv failed/);
});

test('an install waits while a site job runs on its server, and an interrupted one fails plainly', async () => {
  const siteId = randomUUID(), jobId = randomUUID();
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, target, 'waiting-site', '{}', at());
  const { job } = await (await post(user('admin'), url, { package: 'nginx' })).json();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','running','copying',?)").run(jobId, siteId, at());
  assert.equal(installs.claimInstall(), undefined);
  db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(jobId);
  assert.equal(installs.claimInstall().id, job.id);
  installs.failInterruptedInstalls();
  const row = installs.findInstall(job.id);
  assert.equal(row.status, 'failed'); assert.match(row.error, /stopped while installing/);
  db.prepare('DELETE FROM site_moves WHERE site_id=?').run(siteId); db.prepare('DELETE FROM jobs WHERE site_id=?').run(siteId); db.prepare('DELETE FROM sites WHERE id=?').run(siteId);
});

test('schema v7 only adds the server_installs table', () => {
  assert.equal(migrations.find(item => item.version === 7).name, 'server-installs'); assert.equal(migrations.find(item => item.version === 7).compatible, true);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='server_installs'").get());
  assert.throws(() => db.prepare("INSERT INTO server_installs(id,server_id,package,status,stage,steps,actor,created_at) VALUES('x',?,'bash','queued','q','[]','a',?)").run(target, at()), /CHECK/);
  assert.equal(typeof migrate, 'function');
});

// ---------- review fixes ----------
test('Docker offered by the system below what the site needs is not installable, with a plain reason and the official docs', () => {
  const facts = { os: { id: 'ubuntu', versionId: '24.04' }, packageManager: 'apt', candidates: { docker: '26.1' } };
  const multi = plan.installInfo(facts, 'docker', { needDockerMajor: 28 });
  assert.equal(multi.supported, false);
  assert.equal(multi.reason, "This server's packages offer Docker 26.1; this site needs 28 or newer. Install Docker from Docker's own repository instead.");
  assert.match(multi.command, /^# .*https:\/\/docs\.docker\.com\/engine\/install\/$/);
  assert.doesNotMatch(multi.command, /curl|wget|\| *sh/);
  assert.equal(plan.installInfo(facts, 'docker', { needDockerMajor: 0 }).supported, true, 'a single container does not need 28');
  assert.equal(plan.installInfo({ ...facts, candidates: { docker: '28.2' } }, 'docker', { needDockerMajor: 28 }).supported, true);
  for (const candidates of [{ docker: 'x; rm' }, {}, undefined]) {
    const unread = plan.installInfo({ ...facts, candidates }, 'docker', { needDockerMajor: 28 });
    assert.equal(unread.supported, false, 'fail-closed: an unreadable offered version does not meet the need');
    assert.equal(unread.reason, "DockNest could not read which Docker version this server's packages offer; this site needs 28 or newer. Install Docker from Docker's own repository instead.");
  }
  assert.equal(plan.installInfo({ ...facts, candidates: {} }, 'docker', { needDockerMajor: 0 }).supported, true, 'without a need the offered version does not matter');
  assert.equal(plan.installInfo({ ...facts, candidates: {} }, 'nginx', { needDockerMajor: 28 }).supported, true, 'the Docker need applies to Docker only');
  assert.deepEqual([plan.dockerNeed(undefined), plan.dockerNeed(1), plan.dockerNeed(2)], [{ needDockerMajor: 0 }, { needDockerMajor: 0 }, { needDockerMajor: 28 }]);
  const result = evaluateMove(moveFacts(f => { f.target.candidates = { docker: '26.1' }; }));
  assert.equal(checkFor(result, 'docker')[0].install.supported, false);
  assert.match(checkFor(result, 'docker')[0].install.reason, /offer Docker 26\.1; this site needs 28 or newer/);
  const single = evaluateMove(moveFacts(f => { f.target.candidates = { docker: '26.1' }; f.site.containerCount = 1; }));
  assert.equal(checkFor(single, 'docker')[0].install.supported, true);
});

test('helper failure codes map to fixed sentences; free text, stdout and unknown codes never reach the job', async () => {
  for (const code of plan.installErrorCodes) assert.ok(plan.installErrorText(code, 'nginx').length > 10, code);
  assert.match(plan.installErrorText('TIMEOUT_APT_INSTALL', 'docker'), /sudo dpkg --configure -a/);
  assert.doesNotMatch(plan.installErrorText('TIMEOUT_INSTALL', 'docker'), /dpkg/);
  const secret = 'E: password=hunter2 https://user:pw@example.invalid/x';
  assert.equal(plan.installErrorText(secret, 'nginx'), plan.installErrorText('GENERIC', 'nginx'));
  assert.equal(plan.installErrorText('__proto__', 'nginx'), plan.installErrorText('GENERIC', 'nginx'));
  installFault = { stage: 'update', message: secret };
  const { job } = await (await post(user('admin'), url, { package: 'nginx' })).json();
  await installs.executeInstall(installs.claimInstall());
  const failed = installs.findInstall(job.id);
  assert.equal(failed.error, plan.installErrorText('GENERIC', 'nginx'));
  assert.doesNotMatch(JSON.stringify(failed), /hunter2|example\.invalid/);
});

test('an install for a site applies the same Docker need as move preflight; the server panel sends no site', async () => {
  const site = containers => { const siteId = randomUUID(); db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, target, 'need-site', JSON.stringify({ containers }), at()); return siteId; };
  const group = site(['a', 'b']), single = site(['a']);
  system.candidates = { docker: '26.1' };
  let response = await post(user('admin'), url, { package: 'docker', siteId: group });
  let body = await response.json();
  assert.equal(response.status, 409); assert.equal(body.code, 'INSTALL_UNSUPPORTED'); assert.match(body.error, /offer Docker 26\.1; this site needs 28 or newer/);
  system.candidates = {};
  body = await (await post(user('admin'), url, { package: 'docker', siteId: group })).json();
  assert.match(body.error, /could not read which Docker version/);
  assert.equal(installCalls().length, 0); assert.equal(db.prepare('SELECT COUNT(*) n FROM server_installs').get().n, 0);
  assert.equal((await post(user('admin'), url, { package: 'docker', siteId: randomUUID() })).status, 404);
  assert.equal((await post(user('admin'), url, { package: 'docker', siteId: 'not-a-uuid' })).status, 400);
  system.candidates = { docker: '26.1' };
  assert.equal((await post(user('admin'), url, { package: 'docker', siteId: single })).status, 202, 'one container does not need 28');
  db.prepare('DELETE FROM server_installs').run();
  assert.equal((await post(user('admin'), url, { package: 'docker' })).status, 202, 'the server panel: the move preflight still blocks an old Docker later');
  db.prepare('DELETE FROM sites WHERE id IN (?,?)').run(group, single);
});

test('Docker already on the server, from any source, is never installed over', async () => {
  system.installed.docker = true;
  const response = await post(user('admin'), url, { package: 'docker' });
  const body = await response.json();
  assert.equal(response.status, 409); assert.equal(body.code, 'ALREADY_INSTALLED');
  assert.equal(body.error, 'Docker is installed but not running. Start it, then check again.');
  assert.equal(installCalls().length, 0);
});

test('an install never starts while a move touches its server, and a move never starts while an install is queued or running', async () => {
  const siteId = randomUUID(), other = serverRow('src-srv'), moveId = randomUUID();
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, other, 'guard-site', '{}', at());
  const { job } = await (await post(user('admin'), url, { package: 'nginx' })).json();
  const insertMove = (id, source, destination, state) => db.prepare('INSERT INTO site_moves(id,site_id,source_server_id,target_server_id,state,options,preflight,preflight_hash,actor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, siteId, source, destination, state, '{}', '{}', 'x', 'a', at(), at());
  insertMove(moveId, other, target, 'testing');
  assert.equal(installs.claimInstall(), undefined, 'the worker leaves the install queued while the move is active');
  db.prepare("UPDATE site_moves SET state='cleaned' WHERE id=?").run(moveId);
  assert.equal(installs.claimInstall().id, job.id);
  // The install is now running on the target: a draft move to it, or from it, cannot start.
  for (const [source, destination] of [[other, target], [target, other]]) {
    const draft = randomUUID();
    insertMove(draft, source, destination, 'draft');
    const response = await post(user('admin'), `/moves/${draft}/start`, { preflightHash: 'a'.repeat(64) });
    const body = await response.json();
    assert.equal(response.status, 409); assert.equal(body.code, 'INSTALL_RUNNING'); assert.match(body.error, /installing software on /);
    assert.equal(db.prepare('SELECT state FROM site_moves WHERE id=?').get(draft).state, 'draft');
    db.prepare('DELETE FROM site_moves WHERE id=?').run(draft);
  }
  db.prepare('DELETE FROM site_moves WHERE site_id=?').run(siteId); db.prepare('DELETE FROM sites WHERE id=?').run(siteId);
});
