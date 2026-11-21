// Append-only SFTP (docs/storage-backends.md, "Append-only SFTP"): real OpenSSH accounts on the storage host whose
// internal-sftp refuses requests with -P. One refuses delete and every way to change a written file (append-only); one
// refuses only deletes (broken: refused at test time). A real site is backed up to the append-only account, retention
// keeps the aged-out package instead of deleting it (and nothing counts as freed), the server itself refuses a direct
// delete, and the kept package restores on the second host. Passwords are throwaway values and are never printed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

const DENY_ALL = 'remove,rmdir,posix-rename,setstat,fsetstat,lsetstat,hardlink,symlink';
async function addSftpUser(run, host, user, password, denied) {
  await run('exec', host, 'adduser', '-D', '-s', '/bin/sh', user);
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', host, 'chpasswd'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('Fixture password provisioning failed')));
    child.stdin.end(user + ':' + password + '\n');
  });
  await run('exec', host, 'sh', '-c', `printf '\\nMatch User ${user}\\n  ForceCommand internal-sftp -P ${denied}\\n  AllowTcpForwarding no\\n' >> /etc/ssh/sshd_config`);
}

export async function runAppendOnlyScenario({ run, until, hosts, servers, db, record }) {
  const { testStorageTarget, targetOptions, adapters, statFile, storageCapacity, KEPT_UNTIL_RETEST } = await import('../src/storage.js');
  const { recordWriteMode, recordLeftovers, keptSummary } = await import('../src/storage/write-mode.js');
  const { updateSiteStorage } = await import('../src/site-storage.js');
  const { enqueueBackup, claimJob, executeJob, planRestore, enqueueRestore, verifyEncrypted } = await import('../src/engine.js');
  const { seal } = await import('../src/crypto.js');
  const storageHost = hosts[2], storage = servers[2];
  const appendPassword = randomBytes(24).toString('base64url'), halfPassword = randomBytes(24).toString('base64url');
  await addSftpUser(run, storageHost, 'aonly', appendPassword, DENY_ALL);
  await addSftpUser(run, storageHost, 'ahalf', halfPassword, 'remove,rmdir');
  await run('kill', '--signal', 'HUP', storageHost);
  const base = { host: storage.host, port: storage.port, hostKey: storage.host_key };
  let detected;
  await until(async () => { detected = await testStorageTarget({ ...base, username: 'aonly', password: appendPassword, root: '/home/aonly/docknest' }); return true; }, 'Append-only SFTP account did not accept the connection test', 60);
  assert.equal(detected.writeMode, 'append-only'); assert.equal(detected.probeLeftovers.length, 2);
  assert.ok(detected.probeLeftovers.every(file => file.startsWith('/home/aonly/docknest/.docknest-probe/')), 'probe files stay in the DockNest probe folder');
  assert.equal(await run('exec', storageHost, 'sh', '-c', 'ls /home/aonly/docknest/.docknest-probe | wc -l'), '2', 'the storage kept both probe files');
  const half = await testStorageTarget({ ...base, username: 'ahalf', password: halfPassword, root: '/home/ahalf/docknest' }).then(() => null, error => error);
  assert.ok(half, 'a storage that refuses deletes but allows permission changes is refused');
  assert.match(half.message, /not safely append-only/); assert.match(half.message, /permission changes/); assert.ok(half.probeLeftovers.length >= 1);
  record('Write-mode detection on real OpenSSH: an internal-sftp -P account that refuses delete, rename-over and permission changes is detected append-only; one that refuses only deletes is refused; probe files stay in .docknest-probe and are reported, not retried');

  const targetId = randomUUID(), at = new Date().toISOString();
  db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(targetId, 'Append-only QA Storage', base.host, base.port, 'aonly', base.hostKey, 'password', seal(appendPassword), '/home/aonly/docknest', 1e12, 'connected', at, at);
  recordWriteMode(targetId, detected.writeMode, 'qa'); recordLeftovers(targetId, detected.probeLeftovers.map(file => 'sftp:' + targetId + ':' + file));
  assert.equal(targetOptions(targetId).writeMode, 'append-only');

  await run('exec', hosts[0], 'docker', 'run', '-d', '--name', 'ao-site', '-v', 'ao-site-data:/site', 'docknest-fixture:local');
  const siteId = randomUUID(), cfg = { containers: ['ao-site'], stagingRoot: '/var/lib/docknest', exclusiveSourcesConfirmed: true, externalReferencesConfirmed: true, cleanShutdownConfirmed: true, shutdownProfile: 'generic', maintenanceRequired: false, maintenance: { required: false } };
  let copyId = null;
  try {
    await until(async () => (await run('exec', hosts[0], 'docker', 'inspect', '--format', '{{.State.Health.Status}}', 'ao-site')) === 'healthy', 'Append-only fixture site is not healthy');
    db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, servers[0].id, 'append-only-site', JSON.stringify(cfg), at);
    db.prepare("INSERT INTO policies(site_id,enabled,schedule,timezone,retention) VALUES(?,0,'0 2 * * *','UTC',1)").run(siteId);
    updateSiteStorage(siteId, { mainTargetId: targetId, copies: [] }, 'qa');
    const backupOnce = async value => {
      await run('exec', hosts[0], 'docker', 'exec', 'ao-site', 'python', '-c', `import sqlite3;db=sqlite3.connect('/site/database.sqlite');db.execute("UPDATE records SET value='${value}'");db.commit()`);
      const queued = enqueueBackup(siteId, 'qa'), job = claimJob(); assert.equal(job.id, queued.id); await executeJob(job);
      const done = db.prepare('SELECT status,error FROM jobs WHERE id=?').get(job.id); assert.equal(done.status, 'completed', done.error);
      return db.prepare('SELECT * FROM backups WHERE job_id=?').get(job.id);
    };
    const first = await backupOnce('append-first');
    assert.ok(first.path.startsWith('sftp:' + targetId + ':/home/aonly/docknest/'), 'the backup is published on the append-only account');
    assert.equal(await verifyEncrypted(first.path), first.checksum);
    const remotePath = first.path.slice(('sftp:' + targetId + ':').length);
    assert.equal(await run('exec', storageHost, 'stat', '-c', '%a %U', remotePath), '400 aonly', 'a published package is read-only for its owner');
    record('A real site backup publishes to the append-only SFTP account through .partial and a rename that never replaces a file; the package is read-only (0400) and authenticates');

    const freeBefore = (await storageCapacity({ options: targetOptions(targetId) })).managedBytes;
    const second = await backupOnce('append-second');
    assert.ok(db.prepare('SELECT 1 FROM backups WHERE id=?').get(first.id), 'retention keeps the aged-out backup listed');
    assert.equal(db.prepare('SELECT retry_after FROM retention_deferrals WHERE backup_id=?').get(first.id)?.retry_after, KEPT_UNTIL_RETEST);
    assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='retention.kept_by_storage' AND target=?").get(first.id));
    assert.equal((await statFile(first.path)).size, first.size, 'the kept package is still on the storage');
    assert.equal(keptSummary(targetId, 'sftp:' + targetId + ':').backups, 1);
    assert.equal((await storageCapacity({ options: targetOptions(targetId) })).managedBytes, freeBefore + second.size, 'nothing is reported as freed');
    // The server, not DockNest, enforces it: a delete sent straight to the adapter is refused by OpenSSH.
    const options = targetOptions(targetId);
    await assert.rejects(adapters.sftp.removeFile(options, remotePath), error => error.code === 3, 'OpenSSH refuses the delete');
    await assert.rejects(adapters.sftp.renameFile(options, second.path.slice(('sftp:' + targetId + ':').length), remotePath), 'a rename over a package is refused');
    assert.equal(await verifyEncrypted(first.path), first.checksum, 'the kept package is unchanged');
    record('Retention on an append-only SFTP account keeps the aged-out package (no delete sent, no space reported freed, audited once); OpenSSH itself refuses delete and rename-over');

    const plan = await planRestore(first.id, { serverId: servers[1].id }); assert.equal(plan.executable, true, JSON.stringify(plan.blockers));
    const queued = await enqueueRestore(first.id, plan, 'qa'), restoreJob = claimJob(); assert.equal(restoreJob.id, queued.id); await executeJob(restoreJob);
    const restored = db.prepare('SELECT * FROM jobs WHERE id=?').get(restoreJob.id); assert.equal(restored.status, 'completed', restored.error);
    copyId = JSON.parse(restored.details).result.containerId;
    assert.equal(await run('exec', hosts[1], 'docker', 'exec', copyId, 'python', '-c', "import sqlite3;print(sqlite3.connect('/site/database.sqlite').execute('SELECT value FROM records').fetchone()[0])"), 'append-first');
    record('Second-host restore from the package the append-only storage kept brings back its database row');
    // The server stops refusing: a new test detects it (never assumed), releases the kept package, and retention deletes it.
    await run('exec', storageHost, 'sed', '-i', `s|internal-sftp -P ${DENY_ALL}|internal-sftp|`, '/etc/ssh/sshd_config');
    await run('kill', '--signal', 'HUP', storageHost);
    const { testSaved } = await import('../src/storage-targets.js'), { retain } = await import('../src/engine.js');
    let retested;
    await until(async () => { retested = await testSaved(targetId, 'qa'); return retested.writeMode === 'normal'; }, 'The re-test did not detect the account as normal', 60);
    assert.equal(targetOptions(targetId).writeMode, 'normal');
    assert.equal(db.prepare('SELECT 1 FROM retention_deferrals WHERE backup_id=?').get(first.id), undefined, 'the kept package is released');
    await retain(siteId);
    assert.equal(db.prepare('SELECT 1 FROM backups WHERE id=?').get(first.id), undefined);
    assert.equal(await run('exec', storageHost, 'sh', '-c', `test -e '${remotePath}' && echo kept || echo gone`), 'gone');
    record('When the OpenSSH account stops refusing deletes, a new test detects it as normal, releases the kept package and the next retention deletes it');
  } finally {
    if (copyId) await run('exec', hosts[1], 'docker', 'rm', '-f', copyId).catch(() => {});
    await run('exec', hosts[0], 'docker', 'rm', '-f', 'ao-site').catch(() => {});
    // Later scenarios must not pick this destination up (recovery kits go to every main destination).
    db.prepare('DELETE FROM site_storage WHERE site_id=?').run(siteId);
  }
}
