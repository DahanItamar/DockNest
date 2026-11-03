// Launch engine and API (docs/launch-site.md): status codes, input rules, the step machine against a fake helper (real
// launches are covered only by the Linux integration test), teardown on failure, needs_attention with its alert, waiting
// DNS with Check again, certificate failure on HTTP, worker restart, save with day-one backups and restore tests, the
// first backup after the hold, Remove launch, cancel, and no secret in any answer, audit row, log line or stored row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-launch-engine-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { digest, seal } = await import('../src/crypto.js');
const engine = await import('../src/launches/engine.js');
const { claimLaunch, interruptLaunchSteps } = await import('../src/launches/claim.js');
const { generateDeployKey } = await import('../src/launches/deploy-keys.js');
const { launchHeld } = await import('../src/launches/hold.js');
const { claimJob } = await import('../src/engine.js');
const { detectJobsAndMoves } = await import('../src/alerts/detect.js');
const { messageFor, templateFor, EVENTS } = await import('../src/alerts/events.js');
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
test.after(() => listener.close());
test.beforeEach(() => db.exec('DELETE FROM rate_limits'));
const at = () => new Date().toISOString();

function user(role, authenticatedAt = Date.now()) {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId, userId + '@example.invalid', 'fixture', 'fixture', '[]', at(), role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), userId, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), authenticatedAt);
  return async (method, route, body) => { const response = await fetch(base + route, { method, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, 'x-csrf-token': 'csrf', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json().catch(() => null) }; };
}
const admin = user('admin'), stale = user('admin', Date.now() - 6 * 60_000), operator = user('operator');
const serverRow = name => { const serverId = randomUUID(); db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(serverId, name, '198.51.100.20', 22, 'root', 'k', '0'.repeat(64), at()); return serverId; };

// ---------- the fake helper ----------
const SECRET = 'S3cr3t-Value-' + randomBytes(6).toString('hex');
const COMPOSE = `services:\n  web:\n    image: nginx:1.27\n    environment:\n      DB_PASSWORD: \${DB_PASSWORD}\n  db:\n    image: mariadb:11\n`;
let calls = [], script = {};
const facts = (extra = {}) => ({ tools: { docker: true, compose: true, git: true, nginx: true, certbot: true, buildx: true }, freeBytes: 50e9, ports: { 80: true, 443: true }, nginxDomains: [], certLineages: [], dnsAnswers: { A: ['8.8.8.8'], AAAA: [] }, serverIps: ['8.8.8.8', '10.0.0.5', ['100', '64', '1', '2'].join('.'), '2a01:4f9:c010::20'], usedPorts: [22, 80, 443], checks: [{ id: 'docker', ok: true }], services: [{ name: 'web', ports: [80], build: false }, { name: 'db', ports: [], build: false }], ...extra });
engine.launchTransport.remote = async (server, request) => {
  calls.push({ server: server.name, request: structuredClone(request) });
  const answer = script[request.operation];
  if (typeof answer === 'function') return answer(request);
  if (answer !== undefined) return structuredClone(answer);
  switch (request.operation) {
    case 'launch-facts': return facts();
    case 'launch-fetch': return { ok: true, commit: null, services: [{ name: 'web', ports: [80], build: false }, { name: 'db', ports: [], build: false }], composeName: null, gate: { ok: true, refusals: [] } };
    case 'launch-build': return { ok: true, images: ['shop-web'] };
    case 'launch-start': return { ok: true, containers: ['c1', 'c2'], containerNames: [`${request.slug}-web-1`, `${request.slug}-db-1`], composeFiles: [`/srv/docknest/${request.slug}/app/compose.yaml`, `/srv/docknest/${request.slug}/compose.docknest.yaml`] };
    case 'launch-poll': return { ok: true, state: 'passed', httpStatus: 200 };
    case 'launch-web': return { ok: true, file: `/etc/nginx/conf.d/docknest-${request.slug}.conf` };
    case 'launch-certificate': return { ok: true, state: 'issued', certName: `docknest-${request.slug}`, maintenanceReset: !!request.maintenanceDirectory };
    case 'launch-teardown': return { ok: true, removed: ['folder', 'containers'], left: [], keepBackup: true };
    case 'launch-status': return { ok: true, journal: true, phase: 'started', commit: null, counts: {}, present: [], busy: false, killed: 0, resumable: ['check_health', 'web', 'certificate'] };
    default: throw new Error('unexpected ' + request.operation);
  }
};
// The maintenance page setup (src/engine.js setupMaintenance, 2.13) is played here; its own tests cover the real path.
let maintenanceCalls = [], maintenanceFault = null;
engine.launchMaintenance.setup = async (siteId, actor) => { maintenanceCalls.push({ siteId, actor }); if (maintenanceFault) throw new Error(maintenanceFault); return { files: ['nginx'] }; };
const logged = [];
for (const method of ['log', 'warn', 'error']) { const original = console[method]; console[method] = (...args) => { logged.push(args.join(' ')); return original.apply(console, args); }; }
// Drives the worker: tick, claim one step, run it, until nothing is left to claim.
async function drive(limit = 40) {
  for (let index = 0; index < limit; index++) {
    engine.tickLaunches();
    const claimed = claimLaunch();
    if (!claimed) return;
    await engine.executeLaunchStep(claimed);
  }
}
// The first backup is a normal backup job: the test plays the worker finishing it.
function finishBackups(siteId, ok = true) {
  for (const job of db.prepare("SELECT id FROM jobs WHERE site_id=? AND type='backup' AND status='queued'").all(siteId)) {
    db.prepare('UPDATE jobs SET status=?,stage=?,finished_at=? WHERE id=?').run(ok ? 'completed' : 'failed', ok ? 'completed' : 'failed', at(), job.id);
    if (ok) db.prepare("INSERT INTO backups(id,site_id,job_id,captured_at,path,size,checksum,manifest,verified,created_at) VALUES(?,?,?,?,'x.enc',1,?,'{}',1,?)").run(randomUUID(), siteId, job.id, at(), 'a'.repeat(64), at());
  }
}
// The configuration rules of the helper's backup preflight (remote/helper/backup.py preflight() and backup_plan()) that a
// saved launch must pass before its first backup; the container and mount checks need Docker and run in the Linux suite.
function backupPreflightProblems(config) {
  const problems = [];
  if (!['staged', 'direct'].includes(config.deliveryMode ?? 'staged')) problems.push('delivery mode');
  if (config.unresolvedDependencies?.length) problems.push('unresolved dependencies');
  if (!config.containers?.length || !config.containers.every(name => typeof name === 'string' && name && !name.startsWith('-'))) problems.push('containers');
  if (!config.exclusiveSourcesConfirmed) problems.push('exclusive sources');
  if (!['generic', 'postgres', 'mysql'].includes(config.shutdownProfile ?? 'generic')) problems.push('shutdown profile');
  if (!config.cleanShutdownConfirmed) problems.push('clean shutdown'); // generic services always need it (backup_plan)
  if (!config.composeFiles?.length) problems.push('compose files'); // the containers carry a Compose project label
  if (!config.externalReferencesConfirmed) problems.push('external references');
  if (!config.maintenance?.required || !config.maintenance?.directory?.startsWith('/')) problems.push('maintenance');
  return problems;
}
const steps = launchId => Object.fromEntries(db.prepare('SELECT step,state,detail FROM site_launch_steps WHERE launch_id=?').all(launchId).map(row => [row.step, row.state]));
const pasted = (domain, extra = {}) => ({ source: 'compose', domain, compose: COMPOSE, webService: 'web', webPort: 80, env: { DB_PASSWORD: SECRET }, cleanShutdownConfirmed: true, ...extra });
const forCheck = ({ cleanShutdownConfirmed, ...rest }) => rest;

test('check answers the facts in the move shape and runs nothing that changes the server', async () => {
  const server = serverRow('check-srv'); calls = []; script = {};
  const answer = await admin('POST', `/servers/${server}/launch/check`, forCheck(pasted('Shop.Example.com')));
  assert.equal(answer.status, 200);
  assert.equal(answer.body.ok, true); assert.equal(answer.body.domain, 'shop.example.com'); assert.equal(answer.body.slug, 'shop-example-com'); assert.equal(answer.body.folder, '/srv/docknest/shop-example-com');
  assert.deepEqual(answer.body.services.map(service => service.name), ['web', 'db']);
  assert.deepEqual(answer.body.dns.records, [{ type: 'A', name: 'shop.example.com', value: '8.8.8.8' }, { type: 'AAAA', name: 'shop.example.com', value: '2a01:4f9:c010::20' }], 'private and CGNAT addresses are left out');
  assert.deepEqual(calls.map(call => call.request.operation), ['launch-facts']);
  script = { 'launch-facts': facts({ os: { id: 'ubuntu', versionId: '24.04' }, packageManager: 'apt', tools: { git: false }, checks: [{ id: 'git', ok: false, code: 'GIT_MISSING', reason: 'The server needs git. Install it, then try again.', install: 'git' }, { id: 'nginxDomain', ok: false, code: 'NGINX_DOMAIN_SERVED', reason: 'nginx on this server already serves this domain.' }] }) };
  const blocked = await admin('POST', `/servers/${server}/launch/check`, { source: 'git', domain: 'app.example.com', repo: { url: 'https://github.com/owner/app.git', ref: 'main', composePath: 'deploy/compose.yaml' }, webService: 'web', webPort: 3000 });
  assert.equal(blocked.body.ok, false);
  assert.deepEqual(blocked.body.checks.find(item => item.id === 'git').install, { package: 'git', command: 'sudo apt-get update && sudo apt-get install -y --no-install-recommends git', supported: true }, 'blocking tools carry the move-shaped install offer (git now too)');
  assert.match(blocked.body.checks.find(item => item.id === 'nginxDomain').text, /already serves app\.example\.com/);
  assert.deepEqual(calls.at(-1).request.repo, { url: 'https://github.com/owner/app.git', ref: 'main', composePath: 'deploy/compose.yaml', allowPrivate: false });
  assert.equal((await operator('POST', `/servers/${server}/launch/check`, pasted('a.example.com'))).status, 403);
});

test('input rules: domains (punycode, no wildcard, no www), URLs, refs, paths and environment keys', async () => {
  const server = serverRow('rules-srv'); script = {};
  const check = body => { db.exec('DELETE FROM rate_limits'); return admin('POST', `/servers/${server}/launch/check`, forCheck(body)); };
  const idn = await check(pasted('bücher.example'));
  assert.equal(idn.body.domain, 'xn--bcher-kva.example', 'IDN becomes punycode');
  for (const domain of ['*.example.com', 'www.example.com', 'https://shop.example.com', 'shop.example.com/path', '127.0.0.1', 'localhost', '-bad.example.com', 'a'.repeat(64) + '.com', 'shop_example.com']) {
    const answer = await check(pasted(domain)); assert.equal(answer.status, 400, domain); assert.equal(answer.body.code, 'INVALID_DOMAIN', domain);
  }
  const repo = url => check({ source: 'git', domain: 'g.example.com', repo: { url, ref: 'main' } });
  for (const url of ['file:///etc/passwd', 'ext::sh -c id', '-uhttps://x', 'https://user:pw@github.com/o/r.git', 'http://github.com/o/r.git', 'https://github.com/o/../r.git', 'https://github.com/o/r.git?x=1', 'git@github.com:-o/r.git', 'https://127.0.0.1/o/r.git', 'https://169.254.169.254/o/r.git', 'https://[::1]/o/r.git', 'https://[::ffff:10.0.0.1]/o/r.git', 'ssh://root:pw@host/o/r.git']) {
    const answer = await repo(url); assert.equal(answer.status, 400, url); assert.ok(['INVALID_REPOSITORY', 'PRIVATE_ADDRESS'].includes(answer.body.code), url);
  }
  assert.equal((await check({ source: 'git', domain: 'g.example.com', repo: { url: 'https://192.168.1.5/o/r.git', ref: 'main' } })).body.code, 'PRIVATE_ADDRESS');
  assert.equal((await check({ source: 'git', domain: 'g.example.com', allowPrivate: true, repo: { url: 'https://192.168.1.5:3000/o/r.git', ref: 'v1.4.2' } })).status, 200, 'a LAN Gitea with Allow private address, a tag, a real port');
  for (const ref of ['-x', '../main', 'main..x', 'a/.b', 'main.lock', 'a b']) assert.equal((await check({ source: 'git', domain: 'g.example.com', repo: { url: 'https://github.com/o/r.git', ref } })).body.code, 'INVALID_REF', ref);
  for (const composePath of ['/etc/compose.yaml', '../compose.yaml', 'compose.txt', 'a//compose.yaml', '-f.yaml']) assert.equal((await check({ source: 'git', domain: 'g.example.com', repo: { url: 'https://github.com/o/r.git', ref: 'main', composePath } })).body.code, 'INVALID_COMPOSE_PATH', composePath);
  assert.equal((await check({ source: 'git', domain: 'g.example.com', repo: { url: 'git@github.com:o/r.git', ref: 'main' } })).body.code, 'DEPLOY_KEY_REQUIRED');
  for (const key of ['COMPOSE_FILE', 'DOCKER_HOST', 'BUILDKIT_PROGRESS', 'compose_project_name']) assert.equal((await check(pasted('e.example.com', { env: { [key]: 'x' } }))).body.code, 'ENV_KEY_REFUSED', key);
  for (const value of ['a\nb', 'a\rb', 'a\u0000b']) assert.equal((await check(pasted('e.example.com', { env: { KEY: value } }))).body.code, 'INVALID_ENV');
  const echoed = await check(pasted('e.example.com', { env: { 'BAD KEY': SECRET } }));
  assert.ok(!JSON.stringify(echoed.body).includes(SECRET), 'a refused value is never echoed');
});

test('a pasted Compose launch runs every step, saves the site with day-one backups and restore tests, then backs it up', async () => {
  const server = serverRow('web-1'), tester = serverRow('test-1'); calls = []; script = {};
  assert.equal((await stale('POST', `/servers/${server}/launch`, pasted('shop.example.com'))).body.code, 'REAUTH_REQUIRED');
  const started = await admin('POST', `/servers/${server}/launch`, { ...pasted('shop.example.com'), testServerId: tester, backupTime: '04:15' });
  assert.equal(started.status, 202);
  const launchId = started.body.launch.id;
  const row = db.prepare('SELECT * FROM site_launches WHERE id=?').get(launchId);
  assert.ok(!JSON.stringify(row).includes(SECRET) && !JSON.stringify(row).includes('mariadb'), 'neither the Compose text nor values are on the launch row');
  const payload = db.prepare("SELECT payload FROM site_launch_steps WHERE launch_id=? AND step='fetch'").get(launchId).payload;
  assert.ok(payload && !payload.includes(SECRET), 'the job payload is sealed');
  assert.ok(row.loopback_port >= 20000 && row.loopback_port < 30000);
  await drive();
  assert.equal(db.prepare("SELECT payload FROM site_launch_steps WHERE launch_id=? AND step='fetch'").get(launchId).payload, null, 'the payload is wiped after the fetch');
  const fetchCall = calls.find(call => call.request.operation === 'launch-fetch');
  assert.equal(fetchCall.request.composeText, COMPOSE); assert.deepEqual(fetchCall.request.env, { DB_PASSWORD: SECRET }); assert.equal(fetchCall.request.watchStdin, true);
  assert.deepEqual(calls.filter(call => call.request.launchId === launchId).map(call => call.request.operation), ['launch-facts', 'launch-facts', 'launch-fetch', 'launch-start', 'launch-poll', 'launch-web', 'launch-certificate'], 'no build without build:');
  assert.equal(calls.find(call => call.request.operation === 'launch-start').request.loopbackPort, row.loopback_port);
  let launch = (await admin('GET', `/launches/${launchId}`)).body;
  assert.equal(launch.state, 'running'); assert.equal(launch.steps.find(step => step.step === 'build').state, 'skipped');
  assert.ok(launch.siteId, 'saved'); assert.equal(launchHeld(server), false, 'the hold is released before the first backup');
  const site = db.prepare('SELECT * FROM sites WHERE id=?').get(launch.siteId), config = JSON.parse(site.config);
  assert.equal(site.name, 'shop.example.com'); assert.deepEqual(config.containers, ['shop-example-com-web-1', 'shop-example-com-db-1']);
  assert.deepEqual(config.domains, ['shop.example.com']); assert.deepEqual(config.configFiles, ['/srv/docknest/shop-example-com/.env']);
  assert.deepEqual(config.composeFiles, ['/srv/docknest/shop-example-com/app/compose.yaml', '/srv/docknest/shop-example-com/compose.docknest.yaml']);
  assert.equal(config.healthUrl, 'https://shop.example.com/'); assert.equal(config.maintenance.publicUrl, 'https://shop.example.com');
  assert.deepEqual(backupPreflightProblems(config), [], 'the saved site passes the backup preflight rules');
  const policy = db.prepare('SELECT * FROM policies WHERE site_id=?').get(site.id);
  assert.equal(policy.enabled, 1); assert.equal(policy.schedule, '15 4 * * *'); assert.ok(policy.next_run);
  const tests = db.prepare('SELECT * FROM restore_test_settings WHERE site_id=?').get(site.id);
  assert.equal(tests.enabled, 1); assert.equal(tests.cadence, 'weekly'); assert.equal(tests.server_id, tester); assert.ok(tests.next_due_at);
  assert.equal(claimJob()?.site_id, site.id, 'the first backup is a normal queued backup');
  db.prepare("UPDATE jobs SET status='queued' WHERE site_id=?").run(site.id);
  finishBackups(site.id); await drive();
  launch = (await admin('GET', `/launches/${launchId}`)).body;
  assert.equal(launch.state, 'done'); assert.equal(launch.steps.find(step => step.step === 'first_backup').state, 'done');
  assert.ok(Date.parse(launch.removeUntil) - Date.now() > 23 * 3600_000, 'Remove launch is offered for 24 hours');
  assert.deepEqual(launch.actions, { cancel: false, checkDns: false, remove: true, retry: false });
  assert.equal(launch.dns.type, 'A'); assert.equal(launch.progress, 100); assert.match(launch.statusLine, /live and backed up/);
  assert.deepEqual(launch.certificate, { state: 'issued', reason: null }); assert.equal(launch.backups.schedule, '15 4 * * *');
  const state = (await admin('GET', '/state')).body.sites.find(item => item.id === site.id);
  assert.deepEqual(state.launch, { id: launchId, launchedAt: launch.finishedAt, removeUntil: launch.removeUntil }, '/api/state carries the launch for Remove launch');
  const everything = JSON.stringify([launch, db.prepare('SELECT * FROM audit_events').all(), logged, db.prepare('SELECT * FROM site_launches').all(), db.prepare('SELECT detail,result FROM site_launch_steps').all(), db.prepare('SELECT config FROM sites').all()]);
  assert.ok(!everything.includes(SECRET) && !everything.includes('mariadb:11'), 'no value or Compose text in answers, audit rows, logs or stored rows');
});

test('the maintenance page is set up after save; if that fails the launch still succeeds, with no teardown and no alert', async () => {
  const server = serverRow('maint-srv'); calls = []; script = {}; maintenanceCalls = [];
  const id = (await admin('POST', `/servers/${server}/launch`, pasted('maint.example.com'))).body.launch.id;
  await drive();
  const siteId = db.prepare('SELECT site_id FROM site_launches WHERE id=?').get(id).site_id;
  assert.deepEqual(maintenanceCalls, [{ siteId, actor: 'launch:' + id }], 'the 2.13 setup runs once, for the saved site');
  assert.equal(steps(id).maintenance, 'done');
  finishBackups(siteId); await drive();
  assert.equal((await admin('GET', `/launches/${id}`)).body.steps.find(step => step.step === 'maintenance').label, 'Maintenance page');
  maintenanceFault = 'nginx integration failed';
  const failing = (await admin('POST', `/servers/${server}/launch`, pasted('maint2.example.com'))).body.launch.id;
  await drive();
  const siteTwo = db.prepare('SELECT site_id FROM site_launches WHERE id=?').get(failing).site_id;
  finishBackups(siteTwo); await drive();
  const launch = (await admin('GET', `/launches/${failing}`)).body;
  assert.equal(launch.state, 'done', 'the launch succeeds'); assert.equal(steps(failing).maintenance, 'failed'); assert.equal(steps(failing).teardown, 'pending', 'no teardown');
  assert.match(launch.steps.find(step => step.step === 'maintenance').detail, /set it up from the site page/);
  assert.ok(!calls.some(call => call.request.operation === 'launch-teardown' && call.request.launchId === failing));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='launch.needs_attention' AND target=?").get(failing).n, 0, 'no alert');
  const config = JSON.parse(db.prepare('SELECT config FROM sites WHERE id=?').get(siteTwo).config);
  assert.equal(config.maintenance.required, true, 'the site page offers Set up maintenance page as for any site');
  maintenanceFault = null;
});

test('one launch per server, the slug once, 3 launches per server per hour, gate refusals as 422', async () => {
  const server = serverRow('limits-srv'); script = { 'launch-poll': { ok: true, state: 'waiting', reason: 'NO_ANSWER' } };
  const first = await admin('POST', `/servers/${server}/launch`, pasted('one.example.com'));
  assert.equal(first.status, 202);
  assert.equal((await admin('POST', `/servers/${server}/launch`, pasted('two.example.com'))).body.code, 'LAUNCH_RUNNING');
  db.prepare("UPDATE site_launches SET state='done' WHERE id=?").run(first.body.launch.id);
  db.prepare("UPDATE site_launch_steps SET state='done' WHERE launch_id=? AND state='launch_queued'").run(first.body.launch.id);
  assert.equal((await admin('POST', `/servers/${server}/launch`, pasted('one.example.com'))).body.code, 'SLUG_EXISTS');
  script = { 'launch-facts': facts({ gate: { ok: false, refusals: [{ code: 'PRIVILEGED', service: 'web', field: 'privileged' }] } }) };
  const gated = await admin('POST', `/servers/${server}/launch`, pasted('gate.example.com'));
  assert.equal(gated.status, 422); assert.equal(gated.body.code, 'PRIVILEGED'); assert.deepEqual(gated.body.refusals, [{ code: 'PRIVILEGED', service: 'web', field: 'privileged' }]);
  script = {};
  for (const name of ['r2', 'r3']) {
    const answer = await admin('POST', `/servers/${server}/launch`, pasted(`${name}.example.com`));
    assert.equal(answer.status, 202, name);
    db.prepare("UPDATE site_launches SET state='cancelled' WHERE id=?").run(answer.body.launch.id);
    db.prepare("UPDATE site_launch_steps SET state='skipped' WHERE launch_id=? AND state='launch_queued'").run(answer.body.launch.id);
  }
  const limited = await admin('POST', `/servers/${server}/launch`, pasted('r4.example.com'));
  assert.equal(limited.status, 429); assert.equal(limited.body.code, 'RATE_LIMITED');
  const git = await admin('POST', `/servers/${serverRow('trust-srv')}/launch`, { source: 'git', domain: 'g.example.com', repo: { url: 'https://github.com/o/r.git', ref: 'main' }, webService: 'web', webPort: 3000, cleanShutdownConfirmed: true });
  assert.equal(git.body.code, 'TRUST_REQUIRED', 'a repository needs the trust confirmation');
});

test('a failure before save tears everything down; a teardown that fails needs you, alerts, holds the server and Try again finishes it', async () => {
  const server = serverRow('fail-srv'); calls = [];
  detectJobsAndMoves(); // start the alert cursor now
  script = { 'launch-start': { ok: false, code: 'IMAGE_NO_ARCH', reason: "An image has no build for this server's processor." } };
  const { body } = await admin('POST', `/servers/${server}/launch`, pasted('arm.example.com'));
  await drive();
  let launch = (await admin('GET', `/launches/${body.launch.id}`)).body;
  assert.equal(launch.state, 'failed'); assert.equal(launch.failedStep, 'start'); assert.match(launch.reason, /no build for this server's processor/);
  assert.ok(calls.some(call => call.request.operation === 'launch-teardown' && call.request.launchId === body.launch.id && call.request.keepBackup === true));
  assert.equal(launch.siteId, null, 'no site record'); assert.equal(launchHeld(server), false);
  script = { 'launch-poll': { ok: true, state: 'failed', reason: 'CRASH_LOOP', service: 'web' }, 'launch-teardown': { ok: true, removed: ['folder'], left: ['network shop_default'], keepBackup: true } };
  const second = (await admin('POST', `/servers/${server}/launch`, pasted('broken.example.com'))).body.launch.id;
  await drive();
  launch = (await admin('GET', `/launches/${second}`)).body;
  assert.equal(launch.state, 'needs_attention'); assert.equal(launch.failedStep, 'check_health'); assert.equal(launch.actions.retry, true);
  assert.equal(launchHeld(server), true, 'the hold is kept');
  db.prepare("INSERT INTO connections(id,provider,name,secret,settings,created_at,updated_at) VALUES('c1','telegram','Phone','sealed','{}',?,?)").run(at(), at());
  db.prepare("INSERT INTO alert_nodes(id,provider,name,connection_id,created_at,updated_at) VALUES('n1','telegram','Phone','c1',?,?)").run(at(), at());
  db.prepare("INSERT INTO alert_lines(id,node_id,source_kind,source_id,events,enabled,created_at,updated_at) VALUES('l1','n1','server',?,?,1,?,?)").run(server, JSON.stringify(['launch.needs_you']), at(), at());
  assert.ok(EVENTS.includes('launch.needs_you'));
  detectJobsAndMoves();
  const alert = db.prepare("SELECT * FROM alert_outbox WHERE event='launch.needs_you'").get();
  assert.ok(alert, 'alert launch.needs_you queued'); assert.match(alert.message, /fail-srv/);
  assert.equal(templateFor({ type: 'launch.needs_you', serverName: 'x' }).title, 'Launch needs you');
  assert.equal((await stale('POST', `/launches/${second}/retry`, {})).body.code, 'REAUTH_REQUIRED');
  script = {};
  assert.equal((await admin('POST', `/launches/${second}/retry`, {})).status, 202);
  await drive();
  launch = (await admin('GET', `/launches/${second}`)).body;
  assert.equal(launch.state, 'failed'); assert.equal(launch.reason, 'web keeps crashing and restarting.'); assert.equal(launchHeld(server), false);
  // A check that fails creates nothing, so nothing is torn down.
  calls = []; script = { 'launch-facts': request => (calls.filter(call => call.request.operation === 'launch-facts').length > 1 ? facts({ checks: [{ id: 'docker', ok: false, code: 'DOCKER_MISSING', reason: 'Docker is not installed.' }] }) : facts()) };
  const third = (await admin('POST', `/servers/${server}/launch`, pasted('nodocker.example.com'))).body.launch.id;
  await drive();
  assert.equal(db.prepare('SELECT state,failed_step FROM site_launches WHERE id=?').get(third).failed_step, 'check');
  assert.ok(!calls.some(call => call.request.operation === 'launch-teardown'));
});

test('DNS not pointing yet: saved on HTTP in waiting_dns, Check again issues the certificate; a certificate failure keeps the site', async () => {
  const server = serverRow('dns-srv');
  script = { 'launch-certificate': { ok: true, state: 'dns_waiting', certName: 'docknest-new-example-com', code: 'DNS_WAITING', reason: 'The domain does not point at this server yet.' } };
  const id = (await admin('POST', `/servers/${server}/launch`, pasted('new.example.com'))).body.launch.id;
  await drive();
  const siteId = db.prepare('SELECT site_id FROM site_launches WHERE id=?').get(id).site_id;
  finishBackups(siteId); await drive();
  let launch = (await admin('GET', `/launches/${id}`)).body;
  assert.equal(launch.state, 'waiting_dns'); assert.ok(launch.siteId, 'saved and backed up while DNS waits');
  assert.equal(launch.steps.find(step => step.step === 'certificate').state, 'waiting'); assert.equal(launch.actions.checkDns, true);
  const before = calls.length; engine.tickLaunches(); engine.tickLaunches();
  assert.equal(calls.length, before, 'nothing polls DNS');
  script = { 'launch-certificate': { ok: true, state: 'failed', certName: 'docknest-new-example-com', code: 'RATE_LIMITED', reason: "Let's Encrypt rate limit reached. Try again later." } };
  assert.equal((await admin('POST', `/launches/${id}/check-dns`, {})).status, 202);
  await drive();
  launch = (await admin('GET', `/launches/${id}`)).body;
  assert.equal(launch.state, 'waiting_dns', 'a certbot failure changes nothing else'); assert.match(launch.steps.find(step => step.step === 'certificate').detail, /rate limit/);
  assert.equal(db.prepare('SELECT 1 FROM site_archives WHERE site_id=?').get(siteId), undefined, 'the site is kept');
  script = {};
  await admin('POST', `/launches/${id}/check-dns`, {}); await drive();
  launch = (await admin('GET', `/launches/${id}`)).body;
  assert.equal(launch.state, 'done'); assert.equal(launch.steps.find(step => step.step === 'certificate').state, 'done'); assert.equal(launch.actions.checkDns, false);
  assert.equal((await admin('POST', `/launches/${id}/check-dns`, {})).body.code, 'NOT_WAITING');
});

test('a worker restart asks launch-status: a resumable step runs again, otherwise the launch is torn down', async () => {
  const server = serverRow('restart-srv'); calls = [];
  script = { 'launch-build': () => new Promise(() => {}) };
  const repoLaunch = { source: 'git', domain: 'built.example.com', repo: { url: 'https://github.com/o/r.git', ref: 'main', composePath: 'deploy/compose.yaml' }, webService: 'web', webPort: 3000, trustConfirmed: true, cleanShutdownConfirmed: true };
  script['launch-fetch'] = { ok: true, commit: 'a'.repeat(40), services: [{ name: 'web', ports: [3000], build: true }], composeName: null, gate: { ok: true, refusals: [] } };
  const id = (await admin('POST', `/servers/${server}/launch`, repoLaunch)).body.launch.id;
  for (let index = 0; index < 4; index++) { engine.tickLaunches(); const claimed = claimLaunch(); if (claimed?.step === 'build') break; if (claimed) await engine.executeLaunchStep(claimed); }
  assert.equal(steps(id).build, 'launch_running', 'the build is running when the worker dies');
  assert.equal(db.prepare('SELECT commit_sha FROM site_launches WHERE id=?').get(id).commit_sha, 'a'.repeat(40));
  interruptLaunchSteps();
  script = { 'launch-status': { ok: true, journal: true, phase: 'building', present: ['paths', 'builders'], busy: false, killed: 1, resumable: false } };
  await drive();
  const launch = (await admin('GET', `/launches/${id}`)).body;
  assert.equal(launch.state, 'failed'); assert.equal(launch.failedStep, 'build');
  assert.deepEqual(calls.filter(call => call.request.launchId === id).slice(-2).map(call => call.request.operation), ['launch-status', 'launch-teardown']);
  // Resumable: the interrupted health check simply runs again.
  script = { 'launch-poll': { ok: true, state: 'waiting', reason: 'NO_ANSWER' } };
  const other = (await admin('POST', `/servers/${server}/launch`, pasted('resume.example.com'))).body.launch.id;
  await drive();
  db.prepare("UPDATE site_launch_steps SET state='launch_running' WHERE launch_id=? AND step='check_health'").run(other);
  interruptLaunchSteps(); script = {};
  await drive();
  assert.equal(steps(other).check_health, 'done'); assert.equal(steps(other).save, 'done');
});

test('build steps run only with build:, slow health checks wait without holding the worker, and the time limit fails them', async () => {
  const server = serverRow('slow-srv'); calls = [];
  script = { 'launch-fetch': { ok: true, commit: 'b'.repeat(40), services: [{ name: 'web', ports: [3000], build: true }], composeName: null, gate: { ok: true, refusals: [] } }, 'launch-poll': { ok: true, state: 'waiting', reason: 'SETTLING', httpStatus: 200 } };
  const id = (await admin('POST', `/servers/${server}/launch`, { source: 'git', domain: 'slow.example.com', repo: { url: 'https://github.com/o/mono.git', ref: 'main', composePath: 'apps/web/compose.yaml' }, webService: 'web', webPort: 3000, trustConfirmed: true, cleanShutdownConfirmed: true })).body.launch.id;
  await drive();
  assert.ok(calls.some(call => call.request.operation === 'launch-build'));
  assert.equal(calls.find(call => call.request.operation === 'launch-fetch').request.repo.composePath, 'apps/web/compose.yaml');
  assert.equal(steps(id).check_health, 'waiting', 'between looks no job is held');
  assert.equal(claimLaunch(), null, 'and nothing is claimable until the next look is due');
  // The 10-minute limit passes.
  const row = db.prepare("SELECT result FROM site_launch_steps WHERE launch_id=? AND step='check_health'").get(id);
  db.prepare("UPDATE site_launch_steps SET result=? WHERE launch_id=? AND step='check_health'").run(JSON.stringify({ ...JSON.parse(row.result), deadline: new Date(Date.now() - 1000).toISOString() }), id);
  await drive();
  const launch = (await admin('GET', `/launches/${id}`)).body;
  assert.equal(launch.state, 'failed'); assert.equal(launch.failedStep, 'check_health'); assert.match(launch.reason, /did not answer within 10 minutes/);
  script = {};
});

test('a build that runs past its time limit is stopped and the launch is torn down', async () => {
  const server = serverRow('timeout-srv'); calls = [];
  let aborted = false;
  script = { 'launch-fetch': { ok: true, commit: 'b'.repeat(40), services: [{ name: 'web', ports: [3000], build: true }], composeName: null, gate: { ok: true, refusals: [] } } };
  const plainRemote = engine.launchTransport.remote;
  engine.launchTransport.remote = (original => async (srv, request, options) => {
    if (request.operation === 'launch-build') return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('stopped'), { aborted: true })); }));
    return original(srv, request, options);
  })(engine.launchTransport.remote);
  const id = (await admin('POST', `/servers/${server}/launch`, { source: 'git', domain: 'hang.example.com', repo: { url: 'https://github.com/o/r.git', ref: 'main' }, webService: 'web', webPort: 3000, trustConfirmed: true, cleanShutdownConfirmed: true })).body.launch.id;
  for (let index = 0; index < 4 && steps(id).build !== 'launch_queued'; index++) { engine.tickLaunches(); const claimed = claimLaunch(); if (claimed) await engine.executeLaunchStep(claimed); }
  engine.launchLimits.scale = 0.0001; // 30 minutes become 0.18 seconds for this one step
  try { engine.tickLaunches(); await engine.executeLaunchStep(claimLaunch()); } finally { engine.launchLimits.scale = 1; }
  assert.equal(aborted, true, 'the helper call was stopped (its stdin closes)');
  await drive();
  const launch = (await admin('GET', `/launches/${id}`)).body;
  assert.equal(launch.state, 'failed'); assert.equal(launch.failedStep, 'build'); assert.match(launch.reason, /took longer than/);
  assert.ok(calls.some(call => call.request.operation === 'launch-teardown' && call.request.launchId === id));
  engine.launchTransport.remote = plainRemote; script = {};
});

test('cancel before start ends the launch; after start it is refused', async () => {
  const server = serverRow('cancel-srv'); script = {};
  const queued = (await admin('POST', `/servers/${server}/launch`, pasted('c1.example.com'))).body.launch.id;
  const cancelled = await admin('POST', `/launches/${queued}/cancel`, {});
  assert.equal(cancelled.status, 200); assert.equal(cancelled.body.state, 'cancelled');
  assert.equal(db.prepare("SELECT payload FROM site_launch_steps WHERE launch_id=? AND step='fetch'").get(queued).payload, null);
  const running = (await admin('POST', `/servers/${server}/launch`, pasted('c2.example.com'))).body.launch.id;
  engine.tickLaunches(); await engine.executeLaunchStep(claimLaunch()); // check done
  engine.tickLaunches(); await engine.executeLaunchStep(claimLaunch()); // fetch done
  assert.equal((await admin('POST', `/launches/${running}/cancel`, {})).status, 200);
  await drive();
  assert.equal(db.prepare('SELECT state FROM site_launches WHERE id=?').get(running).state, 'cancelled');
  assert.equal(steps(running).teardown, 'done', 'what the fetch made is torn down');
  const started = (await admin('POST', `/servers/${server}/launch`, pasted('c3.example.com'))).body.launch.id;
  await drive();
  assert.equal((await admin('POST', `/launches/${started}/cancel`, {})).body.code, 'CANCEL_NOT_ALLOWED');
});

test('Remove launch within 24 hours tears down, archives the site with its backups and turns schedules off', async () => {
  const server = serverRow('remove-srv'); script = {};
  const id = (await admin('POST', `/servers/${server}/launch`, pasted('gone.example.com'))).body.launch.id;
  await drive();
  const siteId = db.prepare('SELECT site_id FROM site_launches WHERE id=?').get(id).site_id;
  finishBackups(siteId); await drive();
  assert.equal(db.prepare('SELECT enabled FROM restore_test_settings WHERE site_id=?').get(siteId).enabled, 0, 'no other server: restore tests off');
  assert.equal(db.prepare('SELECT skip_reason FROM restore_test_settings WHERE site_id=?').get(siteId).skip_reason, 'Choose a test server to turn on restore tests.');
  assert.equal((await stale('POST', `/launches/${id}/remove`, {})).body.code, 'REAUTH_REQUIRED');
  calls = [];
  assert.equal((await admin('POST', `/launches/${id}/remove`, {})).status, 202);
  await drive();
  const launch = (await admin('GET', `/launches/${id}`)).body;
  assert.equal(launch.state, 'removed');
  assert.ok(calls.some(call => call.request.operation === 'launch-teardown' && call.request.keepBackup === true));
  assert.ok(db.prepare('SELECT 1 FROM site_archives WHERE site_id=?').get(siteId), 'archived');
  assert.equal(db.prepare('SELECT enabled FROM policies WHERE site_id=?').get(siteId).enabled, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backups WHERE site_id=?').get(siteId).n, 1, 'backups kept');
  const late = (await admin('POST', `/servers/${server}/launch`, pasted('late.example.com'))).body.launch.id;
  await drive(); finishBackups(db.prepare('SELECT site_id FROM site_launches WHERE id=?').get(late).site_id); await drive();
  db.prepare('UPDATE site_launches SET remove_until=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), late);
  assert.equal((await admin('POST', `/launches/${late}/remove`, {})).body.code, 'REMOVE_EXPIRED');
});

test('the deploy key goes to the helper only, from its sealed row, and only from the server it was confirmed on', async () => {
  const server = serverRow('key-srv'), other = serverRow('key-other');
  const keyId = randomUUID(), privateKey = generateDeployKey('docknest-test').privateKey;
  db.prepare("INSERT INTO deploy_keys(id,name,git_host,host_key_line,host_key_sha256,public_key,fingerprint,sealed_private_key,pinned_from_server_id,pinned_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(keyId, 'App', 'github.com', 'github.com ssh-ed25519 AAAAC3', 'SHA256:x', 'ssh-ed25519 AAAA c', 'SHA256:y', seal(privateKey), server, at(), 'admin', at());
  calls = []; script = {};
  const body = { source: 'git', domain: 'private.example.com', repo: { url: 'git@github.com:owner/app.git', ref: 'main' }, deployKeyId: keyId, webService: 'web', webPort: 3000 };
  const elsewhere = await admin('POST', `/servers/${other}/launch/check`, body);
  assert.equal(elsewhere.status, 409); assert.equal(elsewhere.body.code, 'HOST_KEY_REPIN_REQUIRED');
  const id = (await admin('POST', `/servers/${server}/launch`, { ...body, trustConfirmed: true, cleanShutdownConfirmed: true })).body.launch.id;
  await drive();
  const fetchCall = calls.find(call => call.request.operation === 'launch-fetch');
  assert.deepEqual(fetchCall.request.deployKey, { privateKey, hostKeyLine: 'github.com ssh-ed25519 AAAAC3' });
  const stored = JSON.stringify([db.prepare('SELECT * FROM site_launches WHERE id=?').get(id), db.prepare('SELECT detail,result,payload FROM site_launch_steps WHERE launch_id=?').all(id), db.prepare('SELECT * FROM audit_events').all(), (await admin('GET', `/launches/${id}`)).body, logged]);
  assert.ok(!stored.includes(privateKey.split('\n')[1]), 'the key is never stored outside its sealed row, logged or answered');
  assert.equal((await admin('POST', `/servers/${server}/launch/check`, { ...body, deployKeyId: undefined, repo: { url: 'git@gitlab.com:o/r.git', ref: 'main' } })).body.code, 'DEPLOY_KEY_REQUIRED');
  assert.equal((await admin('POST', `/servers/${server}/launch/check`, { ...body, repo: { url: 'git@gitlab.com:o/r.git', ref: 'main' } })).body.code, 'DEPLOY_KEY_HOST');
});

test('review fixes: required Launch fields, save failure, first backup refusals, Remove launch refusals, cancel withdraws, alert again', async () => {
  const server = serverRow('review-srv'); script = {}; calls = [];
  // B1 and S4: the clean shutdown confirmation and the web port are required; the web service when Check found several.
  assert.equal((await admin('POST', `/servers/${server}/launch`, pasted('r1.example.com', { cleanShutdownConfirmed: undefined }))).body.code, 'SHUTDOWN_CONFIRM_REQUIRED');
  assert.equal((await admin('POST', `/servers/${server}/launch`, pasted('r1.example.com', { cleanShutdownConfirmed: false }))).body.code, 'SHUTDOWN_CONFIRM_REQUIRED');
  assert.equal((await admin('POST', `/servers/${server}/launch`, pasted('r1.example.com', { webPort: undefined }))).body.code, 'INVALID_PORT');
  assert.equal((await admin('POST', `/servers/${server}/launch`, pasted('r1.example.com', { webService: undefined }))).body.code, 'INVALID_SERVICE');
  // S1: a site record that cannot be saved fails the save step and tears the launch down.
  db.exec("CREATE TEMP TRIGGER launch_test_no_site BEFORE INSERT ON sites BEGIN SELECT RAISE(ABORT,'no site'); END");
  const unsaved = (await admin('POST', `/servers/${serverRow('unsaved-srv')}/launch`, pasted('unsaved.example.com'))).body.launch.id;
  try { await drive(); } finally { db.exec('DROP TRIGGER launch_test_no_site'); }
  let view = (await admin('GET', `/launches/${unsaved}`)).body;
  assert.equal(view.state, 'failed'); assert.equal(view.failedStep, 'save'); assert.equal(steps(unsaved).teardown, 'done');
  // S2: a first backup that can never be queued (the site was removed meanwhile) fails its step; the launch still ends.
  const first = (await admin('POST', `/servers/${serverRow('first-srv')}/launch`, pasted('first.example.com'))).body.launch.id;
  engine.launchMaintenance.setup = async () => { db.prepare('INSERT INTO site_archives(site_id,archived_at) VALUES(?,?)').run(db.prepare('SELECT site_id FROM site_launches WHERE id=?').get(first).site_id, at()); };
  try { await drive(); } finally { engine.launchMaintenance.setup = async () => ({}); }
  view = (await admin('GET', `/launches/${first}`)).body;
  assert.equal(steps(first).first_backup, 'failed'); assert.equal(view.state, 'done');
  assert.match(view.steps.find(step => step.step === 'first_backup').detail, /could not be queued/);
  // S3: Remove launch is refused for an archived or moved site.
  assert.equal((await admin('POST', `/launches/${first}/remove`, {})).body.code, 'REMOVE_NOT_ALLOWED');
  const moved = (await admin('POST', `/servers/${serverRow('moved-srv')}/launch`, pasted('moved.example.com'))).body.launch.id;
  await drive(); const movedSite = db.prepare('SELECT site_id FROM site_launches WHERE id=?').get(moved).site_id; finishBackups(movedSite); await drive();
  db.prepare('UPDATE sites SET server_id=? WHERE id=?').run(serverRow('elsewhere'), movedSite);
  assert.equal((await admin('POST', `/launches/${moved}/remove`, {})).body.code, 'SITE_MOVED');
  // S7: Cancel withdraws a queued step before start (here the fetch), so nothing is created.
  const withdrawn = (await admin('POST', `/servers/${serverRow('withdraw-srv')}/launch`, pasted('withdraw.example.com'))).body.launch.id;
  engine.tickLaunches(); await engine.executeLaunchStep(claimLaunch()); // check done, fetch queued
  assert.equal(steps(withdrawn).fetch, 'launch_queued');
  assert.equal((await admin('POST', `/launches/${withdrawn}/cancel`, {})).status, 200);
  await drive();
  assert.equal(db.prepare('SELECT state FROM site_launches WHERE id=?').get(withdrawn).state, 'cancelled');
  assert.ok(!calls.some(call => call.request.launchId === withdrawn && ['launch-fetch', 'launch-teardown'].includes(call.request.operation)));
  // S8: Try again that fails again alerts again.
  script = { 'launch-poll': { ok: true, state: 'failed', reason: 'UNHEALTHY', service: 'web' }, 'launch-teardown': { ok: true, removed: [], left: ['volume'], keepBackup: true } };
  const stuck = (await admin('POST', `/servers/${serverRow('stuck-srv')}/launch`, pasted('stuck.example.com'))).body.launch.id;
  await drive();
  assert.equal(db.prepare('SELECT state FROM site_launches WHERE id=?').get(stuck).state, 'needs_attention');
  await admin('POST', `/launches/${stuck}/retry`, {}); await drive();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='launch.needs_attention' AND target=?").get(stuck).n, 2, 'each failed teardown is a new alert');
  script = {}; await admin('POST', `/launches/${stuck}/retry`, {}); await drive();
  assert.equal(db.prepare('SELECT state FROM site_launches WHERE id=?').get(stuck).state, 'failed');
  // S5: the certificate step gets the public addresses of the DNS record.
  const certCall = calls.find(call => call.request.operation === 'launch-certificate');
  assert.deepEqual(certCall.request.serverIps, ['8.8.8.8', '2a01:4f9:c010::20']);
});

test('a loopback port taken after Launch fails the check step; certificate refusals keep the health URL empty', async () => {
  const server = serverRow('port-srv'); calls = [];
  script = {};
  const id = (await admin('POST', `/servers/${server}/launch`, pasted('port.example.com'))).body.launch.id;
  const port = db.prepare('SELECT loopback_port FROM site_launches WHERE id=?').get(id).loopback_port;
  script = { 'launch-facts': facts({ usedPorts: [22, 80, 443, port] }) };
  await drive();
  const view = (await admin('GET', `/launches/${id}`)).body;
  assert.equal(view.state, 'failed'); assert.equal(view.failedStep, 'check'); assert.match(view.reason, /taken meanwhile/);
  // A refusal (here an existing lineage) and a missing certbot say nothing about DNS: no http:// health URL.
  for (const [code, reason] of [['CERT_LINEAGE_EXISTS', 'A certificate for this domain already exists on the server.'], ['CERTBOT_MISSING', 'The server needs certbot. Install it, then try again.']]) {
    script = { 'launch-certificate': code === 'CERTBOT_MISSING' ? { ok: true, state: 'failed', certName: 'x', code, reason } : { ok: false, code, reason } };
    const other = (await admin('POST', `/servers/${serverRow('cert-' + code)}/launch`, pasted(`${code.toLowerCase().replace(/_/g, '-')}.example.com`))).body.launch.id;
    await drive();
    const siteId = db.prepare('SELECT site_id FROM site_launches WHERE id=?').get(other).site_id;
    assert.equal(JSON.parse(db.prepare('SELECT config FROM sites WHERE id=?').get(siteId).config).healthUrl, '', code);
  }
  script = {};
});

test('a certificate issued later re-runs the maintenance step (the helper clears ready), and interrupted non-fatal steps never tear down', async () => {
  const server = serverRow('remaint-srv'); calls = []; maintenanceCalls = [];
  engine.launchMaintenance.setup = async (siteId, actor) => { maintenanceCalls.push({ siteId, actor }); return {}; };
  script = { 'launch-certificate': { ok: true, state: 'dns_waiting', certName: 'x', code: 'DNS_WAITING', reason: 'The domain does not point at this server yet.' } };
  const id = (await admin('POST', `/servers/${server}/launch`, pasted('remaint.example.com'))).body.launch.id;
  await drive();
  const siteId = db.prepare('SELECT site_id FROM site_launches WHERE id=?').get(id).site_id;
  finishBackups(siteId); await drive();
  assert.equal(maintenanceCalls.length, 1);
  assert.equal(JSON.parse(db.prepare('SELECT config FROM sites WHERE id=?').get(siteId).config).maintenance.probeOrigin, true, 'setup probes through loopback before DNS points here');
  script = {};
  await admin('POST', `/launches/${id}/check-dns`, {}); await drive();
  const certCall = calls.filter(call => call.request.operation === 'launch-certificate').at(-1);
  assert.equal(certCall.request.maintenanceDirectory, `/var/lib/docknest/maintenance/${siteId}`);
  assert.equal(maintenanceCalls.length, 2, 'the maintenance step ran again (maintenanceReset)'); assert.equal(steps(id).maintenance, 'done');
  // No reset reported: the step is not run again. A changed staging root: the field is left out.
  db.prepare("UPDATE site_launch_steps SET state='waiting' WHERE launch_id=? AND step='certificate'").run(id); db.prepare("UPDATE site_launches SET state='waiting_dns' WHERE id=?").run(id);
  script = { 'launch-certificate': { ok: true, state: 'issued', certName: 'x', maintenanceReset: false } };
  await admin('POST', `/launches/${id}/check-dns`, {}); await drive();
  assert.equal(maintenanceCalls.length, 2);
  const custom = JSON.parse(db.prepare('SELECT config FROM sites WHERE id=?').get(siteId).config);
  db.prepare('UPDATE sites SET config=? WHERE id=?').run(JSON.stringify({ ...custom, maintenance: { ...custom.maintenance, directory: '/opt/stage/maintenance/' + siteId } }), siteId);
  db.prepare("UPDATE site_launch_steps SET state='waiting' WHERE launch_id=? AND step='certificate'").run(id); db.prepare("UPDATE site_launches SET state='waiting_dns' WHERE id=?").run(id);
  script = {};
  await admin('POST', `/launches/${id}/check-dns`, {}); await drive();
  assert.equal(calls.filter(call => call.request.operation === 'launch-certificate').at(-1).request.maintenanceDirectory, undefined);
  assert.equal(maintenanceCalls.length, 2);
  assert.equal(db.prepare('SELECT state FROM site_launches WHERE id=?').get(id).state, 'done');
  // An interrupted maintenance step on a saved launch: not resumable, fails with its own sentence, no teardown.
  db.prepare("UPDATE site_launch_steps SET state='launch_running' WHERE launch_id=? AND step='maintenance'").run(id);
  interruptLaunchSteps();
  script = { 'launch-status': { ok: true, journal: true, phase: 'certificate', present: [], busy: false, killed: 0, resumable: false } };
  db.prepare("UPDATE site_launches SET state='running' WHERE id=?").run(id);
  await drive();
  assert.equal(steps(id).maintenance, 'failed'); assert.equal(steps(id).teardown, 'pending');
  assert.match((await admin('GET', `/launches/${id}`)).body.steps.find(step => step.step === 'maintenance').detail, /set it up from the site page/);
  script = {};
});

test('a maintenance setup that hangs is stopped at the step limit without a teardown', async () => {
  const server = serverRow('hang-maint-srv');
  engine.launchMaintenance.setup = () => new Promise(() => {});
  const id = (await admin('POST', `/servers/${server}/launch`, pasted('hangmaint.example.com'))).body.launch.id;
  for (let index = 0; index < 12 && steps(id).maintenance !== 'launch_queued'; index++) { engine.tickLaunches(); const claimed = claimLaunch(); if (claimed) await engine.executeLaunchStep(claimed); }
  engine.launchLimits.scale = 0.001;
  try { engine.tickLaunches(); await engine.executeLaunchStep(claimLaunch()); } finally { engine.launchLimits.scale = 1; engine.launchMaintenance.setup = async (siteId, actor) => { maintenanceCalls.push({ siteId, actor }); return {}; }; }
  assert.equal(steps(id).maintenance, 'failed'); assert.equal(steps(id).teardown, 'pending');
  assert.match((await admin('GET', `/launches/${id}`)).body.steps.find(step => step.step === 'maintenance').detail, /took too long/);
});

test('the site URLs follow the certificate: none while DNS waits, http after a failure, https once issued', async () => {
  const server = serverRow('urls-srv');
  script = { 'launch-certificate': { ok: true, state: 'dns_waiting', certName: 'docknest-urls-example-com', code: 'DNS_WAITING', reason: 'The domain does not point at this server yet.' } };
  const id = (await admin('POST', `/servers/${server}/launch`, pasted('urls.example.com'))).body.launch.id;
  await drive();
  const siteId = db.prepare('SELECT site_id FROM site_launches WHERE id=?').get(id).site_id;
  const config = () => JSON.parse(db.prepare('SELECT config FROM sites WHERE id=?').get(siteId).config);
  assert.equal(config().healthUrl, ''); assert.equal(config().maintenance.publicUrl, 'http://urls.example.com');
  finishBackups(siteId); await drive();
  script = { 'launch-certificate': { ok: true, state: 'failed', certName: 'docknest-urls-example-com', code: 'CAA_REFUSED', reason: 'A CAA record on the domain does not allow Let\'s Encrypt.' } };
  await admin('POST', `/launches/${id}/check-dns`, {}); await drive();
  assert.equal(config().healthUrl, 'http://urls.example.com/');
  script = {};
  await admin('POST', `/launches/${id}/check-dns`, {}); await drive();
  assert.equal(config().healthUrl, 'https://urls.example.com/'); assert.equal(config().maintenance.publicUrl, 'https://urls.example.com');
});

test('alert text for launch.needs_you names only the server', () => {
  assert.equal(messageFor({ type: 'launch.needs_you', serverName: 'web-1' }), 'Launch needs you: DockNest could not remove everything a failed launch made on web-1. Open DockNest to try again.');
});

test('Remove launch is refused while a Safe Edit or a self-heal restart is queued or running, and turns self-heal off when it starts', async () => {
  const server = serverRow('remove-busy-srv'); script = {};
  const id = (await admin('POST', `/servers/${server}/launch`, pasted('busy.example.com'))).body.launch.id;
  await drive();
  const siteId = db.prepare('SELECT site_id FROM site_launches WHERE id=?').get(id).site_id;
  finishBackups(siteId); await drive();
  for (const [status, type] of [['edit_queued', 'site-edit'], ['edit_running', 'site-edit'], ['edit_waiting', 'site-edit'], ['heal_queued', 'self-heal'], ['heal_running', 'self-heal']]) {
    const jobId = `busy-${status}`;
    db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,?,?,'queued',?,'{}')").run(jobId, siteId, type, status, new Date().toISOString());
    const refused = await admin('POST', `/launches/${id}/remove`, {});
    assert.deepEqual([refused.status, refused.body.code], [409, 'SITE_BUSY'], status);
    db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(jobId);
  }
  const at = new Date().toISOString();
  db.prepare("INSERT INTO site_edits(id,site_id,server_id,state,created_by,created_at) VALUES('open-edit',?,?,'queued','admin',?)").run(siteId, server, at);
  assert.equal((await admin('POST', `/launches/${id}/remove`, {})).body.code, 'SITE_BUSY', 'an unfinished Safe Edit');
  db.prepare("UPDATE site_edits SET state='done',result='applied' WHERE id='open-edit'").run();
  db.prepare("INSERT INTO self_heal_settings(site_id,enabled,updated_at) VALUES(?,1,?)").run(siteId, at);
  assert.equal((await admin('POST', `/launches/${id}/remove`, {})).status, 202);
  assert.equal(db.prepare('SELECT enabled FROM self_heal_settings WHERE site_id=?').get(siteId).enabled, 0, 'self-heal is off for the site being torn down');
});
