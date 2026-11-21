// Emergency kits in the backup storage (docs/emergency-kit.md). Only while the optional split is on: after each completed
// Self Backup, the worker seals the same recovery kit and its passphrase to the active emergency public key and publishes
// it under docknest-recovery/emergency/ on the main destination and on every copy destination that gets the recovery kit,
// next to the one-file offline tool (emergency-open.js), so holders who copy that folder have all they need.
// DockNest never holds the private key, so it can make kits but never open one.
// Where each kit lives is kept in the `emergency_kits` setting (paths and key ids only), because storage cannot be
// listed: a newer kit of the same key replaces the older one once it is verified; kits of a retired key stay until the
// owner deletes them ("Old parts stop opening new kits. Delete the old kits so old parts open nothing.").
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, audit, transaction } from '../db.js';
import { digest } from '../crypto.js';
import { backupRoot, emergencyKitFilename } from '../backup-layout.js';
import { managerBackupDirectory, storageJoin, makeDirectory, publishVerified, storedHash, removeFile, targetOptions, targetPrefix, storageKeepsFiles } from '../storage.js';
import { seal, packKit } from './envelope.js';
import { emergencyToolSource } from './bundle.js';

const SETTING = 'emergency_kits', TOOL = 'emergency-open.js';
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

// The tool next to the kits: published once per build, replaced when a release changes it. Storage never renames over
// a file, so a missing, different or unreadable copy (and any .partial) is removed first; the verified publish then
// fails if anything still stands in the way. An append-only destination keeps the older tool, so this release's tool is
// published beside it as emergency-open-<first 12 hex of its SHA-256>.js (docs/storage-backends.md), or under a fresh
// suffix when an interrupted attempt left a kept .partial there. Returns where the tool is, which the kit record keeps
// with its SHA-256 so the Recovery Guide fetches that exact file and checks it before running it.
async function publishTool(directory, file, sha256) {
  const published = storageJoin(directory, TOOL);
  let current = null;
  try { current = await storedHash(published); } catch { /* Missing or unreadable: written below. */ }
  if (current === sha256) return published;
  if (storageKeepsFiles(published)) {
    if (current === null) try { await publishVerified(file, published, sha256); return published; } catch { /* Something stands there: versioned below. */ }
    const versioned = storageJoin(directory, TOOL.replace(/\.js$/, '-' + sha256.slice(0, 12) + '.js'));
    try { if (await storedHash(versioned) === sha256) return versioned; } catch { /* Missing or unreadable: written below. */ }
    try { await publishVerified(file, versioned, sha256); return versioned; } catch { /* A kept .partial stands there: a fresh name below. */ }
    const fresh = storageJoin(directory, TOOL.replace(/\.js$/, '-' + sha256.slice(0, 12) + '-' + randomUUID().slice(0, 8) + '.js'));
    await publishVerified(file, fresh, sha256); return fresh;
  }
  for (const name of [published, published + '.partial']) try { await removeFile(name); } catch { /* Not there. */ }
  await publishVerified(file, published, sha256);
  return published;
}

// `kit` and `passphrase` are the bytes and passphrase of the recovery kit just published, `keyId` its key identifier and
// `targetIds` every destination that holds that kit. Each destination fails on its own: audited without its text, and
// never failing the Self Backup. Returns how many destinations got the kit.
export async function writeEmergencyKit({ run, kit, passphrase, keyId, targetIds, temporary, release }) {
  const key = activeEmergencyKey();
  if (!key) return 0;
  const createdAt = new Date().toISOString(), sealed = seal(packKit({ kit, passphrase }), { publicKey: Buffer.from(key.public_key, 'base64url'), createdAt, release });
  const file = join(temporary, 'emergency.dkem'), tool = join(temporary, TOOL), toolBytes = emergencyToolSource();
  await writeFile(file, sealed, { mode: 0o600, flag: 'wx' }); await writeFile(tool, toolBytes, { mode: 0o600, flag: 'wx' });
  let written = 0;
  for (const targetId of targetIds) {
    try {
      const directory = storageJoin(managerBackupDirectory(targetId, keyId), 'emergency'), published = storageJoin(directory, emergencyKitFilename(key.digest, run.id, new Date(createdAt)));
      await makeDirectory(directory); await publishVerified(file, published, digest(sealed));
      const toolPath = await publishTool(directory, tool, digest(toolBytes));
      changeKits(list => [...list.filter(item => item.path !== published), { keyId: key.id, targetId, path: published, createdAt, tool: { path: toolPath, sha256: digest(toolBytes) } }]);
      audit('worker', 'emergency.kit_written', run.id, { targetId }); written++;
      // An append-only destination keeps older kits of this key: they stay listed and are never retried.
      for (const older of emergencyKits().filter(item => item.keyId === key.id && item.targetId === targetId && item.path !== published && !storageKeepsFiles(item.path))) try { await removeKit(older); } catch { /* Kept; replaced again after the next Self Backup. */ }
    } catch { audit('worker', 'emergency.kit_failed', run.id, { targetId }); }
  }
  return written;
}

// Removes every emergency kit that the active key (if any) does not open, so parts of an earlier split open nothing.
export async function deleteOldEmergencyKits(actor) {
  const active = activeEmergencyKey();
  let deleted = 0, failed = 0;
  for (const record of emergencyKits().filter(item => item.keyId !== active?.id)) try { await removeKit(record); deleted++; } catch { failed++; }
  audit(actor, 'emergency.old_kits_deleted', null, { deleted, failed });
  return { deleted, failed };
}
