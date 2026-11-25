// The global brake on guessing the system password, and the password length rule for NEW passwords only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-login-guard-'));
Object.assign(process.env, { DATA_DIR: join(directory, 'data'), BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { db } = await import('../src/db.js');
const { recordGlobalFailure, pauseRemainingMs, globalLoginGuard, GLOBAL_FAIL_LIMIT, WINDOW_MS, BASE_PAUSE_MS, MAX_PAUSE_MS, pauseMessage } = await import('../src/login-guard.js');
const { newPasswordSchema } = await import('../src/auth.js');

const reset = () => db.prepare("DELETE FROM rate_limits WHERE key LIKE 'global:%'").run();
const call = () => { const out = { headers: {} }; const res = { set: (name, value) => { out.headers[name] = value; }, status: code => { out.status = code; return { json: body => { out.body = body; } }; } }; let passed = false; globalLoginGuard({}, res, () => { passed = true; }); return { passed, ...out }; };

test('nineteen failures pause nothing; the twentieth starts a pause that grows and is capped', () => {
  reset(); const start = 1_000_000;
  for (let n = 1; n < GLOBAL_FAIL_LIMIT; n++) { recordGlobalFailure(start + n); assert.equal(pauseRemainingMs(start + n), 0, `failure ${n}`); }
  recordGlobalFailure(start + GLOBAL_FAIL_LIMIT);
  assert.equal(pauseRemainingMs(start + GLOBAL_FAIL_LIMIT), BASE_PAUSE_MS);
  let now = start + GLOBAL_FAIL_LIMIT + BASE_PAUSE_MS + 1; assert.equal(pauseRemainingMs(now), 0, 'the pause ends by itself');
  const seen = [];
  for (let n = 1; n <= 8; n++) { recordGlobalFailure(now); seen.push(pauseRemainingMs(now)); now += pauseRemainingMs(now) + 1; }
  assert.deepEqual(seen.slice(0, 4), [60_000, 120_000, 240_000, 480_000], 'doubling');
  assert.equal(seen[4], 0, 'by now the 15 minute window has ended, so counting starts again');
  assert.ok(seen.every(ms => ms <= MAX_PAUSE_MS), 'never longer than 15 minutes');
  reset(); const burst = 9_000_000;
  for (let n = 0; n < 60; n++) recordGlobalFailure(burst);
  assert.equal(pauseRemainingMs(burst), MAX_PAUSE_MS, 'a long guessing run is capped at 15 minutes');
});

test('the window ends by itself: nothing is permanent', () => {
  reset(); const start = 5_000_000;
  for (let n = 0; n < 40; n++) recordGlobalFailure(start + n);
  assert.ok(pauseRemainingMs(start + 40) > 0);
  const after = start + WINDOW_MS + MAX_PAUSE_MS + 1;
  assert.equal(pauseRemainingMs(after), 0);
  recordGlobalFailure(after);
  assert.equal(pauseRemainingMs(after), 0, 'a fresh window starts from one failure');
});

test('the guard answers 429 with Retry-After and a plain message during a pause, and passes otherwise', () => {
  reset();
  assert.equal(call().passed, true);
  const now = Date.now();
  for (let n = 0; n < GLOBAL_FAIL_LIMIT; n++) recordGlobalFailure(now);
  const blocked = call();
  assert.equal(blocked.passed, false); assert.equal(blocked.status, 429); assert.equal(blocked.body.code, 'SIGN_IN_PAUSED');
  assert.match(blocked.body.error, /^Too many failed sign-in attempts\. Sign-in is paused for about \d+ minutes?\. Try again later\.$/);
  assert.ok(Number(blocked.headers['Retry-After']) > 0 && Number(blocked.headers['Retry-After']) <= 30);
  assert.equal(pauseMessage(30_000), 'Too many failed sign-in attempts. Sign-in is paused for about 1 minute. Try again later.');
  assert.equal(pauseMessage(150_000), 'Too many failed sign-in attempts. Sign-in is paused for about 3 minutes. Try again later.');
  reset(); assert.equal(call().passed, true, 'and it clears when the rows are gone');
});

test('new system passwords are 12 to 128 characters; the bounds are inclusive and the message is plain', () => {
  for (const ok of ['x'.repeat(12), 'x'.repeat(128), 'correct horse battery staple']) assert.equal(newPasswordSchema.safeParse(ok).success, true, ok.length + ' characters');
  for (const bad of ['', '1234', 'x'.repeat(11), 'x'.repeat(129)]) {
    const result = newPasswordSchema.safeParse(bad);
    assert.equal(result.success, false, bad.length + ' characters');
    assert.equal(result.error.issues[0].message, 'Choose a system password of 12 to 128 characters.');
  }
});

test('signing in still accepts any stored password: only new passwords follow the new length rule', async () => {
  // The login, verify and reauth bodies use a length-1 to 256 schema, not the new-password rule (src/auth.js passwordSchema).
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/auth.js', import.meta.url), 'utf8');
  assert.match(source, /const passwordSchema=z\.string\(\)\.min\(1\)\.max\(256\);/);
  for (const route of ["auth.post('/login'", "auth.post('/invite-start'", "auth.post('/reauth'"]) {
    const at = source.indexOf(route), body = source.slice(at, source.indexOf('\n auth.', at) > 0 ? at + 400 : at + 400);
    assert.ok(!body.includes('newPasswordSchema'), route + ' accepts a stored password of any allowed length');
  }
  assert.match(source, /password:newPasswordSchema,setupToken/);
});

// ---- the owner is never kept out by someone else's guessing ----
const { rememberSignIn, knownSignIn, forgetKnownSignIns, DEVICE_COOKIE, KNOWN_MS } = await import('../src/login-guard.js');
const { digest } = await import('../src/crypto.js');
const request = (ip, cookie) => ({ ip, headers: cookie ? { cookie } : {} });
const guard = req => { const out = { headers: {} }; const res = { set: (name, value) => { out.headers[name] = value; }, status: code => { out.status = code; return { json: body => { out.body = body; } }; } }; let passed = false; globalLoginGuard(req, res, () => { passed = true; }); return { passed, ...out }; };
const signIn = (ip, now = Date.now()) => { let cookie; rememberSignIn(request(ip), { cookie: (name, value, options) => { cookie = { name, value, options }; } }, { secure: true, httpOnly: false, sameSite: 'lax' }, now); return cookie; };
const pause = () => { const now = Date.now(); for (let n = 0; n < GLOBAL_FAIL_LIMIT; n++) recordGlobalFailure(now); };

test('the known-device cookie is httpOnly, SameSite=Strict, 30 days, opaque, and only its hash is stored', () => {
  reset(); forgetKnownSignIns();
  const cookie = signIn('198.51.100.7');
  assert.equal(cookie.name, DEVICE_COOKIE);
  assert.deepEqual([cookie.options.httpOnly, cookie.options.sameSite, cookie.options.maxAge, cookie.options.secure], [true, 'strict', KNOWN_MS, true]);
  const [id, signature] = cookie.value.split('.');
  assert.match(id, /^[A-Za-z0-9_-]{32}$/); assert.ok(signature.length >= 40);
  const keys = db.prepare("SELECT key FROM rate_limits WHERE key LIKE 'device:%'").all().map(row => row.key);
  assert.deepEqual(keys, ['device:' + digest(id)], 'the stored key is a hash, never the id');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM rate_limits').all()).includes(id));
});

test('during a pause the owner (known device) signs in; an attacker without the cookie is still paused', () => {
  reset(); forgetKnownSignIns();
  const cookie = signIn('198.51.100.7'); pause();
  assert.equal(guard(request('203.0.113.9')).passed, false, 'a stranger is paused');
  assert.equal(guard(request('203.0.113.9')).status, 429);
  const owner = guard(request('203.0.113.50', `${cookie.name}=${cookie.value}`));
  assert.equal(owner.passed, true, 'the owner, on a new address, with the cookie, is let through');
  assert.equal(guard(request('203.0.113.9', 'other=1; ' + `${cookie.name}=${cookie.value}`)).passed, true, 'among other cookies');
});

test('a forged, tampered, expired or revoked cookie is ignored', () => {
  reset(); forgetKnownSignIns();
  const cookie = signIn('198.51.100.7'); pause();
  const [id, signature] = cookie.value.split('.');
  const forged = [`${cookie.name}=${id}.${'A'.repeat(signature.length)}`, `${cookie.name}=${id}`, `${cookie.name}=${id}.${signature}.x`, `${cookie.name}=${id.slice(1)}.${signature}`, `${cookie.name}=abc.def`, `${cookie.name}=`,
    `${cookie.name}=${'z'.repeat(32)}.${signature}`];
  for (const value of forged) assert.equal(guard(request('203.0.113.9', value)).passed, false, value.slice(0, 40));
  // A validly signed id that was never stored (or whose row has expired) is no better.
  db.prepare("UPDATE rate_limits SET reset_at=? WHERE key LIKE 'device:%'").run(Date.now() - 1);
  assert.equal(guard(request('203.0.113.9', `${cookie.name}=${cookie.value}`)).passed, false, 'expired');
  db.prepare("DELETE FROM rate_limits WHERE key LIKE 'login-ok:%'").run();
  assert.equal(knownSignIn(request('203.0.113.9', `${cookie.name}=${cookie.value}`)), false);
});

test('the address of a recent sign-in is the fallback; other addresses stay paused; thirty days and a revoke end it', () => {
  reset(); forgetKnownSignIns();
  const now = Date.now(); signIn('198.51.100.7', now); pause();
  assert.equal(guard(request('198.51.100.7')).passed, true, 'same address, no cookie');
  assert.equal(guard(request('198.51.100.8')).passed, false, 'another address');
  assert.equal(knownSignIn(request('198.51.100.7'), now + KNOWN_MS + 1), false, 'after 30 days');
  forgetKnownSignIns();
  assert.equal(guard(request('198.51.100.7')).passed, false, 'a password change or ending all sessions revokes both marks');
});
