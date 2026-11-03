// Unusual launch cases (docs/launch-site.md, "Real and unusual use cases") against a fake helper: refusals from the
// repository (submodules, LFS, size, symlinks, name collisions, too old git) tear down with their own sentence, an
// IPv6-only server gets an AAAA record only, wildcard nginx conflicts block, and a free loopback port is chosen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-launch-cases-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { db } = await import('../src/db.js');
const engine = await import('../src/launches/engine.js');
const { claimLaunch } = await import('../src/launches/claim.js');
const at = () => new Date().toISOString();
const serverRow = name => { const serverId = randomUUID(); db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(serverId, name, 'h', 22, 'root', 'k', '0'.repeat(64), at()); return serverId; };
let script = {}, calls = [];
const baseFacts = { serverIps: ['1.1.1.1'], dnsAnswers: { A: [], AAAA: [] }, usedPorts: [], checks: [{ id: 'docker', ok: true }] };
engine.launchTransport.remote = async (_server, request) => {
  calls.push(request.operation);
  if (script[request.operation] !== undefined) return structuredClone(script[request.operation]);
  return { 'launch-facts': baseFacts, 'launch-teardown': { removed: ['folder'], left: [] } }[request.operation] ?? { state: 'passed' };
};
async function drive() { for (let index = 0; index < 30; index++) { engine.tickLaunches(); const claimed = claimLaunch(); if (!claimed) return; await engine.executeLaunchStep(claimed); } }
const git = domain => ({ source: 'git', domain, repo: { url: 'https://github.com/owner/app.git', ref: 'main' }, webService: 'web', webPort: 3000, trustConfirmed: true, cleanShutdownConfirmed: true });

test('repository refusals at fetch tear down with the fixed sentence of the helper', async () => {
  // Codes and sentences exactly as remote/helper/launch.py LAUNCH_REASONS.
  for (const [code, reason] of [['SUBMODULES_REFUSED', 'The repository uses Git submodules, which DockNest does not fetch.'], ['LFS_REFUSED', 'The repository uses Git LFS, which DockNest does not fetch.'], ['REPO_TOO_LARGE', 'The repository is larger than 2 GB.'], ['SYMLINK_ESCAPE', 'The repository has a symbolic link that points outside it.'], ['NAME_COLLISION', 'A container, volume or network with this name already exists on the server.'], ['DISK_FULL', 'The server is too low on disk space.'], ['FETCH_TIMEOUT', 'Fetching the repository took longer than 10 minutes.']]) {
    const server = serverRow(code); calls = [];
    script = { 'launch-fetch': { ok: false, code, reason } };
    const { launch } = await engine.startLaunch(server, git(`${code.toLowerCase().replace(/_/g, '-')}.example.com`), 'admin');
    await drive();
    const view = engine.launchView(launch.id);
    assert.equal(view.state, 'failed', code); assert.equal(view.failedStep, 'fetch'); assert.equal(view.reason, reason, code);
    assert.equal(calls.at(-1), 'launch-teardown', code);
  }
  // A gate refusal names the service and the setting.
  const server = serverRow('gated'); calls = [];
  script = { 'launch-fetch': { ok: false, code: 'GATE_REFUSED', reason: 'The Compose file gives the site access to the server.', commit: null, services: [{ name: 'web', ports: [80], build: false }], gate: { ok: false, refusals: [{ code: 'PRIVILEGED', service: 'web', field: 'privileged' }] } } };
  const { launch } = await engine.startLaunch(server, git('gate.example.com'), 'admin');
  await drive();
  assert.match(engine.launchView(launch.id).reason, /web: PRIVILEGED/);
  script = {};
});

test('a too old git or an nginx wildcard that would match blocks at check, before anything is created', async () => {
  for (const [code, sentence] of [['GIT_TOO_OLD', /too old/], ['NGINX_DOMAIN_SERVED', /already serves blocked\.example\.com \(or a wildcard/], ['CERT_LINEAGE_EXISTS', /certificate for blocked\.example\.com/]]) {
    script = { 'launch-facts': { ...baseFacts, checks: [{ id: 'x', ok: false, code, reason: code === 'GIT_TOO_OLD' ? 'The git on the server is too old (it lacks the 2025 submodule fixes). Update git, then try again.' : 'x' }] } };
    const server = serverRow('check-' + code);
    const answer = await engine.checkLaunch(server, git('blocked.example.com'));
    assert.equal(answer.ok, false); assert.match(answer.checks[0].text, sentence);
    await assert.rejects(engine.startLaunch(server, git('blocked.example.com'), 'admin'), error => error.status === 409 && error.code === code);
  }
  script = {};
});

test('an IPv6-only server gets an AAAA record only; a dual-stack one gets both; DNS already pointing is recognised', async () => {
  script = { 'launch-facts': { ...baseFacts, serverIps: ['2a01:4f9:c010::9', 'fd00::1', '10.0.0.9'], dnsAnswers: { A: [], AAAA: ['2a01:4f9:c010::9'] } } };
  const answer = await engine.checkLaunch(serverRow('v6'), git('six.example.com'));
  assert.deepEqual(answer.dns.records, [{ type: 'AAAA', name: 'six.example.com', value: '2a01:4f9:c010::9' }]);
  assert.equal(answer.dns.pointsHere, true);
  script = {};
});

test('the loopback port avoids listening ports and ports of other live launches on the server', () => {
  const server = serverRow('ports');
  db.prepare("INSERT INTO site_launches(id,server_id,slug,source,domain,state,loopback_port,created_by,created_at,updated_at) VALUES(?,?,'a','compose','a.example.com','done',20001,'admin',?,?)").run(randomUUID(), server, at(), at());
  const port = engine.chooseLoopbackPort(server, [20000, 20002], () => 0);
  assert.equal(port, 20003);
});

test('ports 80 and 443 held by another program block Check and Launch; the server nginx does not', async () => {
  script = { 'launch-facts': { ...baseFacts, ports: { 80: { port: 80, holder: 'nginx', process: 'nginx' }, 443: { port: 443, holder: 'other', process: 'python3' } } } };
  const server = serverRow('ports-busy');
  const answer = await engine.checkLaunch(server, git('busy.example.com'));
  assert.equal(answer.ok, false);
  const row = answer.checks.find(item => item.id === 'port443');
  assert.deepEqual({ ok: row.ok, code: row.code, text: row.text, title: row.title, status: row.status }, { ok: false, code: 'PORT_IN_USE', text: 'Port 443 is used by python3. Stop it, then Check again.', title: 'Port 443', status: 'block' });
  assert.equal(answer.checks.find(item => item.id === 'port80'), undefined, 'the server nginx on port 80 is fine');
  assert.ok(answer.blockers.includes('Port 443 is used by python3. Stop it, then Check again.'));
  await assert.rejects(engine.startLaunch(server, git('busy.example.com'), 'admin'), error => error.status === 409 && error.code === 'PORT_IN_USE');
  script = { 'launch-facts': { ...baseFacts, ports: { 80: { port: 80, holder: 'other' }, 443: { port: 443, holder: 'other', process: 'x; rm -rf /' } } } };
  const unnamed = await engine.checkLaunch(server, git('busy.example.com'));
  assert.deepEqual(unnamed.checks.filter(item => item.code === 'PORT_IN_USE').map(item => item.text), ['Port 80 is used by another program. Stop it, then Check again.', 'Port 443 is used by another program. Stop it, then Check again.']);
  script = { 'launch-facts': { ...baseFacts, ports: { 80: { port: 80, holder: 'nginx', process: 'nginx' }, 443: { port: 443, holder: 'none' } } } };
  assert.equal((await engine.checkLaunch(server, git('free.example.com'))).ok, true);
  script = {};
});
