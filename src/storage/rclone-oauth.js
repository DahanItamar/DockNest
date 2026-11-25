// Sign-in to Google Drive, OneDrive and Dropbox from a dashboard that is usually opened over a domain or a LAN address
// (docs/cloud-drives.md, decision 6).
//  A. Address: `rclone authorize <backend> --auth-no-open-browser` runs inside the container and listens on
//     127.0.0.1:53682. The owner signs in in their own browser, the provider redirects to an address that browser cannot
//     open, and the owner pastes it. DockNest checks it (rclone-input.js), rebuilds the request itself from `code` and
//     `state` only, and sends it to the loopback listener. The listener lives at most 10 minutes.
//  B. Token: the JSON `rclone authorize` printed on the owner's own computer, parsed strictly.
//  C. The owner's own client ID and secret, passed to the authorize process through its environment, never its arguments.
// The sign-in link is printed at NOTICE level, so the helper must not run quieter; its output is only matched, never logged.
// Pending tokens stay in memory, sealed with the master key, for the session only.
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { config } from '../config.js';
import { seal, open } from '../crypto.js';
import { BACKENDS } from './rclone-errors.js';
import { AUTH_HOST, AUTH_PORT, issuedState, looksLikeToken, parseClient, parsePastedAddress, parseToken } from './rclone-input.js';
import { childEnvironment, privateFolder } from './rclone.js';

// Production always uses rclone's fixed port. Only under NODE_ENV=test may DOCKNEST_TEST_AUTH_PORT move the local listener,
// so tests do not collide with a real rclone on this machine; the pasted-address check (rclone-input.js) is unchanged.
const LISTEN_PORT = process.env.NODE_ENV === 'test' && /^\d{4,5}$/.test(process.env.DOCKNEST_TEST_AUTH_PORT ?? '') ? process.env.DOCKNEST_TEST_AUTH_PORT : AUTH_PORT;
export const SESSION_MS = 10 * 60_000;
// The only places the provider's own sign-in page may be.
const PROVIDER_HOSTS = Object.freeze({ drive: ['accounts.google.com'], onedrive: ['login.microsoftonline.com', 'login.live.com'], dropbox: ['www.dropbox.com', 'dropbox.com'] });
const CLIENT_ENV = Object.freeze({ drive: 'DRIVE', onedrive: 'ONEDRIVE', dropbox: 'DROPBOX' });
const sessions = new Map();
const fail = (message, status = 400, publicCode = 'oauth_failed') => Object.assign(new Error(message), { status, expose: true, publicCode });
const MAX_SESSIONS = 5;

function forget(session) {
  clearTimeout(session.timer);
  sessions.delete(session.id);
  if (session.child && session.child.exitCode === null && session.child.signalCode === null) session.child.kill('SIGKILL');
  if (session.folder) rm(session.folder, { recursive: true, force: true }).catch(() => {});
}
export const sessionCount = () => sessions.size;
export function endAll() { for (const session of [...sessions.values()]) forget(session); }

function command(args) {
  const bin = config.rcloneBin;
  return bin.endsWith('.js') ? { cmd: process.execPath, args: [bin, ...args] } : { cmd: bin, args };
}
const waitFor = (test, ms, message) => new Promise((resolveWait, reject) => {
  const started = Date.now();
  const tick = () => { const value = test(); if (value) return resolveWait(value); if (Date.now() - started > ms) return reject(fail(message, 504, 'oauth_timeout')); setTimeout(tick, 50); };
  tick();
});
// One request to rclone's own loopback listener. Host and port are constants; only the path and query vary.
function listener(pathAndQuery) {
  return new Promise((resolveRequest, reject) => {
    const request = http.get({ host: AUTH_HOST, port: Number(LISTEN_PORT), path: pathAndQuery, timeout: 15_000, agent: false }, response => {
      response.resume();
      resolveRequest({ status: response.statusCode, location: response.headers.location ?? null });
    });
    request.once('timeout', () => request.destroy(new Error('timeout')));
    request.once('error', () => reject(fail('The sign-in helper did not answer. Start the sign-in again.', 502, 'oauth_helper')));
  });
}
function providerUrl(backend, location) {
  let url;
  try { url = new URL(String(location ?? '')); } catch { return null; }
  return url.protocol === 'https:' && !url.username && !url.password && PROVIDER_HOSTS[backend].includes(url.hostname) && !url.port ? url.toString() : null;
}

export async function start({ userId, backend, flow = 'address', clientId, clientSecret }) {
  if (!BACKENDS[backend]?.oauth) throw fail('Only Google Drive, OneDrive and Dropbox sign in this way.');
  if (!['address', 'token'].includes(flow)) throw fail('Unknown sign-in method.');
  const client = parseClient({ clientId, clientSecret });
  if ((client.clientId || client.clientSecret) && !(client.clientId && client.clientSecret)) throw fail('Enter both the client ID and the client secret of your own app, or neither.');
  if (sessions.size >= MAX_SESSIONS) throw fail('Too many sign-ins are open. Wait a few minutes and try again.', 429, 'oauth_busy');
  const session = { id: randomBytes(24).toString('base64url'), userId, backend, flow, client: client.clientSecret ? { clientId: client.clientId, clientSecret: seal(client.clientSecret) } : null, expiresAt: Date.now() + SESSION_MS, pending: null, state: null, child: null, folder: null, forwarded: false, output: '' };
  if (flow === 'address') {
    // rclone's listener port is fixed, so only one address sign-in can run at a time.
    if ([...sessions.values()].some(item => item.flow === 'address')) throw fail('Another sign-in is open. Finish it, or wait up to 10 minutes, then try again.', 409, 'oauth_busy');
    // Reserved before any await, so two requests cannot both pass the check above.
    session.timer = setTimeout(() => forget(session), SESSION_MS);
    session.timer.unref?.();
    sessions.set(session.id, session);
    try {
      session.folder = await privateFolder();
      const empty = path.join(session.folder, 'rclone.conf');
      await writeFile(empty, '', { mode: 0o600 });
      const env = childEnvironment(session.folder);
      if (LISTEN_PORT !== AUTH_PORT) env.DOCKNEST_TEST_AUTH_PORT = LISTEN_PORT;
      // DockNest only touches files it created: Google Drive is asked for `drive.file`, never the full `drive` scope.
      if (backend === 'drive') env.RCLONE_DRIVE_SCOPE = 'drive.file';
      if (session.client) { env[`RCLONE_${CLIENT_ENV[backend]}_CLIENT_ID`] = client.clientId; env[`RCLONE_${CLIENT_ENV[backend]}_CLIENT_SECRET`] = client.clientSecret; }
      const { cmd, args } = command(['authorize', backend, '--auth-no-open-browser', '--config', empty, '--ask-password=false', '--log-level', 'NOTICE']);
      session.child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true });
      const collect = chunk => { if (session.output.length < 65536) session.output += chunk.toString('utf8'); };
      session.stdout = '';
      session.child.stdout.on('data', chunk => { collect(chunk); if (session.stdout.length < 65536) session.stdout += chunk.toString('utf8'); });
      session.child.stderr.on('data', collect);
      session.exited = new Promise(resolveExit => { session.child.once('error', () => resolveExit('error')); session.child.once('close', () => resolveExit('closed')); });
      const found = await Promise.race([
        waitFor(() => new RegExp(`${AUTH_HOST.replaceAll('.', '\\.')}:${LISTEN_PORT}/auth\\?state=([A-Za-z0-9_-]{8,128})`).exec(session.output)?.[1], 20_000, 'The sign-in helper did not start. Try again.'),
        session.exited.then(() => { throw fail('The sign-in helper could not start. Check that rclone is installed.', 503, 'rclone_missing'); }),
      ]);
      if (!issuedState(found)) throw fail('The sign-in helper gave an unexpected answer.', 502, 'oauth_helper');
      session.state = found;
      // The helper's own link redirects to the provider; the owner is shown the provider's address, which their browser can open.
      const first = await listener(`/auth?state=${found}`);
      const url = providerUrl(backend, first.location);
      if (!url) throw fail('The sign-in helper did not point to the provider. Try again.', 502, 'oauth_helper');
      session.url = url;
    } catch (error) { forget(session); throw error; }
  }
  if (!sessions.has(session.id)) { session.timer = setTimeout(() => forget(session), SESSION_MS); session.timer.unref?.(); sessions.set(session.id, session); }
  return { sessionId: session.id, url: session.url ?? null, expiresInSeconds: SESSION_MS / 1000 };
}

function owned(sessionId, userId) {
  const session = sessions.get(String(sessionId ?? ''));
  if (!session || session.userId !== userId || session.expiresAt < Date.now()) throw fail('This sign-in expired or does not exist. Start it again.', 404, 'oauth_expired');
  return session;
}
async function tokenFromHelper(session) {
  const outcome = await Promise.race([session.exited, new Promise(resolveWait => setTimeout(() => resolveWait('timeout'), 30_000))]);
  if (outcome !== 'closed') throw fail('The provider did not finish the sign-in. Start it again.', 504, 'oauth_timeout');
  return parseToken(session.stdout);
}
// Takes what the owner pasted (an address, or a token) and keeps the resulting token, sealed, until it is used or expires.
export async function submit({ sessionId, userId, pasted }) {
  const session = owned(sessionId, userId);
  if (session.pending) throw fail('This sign-in already finished.', 409, 'oauth_done');
  let token;
  if (looksLikeToken(pasted)) token = parseToken(pasted);
  else {
    if (session.flow !== 'address') throw fail('This sign-in expects the token JSON from rclone authorize.');
    if (session.forwarded) throw fail('This sign-in was already used. Start it again.', 409, 'oauth_done');
    const { code, state } = parsePastedAddress(pasted, session.state);
    session.forwarded = true;
    const query = new URLSearchParams({ state, code }).toString();
    await listener(`/?${query}`);
    token = await tokenFromHelper(session);
  }
  session.pending = seal(JSON.stringify(token)); session.stdout = ''; session.output = '';
  if (session.child) session.child.kill('SIGKILL');
  return { backend: session.backend, tokenExpiresAt: token.expiry || null };
}
// The finished sign-in's token and the owner's own app credentials, for creating or reconnecting a destination. The session
// stays until `cancel` (called once the destination is saved), so a failed test does not cost the owner a second sign-in.
export function take({ sessionId, userId, backend }) {
  const session = owned(sessionId, userId);
  if (!session.pending) throw fail('Finish the sign-in first.', 409, 'oauth_pending');
  if (backend && session.backend !== backend) throw fail('This sign-in was for a different service.');
  const result = { backend: session.backend, token: JSON.parse(open(session.pending)), client: session.client ? { clientId: session.client.clientId, clientSecret: open(session.client.clientSecret) } : null };
  return result;
}
export function cancel({ sessionId, userId }) { const session = sessions.get(String(sessionId ?? '')); if (session?.userId === userId) forget(session); }
export const sameState = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
