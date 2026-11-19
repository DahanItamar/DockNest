import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// MongoDB 7.0 on the disposable nested Linux hosts created by integration-linux: a root-authenticated fixture with
// network none and no published ports is captured cold, restored in isolation and restore-tested, and every copy
// must answer the same read-only document count. Auth without readable credentials and a missing mongosh must be
// refused while the source keeps running. The fixture password is random, written to a mode-600 file and never logged.
export async function runMongoCompatibility({ run, until, hosts, servers, db, directory, evidence, record }) {
  const { enqueueBackup, enqueueRestore, claimJob, executeJob, planBackup, planRestore, verifyEncrypted } = await import('../src/engine.js');
  const { backupVerification } = await import('../src/recovery-evidence.js');
  const rt = await import('../src/restore-tests/engine.js');
  const [source, target] = hosts, name = 'qa-mongo-native', imageName = 'mongo:7.0', password = randomBytes(24).toString('base64url');
  const envFile = join(directory, 'mongo.env');
  await writeFile(envFile, 'MONGO_INITDB_ROOT_USERNAME=demo\nMONGO_INITDB_ROOT_PASSWORD=' + password + '\n', { mode: 0o600 });
  await run('cp', envFile, source + ':/root/qa-mongo.env');
  await run('exec', source, 'chmod', '600', '/root/qa-mongo.env');
  // The fixture's own shell, authenticated from the container environment like DockNest's helper.
  const mongo = (host, container, script) => run('exec', host, 'docker', 'exec', container, 'sh', '-c',
    'exec mongosh --quiet --norc -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin shop --eval "$1"', 'qa', script);
  const count = (host, container) => mongo(host, container, 'print(db.orders.countDocuments({}))');
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
  const leaks = text => String(text ?? '').includes(password);

  await run('exec', source, 'docker', 'pull', imageName);
  const image = JSON.parse(await run('exec', source, 'docker', 'image', 'inspect', imageName))[0];
  await run('exec', source, 'docker', 'run', '-d', '--name', name, '--network', 'none', '--restart', 'no',
    '--env-file', '/root/qa-mongo.env', '-v', name + '-data:/data/db', imageName);
  // The image's first start runs a temporary localhost-only server to create the root user; wait for the real one.
  await until(async () => await mongo(source, name, 'print(db.adminCommand({ getCmdLineOpts: 1 }).parsed.net.bindIpAll === true)') === 'true',
    'MongoDB native fixture did not become ready', 180);
  assert.equal(await mongo(source, name, 'db.orders.insertMany(Array.from({ length: 25 }, (_, n) => ({ n }))); print(db.orders.countDocuments({}))'), '25');
  const nativeVersion = await mongo(source, name, 'print(db.version())');
  const initial = JSON.parse(await run('exec', source, 'docker', 'inspect', name))[0];
  assert.equal(initial.HostConfig.NetworkMode, 'none');
  assert.ok(!Object.values(initial.NetworkSettings.Ports || {}).some(Boolean));

  const siteId = site('Native MongoDB fixture', config(name, [{ container: name, engine: 'mongo', database: 'shop', dependsOn: [], checks: [{ name: 'Orders', collection: 'orders' }] }]));
  const plan = await planBackup(siteId);
  assert.deepEqual([plan.services[0].engine, plan.services[0].version], ['mongo', nativeVersion]);
  assert.match(nativeVersion, /^7\.0\.\d+$/);
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
  assert.ok(![JSON.stringify(plan), JSON.stringify(completed), JSON.stringify(verification)].some(leaks), 'the root password never reaches plans, jobs or evidence');
  assert.equal(await run('exec', source, 'docker', 'inspect', '--format', '{{.State.Running}}', name), 'true');
  assert.equal(await mongo(source, name, 'db.orders.insertOne({ n: 25 }); print(db.orders.countDocuments({}))'), '26');
  record('MongoDB 7.0 with root auth: native version, cold capture with WiredTiger closed, exit code 0 and an empty mongod.lock from this stop; credentials stay out of plans, jobs and evidence');

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

  // Auth on, no credentials in the container: refused at plan time, before anything stops.
  const locked = 'qa-mongo-locked';
  await run('exec', source, 'docker', 'run', '-d', '--name', locked, '--network', 'none', '--restart', 'no', imageName, '--auth');
  await until(async () => await run('exec', source, 'docker', 'exec', locked, 'mongosh', '--quiet', '--norc', '--eval', 'print(db.runCommand({ ping: 1 }).ok)') === '1', 'MongoDB auth fixture did not become ready');
  const lockedSite = site('MongoDB without credentials', config(locked, []));
  await assert.rejects(planBackup(lockedSite), /MongoDB requires authentication/);
  // No mongosh in the container: refused with a plain reason, no image is pulled for it.
  await run('exec', source, 'docker', 'exec', locked, 'sh', '-c', 'rm -f "$(command -v mongosh)"');
  await assert.rejects(planBackup(lockedSite), /mongosh\) is missing/);
  assert.equal(await run('exec', source, 'docker', 'inspect', '--format', '{{.State.Running}}', locked), 'true');
  record('MongoDB with auth but no readable credentials, and MongoDB without mongosh, are refused before stop with plain reasons; the source keeps running');

  evidence.mongo = { engine: 'mongo', version: nativeVersion, image: imageName, imageId: image.Id, digests: image.RepoDigests || [],
    checks: ['native version', 'clean shutdown consistency', 'authenticated SFTP package', 'network-none document-count recovery',
      'restore test document count', 'source live-change preserved', 'credential-less auth refused', 'missing mongosh refused'],
    status: 'passed' };
  await run('exec', source, 'docker', 'rm', '-f', name, locked);
  await run('exec', source, 'rm', '-f', '/root/qa-mongo.env');
}
