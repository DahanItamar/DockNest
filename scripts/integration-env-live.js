// Environment-gated live checks (docs/live-checks-3.0.0.md): scenarios that need a real rootless engine or a real WebDAV
// server, so they cannot join the required Linux integration run. Run by .github/workflows/env-live.yml (workflow_dispatch
// only) on an Ubuntu runner, one scenario per job: LIVE_SCENARIO = rootless-docker | rootless-podman | webdav | no-delegation.
// The runner itself is the "server": DockNest connects to it over SSH as root with a pinned host key, exactly as to any other
// server, and drives the real helper. Fake data only; every credential is made at run time and never printed.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, readdir, rm, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

const exec = promisify(execFile);
const scenario = process.env.LIVE_SCENARIO || '';
if (!['rootless-docker', 'rootless-podman', 'webdav', 'no-delegation'].includes(scenario)) throw new Error('LIVE_SCENARIO must be rootless-docker, rootless-podman, webdav or no-delegation');
const sh = async (command, args = [], options = {}) => {
  try { return (await exec(command, args, { maxBuffer: 16 * 1024 * 1024, ...options })).stdout.trim(); }
  catch (error) { error.message += ' | ' + String(error.stderr || '').replace(/\s+/g, ' ').slice(-1500); throw error; }  // a failed run must say why
};
const sudo = (...args) => sh('sudo', args);
const wait = ms => new Promise(done => setTimeout(done, ms));
async function until(check, message, seconds = 120) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) { try { if (await check()) return; } catch { /* retried */ } await wait(1000); }
  throw new Error(message);
}

const token = randomUUID().slice(0, 8), directory = resolve('data', `env-live-${token}`);
await mkdir(directory, { recursive: true });
Object.assign(process.env, {
  DATA_DIR: join(directory, 'state'), BACKUP_DIR: join(directory, 'backups'), MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'),
  APP_ORIGIN: 'http://127.0.0.1:3000', NODE_ENV: 'test', SECURE_COOKIES: 'false', BACKUP_STORAGE: scenario === 'webdav' ? 'unconfigured' : 'local'
});
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'), { mode: 0o600 });
const evidence = { scenario, at: new Date().toISOString(), release: process.env.GITHUB_SHA || (await sh('git', ['rev-parse', 'HEAD'])), checks: [] };
const record = message => { evidence.checks.push(message); console.log('PASS ' + message); };
let db;
const lines = text => text.split('\n').map(line => line.trim()).filter(Boolean);

// ---- the runner as a server -----------------------------------------------------------------------------------------------
async function connectRunner() {
  const { prepareServerKey } = await import('../src/server-onboarding.js');
  const { seal } = await import('../src/crypto.js');
  const { testServer } = await import('../src/engine.js');
  await sudo('systemctl', 'start', 'ssh');
  const key = await prepareServerKey();
  const publicFile = join(directory, 'runner.pub');
  await writeFile(publicFile, key.publicKey + '\n');
  await sudo('mkdir', '-p', '/root/.ssh');
  await sudo('cp', publicFile, '/root/.ssh/authorized_keys');
  await sudo('chown', 'root:root', '/root/.ssh/authorized_keys');
  await sudo('chmod', '600', '/root/.ssh/authorized_keys');
  const publicHostKey = await sudo('cat', '/etc/ssh/ssh_host_ed25519_key.pub');
  const server = { id: randomUUID(), name: 'runner', host: '127.0.0.1', port: 22, username: 'root', private_key: seal(key.privateKey),
    host_key: createHash('sha256').update(Buffer.from(publicHostKey.split(' ')[1], 'base64')).digest('hex') };
  const capabilities = await testServer(server);
  assert.equal(capabilities.uid, 0);
  db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,capabilities,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(server.id, server.name, server.host, server.port, 'root', server.private_key, server.host_key, JSON.stringify(capabilities), 'connected', new Date().toISOString());
  return { server, capabilities };
}

// ---- a rootless user ------------------------------------------------------------------------------------------------------
const USER = 'dnlive';
async function diagnostics(uid) {
  const tryRun = async (...args) => (await sudo(...args).catch(error => 'ERR ' + String(error.stderr || error.message).slice(0, 300))).slice(0, 700);
  return JSON.stringify({ run: await tryRun('ls', '-la', `/run/user/${uid}`), unit: await tryRun('systemctl', 'status', `user@${uid}.service`, '--no-pager', '-l'), pkg: await tryRun('dpkg', '-l', 'dbus-user-session'), sessions: await tryRun('loginctl', 'list-users') });
}
async function createUser({ delegated }) {
  // dbus-user-session starts the per-user bus with the user's systemd instance; uidmap provides newuidmap and newgidmap.
  // Ubuntu 24.04 and later restrict unprivileged user namespaces with AppArmor; a rootless engine needs them. Disposable runner only.
  await sudo('sysctl', '-w', 'kernel.apparmor_restrict_unprivileged_userns=0').catch(() => '');
  await sudo('apt-get', 'update');
  await sudo('apt-get', 'install', '-y', '--no-install-recommends', 'dbus-user-session', 'uidmap');
  await sudo('useradd', '-m', '-s', '/bin/bash', USER);
  const uid = Number(await sh('id', ['-u', USER]));
  // memory and cpu delegated to the user's systemd instance, or deliberately not (the no-delegation scenario).
  const folder = '/etc/systemd/system/user@.service.d';
  await sudo('mkdir', '-p', folder);
  await sudo('sh', '-c', `printf '[Service]\\nDelegate=\nDelegate=${delegated ? 'cpu cpuset io memory pids' : 'pids'}\\n' > ${folder}/zz-docknest-live.conf`);
  await sudo('systemctl', 'daemon-reload');
  await sudo('loginctl', 'enable-linger', USER);
  await sudo('systemctl', 'restart', `user@${uid}.service`);
  // The user's own D-Bus socket comes from dbus.socket of the user's systemd instance; start it explicitly and keep what the
  // system says if it does not appear (a failed run must say why).
  await sudo('systemctl', '--user', '--machine', USER + '@', 'start', 'dbus.socket').catch(() => '');
  await until(async () => (await sh('sudo', ['test', '-S', `/run/user/${uid}/bus`]).then(() => true, () => false)), 'The user session bus did not start: ' + await diagnostics(uid), 60).catch(async error => { throw new Error(String(error.message).replace(/did not start: .*/s, 'did not start: ') + await diagnostics(uid)); });
  const controllers = await sudo('cat', `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`).catch(() => '');
  evidence.delegation = controllers.split(/\s+/).filter(Boolean);
  const has = ['memory', 'cpu'].every(name => evidence.delegation.includes(name));
  assert.equal(has, delegated, `delegation is ${delegated ? '' : 'not '}in place: ${controllers}`);
  return uid;
}
// A clean environment, like the one DockNest gives the engine: the runner's XDG_*, HOME and working folder must not leak into the user's tools.
const asUser = (uid, command, args, extraEnv = {}) => sudo('-u', USER, '-H', 'env', '-i', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', `HOME=/home/${USER}`, `XDG_RUNTIME_DIR=/run/user/${uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`, ...Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`), 'sh', '-c', 'cd "$HOME" && exec "$0" "$@"', command, ...args);

// ---- the fake app ---------------------------------------------------------------------------------------------------------
async function stageFixture() {
  const folder = '/tmp/dn-live-site';
  await rm(folder, { recursive: true, force: true });
  await cp('tests/integration/site', folder, { recursive: true });
  await sh('chmod', ['-R', 'a+rX', folder]);
  return folder;
}
const siteConfig = (containers, extra = {}) => ({ containers, stagingRoot: '/var/lib/docknest', exclusiveSourcesConfirmed: true, externalReferencesConfirmed: true, cleanShutdownConfirmed: true, shutdownProfile: 'generic', maintenanceRequired: false, maintenance: { required: false }, ...extra });
const MARKER = 'live-' + randomBytes(4).toString('hex');

// ---- DockNest flows -------------------------------------------------------------------------------------------------------
async function engineApi() {
  const engine = await import('../src/engine.js');
  const rt = await import('../src/restore-tests/engine.js');
  rt.testTiming.scale = 0.25; rt.testTiming.cancelPollMs = 200;
  return { ...engine, rt };
}
function addSite(server, name, config) {
  const siteId = randomUUID();
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, server.id, name, JSON.stringify(config), new Date().toISOString());
  return siteId;
}
async function backupOf(api, siteId) {
  const queued = api.enqueueBackup(siteId, 'qa'), job = api.claimJob();
  assert.equal(job.id, queued.id); await api.executeJob(job);
  const done = db.prepare('SELECT status,error FROM jobs WHERE id=?').get(job.id);
  assert.equal(done.status, 'completed', done.error);
  return db.prepare('SELECT * FROM backups WHERE job_id=?').get(job.id);
}
async function restoreOf(api, backup, server) {
  const plan = await api.planRestore(backup.id, { serverId: server.id });
  assert.equal(plan.executable, true, JSON.stringify(plan.blockers));
  const queued = await api.enqueueRestore(backup.id, plan, 'qa'), job = api.claimJob();
  assert.equal(job.id, queued.id); await api.executeJob(job);
  const done = db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
  assert.equal(done.status, 'completed', done.error);
  return JSON.parse(done.details).result;
}
async function driveTest(api, testId) {
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const test = api.rt.loadTest(testId);
    if (test.result !== null && ['done', 'failed', 'acknowledged'].includes(test.cleanup)) return test;
    api.rt.tickRestoreTests();
    const job = api.claimJob();
    if (job) await api.executeJob(job); else await wait(500);
  }
  throw new Error('The restore test did not finish in time');
}

// ---- scenarios ------------------------------------------------------------------------------------------------------------
async function rootlessEngine(engineName) {
  const delegated = scenario !== 'no-delegation';
  const uid = await createUser({ delegated });
  let cli, env = {}, runtime;
  if (engineName === 'docker') {
    await sudo('apt-get', 'install', '-y', '--no-install-recommends', 'slirp4netns', 'curl', 'iptables', 'xz-utils');
    // The runner's Docker comes without the rootless extras, so the user gets Docker's own rootless bundle (docs.docker.com, get.docker.com/rootless).
    // Not pinned: this is a manual live check on a disposable runner, and the engine version it installs is recorded in the evidence.
    await asUser(uid, 'sh', ['-c', 'curl -fsSL https://get.docker.com/rootless -o /tmp/dn-rootless-install.sh && FORCE_ROOTLESS_INSTALL=1 sh /tmp/dn-rootless-install.sh']);
    await asUser(uid, 'systemctl', ['--user', 'enable', '--now', 'docker']).catch(() => '');
    env = { DOCKER_HOST: `unix:///run/user/${uid}/docker.sock` };
    cli = (...args) => asUser(uid, 'docker', args, env);
    await until(async () => (await sh('sudo', ['test', '-S', `/run/user/${uid}/docker.sock`]).then(() => true, () => false)), 'The rootless Docker socket did not appear');
    runtime = { engine: 'docker', rootless: true, user: USER, uid };
  } else {
    await sudo('apt-get', 'install', '-y', '--no-install-recommends', 'podman', 'uidmap', 'slirp4netns', 'passt', 'crun');
    cli = (...args) => asUser(uid, 'podman', args);
    await cli('info');
    runtime = { engine: 'podman', rootless: true, user: USER, uid };
  }
  evidence.engineVersion = await cli('version', '--format', engineName === 'docker' ? '{{.Server.Version}}' : '{{.Version}}');
  const folder = await stageFixture();
  await cli('build', ...(engineName === 'podman' ? ['--format', 'docker'] : []), '-t', 'dn-live-app:local', folder);
  await cli('run', '-d', '--name', 'live-app', '-v', 'live-data:/site', 'dn-live-app:local');
  await until(async () => (await cli('inspect', '--format', '{{.State.Running}}', 'live-app')) === 'true', 'The fake app did not start');
  await cli('exec', 'live-app', 'sh', '-c', `echo ${MARKER} > /site/marker.txt`);
  record(`A fake app runs in rootless ${engineName} (${evidence.engineVersion}) for a real user, delegation ${delegated ? 'on' : 'off'}`);

  ({ db } = await import('../src/db.js'));
  const { server, capabilities } = await connectRunner();
  const engines = capabilities.engines ?? [];
  const found = engines.find(engine => engine.engine === engineName && engine.rootless && engine.user === USER && engine.uid === uid);
  assert.ok(found, 'DockNest found the rootless engine: ' + JSON.stringify(engines));
  assert.equal(found.cgroupDelegated, delegated, 'the delegation DockNest reports matches the system');
  record(`DockNest discovers the rootless ${engineName} engine of the user with cgroupDelegated=${delegated}`);
  const { remote } = await import('../src/ssh.js');
  const discovered = await remote(server, { operation: 'discover' });
  const container = discovered.containers.find(item => item.name === 'live-app');
  assert.deepEqual(container?.runtime, runtime, 'the container carries its runtime');
  record('Discover lists the rootless container tagged with its engine and user');

  const api = await engineApi();
  const siteId = addSite(server, 'live-app', siteConfig(['live-app'], { runtime }));
  const backup = await backupOf(api, siteId);
  const manifest = JSON.parse(backup.manifest);
  assert.equal(manifest.formatVersion, 3); assert.deepEqual(manifest.runtime, runtime); assert.equal(manifest.idMap.uid, uid);
  record('Backup of a rootless app is written as format 3 with the runtime and the ID map');

  if (!delegated) return noDelegation(api, siteId, server, cli);

  const result = await restoreOf(api, backup, server);
  assert.deepEqual(result.runtime, runtime);
  const copy = lines(await cli('ps', '-aq', '--filter', 'label=docker-backup-manager.restore'));
  assert.equal(copy.length, 1, 'one restored copy runs in the user engine');
  assert.equal(await cli('exec', copy[0], 'cat', '/site/marker.txt'), MARKER, 'the restored data is the data of the backup');
  const owner = await asUser(uid, 'stat', ['-c', '%u', result.dataRoot + '/data-0-0']).catch(() => '');
  evidence.dataRoot = result.dataRoot;
  record('Restore into the same user starts an isolated copy with the backed-up data, root-owned data folder outside the home');
  const cleaned = await remote(server, { operation: 'runtime-restore-cleanup', job: copy.length ? (await cli('inspect', '--format', '{{index .Config.Labels "docker-backup-manager.restore"}}', copy[0])) : '', runtime });
  assert.equal(cleaned.containers, 1); assert.equal(cleaned.dataRoot, true);
  assert.deepEqual(lines(await cli('ps', '-aq', '--filter', 'label=docker-backup-manager.restore')), [], 'cleanup removed the copy');
  await sudo('test', '!', '-e', result.dataRoot);
  record('runtime-restore-cleanup removes the copy and its data folder');

  const before = lines(await cli('ps', '-aq'));
  const test = api.rt.createRestoreTest({ siteId, serverId: server.id, liveServer: true, actor: 'qa' }).id;
  const done = await driveTest(api, test);
  assert.equal(done.result, 'passed', done.reason ?? JSON.stringify(done.checks));
  assert.deepEqual(lines(await cli('ps', '-aq')), before, 'the restore test left no container');
  assert.deepEqual(lines(await cli('ps', '-aq', '--filter', 'label=docknest.restore-test')), []);
  await sudo('test', '!', '-e', `/var/lib/docknest/restore-tests/${test}`);
  await sudo('test', '!', '-e', `/var/lib/docker-backup-manager/rootless-restore/${uid}/${test}`);
  record('A restore test runs in the rootless engine with memory and CPU limits, passes, and removes the copy, its journal and its data folder');
}

async function noDelegation(api, siteId, server, cli) {
  const before = lines(await cli('ps', '-aq'));
  const test = api.rt.createRestoreTest({ siteId, serverId: server.id, liveServer: true, actor: 'qa' }).id;
  const done = await driveTest(api, test);
  assert.equal(done.result, 'couldnt_run', 'the test is refused, not run unlimited: ' + JSON.stringify([done.result, done.reason]));
  assert.match(done.reason ?? '', /cannot limit memory for user apps, so DockNest will not test there/);
  assert.deepEqual(lines(await cli('ps', '-aq')), before, 'nothing was created in the user engine');
  const { remote } = await import('../src/ssh.js');
  assert.equal((await remote(server, { operation: 'restore-test-status', testId: test })).present, false);
  record('Without memory and CPU delegation the restore test says it cannot limit memory for user apps, does not run, and leaves nothing behind');
}

async function webdav() {
  ({ db } = await import('../src/db.js'));
  const rcloneBin = process.env.DOCKNEST_RCLONE_BIN;
  assert.ok(rcloneBin, 'DOCKNEST_RCLONE_BIN names the pinned rclone');
  const { config } = await import('../src/config.js');
  assert.equal(config.rcloneBin, rcloneBin);
  const user = 'qa' + randomBytes(4).toString('hex'), password = randomBytes(18).toString('hex');
  const served = join(directory, 'dav');
  await mkdir(served, { recursive: true });
  const port = 18000 + Math.floor(Math.random() * 1000);
  const dav = spawn(rcloneBin, ['serve', 'webdav', served, '--addr', `127.0.0.1:${port}`, '--user', user, '--pass', password], { stdio: 'ignore' });
  process.on('exit', () => dav.kill());
  await until(async () => (await fetch(`http://127.0.0.1:${port}/`, { headers: { authorization: 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64') } })).status < 500, 'The WebDAV server did not start', 30);
  const obscured = await sh(rcloneBin, ['obscure', password]);
  const { seal } = await import('../src/crypto.js');
  const at = new Date().toISOString(), targetId = randomUUID();
  db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(targetId, 'Live WebDAV', 'rclone.invalid', 1, '', 'not-sftp', 'rclone', seal(JSON.stringify({ username: user, passwordObscured: obscured })), '/docknest', 0, 'connected', at, at);
  db.prepare("INSERT INTO storage_target_settings VALUES(?,'rclone',?)").run(targetId, JSON.stringify({ backend: 'webdav', endpoint: `http://127.0.0.1:${port}`, vendor: 'other', account: user }));
  db.prepare("INSERT INTO settings VALUES('backup_storage_target',?)").run(targetId);
  const rclone = await import('../src/storage/rclone.js');
  const probe = await rclone.test({ id: targetId, mode: 'rclone', name: 'Live WebDAV', backend: 'webdav', root: '/docknest', capacity: 0, persist: false, settings: { endpoint: `http://127.0.0.1:${port}`, vendor: 'other' }, secrets: { username: user, passwordObscured: obscured } });
  assert.equal(probe.connected && probe.writeVerified && probe.copyVerified && probe.readVerified && probe.rangeVerified && probe.deleteVerified, true, JSON.stringify(probe));
  evidence.probe = probe;
  record('The pinned rclone serves WebDAV on the runner and DockNest rclone adapter probe runs against it');

  await sudo('systemctl', 'start', 'docker');
  const folder = await stageFixture();
  await sh('docker', ['build', '-t', 'dn-live-app:local', folder]);
  await sh('docker', ['run', '-d', '--name', 'live-app', '-v', 'live-data:/site', 'dn-live-app:local']);
  await until(async () => (await sh('docker', ['inspect', '--format', '{{.State.Running}}', 'live-app'])) === 'true', 'The fake app did not start');
  await sh('docker', ['exec', 'live-app', 'sh', '-c', `echo ${MARKER} > /site/marker.txt`]);
  const { server } = await connectRunner();
  const api = await engineApi();
  const siteId = addSite(server, 'live-app', siteConfig(['live-app']));
  const backup = await backupOf(api, siteId);
  const stored = async folderPath => (await readdir(folderPath, { recursive: true, withFileTypes: true }).catch(() => [])).filter(entry => entry.isFile());
  const files = await stored(served);
  assert.ok(files.length > 0, 'the backup package is stored on the WebDAV server');
  evidence.webdavFiles = files.length;
  record(`A DockNest backup is written through the rclone adapter to WebDAV (${files.length} files on the server)`);
  const result = await restoreOf(api, backup, server);
  assert.equal(await sh('docker', ['exec', result.containerId, 'cat', '/site/marker.txt']), MARKER, 'the data restored from WebDAV is the data of the backup');
  record('A restore reads the backup back through the rclone adapter from WebDAV and the data matches');
  const wrong = await rclone.test({ id: targetId, mode: 'rclone', name: 'Live WebDAV', backend: 'webdav', root: '/docknest', capacity: 0, persist: false, settings: { endpoint: `http://127.0.0.1:${port}`, vendor: 'other' }, secrets: { username: user, passwordObscured: await sh(rcloneBin, ['obscure', 'wrong-' + password]) } }).then(result => (result?.connected === false ? { refused: true } : null), error => error);
  assert.ok(wrong, 'a wrong password is refused');
  record('A wrong WebDAV password is refused with an error');
  await sh('docker', ['rm', '-f', result.containerId]).catch(() => {});
}

try {
  if (scenario === 'webdav') await webdav();
  else if (scenario === 'rootless-docker') await rootlessEngine('docker');
  else await rootlessEngine('podman');
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed'; evidence.error = String(error.stack || error.message).slice(0, 4000);
  console.error(error);
  process.exitCode = 1;
} finally {
  await mkdir('data/qa', { recursive: true });
  await writeFile(`data/qa/env-live-${scenario}.json`, JSON.stringify(evidence, null, 1));
  console.log(`${scenario}: ${evidence.status}, ${evidence.checks.length} checks`);
  process.exit(process.exitCode ?? 0);
}
