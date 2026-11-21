// Online logical database dumps on real Linux Docker (docs/online-dumps.md). Called by scripts/integration-linux.js
// after the native engine milestones (their images are already pulled) with the source host (hosts[0]) and the restore
// target (hosts[1]). For PostgreSQL 16, MySQL 8.4, MariaDB 11.4 and (at the end) Redis 7 and Valkey 8 snapshots: the database keeps running through the backup,
// the package holds a dump, an isolated restore on the second host loads it and the configured data checks pass. A
// MySQL table that is not InnoDB falls back to the stopped file copy with a warning. A restore test loads a dump too.
// Not "validated" until this passes in CI on Linux.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';

const ENGINES = [
  { engine: 'postgres', image: 'postgres:16', data: '/var/lib/postgresql/data', delivery: 'staged' },
  { engine: 'mysql', image: 'mysql:8.4', data: '/var/lib/mysql', delivery: 'staged' },
  { engine: 'mariadb', image: 'mariadb:11.4', data: '/var/lib/mysql', delivery: 'direct' },
];

export async function runOnlineDumpScenario({ run, until, hosts, servers, db, record }) {
  const { enqueueBackup, enqueueRestore, claimJob, executeJob, planBackup, planRestore } = await import('../src/engine.js');
  const { backupVerification } = await import('../src/recovery-evidence.js');
  const [source, target] = hosts;
  const started = name => run('exec', source, 'docker', 'inspect', '--format', '{{.State.StartedAt}}', name);
  async function job(enqueue) {
    await enqueue(); const claimed = claimJob(); await executeJob(claimed);
    const done = db.prepare('SELECT * FROM jobs WHERE id=?').get(claimed.id);
    assert.equal(done.status, 'completed', done.error);
    return done;
  }
  const fixtures = [];
  for (const definition of ENGINES) {
    const name = 'qa-dump-' + definition.engine, password = randomBytes(24).toString('base64url');
    await run('exec', source, 'docker', 'pull', '-q', definition.image);
    const env = definition.engine === 'postgres' ? ['-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_DB=fixture'] : ['-e', (definition.engine === 'mariadb' ? 'MARIADB_ROOT_PASSWORD=' : 'MYSQL_ROOT_PASSWORD=') + password, '-e', (definition.engine === 'mariadb' ? 'MARIADB_DATABASE=' : 'MYSQL_DATABASE=') + 'fixture', '-e', 'MYSQL_UNIX_PORT=/tmp/mysql.sock'];
    // As in the engine milestones: the socket lives in a RAM /tmp, so the data folder holds no link to it.
    await run('exec', source, 'docker', 'run', '-d', '--name', name, '--restart', 'no', '--tmpfs', '/tmp:size=32m,mode=1777', '-v', name + '-data:' + definition.data, ...env, definition.image, ...(definition.engine === 'postgres' ? [] : ['--socket=/tmp/mysql.sock']));
    const cfg = { containers: [name], stagingRoot: '/var/lib/docknest', deliveryMode: definition.delivery, onlineDumps: true, exclusiveSourcesConfirmed: true, externalReferencesConfirmed: true, cleanShutdownConfirmed: true, shutdownProfile: 'generic', stopTimeout: 90, maintenance: { required: false }, temporaryMemoryFolders: [{ container: name, destination: '/tmp' }], services: [{ container: name, engine: definition.engine, database: 'fixture', dependsOn: [], checks: [{ name: 'Fixture records', table: 'records' }] }] };
    const siteId = randomUUID();
    db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, servers[0].id, 'Online dump ' + definition.engine, JSON.stringify(cfg), new Date().toISOString());
    let planError = '';
    await until(async () => { try { return Boolean((await planBackup(siteId)).services[0].version); } catch (error) { planError = String(error.message).slice(0, 200); return false; } }, 'Online dump fixture did not start: ' + definition.engine, 240).catch(error => { throw new Error(error.message + ': ' + planError); });
    const client = definition.engine === 'postgres' ? 'psql' : definition.engine;
    // A failed fixture query names its own SQL step and the client's error line (fixture data only, no password).
    const query = (host, cid, sql, database = 'fixture') => attempt(host, cid, sql, database).catch(error => { throw new Error(`Fixture query failed (${definition.engine}, ${sql.slice(0, 60)}): ${String(error.stderr || '').trim().split('\n').at(-1)?.slice(0, 200)}`); });
    const attempt = (host, cid, sql, database) => definition.engine === 'postgres'
      ? run('exec', host, 'docker', 'exec', '--user', 'postgres', cid, client, '-X', '-w', '-h', '/var/run/postgresql', '-U', 'postgres', '-d', database, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql)
      : run('exec', host, 'docker', 'exec', cid, 'sh', '-c', 'export MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"; exec "$1" --protocol=socket --socket=/tmp/mysql.sock -uroot -N -B -e "$2"', 'fixture', client, sql);
    // Data a dump must carry beyond one table: a second database (PostgreSQL) or a second account (MySQL, MariaDB).
    if (definition.engine === 'postgres') {
      await query(source, name, "CREATE ROLE reporter LOGIN PASSWORD 'fixture-only'; CREATE TABLE records (id INTEGER PRIMARY KEY, value VARCHAR(80)); ALTER TABLE records OWNER TO reporter; INSERT INTO records VALUES (1,'snapshot-native'),(2,'second-record');");
      await query(source, name, 'CREATE DATABASE reports OWNER reporter;', 'postgres');
      await query(source, name, "CREATE TABLE totals (value INTEGER); INSERT INTO totals VALUES (42);", 'reports');
    } else {
      await query(source, name, "USE fixture; CREATE TABLE records (id INTEGER PRIMARY KEY, value VARCHAR(80)) ENGINE=InnoDB; INSERT INTO records VALUES (1,'snapshot-native'),(2,'second-record'); CREATE USER 'reporter'@'%' IDENTIFIED BY 'fixture-only'; GRANT SELECT ON fixture.* TO 'reporter'@'%';");
    }
    const before = await started(name);
    const done = await job(() => enqueueBackup(siteId, 'qa'));
    assert.equal(await started(name), before, definition.engine + ' kept running through the backup: ' + JSON.stringify(JSON.parse(done.details).warnings || []));
    const backup = db.prepare('SELECT * FROM backups WHERE job_id=?').get(done.id), manifest = JSON.parse(backup.manifest);
    assert.equal(manifest.consistency.services[0].method, 'online logical dump');
    assert.equal(manifest.downtimeSeconds, 0, 'nothing stopped');
    assert.equal(backupVerification(backup.id).consistency.status, 'passed');
    assert.ok(!(JSON.parse(done.details).warnings || []).some(text => text.startsWith('Online dumps')), 'no fallback warning');
    await query(source, name, (definition.engine === 'postgres' ? '' : 'USE fixture; ') + "UPDATE records SET value='live-change' WHERE id=1;");
    const restored = await job(async () => enqueueRestore(backup.id, await planRestore(backup.id, { serverId: servers[1].id }), 'qa'));
    const result = JSON.parse(restored.details).result;
    assert.equal(result.restoreTested, true); assert.equal(backupVerification(backup.id).application.status, 'passed');
    assert.equal(await query(target, result.containerId, (definition.engine === 'postgres' ? '' : 'USE fixture; ') + 'SELECT value FROM records WHERE id=1;'), 'snapshot-native');
    if (definition.engine === 'postgres') {
      assert.equal(await query(target, result.containerId, 'SELECT value FROM totals;', 'reports'), '42', 'the second database was loaded');
      assert.equal(await query(target, result.containerId, "SELECT tableowner FROM pg_tables WHERE tablename='records';"), 'reporter', 'roles and owners were loaded');
    } else assert.equal(await query(target, result.containerId, "SELECT COUNT(*) FROM mysql.user WHERE user='reporter';"), '1', 'accounts were loaded');
    assert.equal(await run('exec', target, 'docker', 'ps', '-aq', '--filter', 'name=-load$'), '', 'no loader container is left');
    await run('exec', target, 'docker', 'rm', '-f', ...result.containerIds);
    fixtures.push({ ...definition, name, siteId, backup, query });
    record(`Online dump: ${definition.engine} (${definition.delivery}) keeps running through the backup; the isolated restore loads the dump into a fresh database, with its ${definition.engine === 'postgres' ? 'roles and second database' : 'accounts'}, and the data checks pass`);
  }

  // A writer next to the database: the writer stops (its files need it), the database keeps running, and the
  // restore brings back both the writer's files and the dumped data.
  const postgresFixture = fixtures.find(item => item.engine === 'postgres'), writer = 'qa-dump-writer';
  await run('exec', source, 'docker', 'pull', '-q', 'busybox:1.36');
  await run('exec', source, 'docker', 'run', '-d', '--name', writer, '--restart', 'no', '-v', writer + '-data:/data', 'busybox:1.36', 'sh', '-c', "echo uploaded > /data/upload.txt; trap 'exit 0' TERM; while true; do sleep 1; done");
  await until(async () => (await run('exec', source, 'docker', 'exec', writer, 'cat', '/data/upload.txt')) === 'uploaded', 'Writer fixture did not start');
  const single = JSON.parse(db.prepare('SELECT config FROM sites WHERE id=?').get(postgresFixture.siteId).config);
  const mixedId = randomUUID(), mixed = { ...single, containers: [writer, postgresFixture.name], services: [...single.services, { container: writer, engine: 'generic', dependsOn: [] }] };
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(mixedId, servers[0].id, 'Online dump with a writer', JSON.stringify(mixed), new Date().toISOString());
  const [writerBefore, databaseBefore] = [await started(writer), await started(postgresFixture.name)];
  const mixedDone = await job(() => enqueueBackup(mixedId, 'qa'));
  assert.notEqual(await started(writer), writerBefore, 'the writer stopped for its file copy');
  assert.equal(await started(postgresFixture.name), databaseBefore, 'the database kept running');
  const mixedBackup = db.prepare('SELECT * FROM backups WHERE job_id=?').get(mixedDone.id), mixedManifest = JSON.parse(mixedBackup.manifest);
  assert.ok(mixedManifest.downtimeSeconds > 0, 'the writer was down');
  assert.ok(mixedManifest.consistency.services.some(item => item.method === 'online logical dump'), JSON.stringify(mixedManifest.consistency));
  const mixedRestore = JSON.parse((await job(async () => enqueueRestore(mixedBackup.id, await planRestore(mixedBackup.id, { serverId: servers[1].id }), 'qa'))).details).result;
  // restoreTested stays false: a generic writer has no native data check of its own.
  const outputs = await Promise.all(mixedRestore.containerIds.map(id => run('exec', target, 'docker', 'exec', id, 'cat', '/data/upload.txt').catch(() => null)));
  assert.ok(outputs.includes('uploaded'), 'the writer files were restored');
  const restoredDatabase = mixedRestore.containerIds[outputs.indexOf(null)];
  assert.equal(await postgresFixture.query(target, restoredDatabase, 'SELECT value FROM records WHERE id=1;'), 'live-change', 'the dumped data was restored');
  await run('exec', target, 'docker', 'rm', '-f', ...mixedRestore.containerIds);
  await run('exec', source, 'docker', 'rm', '-f', '-v', writer);
  record('Online dump with a writer in the app: the writer stops for its file copy, the database keeps running, and the restore brings back both');

  // Fail closed: a MySQL table without transactions keeps the stopped file copy, named in a warning.
  const mysql = fixtures.find(item => item.engine === 'mysql');
  await mysql.query(source, mysql.name, 'USE fixture; CREATE TABLE legacy (id INTEGER) ENGINE=MyISAM;');
  const before = await started(mysql.name);
  const fallback = await job(() => enqueueBackup(mysql.siteId, 'qa'));
  assert.notEqual(await started(mysql.name), before, 'the database stopped for the file copy');
  assert.ok(JSON.parse(fallback.details).warnings.some(text => text.startsWith('Online dumps: qa-dump-mysql stopped for a file copy because tables that are not InnoDB')), fallback.details);
  const cold = JSON.parse(db.prepare('SELECT manifest FROM backups WHERE job_id=?').get(fallback.id).manifest);
  assert.equal(cold.consistency.services[0].cleanShutdownLogVerified, true);
  record('Online dump: a MySQL table that is not InnoDB falls back to the verified stopped copy, with the reason in a warning');

  // An automatic restore test of a dumped backup loads the dump and passes its data checks.
  const rt = await import('../src/restore-tests/engine.js');
  rt.testTiming.scale = 0.25; rt.testTiming.cancelPollMs = 200;
  const postgres = fixtures.find(item => item.engine === 'postgres');
  const testId = rt.createRestoreTest({ siteId: postgres.siteId, serverId: servers[1].id, backupId: postgres.backup.id, actor: 'qa' }).id;
  const deadline = Date.now() + 15 * 60 * 1000;
  let test = rt.loadTest(testId);
  while (Date.now() < deadline && !(test.result !== null && ['done', 'failed', 'acknowledged'].includes(test.cleanup))) {
    rt.tickRestoreTests();
    const next = claimJob();
    if (next) await executeJob(next); else await new Promise(resolve => setTimeout(resolve, 500));
    test = rt.loadTest(testId);
  }
  assert.equal(test.result, 'passed', test.reason ?? JSON.stringify(test.checks));
  assert.equal(test.checks.find(check => check.kind === 'dump')?.status, 'passed', JSON.stringify(test.checks));
  assert.ok(test.checks.some(check => check.kind === 'database' && check.status === 'passed'), JSON.stringify(test.checks));
  record('Online dump: an automatic restore test loads the dump in its copy and the database checks pass');
  for (const item of fixtures) await run('exec', source, 'docker', 'rm', '-f', '-v', item.name);
  await runRedisSnapshotScenario({ run, until, hosts, servers, db, record });
}


// Redis 7 and Valkey 8 (docs/online-dumps.md): with the app's online dumps on, a BGSAVE snapshot is taken while the
// server keeps running, and an isolated restore loads it into a fresh container. Seeded keys are compared after the
// restore. A server that keeps nothing on disk, or also keeps an append-only file, falls back to the stopped copy with
// the reason in a warning. The password reaches the server only as an argument of its own start command (fixture only)
// and the CLI only through REDISCLI_AUTH.
const REDIS_FLAVORS = [
  { flavor: 'redis', image: 'redis:7' },
  { flavor: 'valkey', image: 'valkey/valkey:8' },
];

async function runRedisSnapshotScenario({ run, until, hosts, servers, db, record }) {
  const { enqueueBackup, enqueueRestore, claimJob, executeJob, planBackup, planRestore } = await import('../src/engine.js');
  const { backupVerification } = await import('../src/recovery-evidence.js');
  const [source, target] = hosts;
  async function job(enqueue) {
    await enqueue(); const claimed = claimJob(); await executeJob(claimed);
    const done = db.prepare('SELECT * FROM jobs WHERE id=?').get(claimed.id);
    assert.equal(done.status, 'completed', done.error);
    return done;
  }
  const started = name => run('exec', source, 'docker', 'inspect', '--format', '{{.State.StartedAt}}', name);
  for (const { flavor, image } of REDIS_FLAVORS) {
    const name = 'qa-dump-' + flavor, password = randomBytes(24).toString('base64url'), key = 'fixture:key';
    const cli = (host, cid, ...args) => run('exec', host, 'docker', 'exec', '-e', 'REDISCLI_AUTH=' + password, cid, 'sh', '-c', 'c=redis-cli; command -v redis-cli >/dev/null || c=valkey-cli; exec "$c" --raw "$@"', 'fixture', ...args);
    const start = (...serverArgs) => run('exec', source, 'docker', 'run', '-d', '--name', name, '--restart', 'no', '--network', 'none', '-v', name + '-data:/data', image, flavor === 'redis' ? 'redis-server' : 'valkey-server', '--requirepass', password, ...serverArgs);
    await run('exec', source, 'docker', 'pull', '-q', image);
    await start();
    await until(async () => await cli(source, name, 'PING') === 'PONG', flavor + ' fixture did not start');
    // 50 seeded keys of several types, then one named key for the configured data check.
    await cli(source, name, 'EVAL', "for i=1,50 do redis.call('SET','seed:'..i,'value-'..i) end redis.call('RPUSH','seed:list','a','b','c') redis.call('HSET','seed:hash','f','v') return 1", '0');
    assert.equal(await cli(source, name, 'SET', key, 'snapshot-native-' + flavor), 'OK');
    const keys = await cli(source, name, 'DBSIZE');
    assert.equal(keys, '53');
    const digestOf = host => async cid => run('exec', host, 'docker', 'exec', '-e', 'REDISCLI_AUTH=' + password, cid, 'sh', '-c', 'c=redis-cli; command -v redis-cli >/dev/null || c=valkey-cli; "$c" --raw --scan | sort | while read k; do printf "%s=" "$k"; "$c" --raw DUMP "$k" | md5sum; done | md5sum');
    const before = await digestOf(source)(name);
    const cfg = { containers: [name], stagingRoot: '/var/lib/docknest', deliveryMode: 'staged', onlineDumps: true, exclusiveSourcesConfirmed: true, externalReferencesConfirmed: true, cleanShutdownConfirmed: true, shutdownProfile: 'generic', stopTimeout: 90, maintenance: { required: false },
      services: [{ container: name, engine: 'redis', database: '0', dependsOn: [], checks: [{ name: 'Fixture value', key }] }] };
    const siteId = randomUUID();
    db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, servers[0].id, 'Online dump ' + flavor, JSON.stringify(cfg), new Date().toISOString());
    const plan = await planBackup(siteId);
    assert.equal(plan.services[0].engine, 'redis');
    assert.equal(plan.services[0].flavor, flavor);
    assert.equal(plan.services[0].persistence, 'disk');
    const first = await started(name);
    const done = await job(() => enqueueBackup(siteId, 'qa'));
    assert.equal(await started(name), first, flavor + ' kept running through the backup: ' + JSON.stringify(JSON.parse(done.details).warnings || []));
    const backup = db.prepare('SELECT * FROM backups WHERE job_id=?').get(done.id), manifest = JSON.parse(backup.manifest);
    assert.equal(manifest.consistency.services[0].method, 'online logical dump');
    assert.equal(manifest.downtimeSeconds, 0, 'nothing stopped');
    assert.ok(!(JSON.parse(done.details).warnings || []).some(text => text.startsWith('Online dumps')), 'no fallback warning');
    assert.equal(backupVerification(backup.id).consistency.status, 'passed');
    await cli(source, name, 'SET', key, 'live-change');
    const restored = await job(async () => enqueueRestore(backup.id, await planRestore(backup.id, { serverId: servers[1].id }), 'qa'));
    const result = JSON.parse(restored.details).result;
    assert.equal(result.restoreTested, true); assert.equal(backupVerification(backup.id).application.status, 'passed');
    assert.equal(await cli(target, result.containerId, 'GET', key), 'snapshot-native-' + flavor);
    assert.equal(await cli(target, result.containerId, 'DBSIZE'), keys);
    assert.equal(await digestOf(target)(result.containerId), before, 'every key came back unchanged');
    assert.equal(await run('exec', target, 'docker', 'ps', '-aq', '--filter', 'name=-load$'), '', 'no loader container is left');
    await run('exec', target, 'docker', 'rm', '-f', '-v', ...result.containerIds);
    record(`Online dump: ${flavor} keeps running through the backup; the isolated restore loads the BGSAVE snapshot and all ${keys} keys match`);

    // Fail closed: a server that also keeps an append-only file, or nothing on disk, keeps the stopped copy.
    await run('exec', source, 'docker', 'rm', '-f', '-v', name);
    for (const [label, args, reason] of [['append-only file', ['--appendonly', 'yes'], 'it also keeps an append-only file'], ['cache only', ['--save', '', '--appendonly', 'no'], 'it keeps nothing on disk']]) {
      await start(...args);
      await until(async () => await cli(source, name, 'PING') === 'PONG', flavor + ' fixture did not restart');
      await cli(source, name, 'SET', key, 'snapshot-native-' + flavor);
      const stoppedBefore = await started(name);
      const fallback = await job(() => enqueueBackup(siteId, 'qa'));
      assert.notEqual(await started(name), stoppedBefore, flavor + ' (' + label + ') stopped for the file copy');
      assert.ok(JSON.parse(fallback.details).warnings.some(text => text.startsWith('Online dumps: ' + name + ' stopped for a file copy because ' + reason)), fallback.details);
      await run('exec', source, 'docker', 'rm', '-f', '-v', name);
    }
    record(`Online dump: ${flavor} with an append-only file, or cache only, falls back to the stopped copy with the reason in a warning`);
    await run('exec', source, 'docker', 'volume', 'rm', '-f', name + '-data');
  }
}
