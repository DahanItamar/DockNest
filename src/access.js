import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { db, id, audit, transaction } from './db.js';
import { config } from './config.js';
import { base32, seal, digest, passwordHash } from './crypto.js';
import { requireAdmin, requireRecentAuth, securityPolicy, IDLE_MS, INVITATION_MS, opaque, sharedPasswordMatches, qrEnrollment, credentialEpoch } from './auth.js';

export const access = Router();
access.use(requireAdmin);
const nameSchema = z.string().trim().min(1).max(100).regex(/^[^\x00-\x1f\x7f]+$/);
const conflict = message => { const error = new Error(message); error.status = 409; throw error; };
const account = userId => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!user) { const error = new Error('Account not found.'); error.status = 404; throw error; }
  return user;
};
function revokeSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM login_challenges WHERE user_id=?').run(userId);
  for (const invitation of db.prepare('SELECT id FROM invitations WHERE user_id=?').all(userId)) db.prepare('DELETE FROM enrollment_challenges WHERE invitation_id=?').run(invitation.id);
  db.prepare('UPDATE invitations SET revoked_at=? WHERE user_id=? AND consumed_at IS NULL AND revoked_at IS NULL').run(Date.now(), userId);
}
function newInvitation(user, actor) {
  const token = opaque(), invitationId = id(), expiresAt = Date.now() + INVITATION_MS;
  const updated = { ...user, totp_secret: seal(base32(randomBytes(20))) };
  revokeSessions(user.id);
  db.prepare('UPDATE users SET totp_secret=?,totp_last_counter=-1,recovery_codes=?,enrolled=0 WHERE id=? AND disabled=0').run(updated.totp_secret, '[]', user.id);
  db.prepare('INSERT INTO invitations(id,user_id,token_hash,expires_at,created_at,created_by) VALUES (?,?,?,?,?,?)').run(invitationId, user.id, digest(token), expiresAt, new Date().toISOString(), actor);
  audit(actor, 'access.invitation_created', user.id, { invitationId, expiresAt });
  return { id: invitationId, userId: user.id, name: user.name, url: `${config.origin}/#/enroll/${token}`, expiresAt, user: updated };
}
async function invitationResponse(result, res) {
  const { user, ...response } = result, qr = await qrEnrollment(user);
  const current = db.prepare('SELECT * FROM invitations WHERE id=? AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>?').get(result.id, Date.now());
  if (!current) { const error = new Error('Invitation was revoked or expired while preparing the QR code.'); error.status = 410; throw error; }
  res.status(201).json({ ...response, ...qr });
}
access.get('/', (_req, res) => {
  const users = db.prepare('SELECT id,name,email,role,enrolled,disabled,created_at,revoked_at FROM users ORDER BY created_at').all().map(user => {
    const invitation = db.prepare('SELECT id,expires_at,revoked_at,consumed_at FROM invitations WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(user.id);
    const activeSessions = db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=? AND expires_at>? AND last_activity_at>?').get(user.id, Date.now(), Date.now() - IDLE_MS).count;
    return { id: user.id, name: user.name, email: user.email.endsWith('@accounts.invalid') ? null : user.email, role: user.role, status: user.disabled ? 'revoked' : user.enrolled ? 'active' : 'pending', createdAt: user.created_at, revokedAt: user.revoked_at, activeSessions, invitationId: invitation?.id || null, invitationExpiresAt: invitation?.expires_at || null, invitationStatus: !invitation ? null : invitation.revoked_at ? 'revoked' : invitation.consumed_at ? 'accepted' : invitation.expires_at <= Date.now() ? 'expired' : 'pending' };
  });
  res.json({ users, security: securityPolicy });
});
access.post('/invitations', requireRecentAuth, async (req, res) => {
  const { name } = z.object({ name: nameSchema }).parse(req.body);
  const result = transaction(() => {
    if (db.prepare('SELECT COUNT(*) AS count FROM users WHERE disabled=0').get().count >= 100) conflict('This installation supports at most 100 active or pending accounts.');
    if (db.prepare('SELECT 1 FROM users WHERE name=? COLLATE NOCASE AND disabled=0').get(name)) conflict('An account with this name already exists.');
    const user = { id: id(), name, email: `${id()}@accounts.invalid`, role: 'operator' };
    db.prepare('INSERT INTO users(id,name,email,role,password_hash,totp_secret,recovery_codes,created_at) VALUES (?,?,?,?,?,?,?,?)').run(user.id, name, user.email, user.role, 'shared-password', seal('pending'), '[]', new Date().toISOString());
    return newInvitation(user, req.user.id);
  });
  await invitationResponse(result, res);
});
access.post('/users/:id/invitation', requireRecentAuth, async (req, res) => {
  const { confirmation } = z.object({ confirmation: z.string().optional() }).parse(req.body || {});
  const result = transaction(() => {
    const user = account(req.params.id);
    if (user.role === 'admin') conflict('The main administrator cannot reset their authenticator through an invitation. Use a recovery code.');
    if (user.disabled) conflict('Revoked accounts cannot be re-enabled. Create a new named account if access is needed again.');
    if (user.enrolled && confirmation !== user.name) conflict('Confirm the account name before replacing its authenticator and signing out all sessions.');
    return newInvitation(user, req.user.id);
  });
  await invitationResponse(result, res);
});
access.post('/users/:id/revoke', requireRecentAuth, (req, res) => {
  const { confirmation } = z.object({ confirmation: z.string() }).parse(req.body);
  transaction(() => {
    const user = account(req.params.id);
    if (user.id === req.user.id || user.role === 'admin') conflict('The main administrator account cannot be revoked.');
    if (confirmation !== user.name) conflict('Type the account name to confirm revocation.');
    revokeSessions(user.id);
    db.prepare('UPDATE users SET disabled=1,revoked_at=?,totp_secret=?,recovery_codes=? WHERE id=?').run(new Date().toISOString(), seal('revoked'), '[]', user.id);
    audit(req.user.id, 'access.account_revoked', user.id);
  });
  res.json({ revoked: true, signedOut: true });
});
access.post('/invitations/:id/revoke', requireRecentAuth, (req, res) => {
  transaction(() => {
    const invitation = db.prepare('SELECT * FROM invitations WHERE id=?').get(req.params.id);
    if (!invitation) { const error = new Error('Invitation not found.'); error.status = 404; throw error; }
    db.prepare('UPDATE invitations SET revoked_at=? WHERE id=?').run(Date.now(), invitation.id);
    db.prepare('DELETE FROM enrollment_challenges WHERE invitation_id=?').run(invitation.id);
    audit(req.user.id, 'access.invitation_revoked', invitation.user_id, { invitationId: invitation.id });
  });
  res.json({ revoked: true });
});
access.post('/password', requireRecentAuth, (req, res) => {
  const data = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(4).max(16) }).parse(req.body);
  if (!sharedPasswordMatches(data.currentPassword)) return res.status(401).json({ error: 'The current universal password is incorrect.' });
  if (data.currentPassword === data.newPassword) return res.status(400).json({ error: 'Choose a different universal password.' });
  transaction(() => {
    db.prepare("UPDATE settings SET value=? WHERE key='shared_password_hash'").run(passwordHash(data.newPassword));
    db.prepare("UPDATE settings SET value=? WHERE key='auth_epoch'").run(String(credentialEpoch() + 1));
    db.exec('DELETE FROM sessions; DELETE FROM login_challenges; DELETE FROM enrollment_challenges; DELETE FROM challenges;');
    db.prepare('UPDATE invitations SET revoked_at=? WHERE consumed_at IS NULL AND revoked_at IS NULL').run(Date.now());
    audit(req.user.id, 'access.universal_password_changed', req.user.id, { allSessionsRevoked: true });
  });
  res.clearCookie('dbm_session', { httpOnly: true, secure: config.secureCookies, sameSite: 'strict', path: '/' });
  res.json({ signedOut: true });
});
