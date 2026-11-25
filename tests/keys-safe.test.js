// Keys safe (docs/keys-safe.md) without SSH: the rule list schema, the install fingerprint key, the silent first
// baseline, config.changed once per new fingerprint set, known-good (Safe Edit, restore, administrator), the re-baseline
// after a key change, the padlock table, the key proof of a backup and of a restore test, and that a known key value,
// its SHA-256 and its base64 never reach the API, the audit trail, alerts, jobs or logs. Real Docker:
// scripts/integration-keys-safe.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash, createHmac, hkdfSync } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-keys-safe-'));
Object.assign(process.env, { DATA_DIR: join(directory, 'data'), BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
const masterKey = randomBytes(32);
await writeFile(process.env.MASTER_KEY_FILE, masterKey.toString('base64'));
// Everything DockNest prints while these tests run, checked for the key value at the end.
const printed = [];
for (const name of ['log', 'warn', 'error']) { const original = console[name]; console[name] = (...args) => { printed.push(args.map(String).join(' ')); original(...args); }; }

const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const { KEY_RULES, KEY_KINDS, keyRuleProblems, keyRule } = await import('../shared/key-rules.js');
const { fingerprintKey, fingerprintKeyCheck, installId, keysRequest } = await import('../src/keys-safe/fingerprint.js');
const store = await import('../src/keys-safe/store.js');
const { keysView } = await import('../src/keys-safe/padlock.js');
const { safeEditItems } = await import('../src/keys-safe/scan.js');
const { provenKeys, compareRestoredKeys, restoredKeysRequest } = await import('../src/keys-safe/restored.js');
const engine = await import('../src/engine.js');
const alerts = await import('../src/alerts/store.js');
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
test.after(() => listener.close());

// A made-up key value; none of these forms may appear anywhere DockNest stores, returns or prints.
const VALUE = 'base64:' + randomBytes(32).toString('base64');
const FORMS = [VALUE, createHash('sha256').update(VALUE).digest('hex'), Buffer.from(VALUE).toString('base64'), VALUE.slice(7)];
const assertNoValue = (text, where) => { for (const form of FORMS) assert.ok(!String(text).includes(form), `${where} holds the key value or a plain hash of it`); };
const fp = (ruleId, value) => createHmac('sha256', fingerprintKey()).update(Buffer.concat([Buffer.from(ruleId), Buffer.from([0]), Buffer.from(value)])).digest('hex').slice(0, 32);
const fileFp = text => createHmac('sha256', fingerprintKey()).update(Buffer.concat([Buffer.from('docknest-file'), Buffer.from([0]), Buffer.from(text)])).digest('hex').slice(0, 32);
const at = new Date().toISOString();
const serverRow = name => { const serverId = randomUUID(); db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(serverId, name, '192.0.2.10', 22, 'root', 'unused', 'a'.repeat(64), 'connected', at); return serverId; };
const siteRow = (serverId, name, config = { containers: ['wiki-web-1'], composeFiles: ['/srv/wiki/compose.yaml'], configFiles: ['/srv/wiki/.env'] }) => { const siteId = randomUUID(); db.prepare('INSERT INTO sites(id,server_id,name,config,created_at) VALUES(?,?,?,?,?)').run(siteId, serverId, name, JSON.stringify(config), at); return siteId; };
const backupRow = (siteId, capturedAt, manifest = {}) => { const backupId = randomUUID(), jobId = randomUUID(); db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','completed','completed',?)").run(jobId, siteId, capturedAt); db.prepare('INSERT INTO backups(id,site_id,job_id,captured_at,path,size,checksum,manifest,verified,pinned,created_at) VALUES(?,?,?,?,?,?,?,?,1,0,?)').run(backupId, siteId, jobId, capturedAt, 'fixture/' + backupId + '.enc', 1, 'a'.repeat(64), JSON.stringify(manifest), capturedAt); return backupId; };
const audits = (action, target) => db.prepare('SELECT detail FROM audit_events WHERE action=? AND target IS ? ORDER BY created_at,id').all(action, target).map(row => JSON.parse(row.detail));
const items = siteId => Object.fromEntries(db.prepare('SELECT * FROM config_fingerprints WHERE site_id=?').all(siteId).map(row => [row.item, row]));
const scanOf = ({ compose = 'services: {}\n', env = `APP_KEY=${VALUE}\n`, value = VALUE, extra = [] } = {}) => ({
  keys: [{ rule: 'laravel-app-key', location: 'env:wiki-web-1', fingerprint: fp('laravel-app-key', value) }, { rule: 'laravel-app-key', location: 'file:/srv/wiki/.env', fingerprint: fp('laravel-app-key', value) }, ...extra],
  files: [{ path: '/srv/wiki/compose.yaml', fingerprint: fileFp(compose) }, { path: '/srv/wiki/.env', fingerprint: fileFp(env) }],
});

function user(role, { recent = true } = {}) {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId, userId + '@example.invalid', 'fixture', 'fixture', '[]', at, role + ' user', role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), userId, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), recent ? Date.now() : Date.now() - 3600000);
  return (method, route, body) => fetch(base + route, { method, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, 'x-csrf-token': 'csrf', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then(async response => ({ status: response.status, text: await response.text() })).then(({ status, text }) => ({ status, text, body: JSON.parse(text) }));
}

test('the rule list: plain data, every seed rule valid, unique ids, every kind, image hints only on generic names', () => {
  assert.deepEqual(KEY_RULES.map(rule => keyRuleProblems(rule)).filter(problems => problems.length), []);
  assert.equal(new Set(KEY_RULES.map(rule => rule.id)).size, KEY_RULES.length);
  assert.deepEqual([...new Set(KEY_RULES.map(rule => rule.kind))].sort(), [...KEY_KINDS].sort());
  for (const name of ['APP_KEY', 'N8N_ENCRYPTION_KEY', 'SECRET_KEY_BASE', 'OTP_SECRET', 'AUTHENTIK_SECRET_KEY', 'PAPERLESS_SECRET_KEY', 'NEXTAUTH_SECRET', 'UTILS_SECRET']) assert.ok(KEY_RULES.some(rule => rule.name === name), name);
  assert.deepEqual(KEY_RULES.filter(rule => rule.name === 'SECRET_KEY' && rule.kind === 'env').map(rule => [rule.id, rule.image.length > 0]), [['outline-secret-key', true], ['django-secret-key', true]]);
  assert.deepEqual([keyRule('gitea-secret-key').section, keyRule('nextcloud-secret').file, keyRule('vaultwarden-rsa').path], ['security', 'config/config.php', 'rsa_key.pem']);
  assert.ok(Object.isFrozen(KEY_RULES) && KEY_RULES.every(Object.isFrozen));
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(KEY_RULES))), JSON.stringify(KEY_RULES), 'plain JSON data, as the helper receives it');
  for (const bad of [null, { id: 'Bad Id', app: 'x', kind: 'env', name: 'A' }, { id: 'a', app: 'x', kind: 'yaml', name: 'A' }, { id: 'a', app: 'x', kind: 'file', path: '../etc/shadow' }, { id: 'a', app: 'x', kind: 'env', name: 'A', path: 'x' }, { id: 'a', app: 'x', kind: 'ini', file: 'app.ini', name: 'A' }, { id: 'a', app: 'x', kind: 'env', name: 'A', image: ['UPPER'] }, { id: 'a', app: '', kind: 'env', name: 'A' }]) assert.ok(keyRuleProblems(bad).length, JSON.stringify(bad));
});

test('the fingerprint key is HKDF-SHA256 of the master key with the install id and the server id, stable, and never stored', () => {
  const id = installId();
  assert.equal(installId(), id, 'one install id');
  assert.deepEqual(fingerprintKey(), Buffer.from(hkdfSync('sha256', masterKey, id, 'docknest key fingerprint v1', 32)));
  assert.deepEqual(fingerprintKey('server-a'), Buffer.from(hkdfSync('sha256', masterKey, id, 'docknest key fingerprint v1\0server-a', 32)));
  assert.notDeepEqual(fingerprintKey('server-a'), fingerprintKey('server-b'), 'fingerprints from two servers cannot be linked');
  assert.notEqual(fingerprintKeyCheck('server-a'), fingerprintKeyCheck('server-b'));
  // A known answer shared with remote/test_keys.py: the same key, rule and value give the same fingerprint in both.
  assert.equal(createHmac('sha256', Buffer.from([...Array(32).keys()])).update(Buffer.from('laravel-app-key\0base64:example-value')).digest('hex').slice(0, 32), '372a976441289f5e938a50f5f0854fa1');
  assert.equal(Buffer.from(hkdfSync('sha256', Buffer.alloc(32, 7), 'install-example', 'docknest key fingerprint v1', 32)).toString('hex'), '8a83e6d685821150680f171cc6214255eedd47545f27989405563e85ff5a6cdc');
  const request = keysRequest('server-a');
  assert.equal(Buffer.from(request.fingerprintKey, 'base64').length, 32); assert.equal(request.rules, KEY_RULES);
  const dump = JSON.stringify(db.prepare('SELECT key,value FROM settings').all());
  assert.ok(!dump.includes(request.fingerprintKey) && !dump.includes(fingerprintKey('server-a').toString('hex')), 'fpKey is not in settings');
});

test('the first scan is a silent baseline; a hand change raises config.changed once per new fingerprint set', () => {
  const serverId = serverRow('Main server'), siteId = siteRow(serverId, 'Wiki');
  const credential = alerts.createCredential({ kind: 'telegram', name: 'Bot', config: { token: '123456789:' + 'AbCdEf_-12'.repeat(4).slice(0, 35) } }, 'test');
  const channel = alerts.createChannel({ kind: 'telegram', name: 'Phone', credentialId: credential.id, config: { chatId: '-1001234567890' } }, 'test');
  alerts.createRule({ channelId: channel.id, sourceKind: 'site', sourceId: siteId, events: ['config.changed'] }, 'test');
  const outbox = () => db.prepare("SELECT COUNT(*) AS n FROM alert_outbox WHERE event='config.changed'").get().n;
  assert.equal(store.recordScan(siteId, scanOf()), true);
  const first = items(siteId);
  assert.deepEqual(Object.keys(first).sort(), ['/srv/wiki/.env', '/srv/wiki/compose.yaml', 'laravel-app-key@env:wiki-web-1', 'laravel-app-key@file:/srv/wiki/.env']);
  assert.ok(Object.values(first).every(row => row.known_good === row.fingerprint && row.known_good_source === 'baseline' && row.first_seen_changed_at === null));
  assert.equal(audits('config.changed', siteId).length, 0); assert.equal(outbox(), 0);
  store.recordScan(siteId, scanOf());
  assert.equal(audits('config.changed', siteId).length, 0, 'the same files again: nothing');
  const edited = scanOf({ compose: 'services: {web: {image: "app:2"}}\n' });
  store.recordScan(siteId, edited); store.recordScan(siteId, edited); store.recordScan(siteId, edited);
  assert.equal(audits('config.changed', siteId).length, 1, 'once for this fingerprint set'); assert.equal(outbox(), 1);
  assert.deepEqual(audits('config.changed', siteId)[0], { files: ['/srv/wiki/compose.yaml'], keys: [] });
  const changedAt = items(siteId)['/srv/wiki/compose.yaml'].first_seen_changed_at; assert.ok(changedAt);
  assert.match(db.prepare("SELECT message FROM alert_outbox WHERE event='config.changed'").get().message, /Wiki on Main server changed outside Safe Edit/);
  // A second change to another file is a new set: one more alert; the first time seen stays.
  store.recordScan(siteId, scanOf({ compose: 'services: {web: {image: "app:2"}}\n', env: `APP_KEY=${VALUE}\nDEBUG=1\n` }));
  assert.equal(audits('config.changed', siteId).length, 2); assert.equal(items(siteId)['/srv/wiki/compose.yaml'].first_seen_changed_at, changedAt);
  // Put back by hand: known-good again, no alert.
  store.recordScan(siteId, scanOf());
  assert.ok(Object.values(items(siteId)).every(row => row.first_seen_changed_at === null)); assert.equal(audits('config.changed', siteId).length, 2);
  // A changed key value is a changed item too, named by its key name only.
  store.recordScan(siteId, scanOf({ value: 'base64:another-made-up-value' }));
  assert.deepEqual(audits('config.changed', siteId)[2], { files: [], keys: ['APP_KEY'] });
  for (const row of db.prepare("SELECT message,payload FROM alert_outbox WHERE event='config.changed'").all()) assertNoValue(JSON.stringify(row), 'the alert');
});

test('known-good: Safe Edit marks the files it wrote, an administrator re-verifies, audit entries name files and keys only', async () => {
  const serverId = serverRow('Edit server'), siteId = siteRow(serverId, 'Shop');
  store.recordScan(siteId, scanOf());
  // The scan that marks known-good is the scan that sees the change: trusted items raise no alert, the others do.
  const only = safeEditItems({ written: ['/srv/wiki/compose.yaml'], recreated: ['web'], project: 'wiki' });
  store.recordScan(siteId, scanOf({ compose: 'changed: 1\n', env: 'APP_KEY=x\n', value: 'x' }), { trust: { source: 'safe-edit', actor: 'edit:1', only } });
  assert.deepEqual(audits('config.changed', siteId), [{ files: ['/srv/wiki/.env'], keys: ['APP_KEY'] }], 'only what the edit did not write');
  const after = items(siteId);
  assert.equal(after['/srv/wiki/compose.yaml'].known_good_source, 'safe-edit'); assert.equal(after['/srv/wiki/compose.yaml'].first_seen_changed_at, null);
  assert.equal(after['laravel-app-key@env:wiki-web-1'].known_good_source, 'safe-edit');
  assert.ok(after['/srv/wiki/.env'].first_seen_changed_at, 'a file the edit did not write stays changed');
  assert.deepEqual(audits('config.known_good', siteId)[0], { source: 'safe-edit', files: ['/srv/wiki/compose.yaml'], keys: ['APP_KEY'] });
  assert.equal(keysView(siteId).state, 'red', 'still no backup');

  // The API: operators cannot, a stale sign-in cannot, an administrator with a fresh one can, after a fresh scan.
  const scans = [];
  engine.transport.remote = async (_server, request) => { scans.push(request); return request.operation === 'key-scan' ? scanOf({ compose: 'changed again: 2\n', env: 'APP_KEY=x\n', value: 'x' }) : {}; };
  const operator = user('operator'), stale = user('admin', { recent: false }), admin = user('admin');
  assert.equal((await operator('POST', `/sites/${siteId}/keys/known-good`)).status, 403);
  assert.equal((await stale('POST', `/sites/${siteId}/keys/known-good`)).body.code, 'REAUTH_REQUIRED');
  assert.equal(scans.length, 0);
  const marked = await admin('POST', `/sites/${siteId}/keys/known-good`);
  assert.equal(marked.status, 200, marked.text);
  assert.equal(scans.length, 1); assert.equal(scans[0].operation, 'key-scan'); assert.equal(Buffer.from(scans[0].keys.fingerprintKey, 'base64').length, 32);
  assert.deepEqual(marked.body.changed, []); assert.equal(marked.body.knownGood.source, 'admin');
  assert.equal(audits('config.changed', siteId).length, 1, 'a change the administrator marks raises no alert');
  assert.ok(Object.values(items(siteId)).every(row => row.first_seen_changed_at === null && row.known_good === row.fingerprint));
  const entry = audits('config.known_good', siteId).at(-1);
  assert.deepEqual(entry, { source: 'admin', files: ['/srv/wiki/.env', '/srv/wiki/compose.yaml'], keys: ['APP_KEY'] });
  // A scan that fails marks nothing.
  engine.transport.remote = async () => { throw Object.assign(new Error('unreachable'), { code: 'ECONNREFUSED' }); };
  store.recordScan(siteId, scanOf());
  const refused = await admin('POST', `/sites/${siteId}/keys/known-good`);
  assert.equal(refused.status, 409); assert.equal(refused.body.code, 'SCAN_FAILED');
  assert.ok(items(siteId)['/srv/wiki/.env'].first_seen_changed_at, 'still changed');
  assert.equal((await admin('POST', '/sites/not-a-uuid/keys/known-good')).status, 400);
});

test('a new fingerprint key (rotation) re-baselines each app silently with one audit entry', () => {
  const serverId = serverRow('Rotation server'), siteId = siteRow(serverId, 'Notes'), other = siteRow(serverId, 'Blog');
  store.recordScan(siteId, scanOf()); store.recordScan(other, scanOf());
  store.recordScan(other, scanOf({ compose: 'hand edit\n' }));
  const alerted = audits('config.changed', other).length;
  const keyRow = db.prepare('SELECT * FROM app_keys WHERE site_id=? AND location=?').get(siteId, 'env:wiki-web-1');
  db.prepare('UPDATE app_keys SET in_backup=? WHERE site_id=?').run('backup-before-rotation', siteId);
  // A new install id gives a new fpKey, exactly as a new master key does: every stored fingerprint is now foreign.
  db.prepare("UPDATE settings SET value=? WHERE key='install_id'").run(randomUUID());
  const before = audits('keys.rebaselined', null).length;
  store.recordScan(siteId, scanOf()); store.recordScan(other, scanOf({ compose: 'hand edit\n' }));
  assert.equal(audits('keys.rebaselined', null).length, before + 1);
  assert.equal(audits('config.changed', siteId).length, 0); assert.equal(audits('config.changed', other).length, alerted, 'no false alert');
  const row = db.prepare('SELECT * FROM app_keys WHERE site_id=? AND location=?').get(siteId, 'env:wiki-web-1');
  assert.notEqual(row.fingerprint, keyRow.fingerprint); assert.equal(row.in_backup, 'backup-before-rotation'); assert.equal(row.changed_at, null);
  assert.ok(Object.values(items(siteId)).every(item => item.known_good === item.fingerprint));
  assert.ok(items(other)['/srv/wiki/compose.yaml'].first_seen_changed_at, 'an item that was changed stays changed');
  // After its re-baseline, a real change is an alert again.
  store.recordScan(siteId, scanOf({ compose: 'later hand edit\n' }));
  assert.equal(audits('config.changed', siteId).length, 1);
});

test('the padlock: none, red without a backup, green in the last backup, amber when changed after it, verified by a restore test', () => {
  const serverId = serverRow('Padlock server'), siteId = siteRow(serverId, 'Docs');
  assert.deepEqual(keysView(siteId), { state: 'none', keys: [], changed: [], knownGood: null });
  store.recordScan(siteId, { keys: [], files: [{ path: '/srv/wiki/compose.yaml', fingerprint: fileFp('a') }] });
  assert.equal(keysView(siteId).state, 'none', 'files only, unchanged');
  store.recordScan(siteId, { keys: [], files: [{ path: '/srv/wiki/compose.yaml', fingerprint: fileFp('b') }] });
  assert.equal(keysView(siteId).state, 'amber', 'a changed item without keys');
  store.recordScan(siteId, scanOf(), { trust: { source: 'admin', actor: 'test' } });
  let view = keysView(siteId);
  assert.equal(view.state, 'red'); assert.deepEqual(view.keys.map(key => [key.status, key.reason]), [['missing', 'This app has no backup yet.'], ['missing', 'This app has no backup yet.']]);
  const scan = scanOf({ extra: [{ rule: 'rails-secret-key-base', location: 'file:/srv/wiki/extra.env', fingerprint: fp('rails-secret-key-base', 'made-up') }] });
  const proof = { keys: scan.keys.map(key => ({ ...key, inBackup: key.location !== 'file:/srv/wiki/extra.env', ...(key.location === 'file:/srv/wiki/extra.env' ? { reason: 'not-included' } : {}) })), files: scan.files };
  const backupId = backupRow(siteId, new Date(Date.now() - 60000).toISOString(), { keys: store.cleanScan(proof).keys, keysServerId: serverId, keysCheck: fingerprintKeyCheck(serverId) });
  store.recordScan(siteId, proof, { backup: { id: backupId, backupKind: 'full', chainId: null } });
  view = keysView(siteId);
  assert.equal(view.state, 'red');
  assert.deepEqual(view.keys.find(key => key.location === 'file:/srv/wiki/extra.env'), { ruleId: 'rails-secret-key-base', app: 'Rails apps (Mastodon, GitLab)', name: 'SECRET_KEY_BASE', location: 'file:/srv/wiki/extra.env', fingerprint: fp('rails-secret-key-base', 'made-up').slice(0, 8), backupId: null, status: 'missing', reasonCode: 'not-included', reason: 'The file is not one of the files this app backs up.' });
  const inBackup = { ...proof, keys: proof.keys.filter(key => key.inBackup) };
  store.recordScan(siteId, inBackup, { backup: { id: backupId, backupKind: 'full', chainId: null } });
  view = keysView(siteId);
  assert.equal(view.state, 'green'); assert.ok(view.keys.every(key => key.status === 'in-backup' && key.backupId === backupId && /^[0-9a-f]{8}$/.test(key.fingerprint)));
  // Verified: a restore test whose restored keys matched.
  const saved = provenKeys(db.prepare('SELECT manifest FROM backups WHERE id=?').get(backupId).manifest), proven = saved.keys;
  assert.equal(proven.length, 2); assert.equal(saved.comparable, true);
  assert.deepEqual(provenKeys(JSON.stringify({ keys: proven.map(key => ({ ...key, inBackup: true })), keysCheck: 'f'.repeat(32) })).comparable, false, 'a proof made with another fingerprint key is not compared');
  assert.deepEqual(restoredKeysRequest(proven).expect, proven.map(({ rule, location }) => ({ rule, location })));
  assert.equal(compareRestoredKeys(proven, undefined).check.status, 'skipped');
  assert.deepEqual(compareRestoredKeys(proven, [{ ...proven[0] }, { ...proven[1], fingerprint: null }]).failed, true);
  const matched = compareRestoredKeys(proven, proven.map(key => ({ ...key })));
  assert.deepEqual([matched.check.status, matched.check.detail, matched.verified.length], ['passed', '2 keys match the backup', 2]);
  store.markVerified(siteId, 'test-1', matched.verified);
  assert.ok(keysView(siteId).keys.every(key => key.status === 'verified' && key.verifiedTestId === 'test-1'));
  // A value changed after the newest backup: amber, "changed", and no longer verified.
  store.recordScan(siteId, scanOf({ value: 'base64:a-newer-made-up-value' }));
  view = keysView(siteId);
  assert.equal(view.state, 'amber'); assert.ok(view.keys.every(key => key.status === 'changed' && key.changedAt));
  assert.deepEqual(db.prepare('SELECT verified_test_id,in_backup FROM app_keys WHERE site_id=?').all(siteId).map(row => ({ ...row })), [{ verified_test_id: null, in_backup: null }, { verified_test_id: null, in_backup: null }]);
});

test('an increment that does not hold an unchanged key file keeps it in the chain; anything else is not carried', () => {
  const serverId = serverRow('Chain server'), siteId = siteRow(serverId, 'Vault');
  const key = { rule: 'vaultwarden-rsa', location: 'file:/var/lib/docker/volumes/vw/_data/rsa_key.pem', fingerprint: fp('vaultwarden-rsa', 'made-up pem') };
  const full = backupRow(siteId, new Date(Date.now() - 120000).toISOString(), { chain: { id: 'chain-a' } });
  store.recordScan(siteId, { keys: [{ ...key, inBackup: true }], files: [] }, { backup: { id: full, backupKind: 'full', chainId: 'chain-a' } });
  const increment = backupRow(siteId, new Date(Date.now() - 60000).toISOString(), { chain: { id: 'chain-a' } });
  store.recordScan(siteId, { keys: [{ ...key, inBackup: false, reason: 'not-in-package' }], files: [] }, { backup: { id: increment, backupKind: 'incremental', chainId: 'chain-a' } });
  assert.equal(db.prepare('SELECT in_backup FROM app_keys WHERE site_id=?').get(siteId).in_backup, increment);
  const other = backupRow(siteId, new Date().toISOString(), { chain: { id: 'chain-b' } });
  store.recordScan(siteId, { keys: [{ ...key, inBackup: false, reason: 'not-in-package' }], files: [] }, { backup: { id: other, backupKind: 'incremental', chainId: 'chain-b' } });
  assert.equal(db.prepare('SELECT in_backup FROM app_keys WHERE site_id=?').get(siteId).in_backup, null, 'another chain does not hold it');
  assert.equal(keysView(siteId).state, 'red');
});

test('scans are checked: unknown rules, bad locations and fingerprints are dropped; removed keys and files go', () => {
  const serverId = serverRow('Clean server'), siteId = siteRow(serverId, 'Forum');
  assert.equal(store.recordScan(siteId, null), false); assert.equal(store.recordScan(siteId, { keys: 'x', files: [] }), false);
  store.recordScan(siteId, { keys: [{ rule: 'no-such-rule', location: 'env:web', fingerprint: 'a'.repeat(32) }, { rule: 'n8n-encryption-key', location: 'relative/path', fingerprint: 'a'.repeat(32) }, { rule: 'n8n-encryption-key', location: 'env:web', fingerprint: VALUE }, { rule: 'n8n-encryption-key', location: 'env:web', fingerprint: 'b'.repeat(32), inBackup: 'yes' }], files: [{ path: 'relative', fingerprint: 'c'.repeat(32) }, { path: '/srv/forum/compose.yaml', fingerprint: 'd'.repeat(32) }] });
  assert.deepEqual(db.prepare('SELECT rule_id,location,fingerprint,in_backup FROM app_keys WHERE site_id=?').all(siteId).map(row => ({ ...row })), [{ rule_id: 'n8n-encryption-key', location: 'env:web', fingerprint: 'b'.repeat(32), in_backup: null }]);
  store.recordScan(siteId, { keys: [], files: [] });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM app_keys WHERE site_id=?').get(siteId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM config_fingerprints WHERE site_id=?').get(siteId).n, 0);
});

test('a backup carries the key proof: request with fpKey, manifest proof list, in_backup set; /api/state and logs hold no value', async () => {
  const serverId = serverRow('Backup server'), siteId = siteRow(serverId, 'Ledger', { containers: ['wiki-web-1'], composeFiles: ['/srv/wiki/compose.yaml'], configFiles: ['/srv/wiki/.env'] });
  const requests = [];
  const scan = scanOf({ extra: [{ rule: 'rails-secret-key-base', location: 'file:/srv/wiki/extra.env', fingerprint: fp('rails-secret-key-base', VALUE) }] });
  engine.transport.remote = async (_server, request) => {
    requests.push(request);
    if (request.operation === 'plan') return { fingerprint: 'plan' };
    if (request.operation === 'capture') return { remotePath: '/var/lib/docknest/job/payload.tar.gz', root: '/var/lib/docknest/' + request.job, keys: { keys: scan.keys.map(key => ({ ...key, inBackup: key.location !== 'file:/srv/wiki/extra.env', ...(key.location === 'file:/srv/wiki/extra.env' ? { reason: 'not-included' } : {}) })), files: scan.files }, manifest: { kind: 'docker', complete: true, capturedAt: Date.now() / 1000, downtimeSeconds: 1, originalImages: [], architecture: 'amd64', containers: [], consistency: { status: 'passed' } } };
    if (request.operation === 'list-staging') return { root: '/var/lib/docknest', jobs: [] };
    return {};
  };
  engine.transport.download = async (_server, _path, output) => { output.end(Buffer.from('authenticated fixture payload')); };
  engine.enqueueBackup(siteId, 'test'); const job = engine.claimJob(); await engine.executeJob(job);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status, 'completed');
  const capture = requests.find(request => request.operation === 'capture');
  assert.equal(Buffer.from(capture.keys.fingerprintKey, 'base64').length, 32); assert.equal(capture.keys.rules.length, KEY_RULES.length);
  assert.ok(!JSON.stringify(capture.config).includes(capture.keys.fingerprintKey), 'fpKey stays out of the config the helper journals');
  const backup = db.prepare('SELECT * FROM backups WHERE job_id=?').get(job.id);
  assert.deepEqual([JSON.parse(backup.manifest).keysServerId, JSON.parse(backup.manifest).keysCheck], [serverId, fingerprintKeyCheck(serverId)], 'the proof names the server key that made it');
  assert.equal(capture.keys.fingerprintKey, fingerprintKey(serverId).toString('base64'), 'the backup used its server key');
  assert.deepEqual(JSON.parse(backup.manifest).keys.map(key => [key.location, key.inBackup, key.reason ?? null]), [['env:wiki-web-1', true, null], ['file:/srv/wiki/.env', true, null], ['file:/srv/wiki/extra.env', false, 'not-included']]);
  assert.deepEqual(db.prepare('SELECT location,in_backup FROM app_keys WHERE site_id=? ORDER BY location').all(siteId).map(row => [row.location, row.in_backup]), [['env:wiki-web-1', backup.id], ['file:/srv/wiki/.env', backup.id], ['file:/srv/wiki/extra.env', null]]);
  const admin = user('admin'), state = await admin('GET', '/state');
  assert.equal(state.status, 200);
  const ledger = state.body.sites.find(site => site.id === siteId);
  const listed = state.body.backups.find(item => item.id === backup.id);
  assert.ok(listed.manifest && !['keys', 'keysCheck', 'keysServerId'].some(name => name in listed.manifest), 'the full key proof stays on the server');
  const history = await admin('GET', '/backups?limit=50');
  assert.ok(history.body.items.every(item => !('keys' in (item.manifest ?? {}))));
  assert.equal(ledger.keys.state, 'red'); assert.equal(ledger.keys.keys.length, 3);
  const fpKey = capture.keys.fingerprintKey, fpHex = Buffer.from(fpKey, 'base64').toString('hex');
  for (const [where, text] of [['/api/state', state.text], ['audit_events', JSON.stringify(db.prepare('SELECT * FROM audit_events').all())], ['jobs', JSON.stringify(db.prepare('SELECT * FROM jobs').all())], ['backups', JSON.stringify(db.prepare('SELECT * FROM backups').all())], ['app_keys', JSON.stringify(db.prepare('SELECT * FROM app_keys').all())], ['config_fingerprints', JSON.stringify(db.prepare('SELECT * FROM config_fingerprints').all())], ['alert_outbox', JSON.stringify(db.prepare('SELECT * FROM alert_outbox').all())], ['settings', JSON.stringify(db.prepare('SELECT * FROM settings').all())], ['logs', printed.join('\n')]]) {
    assertNoValue(text, where);
    assert.ok(!text.includes(fpKey) && !text.includes(fpHex), `${where} holds the fingerprint key`);
  }
  assert.deepEqual(ledger.keys.keys.map(key => key.fingerprint), scan.keys.map(key => key.fingerprint.slice(0, 8)), 'the padlock shows 8 characters of a fingerprint');
});

test('a restore never marks known-good: it makes a separate copy, so the live app is not scanned or trusted', async () => {
  const serverId = serverRow('Restore server'), siteId = siteRow(serverId, 'Journal');
  store.recordScan(siteId, scanOf());
  const restored = scanOf({ compose: 'restored compose\n', env: 'APP_KEY=restored\n', value: 'restored' });
  let restoreAnswer = () => ({ verification: { isolatedRestore: { status: 'passed' } } });
  const requests = [];
  engine.transport.remote = async (_server, request) => {
    requests.push(request.operation);
    if (request.operation === 'plan') return { fingerprint: 'plan' };
    if (request.operation === 'capture') return { remotePath: '/var/lib/docknest/job/payload.tar.gz', root: '/var/lib/docknest/' + request.job, manifest: { kind: 'docker', complete: true, capturedAt: Date.now() / 1000, downtimeSeconds: 1, originalImages: [], architecture: 'amd64', containers: [], consistency: { status: 'passed' } } };
    if (request.operation === 'list-staging') return { root: '/var/lib/docknest', jobs: [] };
    if (request.operation === 'prepare-restore') return { remotePath: '/var/lib/docker-backup-manager/restore/' + request.job + '/payload.tar.gz' };
    if (request.operation === 'restore') return restoreAnswer();
    if (request.operation === 'key-scan') return restored;
    return {};
  };
  engine.transport.download = async (_server, _path, output) => { output.end(Buffer.from('authenticated fixture payload')); };
  engine.transport.uploadStream = async (_server, input) => { for await (const _chunk of input); };
  engine.enqueueBackup(siteId, 'test'); await engine.executeJob(engine.claimJob());
  const backup = db.prepare('SELECT * FROM backups WHERE site_id=?').get(siteId);
  const restore = async () => {
    const restoreId = randomUUID(), jobId = randomUUID();
    db.prepare("INSERT INTO restores(id,backup_id,server_id,mode,plan,status,created_at) VALUES(?,?,?,'new-copy',?,'queued',?)").run(restoreId, backup.id, serverId, JSON.stringify({ mappings: {} }), at);
    db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,'restore','queued','queued',?,?)").run(jobId, siteId, at, JSON.stringify({ restoreId, backupId: backup.id, targetServerId: serverId }));
    await engine.executeJob(engine.claimJob());
    return db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId).status;
  };
  restoreAnswer = () => { throw Object.assign(new Error('restore failed'), { remoteReported: true }); };
  assert.equal(await restore(), 'failed');
  restoreAnswer = () => ({ verification: { isolatedRestore: { status: 'passed' } } });
  assert.equal(await restore(), 'completed');
  assert.ok(!requests.includes('key-scan'), 'no scan after a restore');
  assert.ok(Object.values(items(siteId)).every(row => row.known_good_source === 'baseline'), 'a change outside DockNest is never laundered by a restore');
  assert.equal(audits('config.known_good', siteId).length, 0);
});

test('readiness and discovery record the scans they carry and never return them', async () => {
  const serverId = serverRow('Scan server'), siteId = siteRow(serverId, 'Board'), staticSite = siteRow(serverId, 'Static', { kind: 'static', documentRoot: '/var/www/site' });
  const requests = [];
  engine.transport.remote = async (_server, request) => {
    requests.push(request);
    if (request.operation === 'readiness') return { ready: true, checks: [], keyScan: scanOf() };
    if (request.operation === 'discover') return { staticSites: [], containers: [], keyScans: { [siteId]: scanOf({ compose: 'hand edit\n' }), [staticSite]: scanOf() } };
    return {};
  };
  const readiness = await engine.checkReadiness(siteId);
  assert.ok(!('keyScan' in readiness)); assert.equal(Buffer.from(requests[0].keys.fingerprintKey, 'base64').length, 32);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM config_fingerprints WHERE site_id=?').get(siteId).n, 4);
  const found = await engine.discover({ id: serverId }, { scanKeys: true });
  assert.ok(!('keyScans' in found)); assert.deepEqual(requests[1].keys.apps.map(item => item.id), [siteId], 'static apps are not scanned');
  assert.equal(audits('config.changed', siteId).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM config_fingerprints WHERE site_id=?').get(staticSite).n, 0);
  await engine.discover({ id: serverId });
  assert.equal(requests.at(-1).keys, undefined, 'a discovery for other purposes carries no key');
  // An app with work in progress (here a Safe Edit, then a move job) is left out of the discovery scan.
  const editId = randomUUID();
  db.prepare("INSERT INTO site_edits(id,site_id,server_id,state,created_by,created_at) VALUES(?,?,?,'queued','test',?)").run(editId, siteId, serverId, at);
  await engine.discover({ id: serverId }, { scanKeys: true });
  assert.equal(requests.at(-1).keys, undefined, 'the only app is busy, so nothing is scanned');
  assert.equal(engine.keyScanBusy(siteId), true);
  db.prepare("UPDATE site_edits SET result='applied',state='done' WHERE id=?").run(editId);
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'site-move','move_queued','queued',?)").run(randomUUID(), siteId, at);
  assert.equal(engine.keyScanBusy(siteId), true);
});

test('Safe Edit trust: the full written-file list and only the recreated services, never other containers', () => {
  const only = safeEditItems({ written: ['/srv/shop/compose.yaml', '/srv/shop/.env'], recreated: ['web'], project: 'shop' });
  assert.deepEqual(['/srv/shop/compose.yaml', '/srv/shop/.env', '/srv/shop/other.env', 'laravel-app-key@file:/srv/shop/.env', 'laravel-app-key@env:shop-web-1', 'laravel-app-key@env:shop_web_2', 'laravel-app-key@env:shop-worker-1', 'laravel-app-key@env:other-web-1'].map(only), [true, true, false, true, true, true, false, false]);
  assert.equal(safeEditItems(undefined)('/srv/shop/compose.yaml'), false, 'without the record nothing is trusted');
  assert.equal(safeEditItems({ written: [], recreated: ['shop-app'], project: null })('laravel-app-key@env:shop-app'), true, 'a single container is its own service');
});

test('Mark as known-good: busy apps, static websites and a race are refused without a mark', async () => {
  const serverId = serverRow('Busy server'), siteId = siteRow(serverId, 'Busy'), staticSite = siteRow(serverId, 'Plain', { kind: 'static', documentRoot: '/var/www/plain' });
  store.recordScan(siteId, scanOf());
  const admin = user('admin');
  engine.transport.remote = async (_server, request) => {
    // A restore test starts while the scan runs: the recorded scan sees it and marks nothing.
    if (request.operation === 'key-scan') db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'restore-test','test_queued','check_space',?)").run(randomUUID(), siteId, at);
    return scanOf({ compose: 'raced\n' });
  };
  const raced = await admin('POST', `/sites/${siteId}/keys/known-good`);
  assert.deepEqual([raced.status, raced.body.code], [409, 'SITE_BUSY']);
  assert.ok(Object.values(items(siteId)).every(row => row.known_good_source === 'baseline'));
  const busy = await admin('POST', `/sites/${siteId}/keys/known-good`);
  assert.deepEqual([busy.status, busy.body.code], [409, 'SITE_BUSY'], 'the restore test still runs');
  const plain = await admin('POST', `/sites/${staticSite}/keys/known-good`);
  assert.deepEqual([plain.status, plain.body.code], [409, 'NOT_APPLICABLE']);
});
