// Optional update-failure excerpt (docs/update-center.md section 7.1, A17). Off by default. Its only source is that
// run's admin-only error, rollbackHint and warning text. It is redacted before it is shown and again before it is sent.
export const EXCERPT_LINES = 40;
export const EXCERPT_BYTES = 2048;
const R = '[redacted]';
const bytes = s => new TextEncoder().encode(s).length;
// Order matters: whole URLs first, then addresses and names inside what is left.
const RULES = [
  /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>]+/gi,                              // URLs
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g,                                      // emails and user@host
  /(?:[A-Za-z]:\\|\\\\)[^\s"'<>]*/g,                                        // Windows and UNC paths
  /(?<![A-Za-z0-9.])~?\/(?:[^\s"'<>(),;]+)/g,                              // absolute and home paths
  /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g,                              // IPv4 (optional port)
  /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi,                               // IPv6, full form
  /(?:\b[0-9a-f]{1,4})?(?::[0-9a-f]{1,4}){0,6}::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?\b/gi, // IPv6, compressed
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}\b/gi,  // host names (and dotted file names)
];
// Long hex: public commit SHAs (exactly 40 hex characters) stay; anything else 16+ long goes.
const HEX = /\b[0-9a-f]{16,}\b/gi;
// Long base64 or token-like runs with at least one digit and one letter.
const B64 = /[A-Za-z0-9+/_-]{24,}={0,2}/g;
export function redact(text) {
  let out = String(text ?? '');
  for (const rule of RULES) out = out.replace(rule, m => (m === '::' ? m : R));
  out = out.replace(HEX, m => (m.length === 40 ? m : R));
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
