// Optional update-failure excerpt (docs/update-center.md section 7.1, A17). Off by default. Its only source is that
// run's admin-only error, rollbackHint and warning text. It is redacted before it is shown and again before it is sent.
// Redaction errs on the side of removing too much: a lost word is cheap, a leaked name or secret is not.
export const EXCERPT_LINES = 40;
export const EXCERPT_BYTES = 2048;
const R = '[redacted]';
const bytes = s => new TextEncoder().encode(s).length;
const TOKEN = /[^\s"'<>(),;]+/g;
// Percent-encoded tokens are decoded first (each on its own, never throwing) so encoded paths and URLs meet the same
// rules; a token that still carries an escape after decoding (double encoding, broken escape) is removed whole.
function decodeTokens(text) {
  return text.replace(TOKEN, token => {
    if (!/%[0-9a-f]{2}/i.test(token)) return token;
    let decoded = token;
    try { decoded = decodeURIComponent(token); } catch { return R; }
    return /%[0-9a-f]{2}/i.test(decoded) ? R : decoded;
  });
}
const SECRET_KEY = /([A-Za-z0-9_.-]*(?:pass|passwd|password|pwd|token|secret|key|auth|credential|cookie|session)[^=:\s]*\s*[=:]\s*)("[^"]*"?|'[^']*'?|[^\s"']+)/gi;
const SECRET_TOKENS = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,                                  // AWS access key ids
  /\beyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+)*/g,                    // JWTs and other base64url JSON
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g,  // GitHub tokens
  /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,                // Authorization header values
];
// The word after one of these is a name, with or without a dot ("Could not resolve hostname nas01").
const NAMED = /(?<![\w.-])(hostname|host|server|remote|node)(\s*[:=]\s*|\s+)([^\s,;'"()<>]+)/gi;
const LABEL = '[\\p{L}\\p{N}_](?:[\\p{L}\\p{N}_-]{0,61}[\\p{L}\\p{N}_])?';
const HOST = new RegExp('(?<![\\p{L}\\p{N}_.-])(?:' + LABEL + '\\.)+[\\p{L}][\\p{L}\\p{N}-]{1,62}(?![\\p{L}\\p{N}_-])', 'gu');
const RULES = [
  /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>]+/gi,                              // URLs
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g,                                      // emails and user@host
];
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g;
const IPV6_FULL = /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi;
const IPV6_SHORT = /(?:\b[0-9a-f]{1,4})?(?::[0-9a-f]{1,4}){0,6}::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?(?![0-9a-f:])/gi;
// Any token with a / or \ that is absolute, home-relative (~, ~name), dot-relative, a drive or UNC path, or has two or
// more segments: the whole token goes.
function isPath(token) {
  if (!/[\\/]/.test(token)) return false;
  if (/^(?:[\\/]|~|\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(token)) return true;
  return token.split(/[\\/]+/).filter(Boolean).length >= 2;
}
// Long hex: a 40-character SHA stays only right after commit, sha or HEAD; anything else 16+ long goes.
const HEX = /\b[0-9a-f]{16,}\b/gi;
const SHA_CONTEXT = /(?:\bcommit|\bsha1?|\bHEAD(?: is(?: at)?)?)[\s:=]*$/i;
// Long base64 or token-like runs with at least one digit and one letter.
const B64 = /[A-Za-z0-9+/_-]{24,}={0,2}/g;
export function redact(text) {
  let out = String(text ?? '').replace(/[．。｡]/g, '.');
  out = decodeTokens(out);
  for (const rule of RULES) out = out.replace(rule, R);
  for (const rule of SECRET_TOKENS) out = out.replace(rule, (m, scheme) => (typeof scheme === 'string' && /^(bearer|basic|token)$/i.test(scheme) ? scheme + ' ' + R : R));
  out = out.replace(SECRET_KEY, (m, key, value) => (value === R ? m : key + R));
  out = out.replace(NAMED, (m, word, sep, name) => (name === R ? m : word + sep + R));
  out = out.replace(TOKEN, token => (isPath(token) ? R : token));
  out = out.replace(IPV4, R).replace(IPV6_FULL, R).replace(IPV6_SHORT, m => (m === '::' ? m : R));
  out = out.replace(HOST, R);
  out = out.replace(HEX, (m, offset, all) => (m.length === 40 && SHA_CONTEXT.test(all.slice(Math.max(0, offset - 16), offset)) ? m : R));
  // Pure hex runs were decided by the HEX rule above (only context-marked commit SHAs are left).
  out = out.replace(B64, m => (m === R || !/\d/.test(m) || !/[A-Za-z]/.test(m) || /^[0-9a-f]{40}$/i.test(m) ? m : R));
  return out;
}
// The last 40 lines and at most 2 KiB, keeping the newest text.
export function limitExcerpt(text) {
  let lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')).filter((l, i, a) => l.trim() || (i > 0 && i < a.length - 1));
  lines = lines.slice(-EXCERPT_LINES);
  let out = lines.join('\n');
  while (bytes(out) > EXCERPT_BYTES && lines.length > 1) { lines.shift(); out = lines.join('\n'); }
  while (bytes(out) > EXCERPT_BYTES) out = out.slice(1);
  return out.trim();
}
// Builds the excerpt from the three admin-only fields of one run.
export function excerptFrom({ error, rollbackHint, warning } = {}) {
  const parts = [error, rollbackHint, warning].filter(v => typeof v === 'string' && v.trim());
  return limitExcerpt(redact(parts.join('\n')));
}
export const excerptOk = v => typeof v === 'string' && v.length > 0 && bytes(v) <= EXCERPT_BYTES && v.split('\n').length <= EXCERPT_LINES;
