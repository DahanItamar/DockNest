import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, copyFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// A scrub of a Google Drive package that Drive cannot show (another Google app uploaded it) is not damage. The rclone
// binary is a fake (tests/fake-rclone.js) whose remote has no files, so every read is a "not found".
const root = await mkdtemp(join(tmpdir(), 'docknest-scrub-nv-')), fakeDir = join(root, 'fake');
await mkdir(fakeDir);
await copyFile(new URL('./fake-rclone.js', import.meta.url), join(fakeDir, 'rclone.js'));
Object.assign(process.env, { DATA_DIR: root, BACKUP_DIR: root, MASTER_KEY_FILE: join(root, 'master.key'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured', DOCKNEST_RCLONE_BIN: join(fakeDir, 'rclone.js') });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { db, id } = await import('../src/db.js');
const { seal } = await import('../src/crypto.js');
const { backupVerification } = await import('../src/recovery-evidence.js');
const { enqueueScrub, claimJob, executeJob } = await import('../src/engine.js');
const { NOT_VISIBLE_MESSAGE } = await import('../src/storage/rclone-errors.js');
// The provider answers `lsjson --stat` with `null` for a file it cannot see: the not-found comes from statFile itself.
await writeFile(join(fakeDir, 'control.json'), JSON.stringify({ statNull: true }));
const at = '2026-01-01T00:00:00.000Z', later = '2026-02-01T00:00:00.000Z';
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run('server', 'Fixture', 'localhost', 22, 'root', 'encrypted', '0'.repeat(64), at);
db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run('site', 'server', 'Fixture', '{}', at);
db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES('capture','site','backup','completed','completed',?)").run(at);

function driveWithBackup(name, settings) {
  const targetId = id(), backupId = 'backup-' + name;
  db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(targetId, 'My cloud', 'rclone.invalid', 1, '', 'not-sftp', 'rclone', seal(JSON.stringify({ token: { access_token: 'fixture-access-token-0001', token_type: 'Bearer', refresh_token: 'fixture-refresh-token-0001' } })), '/docknest', 0, 'connected', at, at);
  db.prepare("INSERT INTO storage_target_settings VALUES(?,'rclone',?)").run(targetId, JSON.stringify({ backend: 'drive', ...settings }));
  db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(backupId, 'site', 'capture', at, `rclone:${targetId}:/docknest/${name}.enc`, 47, '0'.repeat(64), '{}', 0, 1, at);
  return backupId;
}
async function scrub(backupId) {
  const job = enqueueScrub(backupId, 'fixture');
  assert.equal(claimJob().id, job.id);
  await executeJob(db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id));
  return db.prepare('SELECT status,error FROM jobs WHERE id=?').get(job.id);
}

test('a Drive package missing after the Google app changed is "not visible": no integrity failure, nothing marked unverified', async () => {
  const backupId = driveWithBackup('hidden', { clientChangedAt: later });
  const job = await scrub(backupId);
  assert.equal(job.status, 'failed');
  assert.equal(job.error, NOT_VISIBLE_MESSAGE);
  assert.equal(db.prepare('SELECT verified FROM backups WHERE id=?').get(backupId).verified, 1);
  assert.notEqual(backupVerification(backupId).integrity.status, 'failed');
});
test('the same missing package is still damaged when the Google app never changed, or changed before it was uploaded', async () => {
  for (const [name, settings] of [['plain', {}], ['older', { clientChangedAt: '2025-12-01T00:00:00.000Z' }]]) {
    const backupId = driveWithBackup(name, settings);
    const job = await scrub(backupId);
    assert.equal(job.status, 'failed', name);
    assert.match(job.error, /Package integrity could not be verified/, name);
    assert.equal(backupVerification(backupId).integrity.status, 'failed', name);
    assert.equal(db.prepare('SELECT verified FROM backups WHERE id=?').get(backupId).verified, 0, name);
  }
});
test('cleanup', async () => { db.close(); await rm(root, { recursive: true, force: true }); });
