// Backup copies and upgrades (docs/backup-copies.md, "Data model"): a 2.10.1 database with backups migrates with
// nothing changed and no copies, 2.10 code keeps running on the new schema (downgrade), copies an older release left
// behind are cleaned up, and storage migration leaves copies alone. Main copy on a synthetic SFTP server, copies on a
// synthetic S3 bucket.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { startSftpFixture } from './sftp-fixture.js';
import { startS3Fixture } from './s3-fixture.js';

const root = await mkdtemp(join(tmpdir(), 'docknest-copies-upgrade-'));
Object.assign(process.env, { DATA_DIR: root, MASTER_KEY_FILE: join(root, 'master.key'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { db } = await import('../src/db.js'), { seal } = await import('../src/crypto.js');
const { migrate, migrations, schemaVersion, compatFloor } = await import('../src/migrations.js');
const storage = await import('../src/storage.js');
const siteStorage = await import('../src/site-storage.js');
const copies = await import('../src/backup-copies.js');
const journal = await import('../src/artifact-journal.js');
const { migrateStorage } = await import('../src/storage-migration.js');
const engine = await import('../src/engine.js');
const sftp = await startSftpFixture(), bucket = await startS3Fixture({ bucket: 'docknest-copies' });
after(async () => { await sftp.close(); await bucket.close(); db.close(); await rm(root, { recursive: true, force: true }); });
const at = '2026-10-03T12:13:14.000Z', quiet = () => {};
const schema = database => database.prepare('SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all().map(row => ({ ...row }));
const rowsOf = (database, table) => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }));

// ---- Live database: SFTP main destination (the default), S3 copy destination --------------------------------------------
const main = 'storage', copyTarget = randomUUID();
db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(main, 'Offsite SFTP', sftp.options.host, sftp.options.port, sftp.options.username, sftp.options.hostKey, 'password', seal(sftp.options.password), '/backups', 1e12, 'connected', at, at);
{
  const url = new URL(bucket.options.endpoint);
  db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(copyTarget, 'Cloudflare R2', url.hostname, Number(url.port), bucket.options.bucket, '', 's3-access-key', seal(JSON.stringify(bucket.credentials)), '/docknest', 0, 'connected', at, at);
  db.prepare("INSERT INTO storage_target_settings VALUES(?,'s3',?)").run(copyTarget, JSON.stringify({ endpoint: bucket.options.endpoint, region: bucket.options.region, bucket: bucket.options.bucket, pathStyle: true, objectLock: null }));
}
db.prepare("INSERT INTO settings VALUES('backup_storage_target',?)").run(main);
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run('server', 'Production', 'localhost', 22, 'fixture', 'synthetic', '0'.repeat(64), at);
db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run('site', 'server', 'Shop', '{}', at);
db.prepare("INSERT INTO policies VALUES('site',0,'0 2 * * *','UTC',7,NULL)").run();
await storage.makeDirectory('sftp:storage:/backups/old');
async function encrypted() { const chunks = []; const sink = new (await import('node:stream')).Writable({ write(chunk, _e, cb) { chunks.push(chunk); cb(); } }); await engine.encryptStream(Readable.from([randomBytes(4000)]), sink); return Buffer.concat(chunks); }
// A backup published by an older release under the pre-2.4 folder layout, so storage migration has work to do.
async function legacyBackup(backupId) {
  const bytes = await encrypted(), source = '/backups/old/' + backupId + '.enc';
  sftp.files.set(source, bytes);
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,'site','backup','completed','completed',?)").run(backupId, at);
  db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(backupId, 'site', backupId, at, 'sftp:storage:' + source, bytes.length, createHash('sha256').update(bytes).digest('hex'), '{}', 0, 1, at);
  return { bytes, path: 'sftp:storage:' + source };
}

test('migration 11 is one compatible line, adds only its own tables, and the floor stays 1', () => {
  const entry = migrations.find(item => item.version === 11);
  assert.equal(entry.name, 'backup-copies'); assert.equal(entry.compatible, true);
  assert.ok(schemaVersion >= 11, 'later migrations follow 11'); assert.equal(compatFloor(migrations), 1);
});

test('a 2.10.1 database with backups: nothing changes, no copies, and the default destination stays the default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'docknest-v10-')), file = join(directory, 'state.sqlite'), old = new DatabaseSync(file);
  try {
    old.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;');
    migrate(old, { file, list: migrations.slice(0, 10), log: quiet });
    old.exec(`INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('srv','Production','192.0.2.1',22,'root','sealed','${'0'.repeat(64)}','${at}');
      INSERT INTO sites VALUES('site','srv','Shop','{}','${at}');
      INSERT INTO policies VALUES('site',1,'0 2 * * *','UTC',7,NULL);
      INSERT INTO storage_targets VALUES('target','Offsite','198.51.100.4',23,'u','${'a'.repeat(64)}','password','c2VhbGVk','/home/u',1000,'connected','${at}',NULL);
      INSERT INTO settings VALUES('backup_storage_target','target');
      INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES('job','site','backup','completed','completed','${at}');
      INSERT INTO backups VALUES('backup','site','job','${at}','sftp:target:/home/u/BACKUP/x.enc',100,'${'b'.repeat(64)}','{}',1,1,'${at}');`);
    const before = schema(old), tables = before.filter(row => row.type === 'table').map(row => row.name), contents = Object.fromEntries(tables.map(name => [name, rowsOf(old, name).filter(row => name !== 'settings' || row.key !== 'schema_compat_floor')]));
    const result = migrate(old, { file, list: migrations.slice(0, 11), now: () => new Date('2026-10-28T08:00:00.000Z'), log: quiet });
    assert.deepEqual([result.from, result.to], [10, 11]); assert.match(result.snapshot, /state-v10-to-v11-/);
    for (const row of before) assert.deepEqual(schema(old).find(item => item.name === row.name), row, 'existing objects keep their definition');
    assert.deepEqual(Object.fromEntries(tables.map(name => [name, rowsOf(old, name).filter(row => name !== 'settings' || row.key !== 'schema_compat_floor')])), contents, 'no row of an existing table changes');
    for (const table of ['site_storage', 'site_storage_copies', 'backup_copies', 'backup_main_removed', 'manager_backup_copies']) assert.equal(rowsOf(old, table).length, 0, table + ' starts empty');
    assert.equal(old.prepare("SELECT value FROM settings WHERE key='schema_compat_floor'").get().value, '1');
    assert.equal(old.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(migrate(old, { file, list: migrations.slice(0, 11), log: quiet }), { from: 11, to: 11, snapshot: null }, 'a restart is a no-op');
  } finally { old.close(); await rm(directory, { recursive: true, force: true }); }
});

test('downgrade: 2.10 code starts on the new schema and its retention can still delete a backup that has copies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'docknest-downgrade-')), file = join(directory, 'state.sqlite'), database = new DatabaseSync(file);
  try {
    database.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;');
    migrate(database, { file, list: migrations.slice(0, 11), log: quiet });
    database.exec(`INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('srv','P','h',22,'root','k','${'0'.repeat(64)}','${at}');
      INSERT INTO sites VALUES('site','srv','Shop','{}','${at}');
      INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES('job','site','backup','completed','completed','${at}');
      INSERT INTO backups VALUES('backup','site','job','${at}','sftp:t:/x.enc',10,'${'c'.repeat(64)}','{}',0,1,'${at}');
      INSERT INTO site_storage VALUES('site','t2','${at}');
      INSERT INTO site_storage_copies VALUES('site','t3',30,'${at}');
      INSERT INTO backup_copies(backup_id,target_id,path,status,attempts,created_at,updated_at) VALUES('backup','t3','s3:t3:/x.enc','verified',0,'${at}','${at}');`);
    const messages = [];
    assert.deepEqual(migrate(database, { file, list: migrations.slice(0, 10), log: message => messages.push(message) }), { from: 11, to: 11, snapshot: null });
    assert.match(messages[0], /only adds compatible objects/);
    // The exact statements 2.10 retention and publication run: no foreign key on the new tables blocks or cascades.
    database.prepare("INSERT INTO retention_operations VALUES('backup','pending',?)").run(at);
    database.prepare('DELETE FROM downloads WHERE backup_id=? AND expires_at<=?').run('backup', Date.now());
    database.prepare('DELETE FROM backups WHERE id=?').run('backup');
    assert.equal(rowsOf(database, 'backup_copies').length, 1, 'the copy row stays for the newer release to clean up');
    database.prepare('INSERT INTO backups(id,site_id,job_id,captured_at,path,size,checksum,manifest,pinned,verified,created_at) VALUES(?,?,?,?,?,?,?,?,0,1,?)').run('next', 'site', 'job', at, 'sftp:t:/y.enc', 10, 'd'.repeat(64), '{}', at);
    assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});

test('existing backups after the upgrade: the default destination, an empty copy list, and copies only once configured', async () => {
  const { path } = await legacyBackup('before-upgrade');
  assert.equal(siteStorage.siteMainStorage('site').id, main);
  const view = copies.backupCopyViews([{ id: 'before-upgrade', path }]).get('before-upgrade');
  assert.deepEqual(view, { mainTarget: { id: main, name: 'Offsite SFTP', mode: 'sftp' }, copies: [] });
  assert.equal(siteStorage.copyMissing('site'), false);
  assert.equal(journal.claimCopy(), null, 'nothing is copied retroactively');
});

test('SFTP main and S3 copy; storage migration moves the main copy and leaves the copy alone, and waits for a copy step', async () => {
  siteStorage.updateSiteStorage('site', { mainTargetId: null, copies: [{ targetId: copyTarget, retention: null }] }, 'test');
  const { bytes, path } = await legacyBackup('legacy');
  // Copies are scheduled at publication; an older backup gets one when the owner asks (here: directly in the journal).
  db.prepare("INSERT INTO backup_copies(backup_id,target_id,path,status,attempts,created_at,updated_at) VALUES('legacy',?,?,'pending',0,?,?)").run(copyTarget, siteStorage.copyPathFor(copyTarget, { id: 'server', name: 'Production' }, { id: 'site', name: 'Shop' }, path), at, at);
  const claimed = journal.claimCopy();
  assert.equal(claimed.backup_id, 'legacy');
  db.prepare("INSERT INTO settings VALUES('deployment_hold','true') ON CONFLICT(key) DO UPDATE SET value='true'").run();
  try {
    await assert.rejects(migrateStorage(), /Active operations block migration/, 'a copy step in progress blocks storage migration');
    assert.equal((await copies.executeCopy(claimed, engine.verifyEncrypted)).status, 'verified');
    const copy = db.prepare("SELECT * FROM backup_copies WHERE backup_id='legacy'").get();
    assert.deepEqual(Buffer.from(bucket.objects.get(copy.path.replace(/^s3:[^:]+:\//, '')).body), bytes, 'the SFTP package, byte for byte, in the bucket');
    const result = await migrateStorage();
    assert.ok(result.migrated >= 1);
    const moved = db.prepare("SELECT path FROM backups WHERE id='legacy'").get().path;
    assert.notEqual(moved, path); assert.match(moved, /^sftp:storage:\/backups\/BACKUP\/production--server\/shop--site\//);
    const after = db.prepare("SELECT * FROM backup_copies WHERE backup_id='legacy'").get();
    assert.deepEqual({ ...after }, { ...copy }, 'the copy row is untouched');
    assert.ok(await storage.statFile(after.path), 'and so is its file');
    assert.deepEqual(engine.restoreSources(db.prepare("SELECT * FROM backups WHERE id='legacy'").get()).map(source => [source.role, source.status]), [['main', 'verified'], ['copy', 'verified']]);
  } finally { db.prepare("DELETE FROM settings WHERE key='deployment_hold'").run(); }
});

test('copies an older release left behind (its retention removed the backup) are deleted on the next maintenance', async () => {
  const orphanPath = 's3:' + copyTarget + ':/docknest/BACKUP/orphan.enc';
  await pipeline(Readable.from([randomBytes(64)]), await storage.openWrite(orphanPath));
  db.prepare("INSERT INTO backup_copies(backup_id,target_id,path,status,attempts,created_at,updated_at) VALUES('gone',?,?,'verified',0,?,?)").run(copyTarget, orphanPath, at, at);
  const result = await copies.maintainCopies();
  assert.ok(result.deleted >= 1);
  assert.equal(db.prepare("SELECT status FROM backup_copies WHERE backup_id='gone'").get().status, 'deleted');
  await assert.rejects(storage.statFile(orphanPath));
});

test('the recovery kit goes to every destination that holds copies', async () => {
  const { kitCopyDestinations } = await import('../src/self-backup.js');
  assert.deepEqual(kitCopyDestinations(main), [copyTarget]);
  assert.deepEqual(kitCopyDestinations(copyTarget), [], 'never twice to the kit\'s own destination');
});

test('a backup living only on its copy: storage migration skips its gone main package; retention and restore still use the copy', async () => {
  const { bytes, path } = await legacyBackup('copyonly');
  const copyPath = siteStorage.copyPathFor(copyTarget, { id: 'server', name: 'Production' }, { id: 'site', name: 'Shop' }, path);
  await pipeline(Readable.from([bytes]), await storage.openWrite(copyPath));
  db.prepare("INSERT INTO backup_copies(backup_id,target_id,path,status,attempts,verified_at,created_at,updated_at) VALUES('copyonly',?,?,'verified',0,?,?,?)").run(copyTarget, copyPath, at, at, at);
  db.prepare("INSERT INTO backup_main_removed VALUES('copyonly',?,?)").run(path, at);
  sftp.files.delete(path.slice('sftp:storage:'.length));
  db.prepare("INSERT INTO settings VALUES('deployment_hold','true') ON CONFLICT(key) DO UPDATE SET value='true'").run();
  try { await migrateStorage(); } finally { db.prepare("DELETE FROM settings WHERE key='deployment_hold'").run(); }
  assert.equal(db.prepare("SELECT path FROM backups WHERE id='copyonly'").get().path, path, 'the main path is kept, not moved');
  assert.equal(db.prepare("SELECT path FROM backup_copies WHERE backup_id='copyonly'").get().path, copyPath);
  await engine.retain('site');
  assert.ok(db.prepare("SELECT 1 FROM backups WHERE id='copyonly'").get(), 'kept by the copy destination count');
  const saved = engine.transport.uploadStream, received = [];
  engine.transport.uploadStream = async (_server, stream) => { for await (const chunk of stream) received.push(chunk); };
  try { assert.equal((await engine.uploadBackupTo({ id: 'server' }, 'copyonly', randomUUID(), { prepare: async () => ({ remotePath: '/tmp/x' }) })).source.role, 'copy'); }
  finally { engine.transport.uploadStream = saved; }
  assert.ok(received.length);
});

test('recovery kit copies are pruned per destination, only once a newer kit was written there', async () => {
  const { pruneKitCopies } = await import('../src/self-backup.js');
  const kit = (target, root, run) => `${target === main ? 'sftp' : 's3'}:${target}:${root}/BACKUP/docknest-recovery/docknest_${'a'.repeat(16)}_2026-10-28_00-00-0${run}Z--${randomUUID()}.dkit`;
  const rows = [[copyTarget, '/docknest', 1], [main, '/backups', 1], [copyTarget, '/docknest', 2]].map(([target, root, run]) => ({ target, file: kit(target, root, run), run: randomUUID() }));
  await storage.makeDirectory('sftp:storage:/backups/BACKUP/docknest-recovery');
  for (const row of rows) { await pipeline(Readable.from([randomBytes(64)]), await storage.openWrite(row.file)); db.prepare('INSERT INTO manager_backup_copies VALUES(?,?,?,?)').run(row.run, row.target, row.file, at); }
  // Run 2's upload to the SFTP destination failed (no row): its run-1 kit stays.
  await pruneKitCopies();
  await assert.rejects(storage.statFile(rows[0].file), 'the older kit on the bucket is removed');
  assert.ok(await storage.statFile(rows[1].file)); assert.ok(await storage.statFile(rows[2].file));
  assert.deepEqual(db.prepare('SELECT target_id FROM manager_backup_copies ORDER BY rowid').all().map(row => row.target_id), [main, copyTarget]);
});
