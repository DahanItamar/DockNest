// Keeps the newest rollback folders that downgrades leave in DATA_DIR/upgrade-snapshots and removes older ones.
// scripts/upgrade.sh runs it in the new release's api container, only after a successful upgrade:
//   node scripts/prune-upgrade-artifacts.js [--dry-run]
// One exact pattern per prefix; anything else is never touched: the state-v*-to-v*-*.sqlite snapshots (src/migrations.js
// rotates them), .partial files, links, plain files and unknown names. Real directories only, links are never followed.
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

// pre-downgrade-<UTC>: written by upgrade.sh when it restores a snapshot. A calendar-invalid time is not a match.
const utc = (date, time) => {
  const ms = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +time.slice(0, 2), +time.slice(2, 4), +time.slice(4, 6));
  return new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15) === `${date}T${time}` ? ms : null;
};
export const patterns = [
  { prefix: 'pre-downgrade', pattern: /^pre-downgrade-(\d{8})T(\d{6})Z$/, time: match => utc(match[1], match[2]) },
  // pre-rollback-<epoch seconds>: the manual rollback steps in docs/upgrading.md.
  { prefix: 'pre-rollback', pattern: /^pre-rollback-(\d{1,12})$/, time: match => Number(match[1]) * 1000 }
];
const realDirectory = file => { try { const info = lstatSync(file); return info.isDirectory() && !info.isSymbolicLink() ? info : null; } catch { return null; } };

// Newest `keep` per prefix stay, ordered by the time in the name; a name dated in the future is ordered by its
// modification time instead (capped at now), so a wrong clock cannot pin an old folder or evict a new one.
export function pruneUpgradeArtifacts({ directory, keep = 2, now = Date.now(), dryRun = false } = {}) {
  const result = { removed: [], kept: [], failed: [] };
  try { lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  if (!realDirectory(directory)) throw new Error(`${directory} is not a real directory`);
  const names = readdirSync(directory);
  for (const { pattern, time } of patterns) {
    const found = [];
    for (const name of names) {
      const match = pattern.exec(name), stamp = match ? time(match) : null, info = stamp === null ? null : realDirectory(path.join(directory, name));
      if (info) found.push({ name, order: stamp > now ? Math.min(info.mtimeMs, now) : stamp });
    }
    found.sort((a, b) => b.order - a.order || (a.name < b.name ? 1 : -1));
    for (const [index, { name }] of found.entries()) {
      if (index < keep) { result.kept.push(name); continue; }
      if (dryRun) { result.removed.push(name); continue; }
      const target = path.join(directory, name);
      try { if (!realDirectory(target)) continue; rmSync(target, { recursive: true }); result.removed.push(name); } catch { result.failed.push(name); }
    }
  }
  return result;
}

if (import.meta.filename === path.resolve(process.argv[1] || '')) {
  const args = process.argv.slice(2), dryRun = args.includes('--dry-run');
  if (args.some(arg => arg !== '--dry-run')) { console.error('Usage: node scripts/prune-upgrade-artifacts.js [--dry-run]'); process.exit(1); }
  try {
    const { removed, failed } = pruneUpgradeArtifacts({ directory: path.join(process.env.DATA_DIR || '/data', 'upgrade-snapshots'), dryRun });
    for (const name of removed) console.log(`${dryRun ? 'Would remove' : 'Removed'} upgrade-snapshots/${name}`);
    for (const name of failed) console.error(`Could not remove upgrade-snapshots/${name}`);
    if (!removed.length && !failed.length) console.log('No old rollback folders in upgrade-snapshots.');
    if (failed.length) process.exitCode = 1;
  } catch (error) { console.error(`Rollback folders were not pruned: ${error.message}`); process.exitCode = 1; }
}
