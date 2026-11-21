import test from 'node:test';
import assert from 'node:assert/strict';
import { probeCapacity } from '../src/storage/sftp.js';
import { startSftpFixture } from './sftp-fixture.js';

test('probing an unsaved SFTP destination returns the total the server reports', async () => {
  const sftp = await startSftpFixture();
  try {
    sftp.volume.blocks = 250000; sftp.volume.free = 200000; sftp.volume.available = 190000;
    assert.equal(await probeCapacity({ ...sftp.options, root: '/' }), 250000 * 4096);
  } finally { await sftp.close(); }
});
test('probing fails quietly to null when the server reports no capacity', async () => {
  const sftp = await startSftpFixture();
  try { assert.equal(await probeCapacity({ ...sftp.options, root: '/' }), null); }
  finally { await sftp.close(); }
});
test('probing an unreachable or wrongly pinned server returns null, never throws', async () => {
  const sftp = await startSftpFixture();
  try { assert.equal(await probeCapacity({ ...sftp.options, hostKey: 'a'.repeat(64), root: '/' }), null); }
  finally { await sftp.close(); }
  assert.equal(await probeCapacity({ host: '127.0.0.1', port: 1, username: 'x', password: 'x', hostKey: 'a'.repeat(64), root: '/' }), null);
});
