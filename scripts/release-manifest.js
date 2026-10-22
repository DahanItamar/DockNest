// Prints docknest-release.json for a tagged release: what an updater needs to decide whether it may move to it. The
// release workflow signs the printed file with cosign sign-blob, so every field here is covered by the signature.
// Usage: node scripts/release-manifest.js --version X.Y.Z --commit <40 hex> --repository OWNER/NAME [--tag vX.Y.Z]
//          [--image NAME --digest sha256:...]                  print the manifest
//        node scripts/release-manifest.js --check FILE <same options>   refuse a written manifest that does not match
//        node scripts/release-manifest.js --notes-body FILE             print release notes without their front matter
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { schemaVersion } from '../src/migrations.js';

// The host verifier caps the manifest and the notes it shows at 64 KiB (threat model section 5 and D20).
const MAX_BYTES = 65536;
// Highlights front matter: every key is required, in any order (docs/releases/TEMPLATE.md).
const HIGHLIGHTS = ['security', 'features', 'improvements', 'fixes'];
// Every key a manifest carries; highlights is the only optional one (absent when the notes have no front matter).
const KEYS = ['version', 'tag', 'commit', 'repository', 'prerelease', 'schemaVersion', 'minUpgradeFrom', 'image', 'notes', 'highlights', 'updater'];
// Files of the host updater whose SHA-256 the signed manifest carries for its self-update. The list is absent until
// the updater ships; then it is { "version": "X.Y.Z", "files": [paths], "units": [paths], "cosign"?: { "version":
// "vX.Y.Z", "sha256": { "linux-amd64": hex, "linux-arm64": hex } } } with repository-relative paths. Its version is the
// host updater's own version and is deliberately independent of the DockNest release version: the updater changes far
// less often, and a host compares it with the updater it runs to decide whether to self-update, never with the release.
export const UPDATER_LIST = 'updater/release-files.json';

// Notes convention: docs/releases/YYYY-MM-DD-vX.Y.Z.md; a vX.Y.md file covers the X.Y.0 release.
export function releaseNotes(version, files) {
  const [major, minor, patch] = version.split(/[.-]/);
  // A release candidate (X.Y.0-rc.N) ships the notes of the X.Y release it previews.
  const names = [`v${version}.md`, ...(patch === '0' ? [`v${major}.${minor}.md`] : [])];
  for (const name of names) { const match = files.filter(file => /^\d{4}-\d{2}-\d{2}-/.test(file) && file.slice(11) === name).sort().at(-1); if (match) return 'docs/releases/' + match; }
  return null;
}

// Strict front matter: absent (the file does not start with ---) gives no highlights; anything malformed throws.
export function frontMatter(text) {
  // A BOM would hide the opening --- and silently drop the highlights, so it is refused rather than skipped.
  if (text.startsWith('\uFEFF')) throw new Error('front matter: the notes must not start with a UTF-8 byte order mark');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return { highlights: null, body: lines.join('\n') };
  if (lines[0] !== '---') throw new Error('front matter must open with a line of exactly ---');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('front matter is not closed with a line of exactly ---');
  const highlights = {};
  for (const line of lines.slice(1, end)) {
    const [, key, value] = /^([a-z]+): (\S+)$/.exec(line) || [];
    if (!key) throw new Error(`front matter line ${JSON.stringify(line)} is not "key: value"`);
    if (!HIGHLIGHTS.includes(key)) throw new Error(`front matter key ${key} is not one of ${HIGHLIGHTS.join(', ')}`);
    if (key in highlights) throw new Error(`front matter key ${key} appears twice`);
    if (key === 'security') { if (!/^(true|false)$/.test(value)) throw new Error('front matter security must be true or false'); highlights[key] = value === 'true'; }
    else { if (!/^(0|[1-9]\d?)$/.test(value)) throw new Error(`front matter ${key} must be a whole number from 0 to 99`); highlights[key] = Number(value); }
  }
  const missing = HIGHLIGHTS.filter(key => !(key in highlights));
  if (missing.length) throw new Error(`front matter is missing ${missing.join(', ')}`);
  return { highlights: Object.fromEntries(HIGHLIGHTS.map(key => [key, highlights[key]])), body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') };
}

// A repository file the release reads: a regular file (not a symlink) whose real path, every directory included, stays
// inside the repository root.
export function repositoryFile(root, relative) {
  const url = new URL(relative, root); let stat, real;
  try { stat = lstatSync(url); real = realpathSync(url); } catch (error) { if (error.code === 'ENOENT') throw new Error(`${relative} is listed but does not exist`); throw error; }
  if (!stat.isFile()) throw new Error(`${relative} is not a regular file`);
  const inside = path.relative(realpathSync(fileURLToPath(root)), real);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`${relative} resolves outside the repository`);
  return url;
}

// SHA-256 of each listed updater file. An absent list gives an empty block (no updater yet, so no self-update); a list
// that names a missing, non-regular or repeated file fails the release.
export function updaterBlock(root) {
  let list;
  try { list = JSON.parse(readFileSync(new URL(UPDATER_LIST, root), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { version: null, files: {}, units: {} }; throw new Error(`${UPDATER_LIST}: ${error.message}`); }
  const fail = message => { throw new Error(`${UPDATER_LIST}: ${message}`); };
  if (!list || typeof list !== 'object' || Array.isArray(list)) fail('must be a JSON object');
  for (const key of Object.keys(list)) if (!['version', 'files', 'units', 'cosign'].includes(key)) fail(`unknown key ${key}`);
  if (!/^\d+\.\d+\.\d+$/.test(list.version ?? '')) fail('version must be X.Y.Z');
  const seen = new Set(), hashes = name => {
    if (!Array.isArray(list[name])) fail(`${name} must be an array of paths`);
    return Object.fromEntries(list[name].map(path => {
      if (typeof path !== 'string' || !/^[\w.@-]+(\/[\w.@-]+)*$/.test(path) || path.split('/').some(part => part === '.' || part === '..')) fail(`${JSON.stringify(path)} is not a relative path`);
      if (seen.has(path)) fail(`${path} is listed twice`); seen.add(path);
      let url; try { url = repositoryFile(root, path); } catch (error) { fail(error.message); }
      return [path, createHash('sha256').update(readFileSync(url)).digest('hex')];
    }));
  };
  const block = { version: list.version, files: hashes('files'), units: hashes('units') };
  if (list.cosign !== undefined) {
    const { version, sha256, ...rest } = list.cosign || {}, arches = Object.entries(sha256 || {});
    if (Object.keys(rest).length || !/^v\d+\.\d+\.\d+$/.test(version || '')) fail('cosign must be { version: "vX.Y.Z", sha256 }');
    if (!arches.length || arches.some(([arch, hash]) => !/^linux-(amd64|arm64)$/.test(arch) || !/^[a-f0-9]{64}$/.test(hash))) fail('cosign sha256 maps linux-amd64 or linux-arm64 to 64 hex');
    block.cosign = { version, sha256: Object.fromEntries(arches) };
  }
  return block;
}

export function manifest({ version, tag, commit, repository, image = '', digest = '' }, root = new URL('..', import.meta.url)) {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  // There are no public release candidates, so the manifest is only ever made for a final version.
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('--version must be a final X.Y.Z; release candidates are not published');
  if (pkg.version !== version) throw new Error(`package.json is ${pkg.version} but the release is ${version}; bump it before tagging`);
  if ((tag ?? `v${version}`) !== `v${version}`) throw new Error(`--tag must be v${version}`);
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('--commit must be the full 40-character commit SHA of the tag');
  if (!/^[A-Za-z0-9-]+\/[\w.-]+$/.test(repository || '')) throw new Error('--repository must be OWNER/NAME');
  if (digest && !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('--digest must be sha256:<64 hex>');
  if (!image !== !digest) throw new Error('--image and --digest go together');
  let files = []; try { files = readdirSync(new URL('docs/releases/', root)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const notes = releaseNotes(version, files);
  let highlights = null;
  if (notes) {
    let url; try { url = repositoryFile(root, notes); } catch (error) { throw new Error(`${notes}: ${error.message}`); }
    const text = readFileSync(url);
    if (text.length > MAX_BYTES) throw new Error(`${notes} is larger than 64 KiB`);
    try { ({ highlights } = frontMatter(text.toString('utf8'))); } catch (error) { throw new Error(`${notes}: ${error.message}`); }
  }
  const result = { version, tag: `v${version}`, commit, repository, prerelease: false, schemaVersion, minUpgradeFrom: pkg.docknest?.minUpgradeFrom || null,
    image: { name: image || null, digest: digest || null }, notes, ...(highlights && { highlights }), updater: updaterBlock(root) };
  if (Buffer.byteLength(JSON.stringify(result, null, 2)) > MAX_BYTES) throw new Error('the manifest is larger than 64 KiB');
  return result;
}

// What the host verifier checks after the signature (threat model section 5, step 4), run on the published copy.
export function checkManifest(text, { version, commit, repository, digest = '' }) {
  const value = JSON.parse(text), problems = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest refused: not a JSON object');
  const unknown = Object.keys(value).filter(key => !KEYS.includes(key)), missing = KEYS.filter(key => key !== 'highlights' && !(key in value));
  if (unknown.length) problems.push(`unknown keys ${unknown.join(', ')}`);
  if (missing.length) problems.push(`missing keys ${missing.join(', ')}`);
  if (value.version !== version || value.tag !== `v${version}`) problems.push(`version or tag is not ${version}`);
  if (value.commit !== commit) problems.push(`commit is not ${commit}`);
  if (value.repository !== repository) problems.push(`repository is not ${repository}`);
  if (value.prerelease !== false) problems.push('prerelease is not false');
  if (digest && value.image?.digest !== digest) problems.push(`image digest is not ${digest}`);
  if (problems.length) throw new Error(`manifest refused: ${problems.join('; ')}`);
  return value;
}

if (process.argv[1]?.endsWith('release-manifest.js')) {
  const options = Object.fromEntries(['version', 'tag', 'commit', 'repository', 'image', 'digest', 'check', 'notes-body'].map(name => [name, { type: 'string' }]));
  try {
    const { values } = parseArgs({ options });
    if (values['notes-body']) process.stdout.write(frontMatter(readFileSync(values['notes-body'], 'utf8')).body);
    else if (values.check) { checkManifest(readFileSync(values.check, 'utf8'), values); console.log(`${values.check} matches ${values.version} at ${values.commit}`); }
    else console.log(JSON.stringify(manifest(values), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
