// The launch screens (web/map/LaunchFlow.jsx, web/connections/DeployKeys.jsx) against the real launch API and engine with
// the fake helper of tests/launch-engine.test.js: the request bodies the screens build are accepted, and the answers hold
// every field the screens read. Real launches are covered only by the Linux integration test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-launch-ui-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const engine = await import('../src/launches/engine.js');
const keys = await import('../src/launches/deploy-keys.js');
const { claimLaunch } = await import('../src/launches/claim.js');
const ui = await import('../web/map/launch-client.js');
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
test.after(() => listener.close());
test.beforeEach(() => db.exec('DELETE FROM rate_limits'));
const at = () => new Date().toISOString();

const userId = randomUUID(), token = randomBytes(32).toString('base64url');
db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId, userId + '@example.invalid', 'fixture', 'fixture', '[]', at(), 'admin', 'admin');
db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), userId, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), Date.now());
const api = async (method, route, body) => {
  const response = await fetch(base + route, { method, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, 'x-csrf-token': 'csrf', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const serverRow = name => { const id = randomUUID(); db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, name, '198.51.100.20', 22, 'root', 'k', '0'.repeat(64), at()); return id; };
const server = serverRow('Commerce host'), spare = serverRow('Content host');

const facts = (extra = {}) => ({ tools: { docker: true, compose: true, git: true, nginx: true, certbot: true, buildx: true }, freeBytes: 50e9, ports: { 80: true, 443: true }, nginxDomains: [], certLineages: [], dnsAnswers: { A: ['8.8.8.8'], AAAA: [] }, serverIps: ['8.8.8.8'], usedPorts: [22, 80, 443], checks: [{ id: 'docker', ok: true }], services: [{ name: 'web', ports: [80], build: false }, { name: 'db', ports: [], build: false }], ...extra });
let script = {};
engine.launchTransport.remote = async (_server, request) => {
  const answer = script[request.operation];
  if (typeof answer === 'function') return answer(request);
  if (answer !== undefined) return structuredClone(answer);
  switch (request.operation) {
    case 'launch-facts': return facts();
    case 'launch-fetch': return { ok: true, commit: null, services: [{ name: 'web', ports: [80], build: false }], composeName: null, gate: { ok: true, refusals: [] } };
    case 'launch-build': return { ok: true, images: [] };
    case 'launch-start': return { ok: true, containers: ['c1'], containerNames: [`${request.slug}-web-1`], composeFiles: [] };
    case 'launch-poll': return { ok: true, state: 'passed', httpStatus: 200 };
    case 'launch-web': return { ok: true, file: `/etc/nginx/conf.d/docknest-${request.slug}.conf` };
    case 'launch-certificate': return { ok: true, state: 'issued', certName: `docknest-${request.slug}`, maintenanceReset: false };
    default: throw new Error('unexpected ' + request.operation);
  }
};
engine.launchMaintenance.setup = async () => ({ files: ['nginx'] });

const form = (extra = {}) => ({ tab: 'compose', compose: 'services:\n  web:\n    image: nginx:1.27\n  db:\n    image: mariadb:11\n', env: [{ key: 'DB_PASSWORD', value: 'x' }], service: '', domain: 'Shop2.Example.com', repo: '', ref: 'main', composePath: 'compose.yaml', keyId: '', allowPrivate: false, shutdown: true, ...extra });

test('the check answer holds what the check sheet reads', async () => {
  const body = ui.bodyOf(form());
  const { status, body: result } = await api('POST', `/servers/${server}/launch/check`, body);
  assert.equal(status, 200);
  for (const key of ['ok', 'blockers', 'warnings', 'builds', 'checks', 'services', 'gate', 'dns', 'testServers']) assert.ok(key in result, key);
  assert.ok(Array.isArray(result.dns.records) && 'pointsHere' in result.dns);
  const rows = ui.checkRows(result);
  assert.ok(rows.length >= 2 && rows.every(row => row.title && ['success', 'failed', 'needs-review'].includes(row.state)));
  assert.deepEqual(result.services.map(x => x.name), ['web', 'db']);
  assert.deepEqual(result.testServers.map(x => x.id), [spare]);
});

test('a refusal gives blockers and install offers in the shape the sheet reads', async () => {
  script['launch-facts'] = facts({ tools: { docker: true, compose: true, git: true, nginx: false, certbot: true, buildx: true }, checks: [{ id: 'nginx', ok: false, code: 'NGINX_MISSING', install: 'nginx' }] });
  const { body: result } = await api('POST', `/servers/${server}/launch/check`, ui.bodyOf(form()));
  script = {};
  assert.equal(result.ok, false);
  assert.ok(ui.blockersOf(result).length > 0);
  const offer = result.checks.find(item => item.install);
  if (offer) assert.equal(offer.install.package, 'nginx');
  if (offer) assert.ok('supported' in offer.install);
});

test('the launch body is accepted, needs the confirmations and the port, and the view holds what the timeline reads', async () => {
  const start = ui.startBody(form(), { service: 'web', port: 80, testServerId: spare, trust: false });
  const missing = { ...start }; delete missing.cleanShutdownConfirmed;
  assert.equal((await api('POST', `/servers/${server}/launch`, missing)).body.code, 'SHUTDOWN_CONFIRM_REQUIRED');
  const noPort = { ...start }; delete noPort.webPort;
  assert.equal((await api('POST', `/servers/${server}/launch`, { ...noPort, webPort: undefined })).body.code, 'INVALID_PORT');
  const started = await api('POST', `/servers/${server}/launch`, start);
  assert.equal(started.status, 202);
  const id = started.body.launch.id;
  const view = (await api('GET', `/launches/${id}`)).body;
  for (const key of ['state', 'domain', 'steps', 'progress', 'statusLine', 'dns', 'certificate', 'backups', 'restoreTests', 'actions', 'removing', 'reason']) assert.ok(key in view, key);
  assert.ok(['check', 'fetch', 'build', 'start', 'check_health', 'web', 'certificate', 'save', 'maintenance', 'first_backup'].every(step => view.steps.some(x => x.step === step && ui.STEP_LABEL[step])), 'every step has a label');
  const drive = async () => { for (let index = 0; index < 60; index++) { engine.tickLaunches(); const claimed = claimLaunch(); if (!claimed) return; await engine.executeLaunchStep(claimed); } };
  await drive();
  // The first backup is a normal backup job: play the worker finishing it.
  const siteId = (await api('GET', `/launches/${id}`)).body.siteId;
  for (const job of db.prepare("SELECT id FROM jobs WHERE site_id=? AND type='backup' AND status='queued'").all(siteId)) {
    db.prepare('UPDATE jobs SET status=?,stage=?,finished_at=? WHERE id=?').run('completed', 'completed', at(), job.id);
    db.prepare("INSERT INTO backups(id,site_id,job_id,captured_at,path,size,checksum,manifest,verified,created_at) VALUES(?,?,?,?,'x.enc',1,?,'{}',1,?)").run(randomUUID(), siteId, job.id, at(), 'a'.repeat(64), at());
  }
  await drive();
  const done = (await api('GET', `/launches/${id}`)).body;
  assert.ok(['done', 'waiting_dns'].includes(done.state), done.state + ' ' + done.reason);
  assert.ok(ui.settled(done) || done.actions.checkDns);
  assert.ok(done.removeUntil && done.actions.remove);
  assert.ok('enabled' in done.restoreTests && done.certificate.state);
  const state = (await api('GET', '/state')).body;
  const site = state.sites.find(x => x.id === done.siteId);
  assert.ok(site?.launch?.id === id && site.launch.removeUntil && site.launch.launchedAt, 'the site carries launch {id, launchedAt, removeUntil}');
  const list = (await api('GET', `/servers/${server}/launch`)).body.launches;
  assert.ok(Array.isArray(list) && list.every(x => ui.stateText(x)));
});

test('the Git body is accepted: repo object, https takes no key, trust is confirmed', async () => {
  const git = form({ tab: 'git', repo: 'https://git.example.com/shop/demo.git', ref: 'v1.0', composePath: 'deploy/compose.yaml', domain: 'git-shop.example.com' });
  const check = await api('POST', `/servers/${server}/launch/check`, ui.bodyOf(git));
  assert.equal(check.status, 200);
  const body = ui.startBody(git, { service: 'web', port: 80, trust: true });
  assert.equal(body.trustConfirmed, true);
  assert.equal(body.repo.url, 'https://git.example.com/shop/demo.git');
  const without = { ...body }; delete without.trustConfirmed;
  assert.equal((await api('POST', `/servers/${server}/launch`, without)).body.code, 'TRUST_REQUIRED');
});

const hostBlob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), randomBytes(32)]);
const fingerprint = 'SHA256:' + createHash('sha256').update(hostBlob).digest('base64').replace(/=+$/, '');
keys.deployKeyTransport.remote = async (_server, request) => ({ hostKeyLine: `${request.gitHost} ssh-ed25519 ${hostBlob.toString('base64')}`, sha256: fingerprint });

test('deploy keys: host key preview, create with the confirmed fingerprint, host key of a key, repin', async () => {
  const preview = await api('POST', '/deploy-keys/host-key', { gitHost: 'github.com', serverId: server });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.fingerprint, fingerprint);
  const mismatch = await api('POST', '/deploy-keys', { name: 'Shop', gitHost: 'github.com', serverId: server, fingerprint: 'SHA256:' + 'A'.repeat(43) });
  assert.equal(mismatch.body.code, 'HOST_KEY_CHANGED');
  assert.equal(mismatch.body.hostKey.fingerprint, fingerprint);
  const created = await api('POST', '/deploy-keys', { name: 'Shop', gitHost: 'github.com', serverId: server, fingerprint });
  assert.equal(created.status, 201);
  const key = created.body.key;
  for (const field of ['id', 'name', 'gitHost', 'publicKey', 'hostKey', 'pinnedFromServerId', 'pinnedFromServerName', 'createdAt']) assert.ok(field in key, field);
  assert.equal(key.hostKey.sha256, fingerprint);
  const list = (await api('GET', '/deploy-keys')).body.keys;
  assert.ok(list.some(x => x.id === key.id && x.publicKey));
  const read = (await api('POST', `/deploy-keys/${key.id}/host-key`, { serverId: spare })).body;
  assert.equal(read.fingerprint, fingerprint);
  assert.equal(read.changed, false);
  assert.equal(read.previous.fingerprint, fingerprint);
  assert.ok('serverName' in read.previous && 'serverId' in read.previous);
  const moved = await api('POST', `/deploy-keys/${key.id}/repin`, { serverId: spare, fingerprint });
  assert.equal(moved.status, 200);
  assert.ok(moved.body.replacedPin?.text, 'moving the pin names the server that needs to confirm again');
  assert.equal((await api('DELETE', `/deploy-keys/${key.id}`)).status, 200);
});
