import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { manifest, releaseNotes } from '../scripts/release-manifest.js';
import { schemaVersion } from '../src/migrations.js';

test('release manifest carries schema, upgrade floor, image digest and notes only', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')), digest = 'sha256:' + 'a'.repeat(64);
  const result = manifest({ version: pkg.version, image: 'ghcr.io/example/docknest', digest });
  assert.deepEqual(Object.keys(result), ['version', 'schemaVersion', 'minUpgradeFrom', 'image', 'notes']);
  assert.equal(result.schemaVersion, schemaVersion); assert.equal(result.minUpgradeFrom, pkg.docknest.minUpgradeFrom);
  assert.deepEqual(result.image, { name: 'ghcr.io/example/docknest', digest });
  assert.throws(() => manifest({ version: '99.0.0' }), /bump it before tagging/);
  assert.throws(() => manifest({ version: pkg.version, digest: 'latest' }), /--digest/);
});

test('release notes resolve to the exact version file, or the minor file for X.Y.0', () => {
  const files = ['2026-10-03-dark-mode.md', '2026-10-17-v2.0.md', '2026-11-02-v2.1.0.md', '2026-11-09-v2.1.1.md'];
  assert.equal(releaseNotes('2.0.0', files), 'docs/releases/2026-10-17-v2.0.md');
  assert.equal(releaseNotes('2.0.1', files), null);
  assert.equal(releaseNotes('2.1.0', files), 'docs/releases/2026-11-02-v2.1.0.md');
  assert.equal(releaseNotes('2.1.1', files), 'docs/releases/2026-11-09-v2.1.1.md');
  assert.equal(releaseNotes('2.2.0-rc.1', files), null);
});
