import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// MongoDB on the disposable nested Linux hosts created by integration-linux, one tested major per CI matrix job
// (MONGO_IMAGE, default mongo:7.0; INTEGRATION_ONLY=mongo). A root-authenticated fixture with network none and no
// published ports is captured cold, restored in isolation and restore-tested, and every copy must answer the same
// read-only document count. A real SIGKILL must be refused, _FILE credentials must work, and auth without readable
// credentials and a missing mongosh must be refused while the source keeps running. Fixture passwords are random,
// written to mode-600 files and never logged.
export async function runMongoCompatibility({ run, until, hosts, servers, db, directory, evidence, record }) {
  const { enqueueBackup, enqueueRestore, claimJob, executeJob, planBackup, planRestore, verifyEncrypted } = await import('../src/engine.js');
  const { backupVerification } = await import('../src/recovery-evidence.js');
  const rt = await import('../src/restore-tests/engine.js');
  // 15 s stability window and short polls instead of 60 s, as in the restore test scenario: the same property, less CI time.
  rt.testTiming.scale = 0.25; rt.testTiming.cancelPollMs = 200;
  const [source, target] = hosts, name = 'qa-mongo-native', imageName = process.env.MONGO_IMAGE || 'mongo:7.0';
  const password = randomBytes(24).toString('base64url'), filePassword = randomBytes(24).toString('base64url');
  const secret = async (file, text, destination) => {
    await writeFile(join(directory, file), text, { mode: 0o600 });
    await run('cp', join(directory, file), source + ':' + destination);
    await run('exec', source, 'chmod', '600', destination);
  };
  await secret('mongo.env', 'MONGO_INITDB_ROOT_USERNAME=demo\nMONGO_INITDB_ROOT_PASSWORD=' + password + '\n', '/root/qa-mongo.env');
  await secret('mongo-root', filePassword, '/root/qa-mongo-secret');
  // The fixture's own shell, authenticated from the container environment or secret file like DockNest's helper.
  const mongo = (host, container, script) => run('exec', host, 'docker', 'exec', container, 'sh', '-c',
    'p="${MONGO_INITDB_ROOT_PASSWORD:-}"; [ -z "${MONGO_INITDB_ROOT_PASSWORD_FILE:-}" ] || p=$(cat "$MONGO_INITDB_ROOT_PASSWORD_FILE"); exec mongosh --quiet --norc -u "$MONGO_INITDB_ROOT_USERNAME" -p "$p" --authenticationDatabase admin shop --eval "$1"', 'qa', script);
  const count = (host, container) => mongo(host, container, 'print(db.orders.countDocuments({}))');
  const redact = text => [password, filePassword].reduce((value, secretValue) => value.split(secretValue).join('[redacted]'), String(text ?? ''));
  // The image's first start runs a temporary localhost-only server (--bind_ip 127.0.0.1) to create the root user; the
  // real one starts with --bind_ip_all. getCmdLineOpts.argv is the literal command line (parsed reports bindIp '*').
  const ready = async container => {
    const end = Date.now() + 180 * 1000;
    let last = '';
    while (Date.now() < end) {
      try {
        if (await mongo(source, container, "print(db.adminCommand({ getCmdLineOpts: 1 }).argv.includes('--bind_ip_all'))") === 'true') return;
        last = 'the temporary init server is still running';
      } catch (error) { last = String(error.stderr || error.message).slice(-600); }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    // Diagnosable without the password: the fixture's state, its last log lines and the last probe error, redacted.
    const state = await run('exec', source, 'docker', 'inspect', '--format', '{{json .State}}', container).catch(() => 'unknown');
    const logs = await run('exec', source, 'docker', 'logs', '--tail', '40', container).catch(error => String(error.stderr || ''));
    throw new Error(redact('MongoDB fixture ' + container + ' did not become ready. State: ' + state + '\nLast probe: ' + last + '\nLast logs:\n' + logs));
  };
  const running = async container => await run('exec', source, 'docker', 'inspect', '--format', '{{.State.Running}}', container) === 'true';
  const site = (label, cfg) => {
    const siteId = randomUUID();
    db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, servers[0].id, label, JSON.stringify(cfg), new Date().toISOString());
    return siteId;
  };
  const config = (container, services) => ({ containers: [container], stagingRoot: '/var/lib/docknest', exclusiveSourcesConfirmed: true,
    externalReferencesConfirmed: true, cleanShutdownConfirmed: true, shutdownProfile: 'generic', stopTimeout: 90, maintenance: { required: false }, services });
  const job = async () => {
    const claimed = claimJob();
    await executeJob(claimed);
    return db.prepare('SELECT * FROM jobs WHERE id=?').get(claimed.id);
  };
  const leaks = text => [password, filePassword].some(value => String(text ?? '').includes(value));
  const logEntries = async since => (await run('exec', source, 'docker', 'logs', '--since', String(since), name)).split('\n')
    .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const writableLayer = async container => (await run('exec', source, 'docker', 'diff', container)).split('\n').filter(Boolean).sort();

  await run('exec', source, 'docker', 'pull', imageName);
  const image = JSON.parse(await run('exec', source, 'docker', 'image', 'inspect', imageName))[0];
  await run('exec', source, 'docker', 'run', '-d', '--name', name, '--network', 'none', '--restart', 'no',
    '--env-file', '/root/qa-mongo.env', '-v', name + '-data:/data/db', imageName);
  await ready(name);
  assert.equal(await mongo(source, name, 'db.orders.insertMany(Array.from({ length: 25 }, (_, n) => ({ n }))); print(db.orders.countDocuments({}))'), '25');
  const nativeVersion = await mongo(source, name, 'print(db.version())');
  const initial = JSON.parse(await run('exec', source, 'docker', 'inspect', name))[0];
  assert.equal(initial.HostConfig.NetworkMode, 'none');
  assert.ok(!Object.values(initial.NetworkSettings.Ports || {}).some(Boolean));
  const layerBefore = await writableLayer(name);

  const siteId = site('Native MongoDB fixture', config(name, [{ container: name, engine: 'mongo', database: 'shop', dependsOn: [], checks: [{ name: 'Orders', collection: 'orders' }] }]));
  const plan = await planBackup(siteId);
  assert.deepEqual([plan.services[0].engine, plan.services[0].version], ['mongo', nativeVersion]);
  // The plan ran DockNest's mongosh call, which exits 72 unless mongosh reads telemetry as off (pre-seeded config).
  record('MongoDB ' + nativeVersion + ': the DockNest mongosh call reads telemetry as off before it connects');
  assert.ok(nativeVersion.startsWith(imageName.split(':')[1] + '.'), nativeVersion);
  const stopWindow = Math.floor(Date.now() / 1000) - 1;
  enqueueBackup(siteId, 'qa');
  const completed = await job();
  assert.equal(completed.status, 'completed', completed.error);
  const backup = db.prepare('SELECT * FROM backups WHERE job_id=?').get(completed.id);
  assert.equal(await verifyEncrypted(backup.path), backup.checksum);
  assert.ok(backup.path.startsWith('sftp:'), 'MongoDB fixture must use real remote SFTP storage');
  const verification = backupVerification(backup.id);
  assert.equal(verification.consistency.status, 'passed');
  const proof = JSON.stringify(verification.consistency);
  for (const field of ['wiredTigerClosedVerified', 'lockFileEmptyVerified', 'cleanShutdownLogVerified']) assert.match(proof, new RegExp('"' + field + '":true'));
  // The exact log ids the helper's proof relies on, read independently from this capture's stop.
  const entries = await logEntries(stopWindow);
  const closed = entries.findIndex(entry => entry.c === 'STORAGE' && entry.id === 4795901 && entry.msg === 'WiredTiger closed');
  assert.ok(closed >= 0, 'mongod logged STORAGE 4795901 "WiredTiger closed"');
  assert.ok(entries.slice(closed + 1).some(entry => entry.c === 'CONTROL' && entry.id === 23138 && entry.msg === 'Shutting down' && entry.attr?.exitCode === 0), 'then CONTROL 23138 "Shutting down" exitCode 0');
  assert.ok(![JSON.stringify(plan), JSON.stringify(completed), JSON.stringify(verification)].some(leaks), 'the root password never reaches plans, jobs or evidence');
  // DockNest's mongosh runs leave nothing in the writable layer that the backup commits as a snapshot.
  assert.deepEqual(await writableLayer(name), layerBefore);
  assert.ok(!layerBefore.some(line => /\.mongodb|\/tmp\/tmp\./.test(line)));
  assert.ok(await running(name));
  assert.equal(await mongo(source, name, 'db.orders.insertOne({ n: 25 }); print(db.orders.countDocuments({}))'), '26');
  record('MongoDB ' + nativeVersion + ' with root auth: cold capture proven by STORAGE 4795901 WiredTiger closed, then CONTROL 23138 Shutting down exit code 0, and an empty mongod.lock; credentials stay out of plans, jobs and evidence, and the committed writable layer is unchanged');

  const restorePlan = await planRestore(backup.id, { serverId: servers[1].id });
  assert.equal(restorePlan.executable, true, JSON.stringify(restorePlan.blockers));
  const queued = await enqueueRestore(backup.id, restorePlan, 'qa');
  const restored = await job();
  assert.equal(restored.id, queued.id);
  assert.equal(restored.status, 'completed', restored.error);
  const result = JSON.parse(restored.details).result;
  assert.equal(result.networkMode, 'none');
  assert.equal(result.restoreTested, true);
  assert.equal(backupVerification(backup.id).application.status, 'passed');
  assert.equal(await count(target, result.containerId), '25');
  assert.equal(await count(source, name), '26');
  await run('exec', target, 'docker', 'rm', '-f', ...result.containerIds);
  record('MongoDB isolated restore from authenticated SFTP answers the captured document count; the source keeps its live change');

  const testId = rt.createRestoreTest({ siteId, serverId: servers[1].id, actor: 'qa' }).id;
  const deadline = Date.now() + 20 * 60 * 1000;
  let test = rt.loadTest(testId);
  while (!(test.result !== null && ['done', 'failed', 'acknowledged'].includes(test.cleanup))) {
    if (Date.now() > deadline) throw new Error('The MongoDB restore test did not finish in time');
    rt.tickRestoreTests();
    const next = claimJob();
    if (next) await executeJob(next); else await new Promise(resolve => setTimeout(resolve, 500));
    test = rt.loadTest(testId);
  }
  assert.equal(test.result, 'passed', test.reason ?? '');
  assert.equal(test.checks.find(check => check.kind === 'database')?.status, 'passed', JSON.stringify(test.checks));
  record('MongoDB restore test on a second server passes its read-only document count check');

  // A real SIGKILL instead of this fixture's stop: consistency is refused, no package is published, the source recovers.
  // Intercept only this container's stop; any earlier wrapper is preserved and put back.
  assert.match(initial.Id, /^[a-f0-9]{64}$/);
  const marker = '/tmp/docknest-mongo-force-kill', savedDocker = '/usr/local/bin/docker-mongo-qa-real';
  const wrapper = join(directory, 'mongo-docker-wrapper');
  await writeFile(wrapper, '#!/bin/sh\nif [ "$1" = stop ] && [ -f ' + marker + ' ]; then\n for arg in "$@"; do\n  if [ "$arg" = ' + initial.Id + ' ]; then\n   rm ' + marker + '\n   exec ' + savedDocker + ' kill ' + initial.Id + '\n  fi\n done\nfi\nexec ' + savedDocker + ' "$@"\n');
  let replaced = false;
  try {
    await run('exec', source, 'test', '!', '-e', savedDocker);
    await run('exec', source, 'mv', '/usr/local/bin/docker', savedDocker);
    replaced = true;
    await run('cp', wrapper, source + ':/usr/local/bin/docker');
    await run('exec', source, 'chmod', '755', '/usr/local/bin/docker');
    const previousCount = db.prepare('SELECT COUNT(*) AS n FROM backups WHERE site_id=?').get(siteId).n;
    await run('exec', source, 'touch', marker);
    enqueueBackup(siteId, 'qa');
    const killed = await job();
    assert.equal(killed.status, 'failed', killed.error);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backups WHERE site_id=?').get(siteId).n, previousCount);
    assert.equal(await run('exec', source, 'test', '!', '-e', marker), '', 'MongoDB SIGKILL injection was not consumed');
    assert.ok(!leaks(JSON.stringify(killed)));
  } finally {
    await run('exec', source, 'rm', '-f', marker);
    if (replaced) await run('exec', source, 'mv', savedDocker, '/usr/local/bin/docker');
  }
  await until(async () => await count(source, name) === '26', 'MongoDB source did not recover after the forced kill');
  assert.equal(await verifyEncrypted(backup.path), backup.checksum);
  record('Real MongoDB SIGKILL rejects native consistency, publishes no new package, recovers the source and keeps the previous snapshot');

  // Root password from MONGO_INITDB_ROOT_PASSWORD_FILE: the contract reads it inside the container.
  const filed = 'qa-mongo-file';
  await run('exec', source, 'docker', 'run', '-d', '--name', filed, '--network', 'none', '--restart', 'no', '-e', 'MONGO_INITDB_ROOT_USERNAME=demo',
    '-e', 'MONGO_INITDB_ROOT_PASSWORD_FILE=/run/secrets/mongo-root', '-v', '/root/qa-mongo-secret:/run/secrets/mongo-root:ro', '-v', filed + '-data:/data/db', imageName);
  await ready(filed);
  const filePlan = await planBackup(site('MongoDB with a password file', config(filed, [{ container: filed, engine: 'mongo', dependsOn: [] }])));
  assert.deepEqual([filePlan.services[0].engine, filePlan.services[0].version], ['mongo', nativeVersion]);
  assert.ok(!leaks(JSON.stringify(filePlan)));
  record('MongoDB root credentials from a _FILE secret pass the contract without entering the plan');

  // Auth on, no credentials in the container: refused at plan time, before anything stops.
  const locked = 'qa-mongo-locked';
  await run('exec', source, 'docker', 'run', '-d', '--name', locked, '--network', 'none', '--restart', 'no', imageName, '--auth');
  await until(async () => await run('exec', source, 'docker', 'exec', locked, 'mongosh', '--quiet', '--norc', '--eval', 'print(db.runCommand({ ping: 1 }).ok)') === '1', 'MongoDB auth fixture did not become ready');
  const lockedSite = site('MongoDB without credentials', config(locked, []));
  await assert.rejects(planBackup(lockedSite), /MongoDB requires authentication/);
  // No mongosh in the container: refused with a plain reason, no image is pulled for it.
  await run('exec', source, 'docker', 'exec', locked, 'sh', '-c', 'rm -f "$(command -v mongosh)"');
  await assert.rejects(planBackup(lockedSite), /mongosh\) is missing/);
  assert.ok(await running(locked));
  record('MongoDB with auth but no readable credentials, and MongoDB without mongosh, are refused before stop with plain reasons; the source keeps running');

  evidence.mongo = [{ engine: 'mongo', version: nativeVersion, image: imageName, imageId: image.Id, digests: image.RepoDigests || [],
    checks: ['native version', 'clean shutdown consistency', 'authenticated SFTP package', 'network-none document-count recovery',
      'restore test document count', 'source live-change preserved', 'real SIGKILL rejection and source recovery',
      'credential-less auth refused', 'missing mongosh refused'],
    status: 'passed' }];
  await run('exec', source, 'docker', 'rm', '-f', name, filed, locked);
  await run('exec', source, 'rm', '-f', '/root/qa-mongo.env', '/root/qa-mongo-secret');
}
