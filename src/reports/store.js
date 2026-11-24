// Clients and their sealed recipients (docs/client-reports.md, decisions 1 and 8).
// - Recipients are one sealed JSON list (master key, `seal`), at most 3 addresses. The API only ever shows them masked
//   (a***@example.com); the full list is opened only to send a report, and never reaches a log, a job text or an audit row
//   (the audit row holds a SHA-256 of each address).
// - A viewer sees the client, its apps and the report settings that shape the PDF, but no recipients and no schedule.
import { createHmac } from 'node:crypto';
import { db, id, audit, transaction } from '../db.js';
import { seal, open, key } from '../crypto.js';
import { mailbox } from '../alerts/smtp.js';
import { INCLUDE_DEFAULTS, includeOf, ACCENTS } from './client.js';
import { nextDueAt, validZone } from './period.js';

export const MAX_RECIPIENTS = 3, MAX_CLIENTS = 200;
const httpError = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
export const maskAddress = address => { const [local, domain] = String(address).split('@'); return `${local.slice(0, 1)}***@${domain}`; };
// Audit digest: HMAC-SHA256 under a key derived from the master key (domain-separated), so a leaked audit log cannot be
// checked against a list of guessed addresses without the master key.
export const digest = address => createHmac('sha256', createHmac('sha256', key()).update('client-report-audit').digest()).update(String(address).toLowerCase()).digest('hex').slice(0, 16);
// Normal form of a list the owner typed: valid, unique (case-insensitive), at most 3.
export function cleanRecipients(list) {
  const seen = new Set(), clean = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const address = mailbox(raw);
    if (!address) throw httpError(400, 'Enter plain email addresses, for example client@example.com.');
    if (!seen.has(address.toLowerCase())) { seen.add(address.toLowerCase()); clean.push(address); }
  }
  if (clean.length > MAX_RECIPIENTS) throw httpError(400, `A report goes to at most ${MAX_RECIPIENTS} addresses.`);
  return clean;
}
export function sealRecipients(list) {
  const stored = list.length ? JSON.stringify({ sealed: seal(JSON.stringify(list)) }) : '[]';
  if (stored.length > 1024) throw httpError(400, 'Those addresses are too long to store. Use shorter ones.');
  return stored;
}
export function openRecipients(row) {
  try { const stored = JSON.parse(row.recipients || '[]'); return stored.sealed ? JSON.parse(open(stored.sealed)) : []; } catch { return []; }
}
export const recipientsView = row => openRecipients(row).map(maskAddress);

export const appIdsOf = clientId => db.prepare('SELECT site_id FROM client_apps WHERE client_id=? ORDER BY site_id').all(clientId).map(row => row.site_id);
export const getClient = clientId => db.prepare('SELECT * FROM clients WHERE id=?').get(clientId) ?? null;
// role 'admin' (and 'operator') see everything; a viewer never sees recipients, the schedule or the email Connection.
export function clientView(row, role = 'admin') {
  const base = { id: row.id, name: row.name, agency: row.agency, contact: row.contact, accent: row.accent ?? 'default', include: includeOf(row.include), apps: appIdsOf(row.id), timezone: row.timezone, createdAt: row.created_at, updatedAt: row.updated_at };
  if (role === 'viewer') return base;
  const last = db.prepare("SELECT period_start,period_end,status,trigger,size,sent_at,error,created_at FROM client_reports WHERE client_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(row.id) ?? null;
  return { ...base, schedule: { enabled: row.schedule_enabled === 1, connectionId: row.connection_id, nextDueAt: row.schedule_enabled === 1 ? row.next_due_at : null }, recipients: recipientsView(row), lastReport: last && { periodStart: last.period_start, periodEnd: last.period_end, status: last.status, trigger: last.trigger, size: last.size, sentAt: last.sent_at, error: last.error, createdAt: last.created_at } };
}
export const listClients = role => db.prepare('SELECT * FROM clients ORDER BY name COLLATE NOCASE,id').all().map(row => clientView(row, role));

function checkApps(apps) {
  const unique = [...new Set(apps)];
  const known = new Set(db.prepare('SELECT id FROM sites WHERE id NOT IN (SELECT site_id FROM site_archives)').all().map(row => row.id));
  if (unique.some(siteId => !known.has(siteId))) throw httpError(400, 'One of the chosen apps no longer exists. Reload and choose again.');
  return unique;
}
function checkConnection(connectionId) {
  if (connectionId === null || connectionId === undefined) return null;
  const row = db.prepare('SELECT provider FROM connections WHERE id=?').get(connectionId);
  if (!row || row.provider !== 'email') throw httpError(400, 'Choose an email Connection to send reports through.');
  return connectionId;
}
const clip = (value, max) => { const text = String(value ?? '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim(); return text ? text.slice(0, max) : null; };

// input: validated by the route. `recipients` (array) is present only when the caller was re-verified for it.
export function saveClient(input, { actor, existing = null, now = Date.now() }) {
  const timezone = input.timezone ?? existing?.timezone ?? 'UTC';
  if (!validZone(timezone)) throw httpError(400, 'Choose a valid time zone.');
  const apps = input.apps === undefined ? null : checkApps(input.apps);
  const connectionId = input.connectionId === undefined ? (existing?.connection_id ?? null) : checkConnection(input.connectionId);
  const recipients = input.recipients === undefined ? null : cleanRecipients(input.recipients);
  const enabled = input.scheduleEnabled ?? existing?.schedule_enabled === 1;
  const effectiveRecipients = recipients ?? (existing ? openRecipients(existing) : []);
  if (enabled && (!connectionId || !effectiveRecipients.length)) throw httpError(400, 'Choose an email Connection and at least one recipient before turning the schedule on.');
  const at = new Date(now).toISOString();
  return transaction(() => {
    if (!existing && db.prepare('SELECT COUNT(*) AS n FROM clients').get().n >= MAX_CLIENTS) throw httpError(409, `DockNest keeps at most ${MAX_CLIENTS} clients.`);
    const clientId = existing?.id ?? id();
    const include = JSON.stringify(includeOf({ ...INCLUDE_DEFAULTS, ...(existing ? includeOf(existing.include) : {}), ...(input.include ?? {}) }));
    const accent = input.accent === undefined ? (existing?.accent ?? null) : (input.accent && ACCENTS.includes(input.accent) ? input.accent : null);
    const due = enabled ? (existing?.schedule_enabled === 1 && existing.timezone === timezone && existing.next_due_at ? existing.next_due_at : nextDueAt(now, timezone)) : null;
    const values = [input.name ?? existing?.name, input.agency === undefined ? existing?.agency ?? null : clip(input.agency, 80), input.contact === undefined ? existing?.contact ?? null : clip(input.contact, 120), accent, include, enabled ? 1 : 0, timezone, connectionId, recipients ? sealRecipients(recipients) : existing?.recipients ?? '[]', due];
    if (existing) db.prepare('UPDATE clients SET name=?,agency=?,contact=?,accent=?,include=?,schedule_enabled=?,timezone=?,connection_id=?,recipients=?,next_due_at=?,updated_at=? WHERE id=?').run(...values, at, clientId);
    else db.prepare('INSERT INTO clients(name,agency,contact,accent,include,schedule_enabled,timezone,connection_id,recipients,next_due_at,id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...values, clientId, at, at);
    if (apps) { db.prepare('DELETE FROM client_apps WHERE client_id=?').run(clientId); for (const siteId of apps) db.prepare('INSERT INTO client_apps(client_id,site_id) VALUES(?,?)').run(clientId, siteId); }
    audit(actor, existing ? 'client.update' : 'client.create', clientId, { fields: Object.keys(input).filter(key => key !== 'recipients').sort(), ...(recipients ? { recipients: recipients.map(digest) } : {}) });
    return getClient(clientId);
  });
}
export function deleteClient(clientId, actor) {
  return transaction(() => { const gone = db.prepare('DELETE FROM clients WHERE id=?').run(clientId).changes; if (gone) audit(actor, 'client.delete', clientId, {}); return gone > 0; });
}
