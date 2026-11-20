// Self Backup kit check and the optional K-of-N emergency kit (docs/emergency-kit.md) on the real Linux SFTP storage host.
// Called by scripts/integration-linux.js. Proves: a Self Backup's kit check passes; with the split on, a Self Backup writes
// a sealed emergency kit and the one-file tool under docknest-recovery/emergency/; that bundled tool, copied out of the
// storage folder, turns the kit into a recovery kit with K of the parts that `node scripts/recovery-kit.js restore`
// accepts; and the kit check fails cleanly, with a reason code, on a corrupted kit and on a wrong kept passphrase. Afterwards the split is turned off and its kits are deleted.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Runs a repository script with input on stdin; never prints its arguments or output, which hold parts and passphrases.
function script(args, input) {
  return new Promise(resolve => {
    const child = execFile(process.execPath, ['--no-addons', ...args], { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }));
    child.stdin.end(input);
  });
}

export async function runEmergencyScenario({ run, hosts, db, record, directory }) {
  const { saveSelfBackupSettings, enqueueSelfBackup, claimSelfBackup, executeSelfBackup, readLatestSelfBackup, selfBackupDirectory } = await import('../src/self-backup.js');
  const { claimKitCheck, executeKitCheck, queueKitCheckAfterBackup } = await import('../src/kit-check.js');
  const { splitEmergencyKit, retireEmergencyKit } = await import('../src/emergency/keys.js');
  const { emergencyKits, deleteOldEmergencyKits } = await import('../src/emergency/kits.js');
  const { openRead, storageJoin } = await import('../src/storage.js');
  const { seal } = await import('../src/crypto.js');
  const { readEnvelopeHeader } = await import('../src/emergency/envelope.js');
  const work = join(directory, 'emergency'), passphrase = randomBytes(32).toString('base64url'), actor = 'qa-admin';
  await mkdir(work, { recursive: true, mode: 0o700 });
  const lastCheck = () => db.prepare("SELECT result,reason FROM kit_checks WHERE result IN ('passed','failed') ORDER BY checked_at DESC,rowid DESC LIMIT 1").get();
  const selfBackup = async () => {
    enqueueSelfBackup(actor);
    assert.equal(await executeSelfBackup(claimSelfBackup()), true, 'Self Backup completes on the SFTP storage');
    queueKitCheckAfterBackup(); await executeKitCheck(claimKitCheck());
  };
  const read = async file => { const chunks = []; for await (const chunk of await openRead(file)) chunks.push(chunk); return Buffer.concat(chunks); };
  saveSelfBackupSettings({ enabled: false, schedule: '0 3 * * *', timezone: 'UTC', passphrase, recoverySecretSaved: true }, actor);

  await selfBackup();
  assert.deepEqual({ ...lastCheck() }, { result: 'passed', reason: null });
  assert.deepEqual(emergencyKits(), [], 'one passphrase by default: no emergency kit');
  record('Self Backup kit check opens the newest recovery kit from SFTP storage with the kept passphrase and passes; no emergency kit without the split');

  const split = splitEmergencyKit({ k: 2, n: 3, labels: ['Holder one', 'Holder two', 'Holder three'] }, actor);
  await selfBackup();
  const mainTarget = db.prepare("SELECT target_id FROM manager_backups WHERE status='completed' ORDER BY rowid DESC LIMIT 1").get().target_id, kit = emergencyKits().find(item => item.targetId === mainTarget);
  assert.ok(kit && /\/BACKUP\/docknest-recovery\/emergency\/emergency_[a-f0-9]{16}_[0-9_-]+Z--[0-9a-f-]{36}\.dkem$/.test(kit.path));
  const sealed = await read(kit.path);
  assert.equal(readEnvelopeHeader(sealed).digest, split.digest);
  // A holder copies the emergency folder: the kit and the bundled tool, as stored.
  const tool = join(work, 'kits', 'emergency-open.js');
  await mkdir(join(work, 'kits')); await writeFile(join(work, 'kits', kit.path.split('/').at(-1)), sealed);
  await writeFile(tool, await read(storageJoin(kit.path.slice(0, kit.path.lastIndexOf('/')), 'emergency-open.js')));
  const opened = await script([tool, 'open', join(work, 'kits'), join(work, 'opened')], `${split.parts[2].words}\n${split.parts[0].words}\n`);
  assert.equal(opened.code, 0, 'the bundled emergency-open.js from storage opens the kit with K parts');
  assert.deepEqual(await readFile(join(work, 'opened', 'docknest-recovery.dkit')), (await readLatestSelfBackup()).bytes);
  const restored = await script(['scripts/recovery-kit.js', 'restore', join(work, 'opened', 'docknest-recovery.dkit'), join(work, 'restored'), join(work, 'opened', 'recovery-passphrase.txt')], '');
  assert.equal(restored.code, 0, 'recovery-kit.js restore accepts the opened kit');
  assert.equal(JSON.parse(restored.stdout).restored, true);
  assert.ok((await readdir(join(work, 'restored', 'recovery'))).includes('emergency-open.js'));
  const short = await script([tool, 'open', join(work, 'kits'), join(work, 'short')], `${split.parts[1].words}\n`);
  assert.equal(short.code, 1, 'fewer than K parts open nothing');
  record('With the optional 2-of-3 split on, a Self Backup writes a sealed emergency kit and the tool to SFTP; the bundled emergency-open.js copied from storage with 2 parts gives a recovery kit that recovery-kit.js restore accepts, and 1 part opens nothing');

  // Corrupt the published recovery kit on the storage host, check, then put the byte back.
  const kitPath = db.prepare("SELECT path FROM manager_backups WHERE status='completed' ORDER BY rowid DESC LIMIT 1").get().path, remote = kitPath.slice(kitPath.indexOf(':/') + 1);
  const flip = () => run('exec', hosts[2], 'python3', '-c', 'import sys\np=sys.argv[1]\nb=bytearray(open(p,"rb").read())\nb[64]^=1\nopen(p,"wb").write(b)', remote);
  await flip();
  try { queueKitCheckAfterBackup(); await executeKitCheck(claimKitCheck()); } finally { await flip(); }
  assert.deepEqual({ ...lastCheck() }, { result: 'failed', reason: 'unreadable' });
  assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='manager-backup.kit_check' AND detail LIKE '%unreadable%'").get());
  assert.deepEqual((await readdir(await selfBackupDirectory())).filter(name => name.startsWith('.kit-check-')), [], 'the check folder is removed');
  queueKitCheckAfterBackup(); await executeKitCheck(claimKitCheck());
  assert.equal(lastCheck().result, 'passed', 'the restored kit passes again');
  record('A corrupted recovery kit on SFTP storage fails the kit check cleanly with a reason code, and passes again once repaired');

  // A wrong kept passphrase: the stored kit is intact (its checksum passes), so this fails at decryption.
  const settings = db.prepare("SELECT value FROM settings WHERE key='manager_backup_config'").get().value, kept = JSON.parse(settings);
  db.prepare("UPDATE settings SET value=? WHERE key='manager_backup_config'").run(JSON.stringify({ ...kept, passphrase: seal(randomBytes(32).toString('base64url')) }));
  try { queueKitCheckAfterBackup(); await executeKitCheck(claimKitCheck()); } finally { db.prepare("UPDATE settings SET value=? WHERE key='manager_backup_config'").run(settings); }
  assert.deepEqual({ ...lastCheck() }, { result: 'failed', reason: 'passphrase' });
  assert.deepEqual((await readdir(await selfBackupDirectory())).filter(name => name.startsWith('.kit-check-')), []);
  record('A wrong kept passphrase fails the kit check at decryption, not at the storage checksum, with the reason code passphrase');

  // Going back to one passphrase needs a new one (every holder's kit carried the old); the queued Self Backup remakes the kit.
  const renewed = randomBytes(32).toString('base64url');
  assert.equal(retireEmergencyKit({ passphrase: renewed }, actor).selfBackupQueued, true);
  assert.equal(await executeSelfBackup(claimSelfBackup()), true);
  queueKitCheckAfterBackup(); await executeKitCheck(claimKitCheck());
  assert.equal(lastCheck().result, 'passed', 'the new kit opens with the new passphrase');
  const removed = await deleteOldEmergencyKits(actor);
  assert.equal(removed.failed, 0); assert.ok(removed.deleted >= 1, 'the main destination and any copy destinations');
  assert.deepEqual(emergencyKits(), []);
  record('Go back to one passphrase replaces the recovery passphrase, remakes the kit, retires the key pair, and the old emergency kits are deleted from SFTP storage');
}
