import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTransport, parseService, parseCurrent, parseStatus, TransportError } from '../src/updates/transport.js';
import { eligibility } from '../src/updates/eligibility.js';
import { createLimiter, lockExempt } from '../src/updates/lock.js';

const rid = '3f2b8c1e-5d4a-4e6b-9c7d-1a2b3c4d5e6f', at = '2026-10-22T10:00:00Z', later = '2026-10-22T10:00:05Z';
const service = (over = {}) => ({ schema: 1, version: '2.2.0', protocol: 1, actions: ['upgrade', 'check', 'evil'], installMode: 'image', env: { docker: '27.3', os: 'ubuntu', extra: 'x' }, blocked: false, blockedReason: null, consecutiveExit4: { 'v2.3.0': 1 }, heartbeatAt: at, requestId: rid, lastResult: null, ...over });

test('service.json is parsed through an allow-list: unknown fields, actions and env keys are dropped, bad values refused', () => {
  const parsed = parseService({ ...service(), secret: 'x' });
  assert.deepEqual(Object.keys(parsed).sort(), ['actions', 'blocked', 'blockedReason', 'consecutiveExit4', 'env', 'heartbeatAt', 'installMode', 'lastResult', 'protocol', 'requestId', 'version']);
  assert.deepEqual(parsed.actions, ['upgrade', 'check']); assert.deepEqual(parsed.env, { docker: '27.3', os: 'ubuntu' }); assert.deepEqual(parsed.consecutiveExit4, { 'v2.3.0': 1 });
  for (const bad of [null, [], 'x', { ...service(), schema: 2 }, { ...service(), version: 'x; rm' }, { ...service(), protocol: '1' }]) assert.equal(parseService(bad), null);
  const odd = parseService(service({ installMode: 'rm -rf', heartbeatAt: 'yesterday', requestId: 'nope', blocked: true, blockedReason: 'because', consecutiveExit4: { 'x y': 5, 'v1.0.0': -1, 'v1.0.1': 2 }, env: { docker: '1; rm -rf /' } }));
  assert.deepEqual({ mode: odd.installMode, beat: odd.heartbeatAt, id: odd.requestId, reason: odd.blockedReason, exit4: odd.consecutiveExit4, env: odd.env }, { mode: null, beat: null, id: null, reason: 'unknown', exit4: { 'v1.0.1': 2 }, env: {} });
  const last = parseService(service({ lastResult: { requestId: rid, exitCode: 4, refusal: 'made-up', reason: 'not-a-reason', finishedAt: at, extra: 1 } })).lastResult;
  assert.deepEqual(last, { requestId: rid, exitCode: 4, refusal: null, reason: 'unknown', finishedAt: at });
});

test('current.json keeps only fixed phases with parsable, non-decreasing times, at most 32, for one request', () => {
  const events = Array.from({ length: 40 }, () => ({ phase: 'build', at }));
  assert.equal(parseCurrent({ requestId: rid, target: 'v2.3.0', acceptedAt: at, events }).events.length, 32);
  const parsed = parseCurrent({ requestId: rid, target: 'v2.3.0', acceptedAt: at, truncated: 'yes', events: [{ phase: 'verify', at }, { phase: 'rm', at }, { phase: 'fetch', at: later }, { phase: 'idle', at }, { phase: 'build', at: 'soon' }, { phase: 'stop', at: later, text: 'leak' }] });
  assert.deepEqual(parsed.events, [{ phase: 'verify', at }, { phase: 'fetch', at: later }, { phase: 'stop', at: later }]); assert.equal(parsed.truncated, false);
  for (const bad of [null, { requestId: 'x', target: 'v2.3.0', acceptedAt: at, events: [] }, { requestId: rid, target: 'v2', acceptedAt: at, events: [] }, { requestId: rid, target: 'v2.3.0', acceptedAt: at }]) assert.equal(parseCurrent(bad), null);
});

test('status.json: known fields only, enums and regexes enforced, control characters removed, caps applied', () => {
  const base = { phase: 'build', requestId: rid, from: '2.1.0', to: 'v2.3.0', startedAt: at, updatedAt: later, ok: null, error: null, rollbackHint: 'a\u0007b‮c', warning: 'w'.repeat(2000), reason: 'weird', schemaFrom: 4, schemaTo: 5, extra: 1 };
  const parsed = parseStatus(base);
  assert.ok(!('extra' in parsed)); assert.equal(parsed.rollbackHint, 'abc'); assert.equal(parsed.warning.length, 1024); assert.equal(parsed.reason, 'unknown');
  assert.equal(parseStatus({ ...base, error: 'e'.repeat(9000) }).error.length, 4096);
  assert.equal(parseStatus({ ...base, cleanup: 'Cleaned up: 2 old DockNest images' }).cleanup, 'Cleaned up: 2 old DockNest images');
  assert.equal(parseStatus({ ...base, cleanup: 'c'.repeat(900) }).cleanup.length, 256); assert.equal(parseStatus({ ...base, cleanup: 3 }), null);
  for (const bad of [{ ...base, phase: 'rm' }, { ...base, requestId: 'x' }, { ...base, ok: 'true' }, { ...base, to: '$(id)' }, { ...base, updatedAt: 'now' }, { ...base, schemaTo: 1.5 }, { ...base, error: 5 }, null]) assert.equal(parseStatus(bad), null);
});

test('files are read with caps: oversize, symlinks and non-files are refused; missing and unreadable are absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'docknest-transport-')), status = join(dir, 'status');
  await mkdir(status);
  const transport = createTransport({ dir, socket: join(dir, 'none.sock') });
  assert.equal(await transport.readService(), null);
  await writeFile(join(status, 'service.json'), JSON.stringify(service())); assert.equal((await transport.readService()).version, '2.2.0');
  await writeFile(join(status, 'service.json'), JSON.stringify({ ...service(), pad: 'x'.repeat(20000) })); assert.equal(await transport.readService(), null);
  await writeFile(join(status, 'service.json'), '{not json'); assert.equal(await transport.readService(), null);
  await mkdir(join(status, 'current.json')); assert.equal(await transport.readCurrent(), null);
  if (process.platform !== 'win32') { await writeFile(join(dir, 'real.json'), JSON.stringify({ phase: 'done', requestId: rid })); await symlink(join(dir, 'real.json'), join(status, 'status.json')); assert.equal(await transport.readStatus(), null); }
  assert.equal(await transport.socketPresent(), false);
  assert.equal(await transport.runActive(), true, 'the shared kit guard fails closed on an unreadable current.json');
});

test('submitRequest sends exactly the upgrade fields and trusts only a well-formed answer for its own id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'docknest-transport-')), socket = process.platform === 'win32' ? `\\\\.\\pipe\\docknest-unit-${process.pid}` : join(dir, 's.sock');
  let reply = id => JSON.stringify({ accepted: true, id }), seen = [];
  const server = net.createServer({ allowHalfOpen: true }, connection => {
    const chunks = []; let done = false;
    connection.on('data', chunk => { chunks.push(chunk); let request; try { request = JSON.parse(Buffer.concat(chunks).toString()); } catch { return; } if (done) return; done = true; seen.push(request); const body = reply(request.id); if (body === null) return connection.destroy(); connection.end(body); });
    connection.on('error', () => {});
  });
  await new Promise(resolve => server.listen(socket, resolve));
  const transport = createTransport({ dir, socket }), request = { id: rid, version: 'v2.3.0', requestedBy: 'user-1', requestedAt: at };
  try {
    assert.deepEqual(await transport.submitRequest(request), { accepted: true, code: null });
    assert.deepEqual(seen[0], { schema: 1, id: rid, action: 'upgrade', version: 'v2.3.0', requestedBy: 'user-1', requestedAt: at });
    reply = () => JSON.stringify({ accepted: false, code: 'low-disk' }); assert.deepEqual(await transport.submitRequest(request), { accepted: false, code: 'low-disk' });
    for (const bad of [() => JSON.stringify({ accepted: false, code: 'rm -rf' }), () => JSON.stringify({ accepted: true, id: 'other' }), () => 'x'.repeat(2000), () => 'not json', () => JSON.stringify({ accepted: 'yes' })]) {
      reply = bad; await assert.rejects(transport.submitRequest(request), error => error instanceof TransportError && error.delivered === true && error.code === 'invalid-answer');
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
  if (process.platform !== 'win32') await assert.rejects(transport.submitRequest(request), error => error instanceof TransportError && error.delivered === false && error.code === 'unreachable');
});

test('eligibility follows the table: the first matching row wins', () => {
  const updater = { present: true, supported: true, blocked: false, blockedReason: null, consecutiveExit4: {} };
  const latest = { version: 'v2.3.0', releaseUrl: 'https://example.invalid/r' }, input = { base: 'update-available', current: '2.2.0', latest, updater };
  const state = over => eligibility({ ...input, ...over });
  assert.deepEqual([state({}).state, state({}).canStart, state({}).offer.update.version], ['update-available', true, 'v2.3.0']);
  assert.equal(state({ active: { state: 'running' } }).state, 'update-in-progress'); assert.equal(state({ active: { state: 'submitted' } }).offer.update, null);
  assert.equal(state({ active: { state: 'needs_action' } }).state, 'updater-blocked');
  assert.equal(state({ updater: { ...updater, blocked: true } }).state, 'updater-blocked');
  assert.match(state({ updater: { ...updater, consecutiveExit4: { 'v2.3.0': 2 } } }).offer.blocked.message, /failed twice/);
  assert.equal(state({ updater: { ...updater, consecutiveExit4: { 'v2.3.0': 1 } } }).state, 'update-available');
  assert.equal(state({ lastRequest: { state: 'refused', refusal: 'state-mismatch', from_version: '2.2.0' } }).state, 'updater-state-mismatch');
  assert.equal(state({ lastRequest: { state: 'refused', refusal: 'state-mismatch', from_version: '2.1.0' } }).state, 'update-available', 'a changed installed version clears it');
  assert.equal(state({ hold: true }).canStart, false); assert.equal(state({ hold: true }).offer.blocked.code, 'UPDATE_ON_HOLD'); assert.equal(state({ hold: true }).offer.update.version, 'v2.3.0');
  assert.equal(state({ hold: true, recoveryPending: true }).offer.blocked.code, 'RECOVERY_REVIEW_REQUIRED');
  for (const base of ['consent-pending', 'checks-off']) assert.deepEqual([state({ base }).state, state({ base }).offer.update], [base, null]);
  assert.equal(state({ base: 'check-failed', latest: null }).state, 'check-failed'); assert.equal(state({ base: 'check-failed' }).offer.update.version, 'v2.3.0');
  assert.equal(state({ latest: { version: 'v2.2.0' } }).state, 'up-to-date'); assert.equal(state({ latest: { version: 'v2.1.0' } }).offer.update, null);
  assert.deepEqual([state({ minUpgradeFrom: '2.2.5' }).state, state({ minUpgradeFrom: '2.2.5' }).offer.cli.reason, state({ minUpgradeFrom: '2.2.5' }).offer.update], ['update-available', 'min-upgrade-from', null]);
  assert.equal(state({ minUpgradeFrom: '2.2.0' }).canStart, true);
  assert.equal(state({ updater: { ...updater, present: false } }).state, 'updater-not-installed'); assert.equal(state({ updater: { ...updater, present: false } }).offer.cli.command, 'scripts/upgrade.sh');
  assert.equal(state({ updater: { ...updater, supported: false } }).offer.cli.reason, 'updater-outdated');
  assert.equal(state({ current: 'not-a-version' }).offer.update, null, 'an unparsable running version offers nothing');
});

test('the lock exempts exactly the listed method and path pairs', () => {
  const exempt = [['GET', '/api/version'], ['GET', '/api/updates/progress'], ['GET', '/api/updates'], ['GET', '/api/updates/status'], ['GET', '/api/auth/status'], ['POST', '/api/auth/logout'], ['POST', `/api/updates/requests/${rid}/acknowledge`]];
  for (const [method, path] of exempt) assert.equal(lockExempt(method, path), true, method + path);
  const locked = [['POST', '/api/updates'], ['GET', '/api/auth/logout'], ['GET', `/api/updates/requests/${rid}/acknowledge`], ['POST', '/api/updates/requests'], ['POST', '/api/updates/requests/x/acknowledge'], ['POST', `/api/updates/requests/${rid}/acknowledge/`], ['GET', '/api/Version'], ['GET', '/api/updates/history'], ['GET', '/api/auth/login'], ['POST', '/api/auth/login'], ['POST', '/api/auth/setup'], ['PUT', '/api/updates/status'], ['DELETE', '/api/version'], ['HEAD', '/api/version'], ['GET', '/healthz/../api/state'], ['POST', '/api/auth/status']];
  for (const [method, path] of locked) assert.equal(lockExempt(method, path), false, method + path);
});

test('the progress limiter is per key and per window, and its table is bounded', () => {
  let t = 0;
  const limit = createLimiter({ perMinute: 3, windowMs: 1000, clients: 4, now: () => t });
  assert.deepEqual([1, 2, 3].map(() => limit('a')), [0, 0, 0]); assert.ok(limit('a') > 0); assert.equal(limit('b'), 0);
  t = 1001; assert.equal(limit('a'), 0, 'a new window');
  for (const key of ['c', 'd', 'e', 'f', 'g', 'h']) limit(key);
  assert.equal(limit('i'), 0, 'a full table is cleared rather than growing or locking everyone out');
});

test('TRUST_PROXY is opt-in and exact; without it X-Forwarded-For never changes the limiter key, with it only a listed peer is believed', async () => {
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'docknest-trust-'));
  const { parseTrustProxy } = await import('../src/config.js'), { default: express } = await import('express'), { progressHandler } = await import('../src/updates/lock.js');
  assert.equal(parseTrustProxy(undefined), false); assert.equal(parseTrustProxy('  '), false);
  assert.deepEqual(parseTrustProxy('127.0.0.1, 10.0.0.0/8,::1,fd00::/8'), ['127.0.0.1', '10.0.0.0/8', '::1', 'fd00::/8']);
  for (const bad of ['true', '1', 'loopback', 'uniquelocal', 'caddy', '10.0.0.0/33', '10.0.0.1/8/8', '::1/129', '10.0.0.1,', '0.0.0.0/x']) assert.throws(() => parseTrustProxy(bad), /TRUST_PROXY/, bad);
  const keys = [];
  const run = async trust => {
    keys.length = 0;
    const app = express(); app.set('trust proxy', trust);
    app.get('/p', progressHandler({ progress: () => ({ active: false, phase: null, to: null, state: null, stale: false, updatedAt: null, events: [] }) }, key => { keys.push(key); return 0; }));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    try { await fetch(`http://127.0.0.1:${server.address().port}/p`, { headers: { 'X-Forwarded-For': '203.0.113.9' } }); } finally { server.close(); }
    return keys[0];
  };
  assert.match(await run(parseTrustProxy(undefined)), /127\.0\.0\.1$/, 'no TRUST_PROXY: the socket peer is the key');
  assert.match(await run(parseTrustProxy('10.9.9.9')), /127\.0\.0\.1$/, 'a forwarded header from an unlisted peer is ignored');
  assert.equal(await run(parseTrustProxy('127.0.0.1')), '203.0.113.9', 'a listed peer: the forwarded address is used');
});

test('the progress limiter answers 429 with an accurate Retry-After message', async () => {
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'docknest-limit-'));
  const { default: express } = await import('express'), { progressHandler } = await import('../src/updates/lock.js');
  const app = express(); app.get('/p', progressHandler({ progress: () => ({}) }, () => 7));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/p`), body = await response.json();
    assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '7');
    assert.deepEqual(body, { error: 'Too many requests. Try again in 7 seconds.', code: 'RATE_LIMITED', retryAfter: 7 });
  } finally { server.close(); }
});
