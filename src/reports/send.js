// Sending and scheduling client reports (docs/client-reports.md, decisions 7 and 8).
// - The schedule runs inside the worker's existing tick (no timer or loop of its own). It reads one indexed query for
//   clients whose next_due_at has come, makes the previous month's report once (a report row per client and period is
//   the guard), and sends it through the client's email Connection to the sealed recipients.
// - A failed send retries after 1, 2 and 3 hours (three retries over 6 hours), then the row is `failed` and a
//   `report.failed` alert goes to the owner's normal alert lines. A success is recorded, never alerted.
// - The PDF is built in memory for each attempt and never stored. The email body is fixed text with the client and period.
import { createHash } from 'node:crypto';
import { db, id, audit } from '../db.js';
import { emit } from '../alerts/delivery.js';
import { getConnection, openSecret } from '../alerts/connections.js';
import { sendMail, SmtpError, smtpLimits } from '../alerts/smtp.js';
import { buildReport, reportPdf } from './client.js';
import { resolvePeriod, previousMonth, nextDueAt } from './period.js';
import { openRecipients } from './store.js';

export const RETRY_DELAYS_MS = Object.freeze([1, 2, 3].map(hours => hours * 3600_000));
const TOO_LARGE = 'Report too large to email, download it instead.';
const NO_ROUTE = 'No email Connection or recipient is set for this client.';
const failure = message => Object.assign(new Error(message), { final: true });
export const reportFileName = period => `docknest-report-${period.from.slice(0, 7)}.pdf`;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const mailBody = report => `Hello,\n\nThe backup report for ${report.client}, ${report.period.label}, is attached as a PDF.\n\nMade with DockNest.`;

// Builds the report for a stored client and period and e-mails it. Throws an Error whose message is a short fixed
// sentence (never a server reply); `final` marks a failure that a retry cannot fix.
export async function emailReport(client, period, { now = Date.now() } = {}) {
  const recipients = openRecipients(client), connection = client.connection_id ? getConnection(client.connection_id) : null;
  if (!recipients.length || connection?.provider !== 'email') throw failure(NO_ROUTE);
  const report = buildReport(client, period, now), pdf = reportPdf(report, { timeZone: client.timezone });
  if (pdf.length > smtpLimits.attachmentBytes) throw failure(TOO_LARGE);
  let secret; try { secret = openSecret(connection); } catch { throw failure('The email Connection could not be opened. Open it in Alerts and save it again.'); }
  try {
    await sendMail({ ...secret, to: recipients }, { subject: `Backup report: ${report.client}, ${report.period.label}`, text: mailBody(report), attachment: { filename: reportFileName(period), type: 'application/pdf', data: pdf } }, { privateOk: connection.private_ok === 1, id: id() });
  } catch (error) {
    if (error instanceof SmtpError) throw Object.assign(new Error(error.message), { final: error.code === 'too-large' || error.code === 'config' });
    throw new Error('The report could not be sent.');
  }
  return { size: pdf.length, sha256: sha256(pdf) };
}

const iso = ms => new Date(ms).toISOString();
function giveUp(row, client, message, now) {
  db.prepare("UPDATE client_reports SET status='failed',next_attempt_at=NULL,error=? WHERE id=?").run(String(message).slice(0, 200), row.id);
  audit('worker', 'client.report.failed', client?.id ?? row.client_id, { period: row.period_start.slice(0, 10) });
  emit({ type: 'report.failed', key: `occ:report:${row.id}`, at: iso(now), clientName: client?.name ?? 'a client', periodLabel: resolvedLabel(row, client) });
}
const resolvedLabel = (row, client) => { try { return resolvePeriod(row.period_start.slice(0, 10), row.period_end.slice(0, 10), { timeZone: client?.timezone, now: Date.parse(row.created_at) + 1 }).label; } catch { return ''; } };

// One send attempt for one `client_reports` row in status 'sending'.
export async function attempt(row, { now = Date.now() } = {}) {
  const client = db.prepare('SELECT * FROM clients WHERE id=?').get(row.client_id);
  if (!client) { db.prepare("UPDATE client_reports SET status='failed',next_attempt_at=NULL,error='The client was deleted.' WHERE id=?").run(row.id); return 'failed'; }
  // A queued scheduled report is not sent after the owner turned the schedule off.
  if (row.trigger === 'schedule' && client.schedule_enabled !== 1) { db.prepare("UPDATE client_reports SET status='failed',next_attempt_at=NULL,error='The schedule was turned off.' WHERE id=?").run(row.id); return 'failed'; }
  const attempts = row.attempts + 1;
  try {
    const period = resolvePeriod(row.period_start, row.period_end, { timeZone: client.timezone, now: Date.parse(row.created_at) + 1 });
    const result = await emailReport(client, period, { now });
    db.prepare("UPDATE client_reports SET status='sent',attempts=?,next_attempt_at=NULL,size=?,sha256=?,error=NULL,sent_at=? WHERE id=?").run(attempts, result.size, result.sha256, iso(now), row.id);
    audit('worker', 'client.report.sent', client.id, { period: row.period_start, trigger: row.trigger });
    return 'sent';
  } catch (error) {
    const message = String(error?.message ?? 'The report could not be sent.').slice(0, 200);
    db.prepare('UPDATE client_reports SET attempts=? WHERE id=?').run(attempts, row.id);
    if (error?.final || attempts > RETRY_DELAYS_MS.length) { giveUp({ ...row, attempts }, client, message, now); return 'failed'; }
    db.prepare('UPDATE client_reports SET next_attempt_at=?,error=? WHERE id=?').run(iso(now + RETRY_DELAYS_MS[attempts - 1]), message, row.id);
    return 'retry';
  }
}

// Queues the report of the month before `now` for every client that is due, and moves its next_due_at on to the first
// day-1 08:00 after now (an outage never causes a burst of catch-up reports).
export function queueDueReports(now = Date.now()) {
  let queued = 0;
  for (const client of db.prepare("SELECT * FROM clients WHERE schedule_enabled=1 AND next_due_at IS NOT NULL AND next_due_at<=? ORDER BY next_due_at,id LIMIT 50").all(iso(now))) {
    const range = previousMonth(now, client.timezone);
    let period; try { period = resolvePeriod(range.from, range.to, { timeZone: client.timezone, now }); } catch { period = null; }
    db.prepare('UPDATE clients SET next_due_at=? WHERE id=?').run(nextDueAt(now, client.timezone), client.id);
    if (!period || db.prepare("SELECT 1 FROM client_reports WHERE client_id=? AND period_start=? AND trigger='schedule'").get(client.id, period.from)) continue;
    db.prepare("INSERT INTO client_reports(id,client_id,period_start,period_end,trigger,status,attempts,next_attempt_at,created_at) VALUES(?,?,?,?,'schedule','sending',0,?,?)").run(id(), client.id, period.from, period.to, iso(now), iso(now));
    queued += 1;
  }
  return queued;
}

let running = false;
// The worker's tick. Starts at most one pass at a time; the pass sends the due rows one after another.
export function tickClientReports(now = Date.now()) {
  if (running) return null;
  running = true;
  return (async () => {
    try {
      queueDueReports(now);
      for (const row of db.prepare("SELECT * FROM client_reports WHERE status='sending' AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT 5").all(iso(now))) await attempt(row, { now: Date.now() });
    } catch { /* The next tick tries again; nothing here is secret enough to log, and nothing useful to add. */ } finally { running = false; }
  })();
}
