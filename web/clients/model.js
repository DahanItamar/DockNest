// Pure helpers for the Clients page (docs/client-reports.md). Nothing here reads a secret: recipients arrive masked.
export const MAX_RECIPIENTS = 3, MAX_APPS = 200;
// The accent is stored and sent as a token NAME. The server keeps the allow-list (src/reports/client.js, ACCENTS) and maps the
// name to a colour itself; the page only shows a swatch from a design token and never sends a colour.
export const ACCENTS = [['default', 'Default', '--dn-brand-solid'], ['blue', 'Blue', '--dn-info-solid'], ['green', 'Green', '--dn-green-solid'], ['amber', 'Amber', '--dn-amber-solid'], ['red', 'Red', '--dn-red-solid'], ['violet', 'Violet', '--dn-viz-2'], ['teal', 'Teal', '--dn-teal']];
export const accentVar = name => (ACCENTS.find(item => item[0] === name) || ACCENTS[0])[2];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const dayText = iso => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? '' : `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`; };
const shortDate = iso => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? '' : `${date.getDate()} ${MONTHS[date.getMonth()]}`; };

// What the card says about the monthly email: Monthly email on, No email, or Email failed (the newest report failed to send).
// A viewer's client has no schedule, so there is nothing to say.
export function emailState(client) {
  if (!client.schedule) return null;
  if (client.lastReport?.status === 'failed' && client.schedule.enabled) return { state: 'failed', label: 'Email failed' };
  return client.schedule.enabled ? { state: 'success', label: 'Monthly email on' } : { state: 'queued', label: 'No email' };
}
export function lastReportText(client) {
  const last = client.lastReport;
  if (!last) return 'None yet';
  const at = dayText(last.sentAt || last.createdAt);
  if (last.status === 'sent') return 'Sent ' + at;
  if (last.status === 'failed') return 'Email failed ' + at;
  if (last.status === 'sending') return 'Sending now';
  return 'Made ' + at;
}
export function appNames(client, sites) {
  const names = client.apps.map(id => sites.find(site => site.id === id)?.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
  const gone = client.apps.length - names.length;
  return { names, gone, text: names.length ? names.slice(0, 3).join(', ') + (names.length > 3 ? ' and ' + (names.length - 3) + ' more' : '') : client.apps.length ? 'Apps no longer available' : 'No apps yet' };
}

// Recipients typed one per line (commas and semicolons also split). Returns { list, error }; the server checks each address again.
export function parseRecipients(text) {
  const list = [...new Set(String(text || '').split(/[\n,;]+/).map(item => item.trim()).filter(Boolean))];
  if (list.length > MAX_RECIPIENTS) return { list, error: `Up to ${MAX_RECIPIENTS} addresses, one per line.` };
  const bad = list.find(item => !/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(item));
  return { list, error: bad ? 'Enter plain email addresses, for example client@example.com.' : '' };
}

// Period choices: the last 12 calendar months in the client's time zone, newest first.
export function monthChoices(timeZone = 'UTC', now = Date.now(), count = 12) {
  let year, month;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'numeric' }).formatToParts(now);
    year = Number(parts.find(p => p.type === 'year').value); month = Number(parts.find(p => p.type === 'month').value);
  } catch { const date = new Date(now); year = date.getUTCFullYear(); month = date.getUTCMonth() + 1; }
  const out = [], pad = n => String(n).padStart(2, '0');
  for (let i = 0; i < count; i++) {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    out.push({ value: `${year}-${pad(month)}`, label: `${FULL[month - 1]} ${year}`, from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(last)}` });
    month -= 1; if (month < 1) { month = 12; year -= 1; }
  }
  return out;
}

export function attentionNote(app) {
  if (app.state === 'Good') return '';
  const parts = [];
  if (app.state === 'Not protected') parts.push('no backup finished in this period');
  const { missed = 0, failed = 0 } = app.backups || {};
  if (missed) parts.push(`${missed} ${missed === 1 ? 'backup' : 'backups'} missed`);
  if (failed) parts.push(`${failed} ${failed === 1 ? 'backup' : 'backups'} failed`);
  if (app.restoreTests?.at(-1)?.result === 'Failed') parts.push('the last restore test failed');
  if (!parts.length) return '';
  return `${app.name}: ${parts.map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('. ')}.`;
}
// One preview row from the API's app facts.
export function previewRow(app) {
  const taken = app.backups?.taken ?? 0, due = app.backups?.due ?? 0, tests = app.restoreTests || [], last = tests.at(-1);
  const recovery = /^Back in (about [^,]+|under [^,]+)/.exec(app.recovery || '');
  return {
    name: app.name, backups: `${taken} of ${due}`,
    test: last ? { state: last.result === 'Passed' ? 'success' : 'failed', label: `${last.result} ${shortDate(last.at)}` } : { state: 'queued', label: 'No test in this period' },
    recovery: recovery ? recovery[1].charAt(0).toUpperCase() + recovery[1].slice(1) : 'Not measured',
    state: app.state === 'Good' ? 'success' : app.state === 'Needs attention' ? 'needs-review' : 'failed', stateLabel: app.state,
    note: attentionNote(app),
  };
}
export function summaryText(report) {
  const total = report.apps.length, s = report.summary || {};
  const bits = [`${total} ${total === 1 ? 'app' : 'apps'}`];
  if (s.good) bits.push(`${s.good} good`);
  if (s.attention) bits.push(`${s.attention} ${s.attention === 1 ? 'needs' : 'need'} attention`);
  if (s.unprotected) bits.push(`${s.unprotected} not protected`);
  return bits.join(' · ');
}
