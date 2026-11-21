// Append-only SFTP destinations (docs/storage-backends.md, "Append-only SFTP"): write-mode detection with probe files,
// read-only publication, retention and copy retention that keep instead of delete, a normal destination that starts
// refusing deletes, a new test releasing what was kept, and the API. The server is the synthetic SFTP fixture with
// OpenSSH-style PERMISSION_DENIED answers (tests/sftp-fixture.js). Real OpenSSH -P accounts, backup, retention and restore
// are validated by the Linux integration suite (scripts/integration-append-only.js).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { startSftpFixture } from './sftp-fixture.js';

const root = await mkdtemp(join(tmpdir(), 'docknest-append-only-'));
Object.assign(process.env, { DATA_DIR: root, BACKUP_DIR: join(root, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(root, 'master.key'), SETUP_TOKEN_FILE: join(root, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { seal, digest } = await import('../src/crypto.js');
const engine = await import('../src/engine.js');
const journal = await import('../src/artifact-journal.js');
const copies = await import('../src/backup-copies.js');
const siteStorage = await import('../src/site-storage.js');
const storage = await import('../src/storage.js');
const writeModes = await import('../src/storage/write-mode.js');
const selfBackup = await import('../src/self-backup.js');
const report = await import('../src/storage-report.js');
const { backupFilename, backupRoot } = await import('../src/backup-layout.js');
const fixture = await startSftpFixture();
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
after(async () => { listener.close(); await fixture.close(); db.close(); await rm(root, { recursive: true, force: true }); });
copies.copyHooks.capacity = async () => ({ unbounded: true });

const stamp = () => new Date().toISOString();
const appendOnly = () => Object.assign(fixture.denied, { remove: true, setstat: true, reopen: true, rename: false, posixRename: true });
const normal = () => Object.assign(fixture.denied, { remove: false, setstat: false, reopen: false, rename: false, posixRename: false });
const removals = () => fixture.events.filter(event => event.operation === 'remove');
const filesUnder = prefix => [...fixture.files.keys()].filter(file => file.startsWith(prefix));
let rootCount = 0;
function sftpTarget(name = 'Storage Box') {
  const targetId = randomUUID(), folder = '/store' + (++rootCount);
  db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(targetId, name, fixture.options.host, fixture.options.port, fixture.options.username, fixture.options.hostKey, 'password', seal(fixture.options.password), folder, 1e12, 'connected', stamp(), stamp());
  return { targetId, folder };
}
function site(name, retention = 1) {
  const serverId = randomUUID(), siteId = randomUUID();
  db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(serverId, 'Server ' + name, '192.0.2.10', 22, 'root', 'fixture', '0'.repeat(64), stamp());
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, serverId, name, '{}', stamp());
  db.prepare("INSERT INTO policies VALUES(?,0,'0 2 * * *','UTC',?,NULL)").run(siteId, retention);
  return siteId;
}
// Publishes a backup exactly like the engine: to the site's main destination, through the publication journal.
async function publish(siteId, capturedAt) {
  const backupId = randomUUID(), jobId = randomUUID(), siteRow = db.prepare('SELECT * FROM sites WHERE id=?').get(siteId), server = db.prepare('SELECT id,name FROM servers WHERE id=?').get(siteRow.server_id);
  const directory = storage.backupDirectory(server, { id: siteId, name: siteRow.name }, siteStorage.siteMainStorage(siteId));
  await storage.makeDirectory(directory);
  const published = storage.storageJoin(directory, backupFilename(backupId, new Date(capturedAt))), temporary = published + '.partial';
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','running','verifying',?)").run(jobId, siteId, capturedAt);
  await engine.encryptStream(Readable.from([randomBytes(3000)]), await storage.openWrite(temporary)); await storage.syncFile(temporary);
  journal.preparePublication({ backupId, jobId, siteId, temporary, published, manifest: { consistency: { status: 'declared' } }, capturedAt });
  journal.authenticatePublication(backupId, await engine.verifyEncrypted(temporary), (await storage.statFile(temporary)).size);
  await storage.renameFile(temporary, published);
  journal.finalizePublication(backupId);
  return backupId;
}
const day = n => new Date(Date.parse('2026-10-01T02:00:00Z') + n * 86400000).toISOString();
const remoteOf = file => file.slice(file.indexOf(':/') + 1);
const deferral = backupId => db.prepare('SELECT * FROM retention_deferrals WHERE backup_id=?').get(backupId);
const audits = (action, target) => db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE action=? AND target=?').get(action, target).n;
function session() {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId, userId + '@example.invalid', 'fixture', 'fixture', '[]', stamp(), 'admin', 'admin');
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), userId, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), Date.now());
  return async (method, route, body) => { const response = await fetch(base + route, { method, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, 'x-csrf-token': 'csrf', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json().catch(() => null) }; };
}
const connection = folder => ({ host: fixture.options.host, port: fixture.options.port, username: fixture.options.username, password: fixture.options.password, hostKey: fixture.options.hostKey, root: folder });

test('detection: a normal destination deletes its probe files and leaves everything else alone', async () => {
  normal();
  const folder = '/detect-normal';
  fixture.files.set(folder + '/existing-package.enc', Buffer.from('kept as is'));
  fixture.events.length = 0;
  const result = await storage.testStorageTarget(connection(folder));
  assert.equal(result.writeMode, 'normal'); assert.equal(result.renameVerified, true); assert.equal(result.probeLeftovers, undefined);
  assert.deepEqual(filesUnder(folder + '/.docknest-probe/'), []);
  assert.equal(fixture.files.get(folder + '/existing-package.enc').toString(), 'kept as is');
  assert.ok(fixture.events.every(event => ![event.file, event.from, event.to].includes(folder + '/existing-package.enc')), 'the probe touches only its own files');
});

test('detection: refused delete and refused changes is append-only; probe files are reported, not retried', async () => {
  appendOnly();
  const folder = '/detect-append';
  fixture.files.set(folder + '/existing-package.enc', Buffer.from('kept as is'));
  fixture.events.length = 0;
  const result = await storage.testStorageTarget(connection(folder));
  assert.equal(result.writeMode, 'append-only'); assert.equal(result.deleteRefused, true); assert.equal(result.overwriteRefused, true);
  assert.equal(result.probeLeftovers.length, 2);
  assert.ok(result.probeLeftovers.every(file => file.startsWith(folder + '/.docknest-probe/')));
  assert.deepEqual(filesUnder(folder + '/.docknest-probe/').sort(), [...result.probeLeftovers].sort());
  for (const file of result.probeLeftovers) assert.equal(fixture.modes.get(file.replace(/\.verified$/, '')) ?? fixture.modes.get(file), 0o400, 'probe files are created read-only');
  assert.equal(fixture.files.get(folder + '/existing-package.enc').toString(), 'kept as is');
  normal();
});

test('detection: refused deletes but allowed permission changes, reopen or posix-rename is refused as broken', async () => {
  Object.assign(fixture.denied, { remove: true, setstat: false, reopen: true, rename: false, posixRename: true });
  await assert.rejects(storage.testStorageTarget(connection('/detect-broken-1')), error => /not safely append-only/.test(error.message) && /permission changes/.test(error.message) && error.status === 400 && error.probeLeftovers.length === 2);
  Object.assign(fixture.denied, { remove: true, setstat: true, reopen: false, posixRename: true });
  await assert.rejects(storage.testStorageTarget(connection('/detect-broken-2')), error => /open for writing/.test(error.message));
  Object.assign(fixture.denied, { remove: true, setstat: true, reopen: true, posixRename: false }); fixture.features.posixRename = true;
  try { await assert.rejects(storage.testStorageTarget(connection('/detect-broken-3')), error => /posix-rename over a file/.test(error.message)); }
  finally { fixture.features.posixRename = false; normal(); }
});

test('detection: a refused rename, or a delete that merely fails, never reads as append-only', async () => {
  normal(); fixture.denied.rename = true;
  await assert.rejects(storage.testStorageTarget(connection('/detect-rename')), error => /refuses to rename/.test(error.message) && !error.probeLeftovers);
  assert.deepEqual(filesUnder('/detect-rename/.docknest-probe/'), [], 'one removal attempt cleans up a test that stopped');
  normal(); fixture.faults.remove = true;
  try { await assert.rejects(storage.testStorageTarget(connection('/detect-fault')), error => !/append-only/.test(error.message) && error.probeLeftovers?.length >= 1); }
  finally { fixture.faults.remove = false; }
});

test('upgrade: a destination saved before write modes is normal and writes 0600 files as before', async () => {
  normal();
  const { targetId, folder } = sftpTarget('Older destination');
  const options = storage.targetOptions(targetId);
  assert.equal(options.writeMode, 'normal'); assert.equal(options.keepsFiles, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM storage_target_settings WHERE target_id=?').get(targetId).n, 0, 'nothing is written for it');
  const file = `sftp:${targetId}:${folder}/sub/plain.enc`;
  await storage.makeDirectory(`sftp:${targetId}:${folder}/sub`);
  await new Promise((resolve, reject) => storage.openWrite(file).then(output => { output.once('error', reject).once('close', resolve); output.end(Buffer.from('x')); }, reject));
  assert.equal(fixture.modes.get(folder + '/sub/plain.enc'), 0o600);
  await storage.removeFile(file); assert.equal(fixture.files.has(folder + '/sub/plain.enc'), false);
});

test('append-only destination: files are created read-only and deletes never reach the server', async () => {
  appendOnly();
  const { targetId, folder } = sftpTarget('Vault');
  writeModes.recordWriteMode(targetId, 'append-only', 'test');
  await storage.makeDirectory(`sftp:${targetId}:${folder}/sub`);
  const file = `sftp:${targetId}:${folder}/sub/package.enc`;
  await new Promise((resolve, reject) => storage.openWrite(file + '.partial').then(output => { output.once('error', reject).once('close', resolve); output.end(Buffer.from('data')); }, reject));
  assert.equal(fixture.modes.get(folder + '/sub/package.enc.partial'), 0o400);
  await storage.syncFile(file + '.partial'); await storage.renameFile(file + '.partial', file);
  assert.equal(storage.storageKeepsFiles(file), true);
  fixture.events.length = 0;
  await assert.rejects(storage.removeFile(file), error => storage.keptByStorage(error));
  await assert.rejects(storage.removeFile(file + '.missing'), error => error.code === 2, 'a missing file still reads as missing');
  assert.deepEqual(removals(), [], 'no delete request was sent');
  // A kept .partial is listed once as a leftover.
  fixture.files.set(folder + '/sub/stale.partial', Buffer.from('half'));
  for (let i = 0; i < 2; i++) await assert.rejects(storage.removeFile(`sftp:${targetId}:${folder}/sub/stale.partial`), error => storage.keptByStorage(error));
  assert.deepEqual(writeModes.leftovers(targetId).map(item => item.path), [`sftp:${targetId}:${folder}/sub/stale.partial`]);
  await assert.rejects(storage.removeDirectory(`sftp:${targetId}:${folder}/sub`), error => storage.keptByStorage(error));
  normal();
});

test('retention: an append-only main destination keeps aged-out backups, usable and counted, without retrying', async () => {
  appendOnly();
  const { targetId } = sftpTarget('Main vault');
  writeModes.recordWriteMode(targetId, 'append-only', 'test');
  const siteId = site('Vaulted app');
  siteStorage.updateSiteStorage(siteId, { mainTargetId: targetId, copies: [] }, 'test');
  const first = await publish(siteId, day(1)), second = await publish(siteId, day(2));
  const before = (await storage.storageCapacity({ options: storage.targetOptions(targetId) })).managedBytes;
  fixture.events.length = 0;
  await engine.retain(siteId);
  assert.ok(db.prepare('SELECT 1 FROM backups WHERE id=?').get(first), 'the aged-out backup stays listed');
  assert.equal(deferral(first).retry_after, storage.KEPT_UNTIL_RETEST);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM retention_operations WHERE backup_id=?').get(first).n, 0);
  assert.equal(audits('retention.kept_by_storage', first), 1);
  assert.deepEqual(removals(), []);
  assert.equal((await storage.storageCapacity({ options: storage.targetOptions(targetId) })).managedBytes, before, 'nothing is reported as freed');
  assert.equal(writeModes.keptSummary(targetId, `sftp:${targetId}:`).backups, 1);
  // Again: skipped at once, nothing new is audited or sent; reconciliation does not pick it up either.
  await engine.retain(siteId);
  const reconciled = await journal.reconcileArtifacts(engine.verifyEncrypted);
  assert.equal(reconciled.deleted, 0); assert.equal(audits('retention.kept_by_storage', first), 1); assert.deepEqual(removals(), []);
  // Still restorable: the package reads and authenticates.
  const row = db.prepare('SELECT * FROM backups WHERE id=?').get(first);
  assert.equal(await engine.verifyEncrypted(row.path), row.checksum);
  assert.ok(db.prepare('SELECT 1 FROM backups WHERE id=?').get(second));
  // The storage report shows it apart.
  const built = (await report.storageReport()).storages.find(entry => entry.id === targetId);
  assert.equal(built.keptByStorageCount, 1); assert.equal(built.keptByStorageBytes, row.size);

  // A new test that finds the destination normal again releases it; the next retention deletes it.
  normal();
  const api = session();
  const tested = await api('POST', `/storage-targets/${targetId}/test`, {});
  assert.equal(tested.status, 200, JSON.stringify(tested.body)); assert.equal(tested.body.writeMode, 'normal');
  assert.equal(deferral(first), undefined);
  assert.equal(audits('storage.kept_released', targetId), 1);
  await engine.retain(siteId);
  assert.equal(db.prepare('SELECT 1 FROM backups WHERE id=?').get(first), undefined);
  assert.equal(fixture.files.has(remoteOf(row.path)), false, 'the released package is deleted');
});

test('copies: an append-only copy destination keeps aged-out copies; deleting its copies is refused', async () => {
  appendOnly();
  const { targetId } = sftpTarget('Copy vault');
  writeModes.recordWriteMode(targetId, 'append-only', 'test');
  const siteId = site('Copied app', 1);
  siteStorage.updateSiteStorage(siteId, { mainTargetId: null, copies: [{ targetId, retention: 1 }] }, 'test');
  const first = await publish(siteId, day(3));
  for (let copy; (copy = journal.claimCopy());) await copies.executeCopy(copy, engine.verifyEncrypted);
  const firstCopy = db.prepare('SELECT * FROM backup_copies WHERE backup_id=? AND target_id=?').get(first, targetId);
  assert.equal(firstCopy.status, 'verified'); assert.equal(fixture.modes.get(remoteOf(firstCopy.path) + '.partial'), 0o400);
  const second = await publish(siteId, day(4));
  fixture.events.length = 0;
  for (let copy; (copy = journal.claimCopy());) await copies.executeCopy(copy, engine.verifyEncrypted);
  const kept = db.prepare('SELECT * FROM backup_copies WHERE backup_id=? AND target_id=?').get(first, targetId);
  assert.equal(kept.status, 'verified'); assert.equal(kept.delete_state, 'deferred'); assert.equal(kept.delete_after, storage.KEPT_UNTIL_RETEST);
  assert.equal(audits('backup.copy_kept_by_storage', first), 1);
  assert.equal(db.prepare('SELECT status FROM backup_copies WHERE backup_id=? AND target_id=?').get(second, targetId).status, 'verified');
  const maintained = await copies.maintainCopies(Date.now(), engine.verifyEncrypted);
  assert.equal(maintained.deleted, 0); assert.deepEqual(removals(), []);
  assert.throws(() => copies.requestDestinationCopyDeletion(targetId, {}, 'test'), error => error.code === 'kept_by_storage' && error.status === 409);
  normal();
});

test('copies: a .partial the storage keeps from an earlier attempt is written beside, not over', async () => {
  appendOnly();
  const { targetId } = sftpTarget('Copy vault 2');
  writeModes.recordWriteMode(targetId, 'append-only', 'test');
  const siteId = site('Retried copy', 7);
  siteStorage.updateSiteStorage(siteId, { mainTargetId: null, copies: [{ targetId, retention: null }] }, 'test');
  const backupId = await publish(siteId, day(5));
  const row = db.prepare('SELECT * FROM backup_copies WHERE backup_id=? AND target_id=?').get(backupId, targetId);
  const remote = remoteOf(row.path);
  await storage.makeDirectory(row.path.slice(0, row.path.lastIndexOf('/')));
  fixture.files.set(remote + '.partial', Buffer.from('an interrupted attempt'));
  for (let copy; (copy = journal.claimCopy());) assert.equal((await copies.executeCopy(copy, engine.verifyEncrypted)).status, 'verified');
  assert.equal(fixture.files.get(remote + '.partial').toString(), 'an interrupted attempt', 'the kept .partial is never overwritten');
  assert.ok(writeModes.leftovers(targetId).some(item => item.path === row.path + '.partial'));
  assert.equal(await engine.verifyEncrypted(row.path), db.prepare('SELECT checksum FROM backups WHERE id=?').get(backupId).checksum);
  normal();
});

test('a normal destination that starts refusing deletes is marked for a new test and keeps everything until then', async () => {
  normal();
  const { targetId } = sftpTarget('Changed box');
  const siteId = site('Changed app');
  siteStorage.updateSiteStorage(siteId, { mainTargetId: targetId, copies: [] }, 'test');
  const first = await publish(siteId, day(6)); await publish(siteId, day(7));
  fixture.denied.remove = true; fixture.events.length = 0;
  await engine.retain(siteId);
  assert.equal(deferral(first).retry_after, storage.KEPT_UNTIL_RETEST, 'kept, never reported as deleted');
  assert.equal(storage.targetOptions(targetId).keepsFiles, true);
  assert.equal(audits('storage.delete_refused', targetId), 1);
  const api = session();
  const listed = (await api('GET', '/storage-targets')).body.targets.find(target => target.id === targetId);
  assert.equal(listed.writeMode, 'normal'); assert.ok(listed.deletesRefusedAt);
  // No further delete is sent; a new test that finds it append-only records that and clears the warning.
  await engine.retain(siteId); assert.equal(fixture.events.filter(event => event.operation === 'remove').length, 0);
  appendOnly();
  const tested = await api('POST', `/storage-targets/${targetId}/test`, {});
  assert.equal(tested.status, 200); assert.equal(tested.body.writeMode, 'append-only'); assert.equal(tested.body.probeLeftovers, 2, 'the answer counts kept probe files, never names them');
  const after = (await api('GET', '/storage-targets')).body.targets.find(target => target.id === targetId);
  assert.equal(after.writeMode, 'append-only'); assert.equal(after.deletesRefusedAt, null); assert.equal(after.keptByStorage.leftovers, 2);
  assert.equal(deferral(first).retry_after, storage.KEPT_UNTIL_RETEST, 'still kept: the destination is append-only now');
  // A test that fails as broken changes nothing it detected before and lists its probe files.
  Object.assign(fixture.denied, { setstat: false });
  const broken = await api('POST', `/storage-targets/${targetId}/test`, {});
  assert.equal(broken.status, 400); assert.match(broken.body.error, /not safely append-only/);
  assert.equal(storage.targetOptions(targetId).writeMode, 'append-only');
  assert.equal(writeModes.leftovers(targetId).length, 4);
  normal();
});

test('API: connecting an append-only destination records its mode and probe files; the answer never holds paths', async () => {
  appendOnly();
  const api = session();
  const created = await api('POST', '/storage-targets/connect', { name: 'Offsite vault', host: fixture.options.host, port: fixture.options.port, username: fixture.options.username, hostKey: fixture.options.hostKey, authType: 'password', password: fixture.options.password, root: '/connect-vault' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.writeMode, 'append-only'); assert.equal(created.body.keptByStorage.leftovers, 2);
  assert.doesNotMatch(JSON.stringify(created.body), /docknest-probe/);
  assert.equal(storage.targetOptions(created.body.id).writeMode, 'append-only');
  Object.assign(fixture.denied, { setstat: false });
  const refused = await api('POST', '/storage-targets/connect', { name: 'Half vault', host: fixture.options.host, port: fixture.options.port, username: fixture.options.username, hostKey: fixture.options.hostKey, authType: 'password', password: fixture.options.password, root: '/connect-half' });
  assert.equal(refused.status, 400); assert.match(refused.body.error, /could not delete its test files in \/connect-half\/\.docknest-probe/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM storage_targets WHERE name='Half vault'").get().n, 0);
  normal();
  const plain = await api('POST', '/storage-targets/connect', { name: 'Plain box', host: fixture.options.host, port: fixture.options.port, username: fixture.options.username, hostKey: fixture.options.hostKey, authType: 'password', password: fixture.options.password, root: '/connect-plain' });
  assert.equal(plain.status, 201); assert.equal(plain.body.writeMode, 'normal'); assert.equal(plain.body.deletesRefusedAt, null);
});

test('Self Backup clean-up skips kits an append-only destination keeps', async () => {
  appendOnly();
  const { targetId, folder } = sftpTarget('Kit vault');
  writeModes.recordWriteMode(targetId, 'append-only', 'test');
  const path = (name, run) => `sftp:${targetId}:${folder}/docknest-backups/docknest-recovery/docknest_${'a'.repeat(16)}_2026-10-01_02-00-00Z--${run}.dkit`;
  const older = randomUUID(), newer = randomUUID();
  for (const run of [older, newer]) db.prepare('INSERT INTO manager_backup_copies(backup_id,target_id,path,created_at) VALUES(?,?,?,?)').run(run, targetId, path('kit', run), stamp());
  fixture.events.length = 0;
  await selfBackup.pruneKitCopies();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM manager_backup_copies WHERE target_id=?').get(targetId).n, 2, 'the older kit copy stays recorded');
  assert.deepEqual(removals(), []);
  normal();
});

test('storage report: kept-by-storage bytes are shown apart only where a destination keeps backups', () => {
  const built = report.buildReport({ backups: [{ id: 'a', siteId: 's', capturedAt: day(1), path: 'sftp:t1:/x/a', size: 100 }, { id: 'b', siteId: 's', capturedAt: day(2), path: 'sftp:t2:/x/b', size: 50 }], sites: [{ id: 's', name: 'App' }], targets: [{ id: 't1', name: 'Vault', mode: 'sftp' }, { id: 't2', name: 'Box', mode: 'sftp' }], keptByStorage: { t1: { backups: 1, bytes: 100 }, t2: { backups: 0, bytes: 0 } } });
  const vault = built.storages.find(entry => entry.id === 't1'), box = built.storages.find(entry => entry.id === 't2');
  assert.equal(vault.keptByStorageBytes, 100); assert.equal(vault.keptByStorageCount, 1); assert.equal(vault.mainBytes, 100);
  assert.equal(box.keptByStorageBytes, undefined);
});

test('emergency kits on an append-only destination: older kits stay listed and a changed tool is published beside the old one', async () => {
  appendOnly();
  const { generateKeyPair, publicKeyDigest } = await import('../src/emergency/envelope.js');
  const kits = await import('../src/emergency/kits.js');
  const { emergencyToolSource } = await import('../src/emergency/bundle.js');
  const { publicKey } = generateKeyPair(), keyRow = randomUUID();
  db.prepare("INSERT INTO emergency_keys(id,public_key,digest,identifier,k,n,labels,created_by,created_at) VALUES(?,?,?,?,2,3,'[]','test',?)").run(keyRow, publicKey.toString('base64url'), publicKeyDigest(publicKey), 7, stamp());
  const { targetId, folder } = sftpTarget('Emergency vault');
  writeModes.recordWriteMode(targetId, 'append-only', 'test');
  const managerKey = 'b'.repeat(16), toolPath = `${backupRoot(folder)}/docknest-recovery/emergency/emergency-open.js`;
  const write = async () => { const temporary = await mkdtemp(join(root, 'kit-')); try { return await kits.writeEmergencyKit({ run: { id: randomUUID() }, kit: randomBytes(64), passphrase: 'fixture', keyId: managerKey, targetIds: [targetId], temporary, release: 'test' }); } finally { await rm(temporary, { recursive: true, force: true }); } };
  try {
    assert.equal(await write(), 1);
    // An older release's tool is already there and the storage will not let it be replaced.
    fixture.files.set(toolPath, Buffer.from('// older tool'));
    fixture.events.length = 0;
    assert.equal(await write(), 1, 'the kit still counts as written');
    assert.equal(fixture.files.get(toolPath).toString(), '// older tool');
    const versioned = [...fixture.files.keys()].find(file => /emergency-open-[0-9a-f]{12}\.js$/.test(file));
    assert.ok(versioned); assert.equal(fixture.files.get(versioned).toString(), emergencyToolSource().toString());
    assert.equal(kits.emergencyKits().filter(item => item.targetId === targetId).length, 2, 'the older kit stays listed');
    assert.deepEqual(removals(), []);
  } finally { db.prepare('UPDATE emergency_keys SET retired_at=? WHERE id=?').run(stamp(), keyRow); normal(); }
});