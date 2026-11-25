// Strict parsing of everything an owner pastes into the cloud-drive sign-in: the address the browser could not open, and the
// token JSON that `rclone authorize` prints. Nothing here logs or returns the pasted text in an error.
import { timingSafeEqual } from 'node:crypto';

export const AUTH_HOST = '127.0.0.1';
export const AUTH_PORT = '53682';
// Microsoft and Dropbox redirect to `localhost`; the same port. DockNest rebuilds the request itself and sends it to AUTH_HOST only.
const ADDRESS_HOSTS = new Set([AUTH_HOST, 'localhost']);
const fail = message => Object.assign(new Error(message), { status: 400, expose: true, publicCode: 'invalid_paste' });

// Parameters a provider may add to the redirect next to `code` and `state`. They are read and ignored, never forwarded.
const IGNORED_PARAMS = new Set(['scope', 'authuser', 'prompt', 'hd', 'session_state', 'iss']);
// Personal Microsoft account codes also hold ! * $ and run to about 700 characters; the whole paste stays under 4096.
const CODE = /^[A-Za-z0-9._~+/=%!*$-]{8,2048}$/;
const STATE = /^[A-Za-z0-9_-]{8,128}$/;
export const issuedState = value => typeof value === 'string' && STATE.test(value);

// "http://127.0.0.1:53682/?state=...&code=..." -> { code, state }. Refuses any other host, port, scheme or path, a fragment,
// credentials, repeated or unknown parameters, an error answer from the provider, and a state that is not the issued one.
export function parsePastedAddress(text, expectedState) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(raw)) throw fail('Paste the whole address from your browser bar, on one line.');
  let url;
  try { url = new URL(raw); } catch { throw fail('That is not an address. Paste the whole address from your browser bar.'); }
  if (url.protocol !== 'http:' || !ADDRESS_HOSTS.has(url.hostname) || url.port !== AUTH_PORT || url.username || url.password || url.hash || raw.includes('#') || !['', '/'].includes(url.pathname)) {
    throw fail('That address is not the one the sign-in ended on. It must start with http://127.0.0.1:53682/ or http://localhost:53682/');
  }
  const seen = new Map();
  for (const [name, value] of url.searchParams) {
    if (seen.has(name)) throw fail('That address repeats a parameter, so DockNest did not use it.');
    seen.set(name, value);
  }
  if (seen.has('error')) throw fail('The provider reported that the sign-in was not completed. Start the sign-in again.');
  for (const name of seen.keys()) if (name !== 'code' && name !== 'state' && !IGNORED_PARAMS.has(name)) throw fail('That address has parameters DockNest does not accept.');
  const code = seen.get('code'), state = seen.get('state');
  if (!code || !state || !CODE.test(code) || !STATE.test(state)) throw fail('That address does not hold a sign-in code. Paste the address after you approved the access.');
  const expected = Buffer.from(String(expectedState ?? '')), given = Buffer.from(state);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw fail('That address belongs to a different sign-in. Start the sign-in again and use the new link.');
  return { code, state };
}

const TOKEN_KEYS = new Set(['access_token', 'token_type', 'refresh_token', 'expiry', 'expires_in']);
const EXPIRY = /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/;
const printable = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
// The JSON `rclone authorize` prints, alone or inside its "Paste the following ... --->" block. Only the four documented
// fields (and numeric expires_in, which newer rclone adds) are accepted; anything else is refused, never kept.
export function parseToken(text) {
  let raw = String(text ?? '').trim();
  const block = /--->\s*([\s\S]*?)\s*<---/.exec(raw);
  if (block) raw = block[1].trim();
  if (!raw.startsWith('{') || raw.length > 20000) throw fail('That is not the token JSON that rclone authorize prints.');
  let data;
  try { data = JSON.parse(raw); } catch { throw fail('That is not valid token JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('That is not the token JSON that rclone authorize prints.');
  for (const key of Object.keys(data)) if (!TOKEN_KEYS.has(key)) throw fail('The token JSON has fields DockNest does not accept.');
  if (!printable(data.access_token, 8192) || !data.access_token) throw fail('The token JSON has no access_token.');
  if (data.token_type !== undefined && (!printable(data.token_type, 32) || !/^[A-Za-z]+$/.test(data.token_type))) throw fail('The token JSON has an invalid token_type.');
  if (data.refresh_token !== undefined && !printable(data.refresh_token, 8192)) throw fail('The token JSON has an invalid refresh_token.');
  if (data.expiry !== undefined && (typeof data.expiry !== 'string' || !EXPIRY.test(data.expiry))) throw fail('The token JSON has an invalid expiry.');
  if (data.expires_in !== undefined && !(Number.isInteger(data.expires_in) && data.expires_in >= 0 && data.expires_in < 1e9)) throw fail('The token JSON has an invalid expires_in.');
  if (!data.refresh_token) throw fail('The token JSON has no refresh_token, so DockNest could not stay signed in. Authorize again.');
  const { access_token, token_type = 'Bearer', refresh_token, expiry = '', expires_in } = data;
  return { access_token, token_type, refresh_token, expiry, ...(expires_in !== undefined ? { expires_in } : {}) };
}
// Pasted text that is a token rather than an address.
export const looksLikeToken = text => /^\s*\{/.test(String(text ?? '')) || /--->/.test(String(text ?? ''));

// Client ID and secret of the owner's own app (flow C): printable ASCII, no spaces, no quotes.
export function parseClient({ clientId, clientSecret } = {}) {
  if (clientId === undefined && clientSecret === undefined) return { clientId: '', clientSecret: '' };
  const id = String(clientId ?? ''), secret = String(clientSecret ?? '');
  if (!/^[A-Za-z0-9._~:/@+=-]{4,300}$/.test(id)) throw fail('The client ID has characters DockNest does not accept.');
  if (secret && !/^[\x21-\x7e]{1,300}$/.test(secret)) throw fail('The client secret has characters DockNest does not accept.');
  return { clientId: id, clientSecret: secret };
}
