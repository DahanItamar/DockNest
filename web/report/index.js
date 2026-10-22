// Problem reports across DockNest (docs/update-center.md section 13). No other module builds report URLs.
export { ISSUE_BASE, URL_LIMIT, TEMPLATES, buildIssueUrl } from './core.js';
export * from './builders.js';
export { redact, limitExcerpt, excerptFrom, EXCERPT_LINES, EXCERPT_BYTES } from './redact.js';
