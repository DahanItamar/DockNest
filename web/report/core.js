// Problem reports (docs/update-center.md section 13). The one place that builds GitHub issue URLs.
// Pure: no React, no network. The browser opens the URL; DockNest's server never sees or sends a report.
export const ISSUE_BASE = 'https://github.com/DahanItamar/DockNest/issues/new';
export const URL_LIMIT = 4000;
// Constant template names. A template outside this list is refused, never interpolated.
export const TEMPLATES = Object.freeze(['bug-report.yml', 'update-failure.yml', 'job-failure.yml', 'storage-failure.yml', 'server-connection.yml', 'self-backup-failure.yml', 'app-error.yml']);
// Titles are composed by the builders from already-checked values; this pattern is a second fence.
export const TITLE = /^[A-Za-z0-9 .:()<>_-]{1,120}$/;

// A validator is an array of allowed strings, a RegExp that must match the whole value, or a predicate.
export function valid(rule, value) {
  if (typeof value !== 'string' || value === '') return false;
  if (Array.isArray(rule)) return rule.includes(value);
  if (rule instanceof RegExp) { const m = rule.exec(value); return !!m && m.index === 0 && m[0].length === value.length; }
  if (typeof rule === 'function') return rule(value) === true;
  return false;
}

// buildIssueUrl(template, fields, allowList): every field name must be in the allow-list and every value must pass
// its rule; anything else is dropped, never copied. The URL is capped at URL_LIMIT characters (throws past it, so
// a caller can drop optional fields and try again).
export function buildIssueUrl(template, fields, allowList) {
  if (!TEMPLATES.includes(template)) throw new Error('Unknown report template');
  const url = new URL(ISSUE_BASE), params = url.searchParams, sent = [], dropped = [];
  params.set('template', template);
  for (const [name, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null) continue;
    if (!Object.hasOwn(allowList || {}, name) || name === 'template' || !valid(allowList[name], value)) { dropped.push(name); continue; }
    params.set(name, value);
    sent.push([name, value]);
  }
  const href = url.toString();
  if (href.length > URL_LIMIT) throw Object.assign(new Error('Report URL too long'), { code: 'TOO_LONG', length: href.length });
  return { href, sent, dropped };
}
