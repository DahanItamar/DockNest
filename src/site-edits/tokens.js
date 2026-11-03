// Review tokens (docs/safe-edit.md, "Security review changes" item 10). Between Review and Apply the candidate lives
// only here: in the API process's memory, sealed with the master key, for at most 15 minutes, under the SHA-256 of a
// one-use token that is bound to the user, the session, the site and the original file hashes. Never in SQLite, never
// logged. An API restart forgets every token, so the owner reviews again.
import { randomBytes } from 'node:crypto';
import { seal, open, digest } from '../crypto.js';
import { LIMITS } from './state.js';

export const tokenClock = { now: () => Date.now() };
const store = new Map();
const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });
const prune = () => { const now = tokenClock.now(); for (const [key, entry] of store) if (entry.expiresAt <= now) store.delete(key); };
const sameHashes = (a, b) => JSON.stringify([...a].map(({ path, before }) => [path, before]).sort()) === JSON.stringify([...b].map(({ path, before }) => [path, before]).sort());

// `candidate`: the secret part ({ files, env }); `meta`: the non-secret verdict and summary the apply step needs.
export function issueToken({ userId, sessionHash, siteId, hashes, candidate, meta }) {
  prune();
  // One open review per user, session and site: a newer review replaces the older token.
  for (const [key, entry] of store) if (entry.userId === userId && entry.sessionHash === sessionHash && entry.siteId === siteId) store.delete(key);
  const token = randomBytes(32).toString('base64url'), expiresAt = tokenClock.now() + LIMITS.tokenMs;
  store.set(digest(token), { userId, sessionHash, siteId, hashes: hashes.map(({ path, before }) => ({ path, before })), sealed: seal(JSON.stringify(candidate)), meta, expiresAt });
  return { token, expiresAt };
}

// Takes the token out of the store (one use). Any mismatch also removes it: a token presented by someone else, from
// another session or for another site is burnt. Returns { candidate, meta, hashes, restore } where restore() puts the
// token back when the edit could not be created for a reason the owner can wait out (site busy).
export function takeToken(token, { userId, sessionHash, siteId }) {
  prune();
  const key = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? digest(token) : null;
  const entry = key && store.get(key);
  if (!entry) throw httpError(409, 'REVIEW_EXPIRED', 'This review expired. Review the change again.');
  store.delete(key);
  if (entry.userId !== userId || entry.sessionHash !== sessionHash || entry.siteId !== siteId) throw httpError(409, 'REVIEW_EXPIRED', 'This review expired. Review the change again.');
  const candidate = JSON.parse(open(entry.sealed));
  if (!sameHashes(entry.hashes, candidate.originalHashes ?? [])) throw httpError(409, 'REVIEW_EXPIRED', 'This review expired. Review the change again.');
  return { candidate, meta: entry.meta, hashes: entry.hashes, sealed: entry.sealed, restore: () => { if (entry.expiresAt > tokenClock.now()) store.set(key, entry); } };
}

// The original hashes a token was bound to must still be the ones the candidate names.
export const hashesMatch = (entry, candidateHashes) => sameHashes(entry, candidateHashes);
// Tests only.
export const tokenCount = () => { prune(); return store.size; };
export const clearTokens = () => store.clear();
