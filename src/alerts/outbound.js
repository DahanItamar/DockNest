// The one guarded HTTP client for alerts (docs/alert-channels.md, "Outbound safety"). Every HTTP provider sends through
// `outboundRequest`; nothing else in alerts opens an HTTP connection or calls fetch.
// - HTTPS on port 443 to public addresses. Plain HTTP or another port only when the caller allows private addresses (an
//   admin-saved Connection with `private_ok` while "Allow private network" is on) and every address of the host is private.
// - The name is resolved once here, every answer is classified (addresses.js), and the socket gets only those checked
//   answers through a pinned `lookup`, so a DNS answer that changes between check and connect is never used. IP literals
//   skip `lookup` in Node, so they are classified here before any connection. The TLS name stays the host name.
// - A fresh Agent per request with no proxy: HTTP(S)_PROXY and NODE_USE_ENV_PROXY never apply, so no proxy resolves names.
// - Redirects are never followed (a 3xx is a failure), 10 seconds for the whole request including DNS, request body at
//   most 16 KB, response read at most 64 KB and then the connection dropped. TLS 1.2 or newer, certificates verified
//   against Node's bundled CA store.
// - Errors are fixed sentences. Node's own error text can carry the URL (and with it a token), so it is never passed on.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { classify, nameRefused } from './addresses.js';

// Tests shorten totalMs; nothing else changes these.
export const outboundLimits = { totalMs: 10_000, requestBytes: 16 * 1024, responseBytes: 64 * 1024, urlChars: 2048, maxRetryAfterMs: 15 * 60_000, minRetryAfterMs: 1_000 };
const sentences = Object.freeze({
  url: 'The address is not valid.',
  blocked: 'DockNest does not send to this address.',
  dns: 'The server name could not be found.',
  timeout: 'The server did not answer in time.',
  tls: 'The server certificate could not be verified.',
  network: 'The server could not be reached.',
  redirect: 'The server answered with a redirect. Paste the final URL.',
  'too-large': 'The message is too large to send.',
});
export class OutboundError extends Error { constructor(code) { super(sentences[code] ?? sentences.network); this.code = sentences[code] ? code : 'network'; } }

// Test seams, like smtpIo: `resolve` answers [{ address, family }]; `dial` maps a checked address and port to the ones
// the socket connects to (identity in production; tests point a public-looking address at a local fake server); `ca`
// adds a trust root for that server's certificate. There is no setting or API for any of them.
export const outboundIo = {
  resolve: host => dns.lookup(host, { all: true, verbatim: true }),
  dial: (address, port) => ({ address, port }),
  ca: undefined,
};

// The URL rules that need no DNS. Returns the parsed URL, or throws an OutboundError.
// guard: { hosts: [names] | null (any host), privateAllowed: boolean }. A host list entry is an exact name, or `*.suffix` for
// any name below it (Teams Workflows).
export function checkUrl(value, { hosts = null, privateAllowed = false } = {}) {
  if (typeof value !== 'string' || value.length > outboundLimits.urlChars || value.includes('#')) throw new OutboundError('url');
  let url; try { url = new URL(value); } catch { throw new OutboundError('url'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || !url.hostname) throw new OutboundError('url');
  if (url.protocol === 'http:' && !privateAllowed) throw new OutboundError('blocked');
  if (url.port && url.port !== '443' && !privateAllowed) throw new OutboundError('blocked');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host.endsWith('.')) throw new OutboundError('url'); // a trailing dot is the same name to DNS but not to a host list or a certificate
  if (Array.isArray(hosts) && !hosts.some(entry => (entry.startsWith('*.') ? host.length > entry.length - 1 && host.endsWith(entry.slice(1)) : host === entry))) throw new OutboundError('blocked');
  if (nameRefused(host)) throw new OutboundError('blocked');
  // A host that looks numeric but is not a valid literal (the URL parser rewrites every valid IPv4 notation) is refused.
  if (!isIP(host) && /^[0-9a-fx.]+$/i.test(host) && /^(?:0x[0-9a-f]*|\d+)(?:\.(?:0x[0-9a-f]*|\d+))*\.?$/i.test(host)) throw new OutboundError('url');
  if (isIP(host)) { const kind = classify(host); if (kind === 'refused' || (kind === 'private' && !privateAllowed)) throw new OutboundError('blocked'); }
  return url;
}

// Classifies every answer. Refused: any refused answer, a mix of public and private answers, or private answers
// without permission. Returns whether the target is private (every answer private).
export function checkAnswers(answers, privateAllowed) {
  if (!Array.isArray(answers) || !answers.length) throw new OutboundError('dns');
  const kinds = new Set(answers.map(answer => classify(answer?.address)));
  if (kinds.has('refused') || kinds.size !== 1) throw new OutboundError('blocked');
  if (kinds.has('private') && !privateAllowed) throw new OutboundError('blocked');
  return kinds.has('private');
}

// Hands the socket only the checked answers, as Node's `lookup` contract wants them (`all: true` or one address).
export const pinnedLookup = (expected, answers) => (hostname, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {}; }
  const family = typeof options === 'number' ? options : Number(options?.family) || 0;
  const list = answers.filter(answer => !family || answer.family === family);
  if (String(hostname).toLowerCase() !== expected || !list.length) return process.nextTick(callback, Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
  if (options?.all) return process.nextTick(callback, null, list.map(answer => ({ ...answer })));
  process.nextTick(callback, null, list[0].address, list[0].family);
};

const tlsProblem = error => /CERT|SELF_SIGNED|HOSTNAME|ALTNAME|SSL|TLS|ERR_SSL|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(`${error?.code ?? ''}`);
const nullBody = status => status === 204 || status === 205 || status === 304;

// One request. init: { method, headers, body (string or Buffer) }. Resolves { status, headers: { get }, truncated, text(),
// json() } for any non-redirect answer; throws an OutboundError for every refusal and transport failure.
export async function outboundRequest(value, { method = 'GET', headers = {}, body = null } = {}, guard = {}) {
  const privateAllowed = guard.privateAllowed === true;
  const url = checkUrl(value, { hosts: guard.hosts ?? null, privateAllowed });
  const payload = body === null || body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  if (payload && payload.length > outboundLimits.requestBytes) throw new OutboundError('too-large');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase(), literal = isIP(host) !== 0;

  let timer, request;
  const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => { reject(new OutboundError('timeout')); request?.destroy(); }, outboundLimits.totalMs); });
  try {
    // One DNS answer for the check and for the connection. A slow resolver counts against the same 10 seconds.
    let answers;
    if (literal) answers = [{ address: host, family: isIP(host) }];
    else { try { answers = await Promise.race([outboundIo.resolve(host), deadline]); } catch (error) { throw error instanceof OutboundError ? error : new OutboundError('dns'); } }
    answers = (answers ?? []).map(answer => ({ address: String(answer?.address ?? ''), family: isIP(String(answer?.address ?? '')) }));
    const privateTarget = checkAnswers(answers, privateAllowed);
    // Public hosts: HTTPS on 443 only. A private host (every answer private, and allowed) may use HTTP and its own port.
    if (!privateTarget && (url.protocol !== 'https:' || (url.port && url.port !== '443'))) throw new OutboundError('blocked');
    const secure = url.protocol === 'https:', lib = secure ? https : http, port = Number(url.port || (secure ? 443 : 80));
    const dialed = answers.map(answer => { const target = outboundIo.dial(answer.address, port), address = String(target?.address ?? ''); return { address, family: isIP(address), port: Number(target?.port) }; });
    if (dialed.some(answer => !answer.family || !Number.isInteger(answer.port))) throw new OutboundError('network');

    const agent = new lib.Agent({ keepAlive: false, maxSockets: 1 }); // explicit, so no environment proxy ever applies
    const options = {
      method, agent, path: `${url.pathname}${url.search}`, port: dialed[0].port,
      host: literal ? dialed[0].address : host, ...(literal ? {} : { lookup: pinnedLookup(host, dialed.map(({ address, family }) => ({ address, family }))) }),
      headers: { ...Object.fromEntries(Object.entries(headers).filter(([key]) => !/^(host|content-length|transfer-encoding|connection)$/i.test(key))), Host: url.host, Connection: 'close', 'User-Agent': 'DockNest', ...(payload ? { 'Content-Length': payload.length } : {}) },
      ...(secure ? { servername: literal ? undefined : host, minVersion: 'TLSv1.2', rejectUnauthorized: true, ...(outboundIo.ca ? { ca: outboundIo.ca } : {}) } : {}),
    };
    // A literal's certificate is checked against the literal, not against the dialed address (they differ only in tests).
    if (secure && literal) options.checkServerIdentity = (_name, cert) => tls.checkServerIdentity(host, cert);

    const exchange = new Promise((resolve, reject) => {
      request = lib.request(options, response => {
        if (response.statusCode >= 300 && response.statusCode < 400) { response.destroy(); request.destroy(); return reject(new OutboundError('redirect')); }
        const parts = []; let size = 0, truncated = false, done = false;
        const finish = () => { if (done) return; done = true; const data = Buffer.concat(parts), status = response.statusCode, raw = response.headers; resolve({ status, truncated, headers: { get: name => { const found = raw[String(name).toLowerCase()]; return found === undefined ? null : Array.isArray(found) ? found.join(', ') : String(found); } }, text: async () => (nullBody(status) ? '' : data.toString('utf8')), json: async () => JSON.parse(data.toString('utf8')) }); };
        response.on('data', chunk => {
          if (done) return;
          const room = outboundLimits.responseBytes - size;
          if (chunk.length >= room) { parts.push(chunk.subarray(0, room)); size += room; truncated = chunk.length > room || truncated; if (chunk.length > room) { finish(); response.destroy(); request.destroy(); } return; }
          parts.push(chunk); size += chunk.length;
        });
        response.on('end', finish);
        response.on('error', error => (done ? undefined : reject(error)));
        response.on('close', () => (done ? undefined : reject(new OutboundError('network'))));
      });
      request.on('error', reject);
      request.end(payload ?? undefined);
    });
    return await Promise.race([exchange, deadline]);
  } catch (error) {
    if (error instanceof OutboundError) throw error;
    throw new OutboundError(tlsProblem(error) ? 'tls' : 'network');
  } finally { clearTimeout(timer); }
}
// Retry-After (RFC 9110): delay-seconds or an HTTP-date. Returns milliseconds clamped to [1 s, 15 min], or null.
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (/^\d{1,10}$/.test(text)) return clampWait(Number(text) * 1000);
  // IMF-fixdate and RFC 850 dates carry GMT. asctime has no zone and means GMT too, so it is never read as local time.
  const asctime = /^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(text);
  if (asctime || /^[A-Za-z]{3,9}, \d{1,2}[ -][A-Za-z]{3}[ -]\d{2,4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) { const date = Date.parse(asctime ? `${text} GMT` : text); if (Number.isFinite(date)) return clampWait(date - now); }
  return null;
}
const clampWait = ms => Math.min(outboundLimits.maxRetryAfterMs, Math.max(outboundLimits.minRetryAfterMs, Math.round(ms)));
// The wait a 429 asks for: the Retry-After header, then Telegram's `parameters.retry_after`, then Discord's JSON
// `retry_after` (seconds, may be fractional). Null when none is given or none is readable.
export function retryAfterMs(response, body = {}, now = Date.now()) {
  const header = parseRetryAfter(response?.headers?.get?.('retry-after'), now); if (header !== null) return header;
  if (typeof body?.retry_after_ms === 'number' && Number.isFinite(body.retry_after_ms) && body.retry_after_ms >= 0) return clampWait(body.retry_after_ms); // Matrix
  for (const seconds of [body?.parameters?.retry_after, body?.retry_after]) if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) return clampWait(seconds * 1000);
  return null;
}
