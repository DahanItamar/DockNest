// Self-heal on real Linux Docker (docs/self-heal.md, "Test plan" items 1-6, security review item 8, and the extra
// cases: restart limits, backup/restart mutual exclusion, a flapping container, a container recreated with a new ID
// during self-heal). Called by scripts/integration-linux.js with the source host (hosts[0]). The worker is driven in
// this process (syncStreams, tickSelfHeal, claimJob, executeJob) over the real SSH stream and the real helper, so every
// restart below is a real `docker restart` decided by the real claim rules. Not "validated" until this passes in CI on
// Linux.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { writeHelperBundle } from '../src/helper-bundle.js';

export async function runSelfHealScenario({ run, until, hosts, servers, db, directory, record, evidence }) {
  const { enqueueBackup, claimJob, executeJob } = await import('../src/engine.js');
  const { remote } = await import('../src/ssh.js');
  const heal = await import('../src/self-heal/engine.js');
  const streams = await import('../src/self-heal/streams.js');
  const { timing } = await import('../src/self-heal/limits.js');
  const store = await import('../src/alerts/store.js');
  const [source] = hosts, server = servers[0];
  // The same properties with shorter waits: a 5 s gap instead of 60 s, a 5 s settle instead of 2 minutes, a 2 s throttle.
  Object.assign(timing, { minGapMs: 5000, settleMs: 5000, throttleMs: 2000 });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const inspect = async (name, format) => run('exec', source, 'docker', 'inspect', '--format', format, name);
  const health = name => inspect(name, '{{if .State.Health}}{{.State.Health.Status}}{{end}}').catch(() => '');
  const startedAt = name => inspect(name, '{{.State.StartedAt}}');
  const idOf = name => inspect(name, '{{.Id}}');
  const events = (siteId, kind, container) => db.prepare(`SELECT * FROM self_heal_events WHERE site_id=?${kind ? ' AND kind=?' : ''}${container ? ' AND container=?' : ''} ORDER BY at,rowid`).all(...[siteId, kind, container].filter(Boolean));
  const gaveUps = (siteId, reason) => db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='self_heal.gave_up' AND target=? AND json_extract(detail,'$.reason')=?").get(siteId, reason).n;
  const runtime = () => { try { return JSON.parse(db.prepare("SELECT value FROM settings WHERE key='self_heal_runtime'").get()?.value ?? '{}'); } catch { return {}; } };
  const streamState = () => runtime().servers?.[server.id]?.state;
  const eventsProcesses = async () => Number((await run('exec', source, 'sh', '-c', "pgrep -f 'docker events --filter type=container' | wc -l")).trim());
  // The worker loop in this process: open/close streams, queue restarts, claim and run one job, repeat.
  let pumping = false;
  async function pump(ms, stop = () => false) {
    const end = Date.now() + ms;
    pumping = true;
    try {
      while (Date.now() < end) {
        streams.syncStreams(); heal.tickSelfHeal();
        if (await stop()) return true;
        const job = claimJob();
        if (job) await executeJob(job); else await wait(300);
      }
      return false;
    } finally { pumping = false; }
  }
  const connected = () => pump(60_000, () => streamState() === 'connected').then(ok => assert.ok(ok, 'the stream connects'));

  // Fixture: an image whose health check passes while /tmp/ok exists; its entrypoint recreates the file on every start,
  // so a restart fixes it. A second service always fails its health check.
  await run('exec', source, 'sh', '-c', [
    'mkdir -p /heal-fixture',
    "printf 'FROM docknest-fixture:local\\nHEALTHCHECK --interval=1s --timeout=2s --retries=2 CMD test -f /tmp/ok\\nCMD [\"sh\",\"-c\",\"touch /tmp/ok; exec python /app/app.py\"]\\n' > /heal-fixture/Dockerfile",
    'docker build -q -t docknest-heal:local /heal-fixture >/dev/null',
    "printf 'services:\\n  web:\\n    image: docknest-heal:local\\n    restart: unless-stopped\\n  flaky:\\n    image: docknest-heal:local\\n    restart: unless-stopped\\n    healthcheck:\\n      test: [\"CMD\", \"false\"]\\n      interval: 1s\\n      timeout: 2s\\n      retries: 1\\n  flap:\\n    image: docknest-heal:local\\n    restart: unless-stopped\\n    healthcheck:\\n      test: [\"CMD-SHELL\", \"test $$(( $$(date +%%s) %% 6 )) -lt 3\"]\\n      interval: 1s\\n      timeout: 2s\\n      retries: 1\\n' > /heal-fixture/compose.yaml",
    'docker compose -p healshop -f /heal-fixture/compose.yaml up -d',
  ].join(' && '));
  await until(async () => (await health('healshop-web-1')) === 'healthy', 'heal fixture web is not healthy', 60);
  const siteId = randomUUID();
  const config = { containers: ['healshop-web-1', 'healshop-flaky-1', 'healshop-flap-1'], composeFiles: ['/heal-fixture/compose.yaml'], stagingRoot: '/var/lib/docknest', exclusiveSourcesConfirmed: true, externalReferencesConfirmed: true, cleanShutdownConfirmed: true, shutdownProfile: 'generic', maintenanceRequired: false, maintenance: { required: false, directory: '/var/lib/docknest/maintenance/heal' } };
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, server.id, 'heal-shop', JSON.stringify(config), new Date().toISOString());

  // The live event format of this Docker, parsed by the helper's own parser (security review item 4).
  const capture = spawn('docker', ['exec', source, 'timeout', '20', 'docker', 'events', '--filter', 'type=container', '--filter', 'event=health_status', '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let captured = ''; capture.stdout.on('data', chunk => { captured += chunk; });
  await wait(1000);
  await run('exec', source, 'docker', 'exec', 'healshop-web-1', 'rm', '-f', '/tmp/ok');
  await until(async () => captured.includes('health_status: unhealthy'), 'docker events printed no unhealthy event', 30);
  await run('exec', source, 'docker', 'exec', 'healshop-web-1', 'touch', '/tmp/ok');
  await until(async () => (await health('healshop-web-1')) === 'healthy', 'web did not become healthy again', 30);
  capture.kill();
  const bundle = writeHelperBundle(join(directory, 'heal-helper'));
  await run('cp', bundle, source + ':/tmp/docknest-heal-helper.py');
  const line = captured.split('\n').find(text => text.includes('health_status: unhealthy'));
  const parsed = JSON.parse(await run('exec', source, 'python3', '-c', 'import json,sys;sys.path.insert(0,"/tmp");import importlib.util as u;s=u.spec_from_file_location("helper","/tmp/docknest-heal-helper.py");h=u.module_from_spec(s);s.loader.exec_module(h);print(json.dumps(h.heal_event(sys.argv[1],[{"name":"healshop-web-1","project":"healshop","service":"web"}])))', line));
  assert.deepEqual(Object.keys(parsed).sort(), ['at', 'container', 'id', 'status', 'timeNano']);
  assert.equal(parsed.container, 'healshop-web-1'); assert.equal(parsed.status, 'unhealthy'); assert.equal(parsed.id, await idOf('healshop-web-1'));
  evidence.selfHealDocker = evidence.docker;
  record(`Self-heal: the helper parses the live docker events health format of Docker ${evidence.docker} to exactly {container, status, at, id, timeNano}`);

  // Turning it on finds only the site's containers with a health check (read-only helper call), with their Compose identity.
  const resolved = await remote(server, { operation: 'self-heal-resolve', names: config.containers });
  assert.deepEqual(resolved.containers.map(item => [item.name, item.project, item.service, item.healthcheck]), [['healshop-web-1', 'healshop', 'web', true], ['healshop-flaky-1', 'healshop', 'flaky', true], ['healshop-flap-1', 'healshop', 'flap', true]]);
  const watched = resolved.containers.filter(item => item.healthcheck).map(({ name, project, service }) => ({ name, project, service }));
  db.prepare("INSERT INTO self_heal_settings(site_id,enabled,max_restarts,window_minutes,watched,updated_at,updated_by) VALUES(?,1,2,10,?,?,'qa')").run(siteId, JSON.stringify(watched), new Date().toISOString());
  const credential = store.createCredential({ kind: 'telegram', name: 'QA bot', config: { token: '123456789:' + 'AbCdEf_-12'.repeat(4).slice(0, 35) } }, 'qa');
  const channel = store.createChannel({ kind: 'telegram', name: 'QA phone', credentialId: credential.id, config: { chatId: '-1001234567890' } }, 'qa');
  store.createRule({ channelId: channel.id, sourceKind: 'site', sourceId: siteId, events: ['self_heal.restarted', 'self_heal.gave_up'] }, 'qa');
  await connected();
  assert.equal(await eventsProcesses(), 1, 'one docker events process for the server');

  // 1. Health check fails after a file is removed: restarted within 20 s, recovered after the entrypoint restores it.
  let before = await startedAt('healshop-web-1'), t0 = Date.now();
  await run('exec', source, 'docker', 'exec', 'healshop-web-1', 'rm', '-f', '/tmp/ok');
  assert.ok(await pump(20_000, () => events(siteId, 'restarted', 'healshop-web-1').length === 1), 'web was not restarted within 20 s');
  assert.notEqual(await startedAt('healshop-web-1'), before);
  assert.ok(await pump(30_000, () => events(siteId, 'recovered', 'healshop-web-1').length >= 1), 'no recovered row');
  record(`Self-heal case 1: an unhealthy container is restarted in ${Math.round((Date.now() - t0) / 1000)} s and recorded recovered when its health check passes again`);

  // 2 and limits. Always failing: exactly N (2) restarts, then limit_reached and one gave_up alert in the outbox.
  assert.ok(await pump(90_000, () => events(siteId, 'limit_reached', 'healshop-flaky-1').length >= 1), 'flaky never reached its limit');
  await pump(8000);
  assert.equal(events(siteId, 'restarted', 'healshop-flaky-1').length + events(siteId, 'restart_failed', 'healshop-flaky-1').length, 2, 'exactly N restarts');
  const restartedRows = events(siteId, 'restarted', 'healshop-flaky-1');
  assert.ok(Date.parse(restartedRows[1].at) - Date.parse(restartedRows[0].at) >= timing.minGapMs, 'the gap between restarts holds');
  assert.equal(gaveUps(siteId, 'limit'), 1);
  // Alerts: the first restart of each container in its window, and one gave_up per container per window.
  const outbox = Object.fromEntries(db.prepare("SELECT event,COUNT(*) AS n FROM alert_outbox WHERE event LIKE 'self_heal.%' GROUP BY event").all().map(row => [row.event, row.n]));
  const restartedContainers = db.prepare("SELECT COUNT(DISTINCT container) AS n FROM self_heal_events WHERE site_id=? AND kind IN ('restarted','restart_failed')").get(siteId).n;
  const gaveUpRows = db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='self_heal.gave_up' AND target=?").get(siteId).n;
  assert.equal(outbox['self_heal.restarted'], restartedContainers, 'one restarted alert per container in the window, not one per restart');
  assert.equal(outbox['self_heal.gave_up'], gaveUpRows);
  record('Self-heal case 2: an always-failing health check gets exactly N restarts at least the gap apart, then limit_reached and one gave_up alert');

  // Flapping: health alternates every 3 s; the throttle bounds the rows and the limit bounds the restarts.
  const flapBefore = events(siteId, null, 'healshop-flap-1').length, flapStart = Date.now();
  await pump(30_000);
  const flapRows = events(siteId, null, 'healshop-flap-1');
  assert.ok(flapRows.filter(row => ['restarted', 'restart_failed'].includes(row.kind)).length <= 2, 'a flapping container never exceeds the limit');
  assert.ok(flapRows.length - flapBefore <= (Date.now() - flapStart) / timing.throttleMs * 2 + 4, `the throttle bounds the history (${flapRows.length - flapBefore} rows)`);
  // From here on the site is the web service only (a backup below needs every site container to start healthy).
  await run('exec', source, 'docker', 'compose', '-p', 'healshop', '-f', '/heal-fixture/compose.yaml', 'rm', '-s', '-f', 'flaky', 'flap');
  db.prepare('UPDATE sites SET config=? WHERE id=?').run(JSON.stringify({ ...config, containers: ['healshop-web-1'] }), siteId);
  db.prepare('UPDATE self_heal_settings SET watched=? WHERE site_id=?').run(JSON.stringify(watched.filter(item => item.name === 'healshop-web-1')), siteId);
  record('Self-heal: a flapping container is throttled to one acted-on event per window and never restarted beyond its limit');

  // 3. A backup running on the site while the container turns unhealthy: skipped, no restart; the restart follows later.
  const fakeBackup = randomUUID();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,started_at,details) VALUES(?,?,'backup','running','capturing',?,?,'{}')").run(fakeBackup, siteId, new Date().toISOString(), new Date().toISOString());
  const restartsBefore = events(siteId, 'restarted', 'healshop-web-1').length;
  before = await startedAt('healshop-web-1');
  await run('exec', source, 'docker', 'exec', 'healshop-web-1', 'rm', '-f', '/tmp/ok');
  assert.ok(await pump(30_000, () => events(siteId, 'skipped', 'healshop-web-1').some(row => row.reason === 'site_busy')), 'no site_busy skip');
  await pump(5000);
  assert.equal(await startedAt('healshop-web-1'), before, 'no restart while the backup runs');
  db.prepare("UPDATE jobs SET status='completed',stage='completed',finished_at=? WHERE id=?").run(new Date().toISOString(), fakeBackup);
  assert.ok(await pump(30_000, () => events(siteId, 'restarted', 'healshop-web-1').length > restartsBefore), 'the restart follows after the settle time');
  record('Self-heal case 3: no restart while a backup of the site runs (recorded skipped); the restart follows after the settle time');

  // Item 8: a backup that stops the container while a restart is queued. The restart yields (skipped), the real backup
  // runs and starts the site again, and nothing restarts it underneath.
  await pump(15_000, () => false);
  await run('exec', source, 'docker', 'exec', 'healshop-web-1', 'rm', '-f', '/tmp/ok');
  assert.ok(await pump(20_000, () => Boolean(db.prepare("SELECT 1 FROM jobs WHERE site_id=? AND status='heal_queued'").get(siteId)) || events(siteId, 'restarted', 'healshop-web-1').length > restartsBefore + 1), 'a restart was queued');
  if (db.prepare("SELECT 1 FROM jobs WHERE site_id=? AND status='heal_queued'").get(siteId)) {
    const backup = enqueueBackup(siteId, 'qa');
    const first = claimJob();
    assert.equal(first.id, backup.id, 'the queued restart yields to the queued backup');
    assert.ok(events(siteId, 'skipped', 'healshop-web-1').some(row => row.reason === 'work_queued'));
    const restartsDuring = events(siteId, 'restarted').length;
    await executeJob(first);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(first.id).status, 'completed', db.prepare('SELECT error FROM jobs WHERE id=?').get(first.id).error ?? '');
    assert.equal(events(siteId, 'restarted').length, restartsDuring, 'no restart during the backup');
    record('Self-heal item 8: a queued restart yields to a queued backup (no deadlock); the backup stops and starts the site and nothing restarts it underneath');
  }
  // Safe Edit at the same time: an edit job running for the site holds restarts exactly like a backup.
  const edit = randomUUID();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,started_at,details) VALUES(?,?,'site-edit','edit_running','apply',?,?,'{}')").run(edit, siteId, new Date().toISOString(), new Date().toISOString());
  assert.equal(heal.blockReason(siteId), 'site_busy');
  db.prepare("UPDATE jobs SET status='completed',stage='completed',finished_at=? WHERE id=?").run(new Date().toISOString(), edit);
  record('Self-heal item 8: a running Safe Edit (edit_running) holds restarts of its site');
  await until(async () => (await health('healshop-web-1')) === 'healthy', 'web did not settle', 60);

  // 4. Drop the SSH session (kill the sshd child) while the container turns unhealthy: on reconnect the restart happens.
  await pump(15_000, () => streamState() === 'connected');
  const dropRestarts = events(siteId, 'restarted', 'healshop-web-1').length;
  await run('exec', source, 'sh', '-c', "pkill -f 'sshd-session' || pkill -f 'sshd: root@' || true");
  await run('exec', source, 'docker', 'exec', 'healshop-web-1', 'rm', '-f', '/tmp/ok');
  assert.ok(await pump(60_000, () => events(siteId, 'restarted', 'healshop-web-1').length > dropRestarts), 'no restart after the reconnect');
  await until(async () => (await eventsProcesses()) === 1, 'the dropped session left a docker events process behind', 30);
  record('Self-heal case 4: a dropped SSH session reconnects with backoff, the connect snapshot finds the unhealthy container and restarts it; no orphan docker events');

  // 5. A restore test copy with the same Compose service on the same server is never restarted.
  await run('exec', source, 'docker', 'run', '-d', '--name', 'dbm-test-0123456789ab-web', '--label', 'com.docker.compose.project=healshop', '--label', 'com.docker.compose.service=web', '--label', 'docknest.restore-test=0123456789ab', '--health-cmd', 'false', '--health-interval', '1s', '--health-retries', '1', 'docknest-heal:local');
  const copyStarted = await startedAt('dbm-test-0123456789ab-web');
  await until(async () => (await health('dbm-test-0123456789ab-web')) === 'unhealthy', 'the copy did not become unhealthy', 30);
  await pump(15_000);
  assert.equal(await startedAt('dbm-test-0123456789ab-web'), copyStarted, 'the restore test copy was never restarted');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM self_heal_events WHERE container LIKE 'dbm-test-%'").get().n, 0);
  await run('exec', source, 'docker', 'rm', '-f', 'dbm-test-0123456789ab-web');
  record('Self-heal case 5: a restore test copy with the same Compose service is never matched or restarted');

  // 6. Worker restart: the stream resumes and an already handled event is not acted on again.
  await until(async () => (await health('healshop-web-1')) === 'healthy', 'web is not healthy before the restart case', 60);
  const handled = events(siteId, 'restarted').length;
  streams.stopStreams();
  heal.recoverInterruptedHeals();
  await connected();
  await pump(15_000);
  assert.equal(events(siteId, 'restarted').length, handled, 'no duplicate restart after a worker restart');
  record('Self-heal case 6: after a worker restart the stream resumes and nothing already handled restarts again');

  // Item 8: `compose up` recreates the container after enable (new ID, same labels): it is still healed.
  const oldId = await idOf('healshop-web-1');
  await run('exec', source, 'docker', 'compose', '-p', 'healshop', '-f', '/heal-fixture/compose.yaml', 'up', '-d', '--force-recreate', 'web');
  await until(async () => (await health('healshop-web-1')) === 'healthy', 'recreated web is not healthy', 60);
  assert.notEqual(await idOf('healshop-web-1'), oldId);
  const recreatedRestarts = events(siteId, 'restarted', 'healshop-web-1').length;
  await pump(8000);
  await run('exec', source, 'docker', 'exec', 'healshop-web-1', 'rm', '-f', '/tmp/ok');
  assert.ok(await pump(30_000, () => events(siteId, 'restarted', 'healshop-web-1').length > recreatedRestarts), 'a recreated container was not healed');
  record('Self-heal item 8: a container recreated by compose up after enable (new ID, same project and service) is still healed');

  // A container recreated with a new ID while its restart is queued: refused as recreated, gave_up with that reason.
  await until(async () => (await health('healshop-web-1')) === 'healthy', 'web is not healthy before the recreate case', 60);
  await pump(8000);
  await run('exec', source, 'docker', 'exec', 'healshop-web-1', 'rm', '-f', '/tmp/ok');
  await until(async () => (await health('healshop-web-1')) === 'unhealthy', 'web did not turn unhealthy', 30);
  // Let the stream record the event and queue the restart without claiming it.
  await until(async () => { streams.syncStreams(); heal.tickSelfHeal(); return Boolean(db.prepare("SELECT 1 FROM jobs WHERE site_id=? AND status='heal_queued'").get(siteId)); }, 'no queued restart', 30);
  // The stream stops first, so the new container's healthy event cannot close the episode before the claim.
  streams.stopStreams();
  await run('exec', source, 'docker', 'compose', '-p', 'healshop', '-f', '/heal-fixture/compose.yaml', 'up', '-d', '--force-recreate', 'web');
  const job = claimJob(); assert.equal(job.type, 'self-heal'); await executeJob(job);
  assert.equal(events(siteId, 'skipped', 'healshop-web-1').at(-1).reason, 'recreated');
  assert.equal(gaveUps(siteId, 'recreated'), 1);
  record('Self-heal: a container recreated with a new ID during self-heal is not restarted; gave_up is recorded with "container recreated"');

  // Item 8: worker SIGKILL leaves no orphan `docker events` on the server.
  streams.stopStreams();
  await until(async () => (await eventsProcesses()) === 0, 'docker events still runs after the stream stopped', 30);
  const child = spawn(process.execPath, ['--no-addons', '--input-type=module', '-e', "const s=await import('./src/self-heal/streams.js');s.syncStreams();setInterval(()=>{},1000);"], { env: process.env, stdio: 'ignore' });
  await until(async () => (await eventsProcesses()) === 1, 'the child worker did not open its stream', 60);
  child.kill('SIGKILL');
  await until(async () => (await eventsProcesses()) === 0, 'a SIGKILLed worker left docker events running on the server', 60);
  record('Self-heal item 8: a SIGKILLed worker leaves no docker events process on the server');

  // Item 8: the Docker daemon restarts while streaming: the stream reconnects and heals again.
  await connected();
  await run('exec', source, 'sh', '-c', 'pkill dockerd; for i in $(seq 1 30); do pgrep dockerd >/dev/null || break; sleep 1; done; setsid nohup dockerd-entrypoint.sh >/tmp/dockerd.log 2>&1 &');
  await until(async () => (await run('exec', source, 'docker', 'info', '--format', '{{.OSType}}')) === 'linux', 'the Docker daemon did not come back', 90);
  await until(async () => (await health('healshop-web-1')) === 'healthy', 'web did not come back with the daemon', 90);
  assert.ok(await pump(120_000, () => streamState() === 'connected' && runtime().servers?.[server.id]?.since && Date.parse(runtime().servers[server.id].since) > Date.now() - 120_000), 'the stream did not reconnect after the daemon restart');
  const daemonRestarts = events(siteId, 'restarted', 'healshop-web-1').length;
  await pump(8000);
  await run('exec', source, 'docker', 'exec', 'healshop-web-1', 'rm', '-f', '/tmp/ok');
  assert.ok(await pump(30_000, () => events(siteId, 'restarted', 'healshop-web-1').length > daemonRestarts), 'no restart after the daemon restart');
  record('Self-heal item 8: after a Docker daemon restart the stream reconnects and heals again');

  streams.stopStreams();
  assert.equal(pumping, false);
  db.prepare('UPDATE self_heal_settings SET enabled=0 WHERE site_id=?').run(siteId);
  await run('exec', source, 'sh', '-c', 'docker compose -p healshop -f /heal-fixture/compose.yaml down -v >/dev/null 2>&1 || true; rm -f /tmp/docknest-heal-helper.py');
}
