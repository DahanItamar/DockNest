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
if (!['rootless-docker', 'rootless-docker-apt', 'rootless-podman', 'webdav', 'no-delegation', 'podman-extras', 'podman-only', 'smb'].includes(scenario)) throw new Error('LIVE_SCENARIO is not one of the known live checks');
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
  APP_ORIGIN: 'http://127.0.0.1:3000', NODE_ENV: 'test', SECURE_COOKIES: 'false', BACKUP_STORAGE: ['webdav', 'smb'].includes(scenario) ? 'unconfigured' : 'local'
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
async function createUser({ delegated, name = USER, first = true }) {
  // dbus-user-session starts the per-user bus with the user's systemd instance; uidmap provides newuidmap and newgidmap.
  // Ubuntu 24.04 and later restrict unprivileged user namespaces with AppArmor; a rootless engine needs them. Disposable runner only.
  if (first) {
    await sudo('sysctl', '-w', 'kernel.apparmor_restrict_unprivileged_userns=0').catch(() => '');
    await sudo('apt-get', 'update');
    await sudo('apt-get', 'install', '-y', '--no-install-recommends', 'dbus-user-session', 'uidmap');
  }
  await sudo('useradd', '-m', '-s', '/bin/bash', name);
  const uid = Number(await sh('id', ['-u', name]));
  // memory and cpu delegated to the user's systemd instance, or deliberately not (the no-delegation scenario).
  const folder = '/etc/systemd/system/user@.service.d';
  if (first) {
    await sudo('mkdir', '-p', folder);
    await sudo('sh', '-c', `printf '[Service]\\nDelegate=\nDelegate=${delegated ? 'cpu cpuset io memory pids' : 'pids'}\\n' > ${folder}/zz-docknest-live.conf`);
    await sudo('systemctl', 'daemon-reload');
  }
  await sudo('loginctl', 'enable-linger', name);
  await sudo('systemctl', 'restart', `user@${uid}.service`);
  // The user's own D-Bus socket comes from dbus.socket of the user's systemd instance; start it explicitly and keep what the
  // system says if it does not appear (a failed run must say why).
  // env -i: the runner's own XDG_RUNTIME_DIR must not become the environment of this user's session manager (it broke the user's dbus and docker units).
  await sudo('env', '-i', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'systemctl', '--user', '--machine', name + '@', 'start', 'dbus.socket').catch(() => '');
  await until(async () => (await sh('sudo', ['test', '-S', `/run/user/${uid}/bus`]).then(() => true, () => false)), 'The user session bus did not start: ' + await diagnostics(uid), 60).catch(async error => { throw new Error(String(error.message).replace(/did not start: .*/s, 'did not start: ') + await diagnostics(uid)); });
  const controllers = await sudo('cat', `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`).catch(() => '');
  evidence.delegation = controllers.split(/\s+/).filter(Boolean);
  const has = ['memory', 'cpu'].every(name => evidence.delegation.includes(name));
  assert.equal(has, delegated, `delegation is ${delegated ? '' : 'not '}in place: ${controllers}`);
  return uid;
}
// A clean environment, like the one DockNest gives the engine: the runner's XDG_*, HOME and working folder must not leak into the user's tools.
const asUser = (uid, command, args, extraEnv = {}, name = USER) => sudo('-u', name, '-H', 'env', '-i', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', `HOME=/home/${name}`, `XDG_RUNTIME_DIR=/run/user/${uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`, ...Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`), 'sh', '-c', 'cd "$HOME" && exec "$0" "$@"', command, ...args);

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
    await sudo('apt-get', 'install', '-y', '--no-install-recommends', 'slirp4netns', 'curl', 'iptables', 'xz-utils', 'ca-certificates');
    if (scenario === 'rootless-docker-apt') {
      // The packages from download.docker.com: its apt repository for this release if it has one, else the newest Ubuntu LTS it carries.
      await sudo('install', '-m', '0755', '-d', '/etc/apt/keyrings');
      await sh('sh', ['-c', 'curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/docker-live.asc > /dev/null']);
      const own = (await sh('sh', ['-c', '. /etc/os-release && echo $VERSION_CODENAME'])).trim();
      for (const codename of [own, 'noble']) {
        await sh('sh', ['-c', `echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker-live.asc] https://download.docker.com/linux/ubuntu ${codename} stable" | sudo tee /etc/apt/sources.list.d/docker-live.list > /dev/null`]);
        await sudo('apt-get', 'update').catch(() => '');
        if (await sh('sh', ['-c', 'apt-cache policy docker-ce-rootless-extras | grep -q "Candidate: [0-9]"']).then(() => true, () => false)) { evidence.dockerRepositoryCodename = codename; break; }
      }
      await sudo('apt-get', 'install', '-y', '--no-install-recommends', 'docker-ce-rootless-extras');
      try { await asUser(uid, 'dockerd-rootless-setuptool.sh', ['install', '--skip-iptables']); }
      catch (error) { await dockerFailureEvidence(uid); throw error; }
    } else {
      // The runner's Docker comes without the rootless extras, so the user gets Docker's own rootless bundle (docs.docker.com, get.docker.com/rootless).
      // Not pinned: this is a manual live check on a disposable runner, and the engine version it installs is recorded in the evidence.
      try { await asUser(uid, 'sh', ['-c', 'curl -fsSL https://get.docker.com/rootless -o /tmp/dn-rootless-install.sh && FORCE_ROOTLESS_INSTALL=1 sh /tmp/dn-rootless-install.sh']); }
      catch (error) { await dockerFailureEvidence(uid); throw error; }
    }
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
  assert.deepEqual(container?.runtime, runtime, 'the container carries its runtime: ' + JSON.stringify(discovered.containers.map(item => [item.name, item.runtime])));
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

// ==== The remaining Podman and rootless items of docs/live-checks-3.0.0.md =============================================================
const BASE = '/var/lib/docker-backup-manager/rootless-restore';
async function installPodman() {
  await sudo('apt-get', 'install', '-y', '--no-install-recommends', 'podman', 'uidmap', 'slirp4netns', 'passt', 'crun');
}
async function refreshEngines(server) {
  const { testServer } = await import('../src/engine.js');
  const capabilities = await testServer(server);
  db.prepare('UPDATE servers SET capabilities=?,status=? WHERE id=?').run(JSON.stringify(capabilities), 'connected', server.id);
  return capabilities;
}
async function failedJob(api, queued) {
  const job = api.claimJob();
  assert.equal(job.id, queued.id); await api.executeJob(job);
  return db.prepare('SELECT status,error FROM jobs WHERE id=?').get(job.id);
}
async function backupFails(api, siteId) {
  const queued = api.enqueueBackup(siteId, 'qa');
  return failedJob(api, queued);
}
const subuidOf = async name => (await sudo('grep', `^${name}:`, '/etc/subuid')).split(':').slice(1).map(Number);

// One failing check does not hide the others: every step is recorded, and the run fails at the end if any step failed.
const failures = [];
async function step(name, work) {
  try { await work(); } catch (error) { failures.push({ name, error: String(error.stack || error.message).slice(0, 1500) }); evidence.failures = failures; console.error('FAIL ' + name + ': ' + String(error.message).slice(0, 600)); }
}

// What the helper does not print: its own traceback for a request, run on the runner as root (diagnostics only).
async function helperTraceback(request) {
  const { writeHelperBundle } = await import('../src/helper-bundle.js');
  const file = writeHelperBundle(join(directory, 'diag-helper'));
  const script = join(directory, 'diag-helper.py');
  await writeFile(script, ['import sys, traceback, json', "g = {'__name__': 'diag'}", `exec(compile(open(${JSON.stringify(file)}).read(), 'helper.py', 'exec'), g)`,
    'try:', `    g['main'](json.loads(${JSON.stringify(JSON.stringify(request))}))`, "    print('no error')", 'except BaseException:', '    traceback.print_exc()', ''].join(String.fromCharCode(10)));
  return sh('sh', ['-c', `sudo python3 ${script} 2>&1 | tail -40`]).catch(error => String(error.message).slice(0, 1500));
}

// Why a rootless Docker would not start: the user's journal as root sees it, and the daemon run in the foreground for a few seconds.
async function dockerFailureEvidence(uid) {
  evidence.dockerJournal = await sudo('journalctl', '--no-pager', '-n', '60', `_UID=${uid}`).catch(e => String(e.message).slice(0, 800));
  evidence.dockerForeground = await sh('sh', ['-c', `sudo -u ${USER} -H env -i PATH=/home/${USER}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/home/${USER} XDG_RUNTIME_DIR=/run/user/${uid} sh -c 'cd "$HOME" && timeout 15 dockerd-rootless.sh 2>&1 | tail -30' || true`]).catch(e => String(e.message).slice(0, 800));
  console.error('docker journal: ' + String(evidence.dockerJournal).slice(-2500));
  console.error('docker in the foreground: ' + String(evidence.dockerForeground).slice(-2500));
}
async function podmanExtras() {
  const uid = await createUser({ delegated: true });
  await installPodman();
  const cli = (...args) => asUser(uid, 'podman', args);
  await cli('info');
  const runtime = { engine: 'podman', rootless: true, user: USER, uid };
  const folder = await stageFixture();
  await cli('build', '--format', 'docker', '-t', 'dn-live-app:local', folder);
  await cli('run', '-d', '--name', 'live-app', '-v', 'live-data:/site', 'dn-live-app:local');
  await until(async () => (await cli('inspect', '--format', '{{.State.Running}}', 'live-app')) === 'true', 'The fake app did not start');
  await cli('exec', 'live-app', 'sh', '-c', `echo ${MARKER} > /site/marker.txt`);
  const USER2 = 'dnlive2';
  const uid2 = await createUser({ delegated: true, name: USER2, first: false });
  const cli2 = (...args) => asUser(uid2, 'podman', args, {}, USER2);
  await cli2('info');
  const runtime2 = { engine: 'podman', rootless: true, user: USER2, uid: uid2 };
  const [startA, countA] = await subuidOf(USER), [startB, countB] = await subuidOf(USER2);
  assert.ok(startA + countA <= startB || startB + countB <= startA, 'the two users have different subordinate ID ranges');
  record(`Two rootless Podman users with different subordinate ID ranges (${startA}+${countA} and ${startB}+${countB})`);

  ({ db } = await import('../src/db.js'));
  const { server } = await connectRunner();
  const engines = (await refreshEngines(server)).engines ?? [];
  assert.ok(engines.some(engine => engine.user === USER && engine.rootless) && engines.some(engine => engine.user === USER2 && engine.rootless), 'both rootless engines are reported: ' + JSON.stringify(engines));
  const api = await engineApi();
  const siteId = addSite(server, 'live-app', siteConfig(['live-app'], { runtime }));
  const backup = await backupOf(api, siteId);
  assert.equal(JSON.parse(backup.manifest).formatVersion, 3);

  await step('Restore into a second user', async () => {
    // Restore into a second user with a different subordinate ID range: every owner is translated.
    const plan = await api.planRestore(backup.id, { serverId: server.id, runtime: runtime2 });
    assert.equal(plan.executable, true, JSON.stringify(plan.blockers));
    assert.deepEqual(plan.runtime, runtime2);
    const queued = await api.enqueueRestore(backup.id, plan, 'qa'), job = api.claimJob();
    assert.equal(job.id, queued.id); await api.executeJob(job);
    const done = db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
    assert.equal(done.status, 'completed', done.error);
    const result = JSON.parse(done.details).result;
    assert.deepEqual(result.runtime, runtime2);
    const owner = await sudo('find', result.dataRoot, '-name', 'marker.txt', '-printf', '%U');
    assert.equal(Number(owner), uid2, 'the file the first user owned is now owned by the second user: ' + owner);
    const copy = lines(await cli2('ps', '-aq', '--filter', 'label=docker-backup-manager.restore'));
    assert.equal(copy.length, 1);
    assert.equal(await cli2('exec', copy[0], 'cat', '/site/marker.txt'), MARKER);
    const { remote } = await import('../src/ssh.js');
    const cleaned = await remote(server, { operation: 'runtime-restore-cleanup', job: await cli2('inspect', '--format', '{{index .Config.Labels "docker-backup-manager.restore"}}', copy[0]), runtime: runtime2 });
    assert.equal(cleaned.dataRoot, true);
    record('A restore into a second user (different subordinate ID range) translates the owners, runs the copy there, and cleans up');
  });

  await step('Unmappable owner refuses the restore', async () => {
    // A file owned by an ID the new user cannot map refuses the whole restore, and a failed restore leaves nothing.
    const mount = await cli('volume', 'inspect', 'live-data', '--format', '{{.Mountpoint}}');
    await sudo('sh', '-c', `echo planted > ${mount}/rootfile && chown 0:0 ${mount}/rootfile`);
    const second = await backupOf(api, siteId);
    const refused = await failedJob(api, await api.enqueueRestore(second.id, await api.planRestore(second.id, { serverId: server.id, runtime: runtime2 }), 'qa'));
    assert.equal(refused.status, 'failed', 'the restore is refused');
    assert.match(refused.error ?? '', /cannot map|ID the new user/i, refused.error);
    evidence.unmappableMessage = refused.error;
    assert.deepEqual(lines(await cli2('ps', '-aq', '--filter', 'label=docker-backup-manager.restore')), []);
    assert.equal((await sudo('sh', '-c', `ls ${BASE}/${uid2} 2>/dev/null | wc -l`)).trim(), '0', 'no data folder left by the failed restore');
    await sudo('rm', '-f', `${mount}/rootfile`);
    record('A file owned by an ID the new user cannot map refuses the whole restore with a plain message, and the failed restore leaves no container and no data folder');
  });

  await step('Server cleanup lists leftovers', async () => {
    // Server cleanup lists a leftover rootless restore folder and removes it.
    // Restore staging folders left by the earlier restores make the scan wait ("a restore ... was interrupted"); an operator removes them first.
    await sh('sh', ['-c', 'sudo rm -rf /var/lib/docker-backup-manager/restore/*']);
    const leftover = randomUUID();
    await sudo('mkdir', '-p', `${BASE}/${uid}/${leftover}`);
    await sudo('chmod', '711', `${BASE}/${uid}/${leftover}`);
    await sudo('touch', '-d', '3 hours ago', `${BASE}/${uid}/${leftover}`);
    const { scanServer, cleanServer } = await import('../src/server-cleanup.js');
    const scan = await scanServer(server.id, 'qa');
    const item = scan.items.find(entry => entry.kind === 'runtimeData' && entry.id.endsWith('/' + leftover));
    assert.ok(item, 'Server cleanup lists the leftover folder: ' + JSON.stringify(scan.items.map(entry => entry.kind + ' ' + entry.id)));
    const cleanResult = await cleanServer(server.id, { token: scan.token, items: [{ kind: item.kind, id: item.id }] }, 'qa');
    assert.equal(cleanResult.removed, 1, JSON.stringify(cleanResult));
    await sudo('test', '!', '-e', `${BASE}/${uid}/${leftover}`);
    record('Server cleanup lists the leftover rootless restore folder and removes it');
  });

  await step('Refusals: quadlet, native database, split Compose', async () => {
    // Refusals: a container managed by a systemd unit (quadlet), a native database engine, an app split over two engines.
    await cli('run', '-d', '--name', 'quad-app', '--label', 'PODMAN_SYSTEMD_UNIT=quad.service', 'dn-live-app:local');
    const quadSite = addSite(server, 'quad-app', siteConfig(['quad-app'], { runtime }));
    const quad = await backupFails(api, quadSite);
    assert.equal(quad.status, 'failed');
    if (!/systemd unit|quadlet/i.test(quad.error ?? '')) { evidence.quadletTraceback = await helperTraceback({ operation: 'plan', config: JSON.parse(db.prepare('SELECT config FROM sites WHERE id=?').get(quadSite).config) }); console.error('plan traceback (quadlet): ' + String(evidence.quadletTraceback).slice(-2000)); }
    assert.match(quad.error ?? '', /systemd unit|quadlet/i, quad.error);
    evidence.quadletMessage = quad.error;
    await cli('pull', 'docker.io/library/postgres:16-alpine');
    await cli('run', '-d', '--name', 'pg-app', '-e', 'POSTGRES_PASSWORD=' + randomBytes(6).toString('hex'), 'docker.io/library/postgres:16-alpine');
    await until(async () => (await cli('inspect', '--format', '{{.State.Running}}', 'pg-app')) === 'true', 'The database container did not start');
    const pgSite = addSite(server, 'pg-app', siteConfig(['pg-app'], { runtime }));
    const pg = await backupFails(api, pgSite);
    assert.equal(pg.status, 'failed'); evidence.nativeDatabaseMessage = pg.error;
    if (!/database|rootful Docker/i.test(pg.error ?? '')) { evidence.pgTraceback = await helperTraceback({ operation: 'plan', config: JSON.parse(db.prepare('SELECT config FROM sites WHERE id=?').get(pgSite).config) }); console.error('plan traceback (database): ' + String(evidence.pgTraceback).slice(-2000)); }
    assert.match(pg.error ?? '', /database|rootful Docker/i, pg.error);
    await cli('run', '-d', '--name', 'shop-web', '--label', 'com.docker.compose.project=shop', 'dn-live-app:local');
    await cli2('build', '--format', 'docker', '-t', 'dn-live-app:local', folder);
    await cli2('run', '-d', '--name', 'shop-db', '--label', 'com.docker.compose.project=shop', 'dn-live-app:local');
    await refreshEngines(server);
    const { appRuntime } = await import('../src/runtime.js');
    const discovered = await api.discover(db.prepare('SELECT * FROM servers WHERE id=?').get(server.id)).catch(async error => { evidence.discoverTraceback = await helperTraceback({ operation: 'discover' }); console.error('helper traceback: ' + String(evidence.discoverTraceback).slice(-2500)); throw error; });
    const found = discovered.containers.filter(container => container.labels?.['com.docker.compose.project'] === 'shop');
    assert.equal(found.length, 2, 'both halves of the Compose project are discovered: ' + JSON.stringify(found.map(container => [container.name, container.runtime])));
    assert.match(appRuntime(found).error ?? '', /two engines\. Make two apps/);
    record(`Refusals with plain messages: a systemd-managed container ("${quad.error?.slice(0, 80)}"), a native database engine ("${pg.error?.slice(0, 80)}") and a Compose project split over two engines`);
  });

  await step('Older release refuses format 3', () => formatThreeRefused(server, runtime, siteId));
  await step('Move preflight', () => movePreflight(api, server, cli, runtime));
  if (failures.length) throw new Error(`${failures.length} step(s) failed: ${failures.map(item => item.name).join('; ')}`);
}

// Releases before 3.0.0 refuse a format 3 package: the newest 2.16 helper is built from its tag and given a real one.
async function formatThreeRefused(server, runtime, siteId) {
  const tag = (await sh('git', ['tag', '--list', 'v2.16.*', '--sort=-v:refname'])).split('\n').filter(Boolean)[0];
  assert.ok(tag, 'a v2.16 release tag exists (the checkout must fetch tags)');
  const old = '/tmp/dn-old-release';
  await rm(old, { recursive: true, force: true });
  await mkdir(old, { recursive: true });
  await sh('sh', ['-c', `git archive ${tag} remote src/helper-bundle.js | tar -x -C ${old}`]);
  const built = await sh('node', ['--input-type=module', '-e', `const m = await import('${old}/src/helper-bundle.js'); console.log(m.writeHelperBundle('${old}/out'));`]);
  const { remote } = await import('../src/ssh.js');
  const job = randomUUID(), restoreJob = randomUUID();
  const site = db.prepare('SELECT * FROM sites WHERE id=?').get(siteId);
  const captured = await remote(server, { operation: 'capture', job, config: { ...JSON.parse(site.config) } });
  assert.equal(captured.manifest.formatVersion, 3);
  const folderOnServer = `/var/lib/docker-backup-manager/restore/${restoreJob}`;
  await sudo('mkdir', '-p', folderOnServer);
  await sudo('cp', captured.remotePath, `${folderOnServer}/payload.tar.gz`);
  const checksum = (await sudo('sha256sum', `${folderOnServer}/payload.tar.gz`)).split(' ')[0];
  const request = join(directory, 'old-restore.json');
  await writeFile(request, JSON.stringify({ operation: 'restore', job: restoreJob, plaintextChecksum: checksum }));
  const output = await sh('sh', ['-c', `sudo python3 ${built.trim()} < ${request} 2>&1 || true`]);
  assert.match(output, /Unsupported or incomplete backup/, `release ${tag} refuses the package: ${output.slice(-400)}`);
  await sudo('rm', '-rf', folderOnServer, captured.root).catch(() => '');
  evidence.olderRelease = tag;
  record(`A format 3 backup of a Podman app is refused by the ${tag} helper ("Unsupported or incomplete backup")`);
}

// The move check judges ports below the system limit and a missing linger setting, and still blocks the move itself.
async function movePreflight(api, server, cli, runtime) {
  const { previewFacts } = await import('../src/moves/engine.js');
  // A preview to the same server reads no target facts, so the runner is registered a second time as the target.
  const { randomUUID: uuid } = await import('node:crypto');
  const row = db.prepare('SELECT * FROM servers WHERE id=?').get(server.id);
  const target = { ...row, id: uuid(), name: 'runner-target' };
  db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,capabilities,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(target.id, target.name, target.host, target.port, target.username, target.private_key, target.host_key, row.capabilities, 'connected', new Date().toISOString());
  await refreshEngines(target);
  await sudo('sysctl', '-w', 'net.ipv4.ip_unprivileged_port_start=0');
  await cli('run', '-d', '--name', 'live-ports', '-p', '127.0.0.1:8081:8080', 'dn-live-app:local');
  await until(async () => (await cli('inspect', '--format', '{{.State.Running}}', 'live-ports')) === 'true', 'The published-port container did not start');
  // The container stops before the limit is raised: its published port is still in its record, and a running rootless port forwarder would lose its port.
  await cli('stop', '--time', '2', 'live-ports');
  await until(async () => (await cli('inspect', '--format', '{{.State.Status}}', 'live-ports')) === 'exited', 'The published-port container did not stop', 30);
  await sudo('sysctl', '-w', 'net.ipv4.ip_unprivileged_port_start=10000');
  // The user's runtime folder must stay for the preview: linger on and the user manager running.
  await sudo('loginctl', 'enable-linger', USER);
  await sudo('systemctl', 'start', `user@${runtime.uid}.service`);
  const siteId = addSite(server, 'live-ports', siteConfig(['live-ports'], { runtime }));
  evidence.moveStepState = { bus: await sudo('stat', '-c', '%F %U', `/run/user/${runtime.uid}/bus`).catch(e => String(e.message).slice(0, 200)), containers: await cli('ps', '-a', '--format', '{{.Names}} {{.Status}}').catch(e => String(e.message).slice(0, 200)) };
  console.error('move step state: ' + JSON.stringify(evidence.moveStepState));
  // The command the move preview ran, by hand: as the helper does (root, runuser, a clean environment, from /), with its error text.
  const byHand = await sh('sh', ['-c', `cd / && sudo runuser -u ${USER} -- env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin XDG_RUNTIME_DIR=/run/user/${runtime.uid} HOME=/home/${USER} podman inspect live-ports 2>&1 | head -c 600; echo; echo exit=$?`]).catch(e => String(e.message).slice(0, 600));
  console.error('podman inspect by hand: ' + byHand);
  // One preview, no retry: a failure here is a finding. The failing command is run again by hand right away, with its error text, as the helper hides it.
  const checks = async () => {
    try { return (await previewFacts(siteId, target.id, { dnsMode: 'manual' })).result.details.checks; }
    catch (error) {
      evidence.failedInspectByHand = await sh('sh', ['-c', `cd / && sudo runuser -u ${USER} -- env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin XDG_RUNTIME_DIR=/run/user/${runtime.uid} HOME=/home/${USER} podman inspect live-ports 2>&1 | head -c 800; echo; echo inspect-exit=$?; echo ps:; sudo runuser -u ${USER} -- env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin XDG_RUNTIME_DIR=/run/user/${runtime.uid} HOME=/home/${USER} podman ps -a --format '{{.Names}} {{.Status}}' 2>&1; echo ps-exit=$?; ls -ld /run/user/${runtime.uid} 2>&1; ls -l /var/lib/systemd/linger 2>&1; journalctl -n 40 --no-pager -u systemd-logind 2>&1 | cut -c1-220; journalctl --no-pager --since '-3min' 2>&1 | grep -iE 'stopping user|user@${runtime.uid}|Removed session|linger|dnlive' | cut -c1-220 | tail -20; systemctl is-active user@${runtime.uid}.service 2>&1;  sysctl net.ipv4.ip_unprivileged_port_start 2>&1`]).catch(e => String(e.message).slice(-1500));
      console.error('failed inspect, by hand: ' + evidence.failedInspectByHand);
      throw error;
    }
  };
  let found = await checks();
  const ports = found.find(check => check.id === 'runtime-ports'), blocked = found.find(check => check.id === 'runtime-move');
  assert.equal(ports?.status, 'block', 'the low port is blocked: ' + JSON.stringify(found.map(check => [check.id, check.status])));
  assert.match(ports.text, /8081/);
  assert.equal(blocked?.status, 'block'); assert.match(blocked.text, /not available yet/);
  evidence.movePorts = ports.text;
  // With linger off systemd stops the user's manager and removes its runtime folder as soon as no session is left, which is correct: the engine
  // goes away with it. A login session is held open here so the folder stays while the preview reads the linger setting.
  const session = spawn('sudo', ['runuser', '-l', USER, '-c', 'sleep 300'], { stdio: 'ignore' });
  try {
    await until(async () => (await sudo('loginctl', 'list-sessions', '--no-legend')).includes(USER), 'No login session for the rootless user', 30);
    await sudo('loginctl', 'disable-linger', USER);
    found = await checks();
  } finally { session.kill(); }
  const linger = found.find(check => check.id === 'runtime-linger');
  assert.equal(linger?.status, 'warn', 'linger off is flagged: ' + JSON.stringify(found.map(check => [check.id, check.status])));
  await sudo('loginctl', 'enable-linger', USER);
  await sudo('sysctl', '-w', 'net.ipv4.ip_unprivileged_port_start=1024');
  record('The move preflight blocks a port below the system limit, warns when linger is off, and blocks the move itself with the plain message');
}

// Podman and no Docker daemon: the server still connects, shows its engines, and a Podman app is backed up and restored.
async function podmanOnly() {
  await sudo('apt-get', 'update');
  await installPodman();
  await sudo('systemctl', 'stop', 'docker.socket', 'docker', 'containerd').catch(() => '');
  await sudo('systemctl', 'mask', 'docker.socket', 'docker').catch(() => '');
  const folder = await stageFixture();
  await sudo('podman', 'build', '--format', 'docker', '-t', 'dn-live-app:local', folder);
  await sudo('podman', 'run', '-d', '--name', 'live-app', '-v', 'live-data:/site', 'dn-live-app:local');
  await sudo('podman', 'exec', 'live-app', 'sh', '-c', `echo ${MARKER} > /site/marker.txt`);
  ({ db } = await import('../src/db.js'));
  const { server, capabilities } = await connectRunner();
  assert.equal(capabilities.docker, null, 'no Docker daemon is reported: ' + JSON.stringify(capabilities.docker));
  assert.ok((capabilities.engines ?? []).some(engine => engine.engine === 'podman' && !engine.rootless), 'rootful Podman is listed: ' + JSON.stringify(capabilities.engines));
  record('A server with Podman and no Docker daemon connects and lists rootful Podman (docker reported as none)');
  const runtime = { engine: 'podman', rootless: false };
  const api = await engineApi();
  const siteId = addSite(server, 'live-app', siteConfig(['live-app'], { runtime }));
  const backup = await backupOf(api, siteId);
  const manifest = JSON.parse(backup.manifest);
  assert.equal(manifest.formatVersion, 3); assert.deepEqual(manifest.runtime, runtime); assert.equal(manifest.idMap, undefined);
  const result = await restoreOf(api, backup, server);
  assert.equal(await sudo('podman', 'exec', result.containerId, 'cat', '/site/marker.txt'), MARKER);
  record('A rootful Podman app is backed up (format 3, no ID map) and restored with matching data on a server without Docker');
}

// SMB through the pinned rclone: a Samba container on localhost, DockNest's rclone adapter probe, then a backup and a restore through it.
async function smb() {
  ({ db } = await import('../src/db.js'));
  const rcloneBin = process.env.DOCKNEST_RCLONE_BIN;
  assert.ok(rcloneBin, 'DOCKNEST_RCLONE_BIN names the pinned rclone');
  const user = 'qa' + randomBytes(3).toString('hex'), password = randomBytes(12).toString('hex'), port = 1445;
  await sudo('systemctl', 'start', 'docker');
  const image = process.env.SMB_SERVER_IMAGE || 'dperson/samba';
  await sh('docker', ['run', '-d', '--name', 'dn-smb', '-p', `127.0.0.1:${port}:445`, image, '-u', `${user};${password}`, '-s', `share;/share;yes;no;no;${user}`, '-p']);
  const reachable = async () => { const net = await import('node:net'); return new Promise(done => { const socket = net.connect(port, '127.0.0.1', () => { socket.destroy(); done(true); }); socket.on('error', () => done(false)); }); };
  await until(reachable, 'The Samba server did not start', 60);
  await wait(3000);
  const obscured = await sh(rcloneBin, ['obscure', password]);
  const { seal } = await import('../src/crypto.js');
  const at = new Date().toISOString(), targetId = randomUUID();
  const settings = { host: '127.0.0.1', port, share: 'share' }, secrets = { username: user, passwordObscured: obscured };
  db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(targetId, 'Live SMB', 'rclone.invalid', 1, '', 'not-sftp', 'rclone', seal(JSON.stringify(secrets)), '/docknest', 0, 'connected', at, at);
  db.prepare("INSERT INTO storage_target_settings VALUES(?,'rclone',?)").run(targetId, JSON.stringify({ backend: 'smb', ...settings, account: user }));
  db.prepare("INSERT INTO settings VALUES('backup_storage_target',?)").run(targetId);
  const rclone = await import('../src/storage/rclone.js');
  const options = overrides => ({ id: targetId, mode: 'rclone', name: 'Live SMB', backend: 'smb', root: '/docknest', capacity: 0, persist: false, settings, secrets, ...overrides });
  const probe = await rclone.test(options());
  assert.equal(probe.connected && probe.writeVerified && probe.copyVerified && probe.readVerified && probe.rangeVerified && probe.deleteVerified, true, JSON.stringify(probe));
  record('The rclone adapter probe (write, rename, read, range, delete) passes against a Samba share');

  const folder = await stageFixture();
  await sh('docker', ['build', '-t', 'dn-live-app:local', folder]);
  await sh('docker', ['run', '-d', '--name', 'live-app', '-v', 'live-data:/site', 'dn-live-app:local']);
  await until(async () => (await sh('docker', ['inspect', '--format', '{{.State.Running}}', 'live-app'])) === 'true', 'The fake app did not start');
  await sh('docker', ['exec', 'live-app', 'sh', '-c', `echo ${MARKER} > /site/marker.txt`]);
  const { server } = await connectRunner();
  const api = await engineApi();
  const siteId = addSite(server, 'live-app', siteConfig(['live-app']));
  const backup = await backupOf(api, siteId);
  const stored = lines(await sh('docker', ['exec', 'dn-smb', 'sh', '-c', 'find /share -type f | head -20']));
  assert.ok(stored.length > 0, 'the backup package is stored on the share');
  evidence.smbFiles = stored.length;
  record(`A DockNest backup is written through the rclone adapter to SMB (${stored.length} files on the share)`);
  const result = await restoreOf(api, backup, server);
  assert.equal(await sh('docker', ['exec', result.containerId, 'cat', '/site/marker.txt']), MARKER);
  record('A restore reads the backup back through the rclone adapter from SMB and the data matches');
  const wrong = await rclone.test(options({ secrets: { username: user, passwordObscured: await sh(rcloneBin, ['obscure', 'wrong-' + password]) } })).then(r => (r?.connected === false ? { refused: true } : null), error => error);
  assert.ok(wrong, 'a wrong password is refused');
  record('A wrong SMB password is refused with an error');
  await sh('docker', ['rm', '-f', result.containerId, 'dn-smb']).catch(() => {});
}

try {
  if (scenario === 'webdav') await webdav();
  else if (scenario === 'smb') await smb();
  else if (scenario === 'podman-extras') await podmanExtras();
  else if (scenario === 'podman-only') await podmanOnly();
  else if (['rootless-docker', 'rootless-docker-apt'].includes(scenario)) await rootlessEngine('docker');
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
