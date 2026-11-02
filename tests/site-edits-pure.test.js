// Safe Edit pure helpers (src/site-edits/diff.js, invocation.js, state.js): the review diff and its masking, inline
// secret detection, the Compose invocation derived from container labels, the `changes` record limits and tab detection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hunks, lineScript, reviewDiff, inlineSecretKeys, splitLines, MASK } from '../src/site-edits/diff.js';
import { changesRecord, tabsUsed, stateFor, cancellable, SAY, reasonFor, helperCode } from '../src/site-edits/state.js';

// invocation.js imports the database module; its pure parts are checked through a fresh import with a temp DATA_DIR.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const directory = await mkdtemp(join(tmpdir(), 'docknest-site-edits-pure-'));
Object.assign(process.env, { DATA_DIR: directory, MASTER_KEY_FILE: join(directory, 'master.key'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { invocationFromContainers, validInvocation, allowedRoots, invocationHash } = await import('../src/site-edits/invocation.js');

test('line diff: hunks with 3 lines of context, CRLF and a missing final newline read the same', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n') + '\n', after = before.replace('e\n', 'E\n');
  const [hunk, ...rest] = hunks(before, after);
  assert.equal(rest.length, 0);
  assert.deepEqual({ oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines }, { oldStart: 2, oldLines: 7, newStart: 2, newLines: 7 });
  assert.deepEqual(hunk.lines.filter(line => line.type !== 'context'), [{ type: 'remove', text: 'e' }, { type: 'add', text: 'E' }]);
  assert.deepEqual(hunks('x\r\ny\r\n', 'x\ny'), [], 'line endings and the final newline are not a change');
  assert.deepEqual(splitLines(''), []);
  // Two far-apart changes make two hunks; an added service at the end is an add-only hunk.
  const long = Array.from({ length: 30 }, (_value, index) => `line ${index}`).join('\n');
  assert.equal(hunks(long, long.replace('line 2\n', 'line two\n').replace('line 25', 'line 25b')).length, 2);
  const added = hunks('services:\n  web:\n    image: a\n', 'services:\n  web:\n    image: a\n  cache:\n    image: redis:7\n');
  assert.deepEqual(added[0].lines.filter(line => line.type === 'add').map(line => line.text), ['  cache:', '    image: redis:7']);
  // A very large rewrite falls back to a replaced block and stays exact.
  const big = Array.from({ length: 3000 }, (_value, index) => `a${index}`), other = Array.from({ length: 3000 }, (_value, index) => `b${index}`);
  const script = lineScript(big, other);
  assert.equal(script.filter(line => line.type === 'remove').length, 3000); assert.equal(script.filter(line => line.type === 'add').length, 3000);
});

test('review diff masks every environment value and never reads one', () => {
  const diff = reviewDiff({ originals: [{ path: '/srv/a/compose.yaml', text: 'x: 1\n' }], files: [{ path: '/srv/a/compose.yaml', text: 'x: 2\n' }], env: [{ file: '/srv/a/.env', key: 'DB_PASSWORD', value: 'secret-value', existed: true }, { file: '/srv/a/.env', key: 'NEW', value: 'v' }, { file: '/srv/a/.env', key: 'OLD', remove: true }] });
  assert.deepEqual(diff.env, [{ file: '/srv/a/.env', key: 'DB_PASSWORD', change: 'replaced', value: MASK }, { file: '/srv/a/.env', key: 'NEW', change: 'added', value: MASK }, { file: '/srv/a/.env', key: 'OLD', change: 'removed', value: null }]);
  assert.doesNotMatch(JSON.stringify(diff), /secret-value/);
  assert.equal(diff.files.length, 1);
});

test('inline secrets: key names with secret-looking names and literal values, never references or values', () => {
  const text = 'services:\n  web:\n    environment:\n      DB_PASSWORD: hunter2\n      - API_TOKEN=abc\n      SECRET_REF: ${SECRET_REF}\n      NAME: shop\n      "SMTP_PASS": "x y"\n      EMPTY_TOKEN:\n';
  assert.deepEqual(inlineSecretKeys(text), ['API_TOKEN', 'DB_PASSWORD', 'SMTP_PASS']);
});

test('Compose invocation from container labels: one project, files, folder and env files; single containers by name', () => {
  const labels = (extra = {}) => ({ 'com.docker.compose.project': 'shop', 'com.docker.compose.project.config_files': '/srv/shop/compose.yaml,/srv/shop/compose.override.yaml', 'com.docker.compose.project.working_dir': '/srv/shop', 'com.docker.compose.project.environment_file': '/srv/shop/.env', ...extra });
  const config = { containers: ['shop-web', 'shop-db'] };
  assert.deepEqual(invocationFromContainers(config, [{ name: 'shop-web', labels: labels() }, { name: 'shop-db', labels: labels() }]), { kind: 'compose', source: 'labels', invocation: { project: 'shop', files: ['/srv/shop/compose.yaml', '/srv/shop/compose.override.yaml'], projectDirectory: '/srv/shop', envFiles: ['/srv/shop/.env'] } });
  assert.deepEqual(invocationFromContainers({ containers: ['solo'] }, [{ name: 'solo', labels: {} }]), { kind: 'container', source: 'site', invocation: { container: 'solo' } });
  assert.ok(invocationFromContainers(config, [{ name: 'shop-web', labels: labels() }]).problem, 'a missing container');
  assert.ok(invocationFromContainers(config, [{ name: 'shop-web', labels: labels() }, { name: 'shop-db', labels: labels({ 'com.docker.compose.project': 'other' }) }]).problem, 'two projects');
  assert.ok(invocationFromContainers(config, [{ name: 'shop-web', labels: labels() }, { name: 'shop-db', labels: labels({ 'com.docker.compose.project.config_files': '/srv/shop/other.yaml' }) }]).problem, 'different files');
  assert.ok(invocationFromContainers(config, [{ name: 'shop-web', labels: labels({ 'com.docker.compose.project.config_files': '../etc/x.yaml' }) }, { name: 'shop-db', labels: labels({ 'com.docker.compose.project.config_files': '../etc/x.yaml' }) }]).problem, 'relative or traversing paths');
  assert.ok(invocationFromContainers({ containers: ['a', 'b'] }, [{ name: 'a', labels: {} }, { name: 'b', labels: {} }]).problem, 'not started together');
  // An env file label may be empty: no --env-file then.
  assert.deepEqual(invocationFromContainers({ containers: ['shop-web'] }, [{ name: 'shop-web', labels: labels({ 'com.docker.compose.project.environment_file': '' }) }]).invocation.envFiles, []);
  assert.equal(validInvocation('compose', { project: 'Shop!', files: ['/a'], projectDirectory: '/a', envFiles: [] }), null);
  assert.equal(validInvocation('container', { container: 'a', extra: 1 }), null);
  const resolved = { kind: 'compose', invocation: { project: 'shop', files: ['/srv/shop/compose.yaml', '/srv/common/base.yaml'], projectDirectory: '/srv/shop', envFiles: ['/srv/shop/.env'] } };
  assert.deepEqual(allowedRoots({ composeFiles: ['/srv/shop/compose.yaml'], configFiles: ['/srv/shop/config/app.ini', '/x'] }, resolved), ['/srv/common', '/srv/shop', '/srv/shop/config']);
  assert.match(invocationHash(resolved), /^[0-9a-f]{64}$/);
});

test('changes record: field paths, env key names and hashes only, trimmed to 4096 characters', () => {
  const record = changesRecord({ tabs: ['compose', 'image', 'bogus'], changed: ['services.web.image', 'bad path!'], envChanged: { added: ['A', 'bad key'], replaced: [], removed: [] }, hashes: [{ path: '/srv/a/compose.yaml', before: 'a'.repeat(64), after: 'b'.repeat(64) }], imageChanged: true });
  assert.deepEqual(record, { tabs: ['compose', 'image'], changed: ['services.web.image'], env: { added: ['A'], replaced: [], removed: [] }, files: [{ path: '/srv/a/compose.yaml', before: 'a'.repeat(64), after: 'b'.repeat(64) }], imageChanged: true });
  const huge = changesRecord({ tabs: ['compose'], changed: Array.from({ length: 200 }, (_value, index) => `services.service${index}.environment.VARIABLE_${index}`), envChanged: { added: Array.from({ length: 200 }, (_value, index) => `KEY_${index}`) }, hashes: [] });
  assert.ok(JSON.stringify(huge).length <= 4096); assert.equal(huge.truncated, true);
  assert.deepEqual(tabsUsed({ files: [{}], env: [], changed: ['services.web.ports[0]', 'services.web.image'] }).sort(), ['compose', 'image', 'ports']);
});

test('states, cancel window and reasons', () => {
  assert.equal(stateFor('backup', null, false), 'queued'); assert.equal(stateFor('check_health'), 'checking'); assert.equal(stateFor('rollback_health'), 'rolling_back'); assert.equal(stateFor('attention'), 'needs_attention');
  assert.equal(stateFor('finish', 'rolled_back'), 'rolling_back'); assert.equal(stateFor('finish', 'failed'), 'running');
  assert.equal(cancellable({ result: null, progress: { phase: 'backup' } }), true);
  assert.equal(cancellable({ result: null, progress: { phase: 'prepare' } }), true);
  assert.equal(cancellable({ result: null, progress: { phase: 'apply', applyStarted: true } }), false);
  assert.equal(cancellable({ result: null, progress: { phase: 'prepare', applyStarted: true } }), false);
  assert.equal(SAY.unhealthy(120), 'The site did not become healthy in 2 minutes.'); assert.equal(SAY.unhealthy(60), 'The site did not become healthy in 1 minute.'); assert.equal(SAY.unhealthy(90), 'The site did not become healthy in 90 seconds.');
  assert.equal(reasonFor('NOPE', 'fallback'), 'fallback'); assert.equal(helperCode('rm -rf /'), null); assert.equal(helperCode('PORT_IN_USE'), 'PORT_IN_USE');
});
