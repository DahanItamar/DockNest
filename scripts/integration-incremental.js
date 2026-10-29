// Incremental backups (2.12, docs/incremental-backups.md) on real Linux Docker. A real site with a database and uploads
// is backed up as 1 full + 6 increments with edits, deletes, renames, two directories swapping names and a symlink to
// a directory replaced by a real directory. Every restore point is restored on the second host and its file tree and
// database are compared with the source as it was when that backup was taken. Also: a tampered package and a missing
// link are refused before anything is sent, a restore test passes on the newest point, a chain with an S3 copy
// restores from the copy, and the 2.11.1 helper refuses a version 2 package with a plain message.
// Credentials are throwaway values and are never printed. Nothing here is "validated" until this passes in CI on Linux.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { startS3Fixture } from './integration-s3.js';

const exec = promisify(execFile);
const mb = bytes => (bytes / 1048576).toFixed(1) + ' MB';

// Prints one JSON document describing /site: every entry's type, mode, owner and content hash (or link target), and the
// database rows. Run inside the source container and inside each restored copy; the two outputs must be identical.
const TREE = [
  'import os,json,hashlib,sqlite3,stat',
  'out={}',
  'def rec(p):',
  ' s=os.lstat(p);m=s.st_mode',
  " r=['l' if stat.S_ISLNK(m) else 'd' if stat.S_ISDIR(m) else 'f',m&0o7777,s.st_uid,s.st_gid]",
  ' if stat.S_ISLNK(m):r.append(os.readlink(p))',
  ' elif stat.S_ISREG(m):',
  '  h=hashlib.sha256()',
  "  with open(p,'rb') as f:",
  "   for c in iter(lambda:f.read(1<<20),b''):h.update(c)",
  '  r+=[h.hexdigest(),s.st_nlink]',
  ' return r',
  "for d,ds,fs in os.walk('/site'):",
  ' for n in ds+fs:',
  '  p=os.path.join(d,n);out[p]=rec(p)',
  "c=sqlite3.connect('file:/site/database.sqlite?mode=ro',uri=True)",
  "db={'integrity':c.execute('PRAGMA integrity_check').fetchone()[0],'records':c.execute('SELECT rowid,value FROM records ORDER BY rowid').fetchall(),'notes':c.execute('SELECT id,body FROM notes ORDER BY id').fetchall()}",
  "print(json.dumps({'files':out,'db':db},sort_keys=True))",
].join('\n');

export async function runIncrementalScenario({ run, until, hosts, servers, db, directory, record, evidence, sftpDestinationId }) {
  const [source, target] = hosts;
  const { enqueueBackup, claimJob, executeJob, planRestore, enqueueRestore, verifyEncrypted } = await import('../src/engine.js');
  const { updateIncrementalSettings, linkOf } = await import('../src/incremental.js');
  const { updateSiteStorage } = await import('../src/site-storage.js');
  const { claimCopy } = await import('../src/artifact-journal.js');
  const { executeCopy } = await import('../src/backup-copies.js');
  const { removeFile, openRead, openWrite } = await import('../src/storage.js');
  const { incrementalSaving } = await import('../src/storage-report.js');
  const { backupVerification } = await import('../src/recovery-evidence.js');
  const rt = await import('../src/restore-tests/engine.js');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const app = 'inc-app';
  const sh = script => run('exec', source, 'docker', 'exec', app, 'sh', '-c', script);
  const py = code => run('exec', source, 'docker', 'exec', app, 'python', '-c', code);
  const sql = statement => py(`import sqlite3;db=sqlite3.connect('/site/database.sqlite');${statement};db.commit()`);
  const tree = async (host, container) => JSON.parse(await run('exec', host, 'docker', 'exec', container, 'python', '-c', TREE));
  const healthy = () => until(async () => (await run('exec', source, 'docker', 'inspect', '--format', '{{.State.Health.Status}}', app)) === 'healthy', 'The incremental fixture did not become healthy', 120);

  // ---- The site -----------------------------------------------------------------------------------------------------
  await run('exec', source, 'docker', 'run', '-d', '--name', app, '-v', 'inc-data:/site', 'docknest-fixture:local');
  await healthy();
  await py("import sqlite3;db=sqlite3.connect('/site/database.sqlite');db.execute('CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY,body TEXT)');db.execute(\"INSERT INTO notes(body) VALUES('note-0')\");db.execute(\"INSERT INTO records VALUES('point-0')\");db.commit()");
  await sh([
    'cd /site',
    'mkdir -p uploads/2026/a uploads/2026/b da/sub db',
    'head -c 50331648 /dev/urandom > uploads/blob.bin',
    'i=1; while [ $i -le 20 ]; do echo "upload $i" > uploads/2026/a/f$i.txt; i=$((i+1)); done',
    'echo b-file > uploads/2026/b/b1.txt',
    'echo da-file > da/f.txt; echo da-sub > da/sub/s.txt; echo db-file > db/g.txt',
    'ln -s da lnk',
    'chown -R 1000:1000 uploads; chmod 600 uploads/blob.bin; chmod 640 da/f.txt',
  ].join(' && '));
  const config = { containers: [app], stagingRoot: '/var/lib/docknest', exclusiveSourcesConfirmed: true, externalReferencesConfirmed: true, cleanShutdownConfirmed: true, shutdownProfile: 'generic', maintenanceRequired: false, maintenance: { required: false } };
  const siteId = randomUUID();
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, servers[0].id, 'Incremental fixture', JSON.stringify(config), new Date().toISOString());
  const { targetId: copyTargetId, stop: stopS3 } = await startS3Fixture({ run, until, db, label: 'QA incremental copy S3' });
  const createdBackups = [];
  const containersOnTarget = async () => (await run('exec', target, 'docker', 'ps', '-aq')).split('\n').filter(Boolean).sort();
  const restoreDirectories = async () => run('exec', target, 'sh', '-c', 'ls -1 /var/lib/docker-backup-manager/restore 2>/dev/null | sort || true');
  try {
    updateSiteStorage(siteId, { mainTargetId: null, copies: [{ targetId: copyTargetId, retention: null }] }, 'qa');
    const settings = updateIncrementalSettings(siteId, { enabled: true, interval: 6 }, 'qa').settings;
    assert.equal(settings.enabled, true); assert.equal(settings.interval, 6);

    // ---- 1 full + 6 increments ----------------------------------------------------------------------------------------
    const changes = [
      null,
      // 1: edits and additions, database rows
      async () => { await sql("db.execute(\"INSERT INTO records VALUES('point-1')\");db.execute(\"INSERT INTO notes(body) VALUES('note-1')\");db.execute(\"UPDATE notes SET body='note-0-edited' WHERE id=1\")"); await sh('cd /site && echo "edited" > uploads/2026/a/f1.txt && echo "new upload" > uploads/2026/a/new1.txt && echo "asset edited" > asset.txt'); },
      // 2: deletes (files, a whole directory, one of two hard links)
      async () => { await sql("db.execute(\"INSERT INTO records VALUES('point-2')\");db.execute('DELETE FROM notes WHERE id=1')"); await sh('cd /site && rm uploads/2026/a/f2.txt uploads/2026/a/f3.txt uploads/2026/a/f4.txt && rm -r uploads/2026/b'); },
      // 3: renames (a directory, a file inside it, a directory inside da)
      async () => { await sql("db.execute(\"INSERT INTO records VALUES('point-3')\")"); await sh('cd /site && mv uploads/2026 uploads/archive-2026 && mv uploads/archive-2026/a/f11.txt uploads/archive-2026/a/renamed11.txt && mv da/sub da/subdir'); },
      // 4: two directories swap names
      async () => { await sql("db.execute(\"INSERT INTO records VALUES('point-4')\");db.execute(\"INSERT INTO notes(body) VALUES('note-4')\")"); await sh('cd /site && mv da swap-tmp && mv db da && mv swap-tmp db'); },
      // 5: a symlink to a directory is replaced by a real directory; a file becomes a directory
      async () => { await sql("db.execute(\"INSERT INTO records VALUES('point-5')\")"); await sh('cd /site && rm lnk && mkdir lnk && echo "real now" > lnk/file.txt && chown 1000:1000 lnk lnk/file.txt && rm uploads/archive-2026/a/f12.txt && mkdir uploads/archive-2026/a/f12.txt && echo inner > uploads/archive-2026/a/f12.txt/inner.txt'); },
      // 6: a directory becomes a file, metadata edits, a name with spaces and non-ASCII letters
      async () => { await sql("db.execute(\"INSERT INTO records VALUES('point-6')\");db.execute(\"UPDATE notes SET body='note-6' WHERE id>1\")"); await sh('cd /site && rm -r db && echo "db is a file now" > db && chmod 600 da/f.txt && chown 2000:2000 uploads/archive-2026/a/f13.txt && echo "unicode" > "uploads/ünï cöde name.txt"'); },
    ];
    const points = [];
    let previousInspect = null;
    for (let index = 0; index < changes.length; index++) {
      if (changes[index]) { await changes[index](); await healthy(); }
      const expected = await tree(source, app);
      // Diagnostic for the "plan-changed" fallback: which parts of the container's inspect output differ from the
      // previous backup. Only key paths and short values of the fixture container are printed (Env is skipped).
      const inspected = JSON.parse(await run('exec', source, 'docker', 'inspect', app))[0];
      const flat = (value, path = '', out = {}) => { if (value && typeof value === 'object') { for (const [key, item] of Object.entries(value)) if (path !== 'Config' || key !== 'Env') flat(item, path ? path + '.' + key : key, out); } else out[path] = String(value).slice(0, 60); return out; };
      const now = flat({ Id: inspected.Id, Image: inspected.Image, Config: inspected.Config, HostConfig: inspected.HostConfig, Mounts: inspected.Mounts, Networks: inspected.NetworkSettings.Networks });
      if (previousInspect) { const changed = Object.keys({ ...previousInspect, ...now }).filter(key => previousInspect[key] !== now[key]); console.log('Incremental fixture inspect differences since the previous backup: ' + (changed.length ? changed.map(key => `${key}: ${previousInspect[key]} -> ${now[key]}`).join('; ') : 'none')); }
      previousInspect = now;
      const queued = enqueueBackup(siteId, 'qa'), job = claimJob();
      assert.equal(job.id, queued.id);
      await executeJob(job);
      const finished = db.prepare('SELECT status,error FROM jobs WHERE id=?').get(job.id);
      assert.equal(finished.status, 'completed', finished.error);
      const backup = db.prepare('SELECT * FROM backups WHERE job_id=?').get(job.id);
      createdBackups.push(backup.id);
      const link = linkOf(backup.id);
      // Names only the reason code (no paths or secrets) so a chain that fell back to a full backup is explained in the log.
      const detail = JSON.parse(db.prepare('SELECT details FROM jobs WHERE id=?').get(job.id).details || '{}').incremental ?? {};
      console.log(`Incremental fixture point ${index}: kind=${link?.backup_kind} position=${link?.chain_position} fullReason=${detail.fullReason ?? '-'} size=${mb(Number(backup.size))}`);
      assert.ok(link, 'Point ' + index + ' is part of a chain');
      assert.equal(link.backup_kind, index === 0 ? 'full' : 'incremental', 'Point ' + index + ' kind (reason: ' + (detail.fullReason ?? 'none recorded') + ')');
      assert.equal(link.chain_position, index);
      assert.equal(await verifyEncrypted(backup.path), backup.checksum);
      assert.equal(await run('exec', source, 'docker', 'inspect', '--format', '{{.State.Running}}', app), 'true', 'The source keeps running after backup ' + index);
      await healthy();
      assert.deepEqual(await tree(source, app), expected, 'The backup did not change the source');
      points.push({ backup, expected, link });
    }
    assert.equal(new Set(points.map(point => point.link.chain_id)).size, 1, 'All seven points belong to one chain');
    record('Incremental backups: a real site (database + uploads) makes 1 full + 6 increments with edits, deletes, renames, two directories swapping names and a symlink to a directory replaced by a real directory; each package authenticates and the source keeps running');

    // ---- Restore from every point ------------------------------------------------------------------------------------------
    const restoreAndCompare = async (point, index, options = {}) => {
      const plan = await planRestore(point.backup.id, { serverId: servers[1].id, ...options });
      assert.equal(plan.executable, true, JSON.stringify(plan.blockers));
      assert.equal(plan.chainLength ?? 1, index + 1, 'The plan reads the whole chain up to this point');
      const queued = await enqueueRestore(point.backup.id, plan, 'qa'), job = claimJob();
      assert.equal(job.id, queued.id);
      await executeJob(job);
      const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
      assert.equal(row.status, 'completed', row.error);
      const { containerId } = JSON.parse(row.details).result;
      assert.deepEqual(await tree(target, containerId), point.expected, 'Restore point ' + index + ' equals the source at that time (files, modes, owners, links and database)');
      assert.equal(await run('exec', target, 'docker', 'inspect', '--format', '{{.HostConfig.NetworkMode}}', containerId), 'none');
      await run('exec', target, 'docker', 'rm', '-f', '-v', containerId);
      return { plan, row };
    };
    for (const [index, point] of points.entries()) await restoreAndCompare(point, index);
    record('Every one of the 7 restore points (the full backup and each increment) restores on a second host with a file tree, modes, owners, symlinks and database rows identical to the source when that backup was taken; copies have network none');

    // ---- Measured saving ---------------------------------------------------------------------------------------------------
    const rows = db.prepare('SELECT id,size FROM backups WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(createdBackups));
    const sizes = new Map(rows.map(row => [row.id, Number(row.size)]));
    const chains = points.map(point => ({ backupId: point.backup.id, kind: point.link.backup_kind, chainId: point.link.chain_id, position: point.link.chain_position }));
    const saving = incrementalSaving(rows, chains);
    const fullSize = sizes.get(points[0].backup.id), incrementSizes = points.slice(1).map(point => sizes.get(point.backup.id));
    const storedTotal = fullSize + incrementSizes.reduce((sum, size) => sum + size, 0), fullEquivalent = fullSize * points.length;
    for (const size of incrementSizes) assert.ok(size < fullSize, 'An increment is smaller than the full package');
    assert.equal(saving.increments, 6);
    assert.ok(saving.bytesSaved > 0);
    const percent = Math.round((1 - storedTotal / fullEquivalent) * 100);
    evidence.incrementalSaving = { fullBytes: fullSize, incrementBytes: incrementSizes, storedBytes: storedTotal, fullEquivalentBytes: fullEquivalent, savedPercent: percent, reportBytesSaved: saving.bytesSaved };
    console.log(`MEASURED incremental saving: full ${mb(fullSize)}, increments ${incrementSizes.map(mb).join(', ')}; stored ${mb(storedTotal)} for 7 restore points vs ${mb(fullEquivalent)} as 7 full backups (${percent}% saved, mount data only: committed snapshot images are saved in every package)`);
    record(`Measured on the fixture: 7 restore points stored in ${mb(storedTotal)} instead of ${mb(fullEquivalent)} as 7 full backups (${percent}% saved; the storage report counts ${mb(saving.bytesSaved)} saved)`);

    // ---- Tampered package and missing link are refused before anything is sent -----------------------------------------
    const newest = points.at(-1);
    const readAll = async path => { const chunks = []; for await (const chunk of await openRead(path)) chunks.push(chunk); return Buffer.concat(chunks); };
    const put = async (path, data) => { await removeFile(path); const output = await openWrite(path); await new Promise((resolve, reject) => { output.once('error', reject); output.end(data, error => error ? reject(error) : resolve()); }); };
    const refused = async () => {
      try {
        const plan = await planRestore(newest.backup.id, { serverId: servers[1].id });
        if (!plan.executable) return JSON.stringify(plan.blockers);
        const queued = await enqueueRestore(newest.backup.id, plan, 'qa'), job = claimJob();
        assert.equal(job.id, queued.id);
        await executeJob(job);
        const row = db.prepare('SELECT status,error FROM jobs WHERE id=?').get(job.id);
        assert.notEqual(row.status, 'completed', 'A restore that reads a broken chain must not complete');
        return String(row.error);
      } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; return String(error.message); }
    };
    const containersBefore = await containersOnTarget(), directoriesBefore = await restoreDirectories();
    const middle = points[3].backup, middlePath = middle.path, middleBytes = await readAll(middlePath);
    const tampered = Buffer.from(middleBytes); tampered[tampered.length >> 1] ^= 1;
    await put(middlePath, tampered);
    const tamperMessage = await refused();
    assert.match(tamperMessage, /depends on backup|did not authenticate|authenticat|checksum|damaged/i, 'Tampered package refused: ' + tamperMessage);
    assert.deepEqual(await containersOnTarget(), containersBefore, 'No container was created from a tampered chain');
    assert.equal(await restoreDirectories(), directoriesBefore, 'Nothing was sent to the target server for a tampered chain');
    await put(middlePath, middleBytes);
    await removeFile(middlePath);
    const missingMessage = await refused();
    assert.match(missingMessage, new RegExp('depends on backup ' + middle.id + ', which is missing or damaged'), 'Missing link refused with the plain message: ' + missingMessage);
    assert.deepEqual(await containersOnTarget(), containersBefore, 'No container was created from a chain with a missing link');
    assert.equal(await restoreDirectories(), directoriesBefore, 'Nothing was sent to the target server for a chain with a missing link');
    await put(middlePath, middleBytes);
    assert.equal(await verifyEncrypted(middlePath), middle.checksum);
    record('A tampered package in the middle of the chain and a missing link are both refused before any package is sent to the target server (no container created, no staging folder); the plain "depends on backup X" message names the missing backup');
    await restoreAndCompare(newest, 6);
    record('After the damaged package is put back, the newest point restores again and equals the source');

    // ---- Restore test on the newest point ----------------------------------------------------------------------------------
    rt.testTiming.scale = 0.25; rt.testTiming.cancelPollMs = 200;
    const testId = rt.createRestoreTest({ siteId, serverId: servers[1].id, actor: 'qa', probe: { service: app, port: 8080, path: '/' } }).id;
    const testDeadline = Date.now() + 20 * 60 * 1000;
    let test;
    for (;;) {
      test = rt.loadTest(testId);
      if (test.result !== null && ['done', 'failed', 'acknowledged'].includes(test.cleanup)) break;
      assert.ok(Date.now() < testDeadline, 'The restore test did not finish in time: ' + JSON.stringify(rt.loadSteps(testId).map(step => [step.step, step.state, step.detail])));
      rt.tickRestoreTests();
      const job = claimJob();
      if (job) await executeJob(job); else await wait(500);
    }
    assert.equal(test.result, 'passed', test.reason ?? '');
    assert.equal(backupVerification(newest.backup.id).isolatedRestore.method, 'automatic restore test');
    record('A restore test on the newest point (an increment, so the whole chain) passes and is recorded as evidence for that backup');

    // ---- 2.11.1 helper refuses a version 2 package ---------------------------------------------------------------------------
    const oldHelper = (await exec('git', ['show', 'v2.11.1:remote/helper.py'], { maxBuffer: 64 * 1024 * 1024 })).stdout;
    const oldHelperFile = join(directory, 'helper-2.11.1.py');
    await writeFile(oldHelperFile, oldHelper);
    await run('cp', oldHelperFile, target + ':/old-helper.py');
    const downgradeAttempt = async (point, label) => {
      const encrypted = join(directory, label + '.enc'), plain = join(directory, label + '.tar.gz');
      await pipeline(await openRead(point.backup.path), createWriteStream(encrypted));
      await exec('node', ['scripts/decrypt-backup.js', encrypted, process.env.MASTER_KEY_FILE, plain], { maxBuffer: 1024 * 1024 });
      const checksum = createHash('sha256').update(await readFile(plain)).digest('hex');
      const job = randomUUID(), root = '/var/lib/docker-backup-manager/restore/' + job;
      await run('exec', target, 'mkdir', '-p', root);
      await run('cp', plain, target + ':' + root + '/payload.tar.gz');
      const output = await new Promise(resolve => {
        const child = spawn('docker', ['exec', '-i', target, 'python3', '/old-helper.py'], { stdio: ['pipe', 'pipe', 'pipe'] });
        let text = ''; child.stdout.on('data', chunk => { text += chunk; }); child.stderr.on('data', chunk => { text += chunk; });
        child.once('close', code => resolve({ code, text }));
        child.stdin.end(JSON.stringify({ operation: 'restore', job, plaintextChecksum: checksum }) + '\n');
      });
      assert.notEqual(output.code, 0, 'The 2.11.1 helper must not restore a version 2 package');
      assert.match(output.text, /Unsupported or incomplete backup/, 'The 2.11.1 helper refuses with a plain message');
      assert.doesNotMatch(output.text, /"result"/, 'The 2.11.1 helper produced no restore result');
      await run('exec', target, 'rm', '-rf', root);
    };
    await downgradeAttempt(points[0], 'downgrade-full');
    record('The 2.11.1 helper refuses a version 2 package (the full package of a chain) with the plain message "Unsupported or incomplete backup" and restores nothing');

    // ---- The S3 copies of the chain (made after the refusal checks: a restore may fall back to a verified copy of a damaged package, by design) ----------------------------------------------------------------------------------------
    const copyRow = id => db.prepare('SELECT * FROM backup_copies WHERE backup_id=? AND target_id=?').get(id, copyTargetId);
    const deadline = Date.now() + 10 * 60 * 1000;
    for (;;) {
      const states = createdBackups.map(id => copyRow(id)?.status);
      if (states.every(status => status === 'verified')) break;
      assert.ok(!states.some(status => status === 'failed' || status === 'gave_up'), 'An S3 copy ended in a failed state: ' + states.join(','));
      assert.ok(Date.now() < deadline, 'The S3 copies did not all verify in time: ' + states.join(','));
      const next = claimCopy();
      if (next) await executeCopy(next, verifyEncrypted); else await wait(1000);
    }
    for (const point of points) assert.equal(await verifyEncrypted(copyRow(point.backup.id).path), point.backup.checksum, 'The S3 copy is the same encrypted package');

    // ---- Restore from the S3 copy -------------------------------------------------------------------------------------------
    for (const backupId of createdBackups) await removeFile(db.prepare('SELECT path FROM backups WHERE id=?').get(backupId).path);
    const fromCopy = await restoreAndCompare(newest, 6);
    assert.equal(fromCopy.plan.source.role, 'copy', 'With every main package gone, the chain restores from the S3 copies');
    assert.equal(fromCopy.plan.source.targetId, copyTargetId);
    assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='restore.source_fallback'").get(), 'The fallback to the copy is audited');
    record('With every main package deleted from SFTP, the newest point restores from the S3 copies of the whole chain and equals the source at that time');
  } finally {
    const failures = [];
    try { updateSiteStorage(siteId, { mainTargetId: null, copies: [] }, 'qa'); } catch { failures.push('site storage reset'); }
    try { await run('exec', source, 'docker', 'rm', '-f', '-v', app); } catch { failures.push('fixture container'); }
    try {
      const ids = createdBackups;
      for (const id of ids) { db.prepare('DELETE FROM backup_copies WHERE backup_id=?').run(id); db.prepare('DELETE FROM backup_chain_links WHERE backup_id=?').run(id); db.prepare('DELETE FROM backups WHERE id=?').run(id); }
    } catch { failures.push('test backup removal'); }
    try { db.prepare("UPDATE settings SET value=? WHERE key='backup_storage_target'").run(sftpDestinationId); } catch { failures.push('default destination'); }
    await stopS3();
    if (failures.length) console.warn('Incremental scenario cleanup incomplete: ' + failures.join(', '));
  }
}
