// Deploy keys (docs/launch-site.md, "Deploy key" and "Security review changes" items 10 and 17): admin only, CSRF,
// re-verification, the host key confirmed by SHA-256 before anything is stored, the private key sealed and never in an
// answer, a log line or an audit row, re-pin, and the key refused from another server until its host key is confirmed
// from there. The helper is a fake; real Git hosts are covered only by the Linux integration test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const directory = await mkdtemp(join(tmpdir(), 'docknest-deploy-keys-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { digest, open } = await import('../src/crypto.js');
const keys = await import('../src/launches/deploy-keys.js');
const ssh2 = createRequire(import.meta.url)('ssh2');
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
test.after(() => listener.close());
test.beforeEach(() => db.exec('DELETE FROM rate_limits'));
const at = () => new Date().toISOString();

function user(role, authenticatedAt = Date.now(), csrf = 'csrf') {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId, userId + '@example.invalid', 'fixture', 'fixture', '[]', at(), role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), userId, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), authenticatedAt);
  return (route, options = {}) => fetch(base + route, { ...options, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, ...(csrf ? { 'x-csrf-token': csrf } : {}), 'Content-Type': 'application/json' } });
}
const admin = user('admin'), staleAdmin = user('admin', Date.now() - 6 * 60_000), operator = user('operator'), noCsrf = user('admin', Date.now(), null);
const send = (as, method, route, body) => as(route, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
function serverRow(name) {
  const serverId = randomUUID();
  db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(serverId, name, '198.51.100.' + Math.floor(Math.random() * 200 + 1), 22, 'root', 'fixture', '0'.repeat(64), at());
  return serverId;
}
const web = serverRow('web-1'), other = serverRow('web-2');

// A Git host key and the fake helper that returns it.
const hostBlob = key => Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), key]);
let hostKey = randomBytes(32), helperAnswer = null;
const fp = blob => 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
const calls = [];
keys.deployKeyTransport.remote = async (server, request) => {
  calls.push({ server: server.name, request: structuredClone(request) });
  if (request.operation !== 'launch-host-key') throw new Error('unexpected ' + request.operation);
  if (helperAnswer) return helperAnswer;
  const name = request.gitHost.includes(':') ? `[${request.gitHost.split(':')[0]}]:${request.gitHost.split(':')[1]}` : request.gitHost;
  return { hostKeyLine: `${name} ssh-ed25519 ${hostBlob(hostKey).toString('base64')}`, sha256: fp(hostBlob(hostKey)) };
};
const logged = [];
for (const method of ['log', 'warn', 'error']) { const original = console[method]; console[method] = (...args) => { logged.push(args.join(' ')); return original.apply(console, args); }; }

test('the generated pair is a valid OpenSSH ed25519 key whose public half and fingerprint match', () => {
  const pair = keys.generateDeployKey('docknest-test');
  const parsed = ssh2.utils.parseKey(pair.privateKey);
  assert.equal(parsed.type, 'ssh-ed25519');
  assert.equal(parsed.getPublicSSH().toString('base64'), pair.publicKey.split(' ')[1]);
  assert.equal(pair.fingerprint, fp(parsed.getPublicSSH()));
  assert.ok(ssh2.utils.parseKey(pair.publicKey).verify(Buffer.from('data'), parsed.sign(Buffer.from('data'))));
  assert.match(pair.privateKey, /^-{5}BEGIN OPENSSH PRIVATE KEY-{5}\n/);
});

test('only administrators with CSRF and a re-verification within 5 minutes may create, pin or delete keys', async () => {
  const body = { name: 'Shop repo', gitHost: 'github.com', serverId: web };
  assert.equal((await send(operator, 'GET', '/deploy-keys')).status, 403, 'operators never see deploy keys');
  assert.equal((await send(operator, 'POST', '/deploy-keys', body)).status, 403);
  assert.equal((await send(noCsrf, 'POST', '/deploy-keys', body)).status, 403);
  const stale = await send(staleAdmin, 'POST', '/deploy-keys', body);
  assert.equal(stale.status, 403); assert.equal((await stale.json()).code, 'REAUTH_REQUIRED');
  assert.equal(calls.length, 0, 'no server was contacted');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deploy_keys').get().n, 0);
});

test('create: the host key fingerprint is shown first, stored only after it is confirmed, and the private key never leaves', async () => {
  const body = { name: 'Shop repo', gitHost: 'github.com', serverId: web };
  const first = await send(admin, 'POST', '/deploy-keys', body);
  assert.equal(first.status, 409);
  const ask = await first.json();
  assert.equal(ask.code, 'HOST_KEY_CONFIRM'); assert.equal(ask.hostKey.sha256, fp(hostBlob(hostKey))); assert.equal(ask.hostKey.type, 'ssh-ed25519');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deploy_keys').get().n, 0, 'nothing stored before the confirmation');
  const wrong = await send(admin, 'POST', '/deploy-keys', { ...body, hostKeySha256: fp(hostBlob(randomBytes(32))) });
  assert.equal(wrong.status, 409); assert.equal((await wrong.json()).code, 'HOST_KEY_CHANGED');
  const created = await send(admin, 'POST', '/deploy-keys', { ...body, hostKeySha256: ask.hostKey.sha256.replace('SHA256:', '') });
  assert.equal(created.status, 201);
  const { key } = await created.json();
  assert.match(key.publicKey, /^ssh-ed25519 [A-Za-z0-9+/]+=* docknest-[0-9a-f]{8}$/);
  assert.equal(key.gitHost, 'github.com'); assert.equal(key.pinnedFromServerId, web); assert.equal(key.pinnedFromServerName, 'web-1');
  assert.equal(key.hostKey.sha256, ask.hostKey.sha256);
  const row = db.prepare('SELECT * FROM deploy_keys WHERE id=?').get(key.id);
  assert.doesNotMatch(row.sealed_private_key, /PRIVATE KEY/, 'stored sealed');
  const privateKey = open(row.sealed_private_key);
  assert.equal(ssh2.utils.parseKey(privateKey).getPublicSSH().toString('base64'), key.publicKey.split(' ')[1]);
  const secretBody = privateKey.split('\n')[1];
  const everything = JSON.stringify([await (await send(admin, 'GET', '/deploy-keys')).json(), await (await send(admin, 'GET', `/deploy-keys/${key.id}`)).json(), db.prepare('SELECT * FROM audit_events').all(), logged, calls]);
  assert.ok(!everything.includes(secretBody) && !everything.includes('PRIVATE KEY'), 'no answer, audit row, log line or helper request holds the private key');
  assert.equal(row.host_key_line, `github.com ssh-ed25519 ${hostBlob(hostKey).toString('base64')}`);
  assert.deepEqual(calls.at(-1).request, { operation: 'launch-host-key', gitHost: 'github.com', allowPrivate: false });
});

test('host rules: options, private addresses, ports and odd helper answers are refused', async () => {
  const before = calls.length;
  for (const gitHost of ['-oProxyCommand=x', 'git@github.com', 'github.com/owner', 'localhost', '127.0.0.1', '169.254.169.254', 'host:0', 'host:70000', 'a b', '*.example.com']) {
    const answer = await send(admin, 'POST', '/deploy-keys', { name: 'x', gitHost, serverId: web });
    assert.equal(answer.status, 400, gitHost);
  }
  assert.equal(calls.length, before, 'refused before any server is contacted');
  const lan = await send(admin, 'POST', '/deploy-keys', { name: 'x', gitHost: '192.168.1.20:2222', serverId: web });
  assert.equal((await lan.json()).code, 'PRIVATE_ADDRESS');
  const allowed = await send(admin, 'POST', '/deploy-keys', { name: 'x', gitHost: '192.168.1.20:2222', serverId: web, allowPrivate: true });
  assert.equal((await allowed.json()).code, 'HOST_KEY_CONFIRM', 'a LAN Git server works with Allow private address');
  assert.deepEqual(calls.at(-1).request, { operation: 'launch-host-key', gitHost: '192.168.1.20:2222', allowPrivate: true });
  for (const [answer, code] of [[{ ok: false, code: 'PRIVATE_ADDRESS', reason: 'x' }, 'PRIVATE_ADDRESS'], [{ hostKeyLine: 'github.com ssh-dss AAAA' }, 'HOST_KEY_UNAVAILABLE'], [{ hostKeyLine: `evil.example ssh-ed25519 ${hostBlob(hostKey).toString('base64')}` }, 'HOST_KEY_UNAVAILABLE'], [{ hostKeyLine: `github.com ssh-ed25519 ${hostBlob(hostKey).toString('base64')}`, sha256: fp(hostBlob(randomBytes(32))) }, 'HOST_KEY_UNAVAILABLE'], [{ ok: false, code: 'bad code; rm', reason: 'x' }, 'HOST_KEY_UNAVAILABLE']]) {
    helperAnswer = answer;
    const response = await send(admin, 'POST', '/deploy-keys', { name: 'x', gitHost: 'github.com', serverId: web });
    assert.equal(response.status, 409); assert.equal((await response.json()).code, code, JSON.stringify(answer));
  }
  helperAnswer = null;
});

test('re-pin after a host key rotation, and a key confirmed on one server is refused on another until confirmed there', async () => {
  const [key] = (await (await send(admin, 'GET', '/deploy-keys')).json()).keys;
  assert.ok(keys.deployKeyForLaunch(key.id, web).privateKey.includes('OPENSSH PRIVATE KEY'));
  assert.throws(() => keys.deployKeyForLaunch(key.id, other), error => error.code === 'HOST_KEY_REPIN_REQUIRED' && !error.message.includes('PRIVATE'));
  hostKey = randomBytes(32); // the Git host rotated its key
  const ask = await (await send(admin, 'POST', `/deploy-keys/${key.id}/pin`, { serverId: other })).json();
  assert.equal(ask.code, 'HOST_KEY_CONFIRM'); assert.equal(ask.hostKey.sha256, fp(hostBlob(hostKey)));
  const pinned = await send(admin, 'POST', `/deploy-keys/${key.id}/pin`, { serverId: other, hostKeySha256: ask.hostKey.sha256 });
  assert.equal(pinned.status, 200);
  const pinBody = await pinned.json(), view = pinBody.key;
  assert.deepEqual({ ...pinBody.replacedPin, text: undefined }, { serverId: web, serverName: 'web-1', text: undefined }, 'the answer says the old server now needs a re-pin');
  assert.match(pinBody.replacedPin.text, /web-1/);
  assert.equal(view.pinnedFromServerId, other); assert.equal(view.hostKey.sha256, ask.hostKey.sha256); assert.equal(view.publicKey, key.publicKey, 'the deploy key itself is unchanged');
  assert.equal(keys.deployKeyForLaunch(key.id, other).hostKeyLine, `github.com ssh-ed25519 ${hostBlob(hostKey).toString('base64')}`);
  assert.equal((await send(staleAdmin, 'POST', `/deploy-keys/${key.id}/pin`, { serverId: web })).status, 403);
});

test('delete is refused while a launch uses the key and leaves launch history otherwise', async () => {
  const [key] = (await (await send(admin, 'GET', '/deploy-keys')).json()).keys;
  db.prepare("INSERT INTO site_launches(id,server_id,slug,source,repo_url,deploy_key_id,domain,state,created_by,created_at,updated_at) VALUES('L1',?,'shop','git','git@github.com:o/r.git',?,'shop.example.com','running','admin',?,?)").run(other, key.id, at(), at());
  const refused = await send(admin, 'DELETE', `/deploy-keys/${key.id}`);
  assert.equal(refused.status, 409); assert.equal((await refused.json()).code, 'KEY_IN_USE');
  assert.equal((await send(staleAdmin, 'DELETE', `/deploy-keys/${key.id}`)).status, 403);
  db.prepare("UPDATE site_launches SET state='done' WHERE id='L1'").run();
  assert.equal((await send(admin, 'DELETE', `/deploy-keys/${key.id}`)).status, 200);
  assert.equal(db.prepare("SELECT deploy_key_id FROM site_launches WHERE id='L1'").get().deploy_key_id, null);
  assert.equal((await send(admin, 'GET', `/deploy-keys/${key.id}`)).status, 404);
  assert.throws(() => keys.deployKeyForLaunch(key.id, other), error => error.code === 'DEPLOY_KEY_MISSING');
  const actions = db.prepare("SELECT action,detail FROM audit_events WHERE action LIKE 'deploy_key.%' ORDER BY created_at").all().map(row => row.action);
  assert.deepEqual(actions, ['deploy_key.created', 'deploy_key.pinned', 'deploy_key.deleted']);
});
