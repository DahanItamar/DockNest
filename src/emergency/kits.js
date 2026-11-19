// Emergency kits in the backup storage (docs/emergency-kit.md). Only while the optional split is on: after each completed
// Self Backup, the worker seals the same recovery kit and its passphrase to the active emergency public key and publishes
// it under docknest-recovery/emergency/. DockNest never holds the private key, so it can make kits but never open one.
// Where each kit lives is kept in the `emergency_kits` setting (paths and key ids only), because storage cannot be
// listed: a newer kit of the same key replaces the older one once it is verified; kits of a retired key stay until the
// owner deletes them ("Old parts stop opening new kits. Delete the old kits so old parts open nothing.").
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db, audit, transaction } from '../db.js';
import { digest } from '../crypto.js';
import { backupRoot, emergencyKitFilename } from '../backup-layout.js';
import { managerBackupDirectory, storageJoin, makeDirectory, publishVerified, removeFile, targetOptions, targetPrefix } from '../storage.js';
import { seal, packKit } from './envelope.js';

const SETTING = 'emergency_kits';
export const activeEmergencyKey = () => db.prepare('SELECT * FROM emergency_keys WHERE retired_at IS NULL').get() ?? null;
export function emergencyKits() {
  try { const list = JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(SETTING)?.value ?? '[]'); return Array.isArray(list) ? list : []; } catch { return []; }
}
// Each change reads and writes the list in one transaction, so the worker and an API request never lose an entry.
const changeKits = change => transaction(() => db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(SETTING, JSON.stringify(change(emergencyKits()))));

function validPath(record) {
  const selected = targetOptions(record.targetId), directory = targetPrefix(selected) + backupRoot(selected.root) + '/docknest-recovery/emergency/';
  return typeof record.path === 'string' && record.path.startsWith(directory) && /^emergency_[a-f0-9]{16}_[0-9TZ_-]+--[0-9a-f-]{36}\.dkem$/.test(record.path.slice(directory.length));
}
async function removeKit(record) {
  if (!validPath(record)) throw new Error('Invalid emergency kit path');
  for (const file of [record.path + '.partial', record.path]) try { await removeFile(file); } catch (error) { if (error.code !== 2 && error.code !== 'ENOENT') throw error; }
  changeKits(list => list.filter(item => item.path !== record.path));
}

// `kit` and `passphrase` are the bytes and passphrase of the recovery kit just published; `keyId` its key identifier.
// A failure is audited without its text and never fails the Self Backup.
export async function writeEmergencyKit({ run, kit, passphrase, keyId, targetId, temporary, release }) {
  const key = activeEmergencyKey();
  if (!key) return false;
  try {
    const createdAt = new Date().toISOString(), sealed = seal(packKit({ kit, passphrase }), { publicKey: Buffer.from(key.public_key, 'base64url'), createdAt, release });
    const file = join(temporary, 'emergency.dkem'); await writeFile(file, sealed, { mode: 0o600, flag: 'wx' });
    const directory = storageJoin(managerBackupDirectory(targetId, keyId), 'emergency'), published = storageJoin(directory, emergencyKitFilename(key.digest, run.id, new Date(createdAt)));
    await makeDirectory(directory); await publishVerified(file, published, digest(sealed));
    changeKits(list => [...list.filter(item => item.path !== published), { keyId: key.id, targetId, path: published, createdAt }]);
    audit('worker', 'emergency.kit_written', run.id, { targetId });
    for (const older of emergencyKits().filter(item => item.keyId === key.id && item.path !== published)) try { await removeKit(older); } catch { /* Kept; replaced again after the next Self Backup. */ }
    return true;
  } catch { audit('worker', 'emergency.kit_failed', run.id, { targetId }); return false; }
}

// Removes every emergency kit that the active key (if any) does not open, so parts of an earlier split open nothing.
export async function deleteOldEmergencyKits(actor) {
  const active = activeEmergencyKey();
  let deleted = 0, failed = 0;
  for (const record of emergencyKits().filter(item => item.keyId !== active?.id)) try { await removeKit(record); deleted++; } catch { failed++; }
  audit(actor, 'emergency.old_kits_deleted', null, { deleted, failed });
  return { deleted, failed };
}
