import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parsePastedAddress, parseToken, looksLikeToken, parseClient } from '../src/storage/rclone-input.js';
import { classify } from '../src/storage/rclone-errors.js';
import { RCLONE_VERSION } from '../src/storage/rclone-pin.js';

const STATE = 'AbCdEf12_-xyz789', CODE = '4/0AfakeCodeForTests-1234567890';
const address = (query, base = 'http://127.0.0.1:53682/') => base + '?' + query;

test('the pasted address is accepted only for 127.0.0.1:53682 with the issued state', () => {
  assert.deepEqual(parsePastedAddress(address(`state=${STATE}&code=${CODE}`), STATE), { code: CODE, state: STATE });
  assert.deepEqual(parsePastedAddress(`  ${address(`state=${STATE}&code=${CODE}&scope=email%20profile&authuser=0`)}  `, STATE).state, STATE);
  const bad = {
    'wrong host': address(`state=${STATE}&code=${CODE}`, 'http://localhost:53682/'),
    'other host': address(`state=${STATE}&code=${CODE}`, 'http://evil.example.invalid:53682/'),
    'dns lookalike': address(`state=${STATE}&code=${CODE}`, 'http://127.0.0.1.evil.example.invalid:53682/'),
    'wrong port': address(`state=${STATE}&code=${CODE}`, 'http://127.0.0.1:8080/'),
    'no port': address(`state=${STATE}&code=${CODE}`, 'http://127.0.0.1/'),
    https: address(`state=${STATE}&code=${CODE}`, 'https://127.0.0.1:53682/'),
    credentials: address(`state=${STATE}&code=${CODE}`, 'http://user:pw@127.0.0.1:53682/'),
    'other path': address(`state=${STATE}&code=${CODE}`, 'http://127.0.0.1:53682/auth'),
    'other state': address(`state=OtherState123456&code=${CODE}`),
    'missing state': address(`code=${CODE}`),
    'missing code': address(`state=${STATE}`),
    'extra parameter': address(`state=${STATE}&code=${CODE}&redirect=http://evil.example.invalid`),
    'repeated code': address(`state=${STATE}&code=${CODE}&code=${CODE}`),
    'repeated state': address(`state=${STATE}&state=${STATE}&code=${CODE}`),
    fragment: address(`state=${STATE}&code=${CODE}`) + '#frag',
    'empty fragment': address(`state=${STATE}&code=${CODE}`) + '#',
    'provider error': address(`state=${STATE}&error=access_denied`),
    'spaces inside': address(`state=${STATE}&code=${CODE} extra`),
    'line break': address(`state=${STATE}&code=${CODE}`) + '\nhttp://evil.example.invalid/',
    'not an address': 'hello',
    empty: '',
    'huge code': address(`state=${STATE}&code=${'a'.repeat(5000)}`),
  };
  for (const [name, value] of Object.entries(bad)) assert.throws(() => parsePastedAddress(value, STATE), error => error.status === 400 && error.expose === true && !String(error.message).includes(CODE), name);
  // The issued state is never missing: a session without one accepts nothing.
  assert.throws(() => parsePastedAddress(address(`state=${STATE}&code=${CODE}`), ''), /different sign-in/);
});

test('token JSON is parsed strictly and never echoed', () => {
  const good = { access_token: 'fixture-access-token', token_type: 'Bearer', refresh_token: 'fixture-refresh-token', expiry: '2031-01-01T00:00:00.123456789Z' };
  assert.deepEqual(parseToken(JSON.stringify(good)), good);
  assert.deepEqual(parseToken(`Paste the following into your remote machine --->\n${JSON.stringify(good)}\n<---End paste`), good);
  assert.equal(parseToken(JSON.stringify({ ...good, expires_in: 3599 })).expires_in, 3599);
  assert.equal(parseToken(JSON.stringify({ access_token: 'a', refresh_token: 'r' })).token_type, 'Bearer');
  assert.equal(looksLikeToken(JSON.stringify(good)), true);
  assert.equal(looksLikeToken('http://127.0.0.1:53682/?state=x'), false);
  const bad = [
    '[]', '"text"', 'not json', '{', JSON.stringify({ ...good, extra: 'field' }), JSON.stringify({ ...good, scope: 'x' }),
    JSON.stringify({ ...good, access_token: '' }), JSON.stringify({ ...good, access_token: 5 }), JSON.stringify({ ...good, access_token: 'a\nb' }),
    JSON.stringify({ ...good, refresh_token: undefined }), JSON.stringify({ ...good, token_type: 'Bearer\nx' }), JSON.stringify({ ...good, expiry: 'tomorrow' }),
    JSON.stringify({ ...good, expires_in: '3600' }), JSON.stringify({ ...good, access_token: 'x'.repeat(9000) }), JSON.stringify({ __proto__: null, ...good, constructor: {} }),
  ];
  for (const value of bad) assert.throws(() => parseToken(value), error => error.status === 400 && !String(error.message).includes('fixture-access-token'), value.slice(0, 40));
});

test('own client credentials are checked', () => {
  assert.deepEqual(parseClient({}), { clientId: '', clientSecret: '' });
  assert.deepEqual(parseClient({ clientId: '1234-fixture.apps.example.invalid', clientSecret: 'GOCSPX-fixture_secret' }), { clientId: '1234-fixture.apps.example.invalid', clientSecret: 'GOCSPX-fixture_secret' });
  assert.throws(() => parseClient({ clientId: 'has space', clientSecret: 'x' }));
  assert.throws(() => parseClient({ clientId: 'valid-id-123', clientSecret: 'has space' }));
  assert.throws(() => parseClient({ clientId: 'a\nb', clientSecret: 'x' }));
});

test('error mapping turns known rclone failures into plain reasons and drops everything else', () => {
  const secret = 'ya29.fixture-secret-token';
  const cases = [
    [`Failed to create file system: couldn't fetch token: invalid_grant: Token has been expired or revoked. https://x/?access_token=${secret}`, 1, 'drive', 'needs_reconnect', /Google Drive needs you to sign in again/],
    ['AADSTS70008: The provided authorization code or refresh token has expired', 1, 'onedrive', 'needs_reconnect', /OneDrive needs you to sign in again/],
    ['expired_access_token: the access token is expired', 1, 'dropbox', 'needs_reconnect', /Dropbox needs you to sign in again/],
    ['Error: HTTP error 401 (401 Unauthorized) returned body: {}', 1, 'drive', 'needs_reconnect', /sign in again/],
    ['HTTP error 401 (401 Unauthorized)', 1, 'webdav', 'auth_failed', /refused the login/],
    ['googleapi: Error 403: Rate Limit Exceeded, rateLimitExceeded', 1, 'drive', 'rate_limited', /Google Drive is limiting requests, DockNest retries at the next run/],
    ['googleapi: Error 403: The user\'s Drive storage quota has been exceeded, storageQuotaExceeded', 1, 'drive', 'quota', /no space left/],
    ['error listing: directory not found', 3, 'drive', 'not_found', /not on Google Drive/],
    ['object not found', 4, 'webdav', 'not_found', /not on WebDAV/],
    ['dial tcp: lookup nas.example.invalid: no such host', 1, 'smb', 'network', /could not be reached/],
    ['Get "https://www.googleapis.com/drive/v3/about": tls: failed to verify certificate: x509: certificate signed by unknown authority', 1, 'drive', 'tls', /certificate was not accepted/],
    ['x509: certificate has expired or is not yet valid', 1, 'webdav', 'tls', /could not be trusted/],
    ['something nobody has seen before', 1, 'drive', 'failed', /did not accept the request/],
  ];
  for (const [stderr, code, backend, reason, message] of cases) {
    const result = classify(stderr, code, backend);
    assert.equal(result.reason, reason, stderr);
    assert.match(result.message, message);
    assert.equal(result.needsReconnect, reason === 'needs_reconnect');
    assert.ok(!result.message.includes(secret) && !result.message.includes('http'), 'no fragment of rclone output reaches the message');
  }
  // OAuth sign-in text never marks a share or WebDAV as needing a sign-in.
  assert.equal(classify('invalid_grant', 1, 'webdav').needsReconnect, false);
});

test('Dockerfile pins one rclone release with a SHA-256 and the same version as the source pin', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.equal(dockerfile.match(/ARG RCLONE_VERSION=v([\d.]+)/)?.[1], RCLONE_VERSION);
  assert.match(dockerfile, /ARG RCLONE_SHA256=[a-f0-9]{64}\b/);
  assert.match(dockerfile, /sha256sum -c -/);
  assert.match(dockerfile, /linux-amd64\.zip/);
  assert.match(dockerfile, /COPY --from=rclone \/out\/ \/usr\/local\/bin\//);
  assert.doesNotMatch(dockerfile, /rclone (?:selfupdate|version --check)/);
});
