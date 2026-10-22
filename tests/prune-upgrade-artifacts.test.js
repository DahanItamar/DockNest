import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneUpgradeArtifacts } from '../scripts/prune-upgrade-artifacts.js';

const now = Date.UTC(2026, 9, 22, 12), win32 = process.platform === 'win32';
async function folder(t) {
  const root = await mkdtemp(join(tmpdir(), 'docknest-prune-')), directory = join(root, 'upgrade-snapshots');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(directory);
  return { root, directory, dir: async (name, mtime) => { await mkdir(join(directory, name)); await writeFile(join(directory, name, 'state.sqlite'), 'x'); if (mtime) await utimes(join(directory, name), mtime / 1000, mtime / 1000); } };
}
// Names that must never be removed, whatever their age: snapshots, partial copies, near misses, files and links.
const canaries = ['state-v1-to-v2-20200101T000000000Z.sqlite', 'state-v4-to-v5-20200101T000000000Z.sqlite.partial', 'pre-downgrade-20200101T000000Z.partial',
  'pre-downgrade-20200101T000000Z.sqlite', 'pre-downgrade-20201301T000000Z', 'pre-downgrade-2020-01-01', 'PRE-ROLLBACK-1', 'pre-rollback-', 'pre-rollback-12x', 'pre-rollback--1',
  'pre-rollback-1.5', 'xpre-rollback-1', 'pre-rollback-1234567890123', 'notes', '.pre-rollback-1', ...(win32 ? [] : ['pre-rollback-1 ', 'pre-rollback-2\n'])];

test('keeps the newest 2 of each prefix and never touches snapshots, partial files or unknown names', async t => {
  const f = await folder(t);
  for (const day of [1, 2, 3, 4]) await f.dir(`pre-downgrade-2026010${day}T080000Z`);
  for (const seconds of [1000, 2000, 3000]) await f.dir(`pre-rollback-${seconds}`);
  for (const name of canaries) await f.dir(name);
  await writeFile(join(f.directory, 'pre-rollback-5'), 'a plain file, not a rollback folder');
  const result = pruneUpgradeArtifacts({ directory: f.directory, now });
  assert.deepEqual(result.removed.sort(), ['pre-downgrade-20260101T080000Z', 'pre-downgrade-20260102T080000Z', 'pre-rollback-1000']);
  assert.deepEqual(result.failed, []);
  const left = await readdir(f.directory);
  for (const name of [...canaries, 'pre-rollback-5', 'pre-downgrade-20260103T080000Z', 'pre-downgrade-20260104T080000Z', 'pre-rollback-2000', 'pre-rollback-3000']) assert.ok(left.includes(name), name);
  assert.equal(left.length, canaries.length + 5);
  assert.deepEqual(pruneUpgradeArtifacts({ directory: f.directory, now }).removed, [], 'a second run removes nothing more');
});

test('a name dated in the future is ordered by its modification time, capped at now', async t => {
  const f = await folder(t);
  await f.dir('pre-downgrade-20260101T080000Z'); await f.dir('pre-downgrade-20260201T080000Z');
  await f.dir('pre-downgrade-20991231T235959Z', Date.UTC(2025, 0, 1)); // a wrong clock: actually the oldest
  await f.dir('pre-rollback-9999999999', Date.UTC(2099, 0, 1)); // future name and future time: counts as now
  await f.dir('pre-rollback-1700000000'); await f.dir('pre-rollback-1600000000');
  const result = pruneUpgradeArtifacts({ directory: f.directory, now });
  assert.deepEqual(result.removed.sort(), ['pre-downgrade-20991231T235959Z', 'pre-rollback-1600000000']);
  assert.deepEqual(result.kept.sort(), ['pre-downgrade-20260101T080000Z', 'pre-downgrade-20260201T080000Z', 'pre-rollback-1700000000', 'pre-rollback-9999999999']);
});

test('dry run removes nothing; a missing directory is fine; links are never followed or removed', async t => {
  const f = await folder(t);
  for (const day of [1, 2, 3]) await f.dir(`pre-downgrade-2026010${day}T080000Z`);
  assert.deepEqual(pruneUpgradeArtifacts({ directory: f.directory, now, dryRun: true }).removed, ['pre-downgrade-20260101T080000Z']);
  assert.equal((await readdir(f.directory)).length, 3);
  assert.deepEqual(pruneUpgradeArtifacts({ directory: join(f.root, 'missing'), now }), { removed: [], kept: [], failed: [] });
  if (win32) return;
  const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'canary'), 'keep');
  await symlink(outside, join(f.directory, 'pre-downgrade-20200101T000000Z'));
  pruneUpgradeArtifacts({ directory: f.directory, now });
  assert.ok((await readdir(f.directory)).includes('pre-downgrade-20200101T000000Z')); assert.deepEqual(await readdir(outside), ['canary']);
  const linked = join(f.root, 'linked'); await symlink(f.directory, linked);
  assert.throws(() => pruneUpgradeArtifacts({ directory: linked, now }), /not a real directory/);
});

test('the command line prunes DATA_DIR/upgrade-snapshots and reports only names', async t => {
  const f = await folder(t);
  for (const seconds of [1000, 2000, 3000]) await f.dir(`pre-rollback-${seconds}`);
  const cli = new URL('../scripts/prune-upgrade-artifacts.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, DATA_DIR: f.root } });
  let result = run('--dry-run');
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'Would remove upgrade-snapshots/pre-rollback-1000\n');
  assert.equal((await readdir(f.directory)).length, 3);
  result = run();
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'Removed upgrade-snapshots/pre-rollback-1000\n');
  assert.deepEqual((await readdir(f.directory)).sort(), ['pre-rollback-2000', 'pre-rollback-3000']);
  assert.equal(run('--force').status, 1);
});
