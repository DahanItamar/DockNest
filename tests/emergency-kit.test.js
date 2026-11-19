// Kit check and the optional K-of-N split (docs/emergency-kit.md) against the loopback SFTP fixture: off by default, the
// split API (administrators, server-enforced re-verification, parts once with no-store), emergency kits after each Self
// Backup, re-split, "Go back to one passphrase", deleting old kits, the offline tool giving a kit that restore accepts,
// the kit check passing and failing cleanly, and no part, private key or word sequence in logs, audit, jobs or the DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, createHash, scryptSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { startSftpFixture } from './sftp-fixture.js';
const root = await mkdtemp(join(tmpdir(), 'docknest-emergency-kit-'));
Object.assign(process.env, { DATA_DIR: root, MASTER_KEY_FILE: join(root, 'master.key'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured', SECURE_COOKIES: 'false', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
// Everything DockNest prints while these tests run, searched for secrets at the end.
const printed = [];
for (const method of ['log', 'error', 'warn', 'info']) { const original = console[method]; console[method] = (...args) => { printed.push(args.map(String).join(' ')); original.apply(console, args); }; }
const { app } = await import('../src/server.js');
const { db, id } = await import('../src/db.js');
const { digest, seal } = await import('../src/crypto.js');
const { saveSelfBackupSettings, enqueueSelfBackup, claimSelfBackup, executeSelfBackup, readLatestSelfBackup, selfBackupDirectory } = await import('../src/self-backup.js');
const { restoreRecoveryKit, exportRecoveryKit, checkRecoveryKit } = await import('../src/recovery-kit.js');
const { claimKitCheck, executeKitCheck, queueKitCheckAfterBackup, requeueInterruptedKitChecks } = await import('../src/kit-check.js');
const { combineMnemonics } = await import('../src/emergency/slip39.js');
const { open, unpackKit, readEnvelopeHeader, publicKeyOf, publicKeyDigest } = await import('../src/emergency/envelope.js');
const { runWorkerLoop } = await import('../src/worker-loop.js');
const fixture = await startSftpFixture(), target = id(), passphrase = randomBytes(32).toString('base64url');
const now = () => new Date().toISOString();
db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(target, 'Kit storage', fixture.options.host, fixture.options.port, fixture.options.username, fixture.options.hostKey, 'password', seal(fixture.options.password), '/backups', 1e12, 'connected', now(), now());
db.prepare("INSERT INTO settings VALUES('backup_storage_target',?)").run(target);
const [administrator, operator, stale] = [id(), id(), id()], csrf = 'fixture-csrf', tokens = [0, 1, 2].map(() => randomBytes(32).toString('base64url'));
for (const [index, user] of [administrator, operator, stale].entries()) {
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(user, `user${index}@example.com`, 'fixture', seal('JBSWY3DPEHPK3PXP'), '[]', now(), 'Fixture', index === 1 ? 'operator' : 'admin');
  // The third administrator signed in an hour ago and has not re-verified since.
  const verified = index === 2 ? Date.now() - 3600_000 : Date.now();
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(tokens[index]), user, csrf, Date.now() + 3600_000, Date.now(), verified, verified);
}
// Two alert channels with no rule at all, and one rule for kit check failures on a third.
for (const name of ['phone', 'mail', 'ops']) {
  db.prepare("INSERT INTO connections(id,provider,name,secret,settings,created_at,updated_at) VALUES(?,'telegram',?,'sealed','{}',?,?)").run(name, name, now(), now());
  db.prepare("INSERT INTO alert_nodes(id,provider,name,connection_id,created_at,updated_at) VALUES(?,'telegram',?,?,?,?)").run('node-' + name, name, name, now(), now());
}
db.prepare("INSERT INTO alert_lines(id,node_id,source_kind,source_id,events,enabled,created_at,updated_at) VALUES('line','node-ops','docknest',NULL,?,1,?,?)").run(JSON.stringify(['selfbackup.kit_check_failed']), now(), now());
saveSelfBackupSettings({ enabled: false, schedule: '0 3 * * *', timezone: 'UTC', passphrase, recoverySecretSaved: true }, administrator);

const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const request = (route, { index = 0, body } = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/self-backup${route}`, { method: body ? 'POST' : 'GET', headers: { Cookie: 'dbm_session=' + tokens[index], Origin: process.env.APP_ORIGIN, 'x-csrf-token': csrf, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const status = async () => (await request('')).json();
const emergencyFiles = () => [...fixture.files.keys()].filter(name => name.startsWith('/backups/BACKUP/docknest-recovery/emergency/') && name.endsWith('.dkem')).sort();
const kitFiles = () => [...fixture.files.keys()].filter(name => name.endsWith('.dkit'));
// The worker's path: run the Self Backup, then the kit check it queues.
async function selfBackup() {
  enqueueSelfBackup(administrator);
  let idle = false;
  await runWorkerLoop({ active: () => !idle, maintain: async () => {}, tick: () => {}, claimSelfBackup, executeSelfBackup: async run => { if (await executeSelfBackup(run)) queueKitCheckAfterBackup(); }, claimKitCheck, executeKitCheck, claimJob: () => null, executeJob: async () => {}, idle: async () => { idle = true; } });
}
const outbox = event => db.prepare('SELECT connection_id FROM alert_outbox WHERE event=? ORDER BY connection_id').all(event).map(row => row.connection_id);
const secrets = new Set();
const split = async (body, index = 0) => {
  const response = await request('/emergency/split', { index, body }), result = await response.json();
  if (response.ok) for (const part of result.parts) secrets.add(part.words);
  return { response, result };
};

test('one passphrase is the default: no key pair, no emergency kit, and the kit check passes after a Self Backup', async () => {
  const before = await status();
  assert.deepEqual(before.emergency, { split: false, oldKits: 0 }); assert.deepEqual(before.kitCheck, { last: null, active: false });
  assert.equal((await request('/kit-check', { body: {} })).status, 409, 'nothing to check before the first Self Backup');
  await selfBackup();
  assert.equal(kitFiles().length, 1); assert.deepEqual(emergencyFiles(), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM emergency_keys').get().n, 0);
  const after = await status();
  assert.equal(after.kitCheck.last.result, 'passed'); assert.equal(after.kitCheck.last.reason, null); assert.equal(after.kitCheck.active, false);
  assert.equal(db.prepare("SELECT backup_id FROM kit_checks WHERE result='passed'").get().backup_id, after.latest.id);
  assert.deepEqual((await readdir(await selfBackupDirectory())).filter(name => name.startsWith('.')), [], 'no kit check folder is left behind');
  assert.deepEqual(outbox('selfbackup.kit_check_failed'), []);
});

test('Check now queues one check at a time for administrators, and an interrupted check runs again', async () => {
  assert.equal((await request('/kit-check', { index: 1, body: {} })).status, 403);
  const queued = await request('/kit-check', { body: {} }); assert.equal(queued.status, 202); assert.equal((await queued.json()).result, 'queued');
  assert.equal((await request('/kit-check', { body: {} })).status, 409);
  const check = claimKitCheck(); requeueInterruptedKitChecks();
  assert.equal(db.prepare('SELECT result FROM kit_checks WHERE id=?').get(check.id).result, 'queued');
  await executeKitCheck(claimKitCheck());
  assert.equal(db.prepare('SELECT result FROM kit_checks WHERE id=?').get(check.id).result, 'passed');
});

test('a corrupted kit fails the check cleanly with a reason code and raises selfbackup.kit_check_failed', async () => {
  const [file] = kitFiles(), good = Buffer.from(fixture.files.get(file));
  fixture.files.get(file)[60] ^= 1;
  try { queueKitCheckAfterBackup(); await executeKitCheck(claimKitCheck()); } finally { fixture.files.set(file, good); }
  const { last } = (await status()).kitCheck;
  assert.deepEqual([last.result, last.reason], ['failed', 'unreadable']);
  assert.deepEqual(outbox('selfbackup.kit_check_failed'), ['ops'], 'only the channel whose rule selects it');
  const audit = db.prepare("SELECT detail FROM audit_events WHERE action='manager-backup.kit_check' ORDER BY created_at DESC,rowid DESC LIMIT 1").get();
  assert.deepEqual(JSON.parse(audit.detail), { result: 'failed', reason: 'unreadable' });
  assert.deepEqual((await readdir(await selfBackupDirectory())).filter(name => name.startsWith('.')), []);
});

test('checkRecoveryKit: wrong passphrase, other master key, damaged hashes and a corrupt database each give their reason', async () => {
  const kitFile = join(root, 'check.dkit'), live = Buffer.from((await readFile(process.env.MASTER_KEY_FILE, 'utf8')).trim(), 'base64'), parent = await selfBackupDirectory();
  await exportRecoveryKit({ database: db, masterKey: process.env.MASTER_KEY_FILE, output: kitFile, passphrase });
  const bytes = await readFile(kitFile), check = (kit, options = {}) => checkRecoveryKit({ bytes: kit, passphrase, masterKey: live, parent, ...options });
  // Re-seals the kit's JSON after a change, as an attacker or a disk fault could not, to reach the later checks.
  const reseal = change => {
    const header = bytes.subarray(0, 32), key = scryptSync(passphrase, header.subarray(4, 20), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(20)); decipher.setAAD(header); decipher.setAuthTag(bytes.subarray(-16));
    const decoded = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(32, -16)), decipher.final()]).toString()); change(decoded);
    const cipher = createCipheriv('aes-256-gcm', key, header.subarray(20)); cipher.setAAD(header);
    return Buffer.concat([header, cipher.update(JSON.stringify(decoded)), cipher.final(), cipher.getAuthTag()]);
  };
  assert.deepEqual(await check(bytes), { passed: true, reason: null });
  assert.deepEqual(await check(bytes, { passphrase: passphrase + 'x' }), { passed: false, reason: 'passphrase' });
  assert.deepEqual(await check(bytes, { masterKey: randomBytes(32) }), { passed: false, reason: 'key_mismatch' });
  assert.deepEqual(await check(Buffer.from('DKN2' + bytes.toString('latin1').slice(4), 'latin1')), { passed: false, reason: 'format' });
  assert.deepEqual(await check(reseal(kit => { kit.files['recovery/README.md'].sha256 = '0'.repeat(64); })), { passed: false, reason: 'hashes' });
  assert.deepEqual(await check(reseal(kit => { delete kit.files['recovery/README.md']; })), { passed: false, reason: 'contents' });
  // A kit made before 3.0 has no emergency tool: it still checks and restores.
  const earlier = reseal(kit => { delete kit.files['recovery/emergency-open.js']; });
  assert.deepEqual(await check(earlier), { passed: true, reason: null });
  await writeFile(join(root, 'earlier.dkit'), earlier);
  assert.equal((await restoreRecoveryKit({ input: join(root, 'earlier.dkit'), directory: join(root, 'earlier-restored'), passphrase })).restored, true);
  const corrupt = Buffer.from('not an sqlite database, only bytes'), sha = createHash('sha256').update(corrupt).digest('hex');
  assert.deepEqual(await check(reseal(kit => { kit.files['state.sqlite'] = { sha256: sha, body: corrupt.toString('base64') }; })), { passed: false, reason: 'integrity' });
  assert.deepEqual((await readdir(parent)).filter(name => name.startsWith('.kit-check-')), [], 'the folder is removed in every case');
});

test('the split is administrators only, needs a fresh re-verification on the server and validates K, N and the names', async () => {
  const body = { k: 2, n: 3, labels: ['Dana', 'Noam', 'Lior'] };
  assert.equal((await split(body, 1)).response.status, 403);
  const reauth = await split(body, 2); assert.equal(reauth.response.status, 403); assert.equal(reauth.result.code, 'REAUTH_REQUIRED');
  assert.equal((await request('/emergency/off', { index: 2, body: {} })).status, 403);
  assert.equal((await request('/emergency/delete-old-kits', { index: 2, body: {} })).status, 403);
  for (const bad of [{ k: 1, n: 3, labels: ['a', 'b', 'c'] }, { k: 4, n: 3, labels: ['a', 'b', 'c'] }, { k: 2, n: 3, labels: ['a', 'b'] }, { k: 2, n: 17, labels: Array(17).fill('a') }, { k: 2, n: 2, labels: ['a', 'b\u0000'] }, { ...body, extra: true }]) assert.equal((await split(bad)).response.status, 400, JSON.stringify(bad));
  assert.equal((await request('/emergency/off', { body: {} })).status, 409, 'nothing to turn off');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM emergency_keys').get().n, 0);
});

let firstParts, firstDigest;
test('a split returns 33-word parts once, stores only public material, alerts every channel and seals each new Self Backup', async () => {
  const { response, result } = await split({ k: 2, n: 3, labels: ['Dana', 'Noam', 'Lior'] });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(result.parts.map(part => [part.number, part.label, part.words.split(' ').length]), [[1, 'Dana', 33], [2, 'Noam', 33], [3, 'Lior', 33]]);
  firstParts = result.parts.map(part => part.words); firstDigest = result.digest;
  const key = combineMnemonics([firstParts[0], firstParts[2]]); secrets.add(key.toString('hex')); secrets.add(key.toString('base64')); secrets.add(key.toString('base64url'));
  assert.equal(publicKeyDigest(publicKeyOf(key)), result.digest, 'the digest on the parts belongs to the joined key');
  const row = db.prepare('SELECT * FROM emergency_keys WHERE retired_at IS NULL').get();
  assert.deepEqual({ ...row, id: null, created_at: null }, { id: null, public_key: publicKeyOf(key).toString('base64url'), digest: result.digest, identifier: result.identifier, k: 2, n: 3, labels: '["Dana","Noam","Lior"]', created_by: administrator, created_at: null, retired_at: null });
  assert.deepEqual(outbox('emergency.key_changed'), ['mail', 'ops', 'phone'], 'every channel, with or without a rule');
  assert.deepEqual(JSON.parse(db.prepare("SELECT detail FROM audit_events WHERE action='emergency.split'").get().detail), { k: 2, n: 3, digest: result.digest });
  const view = (await status()).emergency;
  assert.deepEqual({ ...view, createdAt: null }, { split: true, digest: result.digest, identifier: result.identifier, k: 2, n: 3, labels: ['Dana', 'Noam', 'Lior'], createdAt: null, latestKitAt: null, oldKits: 0 });
  assert.ok(!JSON.stringify(await status()).includes(firstParts[0].split(' ').slice(0, 4).join(' ')), 'the status never repeats a part');

  await selfBackup();
  const [file] = emergencyFiles(), sealed = fixture.files.get(file);
  assert.match(file, new RegExp(`/emergency_${result.digest.slice(0, 16)}_[0-9_-]+Z--[0-9a-f-]{36}\\.dkem$`));
  assert.equal(readEnvelopeHeader(sealed).digest, result.digest);
  const contents = unpackKit(open(sealed, key)), latest = await readLatestSelfBackup();
  assert.deepEqual(contents.kit, latest.bytes, 'the emergency kit holds the very recovery kit just published');
  assert.equal(contents.passphrase, passphrase);
  assert.equal((await status()).kitCheck.last.result, 'passed');
  assert.ok((await status()).emergency.latestKitAt);

  // The offline tool with K parts gives a recovery kit that restore accepts.
  const work = await mkdtemp(join(tmpdir(), 'docknest-emergency-open-'));
  try {
    await writeFile(join(work, 'kit.dkem'), sealed);
    const opened = spawnSync(process.execPath, ['scripts/emergency-open.js', 'open', work, join(work, 'opened')], { input: `${firstParts[1]}\n${firstParts[0]}\n`, encoding: 'utf8' });
    assert.equal(opened.status, 0, opened.stderr);
    for (const secret of secrets) assert.ok(!(opened.stdout + opened.stderr).includes(secret));
    const restored = await restoreRecoveryKit({ input: join(work, 'opened', 'docknest-recovery.dkit'), directory: join(work, 'restored'), passphrase: await readFile(join(work, 'opened', 'recovery-passphrase.txt'), 'utf8') });
    assert.equal(restored.restored, true);
    assert.ok((await readdir(join(work, 'restored', 'recovery'))).includes('emergency-open.js'), 'the recovery kit carries the offline tool');
  } finally { await rm(work, { recursive: true, force: true }); }

  await selfBackup();
  assert.equal(emergencyFiles().length, 1, 'a newer kit of the same key replaces the older one');
  assert.notEqual(emergencyFiles()[0], file);
});

test('a re-split retires the old key, keeps its kit until deleted, and old parts open only that old kit', async () => {
  const oldFile = emergencyFiles()[0];
  const { response, result } = await split({ k: 3, n: 4, labels: ['Dana', 'Noam', 'Lior', 'Maya'] });
  assert.equal(response.status, 200); assert.notEqual(result.digest, firstDigest);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM emergency_keys WHERE retired_at IS NOT NULL').get().n, 1);
  assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='emergency.resplit'").get());
  assert.equal(outbox('emergency.key_changed').length, 6, 'every channel again');
  await selfBackup();
  assert.equal(emergencyFiles().length, 2); assert.equal((await status()).emergency.oldKits, 1);
  const newFile = emergencyFiles().find(name => name !== oldFile), newKey = combineMnemonics(result.parts.slice(1).map(part => part.words)), oldKey = combineMnemonics(firstParts.slice(0, 2));
  secrets.add(newKey.toString('hex')); secrets.add(newKey.toString('base64'));
  assert.throws(() => open(fixture.files.get(newFile), oldKey), /do not open/); assert.ok(open(fixture.files.get(oldFile), oldKey));
  assert.ok(open(fixture.files.get(newFile), newKey));
  const deleted = await request('/emergency/delete-old-kits', { body: {} });
  assert.deepEqual(await deleted.json(), { deleted: 1, failed: 0 });
  assert.deepEqual(emergencyFiles(), [newFile]); assert.equal((await status()).emergency.oldKits, 0);
});

test('Go back to one passphrase stops new emergency kits and lets the owner delete the last ones', async () => {
  const off = await request('/emergency/off', { body: {} });
  assert.equal(off.status, 200); assert.deepEqual(await off.json(), { split: false });
  assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='emergency.retired'").get());
  const before = emergencyFiles();
  await selfBackup();
  assert.deepEqual(emergencyFiles(), before, 'no new emergency kit');
  assert.deepEqual((await status()).emergency, { split: false, oldKits: 1 });
  assert.deepEqual(await (await request('/emergency/delete-old-kits', { body: {} })).json(), { deleted: 1, failed: 0 });
  assert.deepEqual(emergencyFiles(), []); assert.deepEqual((await status()).emergency, { split: false, oldKits: 0 });
});

test('no part, private key or run of part words reaches the database, audit, alerts, job details, settings or the logs', async () => {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const files = (await readdir(root)).filter(name => name.startsWith('state.sqlite'));
  const raw = Buffer.concat(await Promise.all(files.map(name => readFile(join(root, name))))).toString('latin1');
  const tables = ['audit_events', 'alert_outbox', 'jobs', 'settings', 'emergency_keys', 'kit_checks'].map(table => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).join('\n');
  const logs = printed.join('\n');
  const runs = [...secrets].filter(secret => secret.includes(' ')).flatMap(words => { const list = words.split(' '); return list.slice(0, -3).map((_, index) => list.slice(index, index + 4).join(' ')); });
  assert.ok(secrets.size >= 9);
  for (const secret of [...secrets, ...runs]) for (const [where, text] of [['database file', raw], ['tables', tables], ['logs', logs]]) assert.ok(!text.includes(secret), `${where} holds a secret`);
});

test.after(async () => { await new Promise(resolve => server.close(resolve)); await fixture.close(); db.close(); await rm(root, { recursive: true, force: true }); });
