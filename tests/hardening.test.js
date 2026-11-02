// Hardening score per site (docs/hardening-score.md): grading, the stored facts, discovery matching, never-scanned and
// pre-upgrade sites, and migration 13 being purely additive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const temporary = await mkdtemp(join(tmpdir(), 'dbm-hardening-'));
Object.assign(process.env, { DATA_DIR: join(temporary, 'data'), BACKUP_DIR: temporary, MASTER_KEY_FILE: join(temporary, 'master.key'), BACKUP_STORAGE: 'local', NODE_ENV: 'test' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { db } = await import('../src/db.js');
const { gradeHardening, cleanFacts, recordHardening, recordDiscoveredHardening, hardeningView, CHECKS } = await import('../src/hardening.js');
const { migrations, migrate } = await import('../src/migrations.js');

// A container that passes every check; each test changes only what it is about.
const safe = (overrides = {}) => ({ format: 1, name: 'web', image: 'nginx:1.27', privileged: false, dockerSocket: false, rootUser: false, rootless: false, hostNetwork: false, publishAll: false,
  publicPorts: [], memoryLimit: true, imagePin: 'tag', healthcheck: true, noNewPrivileges: true, extraCapabilities: [], ...overrides });
const ids = view => view.findings.map(item => item.id);
const at = '2026-10-01T10:00:00.000Z';

test('a fully hardened container gets an A with every check passed', () => {
  const view = gradeHardening([safe()], at);
  assert.deepEqual(view, { grade: 'A', checkedAt: at, passed: CHECKS.length, total: CHECKS.length, findings: [] });
  assert.equal(CHECKS.length, 9);
});

test('privileged mode and the Docker socket are each an F', () => {
  for (const facts of [{ privileged: true }, { dockerSocket: true }]) {
    const view = gradeHardening([safe(facts)], at);
    assert.equal(view.grade, 'F'); assert.equal(view.findings[0].severity, 'high'); assert.equal(view.passed, 8);
  }
});

test('every finding has a short plain-language fix and the exact response fields', () => {
  const view = gradeHardening([safe({ privileged: true, dockerSocket: true, rootUser: true, hostNetwork: true, memoryLimit: false, imagePin: 'latest', healthcheck: false, noNewPrivileges: false, extraCapabilities: ['NET_ADMIN'] })], at);
  assert.equal(view.findings.length, 9); assert.equal(view.passed, 0); assert.equal(view.grade, 'F');
  for (const finding of view.findings) {
    assert.deepEqual(Object.keys(finding), ['id', 'severity', 'title', 'fix', 'container']);
    assert.ok(['high', 'medium', 'low'].includes(finding.severity));
    const words = finding.fix.split(/\s+/).length; assert.ok(words >= 6 && words <= 14, finding.fix);
    assert.equal(finding.container, 'web');
  }
});

const portFinding = facts => gradeHardening([safe(facts)]).findings.find(item => item.id === 'public-ports')?.severity ?? null;

test('host network and publish-all count as ports open to the network (medium)', () => {
  const view = gradeHardening([safe({ hostNetwork: true })], at);
  assert.deepEqual(ids(view), ['public-ports']); assert.equal(view.grade, 'C'); assert.equal(view.findings[0].severity, 'medium');
  assert.equal(portFinding({ publishAll: true }), 'medium');
  assert.equal(portFinding({ publishAll: true, publicPorts: ['0.0.0.0:443->443/tcp'] }), 'medium', 'publish-all is never only 80/443');
});

test('ports: loopback passes, 80/443 only is low, other ports medium, database ports high', () => {
  assert.equal(portFinding({ publicPorts: [] }), null, 'nothing reachable (127.0.0.1 bindings are not reported)');
  assert.equal(portFinding({ publicPorts: ['0.0.0.0:80->8080/tcp', ':::443->8443/tcp'] }), 'low');
  assert.equal(portFinding({ publicPorts: ['0.0.0.0:8080->80/tcp'] }), 'medium');
  assert.equal(portFinding({ publicPorts: ['0.0.0.0:80->80/tcp', '[::]:8443->443/tcp'] }), 'medium');
  assert.equal(portFinding({ publicPorts: ['192.168.1.10:8080->80/tcp'] }), 'medium', 'a specific non-loopback address is reachable');
  assert.equal(portFinding({ publicPorts: ['0.0.0.0:?->80/tcp'] }), 'medium');
  for (const port of [3306, 5432, 6379, 27017, 1433]) assert.equal(portFinding({ publicPorts: [`0.0.0.0:${port}->${port}/tcp`] }), 'high', String(port));
  assert.equal(portFinding({ publicPorts: [':::15432->5432/tcp'] }), 'high', 'container database port on another host port');
  assert.equal(portFinding({ publicPorts: ['0.0.0.0:6379->9000/tcp'] }), 'high', 'host port that clients expect a database on');
  assert.equal(portFinding({ publicPorts: ['0.0.0.0:3300-3310->3300-3310/tcp'] }), 'high', 'a range that covers a database port');
  assert.equal(portFinding({ hostNetwork: true, publicPorts: ['0.0.0.0:5432->5432/tcp'] }), 'high');
  assert.equal(gradeHardening([safe({ publicPorts: ['0.0.0.0:5432->5432/tcp'] })]).grade, 'D');
});

test('root user is a finding unless the engine is rootless; a non-root user passes', () => {
  assert.deepEqual(ids(gradeHardening([safe({ rootUser: true, rootless: false })])), ['root-user']);
  assert.deepEqual(ids(gradeHardening([safe({ rootUser: true, rootless: null })])), ['root-user'], 'unknown engine mode is not trusted');
  assert.deepEqual(ids(gradeHardening([safe({ rootUser: true, rootless: true })])), []);
  assert.deepEqual(ids(gradeHardening([safe({ rootUser: false })])), []);
});

test('memory limit, image pin and healthcheck', () => {
  assert.deepEqual(ids(gradeHardening([safe({ memoryLimit: false })])), ['memory-limit']);
  assert.deepEqual(ids(gradeHardening([safe({ imagePin: 'digest' })])), [], 'a pinned digest passes');
  assert.deepEqual(ids(gradeHardening([safe({ imagePin: 'latest' })])), ['image-tag']);
  assert.deepEqual(ids(gradeHardening([safe({ imagePin: 'untagged' })])), ['image-tag']);
  assert.deepEqual(ids(gradeHardening([safe({ healthcheck: false })])), ['healthcheck']);
});

test('grading rule: one low A, two lows B, one medium C, two mediums D, powerful capability D', () => {
  assert.equal(gradeHardening([safe({ healthcheck: false })]).grade, 'A');
  assert.equal(gradeHardening([safe({ healthcheck: false, memoryLimit: false })]).grade, 'B');
  assert.equal(gradeHardening([safe({ rootUser: true, healthcheck: false, memoryLimit: false, noNewPrivileges: false })]).grade, 'C');
  assert.equal(gradeHardening([safe({ rootUser: true, publicPorts: ['0.0.0.0:8080->80/tcp'] })]).grade, 'D');
  assert.equal(gradeHardening([safe({ rootUser: true, publicPorts: ['0.0.0.0:80->80/tcp'] })]).grade, 'C', 'a web server on 80 is low noise');
  const caps = gradeHardening([safe({ extraCapabilities: ['SYS_ADMIN'] })]);
  assert.equal(caps.grade, 'D'); assert.equal(caps.findings[0].severity, 'high');
  assert.equal(gradeHardening([safe({ extraCapabilities: ['NET_ADMIN'] })]).findings[0].severity, 'medium');
});

test('compose multi-container: each check once, naming the worst container', () => {
  const view = gradeHardening([safe({ name: 'web', rootUser: true }), safe({ name: 'db', rootUser: true, memoryLimit: false, extraCapabilities: ['NET_ADMIN'] }), safe({ name: 'worker', extraCapabilities: ['SYS_PTRACE'] })], at);
  assert.deepEqual(view.findings.map(item => [item.id, item.container, item.severity]), [
    ['extra-capabilities', 'worker', 'high'], ['root-user', 'db', 'medium'], ['memory-limit', 'db', 'low']]);
  assert.equal(view.passed, 6); assert.equal(view.total, 9); assert.equal(view.grade, 'D');
});

test('facts are validated: unknown format, wrong types or odd values make the scan unusable, never guessed', () => {
  assert.equal(cleanFacts(safe({ format: 2 })), null);
  assert.equal(cleanFacts(safe({ privileged: 'yes' })), null);
  assert.equal(cleanFacts(safe({ imagePin: 'pinned' })), null);
  assert.equal(cleanFacts(safe({ name: '../etc' })), null);
  assert.equal(cleanFacts({ ...safe(), publicPorts: undefined }), null);
  assert.equal(cleanFacts(safe({ extraCapabilities: ['NET_ADMIN', 'bad cap'] })), null, 'a malformed capability rejects the record');
  assert.equal(cleanFacts(safe({ publicPorts: ['0.0.0.0:8080->80/tcp', 'all of them'] })), null, 'a malformed port rejects the record');
  assert.equal(cleanFacts(safe({ publicPorts: Array.from({ length: 65 }, (_, i) => `0.0.0.0:${10000 + i}->80/tcp`) })), null);
  assert.equal(cleanFacts(safe({ extraCapabilities: Array.from({ length: 41 }, (_, i) => 'CAP' + i) })), null);
  assert.equal(cleanFacts({ ...safe(), publishAll: undefined }), null);
  assert.equal(gradeHardening(Array.from({ length: 31 }, (_, i) => safe({ name: 'c' + i }))).grade, null, 'more than 30 containers: no grade');
  assert.equal(gradeHardening(Array.from({ length: 30 }, (_, i) => safe({ name: 'c' + i }))).grade, 'A');
  assert.equal('env' in cleanFacts(safe({ env: ['SECRET=1'] })), false, 'unknown fields are dropped before storage');
  assert.deepEqual(gradeHardening([safe(), { format: 1 }]), { grade: null, checkedAt: null, passed: 0, total: 0, findings: [] });
});

const server = id => db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,status,created_at) VALUES(?,?,'127.0.0.1',22,'root','unused',?,'unchecked',?)").run(id, id, 'a'.repeat(64), at);
const site = (id, serverId, config) => db.prepare('INSERT INTO sites(id,server_id,name,config,created_at) VALUES(?,?,?,?,?)').run(id, serverId, id, JSON.stringify(config), at);
server('srv-a'); server('srv-b');
site('never', 'srv-a', { containers: ['lonely'] });
site('compose', 'srv-a', { containers: ['app', 'cache'] });
site('by-id', 'srv-a', { containers: ['bbbbbbbbbbbb'] });
site('static', 'srv-a', { kind: 'static', containers: [] });
site('other', 'srv-b', { containers: ['app'] });
site('partial', 'srv-a', { containers: ['app', 'gone'] });

test('a never-scanned site has grade null and no findings', () => {
  assert.deepEqual(hardeningView('never'), { grade: null, checkedAt: null, passed: 0, total: 0, findings: [] });
  assert.deepEqual(hardeningView('static'), { grade: null, checkedAt: null, passed: 0, total: 0, findings: [] });
});

test('a discovery scan records each site on that server from its own containers, by name or short id', () => {
  const discovered = { staticSites: [], containers: [
    { id: 'a'.repeat(64), name: 'app', hardening: safe({ name: 'app', imagePin: 'latest' }) },
    { id: 'c'.repeat(64), name: 'cache', hardening: safe({ name: 'cache', rootUser: true }) },
    { id: 'b'.repeat(64), name: 'svc', hardening: safe({ name: 'svc', dockerSocket: true }) },
    { id: 'd'.repeat(64), name: 'unrelated', hardening: safe({ name: 'unrelated', privileged: true }) }] };
  assert.equal(recordDiscoveredHardening('srv-a', discovered, at), 2);
  const compose = hardeningView('compose');
  assert.equal(compose.grade, 'C'); assert.equal(compose.checkedAt, at);
  assert.deepEqual(compose.findings.map(item => [item.id, item.container]), [['root-user', 'cache'], ['image-tag', 'app']]);
  assert.equal(hardeningView('by-id').grade, 'F');
  assert.equal(hardeningView('never').grade, null, 'a site whose containers are absent keeps its state');
  assert.equal(hardeningView('other').grade, null, 'another server is never touched');
  assert.equal(hardeningView('partial').grade, null, 'a site with a missing container is not graded from the rest');
});

test('a scan from an older helper (no facts) keeps the previous result, and a backup replaces it', () => {
  assert.equal(recordDiscoveredHardening('srv-a', { containers: [{ id: 'a'.repeat(64), name: 'app' }, { id: 'c'.repeat(64), name: 'cache' }] }, '2026-10-02T00:00:00.000Z'), 0);
  assert.equal(hardeningView('compose').checkedAt, at);
  assert.equal(recordHardening('compose', null), false);
  assert.equal(recordHardening('compose', [safe({ name: 'app' }), safe({ name: 'cache' })], '2026-10-03T00:00:00.000Z'), true);
  assert.deepEqual(hardeningView('compose'), { grade: 'A', checkedAt: '2026-10-03T00:00:00.000Z', passed: 9, total: 9, findings: [] });
});

test('stored data this release cannot read (damaged or a different format) is null, no crash', () => {
  db.prepare("INSERT INTO site_hardening(site_id,checked_at,facts) VALUES('never',?,'{not json') ON CONFLICT(site_id) DO UPDATE SET facts=excluded.facts").run(at);
  assert.equal(hardeningView('never').grade, null);
  db.prepare('UPDATE site_hardening SET facts=? WHERE site_id=?').run(JSON.stringify([{ format: 0, name: 'lonely' }]), 'never');
  assert.deepEqual(hardeningView('never'), { grade: null, checkedAt: null, passed: 0, total: 0, findings: [] });
  db.prepare('UPDATE site_hardening SET facts=? WHERE site_id=?').run('{"legacy":true}', 'never');
  assert.equal(hardeningView('never').grade, null);
});

test('a database from before the upgrade (no site_hardening table) reads as never scanned', () => {
  const old = new DatabaseSync(':memory:');
  assert.deepEqual(hardeningView('any', old), { grade: null, checkedAt: null, passed: 0, total: 0, findings: [] });
  old.close();
});

test('migration 13 adds only site_hardening, keeps every earlier table unchanged and is compatible', () => {
  const file = join(temporary, 'migration.sqlite'), database = new DatabaseSync(file), quiet = () => {};
  const schema = () => database.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => ({ ...row }));
  try {
    database.exec('PRAGMA foreign_keys=ON');
    const migration = migrations.find(item => item.name === 'site-hardening');
    assert.equal(migration.compatible, true);
    migrate(database, { file, list: migrations.filter(item => item.version < migration.version), log: quiet });
    const before = schema();
    migrate(database, { file, list: migrations.filter(item => item.version <= migration.version), log: quiet });
    const after = schema();
    assert.deepEqual(after.filter(row => !before.some(item => item.name === row.name)).map(row => row.name), ['site_hardening']);
    for (const row of before) assert.deepEqual(after.find(item => item.name === row.name), row);
  } finally { database.close(); }
});

test('a backup records the facts the helper returns beside the manifest, and a backup without them changes nothing', async t => {
  const { transport, enqueueBackup, claimJob, executeJob } = await import('../src/engine.js');
  server('srv-backup'); site('backed-up', 'srv-backup', { containers: ['app'] });
  const original = { ...transport }; t.after(() => Object.assign(transport, original));
  let hardening;
  transport.remote = async (_server, request) => {
    if (request.operation === 'plan') return { fingerprint: 'plan' };
    if (request.operation === 'cleanup') return { removed: true };
    if (request.operation === 'list-staging') return { root: '/var/lib/docknest', jobs: [] };
    return { remotePath: '/var/lib/docknest/job/payload.tar.gz', root: '/var/lib/docknest/job', hardening, manifest: { kind: 'docker', complete: true, capturedAt: Math.floor(Date.now() / 1000), downtimeSeconds: 1, originalImages: [], architecture: 'amd64', containers: [], consistency: { status: 'passed' } } };
  };
  transport.download = async (_server, _path, output) => { output.end(Buffer.from('authenticated fixture payload')); };
  const run = async () => { enqueueBackup('backed-up', 'test'); const job = claimJob(); await executeJob(job); return db.prepare('SELECT status,details FROM jobs WHERE id=?').get(job.id); };
  hardening = [safe({ name: 'app', privileged: true })];
  assert.equal((await run()).status, 'completed');
  const first = hardeningView('backed-up'); assert.equal(first.grade, 'F'); assert.ok(first.checkedAt);
  hardening = undefined;
  assert.equal((await run()).status, 'completed');
  assert.deepEqual(hardeningView('backed-up'), first, 'an older helper keeps the previous grade');
  hardening = [{ format: 1, name: 'app', privileged: 'broken' }];
  assert.equal((await run()).status, 'completed', 'damaged facts never fail the backup');
  assert.deepEqual(hardeningView('backed-up'), first);
});
