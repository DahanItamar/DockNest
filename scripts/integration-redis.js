import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Receives only the disposable nested Linux hosts created by integration-linux.
// The unauthenticated Redis fixture has network none and no published ports.
export async function runRedisCompatibility({ run, until, hosts, servers, db, directory, evidence, record }) {
  const { enqueueBackup, enqueueRestore, claimJob, executeJob, planBackup, planRestore, verifyEncrypted } = await import('../src/engine.js');
  const { backupVerification } = await import('../src/recovery-evidence.js');
  const source = hosts[0], target = hosts[1], name = 'qa-redis-native', imageName = 'redis:7.4';
  const siteId = randomUUID(), key = 'fixture:key', snapshot = 'snapshot-native-redis';
  const cfg = { containers: [name], stagingRoot: '/var/lib/docknest', exclusiveSourcesConfirmed: true,
    externalReferencesConfirmed: true, cleanShutdownConfirmed: true, shutdownProfile: 'generic',
    stopTimeout: 90, maintenance: { required: false },
    services: [{ container: name, engine: 'redis', database: '0', dependsOn: [], checks: [{ name: 'Fixture value', key }] }] };
  const query = (host, container, ...args) => run('exec', host, 'docker', 'exec', container,
    'redis-cli', '--raw', '-h', '127.0.0.1', '-n', '0', ...args);
  await run('exec', source, 'docker', 'pull', imageName);
  const image = JSON.parse(await run('exec', source, 'docker', 'image', 'inspect', imageName))[0];
  await run('exec', source, 'docker', 'run', '-d', '--name', name, '--network', 'none', '--restart', 'no',
    '-v', name + '-data:/data', imageName, 'redis-server', '--appendonly', 'yes', '--appendfsync', 'always', '--dir', '/data');
  await until(async () => await query(source, name, 'PING') === 'PONG', 'Redis native fixture did not become ready');
  assert.equal(await query(source, name, 'SET', key, snapshot), 'OK');
  assert.equal(await query(source, name, 'TYPE', key), 'string');
  assert.equal(await query(source, name, 'GET', key), snapshot);
  // Explicit SAVE establishes an actual RDB alongside the Redis 7 multipart AOF.
  assert.equal(await query(source, name, 'SAVE'), 'OK');
  assert.equal(await query(source, name, 'CONFIG', 'GET', 'appendonly'), 'appendonly\nyes');
  const initial = JSON.parse(await run('exec', source, 'docker', 'inspect', name))[0];
  assert.equal(initial.HostConfig.NetworkMode, 'none');
  assert.ok(!Object.values(initial.NetworkSettings.Ports || {}).some(Boolean));
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, servers[0].id, 'Native Redis fixture', JSON.stringify(cfg), new Date().toISOString());
  const plan = await planBackup(siteId);
  assert.equal(plan.services[0].engine, 'redis');
  assert.match(plan.services[0].version, /^7\.4\./);
  const nativeVersion = (await query(source, name, 'INFO', 'server')).match(/^redis_version:(.+)\r?$/m)?.[1]?.trim();
  assert.equal(plan.services[0].version, nativeVersion);
  enqueueBackup(siteId, 'qa');
  const capture = claimJob();
  await executeJob(capture);
  const completed = db.prepare('SELECT * FROM jobs WHERE id=?').get(capture.id);
  assert.equal(completed.status, 'completed', completed.error);
  const backup = db.prepare('SELECT * FROM backups WHERE job_id=?').get(capture.id);
  assert.equal(await verifyEncrypted(backup.path), backup.checksum);
  assert.ok(backup.path.startsWith('sftp:'), 'Redis fixture must use real remote SFTP storage');
  assert.equal(backupVerification(backup.id).consistency.status, 'passed');
  assert.equal(backupVerification(backup.id).application.status, 'not-tested');
  const persistenceProbe = "from pathlib import Path;import json;root=Path('/data');assert (root/'dump.rdb').is_file();aof=root/'appendonlydir';assert aof.is_dir();assert any(p.name.endswith('.manifest') for p in aof.iterdir());assert any(p.name.endswith('.aof') for p in aof.iterdir());print('rdb-and-multipart-aof')";
  // The official Redis image has no Python dependency: inspect host volume files.
  const dataSource = initial.Mounts.find(mount => mount.Destination === '/data').Source;
  const hostProbe = persistenceProbe.replace("root=Path('/data')", 'root=Path(' + JSON.stringify(dataSource) + ')');
  assert.equal(await run('exec', source, 'python3', '-c', hostProbe), 'rdb-and-multipart-aof');
  assert.equal(await query(source, name, 'SET', key, 'live-change-redis'), 'OK');
  const restorePlan = await planRestore(backup.id, { serverId: servers[1].id });
  assert.equal(restorePlan.executable, true, JSON.stringify(restorePlan.blockers));
  const queued = await enqueueRestore(backup.id, restorePlan, 'qa');
  const restore = claimJob();
  assert.equal(restore.id, queued.id);
  await executeJob(restore);
  const restored = db.prepare('SELECT * FROM jobs WHERE id=?').get(restore.id);
  assert.equal(restored.status, 'completed', restored.error);
  const result = JSON.parse(restored.details).result;
  assert.equal(result.networkMode, 'none');
  assert.equal(result.restoreTested, true);
  assert.equal(backupVerification(backup.id).application.status, 'passed');
  assert.equal(await query(target, result.containerId, 'TYPE', key), 'string');
  assert.equal(await query(target, result.containerId, 'GET', key), snapshot);
  assert.equal(await query(source, name, 'GET', key), 'live-change-redis');
  const copied = JSON.parse(await run('exec', target, 'docker', 'inspect', result.containerId))[0];
  assert.equal(copied.HostConfig.NetworkMode, 'none');
  assert.ok(!Object.values(copied.NetworkSettings.Ports || {}).some(Boolean));
  const copiedSource = copied.Mounts.find(mount => mount.Destination === '/data').Source;
  assert.notEqual(copiedSource, dataSource);
  assert.equal(await run('exec', target, 'python3', '-c', persistenceProbe.replace("root=Path('/data')", 'root=Path(' + JSON.stringify(copiedSource) + ')')), 'rdb-and-multipart-aof');
  record('Redis 7.4 native cold capture preserves real RDB/multipart AOF; authenticated SFTP isolated restore recovers its named key and preserves source live changes');

  // Intercept only this fixture container's stop to exercise a real SIGKILL.
  // Preserve any prior test wrapper installed by other Linux fixture sections.
  assert.match(initial.Id, /^[a-f0-9]{64}$/);
  const marker = '/tmp/docknest-redis-force-kill', savedDocker = '/usr/local/bin/docker-redis-qa-real';
  const wrapper = join(directory, 'redis-docker-wrapper');
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
    const killed = claimJob();
    await executeJob(killed);
    const failed = db.prepare('SELECT * FROM jobs WHERE id=?').get(killed.id);
    assert.equal(failed.status, 'failed', failed.error);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backups WHERE site_id=?').get(siteId).n, previousCount);
    assert.equal(await run('exec', source, 'test', '!', '-e', marker), '', 'Redis SIGKILL injection was not consumed');
    await until(async () => await query(source, name, 'PING') === 'PONG', 'Redis source did not recover after forced kill');
    assert.equal(await query(source, name, 'GET', key), 'live-change-redis');
    assert.equal(await verifyEncrypted(backup.path), backup.checksum);
    record('Real Redis SIGKILL rejects native consistency, publishes no new package, recovers the source and preserves the previous authenticated snapshot');
  } finally {
    await run('exec', source, 'rm', '-f', marker);
    if (replaced) await run('exec', source, 'mv', savedDocker, '/usr/local/bin/docker');
  }
  evidence.redis = { engine: 'redis', version: nativeVersion, image: imageName, imageId: image.Id,
    digests: image.RepoDigests || [], persistence: ['RDB', 'multipart AOF'],
    checks: ['native version', 'clean shutdown consistency', 'authenticated SFTP package',
      'network-none named-key recovery', 'source live-change preserved', 'real SIGKILL rejection and source recovery'],
    status: 'passed' };
  await run('exec', target, 'docker', 'rm', '-f', ...result.containerIds);
  await run('exec', source, 'docker', 'rm', '-f', name);
}
