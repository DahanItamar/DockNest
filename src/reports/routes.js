// Client report API (docs/client-reports.md "API"):
// - GET/POST /api/clients, GET/PUT/DELETE /api/clients/:id: administrators only to change; recipients (and nothing else
//   that sends mail anywhere new) need a recent re-verification. Other roles may list and open clients, without
//   recipients or schedule.
// - GET /api/clients/:id/report?from&to: the summary as JSON for the in-page preview.
// - POST /api/clients/:id/report.pdf { from, to }: the PDF download, built in memory, `Cache-Control: no-store`, never
//   written to disk. Audit `client.report` with the client id and period, never the content.
// - POST /api/clients/:id/report/send-test: e-mails last month's report to the recipients now (administrators).
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, recentlyVerified, rateLimit } from '../auth.js';
import { db, id, audit } from '../db.js';
import { buildReport, reportPdf, ACCENTS } from './client.js';
import { resolvePeriod, previousMonth } from './period.js';
import { saveClient, deleteClient, getClient, clientView, listClients, MAX_RECIPIENTS } from './store.js';
import { emailReport, sha256, reportFileName } from './send.js';

const MAX_APPS = 200;
const text = max => z.string().max(max);
const fields = {
  agency: text(80).nullable(), contact: text(120).nullable(), accent: z.enum(ACCENTS).nullable(),
  include: z.object({ serverNames: z.boolean(), findingTitles: z.boolean() }).partial().strict(),
  apps: z.array(z.uuid()).max(MAX_APPS), timezone: text(64), scheduleEnabled: z.boolean(), connectionId: z.uuid().nullable(),
  recipients: z.array(text(254)).max(MAX_RECIPIENTS, `A report goes to at most ${MAX_RECIPIENTS} addresses.`),
};
const createSchema = z.object({ name: z.string().trim().min(1, 'Give the client a name.').max(80), ...Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, schema.optional()])) }).strict();
const updateSchema = createSchema.partial().strict();
const periodSchema = z.object({ from: z.string(), to: z.string() }).strict();
const roleOf = req => (req.user?.role === 'admin' ? 'admin' : 'viewer');
const reverify = res => res.status(403).json({ error: 'Verify your own authenticator or recovery code before this change.', code: 'REAUTH_REQUIRED' });
const missing = res => res.status(404).json({ error: 'Client not found.' });
const failed = () => Object.assign(new Error('The report could not be created. Nothing was saved. Try again.'), { status: 500 });

export const clientRoutes = Router();
clientRoutes.get('/', (req, res) => res.json({ clients: listClients(roleOf(req)) }));
clientRoutes.post('/', requireAdmin, rateLimit('clients-write', 60), (req, res) => {
  const input = createSchema.parse(req.body);
  if (input.recipients?.length && !recentlyVerified(req)) return reverify(res);
  res.status(201).json(clientView(saveClient(input, { actor: req.user.id }), 'admin'));
});
clientRoutes.get('/:id', (req, res) => { const row = getClient(req.params.id); return row ? res.json(clientView(row, roleOf(req))) : missing(res); });
clientRoutes.put('/:id', requireAdmin, rateLimit('clients-write', 60), (req, res) => {
  const row = getClient(req.params.id); if (!row) return missing(res);
  const input = updateSchema.parse(req.body);
  if (input.recipients !== undefined && !recentlyVerified(req)) return reverify(res);
  res.json(clientView(saveClient(input, { actor: req.user.id, existing: row }), 'admin'));
});
clientRoutes.delete('/:id', requireAdmin, (req, res) => deleteClient(req.params.id, req.user.id) ? res.json({ deleted: true }) : missing(res));

// The period of a request, in the client's own time zone.
const periodOf = (client, from, to) => resolvePeriod(from, to, { timeZone: client.timezone });
clientRoutes.get('/:id/report', rateLimit('clients-report', 60), (req, res) => {
  const client = getClient(req.params.id); if (!client) return missing(res);
  const { from, to } = periodSchema.parse(req.query);
  res.set('Cache-Control', 'no-store').json(buildReport(client, periodOf(client, from, to)));
});
clientRoutes.post('/:id/report.pdf', rateLimit('clients-report', 30), (req, res) => {
  const client = getClient(req.params.id); if (!client) return missing(res);
  const { from, to } = periodSchema.parse(req.body), period = periodOf(client, from, to), madeAt = Date.now();
  let pdf;
  try { pdf = reportPdf(buildReport(client, period, madeAt), { timeZone: client.timezone }); } catch (error) { throw error.status === 413 ? error : failed(); }
  db.prepare("INSERT INTO client_reports(id,client_id,period_start,period_end,trigger,status,attempts,size,sha256,created_at) VALUES(?,?,?,?,'manual','made',0,?,?,?)").run(id(), client.id, from, to, pdf.length, sha256(pdf), new Date(madeAt).toISOString());
  audit(req.user.id, 'client.report', client.id, { from, to });
  res.set('Cache-Control', 'no-store').attachment(reportFileName(period)).type('application/pdf').send(pdf);
});
clientRoutes.post('/:id/report/send-test', requireAdmin, rateLimit('clients-send', 10), async (req, res) => {
  const client = getClient(req.params.id); if (!client) return missing(res);
  const range = previousMonth(Date.now(), client.timezone), period = periodOf(client, range.from, range.to), rowId = id(), at = new Date().toISOString();
  db.prepare("INSERT INTO client_reports(id,client_id,period_start,period_end,trigger,status,attempts,created_at) VALUES(?,?,?,?,'manual','sending',1,?)").run(rowId, client.id, period.from, period.to, at);
  try {
    const result = await emailReport(client, period);
    db.prepare("UPDATE client_reports SET status='sent',size=?,sha256=?,sent_at=? WHERE id=?").run(result.size, result.sha256, new Date().toISOString(), rowId);
    audit(req.user.id, 'client.report.send_test', client.id, { from: period.from, to: period.to });
    res.json({ sent: true, period: period.label });
  } catch (error) {
    const message = String(error?.message ?? 'The report could not be sent.').slice(0, 200);
    db.prepare("UPDATE client_reports SET status='failed',error=? WHERE id=?").run(message, rowId);
    res.status(error?.final ? 409 : 502).json({ error: message });
  }
});
