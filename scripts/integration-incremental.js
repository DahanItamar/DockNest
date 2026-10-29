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
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
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

// Precise, non-secret difference between two tree snapshots: paths relative to the mount and the kind of difference.
function treeDifferences(expected, actual) {
  const out = [], names = ['type', 'mode', 'uid', 'gid', 'target-or-sha256', 'link-count'];
  const keys = new Set([...Object.keys(expected.files), ...Object.keys(actual.files)]);
  for (const key of [...keys].sort()) {
    const a = expected.files[key], b = actual.files[key], path = key.replace(/^\/site\/?/, '') || '.';
    if (!a) out.push(`extra in restore: ${path} (${b[0]})`);
    else if (!b) out.push(`missing in restore: ${path} (${a[0]})`);
    else for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(`${path}: ${names[i] ?? 'field ' + i} differs (${a[0]} -> ${b[0]}; ${i === 4 ? 'content or link target' : String(a[i]) + ' -> ' + String(b[i])})`);
  }
  if (JSON.stringify(expected.db) !== JSON.stringify(actual.db)) out.push('database differs: ' + JSON.stringify(expected.db).slice(0, 300) + ' -> ' + JSON.stringify(actual.db).slice(0, 300));
  return out;
}
function assertSameTree(expected, actual, label) {
  const differences = treeDifferences(expected, actual);
  assert.equal(differences.length, 0, label + ' differs in ' + differences.length + ' place(s):' + String.fromCharCode(10) + differences.slice(0, 40).join(String.fromCharCode(10)));
}

export async function runIncrementalScenario({ run, until, hosts, servers, db, directory, record, evidence, sftpDestinationId }) {
  const [source, target] = hosts;
  const { enqueueBackup, claimJob, executeJob, planRestore, enqueueRestore, verifyEncrypted } = await import('../src/engine.js');
  const { updateIncrementalSettings, linkOf } = await import('../src/incremental.js');
  const { updateSiteStorage } = await import('../src/site-storage.js');
  const { claimCopy } = await import('../src/artifact-journal.js');
  const { executeCopy } = await import('../src/backup-copies.js');
  const { removeFile, openRead, openWrite } = await import('../src/storage.js');
  const { incrementalSaving } = await import('../src/storage-report.js');
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
    // GNU tar replays directory renames in order, so an increment that contains folder renames is followed by a full
    // backup (reason folders-renamed). The order below puts renames at points 4 and 6 so both are increments.
    const changes = [
      null,
      // 1: edits and additions, database rows
      async () => { await sql("db.execute(\"INSERT INTO records VALUES('point-1')\");db.execute(\"INSERT INTO notes(body) VALUES('note-1')\");db.execute(\"UPDATE notes SET body='note-0-edited' WHERE id=1\")"); await sh('cd /site && echo "edited" > uploads/2026/a/f1.txt && echo "new upload" > uploads/2026/a/new1.txt && echo "asset edited" > asset.txt'); },
      // 2: deletes (files and a whole directory)
      async () => { await sql("db.execute(\"INSERT INTO records VALUES('point-2')\");db.execute('DELETE FROM notes WHERE id=1')"); await sh('cd /site && rm uploads/2026/a/f2.txt uploads/2026/a/f3.txt uploads/2026/a/f4.txt && rm -r uploads/2026/b'); },
      // 3: a symlink to a directory is replaced by a real directory; a file becomes a directory
      async () => { await sql("db.execute(\"INSERT INTO records VALUES('point-3')\")"); await sh('cd /site && rm lnk && mkdir lnk && echo "real now" > lnk/file.txt && chown 1000:1000 lnk lnk/file.txt && rm uploads/2026/a/f12.txt && mkdir uploads/2026/a/f12.txt && echo inner > uploads/2026/a/f12.txt/inner.txt'); },
      // 4: renames (a directory, a file inside it, a directory inside da)
      async () => { await sql("db.execute(\"INSERT INTO records VALUES('point-4')\");db.execute(\"INSERT INTO notes(body) VALUES('note-4')\")"); await sh('cd /site && mv uploads/2026 uploads/archive-2026 && mv uploads/archive-2026/a/f11.txt uploads/archive-2026/a/renamed11.txt && mv da/sub da/subdir'); },
      // 5: small edits (the backup after folder renames is a full one)
      async () => { await sql("db.execute(\"INSERT INTO records VALUES('point-5')\")"); await sh('cd /site && echo "edit after renames" > uploads/archive-2026/a/f5.txt'); },
      // 6: two directories swap names; a directory becomes a file; metadata edits; a name with spaces and non-ASCII letters
      async () => { await sql("db.execute(\"INSERT INTO records VALUES('point-6')\");db.execute(\"UPDATE notes SET body='note-6' WHERE id>1\")"); await sh('cd /site && mv da swap-tmp && mv db da && mv swap-tmp db && rm -r uploads/archive-2026/a/f12.txt && echo "was a directory" > uploads/archive-2026/a/f12.txt && chmod 600 da/g.txt && chown 2000:2000 uploads/archive-2026/a/f13.txt && echo "unicode" > "uploads/ünï cöde name.txt"'); },
    ];
    const points = [];
    let previousInspect = null;
    const kinds = [];
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
      if (index === 0) assert.equal(link.backup_kind, 'full'); else if (link.backup_kind === 'full') assert.ok(detail.fullReason, 'A full backup inside the series names its reason: ' + JSON.stringify(detail));
      kinds.push(`${index}:${link.backup_kind}${detail.fullReason ? '(' + detail.fullReason + ')' : ''}`);
      assert.equal(await verifyEncrypted(backup.path), backup.checksum);
      assert.equal(await run('exec', source, 'docker', 'inspect', '--format', '{{.State.Running}}', app), 'true', 'The source keeps running after backup ' + index);
      await healthy();
      assertSameTree(expected, await tree(source, app), 'The source after backup ' + index);
      points.push({ backup, expected, link });
    }
    const incrementalCount = points.filter(point => point.link.backup_kind === 'incremental').length;
    assert.ok(incrementalCount >= 4 && points.some(point => point.link.chain_position >= 3), 'Chains really form: ' + kinds.join(' '));
    console.log('Incremental fixture kinds: ' + kinds.join(' '));
    assert.deepEqual(kinds, ['0:full(feature-enabled)', '1:incremental', '2:incremental', '3:incremental', '4:incremental', '5:full(folders-renamed)', '6:incremental']);
    record('Incremental backups: a real site (database + uploads) makes a full backup and increments (folder renames force a new full backup) with edits, deletes, renames, two directories swapping names and a symlink to a directory replaced by a real directory; each package authenticates and the source keeps running');

    // ---- Restore from every point ------------------------------------------------------------------------------------------
    const restoreAndCompare = async (point, index, options = {}) => {
      const plan = await planRestore(point.backup.id, { serverId: servers[1].id, ...options });
      assert.equal(plan.executable, true, JSON.stringify(plan.blockers));
      assert.equal(plan.chainLength ?? 1, point.link.chain_position + 1, 'The plan reads the whole chain up to this point');
      const queued = await enqueueRestore(point.backup.id, plan, 'qa'), job = claimJob();
      assert.equal(job.id, queued.id);
      await executeJob(job);
      const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
      if (row.status !== 'completed') {
        // Fixture names only: show the directory-listing records of the failing package so the refusal can be judged.
        const encrypted = join(directory, 'diag-' + index + '.enc'), plain = join(directory, 'diag-' + index + '.tar.gz');
        await pipeline(await openRead(point.backup.path), createWriteStream(encrypted));
        await exec('node', ['scripts/decrypt-backup.js', encrypted, process.env.MASTER_KEY_FILE, plain], { maxBuffer: 1024 * 1024 });
        const script = `import tarfile,sys,io
t=tarfile.open(sys.argv[1])
for m in t:
 if m.name.startswith('mount-') and m.name.endswith('.tar'):
  for n in tarfile.open(fileobj=t.extractfile(m)):
   d=n.pax_headers.get('GNU.dumpdir')
   if d is not None:print(m.name,repr(n.name),repr(d)[:400])
`;
        const listing = (await exec('python3', ['-I', '-c', script, plain], { maxBuffer: 8 * 1024 * 1024 })).stdout;
        console.log(`Restore of point ${index} failed: ${row.error}
Directory listings in its last package:
${listing}`);
      }
      assert.equal(row.status, 'completed', 'Restore of point ' + index + ': ' + row.error);
      const { containerId } = JSON.parse(row.details).result;
      assertSameTree(point.expected, await tree(target, containerId), 'Restore point ' + index + ' vs the source at that time');
      assert.equal(await run('exec', target, 'docker', 'inspect', '--format', '{{.HostConfig.NetworkMode}}', containerId), 'none');
      await run('exec', target, 'docker', 'rm', '-f', '-v', containerId);
      return { plan, row };
    };
    for (const [index, point] of points.entries()) await restoreAndCompare(point, index);
    record('Every one of the 7 restore points (the full backup and each increment) restores on a second host with a file tree, modes, owners, symlinks and database rows identical to the source when that backup was taken; copies have network none');

    // ---- Recovery kit only: no DockNest database, API or ORDER.txt (docs/incremental-backups.md) -------------------------
    // The kit is exported and restored like an owner would, and only its own files are used: master.key,
    // recovery/decrypt-backup.js and recovery/helper.py. The packages are a plain copy of the site's storage folder.
    {
      const { exportRecoveryKit, restoreRecoveryKit } = await import('../src/recovery-kit.js');
      const passphrase = randomBytes(24).toString('base64'); // throwaway, never printed
      const kitFile = join(directory, 'incremental-kit.dkit'), kit = join(directory, 'incremental-kit'), storageCopy = join(directory, 'incremental-storage-copy');
      try {
        await exportRecoveryKit({ database: db, masterKey: process.env.MASTER_KEY_FILE, output: kitFile, passphrase, release: 'qa' });
        await restoreRecoveryKit({ input: kitFile, directory: kit, passphrase, updaterStatus: join(directory, 'no-updater-status') });
        await mkdir(storageCopy, { recursive: true });
        const fileOf = point => point.backup.path.split('/').pop();
        for (const point of points) {
          assert.match(fileOf(point), new RegExp(`^backup_.+--${point.backup.id}\\.tar\\.gz\\.enc$`), 'Packages are stored under their backup ID');
          await pipeline(await openRead(point.backup.path), createWriteStream(join(storageCopy, fileOf(point))));
        }
        await run('cp', join(kit, 'recovery', 'helper.py'), target + ':/kit-helper.py');
        // The tree script with another root; paths are reported as /site/... so they compare with the source.
        const treeAt = async root => {
          const script = TREE.replace("os.walk('/site')", `os.walk(${JSON.stringify(root)})`).replace("'file:/site/database.sqlite?mode=ro'", JSON.stringify(`file:${root}/database.sqlite?mode=ro`));
          const raw = JSON.parse(await run('exec', target, 'python3', '-c', script));
          return { files: Object.fromEntries(Object.entries(raw.files).map(([key, value]) => ['/site' + key.slice(root.length), value])), db: raw.db };
        };
        // Point 4 ends the longest chain (edits, deletes, a symlink replaced by a folder, renames); point 6 is the increment
        // after a new full backup in which two folders swap names.
        for (const index of [4, 6]) {
          const point = points[index], start = points.findLastIndex((item, k) => k <= index && item.link.backup_kind === 'full');
          const expectedIds = points.slice(start, index + 1).map(item => item.backup.id), decrypted = join(directory, 'kit-chain-' + index);
          const { stdout } = await exec(process.execPath, [join(kit, 'recovery', 'decrypt-backup.js'), '--chain', join(storageCopy, fileOf(point)), join(kit, 'master.key'), decrypted], { maxBuffer: 1024 * 1024 });
          assert.match(stdout, new RegExp(`${expectedIds.length} packages, every link matches`));
          const chainFile = JSON.parse(await readFile(join(decrypted, 'CHAIN.json'), 'utf8'));
          assert.deepEqual(chainFile.packages.map(item => item.backupId), expectedIds, 'The kit finds the chain from the sealed manifests, full backup first');
          assert.deepEqual(chainFile.packages.map(item => item.sha256), points.slice(start, index + 1).map(item => item.backup.checksum));
          await run('cp', decrypted, target + ':/kit-chain-' + index);
          const output = await run('exec', target, 'python3', '/kit-helper.py', 'restore-chain', '/kit-chain-' + index, '/kit-restore-' + index);
          const result = JSON.parse(output.split('\n').pop()).result;
          assert.equal(result.packages, expectedIds.length);
          const mount = result.mounts.find(item => item.destination === '/site');
          assert.ok(mount, 'The restore names the /site mount: ' + JSON.stringify(result.mounts.map(item => item.destination)));
          assert.equal(result.images.length, expectedIds.length, 'One images.tar per package, in chain order');
          assertSameTree(point.expected, await treeAt(mount.path), 'Recovery-kit-only restore of point ' + index + ' vs the source at that time');
          await run('exec', target, 'rm', '-rf', '/kit-chain-' + index, '/kit-restore-' + index);
          await rm(decrypted, { recursive: true, force: true });
        }
        // A missing package in the middle of the chain stops the kit before it writes anything.
        const middle = points[2], refusedOutput = join(storageCopy, 'refused');
        await rm(join(storageCopy, fileOf(middle)));
        const refusal = await exec(process.execPath, [join(kit, 'recovery', 'decrypt-backup.js'), '--chain', join(storageCopy, fileOf(points[4])), join(kit, 'master.key'), refusedOutput]).then(() => null, error => String(error.stderr));
        assert.ok(refusal, 'The kit refuses a chain with a missing package');
        assert.match(refusal, new RegExp(`depends on backup ${middle.backup.id}, which is missing or damaged`));
        assert.deepEqual(await readdir(refusedOutput), [], 'Nothing is written for a broken chain');
        record('Recovery kit only (no DockNest database, API or order file): from a plain copy of the storage folder, the kit finds the chain from the sealed manifests, checks every link, and its helper rebuilds points 4 and 6 (deletes, a symlink replaced by a folder, renames, two folders swapping names) with a file tree and database identical to the source at that time; a missing package is refused before anything is written');
      } finally {
        await run('exec', target, 'rm', '-rf', '/kit-helper.py', '/kit-chain-4', '/kit-restore-4', '/kit-chain-6', '/kit-restore-6').catch(() => {});
        for (const path of [kitFile, kit, storageCopy]) await rm(path, { recursive: true, force: true });
      }
    }

    // ---- Measured saving ---------------------------------------------------------------------------------------------------
    const rows = db.prepare('SELECT id,size FROM backups WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(createdBackups));
    const sizes = new Map(rows.map(row => [row.id, Number(row.size)]));
    const chains = points.map(point => ({ backupId: point.backup.id, kind: point.link.backup_kind, chainId: point.link.chain_id, position: point.link.chain_position }));
    const saving = incrementalSaving(rows, chains);
    const fullSize = sizes.get(points[0].backup.id), incrementSizes = points.filter(point => point.link.backup_kind === 'incremental').map(point => sizes.get(point.backup.id));
    const storedTotal = [...sizes.values()].reduce((sum, size) => sum + size, 0), fullEquivalent = fullSize * points.length;
    for (const size of incrementSizes) assert.ok(size < fullSize, 'An increment is smaller than the full package');
    assert.equal(saving.increments, incrementalCount);
    assert.ok(saving.bytesSaved > 0);
    const percent = Math.round((1 - storedTotal / fullEquivalent) * 100);
    evidence.incrementalSaving = { fullBytes: fullSize, incrementBytes: incrementSizes, storedBytes: storedTotal, fullEquivalentBytes: fullEquivalent, savedPercent: percent, reportBytesSaved: saving.bytesSaved };
    console.log(`MEASURED incremental saving: full ${mb(fullSize)}, increments ${incrementSizes.map(mb).join(', ')}; stored ${mb(storedTotal)} for 7 restore points vs ${mb(fullEquivalent)} as 7 full backups (${percent}% saved, mount data only: committed snapshot images are saved in every package)`);
    record(`Measured on the fixture: 7 restore points stored in ${mb(storedTotal)} instead of ${mb(fullEquivalent)} as 7 full backups (${percent}% saved; the storage report counts ${mb(saving.bytesSaved)} saved)`);

    // ---- Tampered package and missing link are refused before anything is sent -----------------------------------------
    const newest = points.at(-1);
    const readAll = async path => { const chunks = []; for await (const chunk of await openRead(path)) chunks.push(chunk); return Buffer.concat(chunks); };
    const put = async (path, data) => { await removeFile(path).catch(() => {}); const output = await openWrite(path); await new Promise((resolve, reject) => { output.once('error', reject); output.end(data, error => error ? reject(error) : resolve()); }); };
    // Tries to restore `target`; returns the refusal text and whether it came at planning time or from the job.
    const refused = async target => {
      try {
        const plan = await planRestore(target.backup.id, { serverId: servers[1].id });
        if (!plan.executable) return JSON.stringify(plan.blockers);
        const queued = await enqueueRestore(target.backup.id, plan, 'qa'), job = claimJob();
        assert.equal(job.id, queued.id);
        await executeJob(job);
        const row = db.prepare('SELECT status,error FROM jobs WHERE id=?').get(job.id);
        assert.notEqual(row.status, 'completed', 'A restore that reads a broken chain must not complete');
        return String(row.error);
      } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; return String(error.message); }
    };
    const containersBefore = await containersOnTarget(), directoriesBefore = await restoreDirectories();
    // The longest chain is points 0-4: restore point 4 while a package in the middle (point 2) is damaged or gone.
    const longest = points[4], middle = points[2].backup, middlePath = middle.path, middleBytes = await readAll(middlePath);
    const tampered = Buffer.from(middleBytes); tampered[tampered.length >> 1] ^= 1;
    await put(middlePath, tampered);
    const tamperMessage = await refused(longest);
    assert.match(tamperMessage, new RegExp('depends on backup ' + middle.id + ', which is missing or damaged'), 'Tampered package refused: ' + tamperMessage);
    assert.deepEqual(await containersOnTarget(), containersBefore, 'No container was created from a tampered chain');
    assert.equal(await restoreDirectories(), directoriesBefore, 'Nothing was sent to the target server for a tampered chain');
    await put(middlePath, middleBytes);
    await removeFile(middlePath);
    const missingMessage = await refused(longest);
    assert.match(missingMessage, new RegExp('depends on backup ' + middle.id + ', which is missing or damaged'), 'Missing link refused with the plain message: ' + missingMessage);
    assert.deepEqual(await containersOnTarget(), containersBefore, 'No container was created from a chain with a missing link');
    assert.equal(await restoreDirectories(), directoriesBefore, 'Nothing was sent to the target server for a chain with a missing link');
    await put(middlePath, middleBytes);
    assert.equal(await verifyEncrypted(middlePath), middle.checksum);
    record('A tampered package in the middle of the chain and a missing link are both refused before any package is sent to the target server (no container created, no staging folder); the plain "depends on backup X" message names the missing backup');
    await restoreAndCompare(longest, 4);
    record('After the damaged package is put back, the end of the longest chain restores again and equals the source');

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
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM backup_verification_history WHERE backup_id=? AND json_extract(evidence,'$.testId')=?").get(newest.backup.id, testId).n > 0, 'The restore test is recorded as evidence for the newest backup');
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
    await downgradeAttempt(points[1], 'downgrade-increment');
    record('The 2.11.1 helper refuses a version 2 package (a full package and an increment) with the plain message "Unsupported or incomplete backup" and restores nothing');

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
    const fromCopy = await restoreAndCompare(newest, points.length - 1);
    assert.equal(fromCopy.plan.source.role, 'copy', 'With every main package gone, the chain restores from the S3 copies');
    assert.equal(fromCopy.plan.source.targetId, copyTargetId);
    assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='restore.source_fallback' AND target=?").get(newest.backup.id), 'The fallback to the copy is audited');
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
    try { updateIncrementalSettings(siteId, { enabled: false }, 'qa'); } catch { failures.push('incremental setting'); }
    try { await stopS3(); } catch { failures.push('S3 fixture'); }
    if (failures.length) console.warn('Incremental scenario cleanup incomplete: ' + failures.join(', '));
  }
}
