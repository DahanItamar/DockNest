import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';
import { key, digest } from './crypto.js';
import { clientKey } from './client-key.js';

// A global brake on guessing the system password, next to the per-address limits (rateLimit in src/auth.js). The per-address
// limits stop one client; behind many addresses (or a spoofed forwarding header, see TRUST_PROXY in docs/security.md) a
// guesser could still try without end. After GLOBAL_FAIL_LIMIT failed sign-ins in one window from anyone, sign-in pauses for
// a growing time: 30 s, then 60 s, 2 min, 4 min, 8 min, never more than 15 min. Nothing is permanent and nothing polls:
// two rows in rate_limits, read when a request arrives. Requests refused during a pause do not extend it. Successful sign-ins
// do not reset it (the window ends by itself), so a valid sign-in can never be used to clear a guessing run.
export const GLOBAL_FAIL_LIMIT = 20;
export const WINDOW_MS = 15 * 60_000;
export const BASE_PAUSE_MS = 30_000;
export const MAX_PAUSE_MS = 15 * 60_000;
const FAILS = 'global:login-failures', PAUSE = 'global:login-pause';
const put = db.prepare('INSERT INTO rate_limits VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts,reset_at=excluded.reset_at');

export function recordGlobalFailure(now = Date.now()) {
  const previous = db.prepare('SELECT * FROM rate_limits WHERE key=?').get(FAILS), open = previous && previous.reset_at > now;
  const attempts = open ? previous.attempts + 1 : 1, resetAt = open ? previous.reset_at : now + WINDOW_MS;
  put.run(FAILS, attempts, resetAt);
  if (attempts >= GLOBAL_FAIL_LIMIT) {
    const pause = Math.min(MAX_PAUSE_MS, BASE_PAUSE_MS * 2 ** Math.min(attempts - GLOBAL_FAIL_LIMIT, 10));
    put.run(PAUSE, attempts, now + pause);
  }
  return attempts;
}
export function pauseRemainingMs(now = Date.now()) {
  const row = db.prepare('SELECT reset_at FROM rate_limits WHERE key=?').get(PAUSE);
  return row && row.reset_at > now ? row.reset_at - now : 0;
}
export const pauseMessage = ms => `Too many failed sign-in attempts. Sign-in is paused for about ${Math.max(1, Math.ceil(ms / 60_000))} minute${Math.ceil(ms / 60_000) > 1 ? 's' : ''}. Try again later.`;
// The owner is never kept out by someone else's guessing. Every full sign-in (password and code) leaves two marks that let later
// requests skip the PAUSE (the per-address limits and the authenticator code still apply to them): a signed "known device" cookie
// (an opaque random id signed with the server key, httpOnly, SameSite=Strict, 30 days, nothing personal; only its hash is stored, so
// it can be revoked) and, as a fallback for a browser that dropped the cookie, the client address of the sign-in, for 30 days.
// Both are cleared by a password change and by ending all sessions. A guesser has neither: he never completes a sign-in.
export const KNOWN_MS = 30 * 24 * 3600_000;
export const DEVICE_COOKIE = 'dbm_device';
const sign = id => createHmac('sha256', key()).update('docknest-known-device:' + id).digest('base64url');
export function rememberSignIn(req, res, cookieOptions, now = Date.now()) {
  db.prepare("DELETE FROM rate_limits WHERE (key LIKE 'device:%' OR key LIKE 'login-ok:%') AND reset_at<=?").run(now);
  const id = randomBytes(24).toString('base64url');
  put.run('device:' + digest(id), 1, now + KNOWN_MS);
  put.run('login-ok:' + clientKey(req.ip), 1, now + KNOWN_MS);
  res.cookie(DEVICE_COOKIE, id + '.' + sign(id), { ...cookieOptions, httpOnly: true, sameSite: 'strict', maxAge: KNOWN_MS });
}
export function knownSignIn(req, now = Date.now()) {
  const raw = (req.headers?.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(DEVICE_COOKIE + '='))?.slice(DEVICE_COOKIE.length + 1);
  if (raw) {
    const [id, signature, extra] = raw.split('.');
    if (id && signature && extra === undefined && /^[A-Za-z0-9_-]{20,64}$/.test(id)) {
      const expected = Buffer.from(sign(id)), given = Buffer.from(signature);
      if (expected.length === given.length && timingSafeEqual(expected, given)) {
        const row = db.prepare('SELECT reset_at FROM rate_limits WHERE key=?').get('device:' + digest(id));
        if (row && row.reset_at > now) return true;
      }
    }
  }
  const seen = db.prepare('SELECT reset_at FROM rate_limits WHERE key=?').get('login-ok:' + clientKey(req.ip));
  return Boolean(seen && seen.reset_at > now);
}
export const forgetKnownSignIns = () => db.prepare("DELETE FROM rate_limits WHERE key LIKE 'device:%' OR key LIKE 'login-ok:%'").run();
// Express middleware for the sign-in steps that check a secret without a session.
export function globalLoginGuard(req, res, next) {
  if (knownSignIn(req)) return next();
  const left = pauseRemainingMs();
  if (!left) return next();
  res.set('Retry-After', String(Math.ceil(left / 1000)));
  return res.status(429).json({ error: pauseMessage(left), code: 'SIGN_IN_PAUSED' });
}
