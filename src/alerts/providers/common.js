// Shared helpers for the provider files (docs/alert-channels.md, "Message template" and "Providers"). Pure functions: no
// network, no database. A provider turns the one message `{ title, site, server, reason, time, url, event, at }` into its
// own request; these helpers clean the text, cut it to a limit, escape it for a markup and judge a saved URL or host.
import { z } from 'zod';
import { isIP } from 'node:net';
import { classify, nameRefused } from '../addresses.js';

export const freeze = Object.freeze;
export const field = value => Object.freeze(value);

// ---- Text ---------------------------------------------------------------------------------------------------------
// One clean line: control characters and line breaks become a space, and bidi overrides and isolates (U+202A-202E,
// U+2066-2069) are dropped. Text is never altered otherwise (Hebrew and other right-to-left text pass through untouched).
export const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;
export const line = (value, fallback = '') => String(value ?? '').replace(BIDI_CONTROLS, '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim() || fallback;
const ELLIPSIS = '\u2026';
// Cut to at most `limit` UTF-16 units without splitting a surrogate pair, ending in an ellipsis when something was cut.
export function cut(text, limit) {
  const value = String(text ?? ''); if (value.length <= limit) return value;
  let out = '';
  for (const char of value) { if (out.length + char.length > limit - 1) break; out += char; }
  return `${out.trimEnd()}${ELLIPSIS}`;
}
// The same for a byte limit (ntfy counts UTF-8 bytes).
export function cutBytes(text, limit) {
  const value = String(text ?? ''); if (Buffer.byteLength(value) <= limit) return value;
  let out = '', size = 0;
  for (const char of value) { const bytes = Buffer.byteLength(char); if (size + bytes > limit - 3) break; out += char; size += bytes; }
  return `${out.trimEnd()}${ELLIPSIS}`;
}
// Failures that deserve a loud notification (ntfy priority 4, Pushover priority 1, Gotify 8).
export const URGENT_EVENTS = freeze(['backup.failed', 'server.unreachable', 'server.disk_low', 'restore_test.failed', 'restore_test.couldnt_run']);
export const urgent = message => URGENT_EVENTS.includes(message?.event);

// The message as clean single-line parts: `where` is "site on server" (either may be missing).
export function parts(message) {
  const site = line(message?.site), server = line(message?.server), time = line(message?.time), url = typeof message?.url === 'string' && /^https?:\/\/\S+$/.test(message.url) ? message.url : '';
  const where = site && server ? `${site} on ${server}` : site || server;
  return { title: line(message?.title, 'DockNest alert'), where: where && time ? `${where} at ${time}` : where, reason: line(message?.reason), url, event: line(message?.event), at: line(message?.at) };
}
// `link: null` leaves the link out (a provider with its own link field).
// Plain text for Telegram, Email, ntfy, Gotify, Pushover and the free-form WhatsApp fallback: up to four short lines.
export function plainText(message, { title = true, link = 'Open the job' } = {}) {
  if (message?.event === 'plain' && message.text) return line(message.text); // a 2.8 item or "N more alerts": the text it has
  const { title: head, where, reason, url } = parts(message);
  return [title ? head : '', where, reason, url && link ? `${link}: ${url}` : ''].filter(Boolean).join('\n');
}
// One sentence, the 2.8 style: "Backup failed: shop on srv at 03:00 UTC. Reason." (Other's `message`).
export function plainLine(message) {
  const { title, where, reason } = parts(message);
  return `${title}${where ? `: ${where}` : ''}${reason ? `${where ? '. ' : ': '}${reason}` : ''}`.replace(/\.\.+$/, '.');
}

// ---- Escaping -----------------------------------------------------------------------------------------------------
export const slackEscape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const htmlEscape = text => slackEscape(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// A zero-width space after @ keeps @everyone, @channel, @here and @room from being a mention.
export const noMention = text => String(text).replace(/@/g, '@\u200b');
// CommonMark, Discord and Mattermost treat a backslash before ASCII punctuation as an escape. A hyphen, plus or number
// followed by a dot only means something at the start of a line (a list), so only there.
export const markdownEscape = text => noMention(String(text).replace(/[\\`*_[\]()#<>~|]/g, "\\$&").replace(/^([-+])/gm, "\\$1").replace(/^(\d+)\.(?= |$)/gm, "$1\\."));

// ---- Failures -----------------------------------------------------------------------------------------------------
export const ok = status => status >= 200 && status < 300;
// The shared answer to an HTTP failure, as one fixed sentence (never the provider's own text, which may echo secrets).
// A rejected login or a gone destination, and any other 4xx, is final: retrying the same request cannot help. 408 and
// 5xx may pass with a retry. 429 is handled by the core (the wait the provider names, no try used up).
export function failure(label, status, { login = [401, 403], gone = [404, 410], loginText, goneText, otherText } = {}) {
  if (ok(status)) return null;
  if (status === 429) return { message: `${label} asked DockNest to slow down.`, final: false };
  if (login.includes(status)) return { message: loginText ?? `${label} does not accept this login.`, final: true };
  if (gone.includes(status)) return { message: goneText ?? `${label} could not find the destination. Check the address.`, final: true };
  if (status >= 400 && status < 500 && status !== 408) return { message: otherText ?? `${label} refused the message.`, final: true };
  return { message: `${label} is not answering right now.`, final: false };
}

// ---- Addresses ----------------------------------------------------------------------------------------------------
// The static part of the address policy, for validation at save: a name that is refused outright, or an IP literal that
// is never reachable. Private addresses pass here: whether one may be used depends on who saves it and on the admin
// setting (connections.js, privateOkFor), and every send checks it again in outbound.js.
export function hostProblem(host) {
  const name = String(host ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!name) return 'Enter a server address.';
  if (name.endsWith('.')) return 'Remove the dot at the end of the server name.';
  if (nameRefused(name)) return 'DockNest does not send to this address.';
  if (isIP(name) && classify(name) === 'refused') return 'DockNest does not send to this address.';
  return null;
}
// A URL as DockNest keeps it, or a problem sentence. `https` only unless `allowHttp` (a private server may speak plain
// HTTP; outbound.js decides at every send whether that is allowed). No user name, password or fragment.
export function readUrl(value, { allowHttp = false, label = 'address' } = {}) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 2048) return { problem: `Enter the ${label}.` };
  let url; try { url = new URL(text); } catch { return { problem: `Enter the full ${label}, starting with https://.` }; }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) return { problem: `The ${label} must start with https://.` };
  if (url.username || url.password) return { problem: `The ${label} must not contain a user name or password.` };
  if (text.includes('#') || url.hash) return { problem: `The ${label} must not contain a # part.` };
  const problem = hostProblem(url.hostname); if (problem) return { problem };
  return { url };
}
// A zod string that must pass `check(url) -> sentence | null` and is kept as `keep(url)`.
export const urlField = ({ label = 'address', allowHttp = false, check = () => null, keep = url => url.href } = {}) => z.string().max(2048).transform((value, ctx) => {
  const read = readUrl(value, { allowHttp, label });
  const problem = read.problem ?? check(read.url);
  if (problem) { ctx.issues.push({ code: 'custom', message: problem, input: value }); return z.NEVER; }
  return keep(read.url);
});
// A server (ntfy, Gotify, Matrix homeserver): origin plus an optional path, no query, no trailing slash.
export const serverUrl = label => urlField({
  label, allowHttp: true,
  check: url => (url.search ? `The ${label} must not contain a ? part.` : null),
  keep: url => `${url.origin}${url.pathname.replace(/\/+$/, '')}`,
});
export const topicName = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Use letters, digits, - and _ only (up to 64).');
