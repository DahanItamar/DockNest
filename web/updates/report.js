// "Report a bug" (docs/update-center.md section 13): the issue URL is built in the browser from allow-listed values only.
// Nothing is sent to DockNest's server and nothing is posted; the admin submits the issue on GitHub.
export const ISSUE_BASE = 'https://github.com/DahanItamar/DockNest/issues/new';
export const BUG_TEMPLATE = 'bug-report.yml';
export const URL_LIMIT = 4000;
const VERSION = /^v?(\d+\.\d+\.\d+)$/;
export const INSTALL_MODES = ['image', 'source'];
// Typed fields only: an invalid value is dropped, never copied. Free text from anywhere cannot reach the URL.
export function buildBugReport({ version, installMode } = {}) {
  const match = VERSION.exec(typeof version === 'string' ? version : ''), v = match ? 'v' + match[1] : null;
  const mode = INSTALL_MODES.includes(installMode) ? installMode : null;
  const title = 'Bug report: DockNest' + (v ? ' ' + v : '');
  const url = new URL(ISSUE_BASE), params = url.searchParams;
  params.set('template', BUG_TEMPLATE);
  params.set('title', title);
  if (v) params.set('version', v);
  if (mode) params.set('install_mode', mode);
  const href = url.toString();
  if (href.length > URL_LIMIT) throw new Error('Report URL too long');
  return { title, href, version: v, installMode: mode, fields: [['DockNest version', v || 'Not available'], ['Install mode', mode ? (mode === 'source' ? 'source (git checkout)' : 'image') : 'Not available']] };
}
