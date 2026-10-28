import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Transform } from 'node:stream';

// Exact pre-M1 helper from this repository, preserved as gzip/base64 to make the
// Linux fixture independent of a checkout's Git history. It is fixture code, not
// the production helper. Never recreate a legacy package by stripping new fields.
export const legacyHelperRevision = '678e9ec89f4ac5f7ab4935b2ce809a356bc68f5f';
export const legacyHelperSha256 = 'ecdf1e62419f4624e42412e291f24314be92ccfa35965bf2e1967e178561dd49';
const legacyHelperGzip = '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';
export function legacyHelperSource() {
  const source = gunzipSync(Buffer.from(legacyHelperGzip, 'base64'));
  assert.equal(createHash('sha256').update(source).digest('hex'), legacyHelperSha256);
  return source;
}

async function historicalCapture(server, request) {
  const { connect } = await import('../src/ssh.js');
  const client = await connect(server);
  try {
    const encoded = legacyHelperSource().toString('base64');
    return await new Promise((resolve, reject) => {
      client.exec(`python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`, { pty: false }, (error, stream) => {
        if (error) return reject(new Error('Historical fixture helper could not start'));
        let buffer = '', result, failed = false;
        stream.on('data', chunk => {
          buffer += chunk.toString();
          if (buffer.length > 4 * 1024 * 1024) {
            stream.destroy();
            reject(new Error('Historical fixture helper output exceeds limit'));
            return;
          }
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            try {
              const event = JSON.parse(line);
              if (event.result) result = event.result;
              if (event.error) failed = true;
            } catch {}
          }
        });
        // Neither raw Docker inspect nor remote errors can enter fixture logs.
        stream.stderr.on('data', () => {});
        stream.once('error', () => reject(new Error('Historical fixture helper connection failed')));
        stream.once('close', code => code === 0 && result && !failed
          ? resolve(result) : reject(new Error('Historical fixture capture failed; inspect its isolated source')));
        stream.end(JSON.stringify(request) + '\n');
      });
    });
  } finally { client.end(); }
}

// Matches the manager metadata projection at legacyHelperRevision. Raw inspect
// records remain inside the encrypted historical payload, never in the database.
function historicalMetadata(manifest) {
  return {
    formatVersion: 1, kind: manifest.kind || 'docker', complete: manifest.complete,
    capturedAt: manifest.capturedAt, downtimeSeconds: manifest.downtimeSeconds,
    containerDowntimeSeconds: manifest.containerDowntimeSeconds,
    visitorDowntimeSeconds: manifest.visitorDowntimeSeconds,
    shutdownEvidence: manifest.shutdownEvidence,
    originalImages: manifest.originalImages.map(image => ({ id: image.Id, digests: image.RepoDigests || [] })),
    architecture: manifest.architecture, restoreTested: false,
    containers: manifest.containers.map(container => ({
      id: container.Id, name: container.Name, image: container.Config.Image,
      mounts: container.Mounts.map(mount => ({ type: mount.Type, destination: mount.Destination }))
    }))
  };
}

export async function runLegacyCompatibility({ run, until, hosts, servers, db, remote, evidence, record }) {
  const { encryptStream, verifyEncrypted, planRestore, enqueueRestore, claimJob, executeJob } = await import('../src/engine.js');
  const { download } = await import('../src/ssh.js');
  const { backupDirectory, storageJoin, makeDirectory, openWrite, statFile } = await import('../src/storage.js');
  const { backupVerification } = await import('../src/recovery-evidence.js');
  const source = hosts[0], target = hosts[1], name = 'qa-pre-m1-legacy';
  const siteId = randomUUID(), captureId = randomUUID(), backupId = randomUUID();
  const cfg = { containers: [name], stagingRoot: '/var/lib/docknest-legacy', exclusiveSourcesConfirmed: true,
    cleanShutdownConfirmed: true, shutdownProfile: 'generic', maintenance: { required: false } };
  await run('exec', source, 'docker', 'run', '-d', '--name', name, '--restart', 'no',
    '-v', name + '-data:/site', 'docknest-fixture:local');
  await until(async () => (await run('exec', source, 'docker', 'inspect', '--format', '{{.State.Health.Status}}', name)) === 'healthy', 'Historical source fixture health failed');
  const original = JSON.parse(await run('exec', source, 'docker', 'inspect', name))[0];
  const createdAt = new Date().toISOString();
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, servers[0].id, 'Pre-M1 historical fixture', JSON.stringify(cfg), createdAt);
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,'backup','running','copying',?,'{}')").run(captureId, siteId, createdAt);
  const captured = await historicalCapture(servers[0], { operation: 'capture', job: captureId, config: cfg });
  assert.equal(captured.manifest.formatVersion, 1);
  assert.equal(captured.manifest.complete, true);
  for (const field of ['backupPlan', 'artifacts', 'consistency']) assert.equal(Object.hasOwn(captured.manifest, field), false, 'Historical capture unexpectedly contains ' + field);
  const directory = backupDirectory(servers[0], { id: siteId, name: 'Pre-M1 historical fixture' });
  await makeDirectory(directory);
  const path = storageJoin(directory, 'payload.enc');
  const pass = new Transform({ transform(chunk, _encoding, callback) { callback(null, chunk); } });
  pass.on('error', () => {});
  const writing = encryptStream(pass, await openWrite(path));
  writing.catch(error => pass.destroy(error));
  try { await download(servers[0], captured.remotePath, pass); await writing; }
  catch (error) { pass.destroy(error); await writing.catch(() => {}); throw error; }
  const checksum = await verifyEncrypted(path), size = (await statFile(path)).size;
  assert.ok(path.startsWith('sftp:'), 'Historical package must use real remote SFTP storage');
  const metadata = JSON.stringify(historicalMetadata(captured.manifest));
  db.prepare('INSERT INTO backups(id,site_id,job_id,captured_at,path,size,checksum,manifest,pinned,verified,created_at) VALUES(?,?,?,?,?,?,?,?,0,1,?)')
    .run(backupId, siteId, captureId, new Date(captured.manifest.capturedAt * 1000).toISOString(), path, size, checksum, metadata, createdAt);
  db.prepare("UPDATE jobs SET status='completed',stage='completed',finished_at=? WHERE id=?").run(new Date().toISOString(), captureId);
  const oldRow = db.prepare('SELECT * FROM backups WHERE id=?').get(backupId);
  assert.equal(backupVerification(backupId).consistency.status, 'not-tested');
  assert.equal(backupVerification(backupId).application.status, 'not-tested');
  assert.deepEqual(backupVerification(backupId).integrity, { status: 'passed', source: 'legacy' }, 'Legacy verified packages read as integrity checked without new evidence rows');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backup_verifications WHERE backup_id=?').get(backupId).n, 0);
  await until(async () => {
    try { return Boolean((await remote(servers[0], { operation: 'cleanup', root: captured.root })).removed); }
    catch { return false; }
  }, 'Historical capture watchdog did not acknowledge disarm', 15);
  const change = "import sqlite3;from pathlib import Path;db=sqlite3.connect('/site/database.sqlite');db.execute(\"UPDATE records SET value='legacy-live-change'\");db.commit();Path('/site/asset.txt').write_text('legacy-live-asset');Path('/app/writable.txt').write_text('legacy-live-layer')";
  await run('exec', source, 'docker', 'exec', name, 'python', '-c', change);
  const planned = await planRestore(backupId, { serverId: servers[1].id });
  assert.equal(planned.executable, true, JSON.stringify(planned.blockers));
  const queued = await enqueueRestore(backupId, planned, 'qa');
  const restore = claimJob();
  assert.equal(restore.id, queued.id);
  await executeJob(restore);
  const completed = db.prepare('SELECT * FROM jobs WHERE id=?').get(restore.id);
  assert.equal(completed.status, 'completed', completed.error);
  const result = JSON.parse(completed.details).result;
  const validate = "import sqlite3,json,os;from pathlib import Path;print(json.dumps({'row':sqlite3.connect('/site/database.sqlite').execute('SELECT value FROM records').fetchone()[0],'asset':Path('/site/asset.txt').read_text(),'layer':Path('/app/writable.txt').read_text(),'mode':oct(os.stat('/site/asset.txt').st_mode&0o777),'uid':os.stat('/site/asset.txt').st_uid,'gid':os.stat('/site/asset.txt').st_gid,'symlink':os.readlink('/site/asset-link.txt'),'hardlink':os.stat('/site/asset.txt').st_ino==os.stat('/site/asset-hardlink.txt').st_ino}))";
  const recovered = JSON.parse(await run('exec', target, 'docker', 'exec', result.containerId, 'python', '-c', validate));
  assert.deepEqual(recovered, { row: 'snapshot-record', asset: 'snapshot-asset', layer: 'snapshot-layer', mode: '0o640', uid: 1234, gid: 2345, symlink: 'asset.txt', hardlink: true });
  const live = JSON.parse(await run('exec', source, 'docker', 'exec', name, 'python', '-c', validate));
  assert.equal(live.row, 'legacy-live-change');
  assert.equal(live.asset, 'legacy-live-asset');
  assert.equal(live.layer, 'legacy-live-layer');
  const originalAfter = JSON.parse(await run('exec', source, 'docker', 'inspect', name))[0];
  for (const field of ['Id', 'Image', 'Mounts', 'HostConfig']) assert.deepEqual(originalAfter[field], original[field], 'Historical restore changed original ' + field);
  assert.equal(originalAfter.State.Running, true);
  const copy = JSON.parse(await run('exec', target, 'docker', 'inspect', result.containerId))[0];
  assert.equal(copy.HostConfig.NetworkMode, 'none');
  assert.ok(!Object.values(copy.NetworkSettings.Ports || {}).some(Boolean));
  assert.ok(copy.Mounts.every(mount => !original.Mounts.some(old => old.Source === mount.Source)));
  assert.equal(result.verification.isolatedRestore.status, 'passed');
  assert.equal(result.verification.isolatedRestore.artifactsVerified, false);
  assert.equal(result.restoreTested, false);
  assert.equal(result.verification.application.status, 'not-tested');
  assert.equal(backupVerification(backupId).integrity.status, 'passed');
  assert.equal(backupVerification(backupId).isolatedRestore.status, 'passed');
  assert.equal(backupVerification(backupId).consistency.status, 'not-tested');
  assert.equal(backupVerification(backupId).application.status, 'not-tested');
  assert.deepEqual(db.prepare('SELECT * FROM backups WHERE id=?').get(backupId), oldRow, 'Restoring a legacy package must preserve its original metadata');
  assert.equal(await verifyEncrypted(path), checksum, 'Historical encrypted payload changed during restore');
  evidence.legacyCompatibility = { helperRevision: legacyHelperRevision, helperSha256: legacyHelperSha256,
    formatVersion: 1, historicalCapture: true, originalMetadataPreserved: true,
    checks: ['real SQLite rows', 'mounted asset ownership, permissions and links', 'committed writable layer',
      'source live changes preserved', 'network-none copy', 'old metadata unchanged', 'no invented artifact or consistency evidence'],
    automaticApplicationStatus: 'not-tested' };
  record('Pre-M1 historical helper creates a real format-v1 backup; current authenticated SFTP restore recovers original SQLite data and metadata without changing the live source or inventing legacy evidence');
  await run('exec', target, 'docker', 'rm', '-f', ...result.containerIds);
  await run('exec', source, 'docker', 'rm', '-f', name);
}
