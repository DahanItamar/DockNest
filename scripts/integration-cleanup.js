// Server cleanup (docs/server-cleanup.md) on a real Linux Docker host. Called by scripts/integration-linux.js.
// Runs on the storage host (a registered server no site job uses), with images made by `docker import` so it needs no
// network. Proves: a registered site's stopped container, its named volume and a volume only its backup lists, a
// restore test copy, a move volume, a kept old copy, DockNest's own container, a running backup's snapshot image and a
// named volume of unknown owner all survive; the chosen eligible container, dangling image and anonymous volume are
// removed by ID; and an item that came into use after the scan is skipped.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function runCleanupScenario({ run, hosts, servers, db, record }) {
  const host = hosts[2], server = servers[2];
  const { scanServer, cleanServer, cleanupOptions } = await import('../src/server-cleanup.js');
  const docker = (...args) => run('exec', host, 'docker', ...args);
  const exists = async (kind, ref) => (await run('exec', host, 'sh', '-c', `docker ${kind} inspect ${ref} >/dev/null 2>&1 && echo yes || echo no`)) === 'yes';
  const now = new Date(Date.now() - 60000).toISOString();
  const siteId = randomUUID(), jobId = randomUUID(), backupId = randomUUID(), moveId = randomUUID(), testId = randomUUID(), stagingJob = randomUUID();
  const created = { containers: [], volumes: [], images: [] };
  cleanupOptions.minAgeSeconds = 0;  // fixtures are seconds old; DockNest itself keeps anything under an hour
  try {
    await run('exec', host, 'sh', '-c', 'tar -cf /tmp/empty.tar --files-from /dev/null && docker import /tmp/empty.tar cl-base:1 >/dev/null');
    created.images.push('cl-base:1');
    const make = async (name, ...extra) => { await docker('create', '--name', name, ...extra, 'cl-base:1', '/none'); created.containers.push(name); return docker('inspect', '--format', '{{.Id}}', name); };
    const volume = async (...args) => { const name = await docker('volume', 'create', ...args); created.volumes.push(name); return name; };
    // Protected fixtures.
    await volume('cl-site-data'); await volume('cl-gone-data'); await volume('cl-orphan');
    await make('cl-site', '-v', 'cl-site-data:/site');
    await make('cl-rt', '--label', 'docknest.restore-test=' + testId);
    const oldCopy = await make('cl-old');
    await make('cl-self', '--label', 'io.github.dahanitamar.docknest=app');
    const moveVolume = await volume('--label', 'docknest.move=' + moveId);
    await run('exec', host, 'sh', '-c', `mkdir -p /var/lib/docknest/moves/${moveId} && printf '%s' '{"containers":[{"id":"${oldCopy}","name":"cl-old","restartPolicy":"no"}]}' > /var/lib/docknest/moves/${moveId}/retired.json`);
    db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, server.id, 'Cleanup QA site', JSON.stringify({ kind: 'docker', containers: ['cl-site'], composeFiles: [], stagingRoot: '/var/lib/docknest' }), now);
    db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','completed','completed',?)").run(jobId, siteId, now);
    db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(backupId, siteId, jobId, now, '/data/cleanup-qa.enc', 1, 'a'.repeat(64), JSON.stringify({ containers: [{ Mounts: [{ Type: 'volume', Name: 'cl-gone-data' }] }] }), 0, 1, now);
    // Eligible fixtures, and one dangling image a backup job folder still lists as its snapshot.
    const junk = await make('cl-junk');
    const commit = async tag => docker('commit', '--change', 'LABEL cl.n=' + randomUUID(), 'cl-junk', tag);
    const dangling = await commit('cl-dangle:1'); await commit('cl-dangle:1'); created.images.push('cl-dangle:1', dangling);
    const snapshot = await commit('cl-snap:1'); await commit('cl-snap:1'); created.images.push('cl-snap:1', snapshot);
    await run('exec', host, 'sh', '-c', `mkdir -p /var/lib/docknest/${stagingJob} && printf '["${snapshot}"]' > /var/lib/docknest/${stagingJob}/snapshot-images.json && touch /var/lib/docknest/${stagingJob}/disarmed /var/lib/docknest/${stagingJob}/watchdog.done`);
    const anonymous = await volume(), late = await volume();

    const scan = await scanServer(server.id, 'qa');
    assert.equal(scan.busy, null, 'nothing runs on the storage host');
    const items = new Map(scan.items.map(item => [item.kind + ':' + item.id, item]));
    for (const key of ['containers:' + junk, 'images:' + dangling, 'volumes:' + anonymous, 'volumes:' + late]) assert.ok(items.has(key), 'offered: ' + key);
    const kept = new Map(scan.protected.map(item => [item.kind + ':' + (item.kind === 'containers' ? item.name : item.id), item.reason]));
    assert.deepEqual(Object.fromEntries(['containers:cl-site', 'containers:cl-rt', 'containers:cl-old', 'containers:cl-self', 'volumes:cl-gone-data', 'volumes:cl-orphan', 'volumes:' + moveVolume, 'images:' + snapshot].map(key => [key, kept.get(key)])),
      { 'containers:cl-site': 'site', 'containers:cl-rt': 'restoreTest', 'containers:cl-old': 'oldCopy', 'containers:cl-self': 'docknest', 'volumes:cl-gone-data': 'site', 'volumes:cl-orphan': 'named', ['volumes:' + moveVolume]: 'move', ['images:' + snapshot]: 'backup' });
    assert.ok(!scan.items.some(item => item.kind === 'volumes' && item.id === 'cl-site-data'), 'a volume a site container mounts is never offered');
    // After the scan, something starts using one of the offered volumes: the clean must skip it.
    await make('cl-late', '-v', late + ':/late');
    const result = await cleanServer(server.id, { token: scan.token, items: [['containers', junk], ['images', dangling], ['volumes', anonymous], ['volumes', late]].map(([kind, id]) => ({ kind, id })) }, 'qa');
    const status = Object.fromEntries(result.results.map(row => [row.kind + ':' + row.id, row.status]));
    assert.deepEqual(status, { ['containers:' + junk]: 'removed', ['images:' + dangling]: 'removed', ['volumes:' + anonymous]: 'removed', ['volumes:' + late]: 'skipped' });
    assert.equal(await exists('container', 'cl-junk'), false); assert.equal(await exists('image', dangling), false); assert.equal(await exists('volume', anonymous), false);
    for (const name of ['cl-site', 'cl-rt', 'cl-old', 'cl-self', 'cl-late']) assert.equal(await exists('container', name), true, name + ' survives');
    for (const name of ['cl-site-data', 'cl-gone-data', 'cl-orphan', moveVolume, late]) assert.equal(await exists('volume', name), true, name + ' survives');
    assert.equal(await exists('image', snapshot), true, 'the snapshot image a backup lists survives');
    const audit = db.prepare("SELECT detail FROM audit_events WHERE action='server.cleanup' AND target=? ORDER BY created_at DESC LIMIT 1").get(server.id);
    assert.deepEqual((({ result, removed, skipped }) => ({ result, removed, skipped }))(JSON.parse(audit.detail)), { result: 'partial', removed: 3, skipped: 1 });
    record('Server cleanup removes only chosen eligible items by ID; site, backup snapshot, restore test, move, kept old copy, DockNest and unknown named volumes survive; an item used after the scan is skipped');
  } finally {
    delete cleanupOptions.minAgeSeconds;
    created.containers.push('cl-late');
    await run('exec', host, 'sh', '-c', `docker rm ${created.containers.join(' ')} >/dev/null 2>&1; docker volume rm ${created.volumes.join(' ')} >/dev/null 2>&1; docker image rm ${created.images.reverse().join(' ')} >/dev/null 2>&1; rm -rf /var/lib/docknest/moves/${moveId} /var/lib/docknest/${stagingJob}; true`).catch(() => {});
    db.prepare('DELETE FROM backups WHERE id=?').run(backupId); db.prepare('DELETE FROM jobs WHERE id=?').run(jobId); db.prepare('DELETE FROM sites WHERE id=?').run(siteId);
  }
}
