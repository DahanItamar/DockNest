// The automatic Recovery Guide copy (docs/recovery-guide.md "Copy next to the kit"): after each completed Self Backup,
// a PDF of the guide for every app is written next to the recovery kit, in docknest-recovery/ on each destination that
// got the kit, so a relative can read it before anything is decrypted. It is always made with the fixed options below:
// never addresses, never login details, whatever the dialog last used. Where each copy lives is kept in the
// `recovery_guide_copies` setting (paths only); a newer copy replaces the older one once it is verified. A failure is
// audited without its text and never fails the Self Backup.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db, audit, transaction } from '../db.js';
import { digest } from '../crypto.js';
import { backupRoot } from '../backup-layout.js';
import { managerBackupDirectory, storageJoin, publishVerified, removeFile, targetOptions, targetPrefix } from '../storage.js';
import { loadInventory } from './inventory.js';
import { INCLUDE_DEFAULTS } from './guide.js';
import { guidePdf } from './render.js';

export const COPY_OPTIONS = Object.freeze({ ...INCLUDE_DEFAULTS, addresses: false, logins: false });
const SETTING = 'recovery_guide_copies';
export function guideCopies() {
  try { const list = JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(SETTING)?.value ?? '[]'); return Array.isArray(list) ? list : []; } catch { return []; }
}
const changeCopies = change => transaction(() => db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(SETTING, JSON.stringify(change(guideCopies()))));
const NAME = /^recovery-guide_[0-9TZ_-]+--[0-9a-f-]{36}\.pdf$/;
const fileName = (runId, at) => `recovery-guide_${at.toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-')}Z--${runId}.pdf`;

async function removeCopy(record) {
  const selected = targetOptions(record.targetId), directory = targetPrefix(selected) + backupRoot(selected.root) + '/docknest-recovery/';
  if (!record.path.startsWith(directory) || !NAME.test(record.path.slice(directory.length))) throw new Error('Invalid Recovery Guide copy path');
  for (const file of [record.path + '.partial', record.path]) try { await removeFile(file); } catch (error) { if (error.code !== 2 && error.code !== 'ENOENT') throw error; }
  changeCopies(list => list.filter(item => item.path !== record.path));
}

// `targetIds`: the destinations that hold the kit just written; `keyId`: its key identifier; `temporary`: the run's
// private staging folder. Returns how many copies were written.
export async function writeGuideCopies({ run, targetIds, keyId, temporary }) {
  let written = 0, pdf;
  const at = new Date();
  try {
    const inventory = await loadInventory();
    pdf = guidePdf(inventory, { appIds: inventory.apps.map(app => app.id), include: COPY_OPTIONS, madeAt: at.toISOString() });
  } catch { audit('worker', 'runbook.copy_failed', run.id, {}); return 0; }
  const file = join(temporary, 'recovery-guide.pdf');
  await writeFile(file, pdf, { mode: 0o600, flag: 'wx' });
  for (const targetId of targetIds) {
    try {
      const published = storageJoin(managerBackupDirectory(targetId, keyId), fileName(run.id, at));
      await publishVerified(file, published, digest(pdf));
      changeCopies(list => [...list.filter(item => item.path !== published), { targetId, path: published, createdAt: at.toISOString() }]);
      audit('worker', 'runbook.copy_written', run.id, { targetId });
      written++;
      for (const older of guideCopies().filter(item => item.targetId === targetId && item.path !== published)) try { await removeCopy(older); } catch { /* Kept; replaced after the next Self Backup. */ }
    } catch { audit('worker', 'runbook.copy_failed', run.id, { targetId }); }
  }
  return written;
}
