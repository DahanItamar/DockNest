import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile, readdir, stat, symlink, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

// Drives scripts/upgrade.sh against a throwaway git history and a `docker compose` test double.
// Real containers, volumes and migrations are covered by the CI upgrade job and the Linux server checklist.
const shell = spawnSync('sh', ['-c', 'exit 0']).status === 0;
const script = new URL('../scripts/upgrade.sh', import.meta.url), fake = new URL('./fixtures/fake-docker.sh', import.meta.url);
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' }).trim();
const pkg = (version, min) => JSON.stringify({ name: 'docknest', version, private: true, ...(min ? { docknest: { minUpgradeFrom: min } } : {}) }, null, 2) + '\n';
const fakeId = version => 'sha256:' + createHash('sha256').update(version).digest('hex'); // the test double's image IDs
const migrations = versions => 'export const migrations = [\n' + versions.map(version => `  { version: ${Math.abs(version)}, name: 'm${Math.abs(version)}',${version < 0 ? ' compatible: true,' : ''} up: () => {} },\n`).join('') + '];\n';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'docknest-upgrade-')), origin = join(root, 'origin'), work = join(root, 'docknest'), state = join(root, 'state'), bin = join(root, 'bin');
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([origin, state, bin].map(path => mkdir(path)));
  git(origin, 'init', '-q', '-b', 'main');
  await mkdir(join(origin, 'scripts')); await mkdir(join(origin, 'src'));
  await copyFile(script, join(origin, 'scripts/upgrade.sh'));
  await writeFile(join(origin, 'compose.yaml'), 'name: docknest\n');
  await writeFile(join(origin, '.gitignore'), 'data/\n.env\ncompose.override.yaml\n');
  const release = async (tag, version, min, schema) => {
    await writeFile(join(origin, 'package.json'), pkg(version, min));
    if (schema) await writeFile(join(origin, 'src/migrations.js'), migrations(schema));
    git(origin, 'add', '-A'); git(origin, 'commit', '-q', '-m', tag); git(origin, 'tag', tag);
  };
  await release('v2.0.0', '2.0.0');
  await release('v2.1.0', '2.1.0', '2.0.0', [1, -2]); // negative = compatible (additive) migration
  await release('v2.2.0-rc.1', '2.2.0-rc.1', '2.1.0', [1, -2, 3]);
  git(root, 'clone', '-q', origin, work); git(work, 'checkout', '-q', 'v2.0.0');
  await mkdir(join(work, 'data'));
  await writeFile(join(work, 'data/master.key'), 'fixture-key\n'); await writeFile(join(work, 'data/setup.token'), 'fixture-token\n');
  await writeFile(join(work, '.env'), 'APP_ORIGIN=https://docknest.example.invalid\n');
  await writeFile(join(bin, 'docker'), `#!/bin/sh\nexec sh '${new URL(fake).pathname.replace(/^\/([A-Za-z]:)/, '$1')}' "$@"\n`, { mode: 0o755 });
  await writeFile(join(state, 'running'), 'up\n'); await writeFile(join(state, 'version'), '2.0.0\n'); await writeFile(join(state, 'schema'), '0\n');
  const argv = args => [join(work, 'scripts/upgrade.sh'), '--non-interactive', '--timeout', '0', '--wait', '0', '--status-file', join(root, 'status.json'), ...args];
  const env = { ...process.env, PATH: bin + delimiter + process.env.PATH, FAKE_STATE: state, DOCKNEST_DIR: '' };
  const exec = (args, extra = {}) => spawnSync('sh', argv(args), { cwd: work, encoding: 'utf8', env: { ...env, ...extra } });
  const start = args => spawn('sh', argv(args), { cwd: work, env });
  const run = (...args) => exec(args);
  const read = async name => (await readFile(join(state, name), 'utf8').catch(() => '')).trim();
  const status = async () => JSON.parse(await readFile(join(root, 'status.json'), 'utf8'));
  const backups = async () => (await readdir(join(work, 'data/upgrade-backups')).catch(() => [])).sort();
  return { root, work, state, run, exec, start, bin, read, status, backups, head: () => git(work, 'describe', '--tags', '--always') };
}
// An upgrade backup as earlier runs leave it: previous-release with an image ID, and a result marker unless legacy.
async function seed(f, name, { result, imageId = '' } = {}) {
  const dir = join(f.work, 'data/upgrade-backups', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'previous-release'), `commit=0\nversion=1.0.0\nschema=1\nimage=\nimageId=${imageId}\n`);
  if (result !== undefined) await writeFile(join(dir, 'result'), result);
  return dir;
}
// Images the test double already holds: [version, ...tags].
const images = (f, list) => Promise.all([
  writeFile(join(f.state, 'store'), list.map(([version]) => `${fakeId(version)} ${version}\n`).join('')),
  writeFile(join(f.state, 'tags'), list.flatMap(([version, ...tags]) => tags.map(tag => `${tag} ${fakeId(version)}\n`)).join(''))
]);

test('upgrades to the newest final release, keeps a rollback copy and releases the hold', { skip: !shell }, async t => {
  const f = await fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(f.head(), 'v2.1.0', 'pre-releases are never selected by default');
  assert.equal(await f.read('version'), '2.1.0'); assert.equal(await f.read('schema'), '2'); assert.equal(await f.read('hold'), 'false');
  const status = await f.status();
  assert.equal(status.phase, 'done'); assert.equal(status.ok, true); assert.equal(status.error, null);
  assert.equal(status.from, '2.0.0'); assert.equal(status.to, '2.1.0'); assert.match(status.startedAt, /^\d{4}-\d\d-\d\dT/);
  const [saved] = await readdir(join(f.work, 'data/upgrade-backups'));
  assert.match(saved, /-2\.0\.0-to-2\.1\.0$/);
  assert.deepEqual((await readdir(join(f.work, 'data/upgrade-backups', saved))).sort(), ['.env', 'master.key', 'previous-release', 'result', 'setup.token']);
  assert.equal(await readFile(join(f.work, 'data/upgrade-backups', saved, 'result'), 'utf8'), 'format=1\nexit=0\n', 'marker format, then the exit code');
  assert.match(await readFile(join(f.work, 'data/upgrade-backups', saved, 'previous-release'), 'utf8'), new RegExp(`imageId=${fakeId('2.0.0')}\n`), 'source mode records the previous image ID too');
  assert.equal(status.warning, null);
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(f.work, 'data/upgrade-backups', saved))).mode & 0o777, 0o700, 'saved secrets stay private');
    assert.equal((await stat(join(f.work, 'data/upgrade-backups', saved, 'previous-release'))).mode & 0o077, 0);
    assert.equal((await stat(join(f.root, 'status.json'))).mode & 0o777, 0o644, 'status is readable by the unprivileged API');
  }
  const calls = await f.read('calls');
  assert.ok(calls.indexOf('deployment-preflight.js hold') < calls.indexOf('compose stop worker'));
  assert.ok(calls.indexOf('compose build') < calls.indexOf('compose stop worker'), 'the old release keeps serving while the new image builds');
  assert.equal(f.run().status, 0, 'running again on the current release is a no-op');
});

test('refuses edited tracked files, busy queues and unsupported upgrade paths without changing anything', { skip: !shell }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.work, 'compose.yaml'), 'name: edited\n');
  let result = f.run();
  assert.equal(result.status, 2); assert.match(result.stderr, /compose\.override\.yaml/);
  assert.equal((await f.status()).ok, false);
  git(f.work, 'checkout', '--', 'compose.yaml');
  await writeFile(join(f.state, 'busy'), '');
  result = f.run();
  assert.equal(result.status, 3); assert.equal(f.head(), 'v2.0.0'); assert.equal(await f.read('version'), '2.0.0');
  await rm(join(f.state, 'busy'));
  result = f.run('--version', 'v2.2.0-rc.1');
  assert.equal(result.status, 2); assert.match(result.stderr, /from 2\.1\.0 or later/);
  result = f.run('--version', 'v9.9.9');
  assert.equal(result.status, 2); assert.match(result.stderr, /does not exist/);
  assert.equal(f.head(), 'v2.0.0'); assert.ok(!existsSync(join(f.work, 'data/upgrade-backups')));
});

test('a failed build or an unhealthy start before migration returns to the previous release automatically', { skip: !shell }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.state, 'fail-build'), '');
  let result = f.run('--version', 'v2.1.0');
  assert.equal(result.status, 4); assert.equal(f.head(), 'v2.0.0'); assert.equal(await f.read('version'), '2.0.0'); assert.equal(await f.read('hold'), 'false');
  await rm(join(f.state, 'fail-build'));
  await writeFile(join(f.state, 'unhealthy'), '2.1.0'); await writeFile(join(f.state, 'no-migrate'), '');
  result = f.run('--version', 'v2.1.0');
  assert.equal(result.status, 4, result.stderr); assert.match(result.stderr, /2\.0\.0 was restored automatically/);
  assert.equal(f.head(), 'v2.0.0'); assert.equal(await f.read('version'), '2.0.0'); assert.equal(await f.read('hold'), 'false');
  const status = await f.status(); assert.equal(status.ok, false); assert.equal(status.phase, 'failed');
});

test('an unhealthy start after an incompatible migration stops with exact rollback commands instead of guessing', { skip: !shell }, async t => {
  const f = await fixture(t);
  assert.equal(f.run('--version', 'v2.1.0').status, 0);
  await writeFile(join(f.state, 'unhealthy'), '2.2.0-rc.1');
  const result = f.run('--version', 'v2.2.0-rc.1');
  assert.equal(result.status, 5, result.stderr);
  assert.equal(f.head(), 'v2.2.0-rc.1', 'code stays on the migrated release'); assert.equal(await f.read('schema'), '3');
  const status = await f.status();
  assert.equal(status.ok, false); assert.match(status.rollbackHint, /state-v2-to-v3-\*\.sqlite/);
  assert.ok(status.rollbackHint.includes(`git checkout ${git(f.work, 'rev-parse', 'v2.1.0^{commit}')} && docker tag ${fakeId('2.1.0')} docknest:local && docker compose up -d --no-build`), status.rollbackHint);
  assert.equal(await f.read('restores'), ''); assert.equal(await f.read('removed'), '', 'nothing is pruned after exit 5');
  const failed = (await f.backups()).find(name => name.endsWith('-2.1.0-to-2.2.0-rc.1'));
  assert.equal(await readFile(join(f.work, 'data/upgrade-backups', failed, 'result'), 'utf8'), 'format=1\nexit=5\n');
});

test('A10: an unhealthy start after a compatible-only migration returns to the previous release with exit 4', { skip: !shell }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.state, 'unhealthy'), '2.1.0'); // v2.0.0 runs on schema 2: migration 1 is its own schema, 2 is compatible
  const result = f.run('--version', 'v2.1.0');
  assert.equal(result.status, 4, result.stderr + result.stdout);
  assert.match(result.stderr, /2\.0\.0 was restored automatically and runs on the migrated metadata/);
  assert.equal(f.head(), 'v2.0.0'); assert.equal(await f.read('version'), '2.0.0'); assert.equal(await f.read('hold'), 'false');
  assert.equal(await f.read('schema'), '2', 'the migrated metadata is kept, nothing is restored'); assert.equal(await f.read('restores'), '');
  // Source mode: back to the recorded image by re-tagging it, without a rebuild; then the failed build is removed.
  const calls = await f.read('calls');
  assert.match(calls, new RegExp(`^tag ${fakeId('2.0.0')} docknest:local `, 'm')); assert.match(calls, /^compose up -d --no-build api worker /m);
  assert.equal(calls.match(/^compose build /gm).length, 1, 'no rebuild of the previous release');
  assert.equal(await f.read('removed'), fakeId('2.1.0'), 'exit 4 removes the image this run built');
  const status = await f.status(); assert.equal(status.ok, false); assert.equal(status.phase, 'failed'); assert.equal(status.warning, null);
});

test('manual CLI downgrade still works: additive migrations need no snapshot; incompatible ones need an accepted matching snapshot', { skip: !shell }, async t => {
  const f = await fixture(t);
  assert.equal(f.run('--version', 'v2.1.0').status, 0);
  let result = f.run('--version', 'v2.0.0');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /only adds compatible objects/); assert.equal(f.head(), 'v2.0.0'); assert.equal(await f.read('restores'), '');
  assert.equal((await f.status()).phase, 'done'); assert.equal(await f.read('version'), '2.0.0'); assert.equal((await f.backups()).length, 2, 'retention after a downgrade keeps the recent backups');
  assert.equal(f.run('--version', 'v2.1.0').status, 0);
  assert.equal(f.run('--version', 'v2.2.0-rc.1').status, 0);
  assert.equal(await f.read('schema'), '3');
  result = f.run('--version', 'v2.1.0');
  assert.equal(result.status, 2); assert.match(result.stderr, /no matching snapshot/);
  await writeFile(join(f.state, 'snapshots'), 'state-v1-to-v3-20261021T080000000Z.sqlite\nstate-v2-to-v3-20261022T080000000Z.sqlite\nstate-v0-to-v2-20261023T080000000Z.sqlite\nnotes.txt\n');
  result = f.run('--version', 'v2.1.0');
  assert.equal(result.status, 2); assert.match(result.stderr, /--allow-data-rollback/);
  assert.equal(f.head(), 'v2.2.0-rc.1');
  result = f.run('--version', 'v2.1.0', '--allow-data-rollback');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(f.head(), 'v2.1.0');
  assert.match(await f.read('restores'), /state-v2-to-v3-20261022T080000000Z\.sqlite/);
});

test('any unexpected failure after the hold releases it, restores the checkout and writes a final failed status', { skip: !shell }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.state, 'fail-stop'), '');
  let result = f.run('--version', 'v2.1.0');
  assert.equal(result.status, 4, result.stderr + result.stdout);
  assert.equal(f.head(), 'v2.0.0'); assert.equal(await f.read('hold'), 'false'); assert.equal(await f.read('version'), '2.0.0');
  let status = await f.status();
  assert.equal(status.ok, false); assert.equal(status.phase, 'failed'); assert.match(status.error, /Unexpected failure/);
  await rm(join(f.state, 'fail-stop'));
  await rm(join(f.work, 'data/upgrade-backups'), { recursive: true, force: true });
  await writeFile(join(f.work, 'data/upgrade-backups'), 'not a directory');
  result = f.run('--version', 'v2.1.0');
  assert.equal(result.status, 2); assert.equal(await f.read('hold'), 'false'); assert.equal(f.head(), 'v2.0.0');
  status = await f.status(); assert.equal(status.ok, false); assert.notEqual(status.ok, null);
  // Migrated metadata plus a failing stop must not be reverted automatically.
  await rm(join(f.work, 'data/upgrade-backups'));
  await writeFile(join(f.state, 'fail-stop'), ''); await writeFile(join(f.state, 'migrate-on-stop'), '');
  result = f.run('--version', 'v2.1.0');
  assert.equal(result.status, 5); assert.equal(f.head(), 'v2.1.0'); assert.equal((await f.status()).ok, false);
});

test('dry run is read-only; offline and spaced paths work; the environment cannot choose what is deleted', { skip: !shell }, async t => {
  const f = await fixture(t);
  git(f.work, 'remote', 'set-url', 'origin', join(f.root, 'gone'));
  const known = git(f.work, 'rev-parse', 'v2.1.0^{commit}');
  git(f.work, 'tag', '-d', 'v2.1.0'); // only known to the unreachable origin now
  const dry = f.run('--version', 'v2.1.0', '--dry-run');
  assert.equal(dry.status, 2); assert.match(dry.stderr, /does not exist locally/);
  assert.ok(!existsSync(join(f.root, 'status.json')), 'dry run writes no status'); assert.equal(await f.read('hold'), '');
  git(f.work, 'tag', 'v2.1.0', known); // already local: offline is fine
  const offline = f.run('--version', 'v2.1.0');
  assert.equal(offline.status, 0, offline.stderr + offline.stdout); assert.match(offline.stderr, /git fetch failed; continuing/);
  const victim = join(f.root, 'victim.txt'); await writeFile(victim, 'keep');
  assert.equal(f.exec(['--version', 'v2.0.0', '--dry-run'], { DOCKNEST_UPGRADE_COPY: victim }).status, 0);
  assert.equal(await readFile(victim, 'utf8'), 'keep');
  const spaced = join(f.root, 'my docknest dir'); execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '-q', join(f.root, 'origin'), spaced]);
  git(spaced, 'checkout', '-q', 'v2.0.0'); await mkdir(join(spaced, 'data')); await writeFile(join(spaced, 'data/master.key'), 'k\n'); await writeFile(join(spaced, 'data/setup.token'), 't\n');
  const result = spawnSync('sh', [join(spaced, 'scripts/upgrade.sh'), '--non-interactive', '--dry-run', '--version', 'v2.1.0'], { cwd: spaced, encoding: 'utf8', env: { ...process.env, PATH: f.bin + delimiter + process.env.PATH, FAKE_STATE: f.state, DOCKNEST_DIR: '' } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test('the script reads the schema version and compatibility floor from the real migrations file', { skip: !shell }, async () => {
  const { schemaVersion, migrations: list, compatFloor } = await import('../src/migrations.js'), root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const result = spawnSync('sh', [join(root, 'scripts/upgrade.sh'), '--print-schema'], { cwd: root, encoding: 'utf8', env: { ...process.env, DOCKNEST_DIR: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `${schemaVersion} ${compatFloor(list)}`);
});

test('a status file path that is a link is never written through', { skip: !shell || process.platform === 'win32' }, async t => {
  const f = await fixture(t), victim = join(f.root, 'victim.txt'), link = join(f.root, 'status.json');
  await writeFile(victim, 'keep'); await symlink(victim, link);
  const result = f.run('--version', 'v2.1.0');
  assert.equal(result.status, 0, result.stderr); assert.match(result.stderr, /not writing/);
  assert.equal(await readFile(victim, 'utf8'), 'keep');
  assert.deepEqual((await readdir(f.root)).filter(name => name.startsWith('.status.')), []);
});

test('image mode switches only the tag per command, rolls back to the recorded image and persists .env after success', { skip: !shell }, async t => {
  const f = await fixture(t), env = join(f.work, '.env');
  await writeFile(join(f.state, 'image-mode'), '');
  await writeFile(env, 'APP_ORIGIN=https://docknest.example.invalid\nDOCKNEST_IMAGE=ghcr.io/example/docknest:2.0.0\n');
  // The new image never becomes healthy and the metadata is untouched: roll back by image id, not by the .env tag.
  await writeFile(join(f.state, 'unhealthy'), '2.1.0'); await writeFile(join(f.state, 'no-migrate'), '');
  let result = f.run('--version', 'v2.1.0');
  assert.equal(result.status, 4, result.stderr + result.stdout);
  let calls = await f.read('calls');
  assert.match(calls, /pull api worker IMG=ghcr\.io\/example\/docknest:2\.1\.0/);
  assert.ok(calls.includes(`up -d --pull never api worker IMG=${fakeId('2.0.0')}`), 'rollback uses the recorded image id');
  assert.equal(await f.read('version'), '2.0.0'); assert.match(await readFile(env, 'utf8'), /DOCKNEST_IMAGE=ghcr\.io\/example\/docknest:2\.0\.0/);
  assert.equal(await f.read('removed'), fakeId('2.1.0'), 'exit 4 removes the image this run pulled');
  const [saved] = await readdir(join(f.work, 'data/upgrade-backups'));
  assert.ok((await readFile(join(f.work, 'data/upgrade-backups', saved, 'previous-release'), 'utf8')).includes(`image=ghcr.io/example/docknest:2.0.0\nimageId=${fakeId('2.0.0')}\n`));
  await rm(join(f.state, 'unhealthy')); await rm(join(f.state, 'no-migrate'));
  result = f.run('--version', 'v2.1.0');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(await readFile(env, 'utf8'), /^DOCKNEST_IMAGE=ghcr\.io\/example\/docknest:2\.1\.0$/m); assert.match(await readFile(env, 'utf8'), /APP_ORIGIN/);
  assert.equal((await f.status()).rollbackHint.includes(fakeId('2.0.0')), true);
  assert.equal(await f.read('removed'), fakeId('2.1.0'), 'the running and the previous image are never removed');
  await writeFile(env, 'DOCKNEST_IMAGE=ghcr.io/example/docknest@sha256:' + 'a'.repeat(64) + '\n');
  result = f.run('--version', 'v2.0.0');
  assert.equal(result.status, 2); assert.match(result.stderr, /pinned by digest/);
});

const forbidden = /image prune|system prune|builder prune|image rm (-f|--force)/;
const win32 = process.platform === 'win32';

test('retention after a success keeps the newest 5 backups and every run that needs manual action, and removes only recorded images of this repository', { skip: !shell }, async t => {
  const f = await fixture(t), dir = join(f.work, 'data/upgrade-backups');
  await writeFile(join(f.state, 'has-prune'), '');
  await images(f, [['1.0.0'], ['1.1.0', 'docknest:old'], ['1.2.0'], ['1.3.0'], ['busybox', 'busybox:latest'], ['9.9.9']]);
  await writeFile(join(f.state, 'in-use'), fakeId('1.3.0') + '\n'); // a stopped container still uses it
  const old = {
    '20200101T000000Z-1.0.0-to-1.1.0': { imageId: fakeId('1.0.0') }, // written before 2.2.0: no result marker
    '20200102T000000Z-1.1.0-to-1.2.0': { result: 'format=1\nexit=0\n', imageId: fakeId('busybox') },
    '20200103T000000Z-1.2.0-to-1.3.0': { result: 'format=1\nexit=5\n', imageId: fakeId('1.2.0') },
    '20200104T000000Z-1.3.0-to-1.4.0': { result: 'format=1\nexit=6\n', imageId: fakeId('1.2.0') },
    '20200105T000000Z-1.4.0-to-1.5.0': { result: 'format=1\n', imageId: fakeId('1.2.0') }, // interrupted: no exit code
    '20200106T000000Z-1.5.0-to-1.6.0': { result: 'format=1\nexit=4\n', imageId: fakeId('1.3.0') },
    '20200107T000000Z-1.6.0-to-1.7.0': { result: 'format=1\nexit=0\n', imageId: fakeId('1.1.0') },
    '20200108T000000Z-1.7.0-to-2.0.0': { result: 'format=1\nexit=2\n', imageId: fakeId('2.0.0') }
  };
  for (const [name, options] of Object.entries(old)) await seed(f, name, options);
  // Canaries: names that do not match exactly, a plain file and (where links work) a link to a folder elsewhere.
  const canaries = ['notes', '20190101T000000Z-x-from-y', '20190101T000000Z-file-to-x', '.20190101T000000Z-a-to-b', ...(win32 ? [] : ['20190101T000000Z-link-to-x'])];
  const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'canary'), 'keep');
  await mkdir(join(dir, 'notes')); await mkdir(join(dir, '20190101T000000Z-x-from-y')); await mkdir(join(dir, '.20190101T000000Z-a-to-b'));
  await writeFile(join(dir, '20190101T000000Z-file-to-x'), 'keep');
  if (!win32) await symlink(outside, join(dir, '20190101T000000Z-link-to-x'));
  const result = f.run('--version', 'v2.1.0');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const kept = await f.backups(), save = kept.find(name => name.endsWith('-2.0.0-to-2.1.0') && !name.startsWith('2020'));
  assert.ok(save);
  assert.deepEqual(kept.filter(name => name.startsWith('2020')), Object.keys(old).slice(2), 'newest 5 with this run, plus the 5, 6 and interrupted runs');
  for (const name of canaries) assert.ok(kept.includes(name), name);
  assert.equal(await readFile(join(outside, 'canary'), 'utf8'), 'keep'); assert.equal(await readFile(join(dir, '20190101T000000Z-file-to-x'), 'utf8'), 'keep');
  assert.match(result.stdout, /Removed data\/upgrade-backups\/20200101T000000Z-1\.0\.0-to-1\.1\.0/); assert.match(result.stdout, /Keeping data\/upgrade-backups\/20200103T000000Z/);
  // Only the recorded, untagged 1.0.0 image goes: busybox and docknest:old are other repositories, 1.2.0 belongs to a
  // run that needs manual action, 1.3.0 is in use (reported), 2.0.0 is the previous and 2.1.0 the running image.
  assert.equal(await f.read('removed'), fakeId('1.0.0'));
  const status = await f.status(), calls = await f.read('calls');
  assert.equal(status.phase, 'done'); assert.equal(status.ok, true); assert.ok(status.warning.includes(`Could not remove image ${fakeId('1.3.0')}`), status.warning);
  assert.match(calls, /^compose exec -T api node scripts\/prune-upgrade-artifacts\.js IMG=$/m); assert.doesNotMatch(calls, forbidden);
  assert.ok(!calls.includes(`image rm ${fakeId('busybox')}`) && !calls.includes(`image rm ${fakeId('1.2.0')}`) && !calls.includes(`image rm ${fakeId('9.9.9')}`));
  assert.equal(await readFile(join(dir, save, 'result'), 'utf8'), 'format=1\nexit=0\n');
});

test('failed and refused runs, --dry-run and --no-prune remove nothing; the dry run lists what retention would remove', { skip: !shell }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.state, 'has-prune'), '');
  await images(f, [['1.0.0']]);
  for (let day = 1; day <= 6; day++) await seed(f, `2020010${day}T000000Z-1.0.${day}-to-1.0.${day + 1}`, { result: 'format=1\nexit=0\n', imageId: fakeId('1.0.0') });
  const seeded = await f.backups();
  await writeFile(join(f.state, 'busy'), '');
  assert.equal(f.run('--version', 'v2.1.0').status, 3);
  await rm(join(f.state, 'busy'));
  await writeFile(join(f.state, 'unhealthy'), '2.1.0'); await writeFile(join(f.state, 'no-migrate'), '');
  assert.equal(f.run('--version', 'v2.1.0').status, 4);
  await rm(join(f.state, 'unhealthy')); await rm(join(f.state, 'no-migrate'));
  const after = await f.backups();
  assert.equal(after.length, 7); assert.ok(seeded.every(name => after.includes(name)));
  assert.equal(await f.read('removed'), fakeId('2.1.0'), 'exit 4 removes only the image that run built');
  const dry = f.run('--version', 'v2.1.0', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  // Seven folders; a real run adds one and keeps five, so the three oldest would go, and the recorded 1.0.0 image.
  for (const day of [1, 2, 3]) assert.match(dry.stdout, new RegExp(`Would remove data/upgrade-backups/2020010${day}T`));
  assert.doesNotMatch(dry.stdout, /Would remove data\/upgrade-backups\/20200104T/); assert.ok(dry.stdout.includes(`Would remove image ${fakeId('1.0.0')}`));
  assert.deepEqual(await f.backups(), after); assert.match(await f.read('calls'), /prune-upgrade-artifacts\.js --dry-run/);
  let result = f.run('--version', 'v2.1.0', '--no-prune');
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Retention skipped \(--no-prune\)/);
  assert.equal((await f.backups()).length, 8); assert.equal(await f.read('removed'), fakeId('2.1.0'));
  await writeFile(join(f.state, 'unhealthy'), '2.2.0-rc.1'); // incompatible migration, then unhealthy: exit 5
  result = f.run('--version', 'v2.2.0-rc.1');
  assert.equal(result.status, 5, result.stderr);
  assert.equal((await f.backups()).length, 9); assert.equal(await f.read('removed'), fakeId('2.1.0'));
  const calls = await f.read('calls');
  assert.doesNotMatch(calls, forbidden); assert.ok(!calls.includes('node scripts/prune-upgrade-artifacts.js IMG='), 'the state volume is pruned only after a success');
});

test("this run's backup is kept by identity; names dated in the future are ordered by modification time", { skip: !shell }, async t => {
  const f = await fixture(t), future = Date.now() / 1000 + 3600;
  const names = [1, 2, 3, 4, 5, 6, 7].map(day => `2099010${day}T000000Z-a-to-b`);
  for (const [index, name] of names.entries()) {
    const dir = await seed(f, name, { result: 'format=1\nexit=0\n' });
    // 1 to 5 look newer than this run (a clock that went back); 6 and 7 are old despite their later names.
    const time = index < 5 ? future : Date.UTC(2014 + index, 0, 1) / 1000;
    await utimes(dir, time, time);
  }
  const result = f.run('--version', 'v2.1.0');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const kept = await f.backups();
  assert.deepEqual(kept.filter(name => name.startsWith('2099')), names.slice(0, 5));
  assert.equal(kept.filter(name => name.endsWith('-2.0.0-to-2.1.0')).length, 1, "this run's backup survives although five others sort before it");
});

test('image cleanup is skipped when the running or previous image ID is unknown; source rollback then rebuilds', { skip: !shell }, async t => {
  const f = await fixture(t);
  await images(f, [['1.0.0']]);
  await seed(f, '20200101T000000Z-1.0.0-to-2.0.0', { result: 'format=1\nexit=0\n', imageId: fakeId('1.0.0') });
  await writeFile(join(f.state, 'no-images'), '');
  await writeFile(join(f.state, 'unhealthy'), '2.1.0'); await writeFile(join(f.state, 'no-migrate'), '');
  let result = f.run('--version', 'v2.1.0');
  assert.equal(result.status, 4, result.stderr);
  const calls = await f.read('calls');
  assert.equal(calls.match(/^compose build /gm).length, 2, 'without a recorded ID the previous release is rebuilt'); assert.doesNotMatch(calls, /^tag /m);
  assert.equal(await f.read('version'), '2.0.0');
  await rm(join(f.state, 'unhealthy')); await rm(join(f.state, 'no-migrate'));
  result = f.run('--version', 'v2.1.0');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Image cleanup skipped/);
  assert.ok(!(await f.read('calls')).includes(`image rm ${fakeId('1.0.0')}`)); assert.ok(!(await f.read('removed')).includes(fakeId('1.0.0')));
});

test('a cleanup that hangs or fails still ends with exit 0, status done and the new release kept', { skip: !shell }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.state, 'has-prune'), ''); await writeFile(join(f.state, 'hang-prune'), '4');
  let result = f.run('--version', 'v2.1.0', '--cleanup-timeout', '1');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  let status = await f.status();
  assert.equal(status.phase, 'done'); assert.equal(status.ok, true); assert.match(status.warning, /stopped after 1s/);
  assert.equal(f.head(), 'v2.1.0'); assert.equal(await f.read('version'), '2.1.0'); assert.equal(await f.read('hold'), 'false');
  await rm(join(f.state, 'hang-prune')); await writeFile(join(f.state, 'fail-prune'), ''); await writeFile(join(f.state, 'fail-rm'), '');
  result = f.run('--version', 'v2.2.0-rc.1');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  status = await f.status();
  assert.equal(status.ok, true); assert.match(status.warning, /could not be removed/); assert.ok(status.warning.length <= 1024);
  assert.doesNotMatch(status.warning, /upgrade-snapshots\/pre-rollback-1/, 'the warning never carries container output');
  assert.equal(await f.read('version'), '2.2.0-rc.1');
});

test('a signal during cleanup is still a success: exit 0, status done, never a revert', { skip: !shell || win32 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.state, 'has-prune'), ''); await writeFile(join(f.state, 'hang-prune'), '3');
  const child = f.start(['--version', 'v2.1.0']), exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  child.stdout.resume(); child.stderr.resume();
  for (const deadline = Date.now() + 60000; !existsSync(join(f.state, 'in-cleanup')) && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 50));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  const status = await f.status();
  assert.equal(status.phase, 'done'); assert.equal(status.ok, true); assert.match(status.warning, /interrupted/);
  assert.equal(f.head(), 'v2.1.0'); assert.equal(await f.read('version'), '2.1.0'); assert.equal(await f.read('hold'), 'false');
  assert.doesNotMatch(await f.read('calls'), /up -d --no-build/, 'nothing was reverted');
});

test('a symlinked data/upgrade-backups is never pruned through', { skip: !shell || win32 }, async t => {
  const f = await fixture(t), real = join(f.root, 'elsewhere');
  await mkdir(real);
  for (let day = 1; day <= 6; day++) await mkdir(join(real, `2020010${day}T000000Z-a-to-b`));
  await symlink(real, join(f.work, 'data/upgrade-backups'));
  const result = f.run('--version', 'v2.1.0');
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readdir(real)).length, 7);
  assert.match((await f.status()).warning, /symbolic link/);
});

test('a run never reuses an existing backup folder; a kept run without an image ID stops image cleanup', { skip: !shell }, async t => {
  const f = await fixture(t), stamp = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'), taken = [];
  await images(f, [['1.0.0']]);
  await seed(f, '20200101T000000Z-1.0.0-to-2.0.0', { result: 'format=1\nexit=0\n', imageId: fakeId('1.0.0') });
  // Every name this run could pick in the next minute already exists, as the backup of a run that needs manual action.
  for (let second = 0; second < 60; second++) taken.push(await seed(f, `${stamp(Date.now() + second * 1000)}-2.0.0-to-2.1.0`, { result: 'format=1\nexit=5\n' }));
  const result = f.run('--version', 'v2.1.0');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  for (const dir of taken) assert.equal(await readFile(join(dir, 'result'), 'utf8'), 'format=1\nexit=5\n', 'never written into');
  const own = (await f.backups()).filter(name => /-2\.0\.0-to-2\.1\.0-2$/.test(name));
  assert.equal(own.length, 1); assert.equal(await readFile(join(f.work, 'data/upgrade-backups', own[0], 'result'), 'utf8'), 'format=1\nexit=0\n');
  assert.match(result.stdout, /Image cleanup skipped: data\/upgrade-backups\/\S+ needs manual action and recorded no image ID/);
  assert.equal(await f.read('removed'), '');
});

test('exit 4 never removes an image that existed before the run', { skip: !shell }, async t => {
  const f = await fixture(t);
  await images(f, [['2.1.0']]); // built earlier, for example by a previous attempt
  await writeFile(join(f.state, 'unhealthy'), '2.1.0'); await writeFile(join(f.state, 'no-migrate'), '');
  const result = f.run('--version', 'v2.1.0');
  assert.equal(result.status, 4, result.stderr);
  assert.equal(await f.read('removed'), ''); assert.doesNotMatch(await f.read('calls'), /^image rm /m);
});

// Test doubles for the manual-run signature check: curl serves state/release/<file>; cosign accepts a bundle that holds
// the SHA-256 of the manifest (a fixture trust root) and logs its identity flags.
async function signer(f) {
  await mkdir(join(f.state, 'release'), { recursive: true });
  await writeFile(join(f.bin, 'curl'), '#!/bin/sh\nout=; prev=; for a; do [ "$prev" = -o ] && out=$a; prev=$a; done; eval url=\\${$#}\necho "curl $url" >> "$FAKE_STATE/calls"\nsrc="$FAKE_STATE/release/${url##*/}"; [ -f "$src" ] || { printf "404 "; exit 0; }; cp "$src" "$out"; printf "200 "\n', { mode: 0o755 });
  await writeFile(join(f.bin, 'cosign'), '#!/bin/sh\necho "cosign $*" >> "$FAKE_STATE/calls"\n[ "$1" = verify-blob ] || exit 1\nbundle=; prev=; for a; do [ "$prev" = --bundle ] && bundle=$a; prev=$a; done; eval file=\\${$#}\n[ "$(sha256sum < "$file" | cut -c1-64)" = "$(cat "$bundle")" ]\n', { mode: 0o755 });
  return async (fields, { tamper } = {}) => {
    const text = JSON.stringify({ version: '2.2.0', tag: 'v2.2.0', commit: '', repository: 'DahanItamar/DockNest', prerelease: false, ...fields }, null, 2) + '\n';
    await writeFile(join(f.state, 'release/docknest-release.json.sigstore.json'), createHash('sha256').update(text).digest('hex'));
    await writeFile(join(f.state, 'release/docknest-release.json'), tamper ? text.replace('"prerelease": false', '"prerelease": true') : text);
  };
}

test('manual runs refuse a tag off main and a tampered signed manifest; --no-verify allows them; older released tags still downgrade', { skip: !shell }, async t => {
  const f = await fixture(t), origin = join(f.root, 'origin');
  git(origin, 'checkout', '-q', '-b', 'side', 'v2.1.0'); await writeFile(join(origin, 'package.json'), pkg('2.1.1'));
  git(origin, 'commit', '-q', '-am', 'off main'); git(origin, 'tag', 'v2.1.1'); git(origin, 'checkout', '-q', 'main');
  let result = f.run('--version', 'v2.1.1');
  assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /not on origin\/main/);
  assert.equal((await f.status()).reason, 'verify-not-on-main'); assert.equal(f.head(), 'v2.0.0'); assert.ok(!existsSync(join(f.work, 'data/upgrade-backups')));
  result = f.run('--version', 'v2.1.1', '--no-verify');
  assert.equal(result.status, 0, result.stderr + result.stdout); assert.match(result.stderr, /--no-verify/); assert.equal(f.head(), 'v2.1.1');
  // The tag name decides whether a signature is needed, so it must be v plus the version it contains.
  git(origin, 'tag', 'v9.9.9', 'v2.1.0');
  result = f.run('--version', 'v9.9.9');
  assert.equal(result.status, 2, result.stderr); assert.equal((await f.status()).reason, 'verify-manifest-mismatch'); assert.equal(f.head(), 'v2.1.1');
  git(f.work, 'tag', '-d', 'v9.9.9'); git(origin, 'tag', '-d', 'v9.9.9');
  // A local branch named like the tag never wins over the tag.
  git(f.work, 'branch', 'v2.0.0', 'HEAD');
  result = f.run('--version', 'v2.0.0');
  assert.equal(result.status, 0, result.stderr + result.stdout); assert.equal(f.head(), 'v2.0.0', 'a downgrade to an older released tag still passes');
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), git(f.work, 'rev-parse', 'refs/tags/v2.0.0^{commit}'));
  // A 2.2.0 release on main: with cosign present its signed manifest must verify and name the tag's commit.
  await writeFile(join(origin, 'package.json'), pkg('2.2.0')); git(origin, 'commit', '-q', '-am', 'v2.2.0'); git(origin, 'tag', 'v2.2.0');
  const commit = git(origin, 'rev-parse', 'v2.2.0^{commit}'), publish = await signer(f);
  await publish({ commit }, { tamper: true });
  result = f.run('--version', 'v2.2.0');
  assert.equal(result.status, 2, result.stderr); assert.equal((await f.status()).reason, 'verify-signature-invalid'); assert.equal(f.head(), 'v2.0.0');
  const calls = await f.read('calls');
  assert.ok(calls.includes('--certificate-identity https://github.com/DahanItamar/DockNest/.github/workflows/release.yml@refs/tags/v2.2.0 --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-github-workflow-repository DahanItamar/DockNest --certificate-github-workflow-trigger push --certificate-github-workflow-ref refs/tags/v2.2.0 --certificate-github-workflow-sha ' + commit), calls);
  await publish({ commit: 'f'.repeat(40) });
  result = f.run('--version', 'v2.2.0');
  assert.equal(result.status, 2, result.stderr); assert.equal((await f.status()).reason, 'verify-manifest-mismatch');
  await publish({ commit, prerelease: true });
  result = f.run('--version', 'v2.2.0');
  assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /not a final release/);
  await publish({ commit });
  result = f.run('--version', 'v2.2.0', '--dry-run');
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Verified the signed release manifest of v2\.2\.0/);
  await publish({ commit }, { tamper: true });
  result = f.run('--version', 'v2.2.0', '--no-verify');
  assert.equal(result.status, 0, result.stderr + result.stdout); assert.equal(f.head(), 'v2.2.0');
});

test('updater flags: capabilities, a pinned commit built from git archive, upgrade-only, request id, status fields and the lock', { skip: !shell }, async t => {
  const f = await fixture(t), sha = tag => git(f.work, 'rev-parse', `${tag}^{commit}`);
  const caps = JSON.parse(f.run('--capabilities').stdout);
  assert.equal(caps.protocol, 1); for (const flag of ['--no-fetch', '--expect-commit', '--expect-image-digest', '--upgrade-only', '--request-id', '--no-verify']) assert.ok(caps.flags.includes(flag), flag);
  assert.equal(f.run('--expect-commit', 'v2.1.0').status, 1, 'only a full SHA');
  let result = f.run('--version', 'v2.1.0', '--expect-commit', sha('v2.0.0'), '--no-fetch');
  assert.equal(result.status, 2); assert.equal((await f.status()).reason, 'verify-manifest-mismatch');
  git(f.work, 'replace', sha('v2.0.0'), sha('v2.1.0'));
  result = f.run('--version', 'v2.1.0', '--expect-commit', sha('v2.1.0'), '--no-fetch');
  assert.equal(result.status, 2); assert.match(result.stderr, /refs\/replace/);
  git(f.work, 'replace', '-d', sha('v2.0.0'));
  assert.equal(f.run('--version', 'v2.0.0', '--upgrade-only').status, 2, 'never the installed release or an older one');
  // A local branch named like the tag cannot win, and git-ignored files never reach the build context (F10).
  git(f.work, 'branch', 'v2.1.0', 'v2.0.0'); await writeFile(join(f.work, 'compose.override.yaml'), 'secret: true\n'); await writeFile(join(f.work, 'data/key.pem'), 'x');
  result = f.run('--version', 'v2.1.0', '--expect-commit', sha('v2.1.0'), '--no-fetch', '--upgrade-only', '--request-id', 'req-1.a_b');
  assert.equal(result.status, 0, result.stderr + result.stdout); assert.match(result.stdout, /--no-fetch/);
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), sha('v2.1.0')); assert.equal(await f.read('version'), '2.1.0');
  const context = (await f.read('context')).split('\n');
  assert.ok(context.includes('package.json') && !context.includes('compose.override.yaml') && !context.includes('data') && !context.includes('.git'), context.join(' '));
  const calls = await f.read('calls');
  assert.match(calls, /^build -t docknest:local - /m); assert.doesNotMatch(calls, /^compose build /m);
  assert.match(calls, /^compose up -d --no-build api worker /m); assert.doesNotMatch(calls, /^compose up -d api worker /m);
  const status = await f.status();
  assert.deepEqual([status.ok, status.reason, status.schemaFrom, status.schemaTo, status.requestId], [true, null, 0, 2, 'req-1.a_b']);
  // The installed version must be the exact tag at HEAD.
  git(f.work, 'tag', '-d', 'v2.1.0');
  result = f.run('--version', 'v2.2.0-rc.1', '--upgrade-only', '--no-fetch');
  assert.equal(result.status, 2); assert.equal((await f.status()).reason, 'state-mismatch'); assert.equal(await f.read('version'), '2.1.0');
  git(f.work, 'tag', 'v2.1.0', sha('HEAD'));
  // One run at a time; a lock left by a process that is gone is taken over.
  const holder = spawn('sh', ['-c', 'mkdir data/.upgrade.lock && echo $$ > data/.upgrade.lock/pid && exec sleep 30'], { cwd: f.work });
  for (const deadline = Date.now() + 10000; !existsSync(join(f.work, 'data/.upgrade.lock/pid')) && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 50));
  await writeFile(join(f.root, 'status.json'), '{"phase":"health"}');
  result = f.run('--version', 'v2.2.0-rc.1');
  holder.kill();
  assert.equal(result.status, 2); assert.match(result.stderr, /holds data\/\.upgrade\.lock/);
  assert.equal(await readFile(join(f.root, 'status.json'), 'utf8'), '{"phase":"health"}', "the other run's status is left alone");
  await writeFile(join(f.work, 'data/.upgrade.lock/pid'), '999999\n');
  // Another run is taking the stale lock over right now (its mutex exists): refuse rather than race it.
  await mkdir(join(f.work, 'data/.upgrade.lock.takeover'));
  result = f.run('--version', 'v2.2.0-rc.1');
  assert.equal(result.status, 2); assert.match(result.stderr, /holds data\/\.upgrade\.lock/);
  await rm(join(f.work, 'data/.upgrade.lock.takeover'), { recursive: true });
  result = f.run('--version', 'v2.2.0-rc.1');
  assert.equal(result.status, 0, result.stderr + result.stdout); assert.ok(!existsSync(join(f.work, 'data/.upgrade.lock')), 'released at exit');
});

test('reason codes: busy, build failure and an unhealthy start report fixed codes and the schema before and after', { skip: !shell }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.state, 'busy'), '');
  assert.equal(f.run('--version', 'v2.1.0').status, 3); assert.equal((await f.status()).reason, 'jobs-did-not-finish');
  await rm(join(f.state, 'busy')); await writeFile(join(f.state, 'fail-build'), '');
  assert.equal(f.run('--version', 'v2.1.0').status, 4); assert.equal((await f.status()).reason, 'build-failed');
  await rm(join(f.state, 'fail-build')); await writeFile(join(f.state, 'unhealthy'), '2.1.0');
  assert.equal(f.run('--version', 'v2.1.0').status, 4);
  const status = await f.status();
  assert.deepEqual([status.reason, status.schemaFrom, status.schemaTo], ['health-timeout-api', 0, 2]);
});

test('image mode: --expect-image-digest pulls and persists name:X.Y.Z@sha256, records RepoDigests; upgrade-only checks the running image', { skip: !shell }, async t => {
  const f = await fixture(t), env = join(f.work, '.env'), digest = n => 'sha256:' + String(n).repeat(64);
  await writeFile(join(f.state, 'image-mode'), '');
  await writeFile(env, 'APP_ORIGIN=https://docknest.example.invalid\nDOCKNEST_IMAGE=ghcr.io/example/docknest:2.0.0\n');
  await writeFile(join(f.state, 'digests'), `ghcr.io/example/docknest@${digest(0)} ${fakeId('2.0.0')}\n`);
  let result = f.run('--version', 'v2.1.0', '--expect-image-digest', digest(1), '--upgrade-only');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(await f.read('calls'), new RegExp(`pull api worker IMG=ghcr\\.io/example/docknest:2\\.1\\.0@${digest(1)}`));
  assert.match(await readFile(env, 'utf8'), new RegExp(`^DOCKNEST_IMAGE=ghcr\\.io/example/docknest:2\\.1\\.0@${digest(1)}$`, 'm'));
  const [saved] = await f.backups();
  assert.match(await readFile(join(f.work, 'data/upgrade-backups', saved, 'previous-release'), 'utf8'), new RegExp(`repoDigests=ghcr\\.io/example/docknest@${digest(0)}\n`));
  await writeFile(join(f.state, 'label'), '9.9.9');
  result = f.run('--version', 'v2.2.0-rc.1', '--upgrade-only');
  assert.equal(result.status, 2); assert.equal((await f.status()).reason, 'state-mismatch');
  await writeFile(join(f.state, 'label'), ''); // no label: the digest recorded in .env must be the running image's
  result = f.run('--version', 'v2.2.0-rc.1', '--upgrade-only');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(await readFile(env, 'utf8'), /^DOCKNEST_IMAGE=ghcr\.io\/example\/docknest:2\.2\.0-rc\.1$/m, 'a tag plus digest in .env is accepted and switched');
  assert.equal(f.run('--version', 'v2.1.0', '--expect-image-digest', 'sha256:abc').status, 1);
});

test('an updater run (--expect-commit) in image mode without a verified digest is refused before anything is pulled', { skip: !shell }, async t => {
  const f = await fixture(t), env = join(f.work, '.env'), sha = git(f.work, 'rev-parse', 'v2.1.0^{commit}');
  await writeFile(join(f.state, 'image-mode'), '');
  // An image name the broker does not recognise as the published one (a mirror) makes it send source-mode flags only.
  await writeFile(env, 'APP_ORIGIN=https://docknest.example.invalid\nDOCKNEST_IMAGE=registry.example.invalid/docknest:2.0.0\n');
  const result = f.run('--version', 'v2.1.0', '--expect-commit', sha, '--no-fetch', '--upgrade-only', '--request-id', 'req-2');
  assert.equal(result.status, 2, result.stderr + result.stdout); assert.match(result.stderr, /pulled unverified/);
  const status = await f.status();
  assert.deepEqual([status.ok, status.reason], [false, 'state-mismatch']);
  assert.doesNotMatch(await f.read('calls'), /pull api worker/); assert.equal(await f.read('version'), '2.0.0');
  assert.equal(f.head(), 'v2.0.0'); assert.match(await readFile(env, 'utf8'), /DOCKNEST_IMAGE=registry\.example\.invalid\/docknest:2\.0\.0/);
});

test('manual image mode pulls the digest from the verified manifest, pins it in .env and refuses another image name', { skip: !shell }, async t => {
  const f = await fixture(t), env = join(f.work, '.env'), origin = join(f.root, 'origin'), digest = 'sha256:' + '7'.repeat(64);
  await writeFile(join(f.state, 'image-mode'), '');
  await writeFile(env, 'APP_ORIGIN=https://docknest.example.invalid\nDOCKNEST_IMAGE=ghcr.io/example/docknest:2.0.0\n');
  await writeFile(join(origin, 'package.json'), pkg('2.2.0')); git(origin, 'commit', '-q', '-am', 'v2.2.0'); git(origin, 'tag', 'v2.2.0');
  const commit = git(origin, 'rev-parse', 'v2.2.0^{commit}'), publish = await signer(f);
  await publish({ commit, image: { name: 'ghcr.io/other/docknest', digest } });
  let result = f.run('--version', 'v2.2.0');
  assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /signed release is ghcr\.io\/other\/docknest/);
  await publish({ commit, image: { name: 'ghcr.io/example/docknest', digest } });
  result = f.run('--version', 'v2.2.0');
  assert.equal(result.status, 0, result.stderr + result.stdout); assert.doesNotMatch(result.stderr, /unverified/);
  assert.match(await f.read('calls'), new RegExp(`pull api worker IMG=ghcr\\.io/example/docknest:2\\.2\\.0@${digest}`));
  assert.match(await readFile(env, 'utf8'), new RegExp(`^DOCKNEST_IMAGE=ghcr\\.io/example/docknest:2\\.2\\.0@${digest}$`, 'm'));
  result = f.run('--version', 'v2.2.0-rc.1', '--no-verify');
  assert.equal(result.status, 0, result.stderr + result.stdout); assert.match(result.stderr, /pulled by its tag, unverified/);
});
