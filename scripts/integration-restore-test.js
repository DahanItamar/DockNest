// Automatic restore tests on real Linux Docker (docs/restore-tests.md, "Linux integration test plan"). Called by
// scripts/integration-linux.js with the source host (hosts[0], also the "live server") and the test server
// (hosts[1]). Each case runs the real engine (tick/claim/execute, or real worker processes) and the real helper over
// SSH, then proves the server is exactly as before: no labelled container or network, the same image IDs, tags and
// containers, no staging or journal path, no restore-test firewall rule, restore-test-status reports nothing left, and
// the reaper is gone. Not "validated" until this passes in CI on Linux.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

export async function runRestoreTestScenario({ run, until, hosts, servers, db, record, staticSiteId, evidence }) {
  const { enqueueBackup, claimJob, executeJob, planBackup } = await import('../src/engine.js');
  const { remote } = await import('../src/ssh.js');
  const { backupVerification } = await import('../src/recovery-evidence.js');
  const rt = await import('../src/restore-tests/engine.js');
  const [source, target] = hosts;
  // 15 s stability window and 2.5 s polls instead of 60 s and 10 s: the same property, less CI time.
  rt.testTiming.scale = 0.25; rt.testTiming.cancelPollMs = 200;
  const label = 'docknest.restore-test';
  const lines = text => text.split('\n').map(line => line.trim()).filter(Boolean);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const row = testId => rt.loadTest(testId);
  const finished = test => test.result !== null && ['done', 'failed', 'acknowledged'].includes(test.cleanup);
  const hostOf = server => (server === servers[0] ? source : target);

  async function snapshot(host) {
    const images = [...new Set(lines(await run('exec', host, 'docker', 'images', '-aq', '--no-trunc')))].sort();
    const tags = lines(await run('exec', host, 'docker', 'images', '--no-trunc', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}')).filter(line => !line.includes('<none>')).sort();
    const containers = lines(await run('exec', host, 'docker', 'ps', '-a', '--no-trunc', '--format', '{{.ID}} {{.Names}} {{.State}} {{.Ports}}')).sort();
    return { images, tags, containers };
  }
  async function hostRules(host) {
    const rules = [];
    for (const tool of ['iptables', 'ip6tables']) rules.push(...lines(await run('exec', host, 'sh', '-c', `${tool} -S 2>/dev/null || true`)).filter(line => line.includes('docknest-restore-test')));
    return rules;
  }
  async function backup(siteId) {
    const queued = enqueueBackup(siteId, 'qa'), job = claimJob();
    assert.equal(job.id, queued.id); await executeJob(job);
    const done = db.prepare('SELECT status,error FROM jobs WHERE id=?').get(job.id);
    assert.equal(done.status, 'completed', done.error);
    return db.prepare('SELECT * FROM backups WHERE job_id=?').get(job.id);
  }
  // The worker loop in this process: tick, claim one job, run it. `onHealth` runs once while the copy is up.
  async function drive(testId, { onHealth, stop = finished } = {}) {
    const deadline = Date.now() + 20 * 60 * 1000;
    let healthDone = false;
    while (Date.now() < deadline) {
      const test = row(testId);
      if (stop(test)) return test;
      if (onHealth && !healthDone && test.result === null && test.step === 'check_health') { healthDone = true; await onHealth(test); }
      rt.tickRestoreTests();
      const job = claimJob();
      if (job) await executeJob(job); else await wait(500);
    }
    throw new Error('The restore test did not finish in time: ' + JSON.stringify(rt.loadSteps(testId).map(step => [step.step, step.state, step.detail])));
  }
  async function verifyClean(testId, before, server = servers[1]) {
    const host = hostOf(server);
    assert.equal(await run('exec', host, 'docker', 'ps', '-aq', '--filter', 'label=' + label), '', 'no labelled container is left');
    assert.equal(await run('exec', host, 'docker', 'network', 'ls', '-q', '--filter', 'label=' + label), '', 'no labelled network is left');
    assert.deepEqual(await snapshot(host), before, 'image IDs, every tag and every container (state and ports) are as before');
    await run('exec', host, 'test', '!', '-e', '/var/lib/docker-backup-manager/restore/' + testId);
    await run('exec', host, 'test', '!', '-e', '/var/lib/docknest/restore-tests/' + testId);
    assert.deepEqual(await hostRules(host), [], 'no restore-test firewall rule on the host');
    assert.equal((await remote(server, { operation: 'restore-test-status', testId })).present, false);
    // [.] keeps this shell's own command line from matching the pattern it searches for.
    const reaperGone = `for p in /proc/[0-9]*; do [ "\${p#/proc/}" = "$$" ] && continue; grep -q 'restore-tests/${testId}/reaper[.]py' "$p/cmdline" 2>/dev/null && exit 1; done; exit 0`;
    await until(async () => { await run('exec', host, 'sh', '-c', reaperGone); return true; }, 'The reaper did not exit after clean-up', 60);
  }
  async function copies(testId, host = target) {
    const ids = lines(await run('exec', host, 'docker', 'ps', '-aq', '--filter', `label=${label}=${testId}`));
    return ids.length ? JSON.parse(await run('exec', host, 'docker', 'inspect', ...ids)) : [];
  }
  function assertLimits(container, testId, memory = 1024) {
    const host = container.HostConfig;
    assert.equal(host.Memory, memory * 1024 * 1024); assert.equal(host.MemorySwap, memory * 1024 * 1024);
    assert.equal(host.NanoCpus, 1e9); assert.equal(host.PidsLimit, 1024);
    assert.equal(host.RestartPolicy.Name, 'no'); assert.equal(host.Privileged, false);
    assert.deepEqual({ type: host.LogConfig.Type, size: host.LogConfig.Config['max-size'], files: host.LogConfig.Config['max-file'] }, { type: 'local', size: '10m', files: '3' });
    assert.ok(!Object.values(host.PortBindings || {}).some(list => list?.length), 'no published ports');
    assert.equal(container.Config.Labels['com.docker.compose.project'], 'docknest-test-' + testId.slice(0, 12));
  }
  const historyCount = backupId => db.prepare('SELECT COUNT(*) AS n FROM backup_verification_history WHERE backup_id=?').get(backupId).n;
  const testEvidence = testId => db.prepare("SELECT COUNT(*) AS n FROM backup_verification_history WHERE json_extract(evidence,'$.testId')=?").get(testId).n;

  // The test server's image store: Docker 29 starts fresh installs on the containerd image store.
  const containerdStore = /io\.containerd\.snapshotter/.test(await run('exec', target, 'docker', 'info', '--format', '{{.Driver}} {{json .DriverStatus}}'));
  const store = containerdStore ? 'containerd' : 'classic';
  if (evidence) evidence.restoreTestImageStore = store;

  // Fixtures on the source: a fresh image the test server has never seen, so its IDs are test-only there.
  await run('exec', source, 'docker', 'build', '-q', '-t', 'docknest-rt:local', '--label', 'docknest.qa=restore-test', '/fixture-site');
  const config = (containers, extra = {}) => ({ containers, stagingRoot: '/var/lib/docknest', exclusiveSourcesConfirmed: true, externalReferencesConfirmed: true, cleanShutdownConfirmed: true, shutdownProfile: 'generic', maintenanceRequired: false, maintenance: { required: false }, ...extra });
  const site = (name, cfg) => { const siteId = randomUUID(); db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, servers[0].id, name, JSON.stringify(cfg), new Date().toISOString()); return siteId; };
  const healthy = name => until(async () => (await run('exec', source, 'docker', 'inspect', '--format', '{{.State.Health.Status}}', name)) === 'healthy', name + ' is not healthy');

  // 1. Single container with a healthcheck.
  await run('exec', source, 'docker', 'run', '-d', '--name', 'rt-single', '-v', 'rt-single-data:/site', 'docknest-rt:local');
  await healthy('rt-single');
  const singleSite = site('rt-single', config(['rt-single'])), singleBackup = await backup(singleSite);
  let before = await snapshot(target);
  const single = rt.createRestoreTest({ siteId: singleSite, serverId: servers[1].id, actor: 'qa', probe: { service: 'rt-single', port: 8080, path: '/' } }).id;
  let seen = 0;
  const singleDone = await drive(single, { onHealth: async () => {
    const list = await copies(single); seen = list.length;
    assertLimits(list[0], single); assert.equal(list[0].HostConfig.NetworkMode, 'none');
    await run('exec', target, 'test', '-f', `/var/lib/docknest/restore-tests/${single}/reaper.py`);
  } });
  assert.equal(singleDone.result, 'passed', singleDone.reason ?? ''); assert.equal(seen, 1, 'the copy was inspected while it ran');
  assert.equal(singleDone.checks.find(check => check.kind === 'http')?.status, 'passed', 'the internal web check ran as nobody inside the copy: ' + JSON.stringify(singleDone.checks));
  assert.equal(backupVerification(singleBackup.id).isolatedRestore.method, 'automatic restore test');
  await verifyClean(single, before);
  record(`Restore test, single container: limits (memory, swap, CPU, pids, local logs), restart no, network none and no ports match; the internal web check runs as nobody; teardown leaves the test server exactly as before (${store} image store)`);

  // 2. Live-server opt-in next to the running site: live containers, tags and ports are unchanged afterwards.
  before = await snapshot(source);
  const live = rt.createRestoreTest({ siteId: singleSite, serverId: servers[0].id, liveServer: true, actor: 'qa' }).id;
  const liveDone = await drive(live, { onHealth: async () => {
    assert.equal(await run('exec', source, 'docker', 'inspect', '--format', '{{.State.Running}}', 'rt-single'), 'true', 'the live site keeps running next to its copy');
    const [copy] = await copies(live, source); assertLimits(copy, live); assert.notEqual(copy.Name, '/rt-single');
  } });
  assert.equal(liveDone.result, 'passed', liveDone.reason ?? '');
  await verifyClean(live, before, servers[0]);
  record('Restore test on the live server (opt-in): the live container keeps running and every container, tag, image and port on that server is unchanged afterwards');

  // 3. Grouped site: web + PostgreSQL with a row-count check and a web check. (A real Compose project needs its Compose
  // files selected; the Compose move case covers those. Copies always get their own docknest-test project label.)
  const password = randomBytes(18).toString('base64url');
  await run('exec', source, 'docker', 'pull', '-q', 'postgres:16');
  await run('exec', source, 'docker', 'network', 'create', 'rt-group');
  await run('exec', source, 'docker', 'run', '-d', '--name', 'rt-db', '--network', 'rt-group', '--network-alias', 'db', '--tmpfs', '/tmp:size=32m,mode=1777', '-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_DB=fixture', '-v', 'rt-db-data:/var/lib/postgresql/data', 'postgres:16');
  await run('exec', source, 'docker', 'run', '-d', '--name', 'rt-web', '--network', 'rt-group', '--network-alias', 'web', '-v', 'rt-web-data:/site', 'docknest-rt:local');
  const groupCfg = config(['rt-web', 'rt-db'], { stopTimeout: 90, temporaryMemoryFolders: [{ container: 'rt-db', destination: '/tmp' }], services: [{ container: 'rt-db', engine: 'postgres', database: 'fixture', dependsOn: [], checks: [{ name: 'Records', table: 'records' }] }] });
  const groupSite = site('rt-group', groupCfg);
  await until(async () => { try { return Boolean((await planBackup(groupSite)).services.find(service => service.engine === 'postgres')?.version); } catch { return false; } }, 'PostgreSQL fixture did not become ready', 180);
  await run('exec', source, 'docker', 'exec', '--user', 'postgres', 'rt-db', 'psql', '-X', '-w', '-h', '/var/run/postgresql', '-U', 'postgres', '-d', 'fixture', '-v', 'ON_ERROR_STOP=1', '-c', "CREATE TABLE records (id INTEGER PRIMARY KEY, value VARCHAR(80)); INSERT INTO records VALUES (1,'snapshot'),(2,'second');");
  const groupBackup = await backup(groupSite);
  const gateway = (await run('exec', target, 'sh', '-c', "ip -4 route show default | awk '{print $3}'")).trim() || '172.17.0.1';
  // Only "no route" or a timeout count as isolated; a refusal means the address answered.
  const isolation = [
    'import socket,sys,errno',
    'unreachable={errno.ENETUNREACH,errno.EHOSTUNREACH,errno.EADDRNOTAVAIL,errno.EAFNOSUPPORT}',
    `targets=[(${JSON.stringify(gateway)},22),('172.17.0.1',22),('169.254.169.254',80),('1.1.1.1',443),('8.8.8.8',53),('2606:4700:4700::1111',443)]`,
    'for host,port in targets:',
    ' try:',
    '  socket.create_connection((host,port),3).close();sys.exit("reached %s:%d"%(host,port))',
    ' except ConnectionRefusedError:sys.exit("%s:%d refused the connection, so it was reachable"%(host,port))',
    ' except TimeoutError:pass',
    ' except OSError as error:',
    '  if error.errno not in unreachable:sys.exit("%s:%d gave %s"%(host,port,error))',
    'try:',
    ' socket.getaddrinfo("example.com",443);sys.exit("public DNS answered")',
    'except OSError:pass',
    'print("isolated")',
  ].join('\n');
  before = await snapshot(target);
  const grouped = rt.createRestoreTest({ siteId: groupSite, serverId: servers[1].id, actor: 'qa', probe: { service: 'rt-web', port: 8080, path: '/' } }).id;
  const groupedDone = await drive(grouped, { onHealth: async () => {
    const list = await copies(grouped);
    assert.equal(list.length, 2);
    for (const container of list) assertLimits(container, grouped);
    for (const name of new Set(list.flatMap(container => Object.keys(container.NetworkSettings.Networks)))) {
      const network = JSON.parse(await run('exec', target, 'docker', 'network', 'inspect', name))[0];
      assert.equal(network.Internal, true); assert.equal(network.Options['com.docker.network.bridge.gateway_mode_ipv4'], 'isolated'); assert.equal(network.Labels[label], grouped);
    }
    const web = list.find(container => container.Name.endsWith('-0'));
    assert.equal(await run('exec', target, 'docker', 'exec', web.Id, 'python', '-c', isolation), 'isolated');
  } });
  assert.equal(groupedDone.result, 'passed', groupedDone.reason ?? '');
  assert.equal(groupedDone.checks.find(check => check.kind === 'database')?.status, 'passed', JSON.stringify(groupedDone.checks));
  assert.equal(groupedDone.checks.find(check => check.kind === 'http')?.status, 'passed', JSON.stringify(groupedDone.checks));
  assert.equal(backupVerification(groupBackup.id).application.status, 'passed');
  await verifyClean(grouped, before);
  record('Restore test, grouped web + PostgreSQL: fresh internal isolated networks, row-count and web checks pass; from inside a copy the host gateway, 169.254.169.254, public IPv4 and IPv6 are unreachable (no route or timeout, never a refusal) and public DNS does not answer');

  // 4. Cancel during copy_backup: the package is still streaming when the owner cancels.
  before = await snapshot(target);
  const cancelled = rt.createRestoreTest({ siteId: groupSite, serverId: servers[1].id, actor: 'qa' }).id;
  await drive(cancelled, { stop: test => test.step === 'copy_backup' });
  rt.tickRestoreTests();
  const copyJob = claimJob(); assert.equal(JSON.parse(copyJob.details).step, 'copy_backup');
  const copying = executeJob(copyJob);
  await until(async () => { await run('exec', target, 'test', '-s', `/var/lib/docker-backup-manager/restore/${cancelled}/payload.tar.gz`); return true; }, 'The copy did not start', 120);
  rt.cancelRestoreTest(cancelled, 'qa');
  await copying;
  const cancelledDone = await drive(cancelled);
  assert.equal(cancelledDone.result, 'cancelled'); assert.equal(cancelledDone.failed_step, 'copy_backup'); assert.equal(testEvidence(cancelled), 0);
  await verifyClean(cancelled, before);
  record('Restore test cancelled during Copy backup: the transfer stops, the result is cancelled with no backup evidence, and clean-up removes the partial staging');

  // 5. Allow internet: rules inside each copy's namespace; a host firewall flush mid-test changes nothing.
  const blocked = (gatewayAddress, hostAddress) => [
    'import socket,sys',
    'socket.create_connection(("1.1.1.1",443),10).close()',
    'def rejected(host,port):',
    ' try:',
    '  socket.create_connection((host,port),5).close();sys.exit("reached %s:%d"%(host,port))',
    ' except ConnectionRefusedError:pass',
    ' except OSError as error:sys.exit("%s:%d not rejected: %s"%(host,port,type(error).__name__))',
    'for port in [25,465,587,2525]:rejected("1.1.1.1",port)',
    'rejected("169.254.169.254",80)',
    `rejected(${JSON.stringify(gatewayAddress)},22)`,
    `rejected(${JSON.stringify(hostAddress)},22)`,
    'print("blocked")',
  ].join('\n');
  const hostAddress = (await run('exec', target, 'sh', '-c', "ip -4 -o addr show dev eth0 | awk '{print $4}' | cut -d/ -f1")).trim();
  before = await snapshot(target);
  const online = rt.createRestoreTest({ siteId: groupSite, serverId: servers[1].id, actor: 'qa', internet: true }).id;
  const onlineDone = await drive(online, { onHealth: async () => {
    const list = await copies(online), web = list.find(container => container.Name.endsWith('-0'));
    for (const container of list) {
      assert.ok((container.HostConfig.CapDrop || []).some(cap => /NET_ADMIN$/.test(cap)), 'copies cannot change their own firewall');
      const key = await run('exec', target, 'docker', 'inspect', '--format', '{{.NetworkSettings.SandboxKey}}', container.Id);
      for (const tool of ['iptables', 'ip6tables']) assert.match(await run('exec', target, 'nsenter', '--net=' + key, tool, '-S', 'OUTPUT'), /25,465,587,2525.*REJECT/, `${tool} rules inside ${container.Name}`);
    }
    const egress = JSON.parse(await run('exec', target, 'docker', 'network', 'inspect', `dbm-test-${online.slice(0, 12)}-egress`))[0];
    assert.equal(egress.Internal, false);
    const egressGateway = egress.IPAM.Config.find(item => item.Gateway && !item.Gateway.includes(':')).Gateway;
    assert.equal(await run('exec', target, 'docker', 'exec', web.Id, 'python', '-c', blocked(egressGateway, hostAddress)), 'blocked');
    assert.deepEqual(await hostRules(target), [], 'no host rules are used');
    await run('exec', target, 'sh', '-c', 'for tool in iptables ip6tables; do $tool -F INPUT 2>/dev/null; $tool -F DOCKER-USER 2>/dev/null; done; true');
    assert.equal(await run('exec', target, 'docker', 'exec', web.Id, 'python', '-c', blocked(egressGateway, hostAddress)), 'blocked', 'a host flush leaves the in-namespace rules intact');
    assert.equal((await remote(servers[1], { operation: 'restore-test-mail-check', testId: online })).intact, true);
  } });
  assert.equal(onlineDone.result, 'passed', onlineDone.reason ?? '');
  await verifyClean(online, before);
  record('Restore test with Allow internet: HTTPS out works; mail ports 25, 465, 587 and 2525, 169.254.169.254, the Docker gateway and the host address are rejected by IPv4 and IPv6 rules inside each copy; a host iptables flush mid-test leaves them intact and mail is still blocked');
  record('Restore test IPv6 egress: not sent for real, because GitHub-hosted runners have no IPv6 route and the nested daemon would need a restart with IPv6 mid-suite; the ip6tables rules inside every copy are asserted instead');

  // 6. Allow internet is refused when a container adds NET_ADMIN.
  await run('exec', source, 'docker', 'run', '-d', '--name', 'rt-netadmin', '--cap-add', 'NET_ADMIN', '-v', 'rt-netadmin-data:/site', 'docknest-rt:local');
  await healthy('rt-netadmin');
  const netadminSite = site('rt-netadmin', config(['rt-netadmin'])); await backup(netadminSite);
  before = await snapshot(target);
  const refused = rt.createRestoreTest({ siteId: netadminSite, serverId: servers[1].id, actor: 'qa', internet: true }).id;
  const refusedDone = await drive(refused);
  assert.equal(refusedDone.result, 'couldnt_run'); assert.equal(refusedDone.failed_step, 'restore_copy');
  assert.match(refusedDone.reason, /Allow internet is refused: rt-netadmin adds NET_ADMIN/);
  await verifyClean(refused, before);
  record('Restore test: Allow internet is refused with a plain reason when a container adds NET_ADMIN');

  // 7. A container that exits 20 seconds after start fails at "Still running" (30 s window for this case).
  await run('exec', source, 'docker', 'run', '-d', '--name', 'rt-exit', '--hostname', 'rt-exit-live', '-v', 'rt-exit-data:/site', 'docknest-rt:local', 'sh', '-c', 'python /app/app.py & sleep 20; [ "$(hostname)" = rt-exit-live ] || exit 3; wait');
  await healthy('rt-exit');
  const exitSite = site('rt-exit', config(['rt-exit'])); await backup(exitSite);
  before = await snapshot(target);
  rt.testTiming.scale = 0.5;
  const exiting = rt.createRestoreTest({ siteId: exitSite, serverId: servers[1].id, actor: 'qa' }).id;
  const exitDone = await drive(exiting).finally(() => { rt.testTiming.scale = 0.25; });
  assert.equal(exitDone.result, 'failed', exitDone.reason ?? ''); assert.equal(exitDone.failed_step, 'check_health');
  assert.equal(exitDone.checks.find(check => check.kind === 'stable')?.status, 'failed', JSON.stringify(exitDone.checks));
  await verifyClean(exiting, before);
  record('Restore test: a container that exits 20 seconds after start fails at "Still running"');

  // 8. The memory limit: a copy that needs more than 512 MB ends couldnt_run with no backup evidence.
  await run('exec', source, 'docker', 'run', '-d', '--name', 'rt-oom', '--hostname', 'rt-oom-live', '-v', 'rt-oom-data:/site', 'docknest-rt:local', 'sh', '-c', 'python /app/app.py & sleep 8; [ "$(hostname)" = rt-oom-live ] && wait; exec python -c "b=b\'x\'*(800*1024*1024);import time;time.sleep(600)"');
  await healthy('rt-oom');
  const oomSite = site('rt-oom', config(['rt-oom'])), oomBackup = await backup(oomSite);
  const oomHistory = historyCount(oomBackup.id);
  before = await snapshot(target);
  const oom = rt.createRestoreTest({ siteId: oomSite, serverId: servers[1].id, actor: 'qa', limits: { memoryMb: 512 } }).id;
  const oomDone = await drive(oom);
  assert.equal(oomDone.result, 'couldnt_run', oomDone.reason ?? ''); assert.match(oomDone.reason, /memory limit/);
  assert.equal(historyCount(oomBackup.id), oomHistory, 'couldnt_run writes no backup evidence');
  await verifyClean(oom, before);
  record('Restore test: a copy over its 512 MB memory limit ends couldnt_run ("memory limit") with no backup evidence');

  // 9. Static site: passes on the captured digest; the container steps are skipped.
  before = await snapshot(target);
  const staticTest = rt.createRestoreTest({ siteId: staticSiteId, serverId: servers[1].id, actor: 'qa' }).id;
  const staticDone = await drive(staticTest);
  assert.equal(staticDone.result, 'passed', staticDone.reason ?? '');
  assert.deepEqual(rt.loadSteps(staticTest).map(step => step.state), ['done', 'done', 'done', 'skipped', 'skipped', 'done']);
  await verifyClean(staticTest, before);
  record('Restore test, static site: passes on the captured file digest; staging and journal are removed');

  // 10. Tag collision. Packages save images by ID (no tags), so the defensive tag restore is driven directly with a
  // tagged archive on the test server's real image store.
  await run('cp', 'remote', target + ':/qa-helper');
  await run('cp', 'tests/integration/site', target + ':/fixture-site');
  const loaded = (await run('exec', target, 'docker', 'build', '-q', '-t', 'rt-collide:1', '--label', 'rt=loaded', '/fixture-site')).trim();
  await run('exec', target, 'docker', 'save', '-o', '/tmp/rt-collide.tar', 'rt-collide:1');
  const kept = (await run('exec', target, 'docker', 'build', '-q', '-t', 'rt-collide:1', '--label', 'rt=kept', '/fixture-site')).trim();
  await run('exec', target, 'docker', 'image', 'rm', loaded);
  const collision = await run('exec', target, 'python3', '-c', "import sys,json;sys.path.insert(0,'/qa-helper');import helper;tags=helper.image_archive_tags('/tmp/rt-collide.tar');state={'created':{'tags':[{'tag':t,'previous':helper.image_id_of(t)} for t in tags]}};helper.docker('load','-i','/tmp/rt-collide.tar');moved=helper.image_id_of('rt-collide:1');changed=helper.restore_test_tags(state);print(json.dumps({'tags':tags,'moved':moved,'changed':changed,'now':helper.image_id_of('rt-collide:1')}))");
  const collided = JSON.parse(collision.split('\n').at(-1));
  assert.deepEqual(collided.tags, ['rt-collide:1'], 'the archive names its tag'); assert.notEqual(collided.moved, kept, 'docker load moved the tag');
  assert.deepEqual(collided.changed, ['rt-collide:1']); assert.equal(collided.now, kept, 'the tag points back at the image it named before');
  await run('exec', target, 'sh', '-c', `docker image rm ${collided.moved} rt-collide:1 >/dev/null 2>&1; rm -f /tmp/rt-collide.tar; true`);
  record(`Restore test tag restore: a tag that docker load moved points back at its earlier image right after the load (${store} image store)`);

  // 11. A worker killed during Restore copy: the next worker ends the test couldnt_run and cleans up first.
  const worker = () => spawn(process.execPath, ['--no-addons', 'src/worker.js'], { env: process.env, stdio: 'ignore' });
  before = await snapshot(target);
  const killed = rt.createRestoreTest({ siteId: groupSite, serverId: servers[1].id, actor: 'qa' }).id;
  const first = worker();
  await until(async () => db.prepare("SELECT 1 FROM jobs WHERE type='restore-test' AND status='test_running' AND json_extract(details,'$.testId')=? AND json_extract(details,'$.step')='restore_copy'").get(killed), 'The worker did not reach Restore copy', 300);
  first.kill('SIGKILL'); await new Promise(resolve => first.once('exit', resolve));
  assert.equal(row(killed).result, null);
  const second = worker();
  try { await until(async () => finished(row(killed)), 'The next worker did not clean up the interrupted test', 420); }
  finally { second.kill('SIGTERM'); await new Promise(resolve => second.once('exit', resolve)); }
  const killedDone = row(killed);
  assert.equal(killedDone.result, 'couldnt_run'); assert.equal(killedDone.failed_step, 'restore_copy'); assert.match(killedDone.reason, /restarted during this step/); assert.equal(killedDone.cleanup, 'done');
  await verifyClean(killed, before);
  record('Restore test: a worker killed during Restore copy leaves the test to the next worker, which ends it couldnt_run and cleans the test server first');

  // 12. The manager stops past the deadline: the reaper on the test server cleans up on its own.
  before = await snapshot(target);
  const reaped = rt.createRestoreTest({ siteId: singleSite, serverId: servers[1].id, actor: 'qa', limits: { timeLimitMinutes: 10 } }).id;
  await drive(reaped, { stop: test => test.step === 'copy_backup' });
  db.prepare('UPDATE restore_tests SET deadline_at=? WHERE id=?').run(new Date(Date.now() + 60000).toISOString(), reaped);
  await drive(reaped, { stop: test => test.step === 'check_health' || test.result !== null });
  assert.equal(row(reaped).result, null);
  assert.ok((await copies(reaped)).length, 'the copy runs when the manager stops');
  await until(async () => (await copies(reaped)).length === 0 && (await run('exec', target, 'sh', '-c', `test -e /var/lib/docknest/restore-tests/${reaped} && echo journal || echo gone`)) === 'gone', 'The reaper did not clean up after the deadline', 420);
  const reapedDone = await drive(reaped);
  assert.equal(reapedDone.result, 'couldnt_run'); assert.match(reapedDone.reason, /time limit/); assert.equal(reapedDone.cleanup, 'done');
  await verifyClean(reaped, before);
  record('Restore test: with the manager stopped past the deadline, the reaper alone removes the copy, networks, images and staging; the manager later records couldnt_run and finds nothing left');

  for (const name of ['rt-single', 'rt-web', 'rt-db', 'rt-netadmin', 'rt-exit', 'rt-oom']) await run('exec', source, 'docker', 'rm', '-f', name).catch(() => {});
}
