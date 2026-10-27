// Alert delivery (docs/alerts.md, docs/alert-channels.md "Delivery, dedup, rate limits and failures"). The detector
// (detect.js) calls `emit`; the worker drains the outbox with `deliverDue`. Each provider (providers/) says what to send;
// HTTP requests go only through the guarded client in outbound.js (own DNS check pinned to the socket, HTTPS on 443 to
// public addresses, no redirects, 10 s, 64 KB), and Email through src/alerts/smtp.js. Messages are short plain text built
// in events.js. Sealed logins are opened only at the moment of a send and never appear in a log line, an audit event or
// an error.
import { db, id, audit, transaction } from '../db.js';
import { messageFor, templateFor, messageOf, plainTemplate, testMessage, ruleMatches, DEDUPE_MS, STATE_DEDUPE_MS } from './events.js';
import { enabledRules, getChannel, getCredential, nodeConnection, recordResult, recordCredentialTest, httpError } from './store.js';
import { getConnection, openSecret, recordConnectionSend, privateAllowed } from './connections.js';
import { provider } from './providers/index.js';
import { plainText } from './providers/common.js';
import { sendMail, SmtpError } from './smtp.js';
import { outboundRequest, OutboundError, retryAfterMs, outboundLimits } from './outbound.js';

// pendingCap: pending items per Connection before new ones fold into one "N more alerts" item. maxAgeMs: an item older
// than that is marked failed without sending; a stale "server unreachable" helps no one. rateLimit: messages per
// Connection per rateWindowMs; over that, items wait for the next window. retryAfterMs: the wait after a 429 that names
// none (a 429 never uses up a try; the wait it names is capped at 15 minutes in outbound.js).
export const deliveryPolicy = Object.freeze({ attempts: 3, backoffMs: [60_000, 5 * 60_000], batch: 20, keepDays: 7, timeoutMs: outboundLimits.totalMs, responseBytes: outboundLimits.responseBytes, pendingCap: 50, maxAgeMs: 24 * 3600_000, rateLimit: 20, rateWindowMs: 10 * 60_000, retryAfterMs: 60_000 });
export const COLLAPSE_KEY = 'collapse:pending';
export const collapsedText = count => `${count} more ${count === 1 ? 'alert' : 'alerts'}. Open DockNest to see ${count === 1 ? 'it' : 'them'}.`;
// Every HTTP provider request. Tests replace `alertHttp.fetch` with a fixture (same (url, init) shape, answering a Response).
export const alertHttp = { fetch: (url, init, guard) => outboundRequest(url, init, guard) };

// At most 64 KB of an answer, from the guarded client or from a test's Response.
async function boundedText(response) {
  const reader = response.body?.getReader?.();
  if (!reader) { try { return String(await response.text()).slice(0, deliveryPolicy.responseBytes); } catch { return ''; } }
  const parts = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > deliveryPolicy.responseBytes) { await reader.cancel(); break; } parts.push(value); }
  return Buffer.concat(parts).toString('utf8');
}
// final: not worth retrying (a rejected login, a gone destination). wait: a 429's wait in ms, which uses up no try.
export class DeliveryError extends Error { constructor(message, final = false, wait = null) { super(message); this.final = final; this.wait = wait; } }
const unreadable = () => new DeliveryError('The saved settings cannot be read. Enter them again.');
// The sealed login and the plain destination of a Connection, checked against its provider. Never returned anywhere.
function valuesOf(connection) {
  const item = provider(connection.provider); if (!item) throw new DeliveryError('This channel type is not supported.');
  let secret, settings; try { secret = openSecret(connection); settings = JSON.parse(connection.settings); } catch { throw unreadable(); }
  // The saved login and destination are checked against the provider's schemas at every send, not only at save: a row that
  // no longer passes (a hand-edited database, a rule that got stricter) sends nothing. Email keeps its own 2.8 checks.
  const destination = item.settingsSchema.safeParse(settings); if (!destination.success) throw unreadable();
  if (item.id !== 'email') { const login = item.secretSchema.safeParse(secret); if (!login.success) throw unreadable(); secret = login.data; }
  return { item, secret, settings: destination.data };
}
// What the guarded client may reach for this Connection. A provider with fixed hosts (Telegram, Slack, Discord, Teams,
// Google Chat, Pushover, WhatsApp) may reach those hosts only, on a public address: private addresses are never allowed
// for it, whatever the Connection's `private_ok` says. A provider with a user host (ntfy, Gotify, Matrix, Mattermost,
// Other) reaches any host the Connection's saved URL names, with private addresses only when the Connection is stamped
// `private_ok` and "Allow private network" is on right now. Both are checked again by outbound.js at every send.
export function guardFor(connection, item = provider(connection?.provider), values = {}) {
  const hosts = item?.target?.(values)?.hosts;
  return Array.isArray(hosts) ? { hosts, privateAllowed: false } : { hosts: null, privateAllowed: privateAllowed(connection) };
}
// The URL of a call: a full `url` the provider took from the Connection's saved webhook URL, or the target's base (a fixed
// host, or the saved and validated server of the Connection) plus the call's path. Never built from a guess.
function urlOf(call, target) {
  if (typeof call.url === 'string') return call.url;
  if (typeof target?.base === 'string' && typeof call.path === 'string') return `${target.base}${call.path}`;
  throw unreadable();
}
async function request(item, call, target, guard, verifying = false) {
  let response, body = {}, text = '';
  const headers = { ...(call.headers ?? {}), ...(call.json ? { 'Content-Type': 'application/json' } : {}) };
  const url = urlOf(call, target);
  try { response = await alertHttp.fetch(url, { method: call.method, ...(Object.keys(headers).length ? { headers } : {}), ...(call.json ? { body: JSON.stringify(call.json) } : {}) }, guard); }
  catch (error) { throw new DeliveryError(error instanceof OutboundError && error.code === 'redirect' ? error.message : item.unreachable); } // never the error: its text can carry the URL with the token
  try { text = await boundedText(response); body = JSON.parse(text); } catch { /* not JSON */ }
  const problem = item.explain(response.status, body ?? {}, { verifying, text: text.slice(0, 200) });
  if (response.status === 429) throw new DeliveryError(problem?.message ?? 'The service asked DockNest to slow down.', false, retryAfterMs(response, body ?? {}) ?? deliveryPolicy.retryAfterMs);
  if (problem) throw new DeliveryError(problem.message, problem.final);
  return { status: response.status };
}
// SMTP: a rejected user name or password is final (the provider's 401); everything else may pass with a retry.
const mailError = (error, item) => new DeliveryError(error instanceof SmtpError ? error.message : item.unreachable, error instanceof SmtpError && error.code === 'auth');
// One message through one Connection. Throws a DeliveryError with a plain, secret-free sentence.
// `input` is the structured message (events.js, templateFor); a plain string (2.8 text) is read as a title and a reason.
export async function sendWith(connection, input, subject) {
  const { item, secret, settings } = valuesOf(connection), message = typeof input === 'string' ? { ...plainTemplate(input), ...(subject ? { title: subject } : {}) } : input;
  if (item.id === 'email') {
    // The relay host follows `private_ok` (set by an administrator, or migrated from 2.8): the 2.8 rule; else public only.
    const head = String(message.title || 'DockNest alert').replace(/[\r\n]+/g, ' ').slice(0, 100);
    try { await sendMail({ ...secret, to: settings.to }, { subject: `${settings.subjectPrefix ? settings.subjectPrefix + ' ' : ''}${head}`, text: plainText(message, { title: false }) || head }, { privateOk: connection.private_ok === 1 }); }
    catch (error) { throw mailError(error, item); }
    return;
  }
  const values = { ...secret, ...settings };
  return request(item, item.format(message, values), item.target(values), guardFor(connection, item, values));
}
// One message through one node (2.8 name). A node without a Connection of its provider sends nothing.
export async function sendThrough(row, message, subject) {
  const connection = nodeConnection(row); if (!connection) throw new DeliveryError('Needs a credential. Choose one for this node.');
  return sendWith(connection, message, subject);
}
// Checks a credential's login without sending a message: Telegram getMe, or SMTP connect + encrypt + sign in.
export async function verifyCredential(credentialId, actor) {
  const credential = getCredential(credentialId); if (!credential) throw httpError(404, 'This credential does not exist.');
  try {
    const item = provider(credential.rows[0].provider);
    const secret = (() => { try { return openSecret(credential); } catch { throw unreadable(); } })();
    if (item.id === 'telegram') await request(item, item.verify(secret), item.target(secret), guardFor(credential.rows[0], item, secret), true);
    else { try { await sendMail(secret, null, { privateOk: credential.rows[0].private_ok === 1 }); } catch (error) { throw mailError(error, item); } }
  } catch (error) { recordCredentialTest(credentialId, false, error instanceof DeliveryError ? error.message : 'The check failed.'); audit(actor, 'alert.credential.test', credentialId, { kind: credential.kind, ok: false }); throw httpError(502, error instanceof DeliveryError ? error.message : 'The check failed.'); }
  recordCredentialTest(credentialId, true); audit(actor, 'alert.credential.test', credentialId, { kind: credential.kind, ok: true });
  return { verified: true };
}
export async function sendTest(channelId, actor) {
  const row = getChannel(channelId); if (!row) throw httpError(404, 'This channel does not exist.');
  try { await sendThrough(row, testMessage()); }
  catch (error) { recordResult(channelId, false, error instanceof DeliveryError ? error.message : null); audit(actor, 'alert.channel.test', channelId, { kind: row.provider, ok: false }); throw httpError(502, error instanceof DeliveryError ? error.message : 'The test message could not be sent.'); }
  recordResult(channelId, true); audit(actor, 'alert.channel.test', channelId, { kind: row.provider, ok: true });
  return { sent: true };
}

// ---- Outbox ------------------------------------------------------------------------------------------------------
// event: see messageFor in events.js, plus `key` (what makes this occurrence unique) and siteId / serverId / targetServerId.
export function emit(event, { at = Date.now() } = {}) {
  const stamped = { ...event, at: event.at ?? new Date(at).toISOString() }, text = messageFor(stamped), template = templateFor(stamped); if (!text || !template) return 0;
  const payload = JSON.stringify(template);
  // Dedup per Connection: one message per Connection and event, however many nodes and lines lead to it.
  const targets = new Map();
  for (const rule of enabledRules().filter(rule => ruleMatches(rule, event))) {
    const node = db.prepare('SELECT connection_id FROM alert_nodes WHERE id=?').get(rule.node_id);
    if (node?.connection_id && !targets.has(node.connection_id)) targets.set(node.connection_id, rule.node_id);
  }
  const window = STATE_DEDUPE_MS[event.type] ?? DEDUPE_MS, key = `${event.type}:${event.key}`.slice(0, 200), created = new Date(at).toISOString();
  let queued = 0;
  for (const [connectionId, nodeId] of targets) {
    // Keys starting "occ:" name one occurrence (a move state, a release) and are never sent twice. Every other key names
    // an event and its source (for example one site's backups): repeats inside the window are dropped, so a flapping
    // server or a failing schedule cannot flood a phone.
    const since = event.key.startsWith('occ:') ? '0' : new Date(at - window).toISOString();
    if (db.prepare('SELECT 1 FROM alert_outbox WHERE connection_id=? AND dedupe_key=? AND created_at>=?').get(connectionId, key, since)) continue;
    const pending = db.prepare("SELECT COUNT(*) AS n FROM alert_outbox WHERE connection_id=? AND status='pending' AND dedupe_key<>?").get(connectionId, COLLAPSE_KEY).n;
    if (pending >= deliveryPolicy.pendingCap) { fold(connectionId, nodeId, event.type, key, text, at); queued++; continue; }
    db.prepare("INSERT INTO alert_outbox(id,connection_id,node_id,event,dedupe_key,message,payload,status,attempts,next_attempt_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,'pending',0,?,?,?)").run(id(), connectionId, nodeId, event.type, key, text, payload, at, at + deliveryPolicy.maxAgeMs, created);
    queued++;
  }
  return queued;
}
// Over the cap, new items are not stored one by one: one pending item per Connection counts them, updated in place.
// Each folded event still leaves a dedup entry (status 'sent', payload { foldedInto }), so a repeat inside its window is
// not counted again. These entries are never delivered on their own (only pending items are) and are pruned like any.
function fold(connectionId, nodeId, type, key, text, at) {
  const item = db.prepare("SELECT id,payload FROM alert_outbox WHERE connection_id=? AND status='pending' AND dedupe_key=?").get(connectionId, COLLAPSE_KEY);
  let count = 1; try { count = (JSON.parse(item?.payload ?? '{}').collapsed ?? 0) + 1; } catch { /* restart the count */ }
  const created = new Date(at).toISOString(), collapseId = item?.id ?? id();
  if (item) db.prepare('UPDATE alert_outbox SET message=?,payload=? WHERE id=?').run(collapsedText(count), JSON.stringify({ collapsed: count }), item.id);
  else db.prepare("INSERT INTO alert_outbox(id,connection_id,node_id,event,dedupe_key,message,payload,status,attempts,next_attempt_at,expires_at,created_at) VALUES(?,?,?,'alerts.collapsed',?,?,?,'pending',0,?,?,?)").run(collapseId, connectionId, nodeId, COLLAPSE_KEY, collapsedText(count), JSON.stringify({ collapsed: count }), at, at + deliveryPolicy.maxAgeMs, created);
  db.prepare("INSERT INTO alert_outbox(id,connection_id,node_id,event,dedupe_key,message,payload,status,attempts,next_attempt_at,expires_at,created_at,finished_at) VALUES(?,?,?,?,?,?,?,'sent',0,?,?,?,?)").run(id(), connectionId, nodeId, type, key, text, JSON.stringify({ foldedInto: collapseId }), at, at + deliveryPolicy.maxAgeMs, created, created);
}

// Rate limit per Connection: real deliveries (attempts > 0; folded dedup entries have none) in the last window. Returns
// when the next window opens, or null while there is room.
function rateLimited(connectionId, at) {
  const row = db.prepare("SELECT COUNT(*) AS n, MIN(finished_at) AS first FROM alert_outbox WHERE connection_id=? AND status='sent' AND attempts>0 AND finished_at>?").get(connectionId, new Date(at - deliveryPolicy.rateWindowMs).toISOString());
  return row.n >= deliveryPolicy.rateLimit ? Date.parse(row.first) + deliveryPolicy.rateWindowMs : null;
}
// Marks an item sent only if it is still what was sent. The "N more alerts" item can grow while its send is in flight
// (emit folds into it in place); then only the part that was sent is done, and the rest stays pending as a smaller count.
function markSent(item, attempts, finished, at) {
  const changes = db.prepare("UPDATE alert_outbox SET status='sent',attempts=?,finished_at=? WHERE id=? AND status='pending' AND message IS ? AND payload IS ?").run(attempts, finished, item.id, item.message, item.payload).changes;
  if (changes || item.dedupe_key !== COLLAPSE_KEY) return;
  transaction(() => {
    const now = db.prepare("SELECT payload FROM alert_outbox WHERE id=? AND status='pending'").get(item.id); if (!now) return;
    const count = payload => { try { return Number(JSON.parse(payload ?? '{}').collapsed) || 0; } catch { return 0; } };
    const rest = count(now.payload) - count(item.payload);
    if (rest <= 0) db.prepare("UPDATE alert_outbox SET status='sent',attempts=?,finished_at=? WHERE id=?").run(attempts, finished, item.id);
    else db.prepare('UPDATE alert_outbox SET message=?,payload=?,attempts=0,next_attempt_at=? WHERE id=?').run(collapsedText(rest), JSON.stringify({ collapsed: rest }), at, item.id);
  });
}

let draining = false;
export async function deliverDue({ at = Date.now() } = {}) {
  if (draining) return 0;
  draining = true; let sent = 0;
  try {
    const finished = new Date(at).toISOString();
    db.prepare("UPDATE alert_outbox SET status='failed',finished_at=? WHERE status='pending' AND expires_at<=?").run(finished, at);
    const due = db.prepare("SELECT * FROM alert_outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,created_at LIMIT ?").all(at, deliveryPolicy.batch);
    const held = new Set(); // Connections that asked to slow down (429) or are over their rate limit in this run
    for (const item of due) {
      if (held.has(item.connection_id)) continue;
      const connection = getConnection(item.connection_id), attempts = item.attempts + 1;
      // Nothing goes through a Connection that no node uses any more (its nodes were deleted after the item was queued).
      if (!connection || !db.prepare('SELECT 1 FROM alert_nodes WHERE connection_id=? LIMIT 1').get(item.connection_id)) { db.prepare("UPDATE alert_outbox SET status='failed',finished_at=? WHERE id=?").run(finished, item.id); continue; }
      // Over the limit: this Connection's items wait for the next window, without using up a try.
      const opens = rateLimited(item.connection_id, at);
      if (opens !== null) { db.prepare("UPDATE alert_outbox SET next_attempt_at=? WHERE connection_id=? AND status='pending' AND next_attempt_at<?").run(opens, item.connection_id, opens); held.add(item.connection_id); continue; }
      let error = null;
      try { await sendWith(connection, messageOf(item)); } catch (caught) { error = caught instanceof DeliveryError ? caught : new DeliveryError('The message could not be sent.'); }
      if (!error) { markSent(item, attempts, finished, at); recordConnectionSend(item.connection_id, true); sent++; continue; }
      recordConnectionSend(item.connection_id, false, error.message);
      // 429: the provider's wait (capped), no try used up; the Connection's other pending items wait as long.
      if (error.wait !== null) { const next = at + error.wait; db.prepare("UPDATE alert_outbox SET next_attempt_at=? WHERE connection_id=? AND status='pending' AND next_attempt_at<?").run(next, item.connection_id, next); held.add(item.connection_id); continue; }
      if (error.final || attempts >= deliveryPolicy.attempts) db.prepare("UPDATE alert_outbox SET status='failed',attempts=?,finished_at=? WHERE id=?").run(attempts, finished, item.id);
      else db.prepare('UPDATE alert_outbox SET attempts=?,next_attempt_at=? WHERE id=?').run(attempts, at + deliveryPolicy.backoffMs[attempts - 1], item.id);
    }
    db.prepare("DELETE FROM alert_outbox WHERE status<>'pending' AND finished_at<?").run(new Date(at - deliveryPolicy.keepDays * 86400_000).toISOString());
  } finally { draining = false; }
  return sent;
}
