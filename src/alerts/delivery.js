// Alert delivery (docs/alerts.md, docs/alert-channels.md "Delivery, dedup, rate limits and failures"). The detector
// (detect.js) calls `emit`; the worker drains the outbox with `deliverDue`. Each provider (providers/) says what to send;
// this file makes the request. Outbound traffic goes only to https://api.telegram.org (fixed host, no redirects, 10 s
// limit, 64 KB response cap) and to the SMTP host of an Email Connection (src/alerts/smtp.js). Messages are short plain
// text built in events.js. Sealed logins are opened only at the moment of a send and never appear in a log line, an
// audit event or an error.
import { db, id, audit } from '../db.js';
import { messageFor, ruleMatches, DEDUPE_MS, STATE_DEDUPE_MS } from './events.js';
import { enabledRules, getChannel, getCredential, nodeConnection, recordResult, recordCredentialTest, httpError } from './store.js';
import { getConnection, openSecret, recordConnectionSend } from './connections.js';
import { provider } from './providers/index.js';
import { sendMail, SmtpError } from './smtp.js';

// pendingCap: pending items per Connection before new ones fold into one "N more alerts" item. maxAgeMs: an item older
// than that is marked failed without sending; a stale "server unreachable" helps no one.
export const deliveryPolicy = Object.freeze({ attempts: 3, backoffMs: [60_000, 5 * 60_000], batch: 20, keepDays: 7, timeoutMs: 10_000, responseBytes: 64 * 1024, pendingCap: 50, maxAgeMs: 24 * 3600_000 });
export const COLLAPSE_KEY = 'collapse:pending';
export const collapsedText = count => `${count} more ${count === 1 ? 'alert' : 'alerts'}. Open DockNest to see ${count === 1 ? 'it' : 'them'}.`;
// Tests replace `alertHttp.fetch` with a fixture; the timeout and the refusal to follow redirects live here.
export const alertHttp = { fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(deliveryPolicy.timeoutMs) }) };

async function boundedText(response) {
  const reader = response.body?.getReader(); if (!reader) return '';
  const parts = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > deliveryPolicy.responseBytes) { await reader.cancel(); break; } parts.push(value); }
  return Buffer.concat(parts).toString('utf8');
}
class DeliveryError extends Error { constructor(message, final = false) { super(message); this.final = final; } }
const unreadable = () => new DeliveryError('The saved settings cannot be read. Enter them again.');
// The sealed login and the plain destination of a Connection, checked against its provider. Never returned anywhere.
function valuesOf(connection) {
  const item = provider(connection.provider); if (!item) throw new DeliveryError('This channel type is not supported.');
  let secret, settings; try { secret = openSecret(connection); settings = JSON.parse(connection.settings); } catch { throw unreadable(); }
  const destination = item.settingsSchema.safeParse(settings); if (!destination.success) throw unreadable();
  return { item, secret, settings: destination.data };
}
async function request(item, call, verifying = false) {
  let response, body = {};
  try { response = await alertHttp.fetch(`https://${item.target().hosts[0]}${call.path}`, { method: call.method, ...(call.json ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(call.json) } : {}) }); }
  catch { throw new DeliveryError(item.unreachable); } // never the error: its text can carry the URL with the token
  try { body = JSON.parse(await boundedText(response)); } catch { /* not JSON */ }
  const problem = item.explain(response.status, body, { verifying }); if (problem) throw new DeliveryError(problem.message, problem.final);
}
// One message through one Connection. Throws a DeliveryError with a plain, secret-free sentence.
export async function sendWith(connection, text, subject = 'DockNest alert') {
  const { item, secret, settings } = valuesOf(connection);
  if (item.id === 'email') {
    try { await sendMail({ ...secret, to: settings.to }, { subject: `${settings.subjectPrefix ? settings.subjectPrefix + ' ' : ''}${subject}`, text }); }
    catch (error) { throw new DeliveryError(error instanceof SmtpError ? error.message : item.unreachable); }
    return;
  }
  return request(item, item.format({ text, subject }, { ...secret, ...settings }));
}
// One message through one node (2.8 name). A node without a Connection of its provider sends nothing.
export async function sendThrough(row, text, subject = 'DockNest alert') {
  const connection = nodeConnection(row); if (!connection) throw new DeliveryError('Needs a credential. Choose one for this node.');
  return sendWith(connection, text, subject);
}
// Checks a credential's login without sending a message: Telegram getMe, or SMTP connect + encrypt + sign in.
export async function verifyCredential(credentialId, actor) {
  const credential = getCredential(credentialId); if (!credential) throw httpError(404, 'This credential does not exist.');
  try {
    const item = provider(credential.rows[0].provider);
    const secret = (() => { try { return openSecret(credential); } catch { throw unreadable(); } })();
    if (item.id === 'telegram') await request(item, item.verify(secret), true);
    else { try { await sendMail(secret, null); } catch (error) { throw new DeliveryError(error instanceof SmtpError ? error.message : item.unreachable); } }
  } catch (error) { recordCredentialTest(credentialId, false, error instanceof DeliveryError ? error.message : 'The check failed.'); audit(actor, 'alert.credential.test', credentialId, { kind: credential.kind, ok: false }); throw httpError(502, error instanceof DeliveryError ? error.message : 'The check failed.'); }
  recordCredentialTest(credentialId, true); audit(actor, 'alert.credential.test', credentialId, { kind: credential.kind, ok: true });
  return { verified: true };
}
export async function sendTest(channelId, actor) {
  const row = getChannel(channelId); if (!row) throw httpError(404, 'This channel does not exist.');
  try { await sendThrough(row, 'This is a test message from DockNest. Your alerts are connected.', 'DockNest test message'); }
  catch (error) { recordResult(channelId, false, error instanceof DeliveryError ? error.message : null); audit(actor, 'alert.channel.test', channelId, { kind: row.provider, ok: false }); throw httpError(502, error instanceof DeliveryError ? error.message : 'The test message could not be sent.'); }
  recordResult(channelId, true); audit(actor, 'alert.channel.test', channelId, { kind: row.provider, ok: true });
  return { sent: true };
}

// ---- Outbox ------------------------------------------------------------------------------------------------------
// event: see messageFor in events.js, plus `key` (what makes this occurrence unique) and siteId / serverId / targetServerId.
export function emit(event, { at = Date.now() } = {}) {
  const text = messageFor({ ...event, at: event.at ?? new Date(at).toISOString() }); if (!text) return 0;
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
    db.prepare("INSERT INTO alert_outbox(id,connection_id,node_id,event,dedupe_key,message,status,attempts,next_attempt_at,expires_at,created_at) VALUES(?,?,?,?,?,?,'pending',0,?,?,?)").run(id(), connectionId, nodeId, event.type, key, text, at, at + deliveryPolicy.maxAgeMs, created);
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

let draining = false;
export async function deliverDue({ at = Date.now() } = {}) {
  if (draining) return 0;
  draining = true; let sent = 0;
  try {
    const finished = new Date(at).toISOString();
    db.prepare("UPDATE alert_outbox SET status='failed',finished_at=? WHERE status='pending' AND expires_at<=?").run(finished, at);
    const due = db.prepare("SELECT * FROM alert_outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,created_at LIMIT ?").all(at, deliveryPolicy.batch);
    for (const item of due) {
      const connection = getConnection(item.connection_id), attempts = item.attempts + 1;
      // Nothing goes through a Connection that no node uses any more (its nodes were deleted after the item was queued).
      if (!connection || !db.prepare('SELECT 1 FROM alert_nodes WHERE connection_id=? LIMIT 1').get(item.connection_id)) { db.prepare("UPDATE alert_outbox SET status='failed',finished_at=? WHERE id=?").run(finished, item.id); continue; }
      let error = null;
      try { await sendWith(connection, item.message, item.message.split(':')[0].slice(0, 80)); } catch (caught) { error = caught instanceof DeliveryError ? caught : new DeliveryError('The message could not be sent.'); }
      if (!error) { db.prepare("UPDATE alert_outbox SET status='sent',attempts=?,finished_at=? WHERE id=?").run(attempts, finished, item.id); recordConnectionSend(item.connection_id, true); sent++; continue; }
      recordConnectionSend(item.connection_id, false, error.message);
      if (error.final || attempts >= deliveryPolicy.attempts) db.prepare("UPDATE alert_outbox SET status='failed',attempts=?,finished_at=? WHERE id=?").run(attempts, finished, item.id);
      else db.prepare('UPDATE alert_outbox SET attempts=?,next_attempt_at=? WHERE id=?').run(attempts, at + deliveryPolicy.backoffMs[attempts - 1], item.id);
    }
    db.prepare("DELETE FROM alert_outbox WHERE status<>'pending' AND finished_at<?").run(new Date(at - deliveryPolicy.keepDays * 86400_000).toISOString());
  } finally { draining = false; }
  return sent;
}
