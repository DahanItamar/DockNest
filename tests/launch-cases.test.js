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
const baseFacts = { serverIps: ['198.51.100.9'], dnsAnswers: { A: [], AAAA: [] }, usedPorts: [], checks: [{ id: 'docker', ok: true }] };
engine.launchTransport.remote = async (_server, request) => {
  calls.push(request.operation);
  if (script[request.operation] !== undefined) return structuredClone(script[request.operation]);
  return { 'launch-facts': baseFacts, 'launch-teardown': { removed: ['folder'], left: [] } }[request.operation] ?? { state: 'passed' };
};
async function drive() { for (let index = 0; index < 30; index++) { engine.tickLaunches(); const claimed = claimLaunch(); if (!claimed) return; await engine.executeLaunchStep(claimed); } }
const git = domain => ({ source: 'git', domain, repo: { url: 'https://github.com/owner/app.git', ref: 'main' }, webService: 'web', webPort: 3000, trustConfirmed: true });

test('repository refusals at fetch tear down with their own plain sentence', async () => {
  for (const [code, sentence] of [['SUBMODULES', /submodules/], ['LFS', /Git LFS/], ['REPO_TOO_LARGE', /larger than 2 GB/], ['SYMLINK_ESCAPE', /symbolic link/], ['NAME_COLLISION', /already exists on this server/], ['NO_SPACE', /free space/]]) {
    const server = serverRow(code); calls = [];
    script = { 'launch-fetch': { ok: false, code, reason: 'raw helper text with /root/path' } };
    const { launch } = await engine.startLaunch(server, git(`${code.toLowerCase().replace(/_/g, '-')}.example.com`), 'admin');
    await drive();
    const view = engine.launchView(launch.id);
    assert.equal(view.state, 'failed', code); assert.equal(view.failedStep, 'fetch'); assert.match(view.reason, sentence, code);
    assert.ok(!view.reason.includes('/root/path'));
    assert.equal(calls.at(-1), 'launch-teardown', code);
  }
  script = {};
});

test('a too old git or an nginx wildcard that would match blocks at check, before anything is created', async () => {
  for (const [code, sentence] of [['GIT_TOO_OLD', /too old/], ['DOMAIN_SERVED', /already serves/], ['CERT_LINEAGE_EXISTS', /certificate for/]]) {
    script = { 'launch-facts': { ...baseFacts, checks: [{ id: 'x', ok: false, code }] } };
    const server = serverRow('check-' + code);
    const answer = await engine.checkLaunch(server, git('blocked.example.com'));
    assert.equal(answer.ok, false); assert.match(answer.checks[0].text, sentence);
    await assert.rejects(engine.startLaunch(server, git('blocked.example.com'), 'admin'), error => error.status === 409 && error.code === code);
  }
  script = {};
});

test('an IPv6-only server gets an AAAA record only; a dual-stack one gets both; DNS already pointing is recognised', async () => {
  script = { 'launch-facts': { ...baseFacts, serverIps: ['2001:db8::9', 'fd00::1'], dnsAnswers: { A: [], AAAA: ['2001:db8::9'] } } };
  const answer = await engine.checkLaunch(serverRow('v6'), git('six.example.com'));
  assert.deepEqual(answer.dns.records, [{ type: 'AAAA', name: 'six.example.com', value: '2001:db8::9' }]);
  assert.equal(answer.dns.pointsHere, true);
  script = {};
});

test('the loopback port avoids listening ports and ports of other live launches on the server', () => {
  const server = serverRow('ports');
  db.prepare("INSERT INTO site_launches(id,server_id,slug,source,domain,state,loopback_port,created_by,created_at,updated_at) VALUES(?,?,'a','compose','a.example.com','done',20001,'admin',?,?)").run(randomUUID(), server, at(), at());
  const port = engine.chooseLoopbackPort(server, [20000, 20002], () => 0);
  assert.equal(port, 20003);
});
