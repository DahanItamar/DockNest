import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

// Drives scripts/upgrade.sh against a throwaway git history and a `docker compose` test double.
// Real containers, volumes and migrations are covered by the CI upgrade job and the Linux server checklist.
const shell = spawnSync('sh', ['-c', 'exit 0']).status === 0;
const script = new URL('../scripts/upgrade.sh', import.meta.url), fake = new URL('./fixtures/fake-docker.sh', import.meta.url);
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' }).trim();
const pkg = (version, min) => JSON.stringify({ name: 'docknest', version, private: true, ...(min ? { docknest: { minUpgradeFrom: min } } : {}) }, null, 2) + '\n';
const migrations = versions => 'export const migrations = [\n' + versions.map(version => `  { version: ${version}, name: 'm${version}', up: () => {} },\n`).join('') + '];\n';

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
  await release('v2.1.0', '2.1.0', '2.0.0', [1, 2]);
  await release('v2.2.0-rc.1', '2.2.0-rc.1', '2.1.0', [1, 2, 3]);
  git(root, 'clone', '-q', origin, work); git(work, 'checkout', '-q', 'v2.0.0');
  await mkdir(join(work, 'data'));
  await writeFile(join(work, 'data/master.key'), 'fixture-key\n'); await writeFile(join(work, 'data/setup.token'), 'fixture-token\n');
  await writeFile(join(work, '.env'), 'APP_ORIGIN=https://docknest.example.invalid\n');
  await writeFile(join(bin, 'docker'), `#!/bin/sh\nexec sh '${new URL(fake).pathname.replace(/^\/([A-Za-z]:)/, '$1')}' "$@"\n`, { mode: 0o755 });
  await writeFile(join(state, 'running'), 'up\n'); await writeFile(join(state, 'version'), '2.0.0\n'); await writeFile(join(state, 'schema'), '0\n');
  const run = (...args) => spawnSync('sh', [join(work, 'scripts/upgrade.sh'), '--non-interactive', '--timeout', '0', '--wait', '0', '--status-file', join(root, 'status.json'), ...args], { cwd: work, encoding: 'utf8', env: { ...process.env, PATH: bin + delimiter + process.env.PATH, FAKE_STATE: state, DOCKNEST_DIR: '', DOCKNEST_UPGRADE_COPY: '' } });
  const read = async name => (await readFile(join(state, name), 'utf8').catch(() => '')).trim();
  const status = async () => JSON.parse(await readFile(join(root, 'status.json'), 'utf8'));
  return { root, work, state, run, read, status, head: () => git(work, 'describe', '--tags', '--always') };
}

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
  assert.deepEqual((await readdir(join(f.work, 'data/upgrade-backups', saved))).sort(), ['.env', 'master.key', 'previous-release', 'setup.token']);
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

test('an unhealthy start after migration stops with exact rollback commands instead of guessing', { skip: !shell }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.state, 'unhealthy'), '2.1.0');
  const result = f.run('--version', 'v2.1.0');
  assert.equal(result.status, 5);
  assert.equal(f.head(), 'v2.1.0', 'code stays on the migrated release');
  const status = await f.status();
  assert.equal(status.ok, false); assert.match(status.rollbackHint, /state-v0-to-v2-\*\.sqlite/); assert.match(status.rollbackHint, /git checkout [0-9a-f]{40}/);
  assert.equal(await f.read('restores'), '');
});

test('downgrades only with an equal schema or an explicitly accepted matching snapshot', { skip: !shell }, async t => {
  const f = await fixture(t);
  assert.equal(f.run('--version', 'v2.1.0').status, 0);
  let result = f.run('--version', 'v2.0.0');
  assert.equal(result.status, 2); assert.match(result.stderr, /no matching snapshot/);
  await writeFile(join(f.state, 'snapshots'), 'state-v0-to-v2-20261021T080000000Z.sqlite\nstate-v0-to-v1-20261022T080000000Z.sqlite\nnotes.txt\n');
  result = f.run('--version', 'v2.0.0');
  assert.equal(result.status, 2); assert.match(result.stderr, /--allow-data-rollback/);
  assert.equal(f.head(), 'v2.1.0');
  result = f.run('--version', 'v2.0.0', '--allow-data-rollback');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(f.head(), 'v2.0.0'); assert.equal(await f.read('version'), '2.0.0');
  assert.match(await f.read('restores'), /state-v0-to-v2-20261021T080000000Z\.sqlite/);
});
