// Incremental backups (docs/incremental-backups.md): chain selection, every reason a backup becomes full, recording what
// the helper made, commit only after publication, link verification before any upload, chain-aware retention, pins,
// deletion, scrub, copies and Object Lock. The helper is a mock that keeps snapshot state per site like PR A's helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Writable } from 'node:stream';

const temporary = await mkdtemp(join(tmpdir(), 'dbm-incremental-'));
Object.assign(process.env, { DATA_DIR: join(temporary, 'data'), BACKUP_DIR: temporary, MASTER_KEY_FILE: join(temporary, 'master.key'), BACKUP_STORAGE: 'local', NODE_ENV: 'test' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { db } = await import('../src/db.js');
const { transport, enqueueBackup, enqueueScrub, claimJob, executeJob, encryptStream, verifyEncrypted, finishReconciledBackup, uploadBackupTo, retain } = await import('../src/engine.js');
const { preparePublication, authenticatePublication, reconcileArtifacts, claimDeletion, claimCopy, deferDeletion, retryCopy } = await import('../src/artifact-journal.js');
const inc = await import('../src/incremental.js');
const { keptForChainIds, buildReport } = await import('../src/storage-report.js');
const { migrationGroups } = await import('../src/storage-migration.js');
const { openWrite } = await import('../src/storage.js');

const at = new Date().toISOString();
const sha = text => createHash('sha256').update(text).digest('hex');
const server = id => db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,status,created_at) VALUES(?,?,'127.0.0.1',22,'root','unused',?,'unchecked',?)").run(id, id, 'a'.repeat(64), at);
const site = (id, serverId, config = {}) => { db.prepare('INSERT INTO sites(id,server_id,name,config,created_at) VALUES(?,?,?,?,?)').run(id, serverId, id, JSON.stringify(config), at); db.prepare("INSERT INTO policies(site_id,enabled,schedule,timezone,retention) VALUES(?,0,'0 0 * * *','UTC',30)").run(id); };
server('srv'); server('srv-2');

// ---- mock helper --------------------------------------------------------------------------------------------------
const helper = { commits: [], state: new Map(), pending: new Map(), requests: [], calls: [], chainFingerprint: 'chain-a', clock: 0, failCommit: false, forge: null, prepared: [], uploads: [], restores: [] };
const mountKey = sha('/srv/data');
transport.remote = async (_server, request) => {
  helper.calls.push(request.operation);
  switch (request.operation) {
    // Like the real plan: `fingerprint` changes on every container restart (EndpointID, MacAddress); `chainFingerprint` does not.
    case 'plan': return { fingerprint: 'plan-' + randomUUID(), chainFingerprint: helper.chainFingerprint };
    case 'capture': {
      helper.requests.push(request);
      const manifest = { kind: 'docker', complete: true, capturedAt: Date.now() / 1000 + (++helper.clock), downtimeSeconds: 1, originalImages: [{ Id: 'sha256:base', RepoDigests: [] }], architecture: 'amd64', containers: [{ Id: 'c1', Name: '/app', Config: { Image: 'app' }, Mounts: [{ Type: 'bind', Source: '/srv/data', Destination: '/data' }] }], consistency: { status: 'passed' } };
      const wanted = request.incremental;
      if (!wanted) return { remotePath: '/x/payload.tar.gz', root: '/var/lib/docknest/' + request.job, manifest: { ...manifest, formatVersion: 1 } };
      let mode = wanted.mode, chainId = wanted.chainId, fallback = null;
      const current = helper.state.get(wanted.siteKey)?.[mountKey];
      if (mode === 'incremental' && current !== wanted.parentSnapshots[mountKey]) { mode = 'full'; chainId = wanted.fallbackChainId; fallback = { reason: current ? 'snapshot-mismatch' : 'snapshot-missing' }; }
      const snapshot = sha(randomUUID());
      helper.pending.set(request.job, { siteKey: wanted.siteKey, snapshots: { [mountKey]: snapshot } });
      Object.assign(manifest, { chainFingerprint: helper.chainFingerprint, formatVersion: 2, backupKind: mode, chain: { id: chainId, position: mode === 'full' ? 0 : wanted.position, parentBackupId: mode === 'full' ? null : wanted.parentBackupId, parentSha256: mode === 'full' ? null : wanted.parentSha256 }, ...(fallback ? { fallback } : {}), ...(mode === 'incremental' ? { chainImages: wanted.parentImageIds } : {}) });
      manifest.containers[0].Mounts[0].incremental = { snapshotKey: mountKey, level: mode === 'full' ? 0 : 1, snapshotSha256: snapshot };
      helper.forge?.(manifest);
      return { remotePath: '/x/payload.tar.gz', root: '/var/lib/docknest/' + request.job, manifest };
    }
    case 'incremental-commit': {
      helper.commits.push(request);
      if (helper.failCommit) throw new Error('connection lost');
      const pending = helper.pending.get(request.job); if (!pending) throw new Error('nothing to commit');
      helper.state.set(pending.siteKey, { ...pending.snapshots }); return { committed: true };
    }
    case 'incremental-discard': helper.state.delete(request.siteKey); return { discarded: true };
    case 'prepare-restore': helper.prepared.push(request); return request.chainLength ? { remotePaths: Array.from({ length: request.chainLength }, (_, index) => `/restore/${request.job}/payload-${index}.tar.gz`) } : { remotePath: `/restore/${request.job}/payload.tar.gz` };
    case 'list-staging': return { root: '/var/lib/docknest', jobs: [] };
    default: return {};
  }
};
transport.download = async (_server, _path, output) => output.end(Buffer.from('payload ' + randomUUID()));
transport.uploadStream = async (_server, input, remotePath) => { const parts = []; await new Promise((resolve, reject) => input.pipe(new Writable({ write(chunk, _e, cb) { parts.push(chunk); cb(); }, final(cb) { resolve(); cb(); } })).on('error', reject)); helper.uploads.push({ remotePath, bytes: Buffer.concat(parts).toString() }); };

const run = async siteId => { helper.calls.length = 0; enqueueBackup(siteId, 'test'); const job = claimJob(); await executeJob(job); return { job, row: db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id), backup: db.prepare('SELECT * FROM backups WHERE job_id=?').get(job.id) }; };
const details = row => JSON.parse(row.details);
const lastRequest = () => helper.requests.at(-1).incremental;
const link = backupId => inc.linkOf(backupId);
const enable = (siteId, body = {}) => inc.updateIncrementalSettings(siteId, { enabled: true, ...body }, 'owner');

test('option off: the request, package and calls are exactly as before (no chain, no commit)', async () => {
  site('off', 'srv');
  const { row, backup } = await run('off');
  assert.equal(row.status, 'completed');
  assert.equal(helper.requests.at(-1).incremental, undefined);
  assert.deepEqual(helper.calls, ['plan', 'capture', 'cleanup', 'list-staging']);
  assert.equal(JSON.parse(backup.manifest).formatVersion, 1); assert.equal(JSON.parse(backup.manifest).backupKind, undefined);
  assert.equal(link(backup.id), null); assert.equal(details(row).incremental, undefined);
  assert.deepEqual(inc.chainViews([backup]).get(backup.id), { backupKind: 'full', chainId: null, parentId: null, chainPosition: null, chainLength: 1, dependents: 0, pinnedByChain: false });
});

test('a chain: full, then increments that name their parent; commit only after publication; the interval starts a new chain', async () => {
  site('chain', 'srv'); enable('chain', { interval: 2 });
  const first = await run('chain');
  assert.equal(lastRequest().mode, 'full'); assert.equal(details(first.row).incremental.fullReason, 'feature-enabled');
  assert.deepEqual(helper.calls, ['plan', 'capture', 'incremental-commit', 'cleanup', 'list-staging'], 'commit after publication, before cleanup');
  assert.deepEqual({ ...link(first.backup.id) }, { backup_id: first.backup.id, backup_kind: 'full', chain_id: lastRequest().chainId, parent_id: null, chain_position: 0 });
  assert.equal(inc.incrementalSettings('chain').fullNext, false, 'the feature-enabled flag is cleared by the full backup');
  const second = await run('chain');
  assert.deepEqual({ mode: lastRequest().mode, position: lastRequest().position, parentBackupId: lastRequest().parentBackupId, parentSha256: lastRequest().parentSha256 }, { mode: 'incremental', position: 1, parentBackupId: first.backup.id, parentSha256: first.backup.checksum });
  assert.deepEqual(lastRequest().parentSnapshots, JSON.parse(first.backup.manifest).incremental.snapshots);
  assert.deepEqual(lastRequest().parentImageIds, ['sha256:base']);
  assert.equal(link(second.backup.id).parent_id, first.backup.id);
  const manifest = JSON.parse(second.backup.manifest);
  assert.deepEqual({ formatVersion: manifest.formatVersion, backupKind: manifest.backupKind, chain: manifest.chain }, { formatVersion: 2, backupKind: 'incremental', chain: { id: link(first.backup.id).chain_id, position: 1, parentBackupId: first.backup.id, parentSha256: first.backup.checksum } });
  const third = await run('chain');
  assert.equal(link(third.backup.id).chain_position, 2);
  const fourth = await run('chain');
  assert.equal(lastRequest().mode, 'full'); assert.equal(details(fourth.row).incremental.fullReason, 'interval');
  assert.notEqual(link(fourth.backup.id).chain_id, link(first.backup.id).chain_id);
  const views = inc.chainViews([first.backup, second.backup, third.backup]);
  assert.deepEqual(views.get(first.backup.id), { backupKind: 'full', chainId: link(first.backup.id).chain_id, parentId: null, chainPosition: 0, chainLength: 1, dependents: 2, pinnedByChain: false });
  assert.deepEqual(views.get(third.backup.id).chainLength, 3);
  assert.equal(inc.chainSize(third.backup.id), first.backup.size + second.backup.size + third.backup.size, 'restore space is the sum of the chain');
});

// One chain of length 1, then a check that the next backup is full for `reason` after `change`.
async function becomesFull(siteId, change, reason, { restore } = {}) {
  site(siteId, 'srv'); enable(siteId);
  const first = await run(siteId);
  const second = await run(siteId);
  assert.equal(lastRequest().mode, 'incremental', 'the chain continues before the change');
  await change({ first, second });
  const next = await run(siteId);
  assert.equal(next.row.status, 'completed');
  assert.equal(link(next.backup.id).backup_kind, 'full', reason);
  assert.equal(details(next.row).incremental.fullReason, reason);
  await restore?.({ first, second, next });
  return next;
}
test('full reasons: the owner asks (fullNow), and the flag clears once a full backup is published', async () => {
  await becomesFull('r-now', () => enable('r-now', { fullNow: true }), 'full-now');
  assert.equal(inc.incrementalSettings('r-now').fullNext, false);
  await run('r-now'); assert.equal(lastRequest().mode, 'incremental');
});
test('full reasons: parent unverified, missing (main package gone or a chain row gone), being removed', async () => {
  await becomesFull('r-unverified', ({ second }) => db.prepare('UPDATE backups SET verified=0 WHERE id=?').run(second.backup.id), 'parent-unverified');
  await becomesFull('r-main', ({ second }) => db.prepare('INSERT INTO backup_main_removed VALUES(?,?,?)').run(second.backup.id, second.backup.path, at), 'parent-missing');
  await becomesFull('r-row', ({ first }) => db.prepare("UPDATE backup_chain_links SET chain_id='other' WHERE backup_id=?").run(first.backup.id), 'parent-missing');
  await becomesFull('r-removing', ({ first }) => db.prepare("INSERT INTO retention_operations VALUES(?,'pending',?)").run(first.backup.id, at), 'parent-removing',
    { restore: ({ first }) => db.prepare('DELETE FROM retention_operations WHERE backup_id=?').run(first.backup.id) });
  await becomesFull('r-locked', ({ first }) => deferDeletion(first.backup.id, new Date(Date.now() + 86400000).toISOString()), 'parent-removing');
});
test('full reasons: an increment with folder renames stays valid and ends its chain (folders-renamed)', async () => {
  site('r-renamed', 'srv'); enable('r-renamed');
  const first = await run('r-renamed');
  helper.forge = manifest => { if (manifest.backupKind === 'incremental') manifest.renamesSeen = true; };
  const second = await run('r-renamed');
  helper.forge = null;
  assert.equal(second.row.status, 'completed');
  assert.equal(link(second.backup.id).backup_kind, 'incremental', 'the increment that holds the renames is kept and restorable');
  assert.equal(link(second.backup.id).parent_id, first.backup.id);
  assert.equal(JSON.parse(second.backup.manifest).renamesSeen, true);
  const third = await run('r-renamed');
  assert.equal(lastRequest().mode, 'full');
  assert.equal(link(third.backup.id).backup_kind, 'full');
  assert.equal(details(third.row).incremental.fullReason, 'folders-renamed');
  assert.equal(inc.FULL_REASONS['folders-renamed'], 'Folders were renamed since the last full backup, so this backup is full.');
  const fourth = await run('r-renamed');
  assert.equal(lastRequest().mode, 'incremental', 'the new chain continues');
  assert.equal(JSON.parse(fourth.backup.manifest).renamesSeen, undefined);
  // A full package never carries the flag, even if a helper sent it: a full backup has no rename records.
  helper.forge = manifest => { manifest.renamesSeen = true; };
  enable('r-renamed', { fullNow: true });
  const fifth = await run('r-renamed');
  helper.forge = null;
  assert.equal(link(fifth.backup.id).backup_kind, 'full'); assert.equal(JSON.parse(fifth.backup.manifest).renamesSeen, undefined);
  await run('r-renamed'); assert.equal(lastRequest().mode, 'incremental');
});
test('full reasons: chain fingerprint (containers, mounts, images), site moved, format changed', async () => {
  await becomesFull('r-plan', () => { helper.chainFingerprint = 'chain-b'; }, 'plan-changed');
  helper.chainFingerprint = 'chain-a';
  // A parent recorded without a chainFingerprint (an older helper) starts a new chain.
  await becomesFull('r-plan-missing', ({ second }) => { const manifest = JSON.parse(second.backup.manifest); delete manifest.chainFingerprint; db.prepare('UPDATE backups SET manifest=? WHERE id=?').run(JSON.stringify(manifest), second.backup.id); }, 'plan-changed');
  await becomesFull('r-moved', () => db.prepare("UPDATE sites SET server_id='srv-2' WHERE id='r-moved'").run(), 'site-moved');
  await becomesFull('r-format', ({ second }) => { const manifest = JSON.parse(second.backup.manifest); manifest.incremental.format = 3; db.prepare('UPDATE backups SET manifest=? WHERE id=?').run(JSON.stringify(manifest), second.backup.id); }, 'format-changed');
});
test('the plan fingerprint changing on every restart does not break a chain; the stable chainFingerprint is stored', async () => {
  site('restarts', 'srv'); enable('restarts');
  const backups = [];
  for (let index = 0; index < 4; index++) backups.push((await run('restarts')).backup);
  assert.deepEqual(backups.map(backup => link(backup.id).chain_position), [0, 1, 2, 3]);
  assert.equal(new Set(backups.map(backup => JSON.parse(backup.manifest).backupPlan.fingerprint)).size, 4, 'every plan fingerprint differed');
  assert.ok(backups.every(backup => JSON.parse(backup.manifest).chainFingerprint === 'chain-a'));
  // The plan approval fingerprint is still the one sent with the capture.
  assert.equal(helper.requests.at(-1).planFingerprint, JSON.parse(backups.at(-1).manifest).backupPlan.fingerprint);
});
test('full reasons: storage destination changed (the decision compares the main destination of the new backup)', async () => {
  site('r-storage', 'srv'); enable('r-storage'); await run('r-storage');
  const siteRow = { id: 'r-storage', server_id: 'srv', config: {} };
  assert.equal(inc.decideCapture({ site: siteRow, plan: { fingerprint: 'plan-x', chainFingerprint: 'chain-a' }, directory: join(temporary, 'srv') }).mode, 'incremental');
  assert.equal(inc.decideCapture({ site: siteRow, plan: { fingerprint: 'plan-x', chainFingerprint: 'chain-a' }, directory: 's3:other-target:/backups/srv' }).reason, 'storage-changed');
  // Never incremental: static sites and a site move's own backup.
  assert.equal(inc.decideCapture({ site: { ...siteRow, config: { kind: 'static' } }, plan: { fingerprint: 'plan-x', chainFingerprint: 'chain-a' }, directory: temporary }), null);
  assert.equal(inc.decideCapture({ site: siteRow, plan: { fingerprint: 'plan-x', chainFingerprint: 'chain-a' }, directory: temporary, jobDetails: { moveId: 'move' } }), null);
});
test('full reasons: the helper falls back (snapshot mismatch) and the engine records what the helper made', async () => {
  const next = await becomesFull('r-helper', () => { helper.state.set('r-helper', { [mountKey]: sha('changed on the source') }); }, 'snapshot-mismatch');
  assert.equal(lastRequest().mode, 'incremental', 'the engine asked for an increment');
  assert.equal(link(next.backup.id).chain_id, lastRequest().fallbackChainId, 'a fallback full starts the fallback chain');
  assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='backup.incremental_fallback' AND target='r-helper'").get());
  await run('r-helper'); assert.equal(lastRequest().mode, 'incremental'); assert.equal(lastRequest().parentBackupId, next.backup.id);
});
test('full reasons: turned off makes a standard package and discards nothing it needs; turned on again makes a full one', async () => {
  site('r-toggle', 'srv'); enable('r-toggle'); await run('r-toggle'); await run('r-toggle');
  const off = inc.updateIncrementalSettings('r-toggle', { enabled: false }, 'owner');
  assert.equal(off.discard, true);
  const plain = await run('r-toggle');
  assert.equal(helper.requests.at(-1).incremental, undefined); assert.equal(link(plain.backup.id), null);
  const on = enable('r-toggle');
  assert.equal(on.settings.fullNextReason, 'feature-enabled');
  const next = await run('r-toggle');
  assert.equal(link(next.backup.id).backup_kind, 'full'); assert.equal(details(next.row).incremental.fullReason, 'feature-enabled');
});
test('full reasons: a failed commit makes the next backup full', async () => {
  await becomesFull('r-commit', async () => { helper.failCommit = true; await run('r-commit'); helper.failCommit = false; }, 'snapshot-not-committed');
});
test('the commit sends the site config, so a custom staging root is committed', async () => {
  site('custom-root', 'srv', { stagingRoot: '/srv/docknest-staging' }); enable('custom-root');
  const { job } = await run('custom-root');
  assert.deepEqual([helper.commits.at(-1).job, helper.commits.at(-1).siteKey, helper.commits.at(-1).config.stagingRoot], [job.id, 'custom-root', '/srv/docknest-staging']);
  assert.ok(helper.calls.indexOf('incremental-commit') < helper.calls.indexOf('cleanup'), 'commit before cleanup');
});
test('turned off while a backup runs: the backup commits, then removes the snapshot files it just committed', async () => {
  site('off-mid', 'srv'); enable('off-mid'); await run('off-mid');
  helper.forge = () => { inc.updateIncrementalSettings('off-mid', { enabled: false }, 'owner'); };
  try { await run('off-mid'); } finally { helper.forge = null; }
  assert.deepEqual(helper.calls.filter(call => call.startsWith('incremental-')), ['incremental-commit', 'incremental-discard']);
  assert.equal(helper.state.has('off-mid'), false);
});
test('full reasons: after a site move’s own backup, and after a standard package the helper made', async () => {
  site('r-move', 'srv'); enable('r-move'); await run('r-move');
  helper.calls.length = 0; enqueueBackup('r-move', 'test', { moveId: 'move-1' }); await executeJob(claimJob());
  assert.equal(helper.requests.at(-1).incremental, undefined, 'a move’s own backup is a standard package');
  const afterMove = await run('r-move');
  assert.equal(details(afterMove.row).incremental.fullReason, 'site-moved');
  helper.forge = manifest => { manifest.formatVersion = 1; delete manifest.backupKind; delete manifest.chain; };
  let standard; try { standard = await run('r-move'); } finally { helper.forge = null; }
  assert.equal(details(standard.row).incremental.standardPackage, true); assert.equal(link(standard.backup.id), null);
  const next = await run('r-move');
  assert.equal(details(next.row).incremental.fullReason, 'standard-package');
});
test('a returned chain that does not match the request is refused and nothing is published', async () => {
  site('forged', 'srv'); enable('forged'); await run('forged');
  helper.forge = manifest => { manifest.chain.parentSha256 = 'f'.repeat(64); };
  try { const { row, backup } = await run('forged'); assert.notEqual(row.status, 'completed'); assert.equal(backup, undefined); assert.match(row.error, /does not match/); assert.ok(!helper.calls.includes('incremental-commit')); }
  finally { helper.forge = null; db.prepare("UPDATE jobs SET status='failed' WHERE site_id='forged' AND status='recovery_required'").run(); }
});

test('worker restart mid-increment: published by startup reconciliation, never committed, so the next backup is full', async () => {
  site('restart', 'srv'); enable('restart');
  const first = await run('restart');
  // The worker stopped after authenticating an increment and before publishing it.
  const jobId = randomUUID(), backupId = randomUUID(), published = join(temporary, 'restart-' + backupId + '.enc'), partial = published + '.partial';
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,started_at) VALUES(?,'restart','backup','running','verifying',?,?)").run(jobId, at, at);
  const manifest = { ...JSON.parse(first.backup.manifest), formatVersion: 2, backupKind: 'incremental', chain: { id: link(first.backup.id).chain_id, position: 1, parentBackupId: first.backup.id, parentSha256: first.backup.checksum } };
  preparePublication({ backupId, jobId, siteId: 'restart', temporary: partial, published, manifest, capturedAt: new Date(Date.now() + 60000).toISOString() });
  const { Readable } = await import('node:stream');
  await encryptStream(Readable.from([Buffer.from('increment payload')]), await openWrite(partial));
  authenticatePublication(backupId, await verifyEncrypted(partial), (await readFile(partial)).length);
  helper.calls.length = 0;
  await reconcileArtifacts(verifyEncrypted, { onJobCompleted: finishReconciledBackup });
  assert.equal(link(backupId).backup_kind, 'incremental', 'the published increment is part of the chain');
  assert.ok(!helper.calls.includes('incremental-commit'), 'reconciliation never commits snapshot files');
  assert.equal(inc.incrementalSettings('restart').fullNextReason, 'snapshot-not-committed');
  const next = await run('restart');
  assert.equal(lastRequest().mode, 'full'); assert.equal(details(next.row).incremental.fullReason, 'snapshot-not-committed');
});
test('worker restart before authentication: nothing published or committed, the chain continues from its last package', async () => {
  site('restart-early', 'srv'); enable('restart-early');
  const first = await run('restart-early');
  const jobId = randomUUID(), backupId = randomUUID(), published = join(temporary, 'early-' + backupId + '.enc');
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,started_at) VALUES(?,'restart-early','backup','failed','failed',?,?)").run(jobId, at, at);
  preparePublication({ backupId, jobId, siteId: 'restart-early', temporary: published + '.partial', published, manifest: { complete: true }, capturedAt: at });
  await reconcileArtifacts(verifyEncrypted);
  assert.equal(db.prepare('SELECT 1 FROM backups WHERE id=?').get(backupId), undefined);
  await run('restart-early');
  assert.equal(lastRequest().mode, 'incremental'); assert.equal(lastRequest().parentBackupId, first.backup.id);
});

// ---- restore: load, verify every link and package before any upload --------------------------------------------------
async function chainOf(siteId, length) {
  site(siteId, 'srv'); enable(siteId);
  const backups = [];
  for (let index = 0; index < length; index++) backups.push((await run(siteId)).backup);
  return backups;
}
test('restore sends the whole chain, full first, after authenticating every package; the helper gets every link', async () => {
  const chain = await chainOf('restore', 3);
  helper.prepared.length = 0; helper.uploads.length = 0;
  const result = await uploadBackupTo({ id: 'srv' }, chain[2].id, 'restore-job');
  assert.deepEqual(helper.prepared.map(request => request.chainLength), [3]);
  assert.deepEqual(helper.uploads.map(upload => upload.remotePath), [0, 1, 2].map(index => `/restore/restore-job/payload-${index}.tar.gz`));
  assert.ok(helper.uploads.every(upload => upload.bytes.startsWith('payload ')), 'decrypted inside the authenticated stream');
  assert.deepEqual(result.chain.map(item => [item.backupId, item.sha256]), chain.map(backup => [backup.id, backup.checksum]));
  assert.equal(result.plaintextChecksum, result.chain.at(-1).plaintextChecksum);
  // A full backup outside a chain keeps the single-package request.
  site('restore-plain', 'srv'); const plain = (await run('restore-plain')).backup;
  helper.prepared.length = 0;
  const single = await uploadBackupTo({ id: 'srv' }, plain.id, 'plain-job');
  assert.equal(helper.prepared[0].chainLength, undefined); assert.equal(single.chain, undefined);
});
test('link verification: missing, reordered, swapped and tampered packages stop the restore before any upload', async () => {
  const chain = await chainOf('links', 4);
  const attempt = async () => { helper.prepared.length = 0; helper.uploads.length = 0; try { await uploadBackupTo({ id: 'srv' }, chain[3].id, 'links-job'); return null; } catch (error) { assert.equal(helper.prepared.length, 0, 'nothing prepared'); assert.equal(helper.uploads.length, 0, 'nothing uploaded'); return error; } };
  const message = id => `This backup depends on backup ${id}, which is missing or damaged. Restore ${id}'s chain from an earlier point, or pick a full backup.`;
  // Tampered: one byte of the middle package changes, so GCM and SHA-256 fail.
  const file = chain[1].path, original = await readFile(file), tampered = Buffer.from(original); tampered[20] ^= 1;
  await writeFile(file, tampered);
  assert.equal((await attempt()).message, message(chain[1].id));
  await writeFile(file, original);
  // Swapped: the parent's recorded package is a different one (its SHA-256 no longer matches the child's link).
  db.prepare('UPDATE backups SET checksum=? WHERE id=?').run('0'.repeat(64), chain[1].id);
  assert.equal((await attempt()).message, message(chain[1].id));
  db.prepare('UPDATE backups SET checksum=? WHERE id=?').run(chain[1].checksum, chain[1].id);
  // Reordered: positions out of order.
  db.prepare('UPDATE backup_chain_links SET chain_position=3 WHERE backup_id=?').run(chain[2].id);
  db.prepare('UPDATE backup_chain_links SET chain_position=2 WHERE backup_id=?').run(chain[3].id);
  assert.ok((await attempt()).code === 'chain_broken');
  db.prepare('UPDATE backup_chain_links SET chain_position=2 WHERE backup_id=?').run(chain[2].id);
  db.prepare('UPDATE backup_chain_links SET chain_position=3 WHERE backup_id=?').run(chain[3].id);
  // Missing: a package the backup builds on is gone.
  db.prepare('UPDATE backup_chain_links SET parent_id=? WHERE backup_id=?').run('gone', chain[2].id);
  assert.equal((await attempt()).message, message('gone'));
  db.prepare('UPDATE backup_chain_links SET parent_id=? WHERE backup_id=?').run(chain[1].id, chain[2].id);
  assert.equal(await attempt(), null, 'restored links pass again');
});
test('scrub of an increment verifies its whole chain and marks the damaged package', async () => {
  const chain = await chainOf('scrub', 3);
  const scrub = async () => { const { id } = enqueueScrub(chain[2].id, 'test'); await executeJob(claimJob()); return db.prepare('SELECT * FROM jobs WHERE id=?').get(id); };
  assert.equal((await scrub()).status, 'completed');
  const original = await readFile(chain[0].path), damaged = Buffer.from(original); damaged[30] ^= 1; await writeFile(chain[0].path, damaged);
  const job = await scrub();
  assert.equal(job.status, 'failed'); assert.match(job.error, new RegExp(`depends on backup ${chain[0].id}`));
  assert.deepEqual(db.prepare('SELECT id,verified FROM backups WHERE id IN (?,?,?) ORDER BY captured_at').all(...chain.map(b => b.id)).map(row => row.verified), [0, 1, 0]);
  await writeFile(chain[0].path, original);
});

// ---- retention, pins, deletion, Object Lock ---------------------------------------------------------------------------
test('retention counts restore points and keeps a full package while its increments are kept ("kept for a chain")', async () => {
  const chain = await chainOf('keep', 4);
  db.prepare("UPDATE policies SET retention=2 WHERE site_id='keep'").run();
  await retain('keep');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM backups WHERE site_id='keep'").get().n, 4, 'the two oldest stay for the chain');
  assert.deepEqual([...keptForChainIds()].filter(id => chain.some(b => b.id === id)).sort(), [chain[0].id, chain[1].id].sort());
  // A new chain starts; once the old chain is all past the count, it goes, newest first.
  enable('keep', { fullNow: true }); await run('keep'); await run('keep');
  await retain('keep');
  assert.deepEqual(db.prepare("SELECT id FROM backups WHERE site_id='keep' ORDER BY captured_at").all().map(row => row.id).filter(id => chain.some(b => b.id === id)), []);
});
test('pinning an increment pins its chain; deleting a package others depend on is refused unless they go together', async () => {
  const chain = await chainOf('pin', 3);
  assert.equal(claimDeletion(chain[0].id), false, 'a full package with live increments is never claimed');
  assert.match(inc.deletionRefusal([chain[0].id]).message, /Delete this backup and the 2 backups that depend on it together/);
  assert.equal(inc.deletionRefusal(chain.map(b => b.id)), null);
  assert.deepEqual(inc.deletionOrder(chain.map(b => b.id)), [chain[2].id, chain[1].id, chain[0].id]);
  db.prepare('UPDATE backups SET pinned=1 WHERE id=?').run(chain[1].id);
  const views = inc.chainViews(chain);
  assert.equal(views.get(chain[0].id).pinnedByChain, true); assert.equal(views.get(chain[2].id).pinnedByChain, false);
  db.prepare("UPDATE policies SET retention=1 WHERE site_id='pin'").run();
  enable('pin', { fullNow: true }); await run('pin');
  await retain('pin');
  assert.deepEqual(db.prepare('SELECT id FROM backups WHERE id IN (?,?,?) ORDER BY captured_at').all(...chain.map(b => b.id)).map(row => row.id), [chain[0].id, chain[1].id], 'the unpinned tail goes, the pinned increment keeps its full');
});
test('Object Lock on a chain member: the locked increment is deferred and keeps the packages it builds on', async () => {
  const chain = await chainOf('locked', 3);
  deferDeletion(chain[2].id, new Date(Date.now() + 86400000).toISOString());
  db.prepare("UPDATE policies SET retention=1 WHERE site_id='locked'").run();
  enable('locked', { fullNow: true }); await run('locked');
  await retain('locked');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backups WHERE id IN (?,?,?)').get(...chain.map(b => b.id)).n, 3);
  db.prepare('DELETE FROM retention_deferrals WHERE backup_id=?').run(chain[2].id);
  await retain('locked');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backups WHERE id IN (?,?,?)').get(...chain.map(b => b.id)).n, 0, 'once the lock ends the whole chain goes');
});

// ---- copies, storage migration, storage report ----------------------------------------------------------------------
test('copies: an increment is copied to a destination only after its parent is verified there', async () => {
  const chain = await chainOf('copies', 2);
  db.prepare("INSERT INTO site_storage_copies(site_id,target_id,retention,created_at) VALUES('copies','copy-target',NULL,?)").run(at);
  for (const backup of chain) db.prepare("INSERT INTO backup_copies(backup_id,target_id,path,status,attempts,created_at,updated_at) VALUES(?,'copy-target',?,'pending',0,?,?)").run(backup.id, 'sftp:copy-target:/x/' + backup.id, at, at);
  db.prepare("UPDATE backup_copies SET status='failed',next_attempt_at=? WHERE backup_id=?").run(Date.now() + 3600000, chain[0].id);
  assert.equal(claimCopy(), null, 'the increment waits for its parent (partial chain)');
  db.prepare("UPDATE backup_copies SET status='verified',next_attempt_at=NULL WHERE backup_id=?").run(chain[0].id);
  assert.equal(claimCopy().backup_id, chain[1].id);
  // A parent copy that gave up is tried again when the owner retries the increment's copy.
  db.prepare("UPDATE backup_copies SET status='gave_up',next_attempt_at=NULL WHERE backup_id=?").run(chain[0].id);
  db.prepare("UPDATE backup_copies SET status='pending' WHERE backup_id=?").run(chain[1].id);
  assert.equal(retryCopy(chain[1].id, 'copy-target').found, true);
  assert.equal(db.prepare("SELECT status FROM backup_copies WHERE backup_id=? AND target_id='copy-target'").get(chain[0].id).status, 'pending');
  db.prepare("DELETE FROM backup_copies WHERE target_id='copy-target'").run(); db.prepare("DELETE FROM site_storage_copies WHERE target_id='copy-target'").run();
});
test('storage migration switches a chain together, full first; outside chains one package at a time', () => {
  const plan = [{ id: 'plain-1' }, { id: 'f', chainId: 'c' }, { id: 'plain-2' }, { id: 'i1', chainId: 'c' }, { id: 'i2', chainId: 'c' }];
  assert.deepEqual(migrationGroups(plan).map(group => group.map(entry => entry.id)), [['plain-1'], ['f', 'i1', 'i2'], ['plain-2']]);
});
test('storage report: the real measured saving of increments against their chain\'s full package', () => {
  const backups = [{ id: 'f', siteId: 's', capturedAt: at, path: 'local', size: 1000 }, { id: 'i1', siteId: 's', capturedAt: at, path: 'local', size: 100 }, { id: 'i2', siteId: 's', capturedAt: at, path: 'local', size: 300 }, { id: 'plain', siteId: 's', capturedAt: at, path: 'local', size: 900 }];
  const chains = [{ backupId: 'f', kind: 'full', chainId: 'c', position: 0 }, { backupId: 'i1', kind: 'incremental', chainId: 'c', position: 1 }, { backupId: 'i2', kind: 'incremental', chainId: 'c', position: 2 }];
  const report = buildReport({ backups, sites: [{ id: 's', name: 'S' }], targets: [], chains, keptForChain: new Set(['f']) });
  assert.deepEqual({ ...report.incrementalSaving, method: undefined }, { bytesSaved: 1600, fullEquivalentBytes: 2000, storedBytes: 400, increments: 2, chains: 1, keptForChain: 1, keptForChainBytes: 1000, method: undefined });
  assert.equal(report.storages[0].chainBytes, 1000);
  assert.deepEqual(buildReport({ backups, sites: [], targets: [] }).incrementalSaving.bytesSaved, 0, 'no chains: nothing saved');
});
