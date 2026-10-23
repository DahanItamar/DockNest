// Site move engine end to end against a fake helper: preview, start, every step through the worker, crash resume,
// cancel, rollback, the API role and re-auth rules and the guards on other site work. Real servers are covered only
// by the Linux integration test (scripts/integration-linux.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-moves-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const { claimJob, executeJob } = await import('../src/engine.js');
const moves = await import('../src/moves/engine.js');
const { dnsResolver } = await import('../src/moves/dns.js');
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
const at = () => new Date().toISOString();

function user(role, authenticatedAt = Date.now()) {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId, userId + '@example.invalid', 'fixture', 'fixture', '[]', at(), role, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), userId, 'csrf', Date.now() + 3600000, Date.now(), Date.now(), authenticatedAt);
  return (route, options = {}) => fetch(base + route, { ...options, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, 'x-csrf-token': 'csrf', 'Content-Type': 'application/json' } });
}
const admin = user('admin'), staleAdmin = user('admin', Date.now() - 3600000), operator = user('operator');
const post = (as, route, body = {}) => as(route, { method: 'POST', body: JSON.stringify(body) });

function serverRow(name, host) {
  const serverId = randomUUID();
  db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(serverId, name, host, 22, 'root', 'fixture', '0'.repeat(64), at());
  return serverId;
}
const oldServer = serverRow('old-srv', '203.0.113.7'), newServer = serverRow('new-srv', '198.51.100.9');
function siteRow(name) {
  const siteId = randomUUID();
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, oldServer, name, JSON.stringify({ containers: ['web'], domains: [name + '.example.com'], healthUrl: 'http://127.0.0.1:8080/health' }), at());
  return siteId;
}
function backupRow(siteId, seconds = 20) {
  const jobId = randomUUID(), started = new Date(Date.now() - seconds * 1000).toISOString();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,started_at,finished_at) VALUES(?,?,'backup','completed','completed',?,?,?)").run(jobId, siteId, started, started, at());
  db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), siteId, jobId, new Date(Date.now() - 3600000).toISOString(), join(directory, 'x.enc'), 1024, 'a'.repeat(64), '{}', 0, 1, at());
}

// The fake helper keeps per-move target state like remote/helper.py does (deploy-status, idempotent deploys).
const calls = [], deployed = new Map(), faults = {};
moves.moveTransport.wait = async () => {};
moves.moveTransport.upload = async () => ({ plaintextChecksum: 'f'.repeat(64) });
moves.moveTransport.remote = async (server, request, options = {}) => {
  calls.push({ server: server.name, operation: request.operation, mode: request.mode, request, options });
  if (faults[request.operation]) throw Object.assign(new Error(faults[request.operation]), { remoteReported: true });
  const state = deployed.get(request.moveId) ?? new Set();
  switch (request.operation) {
    case 'move-facts': return request.role === 'source'
      ? { addresses: ['203.0.113.7'], site: { kind: 'container', domains: request.config.domains, containerCount: 1, architecture: 'x86_64', ports: [{ container: 'web', hostIp: '127.0.0.1', hostPort: 8080, containerPort: 80, protocol: 'tcp' }], bindPaths: ['/srv/shop'], names: { containers: ['web'], volumes: [], networks: [] }, networks: [], running: ['cid-web'], nginxDirectives: ['client_max_body_size'], web: 8080, maintenanceReady: true, env: [{ key: 'API_URL', where: 'container web', kind: 'ip', masked: 'http://203.0.113.7:9000' }] } }
      : { uid: 0, architecture: 'x86_64', dockerVersion: '29.0.1', composeVersion: '2.29.1', freeBytes: 100 * 1024 ** 3, totalBytes: 200 * 1024 ** 3, stagingWritable: true, usedPorts: [22, 80, 8080], nginx: { installed: true, configOk: true, running: true, confDir: '/etc/nginx/conf.d', serverNames: [] }, webPortOwner: 'nginx', certbot: { installed: false, account: false }, addresses: ['198.51.100.9'], probe: { existingPaths: [], conflicts: {} } };
    case 'deploy-status': return { present: state.size > 0, deployed: [...state], finalized: false };
    case 'deploy-restore': state.add(request.mode); deployed.set(request.moveId, state); return { mode: request.mode, kind: 'docker', containers: ['web'], running: ['web'], ports: [{ container: 'web', from: 8080, to: 8081, containerPort: 80, protocol: 'tcp' }], paths: ['/srv/shop'], mailBlocked: request.mode === 'test' };
    case 'deploy-teardown': deployed.delete(request.moveId); return { removed: true };
    case 'move-test': return { containersHealthy: true, http: { port: request.http.port, status: 200, ok: true } };
    case 'move-certificate': return { status: 'needs-owner', reason: 'no-certbot' };
    case 'move-finalize-target': return { finalized: true };
    case 'move-retire-source': return { containers: [{ id: 'cid-web', name: 'web', restartPolicy: 'unless-stopped' }] };
    case 'move-resume-source': return { resumed: true, running: 1 };
    case 'move-stop-target': return { containers: [{ id: 'n1', name: 'web', restartPolicy: 'unless-stopped' }], maintenance: true };
    case 'move-unretire-source': return { started: 1, containers: [] };
    case 'move-remove-old': return { containers: 1, volumes: request.deleteData ? ['web-data'] : [], paths: [], dataKept: !request.deleteData };
    case 'move-lock-status': return { busy: faults.lockBusy === true };
    default: throw new Error('unexpected operation ' + request.operation);
  }
};
dnsResolver.resolve = async () => [{ A: ['198.51.100.9'], AAAA: [] }];

// Worker stand-in: ticks moves, runs claimed jobs, and completes backup jobs with a verified backup.
async function drive(rounds = 60) {
  for (let round = 0; round < rounds; round++) {
    moves.tickMoves();
    await new Promise(resolve => setImmediate(resolve));
    const job = claimJob();
    if (job?.type === 'site-move') await executeJob(job);
    else if (job) {
      db.prepare("UPDATE jobs SET status='completed',stage='completed',finished_at=? WHERE id=?").run(at(), job.id);
      db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), job.site_id, job.id, at(), join(directory, job.id + '.enc'), 2048, 'b'.repeat(64), '{}', 0, 1, at());
    }
  }
}
const engineState = moveId => db.prepare('SELECT state FROM site_moves WHERE id=?').get(moveId).state;
async function preview(siteId, options) { const response = await post(admin, '/moves', { siteId, targetServerId: newServer, ...(options ? { options } : {}) }); assert.equal(response.status, 201, await response.clone().text()); return response.json(); }
async function start(body) { const response = await post(admin, `/moves/${body.id}/start`, { preflightHash: body.preflightHash, ...(body.moveAnyway ? { moveAnyway: true } : {}) }); return response; }

test('a site moves end to end: fresh backup, loopback test, final copy, DNS wait, finalize; the source changes only at the final copy', async () => {
  const siteId = siteRow('shop'); backupRow(siteId);
  const draft = await preview(siteId);
  assert.equal(draft.ok, true); assert.equal(draft.needsMoveAnyway, false); assert.equal(draft.undoDays, 7);
  assert.match(draft.sentence, /^shop is ready to move to new-srv\. It stays online while the copy is tested; expected downtime is about .+, then until your DNS change is live\.$/);
  assert.deepEqual(draft.advanced.ports, [{ from: 8080, to: 8081, containerPort: 80, protocol: 'tcp', hostIp: '127.0.0.1', changed: true }]);
  assert.deepEqual(draft.advanced.envKeys, [{ key: 'API_URL', where: 'container web', kind: 'ip', masked: 'http://203.0.113.7:9000', rewrite: false }]);
  assert.deepEqual(draft.advanced.nginx.notCopied, ['client_max_body_size']);
  assert.deepEqual(draft.advanced.dns.record, { type: 'A', name: 'shop.example.com', value: '198.51.100.9' });
  const started = await start(draft); assert.equal(started.status, 202);
  assert.equal((await started.json()).state, 'queued');
  calls.length = 0;
  await drive();
  assert.equal(engineState(draft.id), 'completed');
  assert.equal(db.prepare('SELECT server_id FROM sites WHERE id=?').get(siteId).server_id, newServer, 'the site record moved');
  const view = await (await admin('/moves/' + draft.id)).json();
  assert.equal(view.state, 'done'); assert.equal(view.progress, 100); assert.equal(view.cancelable, false);
  assert.deepEqual(view.dns, { type: 'A', name: 'shop.example.com', value: '198.51.100.9' });
  assert.match(view.statusLine, /^Done\. shop now runs on new-srv\. The old copy on old-srv is kept, stopped, until \d{4}-\d{2}-\d{2}\.$/);
  assert.deepEqual(view.steps.map(step => [step.step, step.state]), [['preflight', 'done'], ['backup', 'done'], ['deploy_test', 'done'], ['test', 'done'], ['await_switch', 'done'], ['final_sync', 'done'], ['deploy_final', 'done'], ['switch_dns', 'done'], ['verify_dns', 'done'], ['certificate', 'done'], ['finalize', 'done']]);
  const deploys = calls.filter(call => call.operation === 'deploy-restore');
  assert.deepEqual(deploys.map(call => call.mode), ['test', 'live']);
  assert.deepEqual(deploys[0].request.portMap.map(entry => [entry.from, entry.to]), [[8080, 8081]]);
  assert.equal(deploys[0].request.nginx, undefined, 'the test copy is never routed by nginx');
  assert.equal(deploys[1].request.nginx.upstreamPort, 8081); assert.equal(deploys[0].request.envRewrite, undefined, 'settings rewrite is off by default');
  assert.equal(calls.find(call => call.operation === 'move-test').request.http.port, 8081);
  // Before the final copy only read-only facts were requested from the old server.
  const firstSourceChange = calls.findIndex(call => call.server === 'old-srv' && call.operation !== 'move-facts');
  assert.ok(calls.findIndex(call => call.mode === 'live') < firstSourceChange || firstSourceChange === -1 || calls[firstSourceChange].operation === 'move-retire-source');
  const finalJob = db.prepare("SELECT details FROM jobs WHERE type='backup' AND json_extract(details,'$.keepStopped')=1 AND site_id=?").get(siteId);
  assert.ok(finalJob, 'the final copy keeps the source stopped behind its maintenance page');
  assert.ok(db.prepare("SELECT 1 FROM jobs WHERE type='backup' AND json_extract(details,'$.moveId')=? AND json_extract(details,'$.keepStopped')=0").get(draft.id), 'the move takes its own fresh backup instead of reusing an older one');
  assert.equal(calls.filter(call => call.operation === 'deploy-teardown').length, 1, 'the rehearsal is removed before the live deploy');
  // After the move: the site's own record and backups are on the new server; the move is listed until cleanup.
  assert.ok((await (await admin('/moves')).json()).moves.some(move => move.id === draft.id));
});

test('a crash during the copy resumes from the journal: an unfinished deploy is undone and run again', async () => {
  const siteId = siteRow('crash'); backupRow(siteId);
  const draft = await preview(siteId, { askBeforeSwitch: true });
  assert.equal((await start(draft)).status, 202);
  // Run until the test copy is being deployed, then "kill" the worker: the step stays running, its job is failed.
  for (let round = 0; round < 20; round++) {
    moves.tickMoves();
    const job = claimJob();
    if (!job) continue;
    if (job.type !== 'site-move') { db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(job.id); db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), siteId, job.id, at(), 'p', 1, 'c'.repeat(64), '{}', 0, 1, at()); continue; }
    const step = db.prepare("SELECT step FROM site_move_steps WHERE move_id=? AND state='pending' ORDER BY rowid").all(draft.id).map(row => row.step)[0];
    if (step === 'deploy_test') {
      db.prepare("UPDATE site_move_steps SET state='running',attempt=1,started_at=? WHERE move_id=? AND step='deploy_test'").run(at(), draft.id);
      deployed.set(draft.id, new Set()); // something was created, the deploy never finished
      db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(job.id); // what src/worker.js does on restart
      break;
    }
    await executeJob(job);
  }
  calls.length = 0;
  await drive(30);
  assert.equal(calls[0].operation, 'deploy-status');
  assert.ok(calls.findIndex(call => call.operation === 'deploy-teardown') < calls.findIndex(call => call.operation === 'deploy-restore'), 'undo before the re-run');
  assert.equal(engineState(draft.id), 'waiting');
  const view = await (await admin('/moves/' + draft.id)).json();
  assert.equal(view.state, 'waiting_switch'); assert.equal(view.steps.find(step => step.step === 'deploy_test').state, 'done');
  // Cancel before the switch: the copy is removed and the site stays where it was.
  const cancelled = await post(admin, `/moves/${draft.id}/cancel`); assert.equal(cancelled.status, 200);
  calls.length = 0; await drive(20);
  assert.equal(engineState(draft.id), 'cancelled');
  assert.ok(calls.some(call => call.operation === 'deploy-teardown' && call.server === 'new-srv'));
  assert.ok(!calls.some(call => call.server === 'old-srv' && call.operation !== 'move-facts'), 'cancelling before the final copy never touches the old server');
  assert.equal(db.prepare('SELECT server_id FROM sites WHERE id=?').get(siteId).server_id, oldServer);
  assert.match((await (await admin('/moves/' + draft.id)).json()).statusLine, /^Cancelled\. crash stays on old-srv\.$/);
});

test('a failed test rolls the move back with the reason; a failed final copy restarts the old site', async () => {
  const siteId = siteRow('broken'); backupRow(siteId);
  const draft = await preview(siteId); assert.equal((await start(draft)).status, 202);
  faults['move-test'] = 'The copy did not answer for broken.example.com (HTTP 502).';
  await drive(30); delete faults['move-test'];
  assert.equal(engineState(draft.id), 'rolled_back');
  const view = await (await admin('/moves/' + draft.id)).json();
  assert.equal(view.state, 'rolled_back'); assert.match(view.statusLine, /HTTP 502/);
  assert.equal(view.steps.find(step => step.step === 'deploy_test').state, 'undone');

  const second = siteRow('stops'); backupRow(second);
  const move = await preview(second); assert.equal((await start(move)).status, 202);
  faults['deploy-restore'] = 'nginx on this server did not serve the moved site';
  let failedOnce = false;
  const original = moves.moveTransport.remote;
  moves.moveTransport.remote = async (server, request) => { if (request.operation === 'deploy-restore' && request.mode === 'test') { const saved = faults['deploy-restore']; delete faults['deploy-restore']; try { return await original(server, request); } finally { faults['deploy-restore'] = saved; } } if (request.operation === 'deploy-restore') failedOnce = true; return original(server, request); };
  calls.length = 0; await drive(40); moves.moveTransport.remote = original; delete faults['deploy-restore'];
  assert.ok(failedOnce);
  assert.equal(engineState(move.id), 'rolled_back');
  const resume = calls.find(call => call.operation === 'move-resume-source');
  assert.ok(resume, 'the old site is started again'); assert.deepEqual(resume.request.running, ['cid-web']);
  assert.equal(db.prepare('SELECT server_id FROM sites WHERE id=?').get(second).server_id, oldServer);
});

test('long downtime needs Move anyway; Cloudflare is not offered yet; a changed preview is refused', async () => {
  const siteId = siteRow('large'); backupRow(siteId, 3000);
  const draft = await preview(siteId);
  assert.equal(draft.ok, true); assert.equal(draft.needsMoveAnyway, true);
  assert.ok(draft.warnings.some(item => item.requiresConfirmation && /Move anyway/.test(item.text)));
  const refused = await start(draft); assert.equal(refused.status, 409); assert.equal((await refused.json()).code, 'MOVE_ANYWAY_REQUIRED');
  const wrongHash = await post(admin, `/moves/${draft.id}/start`, { preflightHash: '0'.repeat(64), moveAnyway: true });
  assert.equal(wrongHash.status, 409); assert.equal((await wrongHash.json()).code, 'PREFLIGHT_CHANGED');
  assert.equal((await start({ ...draft, moveAnyway: true })).status, 202);
  const cloudflare = await post(admin, '/moves', { siteId: siteRow('cf'), targetServerId: newServer, options: { dnsMode: 'cloudflare' } });
  assert.equal(cloudflare.status, 400); assert.match((await cloudflare.json()).error, /Connect Cloudflare in Settings first/);
  await post(admin, `/moves/${draft.id}/cancel`); await drive(20);
});

test('only administrators manage moves; starting needs a recent re-verification; a moving site refuses other work', async () => {
  const siteId = siteRow('guarded'); backupRow(siteId);
  assert.equal((await post(operator, '/moves', { siteId, targetServerId: newServer })).status, 403);
  assert.equal((await operator('/moves')).status, 403);
  const draft = await preview(siteId);
  assert.equal((await operator('/moves/' + draft.id)).status, 403);
  assert.equal((await post(operator, `/moves/${draft.id}/cancel`)).status, 403);
  const stale = await post(staleAdmin, `/moves/${draft.id}/start`, { preflightHash: draft.preflightHash });
  assert.equal(stale.status, 403); assert.equal((await stale.json()).code, 'REAUTH_REQUIRED');
  assert.equal((await post(admin, '/sites/' + siteId + '/backup')).status, 202, 'a draft blocks nothing');
  db.prepare("UPDATE jobs SET status='completed' WHERE site_id=? AND status='queued'").run(siteId);
  assert.equal((await start(draft)).status, 202);
  const backup = await post(admin, '/sites/' + siteId + '/backup'); assert.equal(backup.status, 409); assert.match((await backup.json()).error, /being moved/);
  assert.equal((await admin('/sites/' + siteId, { method: 'DELETE' })).status, 409);
  assert.equal((await post(admin, '/moves', { siteId, targetServerId: newServer })).status, 409, 'one move per site');
  const same = await post(admin, '/moves', { siteId: siteRow('same'), targetServerId: oldServer });
  const body = await same.json(); assert.equal(body.ok, false); assert.equal(body.id, null); assert.equal(body.sentence, 'This site is already on old-srv.');
  assert.equal((await post(admin, `/moves/${draft.id}/start`, { preflightHash: draft.preflightHash })).status, 409, 'already started');
  await post(admin, `/moves/${draft.id}/cancel`); await drive(20);
  assert.equal(engineState(draft.id), 'cancelled');
});

test('Start accepts a preview whose volatile facts changed, and refuses one whose decisions changed', async () => {
  const original = moves.moveTransport.remote;
  const vary = change => { moves.moveTransport.remote = async (server, request) => { const result = await original(server, request); if (request.operation === 'move-facts' && request.role !== 'source') change(result); return result; }; };
  const siteId = siteRow('volatile'); backupRow(siteId);
  const draft = await preview(siteId);
  vary(result => { result.freeBytes -= 3 * 1024 ** 2; result.usedPorts.push(41234); result.addresses.reverse(); });
  dnsResolver.resolve = async () => [];
  try {
    const started = await start(draft); assert.equal(started.status, 202, await started.clone().text());
  } finally { moves.moveTransport.remote = original; dnsResolver.resolve = async () => [{ A: ['198.51.100.9'], AAAA: [] }]; }
  await post(admin, `/moves/${draft.id}/cancel`); await drive(20);

  for (const [name, change] of [['port-taken', null], ['disk-full', result => { result.freeBytes = 1024 ** 3; }]]) {
    const id = siteRow(name); backupRow(id);
    const reviewed = await preview(id);
    const effect = change ?? (result => result.usedPorts.push(reviewed.advanced.ports[0].to));
    vary(effect);
    try {
      const refused = await start(reviewed); assert.equal(refused.status, 409);
      const body = await refused.json(); assert.equal(body.code, 'PREFLIGHT_CHANGED', name); assert.ok(body.preview, 'the fresh preview comes back');
    } finally { moves.moveTransport.remote = original; }
  }
});

async function finishedMove(name, options) {
  const siteId = siteRow(name); backupRow(siteId);
  const draft = await preview(siteId, options);
  assert.equal((await start(draft)).status, 202);
  await drive();
  assert.equal(engineState(draft.id), 'completed');
  return { siteId, moveId: draft.id };
}

test('the certificate step gives the owner the exact command when the new server has no certbot account', async () => {
  const original = moves.moveTransport.remote;
  moves.moveTransport.remote = async (server, request) => request.operation === 'move-certificate' ? { status: 'needs-owner', reason: 'no-certbot', command: 'certbot --nginx --cert-name docknest-x -d cert.example.com' } : original(server, request);
  try {
    const { moveId } = await finishedMove('cert');
    const step = (await (await admin('/moves/' + moveId)).json()).steps.find(item => item.step === 'certificate');
    assert.equal(step.state, 'done'); assert.equal(step.result.command, 'certbot --nginx --cert-name docknest-x -d cert.example.com');
  } finally { moves.moveTransport.remote = original; }
});

test('switch back within the 7 days: the new copy stops, the old copy starts, the site record returns', async () => {
  const { siteId, moveId } = await finishedMove('back');
  const view = await (await admin('/moves/' + moveId)).json();
  assert.deepEqual([view.actions.switchBack, view.actions.removeOldCopy, view.actions.askRemoveOldCopy], [true, true, false]);
  assert.equal((await post(staleAdmin, `/moves/${moveId}/switch-back`)).status, 403);
  assert.equal((await post(operator, `/moves/${moveId}/switch-back`)).status, 403);
  const started = await post(admin, `/moves/${moveId}/switch-back`); assert.equal(started.status, 202);
  assert.equal((await started.json()).state, 'switching_back');
  calls.length = 0; await drive(20);
  assert.equal(engineState(moveId), 'switched_back');
  assert.deepEqual(calls.filter(call => call.operation.startsWith('move-')).map(call => [call.server, call.operation]), [['new-srv', 'move-stop-target'], ['old-srv', 'move-unretire-source']]);
  assert.ok(!calls.some(call => ['deploy-teardown', 'move-remove-old'].includes(call.operation)), 'switching back deletes nothing');
  assert.equal(db.prepare('SELECT server_id FROM sites WHERE id=?').get(siteId).server_id, oldServer);
  const back = await (await admin('/moves/' + moveId)).json();
  assert.equal(back.state, 'switched_back'); assert.deepEqual(back.dns, { type: 'A', name: 'back.example.com', value: '203.0.113.7' });
  assert.match(back.statusLine, /Change the DNS record back: A back\.example\.com -> 203\.0\.113\.7/);
  assert.equal((await post(admin, `/moves/${moveId}/switch-back`)).status, 409);
});

test('the old copy is never removed by itself; removal needs the site name and keeps data unless asked', async () => {
  const { moveId } = await finishedMove('cleanup');
  db.prepare('UPDATE site_moves SET retain_until=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), moveId);
  calls.length = 0; await drive(5);
  assert.equal(engineState(moveId), 'retention_expired'); assert.ok(!calls.some(call => call.operation === 'move-remove-old'), 'nothing is removed automatically');
  assert.equal((await (await admin('/moves/' + moveId)).json()).actions.askRemoveOldCopy, true);
  assert.equal((await post(admin, `/moves/${moveId}/remove-old-copy`, { confirmation: 'wrong' })).status, 409);
  assert.equal((await post(staleAdmin, `/moves/${moveId}/remove-old-copy`, { confirmation: 'cleanup' })).status, 403);
  assert.equal((await post(admin, `/moves/${moveId}/remove-old-copy`, { confirmation: 'cleanup' })).status, 202);
  await drive(5);
  const removal = calls.find(call => call.operation === 'move-remove-old');
  assert.equal(removal.server, 'old-srv'); assert.equal(removal.request.deleteData, false);
  const view = await (await admin('/moves/' + moveId)).json();
  assert.equal(view.engineState, 'cleaned'); assert.match(view.statusLine, /its data folders were kept/);
  const other = await finishedMove('cleanup-data');
  assert.equal((await post(admin, `/moves/${other.moveId}/remove-old-copy`, { confirmation: 'cleanup-data', deleteData: true })).status, 202);
  calls.length = 0; await drive(5);
  assert.equal(calls.find(call => call.operation === 'move-remove-old').request.deleteData, true);
  assert.equal(engineState(other.moveId), 'cleaned');
});

test('a server step past its time limit stops waiting and asks the owner; Try again resumes it', async () => {
  const siteId = siteRow('slow'); backupRow(siteId);
  const draft = await preview(siteId); assert.equal((await start(draft)).status, 202);
  const original = moves.moveTransport.remote;
  let hang = true, aborted = false, stdinOpen = false;
  moves.moveTransport.remote = (server, request, options) => {
    if (request.operation !== 'move-test' || !hang) return original(server, request, options);
    stdinOpen = options.keepStdinOpen === true && request.watchStdin === true;
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('stopped'), { aborted: true })); }));
  };
  moves.moveLimits.scale = 0.0005; // 300 s test limit (at least 120 s) -> well under a second
  try { await drive(30); } finally { moves.moveLimits.scale = 1; }
  assert.equal(engineState(draft.id), 'recovery_required');
  assert.ok(aborted, 'the server-side step is stopped, not just abandoned'); assert.ok(stdinOpen, 'the helper watches stdin to stop itself');
  const view = await (await admin('/moves/' + draft.id)).json();
  assert.equal(view.state, 'needs_attention'); assert.match(view.statusLine, /^Test the copy took longer than 1 minutes, so DockNest stopped it\. Check new-srv, then choose Try again or Undo\.$/);
  assert.deepEqual(view.actions.resolve, ['retry', 'undo']);
  assert.equal((await post(staleAdmin, `/moves/${draft.id}/resolve`, { action: 'retry' })).status, 403, 'resolving needs a recent re-verification');
  faults.lockBusy = true;
  const busy = await post(admin, `/moves/${draft.id}/resolve`, { action: 'retry' });
  faults.lockBusy = false;
  assert.equal(busy.status, 409, 'no Try again while the server still runs the step');
  hang = false;
  assert.equal((await post(admin, `/moves/${draft.id}/resolve`, { action: 'retry' })).status, 200);
  await drive(); moves.moveTransport.remote = original;
  assert.equal(engineState(draft.id), 'completed');
});

test('Cloudflare: the token is checked with read calls, sealed, never returned, and switches and reverts the A record', async () => {
  const { cloudflareHttp } = await import('../src/moves/cloudflare.js');
  const token = 'cf_' + 'a'.repeat(40), zone = 'f'.repeat(32), requests = [];
  let content = '203.0.113.7';
  const journaledFirst = [];
  cloudflareHttp.fetch = async (url, init) => {
    requests.push({ url, method: init.method, auth: init.headers.Authorization === 'Bearer ' + token, body: init.body });
    const ok = result => ({ ok: true, status: 200, json: async () => ({ success: true, result }) });
    if (url.endsWith('/user/tokens/verify')) return ok({ status: 'active' });
    if (url.includes('/zones?')) return ok([{ id: zone, name: 'example.com' }]);
    if (url.includes('/dns_records?')) return ok([{ id: 'r'.repeat(32), type: 'A', name: 'cf.example.com', content, proxied: true, ttl: 1 }]);
    if (init.method === 'PATCH') {
      const running = db.prepare("SELECT resources FROM site_move_steps WHERE step='switch_dns' AND state='running'").get();
      if (running) journaledFirst.push(JSON.parse(running.resources).records?.[0]?.previous === '203.0.113.7');
      content = JSON.parse(init.body).content; return ok({});
    }
    return { ok: false, status: 404, json: async () => ({ success: false }) };
  };
  assert.equal((await admin('/settings/cloudflare-dns')).status, 200);
  assert.equal((await staleAdmin('/settings/cloudflare-dns', { method: 'PUT', body: JSON.stringify({ token }) })).status, 403);
  assert.equal((await operator('/settings/cloudflare-dns')).status, 403);
  const saved = await admin('/settings/cloudflare-dns', { method: 'PUT', body: JSON.stringify({ token }) });
  const savedText = await saved.text();
  assert.equal(saved.status, 200, savedText); assert.ok(!savedText.includes(token), 'the token is never returned');
  assert.deepEqual(JSON.parse(savedText).zones, ['example.com']);
  assert.ok(requests.every(request => request.auth && request.method === 'GET'), 'connecting only reads');
  const stored = db.prepare("SELECT value FROM settings WHERE key='cloudflare_dns'").get().value;
  assert.ok(!stored.includes(token), 'sealed with the master key');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit_events').all()).includes(token));
  const { siteId, moveId } = await finishedMove('cf', { dnsMode: 'cloudflare' });
  assert.equal(content, '198.51.100.9', 'the A record points at the new server');
  assert.deepEqual(journaledFirst, [true], 'the previous record is journaled before Cloudflare is changed');
  const { switchRecord } = await import('../src/moves/cloudflare.js');
  const journalRow = db.prepare("SELECT resources FROM site_move_steps WHERE move_id=? AND step='switch_dns'").get(moveId);
  const kept = JSON.parse(journalRow.resources).records, rejournal = [];
  assert.deepEqual(await switchRecord('cf.example.com', { ipv4: '198.51.100.9' }, { existing: kept, onJournal: j => rejournal.push(j) }), kept, 'a resumed switch reuses the journal');
  assert.deepEqual(rejournal, [], 'and never records the new value as the previous one');
  await assert.rejects(switchRecord('cf.example.com', { ipv4: '198.51.100.9' }, {}), /no record of its previous value/);
  const steps = (await (await admin('/moves/' + moveId)).json()).steps.map(step => step.step);
  assert.ok(!steps.includes('await_switch'), 'no manual switch gate');
  assert.ok(!JSON.stringify(db.prepare('SELECT resources,result FROM site_move_steps WHERE move_id=?').all(moveId)).includes(token));
  assert.equal((await post(admin, `/moves/${moveId}/switch-back`)).status, 202); await drive(20);
  assert.equal(content, '203.0.113.7', 'switch back restores the previous record');
  assert.equal(db.prepare('SELECT server_id FROM sites WHERE id=?').get(siteId).server_id, oldServer);
  assert.equal((await admin('/settings/cloudflare-dns', { method: 'DELETE' })).status, 200);
  assert.equal((await (await admin('/settings/cloudflare-dns')).json()).configured, false);
});

test('a failure after the DNS switch never undoes the move: no teardown, no restart of the old site, the owner decides', async () => {
  const siteId = siteRow('afterswitch'); backupRow(siteId);
  const draft = await preview(siteId); assert.equal((await start(draft)).status, 202);
  faults['move-certificate'] = 'certbot crashed';
  calls.length = 0; await drive(40); delete faults['move-certificate'];
  assert.equal(engineState(draft.id), 'recovery_required');
  const live = calls.findIndex(call => call.operation === 'deploy-restore' && call.mode === 'live');
  assert.ok(live > 0 && !calls.slice(live).some(call => ['deploy-teardown', 'move-resume-source'].includes(call.operation)), 'after the live deploy nothing is torn down and the old site is not restarted');
  const view = await (await admin('/moves/' + draft.id)).json();
  assert.match(view.statusLine, /certbot crashed The site already runs on new-srv, so DockNest did not undo anything\. Press Try again, or Switch back\.$/);
  assert.deepEqual(view.actions.resolve, ['retry']); assert.equal(view.actions.switchBack, true);
  assert.equal((await post(admin, `/moves/${draft.id}/resolve`, { action: 'undo' })).status, 409);
  // Switch back before finalize: the old copy was only stopped, so it is resumed (not un-retired).
  calls.length = 0;
  assert.equal((await post(admin, `/moves/${draft.id}/switch-back`)).status, 202); await drive(20);
  assert.equal(engineState(draft.id), 'switched_back');
  assert.ok(calls.some(call => call.operation === 'move-resume-source') && !calls.some(call => call.operation === 'move-unretire-source'));
  assert.equal(db.prepare('SELECT server_id FROM sites WHERE id=?').get(siteId).server_id, oldServer);
});

test('DNS wait: a Cloudflare proxy is explained and confirmed by the owner, Cancel and go back works, and the wait has a limit', async () => {
  const siteId = siteRow('proxied'); backupRow(siteId);
  const draft = await preview(siteId, { askBeforeSwitch: false });
  assert.equal((await start(draft)).status, 202);
  dnsResolver.resolve = async () => [{ A: ['104.16.1.1'], AAAA: [] }];
  try {
    await drive(40); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(engineState(draft.id), 'waiting');
    assert.equal((await post(staleAdmin, `/moves/${draft.id}/continue`, { gate: 'dns' })).status, 403);
    const refused = await post(admin, `/moves/${draft.id}/continue`, { gate: 'dns' });
    assert.equal(refused.status, 409); const body = await refused.json();
    assert.equal(body.code, 'DNS_PROXIED'); assert.match(body.error, /behind Cloudflare's proxy \(orange cloud\)/);
    assert.equal((await (await admin('/moves/' + draft.id)).json()).actions.dnsProxied, true);
    assert.equal((await post(admin, `/moves/${draft.id}/continue`, { gate: 'dns', confirmed: true })).status, 200);
    await drive(20); assert.equal(engineState(draft.id), 'completed');
  } finally { dnsResolver.resolve = async () => [{ A: ['198.51.100.9'], AAAA: [] }]; }

  const other = siteRow('goback'); backupRow(other);
  const move = await preview(other); assert.equal((await start(move)).status, 202);
  dnsResolver.resolve = async () => [{ A: ['203.0.113.7'], AAAA: [] }];
  try {
    await drive(40);
    assert.equal((await (await admin('/moves/' + move.id)).json()).state, 'waiting_dns');
    db.prepare("UPDATE site_move_steps SET result=json_set(result,'$.waitingSince',?) WHERE move_id=? AND step='verify_dns'").run(new Date(Date.now() - (moves.DNS_WAIT_HOURS + 1) * 3600000).toISOString(), move.id);
    await drive(2);
    const limited = await (await admin('/moves/' + move.id)).json();
    assert.equal(limited.state, 'needs_attention'); assert.match(limited.statusLine, /still does not point to new-srv after 48 hours/); assert.equal(limited.actions.switchBack, true);
    assert.equal((await post(admin, `/moves/${move.id}/switch-back`)).status, 202, 'Cancel and go back');
    calls.length = 0; await drive(20);
    assert.equal(engineState(move.id), 'switched_back');
    const operations = calls.map(call => call.operation);
    assert.ok(operations.includes('move-stop-target') && operations.includes('move-resume-source') && !operations.includes('move-unretire-source') && !operations.includes('deploy-teardown'), operations.join());
    assert.equal(db.prepare('SELECT server_id FROM sites WHERE id=?').get(other).server_id, oldServer);
  } finally { dnsResolver.resolve = async () => [{ A: ['198.51.100.9'], AAAA: [] }]; }
});

test('a release without moves never claims or recovers move jobs (rollback safety)', () => {
  const statuses = db.prepare("SELECT DISTINCT status FROM jobs WHERE type='site-move'").all().map(row => row.status);
  assert.ok(statuses.length > 0);
  assert.ok(statuses.every(status => !['queued', 'running', 'recovery_required'].includes(status)), statuses.join());
  // 2.5.0 claimed with status='queued' and recovered status='running' on start.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='site-move' AND status IN ('queued','running')").get().n, 0);
});

test('a site-move job keeps both of its servers busy', () => {
  const siteId = siteRow('exclusive'), other = randomUUID();
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(other, newServer, 'other', '{}', at());
  const running = randomUUID(), queued = randomUUID();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','running','copying',?)").run(running, other, at());
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,'site-move','move_queued','queued',?,?)").run(queued, siteId, at(), JSON.stringify({ moveId: randomUUID(), sourceServerId: oldServer, targetServerId: newServer }));
  assert.equal(claimJob(), undefined, 'the target is busy with another site');
  db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(running);
  assert.equal(claimJob().id, queued);
  const blocked = randomUUID();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','queued','queued',?)").run(blocked, other, at());
  assert.equal(claimJob(), undefined, 'the move job holds the target as well as the source');
  db.prepare("UPDATE jobs SET status='completed' WHERE id IN (?,?)").run(queued, blocked);
});

test.after(() => listener.close());
