// Prints docknest-release.json for a tagged release: what an updater needs to decide whether it may move to it.
// Usage: node scripts/release-manifest.js --version X.Y.Z [--image NAME --digest sha256:...]
import { readFileSync, readdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { schemaVersion } from '../src/migrations.js';

// Notes convention: docs/releases/YYYY-MM-DD-vX.Y.Z.md; a vX.Y.md file covers the X.Y.0 release.
export function releaseNotes(version, files) {
  const [major, minor, patch] = version.split(/[.-]/);
  // A release candidate (X.Y.0-rc.N) ships the notes of the X.Y release it previews.
  const names = [`-v${version}.md`, ...(patch === '0' ? [`-v${major}.${minor}.md`] : [])];
  for (const suffix of names) { const match = files.filter(file => file.endsWith(suffix)).sort().at(-1); if (match) return 'docs/releases/' + match; }
  return null;
}
export function manifest({ version, image = '', digest = '' }, root = new URL('..', import.meta.url)) {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version || '')) throw new Error('--version must be X.Y.Z');
  if (pkg.version !== version) throw new Error(`package.json is ${pkg.version} but the release is ${version}; bump it before tagging`);
  if (digest && !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('--digest must be sha256:<64 hex>');
  let files = []; try { files = readdirSync(new URL('docs/releases/', root)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { version, schemaVersion, minUpgradeFrom: pkg.docknest?.minUpgradeFrom || null, image: { name: image || null, digest: digest || null }, notes: releaseNotes(version, files) };
}
if (process.argv[1]?.endsWith('release-manifest.js')) {
  const { values } = parseArgs({ options: { version: { type: 'string' }, image: { type: 'string' }, digest: { type: 'string' } } });
  try { console.log(JSON.stringify(manifest(values), null, 2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
