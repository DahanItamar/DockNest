// Automatic restore tests on real Linux Docker (docs/restore-tests.md, "Linux integration test plan"). Called by
// scripts/integration-linux.js with the source host (hosts[0]) and the test server (hosts[1]). Each case runs the real
// engine through the worker's tick/claim/execute loop and the real helper over SSH, then proves the test server is
// exactly as before: no labelled container or network, the same image IDs and tags, no staging or journal path, no
// firewall rule, restore-test-status reports nothing left, and the reaper has exited.
// Cases: single container (limits, network none, no ports, internal web check as nobody), grouped Compose-labelled
// web + PostgreSQL (row-count check, web check, isolation asserts from inside a copy), grouped with Allow internet
// (HTTPS out, mail ports 25/465/587/2525 rejected), a mail-rule flush mid-test (couldnt_run, no backup evidence) and a
// static site (digest). Not "validated" until this passes in CI on Linux.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';

export async function runRestoreTestScenario({ run, until, hosts, servers, db, record, staticSiteId }) {
  const { enqueueBackup, claimJob, executeJob, planBackup } = await import('../src/engine.js');
  const { remote } = await import('../src/ssh.js');
  const { backupVerification } = await import('../src/recovery-evidence.js');
  const rt = await import('../src/restore-tests/engine.js');
  const [source, target] = hosts;
  // 15 s stability window and 2.5 s polls instead of 60 s and 10 s: the same property, less CI time.
  rt.testTiming.scale = 0.25;
  const label = 'docknest.restore-test';
  const lines = text => text.split('\n').map(line => line.trim()).filter(Boolean);

  async function serverSnapshot() {
    const images = [...new Set(lines(await run('exec', target, 'docker', 'images', '-aq', '--no-trunc')))].sort();
    const tags = lines(await run('exec', target, 'docker', 'images', '--no-trunc', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}')).filter(line => !line.includes('<none>')).sort();
    return { images, tags };
  }
  async function firewallRules() {
    const rules = [];
    for (const tool of ['iptables', 'ip6tables']) rules.push(...lines(await run('exec', target, 'sh', '-c', `${tool} -S DOCKER-USER 2>/dev/null || true`)).filter(line => line.includes('docknest-restore-test')));
    return rules;
  }
  async function backup(siteId) {
    const queued = enqueueBackup(siteId, 'qa'), job = claimJob();
    assert.equal(job.id, queued.id); await executeJob(job);
    const done = db.prepare('SELECT status,error FROM jobs WHERE id=?').get(job.id);
    assert.equal(done.status, 'completed', done.error);
    return db.prepare('SELECT * FROM backups WHERE job_id=?').get(job.id);
  }
  // The worker loop: tick, claim one job, run it. `onHealth` runs once while the copy is up (check_health).
  async function drive(testId, { onHealth } = {}) {
    const deadline = Date.now() + 20 * 60 * 1000;
    let healthDone = false;
    while (Date.now() < deadline) {
      const test = rt.loadTest(testId);
      if (test.result !== null && ['done', 'failed', 'acknowledged'].includes(test.cleanup)) return test;
      if (onHealth && !healthDone && test.result === null && test.step === 'check_health') { healthDone = true; await onHealth(test); }
      rt.tickRestoreTests();
      const job = claimJob();
      if (job) await executeJob(job); else await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('The restore test did not finish in time: ' + JSON.stringify(rt.loadSteps(testId).map(step => [step.step, step.state, step.detail])));
  }
  async function verifyClean(testId, before) {
    assert.equal(await run('exec', target, 'docker', 'ps', '-aq', '--filter', 'label=' + label), '', 'no labelled container is left');
    assert.equal(await run('exec', target, 'docker', 'network', 'ls', '-q', '--filter', 'label=' + label), '', 'no labelled network is left');
    assert.deepEqual(await serverSnapshot(), before, 'image IDs and every tag are as before');
    await run('exec', target, 'test', '!', '-e', '/var/lib/docker-backup-manager/restore/' + testId);
    await run('exec', target, 'test', '!', '-e', '/var/lib/docknest/restore-tests/' + testId);
    assert.deepEqual(await firewallRules(), [], 'no firewall rule is left');
    assert.equal((await remote(servers[1], { operation: 'restore-test-status', testId })).present, false);
    const reaperGone = `for p in /proc/[0-9]*; do grep -q 'restore-tests/${testId}' "$p/cmdline" 2>/dev/null && exit 1; done; exit 0`;
    await until(async () => { await run('exec', target, 'sh', '-c', reaperGone); return true; }, 'The reaper did not exit after clean-up', 60);
  }
  async function copies(testId) {
    const ids = lines(await run('exec', target, 'docker', 'ps', '-aq', '--filter', `label=${label}=${testId}`));
    return ids.length ? JSON.parse(await run('exec', target, 'docker', 'inspect', ...ids)) : [];
  }
  function assertLimits(container, testId) {
    const host = container.HostConfig;
    assert.equal(host.Memory, 1024 * 1024 * 1024); assert.equal(host.MemorySwap, 1024 * 1024 * 1024);
    assert.equal(host.NanoCpus, 1e9); assert.equal(host.PidsLimit, 1024);
    assert.equal(host.RestartPolicy.Name, 'no'); assert.equal(host.Privileged, false);
    assert.deepEqual({ type: host.LogConfig.Type, size: host.LogConfig.Config['max-size'], files: host.LogConfig.Config['max-file'] }, { type: 'local', size: '10m', files: '3' });
    assert.ok(!Object.values(host.PortBindings || {}).some(list => list?.length), 'no published ports');
    assert.equal(container.Config.Labels['com.docker.compose.project'], 'docknest-test-' + testId.slice(0, 12));
  }

  // Fixtures on the source: a fresh image this test server has never seen, so its IDs are test-only there.
  await run('exec', source, 'docker', 'build', '-q', '-t', 'docknest-rt:local', '--label', 'docknest.qa=restore-test', '/fixture-site');
  const config = (containers, extra = {}) => ({ containers, stagingRoot: '/var/lib/docknest', exclusiveSourcesConfirmed: true, externalReferencesConfirmed: true, cleanShutdownConfirmed: true, shutdownProfile: 'generic', maintenanceRequired: false, maintenance: { required: false }, ...extra });
  const site = (name, cfg) => { const siteId = randomUUID(); db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, servers[0].id, name, JSON.stringify(cfg), new Date().toISOString()); return siteId; };

  // 1. Single container with a healthcheck.
  await run('exec', source, 'docker', 'run', '-d', '--name', 'rt-single', '-v', 'rt-single-data:/site', 'docknest-rt:local');
  await until(async () => (await run('exec', source, 'docker', 'inspect', '--format', '{{.State.Health.Status}}', 'rt-single')) === 'healthy', 'Single fixture is not healthy');
  const singleSite = site('rt-single', config(['rt-single'])), singleBackup = await backup(singleSite);
  let before = await serverSnapshot();
  const single = rt.createRestoreTest({ siteId: singleSite, serverId: servers[1].id, actor: 'qa', probe: { service: 'rt-single', port: 8080, path: '/' } }).id;
  let singleCopies = [];
  const singleDone = await drive(single, { onHealth: async () => {
    singleCopies = await copies(single);
    assert.equal(singleCopies.length, 1);
    assertLimits(singleCopies[0], single); assert.equal(singleCopies[0].HostConfig.NetworkMode, 'none');
    await run('exec', target, 'test', '-f', `/var/lib/docknest/restore-tests/${single}/reaper.py`);
  } });
  assert.equal(singleDone.result, 'passed', singleDone.reason ?? ''); assert.equal(singleCopies.length, 1, 'the copy was inspected while it ran');
  const singleChecks = JSON.parse(db.prepare('SELECT checks FROM restore_tests WHERE id=?').get(single).checks);
  assert.equal(singleChecks.find(check => check.kind === 'http')?.status, 'passed', 'the internal web check ran as nobody inside the copy: ' + JSON.stringify(singleChecks));
  assert.equal(backupVerification(singleBackup.id).isolatedRestore.method, 'automatic restore test');
  await verifyClean(single, before);
  record('Restore test, single container: limits (memory, swap, CPU, pids, local logs), restart no, network none and no ports match; the internal web check runs as nobody; teardown leaves the test server exactly as before');

  // 2. Grouped Compose-labelled site: web + PostgreSQL with a row-count check and a web check.
  const password = randomBytes(18).toString('base64url');
  await run('exec', source, 'docker', 'pull', '-q', 'postgres:16');
  await run('exec', source, 'docker', 'network', 'create', 'rt-group');
  await run('exec', source, 'docker', 'run', '-d', '--name', 'rt-db', '--network', 'rt-group', '--network-alias', 'db', '--label', 'com.docker.compose.project=rtshop', '--tmpfs', '/tmp:size=32m,mode=1777', '-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_DB=fixture', '-v', 'rt-db-data:/var/lib/postgresql/data', 'postgres:16');
  await run('exec', source, 'docker', 'run', '-d', '--name', 'rt-web', '--network', 'rt-group', '--network-alias', 'web', '--label', 'com.docker.compose.project=rtshop', '-v', 'rt-web-data:/site', 'docknest-rt:local');
  const groupCfg = config(['rt-web', 'rt-db'], { stopTimeout: 90, temporaryMemoryFolders: [{ container: 'rt-db', destination: '/tmp' }], services: [{ container: 'rt-db', engine: 'postgres', database: 'fixture', dependsOn: [], checks: [{ name: 'Records', table: 'records' }] }] });
  const groupSite = site('rt-group', groupCfg);
  await until(async () => { try { return Boolean((await planBackup(groupSite)).services.find(service => service.engine === 'postgres')?.version); } catch { return false; } }, 'PostgreSQL fixture did not become ready', 180);
  await run('exec', source, 'docker', 'exec', '--user', 'postgres', 'rt-db', 'psql', '-X', '-w', '-h', '/var/run/postgresql', '-U', 'postgres', '-d', 'fixture', '-v', 'ON_ERROR_STOP=1', '-c', "CREATE TABLE records (id INTEGER PRIMARY KEY, value VARCHAR(80)); INSERT INTO records VALUES (1,'snapshot'),(2,'second');");
  const groupBackup = await backup(groupSite);
  const gateway = (await run('exec', target, 'sh', '-c', "ip -4 route show default | awk '{print $3}'")).trim() || '172.17.0.1';
  const isolation = [
    'import socket,sys',
    `targets=[(${JSON.stringify(gateway)},22),('172.17.0.1',22),('169.254.169.254',80),('1.1.1.1',443),('8.8.8.8',53),('2606:4700:4700::1111',443)]`,
    'for host,port in targets:',
    ' try:',
    '  socket.create_connection((host,port),2).close();sys.exit("reached %s:%d"%(host,port))',
    ' except OSError:pass',
    'try:',
    ' socket.getaddrinfo("example.com",443);sys.exit("public DNS answered")',
    'except OSError:pass',
    'print("isolated")',
  ].join('\n');
  before = await serverSnapshot();
  const grouped = rt.createRestoreTest({ siteId: groupSite, serverId: servers[1].id, actor: 'qa', probe: { service: 'rt-web', port: 8080, path: '/' } }).id;
  const groupedDone = await drive(grouped, { onHealth: async () => {
    const list = await copies(grouped);
    assert.equal(list.length, 2);
    for (const container of list) assertLimits(container, grouped);
    const networks = new Set(list.flatMap(container => Object.keys(container.NetworkSettings.Networks)));
    for (const name of networks) {
      const network = JSON.parse(await run('exec', target, 'docker', 'network', 'inspect', name))[0];
      assert.equal(network.Internal, true); assert.equal(network.Options['com.docker.network.bridge.gateway_mode_ipv4'], 'isolated'); assert.equal(network.Labels[label], grouped);
    }
    const web = list.find(container => container.Name.endsWith('-0'));
    assert.equal(await run('exec', target, 'docker', 'exec', web.Id, 'python', '-c', isolation), 'isolated');
  } });
  assert.equal(groupedDone.result, 'passed', groupedDone.reason ?? '');
  const groupedChecks = JSON.parse(db.prepare('SELECT checks FROM restore_tests WHERE id=?').get(grouped).checks);
  assert.equal(groupedChecks.find(check => check.kind === 'database')?.status, 'passed', JSON.stringify(groupedChecks));
  assert.equal(groupedChecks.find(check => check.kind === 'http')?.status, 'passed', JSON.stringify(groupedChecks));
  assert.equal(backupVerification(groupBackup.id).application.status, 'passed');
  await verifyClean(grouped, before);
  record('Restore test, grouped Compose-labelled web + PostgreSQL: fresh internal isolated networks, row-count and web checks pass; from inside a copy there is no route to the host gateway, 169.254.169.254, public IPv4 or IPv6 and no public DNS; teardown leaves the server as before');

  // 3. Allow internet: HTTPS out works, the four mail ports are rejected, the rules are gone afterwards.
  const mail = [
    'import socket,sys',
    'socket.create_connection(("1.1.1.1",443),10).close()',
    'for port in [25,465,587,2525]:',
    ' try:',
    '  socket.create_connection(("1.1.1.1",port),5).close();sys.exit("mail port %d open"%port)',
    ' except ConnectionRefusedError:pass',
    ' except OSError as error:sys.exit("mail port %d not rejected: %s"%(port,type(error).__name__))',
    'print("mail-blocked")',
  ].join('\n');
  before = await serverSnapshot();
  const online = rt.createRestoreTest({ siteId: groupSite, serverId: servers[1].id, actor: 'qa', internet: true }).id;
  const onlineDone = await drive(online, { onHealth: async () => {
    const rules = await firewallRules();
    assert.ok(rules.length >= 1 && rules.every(rule => rule.includes('25,465,587,2525') && rule.includes('REJECT')), JSON.stringify(rules));
    const web = (await copies(online)).find(container => container.Name.endsWith('-0'));
    assert.equal(await run('exec', target, 'docker', 'exec', web.Id, 'python', '-c', mail), 'mail-blocked');
  } });
  assert.equal(onlineDone.result, 'passed', onlineDone.reason ?? '');
  await verifyClean(online, before);
  record('Restore test with Allow internet: outbound HTTPS works, ports 25, 465, 587 and 2525 are rejected by DOCKER-USER rules, and the rules are removed afterwards');

  // 4. The mail rules are flushed mid-test: the next poll stops the copy and the test ends couldnt_run.
  const evidenceBefore = db.prepare('SELECT COUNT(*) AS n FROM backup_verification_history WHERE backup_id=?').get(groupBackup.id).n;
  before = await serverSnapshot();
  const flushed = rt.createRestoreTest({ siteId: groupSite, serverId: servers[1].id, actor: 'qa', internet: true }).id;
  const flushedDone = await drive(flushed, { onHealth: async () => {
    await run('exec', target, 'sh', '-c', 'iptables -F DOCKER-USER; ip6tables -F DOCKER-USER 2>/dev/null || true');
  } });
  assert.equal(flushedDone.result, 'couldnt_run'); assert.equal(flushedDone.failed_step, 'check_health');
  assert.match(flushedDone.reason, /Mail blocking was removed/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backup_verification_history WHERE backup_id=?').get(groupBackup.id).n, evidenceBefore, 'couldnt_run writes no backup evidence');
  await verifyClean(flushed, before);
  record('Restore test with Allow internet: flushing DOCKER-USER mid-test stops the copy at the next poll, ends couldnt_run ("mail blocking was removed") with no backup evidence, and teardown still leaves nothing');

  // 5. Static site: passes on the captured digest; the container steps are skipped.
  before = await serverSnapshot();
  const staticTest = rt.createRestoreTest({ siteId: staticSiteId, serverId: servers[1].id, actor: 'qa' }).id;
  const staticDone = await drive(staticTest);
  assert.equal(staticDone.result, 'passed', staticDone.reason ?? '');
  assert.deepEqual(rt.loadSteps(staticTest).map(step => step.state), ['done', 'done', 'done', 'skipped', 'skipped', 'done']);
  await verifyClean(staticTest, before);
  record('Restore test, static site: passes on the captured file digest; staging and journal are removed');

  for (const name of ['rt-single', 'rt-web', 'rt-db']) await run('exec', source, 'docker', 'rm', '-f', name).catch(() => {});
}
