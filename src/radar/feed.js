// Advisory feed: validation, sanitising and Ed25519 detached-signature verification.
// 2.12.0 uses only the bundled radar/advisories.json, trusted through the signed release. verifySignedFeed is kept and
// tested for the signed refresh a later release adds; nothing calls it yet and DockNest fetches no feed over the network.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

export const MAX_FEED_BYTES = 512 * 1024;
// Pinned production public key(s): base64 SPKI DER. Empty until the release key exists;
// verifySignedFeed fails closed while this is empty. The bundled file is trusted as part of the release.
export const PINNED_FEED_PUBLIC_KEYS = [];
export const ALLOWED_REF_HOSTS = ['nvd.nist.gov', 'cve.org', 'github.com', 'php.net', 'nodejs.org'];
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

export class FeedError extends Error {
  constructor(code, message) { super(message); this.name = 'FeedError'; this.code = code; }
}
const bad = (msg) => { throw new FeedError('feed_invalid', msg); };

export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function cleanRef(value) {
  if (typeof value !== 'string' || value.length > 300) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_REF_HOSTS.some((h) => host === h || host === `www.${h}`)) return null;
  return u.href;
}

const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(v) && !Number.isNaN(Date.parse(v));
const arr = (v, name, max) => { if (!Array.isArray(v) || v.length > max) bad(`${name} must be an array of at most ${max}`); return v; };

export function validateFeed(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('feed must be an object');
  if (raw.format !== 1) bad('unsupported feed format');
  if (!Number.isSafeInteger(raw.serial) || raw.serial < 1) bad('serial must be a positive integer');
  if (!isDate(raw.generatedAt) || !isDate(raw.expiresAt)) bad('generatedAt and expiresAt must be dates');
  const advisories = arr(raw.advisories, 'advisories', 500).map((a) => {
    if (!a || typeof a !== 'object') bad('advisory must be an object');
    if (typeof a.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(a.id)) bad('bad advisory id');
    if (!SEVERITIES.includes(a.severity)) bad(`bad severity for ${a.id}`);
    if (typeof a.product !== 'string' || !/^[a-z0-9._-]{1,32}$/.test(a.product)) bad(`bad product for ${a.id}`);
    if (!isDate(a.publishedAt)) bad(`bad publishedAt for ${a.id}`);
    const cve = arr(a.cve ?? [], 'cve', 20).filter((c) => typeof c === 'string' && /^CVE-\d{4}-\d{4,10}$/.test(c));
    const ranges = arr(a.ranges, 'ranges', 10).map((r) => {
      if (!r || r.scheme !== 'dotted') bad(`unsupported range scheme for ${a.id}`);
      const fixed = arr(r.fixed, 'fixed', 50);
      if (!fixed.every((f) => typeof f === 'string' && /^\d+(\.\d+){1,4}$/.test(f))) bad(`bad fixed version for ${a.id}`);
      return { scheme: 'dotted', fixed };
    });
    const eol = a.eol == null ? null : (isDate(a.eol) ? a.eol : bad(`bad eol for ${a.id}`));
    return {
      id: a.id, cve, title: cleanText(a.title, 160), severity: a.severity, product: a.product, ranges, eol,
      summary: cleanText(a.summary, 600), action: cleanText(a.action, 400),
      refs: arr(a.refs ?? [], 'refs', 20).map(cleanRef).filter(Boolean), publishedAt: a.publishedAt,
    };
  });
  const eol = arr(raw.eol ?? [], 'eol', 500).map((e) => {
    if (!e || typeof e.product !== 'string' || typeof e.cycle !== 'string' || !/^[\d.]{1,12}$/.test(e.cycle) || !isDate(e.eol)) bad('bad eol entry');
    return { product: cleanText(e.product, 32), cycle: e.cycle, eol: e.eol };
  });
  return { format: 1, serial: raw.serial, generatedAt: raw.generatedAt, expiresAt: raw.expiresAt, advisories, eol };
}

export function parseFeed(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
  if (buf.length > MAX_FEED_BYTES) throw new FeedError('feed_too_large', 'feed exceeds size cap');
  let raw;
  try { raw = JSON.parse(buf.toString('utf8')); } catch { throw new FeedError('feed_invalid', 'feed is not valid JSON'); }
  return validateFeed(raw);
}

// Bundled feed ships inside the release, so it is trusted without a signature.
export function loadBundledFeed(path) {
  return parseFeed(readFileSync(path));
}

// Fails closed: no pinned keys, bad signature, rolled-back serial or expired feed all throw.
export function verifySignedFeed({ bytes, signature, publicKeys = PINNED_FEED_PUBLIC_KEYS, lastSerial = 0, now = new Date() }) {
  if (!publicKeys.length) throw new FeedError('no_pinned_key', 'no pinned feed key; refusing unsigned feed');
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
  if (buf.length > MAX_FEED_BYTES) throw new FeedError('feed_too_large', 'feed exceeds size cap');
  const sig = Buffer.from(String(signature ?? '').trim(), 'base64');
  const ok = sig.length === 64 && publicKeys.some((k) => {
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' });
      return crypto.verify(null, buf, key, sig);
    } catch { return false; }
  });
  if (!ok) throw new FeedError('bad_signature', 'feed signature is not valid');
  const feed = parseFeed(buf);
  if (feed.serial <= lastSerial) throw new FeedError('rollback', 'feed serial is not newer than the installed one');
  if (Date.parse(feed.expiresAt) <= now.getTime()) throw new FeedError('expired', 'feed has expired');
  return feed;
}
