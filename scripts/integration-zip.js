// Full ZIP export of a stored backup to a local file, driven like the browser does: prepare (verify only), poll until
// ready, then stream. Shared by the Linux integration scenarios that read a decrypted package.
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';

export async function exportBackupZip(backup, file) {
  const { startZipExport, findZipExport, zipExportState, streamZipExport } = await import('../src/backup-export.js');
  const prepared = startZipExport(backup).item; let state = prepared;
  for (let i = 0; i < 600 && state.status === 'preparing'; i++) { await new Promise(resolve => setTimeout(resolve, 500)); state = zipExportState(findZipExport(backup.id, prepared.id)); }
  assert.equal(state.status, 'ready', state.error || 'ZIP preparation did not finish');
  const response = createWriteStream(file); response.attachment = () => response; response.set = () => response;
  await streamZipExport(findZipExport(backup.id, prepared.id), backup, response);
  await new Promise(resolve => response.writableFinished ? resolve() : response.once('finish', resolve));
}
