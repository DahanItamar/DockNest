import { Router } from 'express';
import fs from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db, id, audit, transaction } from './db.js';
import { config } from './config.js';
import { seal, open, passwordHash, passwordVerify, digest, base32, verifyTotp } from './crypto.js';

export const auth = Router();
const opaque = () => randomBytes(32).toString('base64url');
const loginSchema = z.object({ email: z.email().max(254).transform(v => v.toLowerCase()), password: z.string().min(1).max(256) });
const dummyHash = passwordHash('unavailable-account-timing-protection');
const userView = user => ({ id: user.id, email: user.email });
const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: 'strict', path: '/', maxAge: 8 * 60 * 60 * 1000 };
export function rateLimit(scope, limit = 10, windowMs = 15 * 60 * 1000) {
  return (req, res, next) => {
    const key = `${scope}:${req.ip}`, now = Date.now();
    const previous = db.prepare('SELECT * FROM rate_limits WHERE key=?').get(key);
    if (previous && previous.reset_at > now && previous.attempts >= limit) {
      res.set('Retry-After', String(Math.ceil((previous.reset_at - now) / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    db.prepare('INSERT INTO rate_limits VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts,reset_at=excluded.reset_at').run(key, previous && previous.reset_at > now ? previous.attempts + 1 : 1, previous && previous.reset_at > now ? previous.reset_at : now + windowMs);
    next();
  };
}
export function session(req, res, next) {
  const raw = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('dbm_session='))?.slice(12);
  if (raw && /^[A-Za-z0-9_-]{43}$/.test(raw)) {
    const row = db.prepare('SELECT sessions.*,users.email FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>? AND users.enrolled=1').get(digest(raw), Date.now());
    if (row) { req.user = { id: row.user_id, email: row.email }; req.session = row; }
  }
  next();
}
export function requireAuth(req, res, next) { return req.user ? next() : res.status(401).json({ error: 'Sign in to continue.' }); }
export function csrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const provided = req.headers['x-csrf-token'];
  if (!req.session || typeof provided !== 'string' || digest(provided) !== digest(req.session.csrf_token)) return res.status(403).json({ error: 'Your session needs to be refreshed.' });
  next();
}
function challengeFor(user) {
  const challenge = opaque();
  db.prepare('DELETE FROM challenges WHERE expires_at<? OR user_id=?').run(Date.now(), user.id);
  db.prepare('INSERT INTO challenges(token_hash,user_id,expires_at) VALUES (?,?,?)').run(digest(challenge), user.id, Date.now() + 5 * 60 * 1000);
  return challenge;
}
function enrollment(user) {
  const secret = open(user.totp_secret);
  const recoveryCodes = Array.from({ length: 10 }, () => randomBytes(10).toString('hex'));
  db.prepare('UPDATE users SET recovery_codes=? WHERE id=? AND enrolled=0').run(JSON.stringify(recoveryCodes.map(digest)), user.id);
  return { enrollmentRequired: true, secret, uri: `otpauth://totp/${encodeURIComponent('Docker Backup:' + user.email)}?secret=${secret}&issuer=Docker%20Backup&algorithm=SHA1&digits=6&period=30`, recoveryCodes };
}
auth.get('/status', (req, res) => {
  res.json({ setupRequired: !db.prepare('SELECT 1 FROM users LIMIT 1').get(), authenticated: Boolean(req.user), ...(req.user ? { user: req.user, csrfToken: req.session.csrf_token } : {}) });
});
auth.post('/setup', rateLimit('setup', 5), (req, res) => {
  const data = loginSchema.extend({ password: z.string().min(14).max(256), setupToken: z.string().min(1).max(256) }).parse(req.body);
  let expected;
  try { expected = fs.readFileSync(config.setupTokenFile, 'utf8').trim(); } catch { return res.status(503).json({ error: 'Run npm run setup to create the one-time setup token.' }); }
  if (!expected || !timingSafeEqual(Buffer.from(digest(data.setupToken)), Buffer.from(digest(expected)))) return res.status(403).json({ error: 'Invalid setup token.' });
  const user = transaction(() => {
    if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) { const error = new Error('Administrator has already been created. Sign in instead.'); error.status = 409; throw error; }
    const user = { id: id(), email: data.email, totp_secret: seal(base32(randomBytes(20))) };
    db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,created_at) VALUES (?,?,?,?,?,?)').run(user.id, user.email, passwordHash(data.password), user.totp_secret, '[]', new Date().toISOString());
    audit(user.id, 'auth.setup', user.id);
    return user;
  });
  res.status(201).json({ challenge: challengeFor(user), ...enrollment(user) });
});
auth.post('/login', rateLimit('login'), (req, res) => {
  const data = loginSchema.parse(req.body);
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(data.email);
  const valid = passwordVerify(data.password, user?.password_hash || dummyHash);
  if (!user || !valid) { audit('anonymous', 'auth.login_failed'); return res.status(401).json({ error: 'Invalid email or password.' }); }
  res.json({ challenge: challengeFor(user), ...(!user.enrolled ? enrollment(user) : {}) });
});
auth.post('/verify', rateLimit('verify', 15), (req, res) => {
  const data = z.object({ challenge: z.string().length(43), code: z.string().min(6).max(32) }).parse(req.body);
  const result = transaction(() => {
    const challenge = db.prepare('SELECT * FROM challenges WHERE token_hash=? AND expires_at>? AND attempts<5').get(digest(data.challenge), Date.now());
    if (!challenge) return null;
    db.prepare('UPDATE challenges SET attempts=attempts+1 WHERE token_hash=?').run(digest(data.challenge));
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(challenge.user_id);
    const counter = verifyTotp(open(user.totp_secret), data.code, user.totp_last_counter);
    const recovery = JSON.parse(user.recovery_codes);
    const recoveryIndex = user.enrolled ? recovery.indexOf(digest(data.code.toLowerCase().replace(/[\s-]/g, ''))) : -1;
    if (counter === null && recoveryIndex === -1) return null;
    if (recoveryIndex !== -1) recovery.splice(recoveryIndex, 1);
    db.prepare('UPDATE users SET enrolled=1,totp_last_counter=?,recovery_codes=? WHERE id=?').run(counter ?? user.totp_last_counter, JSON.stringify(recovery), user.id);
    db.prepare('DELETE FROM challenges WHERE user_id=?').run(user.id);
    const token = opaque(), csrfToken = opaque();
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(digest(token), user.id, csrfToken, Date.now() + cookieOptions.maxAge);
    audit(user.id, recoveryIndex !== -1 ? 'auth.recovery_login' : 'auth.login', user.id);
    return { token, csrfToken, user: userView(user) };
  });
  if (!result) return res.status(401).json({ error: 'Invalid or expired code. Sign in again after five unsuccessful attempts.' });
  res.cookie('dbm_session', result.token, cookieOptions);
  res.json({ user: result.user, csrfToken: result.csrfToken });
});
auth.post('/logout', requireAuth, csrf, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.session.token_hash);
  audit(req.user.id, 'auth.logout'); res.clearCookie('dbm_session', cookieOptions); res.status(204).end();
});
