// Incremental backups API (docs/incremental-backups.md): the per-site setting, chain fields on backups, ZIP only for
// full backups, "Download chain" and the update center's downgrade warning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';

const directory = await mkdtemp(join(tmpdir(), 'docknest-incremental-api-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const { transport, encryptStream } = await import('../src/engine.js');
const { downgradeWarning } = await import('../src/updates/routes.js');
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
test.after(() => listener.close());

const remoteCalls = [];
transport.remote = async (_server, request) => { remoteCalls.push(request); return {}; };
function user(role) {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId, userId + '@example.invalid', 'fixture', 'fixture', '[]', new Date().toISOString(), role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), userId, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), Date.now());
  return (method, route, body) => fetch(base + route, { method, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, 'x-csrf-token': 'csrf', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const admin = user('admin'), operator = user('operator');
const json = async response => ({ status: response.status, body: await response.json() });
const at = new Date().toISOString(), sha = bytes => createHash('sha256').update(bytes).digest('hex');
db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('srv','Server','127.0.0.1',22,'root','unused',?,?)").run('a'.repeat(64), at);
for (const [id, config] of [['site', {}], ['static', { kind: 'static' }]]) { db.prepare('INSERT INTO sites(id,server_id,name,config,created_at) VALUES(?,?,?,?,?)').run(id, 'srv', id, JSON.stringify(config), at); db.prepare("INSERT INTO policies(site_id,enabled,schedule,timezone,retention) VALUES(?,0,'0 0 * * *','UTC',7)").run(id); }
db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES('job','site','backup','completed','completed',?)").run(at);

// A full package and two increments, stored and linked as a published chain would be.
const chainId = randomUUID(), members = [];
for (let index = 0; index < 3; index++) {
  const id = randomUUID(), file = join(process.env.BACKUP_DIR, id + '.enc'), previous = members[index - 1];
  await encryptStream(Readable.from([Buffer.from('package ' + index)]), createWriteStream(file));
  const bytes = await readFile(file), kind = index ? 'incremental' : 'full';
  const manifest = { formatVersion: 2, kind: 'docker', backupKind: kind, chain: { id: chainId, position: index, parentBackupId: previous?.id ?? null, parentSha256: previous?.checksum ?? null }, incremental: { format: 2 } };
  db.prepare('INSERT INTO backups(id,site_id,job_id,captured_at,path,size,checksum,manifest,pinned,verified,created_at) VALUES(?,?,?,?,?,?,?,?,0,1,?)').run(id, 'site', 'job', new Date(Date.now() + index * 1000).toISOString(), file, bytes.length, sha(bytes), JSON.stringify(manifest), at);
  db.prepare('INSERT INTO backup_chain_links VALUES(?,?,?,?,?)').run(id, kind, chainId, previous?.id ?? null, index);
  members.push({ id, checksum: sha(bytes), size: bytes.length, bytes });
}
const plainId = randomUUID(), plainFile = join(process.env.BACKUP_DIR, plainId + '.enc');
await encryptStream(Readable.from([Buffer.from('plain')]), createWriteStream(plainFile));
db.prepare("INSERT INTO backups(id,site_id,job_id,captured_at,path,size,checksum,manifest,pinned,verified,created_at) VALUES(?,'site','job',?,?,?,?,'{}',0,1,?)").run(plainId, new Date(Date.now() - 86400000).toISOString(), plainFile, (await readFile(plainFile)).length, sha(await readFile(plainFile)), at);

test('GET and PUT /api/sites/:id/incremental: off by default, admin only, validated, and turning it off discards the source state', async () => {
  assert.deepEqual((await json(await operator('GET', '/sites/site/incremental'))).body, { siteId: 'site', enabled: false, interval: 6, fullNext: false, fullNextReason: null, fullNextMessage: null, available: true, beta: true });
  assert.equal((await operator('PUT', '/sites/site/incremental', { enabled: true })).status, 403);
  assert.equal((await json(await admin('PUT', '/sites/site/incremental', { interval: 31 }))).body.code, 'invalid_interval');
  assert.equal((await json(await admin('PUT', '/sites/site/incremental', { fullNow: true }))).status, 409);
  assert.equal((await json(await admin('PUT', '/sites/static/incremental', { enabled: true }))).body.code, 'static_site');
  assert.equal((await json(await admin('PUT', '/sites/site/incremental', { enabled: true, extra: 1 }))).status, 400);
  const on = await json(await admin('PUT', '/sites/site/incremental', { enabled: true, interval: 13 }));
  assert.deepEqual(on.body, { siteId: 'site', enabled: true, interval: 13, fullNext: true, fullNextReason: 'feature-enabled', fullNextMessage: 'This is the first backup since incremental backups were turned on.', available: true, beta: true });
  // Full backup now: an operator may ask (like Back up now); it marks the next backup full and queues it at once.
  assert.equal((await operator('PUT', '/sites/site/incremental', { fullNow: true, interval: 6 })).status, 403, 'settings stay admin-only');
  const now = await json(await operator('PUT', '/sites/site/incremental', { fullNow: true }));
  assert.equal(now.status, 202); assert.equal(now.body.fullNextReason, 'full-now');
  assert.deepEqual({ ...db.prepare('SELECT type,status,site_id FROM jobs WHERE id=?').get(now.body.job.id) }, { type: 'backup', status: 'queued', site_id: 'site' });
  assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='backup.full_now' AND target='site'").get());
  // The busy guard of Back up now: refused, nothing queued, and the mark goes back to what it was.
  db.prepare("UPDATE site_incremental SET force_full=3 WHERE site_id='site'").run();
  const busy = await operator('PUT', '/sites/site/incremental', { fullNow: true });
  assert.ok(busy.status >= 400); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE site_id='site' AND status='queued'").get().n, 1);
  assert.equal(db.prepare("SELECT force_full FROM site_incremental WHERE site_id='site'").get().force_full, 3);
  // Turning the option on together with fullNow: a refused backup rolls back the settings change and its audit row.
  db.prepare("INSERT INTO sites(id,server_id,name,config,created_at) VALUES('site-b','srv','site-b','{}',?)").run(at);
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES('busy-b','site-b','backup','queued','queued',?)").run(at);
  const audits = () => db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='site.incremental_update' AND target='site-b'").get().n;
  assert.ok((await admin('PUT', '/sites/site-b/incremental', { enabled: true, fullNow: true })).status >= 400);
  assert.equal(db.prepare("SELECT 1 FROM site_incremental WHERE site_id='site-b'").get(), undefined); assert.equal(audits(), 0);
  db.prepare("DELETE FROM jobs WHERE id='busy-b'").run();
  const both = await json(await admin('PUT', '/sites/site-b/incremental', { enabled: true, fullNow: true }));
  assert.deepEqual([both.status, both.body.enabled, both.body.fullNextReason, audits()], [202, true, 'full-now', 1]);
  db.prepare('DELETE FROM jobs WHERE id IN (?,?)').run(now.body.job.id, both.body.job.id);
  // /api/state carries the setting for Docker sites only.
  const state = (await json(await operator('GET', '/state'))).body;
  assert.deepEqual(state.sites.find(item => item.id === 'site').incremental, { enabled: true, interval: 13 });
  assert.equal('incremental' in state.sites.find(item => item.id === 'static'), false);
  remoteCalls.length = 0;
  assert.equal((await json(await admin('PUT', '/sites/site/incremental', { enabled: false }))).body.enabled, false);
  assert.deepEqual(remoteCalls.map(call => [call.operation, call.siteKey]), [['incremental-discard', 'site']]);
  assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='site.incremental_update' AND target='site'").get());
});

test('backups list items carry their chain fields', async () => {
  const { body } = await json(await operator('GET', '/backups?limit=10'));
  const byId = new Map(body.items.map(item => [item.id, item]));
  assert.deepEqual(['backupKind', 'chainId', 'parentId', 'chainPosition', 'chainLength', 'dependents'].map(key => byId.get(members[1].id)[key]), ['incremental', chainId, members[0].id, 1, 2, 1]);
  assert.deepEqual(['backupKind', 'chainLength', 'dependents'].map(key => byId.get(members[0].id)[key]), ['full', 1, 2]);
  assert.deepEqual(['backupKind', 'chainId', 'chainLength'].map(key => byId.get(plainId)[key]), ['full', null, 1]);
});

test('ZIP export is refused for an increment; Download chain streams the encrypted packages and ORDER.txt', async () => {
  const zip = await json(await operator('POST', `/backups/${members[2].id}/zip-exports`));
  assert.deepEqual([zip.status, zip.body.code, zip.body.error], [409, 'incremental_zip', 'This backup is incremental. Use Download chain.']);
  assert.equal((await operator('GET', `/backups/${members[2].id}/download?format=zip`)).status, 409);
  const response = await operator('GET', `/backups/${members[2].id}/chain-download`);
  assert.equal(response.status, 200);
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(Number(response.headers.get('content-length')), body.length);
  // Walk the tar: ORDER.txt, then each package byte for byte, full first.
  const entries = [];
  for (let offset = 0; offset + 512 <= body.length;) {
    const header = body.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, ''), size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, ''), 8);
    entries.push([name, body.subarray(offset + 512, offset + 512 + size)]); offset += 512 + size + ((512 - size % 512) % 512);
  }
  assert.deepEqual(entries.map(([name]) => name), ['ORDER.txt', ...members.map((member, index) => `0${index + 1}-${member.id}.enc`)]);
  members.forEach((member, index) => assert.deepEqual(entries[index + 1][1], member.bytes));
  assert.match(entries[0][1].toString(), new RegExp(`^2 03-${members[2].id}\\.enc incremental ${members[2].id} ${members[2].checksum} ${members[2].size} ${members[1].id} ${members[1].checksum}$`, 'm'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM downloads').get().n, 0, 'download leases are released');
  assert.equal((await json(await operator('GET', `/backups/${plainId}/chain-download`))).body.code, 'not_incremental');
  // A damaged chain is refused before any byte is sent.
  db.prepare('UPDATE backups SET size=size+1 WHERE id=?').run(members[0].id);
  const broken = await json(await operator('GET', `/backups/${members[2].id}/chain-download`));
  assert.deepEqual([broken.status, broken.body.code], [409, 'chain_broken']);
  assert.match(broken.body.error, new RegExp(`depends on backup ${members[0].id}`));
  db.prepare('UPDATE backups SET size=size-1 WHERE id=?').run(members[0].id);
  // Every package must be verified, as for a single Download.
  db.prepare('UPDATE backups SET verified=0 WHERE id=?').run(members[1].id);
  assert.equal((await json(await operator('GET', `/backups/${members[2].id}/chain-download`))).body.code, 'chain_broken');
  db.prepare('UPDATE backups SET verified=1 WHERE id=?').run(members[1].id);
});

test('pinning an increment clears Object Lock deferrals of the packages it builds on', async () => {
  db.prepare('INSERT INTO retention_deferrals VALUES(?,?,NULL,?)').run(members[0].id, Date.now() + 1000, Date.now());
  assert.equal((await operator('POST', `/backups/${members[2].id}/pin`, { pinned: true })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM retention_deferrals').get().n, 0);
  assert.equal(db.prepare('SELECT pinned FROM backups WHERE id=?').get(members[0].id).pinned, 0, 'only the increment itself is pinned; its chain is kept through it');
});

test('update center: a downgrade warning while incremental backups exist, none otherwise', () => {
  const warning = downgradeWarning(db);
  assert.equal(warning.incrementalBackups, 2); assert.equal(warning.below, '2.12.0');
  assert.match(warning.message, /versions before 2.12.0 cannot restore them/); assert.match(warning.message, /Make a full backup and turn incremental off before downgrading to 2.11./);
  assert.equal(downgradeWarning(db, 0), null);
});
