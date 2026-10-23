// Alert delivery (docs/alerts.md). The detector (detect.js) calls `emit`; the worker drains the queue with `deliverDue`.
// Outbound traffic goes only to https://api.telegram.org (fixed host, no redirects, 10 s limit, 64 KB response cap) and to
// the SMTP host a channel names (src/alerts/smtp.js). Messages are short plain text built in events.js. Credentials are
// opened only at the moment of a send and never appear in a log line, an audit event or an error.
import { db, id, audit } from '../db.js';
import { messageFor, ruleMatches, DEDUPE_MS, STATE_DEDUPE_MS } from './events.js';
import { enabledRules, getChannel, channelConfig, recordResult, httpError } from './store.js';
import { sendMail, SmtpError } from './smtp.js';

export const deliveryPolicy = Object.freeze({ attempts: 3, backoffMs: [60_000, 5 * 60_000], batch: 20, keepDays: 7, timeoutMs: 10_000, responseBytes: 64 * 1024 });
const TELEGRAM = 'https://api.telegram.org';
// Tests replace `alertHttp.fetch` with a fixture; the timeout and the refusal to follow redirects live here.
export const alertHttp = { fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(deliveryPolicy.timeoutMs) }) };

async function boundedText(response) {
  const reader = response.body?.getReader(); if (!reader) return '';
  const parts = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > deliveryPolicy.responseBytes) { await reader.cancel(); break; } parts.push(value); }
  return Buffer.concat(parts).toString('utf8');
}
class DeliveryError extends Error {}
async function sendTelegram(config, text) {
  let response, body = {};
  try { response = await alertHttp.fetch(`${TELEGRAM}/bot${config.token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: config.chatId, text, disable_web_page_preview: true }) }); }
  catch { throw new DeliveryError('Telegram could not be reached.'); } // never the error: its text can carry the URL with the token
  try { body = JSON.parse(await boundedText(response)); } catch { /* not JSON */ }
  if (response.ok && body.ok !== false) return;
  if (response.status === 401 || response.status === 404) throw new DeliveryError('Telegram does not accept this bot token.');
  if (response.status === 400 || response.status === 403) throw new DeliveryError('Telegram could not deliver to this chat. Open the bot in Telegram and press Start, or add it to the group.');
  if (response.status === 429) throw new DeliveryError('Telegram asked DockNest to slow down.');
  throw new DeliveryError('Telegram refused the message.');
}
async function sendEmail(config, text, subject) {
  try { await sendMail({ ...config, to: config.to }, { subject, text }); }
  catch (error) { throw new DeliveryError(error instanceof SmtpError ? error.message : 'The mail server could not be reached.'); }
}
// One message to one channel. Throws a DeliveryError with a plain, secret-free sentence.
export async function sendThrough(row, text, subject = 'DockNest alert') {
  let config; try { config = channelConfig(row); } catch { throw new DeliveryError('The saved settings of this channel cannot be read. Enter them again.'); }
  if (row.kind === 'telegram') return sendTelegram(config, text);
  if (row.kind === 'email') return sendEmail(config, text, subject);
  throw new DeliveryError('This channel type is not supported.');
}
export async function sendTest(channelId, actor) {
  const row = getChannel(channelId); if (!row) throw httpError(404, 'This channel does not exist.');
  try { await sendThrough(row, 'This is a test message from DockNest. Your alerts are connected.', 'DockNest test message'); }
  catch (error) { recordResult(channelId, false, error.message); audit(actor, 'alert.channel.test', channelId, { kind: row.kind, ok: false }); throw httpError(502, error instanceof DeliveryError ? error.message : 'The test message could not be sent.'); }
  recordResult(channelId, true); audit(actor, 'alert.channel.test', channelId, { kind: row.kind, ok: true });
  return { sent: true };
}

// ---- Queue -------------------------------------------------------------------------------------------------------
// event: see messageFor in events.js, plus `key` (what makes this occurrence unique) and siteId / serverId / targetServerId.
export function emit(event, { at = Date.now() } = {}) {
  const text = messageFor({ ...event, at: event.at ?? new Date(at).toISOString() }); if (!text) return 0;
  const channels = new Set(enabledRules().filter(rule => ruleMatches(rule, event)).map(rule => rule.channel_id));
  const window = STATE_DEDUPE_MS[event.type] ?? DEDUPE_MS, key = `${event.type}:${event.key}`.slice(0, 200);
  let queued = 0;
  for (const channelId of channels) {
    // Keys starting "occ:" name one occurrence (a move state, a release) and are never sent twice. Every other key names
    // an event and its source (for example one site's backups): repeats inside the window are dropped, so a flapping
    // server or a failing schedule cannot flood a phone.
    const since = event.key.startsWith('occ:') ? '0' : new Date(at - window).toISOString();
    if (db.prepare('SELECT 1 FROM alert_queue WHERE channel_id=? AND dedupe_key=? AND created_at>=?').get(channelId, key, since)) continue;
    db.prepare("INSERT INTO alert_queue(id,channel_id,event,dedupe_key,message,status,attempts,next_attempt_at,created_at) VALUES(?,?,?,?,?,'pending',0,?,?)").run(id(), channelId, event.type, key, text, at, new Date(at).toISOString());
    queued++;
  }
  return queued;
}

let draining = false;
export async function deliverDue({ at = Date.now() } = {}) {
  if (draining) return 0;
  draining = true; let sent = 0;
  try {
    const due = db.prepare("SELECT * FROM alert_queue WHERE status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,created_at LIMIT ?").all(at, deliveryPolicy.batch);
    for (const item of due) {
      const channel = getChannel(item.channel_id), attempts = item.attempts + 1;
      let error = null;
      if (!channel) error = new DeliveryError('The channel was removed.');
      else try { await sendThrough(channel, item.message, item.message.split(':')[0].slice(0, 80)); } catch (caught) { error = caught instanceof DeliveryError ? caught : new DeliveryError('The message could not be sent.'); }
      if (!error) { db.prepare("UPDATE alert_queue SET status='sent',attempts=?,finished_at=? WHERE id=?").run(attempts, new Date(at).toISOString(), item.id); recordResult(item.channel_id, true); sent++; continue; }
      if (channel) recordResult(item.channel_id, false, error.message);
      if (!channel || attempts >= deliveryPolicy.attempts) db.prepare("UPDATE alert_queue SET status='failed',attempts=?,finished_at=? WHERE id=?").run(attempts, new Date(at).toISOString(), item.id);
      else db.prepare('UPDATE alert_queue SET attempts=?,next_attempt_at=? WHERE id=?').run(attempts, at + deliveryPolicy.backoffMs[attempts - 1], item.id);
    }
    db.prepare("DELETE FROM alert_queue WHERE status<>'pending' AND finished_at<?").run(new Date(at - deliveryPolicy.keepDays * 86400_000).toISOString());
  } finally { draining = false; }
  return sent;
}
