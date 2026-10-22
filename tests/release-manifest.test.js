import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UPDATER_LIST, checkManifest, frontMatter, manifest, releaseNotes, updaterBlock } from '../scripts/release-manifest.js';
import { schemaVersion } from '../src/migrations.js';

const commit = 'c'.repeat(40), digest = 'sha256:' + 'a'.repeat(64), repository = 'DahanItamar/DockNest';
const release = { version: '2.2.0', commit, repository, image: 'ghcr.io/dahanitamar/docknest', digest };
const highlights = '---\nsecurity: true\nfeatures: 3\nimprovements: 0\nfixes: 12\n---\n';
const sha256 = text => createHash('sha256').update(text).digest('hex');

// A throwaway repository root: package.json, optional notes and optional updater files.
function fixture(t, { notes = '# DockNest 2.2\n', files = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'docknest-release-manifest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, text) => { mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); writeFileSync(path.join(dir, name), text); };
  write('package.json', JSON.stringify({ version: '2.2.0', docknest: { minUpgradeFrom: '2.0.0' } }));
  if (notes !== null) write('docs/releases/2026-11-02-v2.2.md', notes);
  for (const [name, text] of Object.entries(files)) write(name, text);
  return { dir, root: pathToFileURL(dir + path.sep), write };
}

test('release manifest carries the signed identity fields, schema, upgrade floor, image, notes and updater block', t => {
  const { root } = fixture(t), result = manifest(release, root);
  assert.deepEqual(Object.keys(result), ['version', 'tag', 'commit', 'repository', 'prerelease', 'schemaVersion', 'minUpgradeFrom', 'image', 'notes', 'updater']);
  assert.deepEqual(result, { version: '2.2.0', tag: 'v2.2.0', commit, repository, prerelease: false, schemaVersion, minUpgradeFrom: '2.0.0',
    image: { name: release.image, digest }, notes: 'docs/releases/2026-11-02-v2.2.md', updater: { version: null, files: {}, units: {} } });
  assert.equal('schemaFloor' in result, false);
  assert.deepEqual(manifest({ ...release, tag: 'v2.2.0', image: '', digest: '' }, root).image, { name: null, digest: null });
  assert.equal(manifest(release, fixture(t, { notes: null }).root).notes, null);
});

test('release manifest refuses anything that is not a final, bumped, fully identified release', t => {
  const { root } = fixture(t);
  assert.throws(() => manifest({ ...release, version: '2.2.0-rc.1' }, root), /final X\.Y\.Z; release candidates are not published/);
  assert.throws(() => manifest({ ...release, version: '2.3.0' }, root), /bump it before tagging/);
  assert.throws(() => manifest({ ...release, tag: 'v2.2.1' }, root), /--tag must be v2\.2\.0/);
  for (const bad of [undefined, 'abc1234', 'C'.repeat(40), `${commit}\n`]) assert.throws(() => manifest({ ...release, commit: bad }, root), /--commit/);
  for (const bad of [undefined, 'DockNest', 'a/b/c', 'own er/x']) assert.throws(() => manifest({ ...release, repository: bad }, root), /--repository/);
  assert.throws(() => manifest({ ...release, digest: 'latest' }, root), /--digest/);
  assert.throws(() => manifest({ ...release, digest: '' }, root), /--image and --digest go together/);
  // The real repository still produces a manifest for its own version.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest({ version: pkg.version, commit, repository }).prerelease, false);
});

test('release notes resolve to the exact dated version file, or the minor file for X.Y.0 and its release candidates', () => {
  const files = ['2026-10-03-dark-mode.md', '2026-10-17-v2.0.md', '2026-11-02-v2.1.0.md', '2026-11-09-v2.1.1.md', 'v2.3.md', 'draft-v2.4.0.md'];
  assert.equal(releaseNotes('2.0.0', files), 'docs/releases/2026-10-17-v2.0.md');
  assert.equal(releaseNotes('2.0.1', files), null);
  assert.equal(releaseNotes('2.1.0', files), 'docs/releases/2026-11-02-v2.1.0.md');
  assert.equal(releaseNotes('2.1.1', files), 'docs/releases/2026-11-09-v2.1.1.md');
  assert.equal(releaseNotes('2.2.0-rc.1', files), null);
  assert.equal(releaseNotes('2.0.0-rc.1', files), 'docs/releases/2026-10-17-v2.0.md');
  assert.equal(releaseNotes('2.0.1-rc.1', files), null);
  // Only the dated name the host verifier accepts counts (threat model D20 path rule).
  assert.equal(releaseNotes('2.3.0', files), null); assert.equal(releaseNotes('2.4.0', files), null);
});

test('highlights front matter is parsed strictly and becomes the manifest highlights', t => {
  assert.deepEqual(frontMatter(highlights + '# DockNest 2.2\n'), { highlights: { security: true, features: 3, improvements: 0, fixes: 12 }, body: '# DockNest 2.2\n' });
  // Any key order and CRLF line endings; the result has a fixed key order and the body keeps no front matter.
  const reordered = frontMatter('---\r\nfixes: 99\r\nsecurity: false\r\nimprovements: 1\r\nfeatures: 0\r\n---\r\n\r\n# Notes\r\n');
  assert.deepEqual(reordered, { highlights: { security: false, features: 0, improvements: 1, fixes: 99 }, body: '# Notes\n' });
  assert.deepEqual(Object.keys(reordered.highlights), ['security', 'features', 'improvements', 'fixes']);
  const result = manifest(release, fixture(t, { notes: highlights + '# DockNest 2.2\n' }).root);
  assert.deepEqual(result.highlights, { security: true, features: 3, improvements: 0, fixes: 12 });
  assert.deepEqual(Object.keys(result).slice(-2), ['highlights', 'updater']);
  // The template ships valid front matter, so a copied notes file publishes.
  assert.deepEqual(frontMatter(readFileSync(new URL('../docs/releases/TEMPLATE.md', import.meta.url), 'utf8')).highlights, { security: false, features: 0, improvements: 0, fixes: 0 });
});

test('absent front matter gives no highlights and leaves the notes unchanged', t => {
  assert.deepEqual(frontMatter('# DockNest 2.2\n\n---\n\nsecurity: true\n'), { highlights: null, body: '# DockNest 2.2\n\n---\n\nsecurity: true\n' });
  assert.equal('highlights' in manifest(release, fixture(t).root), false);
  for (const name of ['2026-10-17-v2.0.md', '2026-10-22-v2.1.md']) assert.equal(frontMatter(readFileSync(new URL(`../docs/releases/${name}`, import.meta.url), 'utf8')).highlights, null, name);
});

test('malformed front matter fails the release with the notes file named', t => {
  const body = lines => `---\n${lines.join('\n')}\n---\n# Notes\n`, all = ['security: true', 'features: 1', 'improvements: 2', 'fixes: 3'];
  const invalid = {
    'not closed': '---\nsecurity: true\nfeatures: 1\nimprovements: 2\nfixes: 3\n# Notes\n',
    'trailing space on the opening line': '--- \n' + all.join('\n') + '\n---\n',
    'empty block': '---\n---\n# Notes\n',
    'unknown key': body([...all, 'breaking: 1']),
    'duplicate key': body([...all, 'fixes: 4']),
    'missing key': body(all.slice(0, 3)),
    'quoted boolean': body(['security: "true"', ...all.slice(1)]),
    'yes as boolean': body(['security: yes', ...all.slice(1)]),
    'number 100': body([...all.slice(0, 3), 'fixes: 100']),
    'negative number': body([...all.slice(0, 3), 'fixes: -1']),
    'leading zero': body([...all.slice(0, 3), 'fixes: 07']),
    'decimal': body([...all.slice(0, 3), 'fixes: 1.5']),
    'comment': body([...all.slice(0, 3), 'fixes: 3 # three']),
    'blank line': body(['', ...all]),
    'no space after colon': body([...all.slice(0, 3), 'fixes:3']),
    'upper-case key': body([...all.slice(0, 3), 'Fixes: 3']),
    'indented line': body([...all.slice(0, 3), '  fixes: 3']),
  };
  for (const [name, text] of Object.entries(invalid)) assert.throws(() => frontMatter(text), /front matter/, name);
  assert.throws(() => manifest(release, fixture(t, { notes: invalid['number 100'] }).root), /^Error: docs\/releases\/2026-11-02-v2\.2\.md: front matter fixes must be a whole number from 0 to 99$/);
  assert.throws(() => manifest(release, fixture(t, { notes: '# Notes\n' + 'x'.repeat(65536) }).root), /larger than 64 KiB/);
});

test('updater block is empty without a file list and hashes every listed file when there is one', t => {
  assert.deepEqual(updaterBlock(fixture(t).root), { version: null, files: {}, units: {} });
  const broker = '#!/usr/bin/env python3\nprint("broker")\n', unit = '[Unit]\nDescription=DockNest updater\n';
  const list = { version: '1.0.0', files: ['updater/broker.py'], units: ['updater/systemd/docknest-updater.service'], cosign: { version: 'v3.0.5', sha256: { 'linux-amd64': 'b'.repeat(64) } } };
  const { root } = fixture(t, { files: { 'updater/broker.py': broker, 'updater/systemd/docknest-updater.service': unit, [UPDATER_LIST]: JSON.stringify(list) } });
  const expected = { version: '1.0.0', files: { 'updater/broker.py': sha256(broker) }, units: { 'updater/systemd/docknest-updater.service': sha256(unit) }, cosign: list.cosign };
  assert.deepEqual(updaterBlock(root), expected);
  assert.deepEqual(manifest(release, root).updater, expected);
  // An existing but still empty list is valid: version only, nothing to self-update yet.
  assert.deepEqual(updaterBlock(fixture(t, { files: { [UPDATER_LIST]: '{"version":"1.0.0","files":[],"units":[]}' } }).root), { version: '1.0.0', files: {}, units: {} });
});

test('updater block fails closed on missing files and malformed lists', t => {
  const { root, write } = fixture(t, { files: { 'updater/broker.py': 'x', 'updater/dir/keep': 'x' } });
  const list = value => { write(UPDATER_LIST, typeof value === 'string' ? value : JSON.stringify(value)); return () => updaterBlock(root); };
  const valid = { version: '1.0.0', files: ['updater/broker.py'], units: [] };
  assert.throws(list({ ...valid, files: ['updater/broker.py', 'updater/verifier.py'] }), /updater\/verifier\.py is listed but does not exist/);
  assert.throws(list({ ...valid, units: ['updater/docknest-updater.service'] }), /does not exist/);
  assert.throws(list({ ...valid, files: ['updater/dir'] }), /not a regular file/);
  assert.throws(list({ ...valid, units: ['updater/broker.py'] }), /listed twice/);
  for (const bad of ['../package.json', '/etc/passwd', 'updater\\broker.py', 'updater/./broker.py', 'updater//broker.py', '', 7]) assert.throws(list({ ...valid, files: [bad] }), /is not a relative path/, String(bad));
  assert.throws(list('{"version":'), new RegExp(UPDATER_LIST.replace(/[./]/g, '\\$&')));
  assert.throws(list([]), /must be a JSON object/);
  assert.throws(list({ ...valid, extra: 1 }), /unknown key extra/);
  assert.throws(list({ ...valid, version: 'v1.0.0' }), /version must be X\.Y\.Z/);
  assert.throws(list({ files: [], units: [] }), /version must be X\.Y\.Z/);
  assert.throws(list({ ...valid, units: undefined }), /units must be an array/);
  assert.throws(list({ ...valid, cosign: { version: '3.0.5', sha256: { 'linux-amd64': 'b'.repeat(64) } } }), /cosign must be/);
  assert.throws(list({ ...valid, cosign: { version: 'v3.0.5', sha256: {} } }), /cosign sha256/);
  assert.throws(list({ ...valid, cosign: { version: 'v3.0.5', sha256: { 'darwin-arm64': 'b'.repeat(64) } } }), /cosign sha256/);
  assert.throws(list({ ...valid, cosign: { version: 'v3.0.5', sha256: { 'linux-amd64': 'B'.repeat(64) } } }), /cosign sha256/);
  assert.throws(() => manifest(release, root), /cosign sha256/, 'a broken list fails the whole manifest');
});

test('a published manifest is refused unless it names this version, commit, repository and digest as a final release', t => {
  const text = JSON.stringify(manifest(release, fixture(t).root)), expected = { version: '2.2.0', commit, repository, digest };
  assert.equal(checkManifest(text, expected).commit, commit);
  const tampered = change => () => checkManifest(JSON.stringify({ ...JSON.parse(text), ...change }), expected);
  assert.throws(tampered({ commit: 'd'.repeat(40) }), /commit is not/);
  assert.throws(tampered({ tag: 'v2.1.0' }), /version or tag/);
  assert.throws(tampered({ repository: 'someone/DockNest' }), /repository is not/);
  assert.throws(tampered({ prerelease: true }), /prerelease is not false/);
  assert.throws(tampered({ prerelease: undefined }), /prerelease is not false/);
  assert.throws(tampered({ image: { name: release.image, digest: 'sha256:' + 'f'.repeat(64) } }), /image digest/);
});

test('the command line prints notes without front matter and checks a written manifest', t => {
  const { dir } = fixture(t, { files: { 'notes.md': highlights + '# DockNest 2.2\n' } }), script = fileURLToPath(new URL('../scripts/release-manifest.js', import.meta.url));
  assert.equal(execFileSync(process.execPath, [script, '--notes-body', path.join(dir, 'notes.md')], { encoding: 'utf8' }), '# DockNest 2.2\n');
  const file = path.join(dir, 'docknest-release.json'), run = (...args) => execFileSync(process.execPath, [script, '--check', file, ...args], { encoding: 'utf8', stdio: 'pipe' });
  writeFileSync(file, JSON.stringify(manifest(release, fixture(t).root), null, 2));
  assert.match(run('--version', '2.2.0', '--commit', commit, '--repository', repository, '--digest', digest), /matches 2\.2\.0/);
  assert.throws(() => run('--version', '2.2.0', '--commit', 'e'.repeat(40), '--repository', repository), /commit is not/);
});
