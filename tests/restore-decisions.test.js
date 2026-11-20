// The restore check (docs/restore-check.md): Ignore and Note answers per finding, joined onto the readiness result;
// migration 20 adds one compatible table and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const directory = await mkdtemp(join(tmpdir(), 'docknest-restore-decisions-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const { transport, checkReadiness } = await import('../src/engine.js');
const { migrate, migrations, compatFloor } = await import('../src/migrations.js');
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
test.after(() => listener.close());

function user(role) {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId, userId + '@example.invalid', 'fixture', 'fixture', '[]', new Date().toISOString(), role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), userId, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), Date.now());
  const call = (method, route, body) => fetch(base + route, { method, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, 'x-csrf-token': 'csrf', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return Object.assign(call, { id: userId });
}
const admin = user('admin'), operator = user('operator');
const json = async response => ({ status: response.status, body: await response.json() });
const at = new Date().toISOString(), key = 'a'.repeat(64), other = 'b'.repeat(64);
db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('srv','Server','127.0.0.1',22,'root','unused',?,?)").run('a'.repeat(64), at);
for (const id of ['site', 'removed']) db.prepare('INSERT INTO sites(id,server_id,name,config,created_at) VALUES(?,?,?,?,?)').run(id, 'srv', id, '{}', at);
db.prepare("INSERT INTO site_archives VALUES('removed',?)").run(at);
const route = (siteId, findingKey = key) => `/sites/${siteId}/restore-decisions/${findingKey}`;
const audits = action => db.prepare('SELECT actor,target,detail FROM audit_events WHERE action=? ORDER BY created_at,rowid').all(action).map(row => ({ ...row, detail: JSON.parse(row.detail) }));

test('administrators and operators store, replace and remove an answer; the audit trail keeps the key and answer only', async () => {
  const note = 'Recreated by our Ansible play; token is SECRET-in-note';
  let response = await json(await operator('PUT', route('site'), { decision: 'note', note: '  ' + note + '  ' }));
  assert.equal(response.status, 200); assert.deepEqual({ ...response.body, decidedAt: undefined }, { key, decision: 'note', note, decidedBy: operator.id, decidedAt: undefined });
  response = await json(await admin('PUT', route('site'), { decision: 'ignore' }));
  assert.equal(response.body.note, null);
  assert.deepEqual({ ...db.prepare('SELECT site_id,finding_key,decision,note,decided_by FROM site_restore_decisions').get() }, { site_id: 'site', finding_key: key, decision: 'ignore', note: null, decided_by: admin.id });
  assert.deepEqual(audits('site.restore_decision').map(row => row.detail), [{ key, decision: 'note' }, { key, decision: 'ignore' }]);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit_events').all()).includes('SECRET-in-note'));
  assert.deepEqual((await json(await operator('DELETE', route('site')))).body, { key, removed: true });
  assert.deepEqual((await json(await operator('DELETE', route('site')))).body, { key, removed: false });
  assert.equal(audits('site.restore_decision_removed').length, 1);
});

test('invalid keys, answers and notes are refused; unknown and removed sites are refused', async () => {
  for (const [findingKey, body] of [['A'.repeat(64), { decision: 'ignore' }], ['a'.repeat(63), { decision: 'ignore' }], [key, { decision: 'include' }], [key, { decision: 'note' }],
    [key, { decision: 'note', note: '   ' }], [key, { decision: 'note', note: 'x'.repeat(501) }], [key, { decision: 'note', note: 'bell\x07' }], [key, { decision: 'ignore', extra: 1 }]]) {
    assert.equal((await operator('PUT', route('site', findingKey), body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await operator('PUT', route('missing'), { decision: 'ignore' })).status, 404);
  assert.equal((await operator('PUT', route('removed'), { decision: 'ignore' })).status, 409);
  assert.equal((await operator('DELETE', route('removed'))).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM site_restore_decisions').get().n, 0);
});

test('readiness joins stored answers onto the helper findings and leaves ready and an older helper answer as they were', async () => {
  const findings = [{ key, kind: 'host-schedule', path: '/etc/cron.d/shop', matched: '/srv/shop', includable: true, included: false, message: 'm' }, { key: other, kind: 'external-network', path: 'proxy', matched: 'shop', includable: false, included: false, message: 'n' }];
  let answer = { ready: true, checks: [{ name: 'Containers and configuration files', ok: true, message: 'Ready' }], restoreGaps: { findings, complete: true, limits: {} } };
  transport.remote = async (_server, request) => { assert.equal(request.operation, 'readiness'); return structuredClone(answer); };
  await operator('PUT', route('site'), { decision: 'note', note: 'Copied by hand' });
  const result = await checkReadiness('site');
  assert.deepEqual(result.restoreGaps.findings.map(f => [f.key, f.decision, f.note]), [[key, 'note', 'Copied by hand'], [other, undefined, undefined]]);
  assert.equal(result.restoreGaps.complete, true);
  assert.equal(result.ready, result.checks.every(check => check.ok || check.required === false));
  answer = { ready: true, checks: [] };
  assert.equal('restoreGaps' in await checkReadiness('site'), false);
  answer = { ready: true, checks: [], restoreGaps: { error: 'The restore check could not finish on this server.' } };
  assert.deepEqual((await checkReadiness('site')).restoreGaps, answer.restoreGaps);
});

test('migration 20 is one compatible line, adds only site_restore_decisions to a schema-19 database, keeps rows and restarts as a no-op', async () => {
  const lines = (await readFile(new URL('../src/migrations.js', import.meta.url), 'utf8')).split(/\r?\n/).filter(line => /^\s*\{\s*version:\s*20\b/.test(line));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ {2}\{ version: 20, name: 'site-restore-decisions', compatible: true, up: db => db\.exec\(restoreDecisionsSchema\) \},$/);
  assert.equal(compatFloor(migrations), 1);
  const folder = await mkdtemp(join(tmpdir(), 'docknest-restore-decisions-migration-')), file = join(folder, 'state.sqlite'), target = new DatabaseSync(file);
  try {
    target.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;');
    const released = migrations.filter(migration => migration.version <= 19), schema = () => target.prepare('SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all().map(row => ({ ...row }));
    migrate(target, { file, list: released, log: () => {} });
    target.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('s','n','h',22,'root','k','f','2026-01-01')").run();
    target.prepare("INSERT INTO sites VALUES('site','s','shop','{}','2026-01-01')").run();
    const before = schema(), sites = target.prepare('SELECT * FROM sites').all().map(row => ({ ...row }));
    const result = migrate(target, { file, list: [...released, migrations.find(migration => migration.version === 20)], now: () => new Date('2026-11-19T08:00:00.000Z'), log: () => {} });
    assert.deepEqual([result.from, result.to], [19, 20]); assert.match(result.snapshot, /state-v19-to-v20-/);
    for (const row of before) assert.deepEqual(schema().find(item => item.name === row.name), row, `${row.name} keeps its definition`);
    assert.deepEqual(schema().map(row => row.name).filter(name => !before.some(row => row.name === name)), ['site_restore_decisions']);
    assert.deepEqual(target.prepare('SELECT * FROM sites').all().map(row => ({ ...row })), sites);
    assert.deepEqual(migrate(target, { file, list: migrations.filter(migration => migration.version <= 20), log: () => {} }).snapshot, null);
    const insert = target.prepare('INSERT INTO site_restore_decisions VALUES(?,?,?,?,?,?)');
    insert.run('site', key, 'note', 'kept', 'u', '2026-11-19');
    for (const values of [['site', 'A'.repeat(64), 'ignore', null], ['site', key.slice(1), 'ignore', null], ['site', other, 'include', null], ['site', other, 'note', 'x'.repeat(501)], ['nowhere', other, 'ignore', null]]) {
      assert.throws(() => insert.run(...values, 'u', '2026-11-19'), /CHECK|FOREIGN KEY/, JSON.stringify(values.slice(0, 3)));
    }
    assert.throws(() => insert.run('site', key, 'ignore', null, 'u', '2026-11-19'), /UNIQUE|PRIMARY/);
  } finally { target.close(); await rm(folder, { recursive: true, force: true }); }
});
