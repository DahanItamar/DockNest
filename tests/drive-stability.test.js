import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildConfig } from '../src/storage/rclone.js';
import { fetchRootFolderId } from '../src/storage/drive-root.js';
import { STILL_CHECKING, waitForTest } from '../web/storage-drives/test-poll.js';

// A fake Google API on a local port: no network, no accounts.
let mode = 'ok';
const requests = [];
const server = http.createServer((request, response) => {
  requests.push({ url: request.url, authorization: request.headers.authorization });
  if (request.headers.authorization !== 'Bearer good-token') { response.writeHead(401); return response.end('{}'); }
  if (mode === 'error') { response.writeHead(500); return response.end('{}'); }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(mode === 'huge' ? JSON.stringify({ id: '0AFixtureRootFolderId_123', pad: 'x'.repeat(10000) }) : mode === 'bad' ? JSON.stringify({ id: 'bad id with spaces' }) : JSON.stringify({ id: '0AFixtureRootFolderId_123' }));
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
Object.assign(process.env, { NODE_ENV: 'test', DOCKNEST_TEST_GOOGLE_URL: `http://127.0.0.1:${server.address().port}` });
after(() => server.close());

test('the root folder ID comes from Google, strictly checked, and every failure gives null', async () => {
  mode = 'ok';
  assert.equal(await fetchRootFolderId('good-token'), '0AFixtureRootFolderId_123');
  assert.equal(requests.at(-1).url, '/drive/v3/files/root?fields=id');
  assert.equal(await fetchRootFolderId('wrong'), null);
  assert.equal(await fetchRootFolderId(''), null);
  for (const bad of ['error', 'huge', 'bad']) { mode = bad; assert.equal(await fetchRootFolderId('good-token'), null, bad); }
});
test('buildConfig writes root_folder_id for Google Drive only, and only a well-formed one', () => {
  const drive = settings => buildConfig({ backend: 'drive', settings }, { token: { access_token: 'a' } });
  assert.match(drive({ rootFolderId: '0AFixtureRootFolderId_123' }), /^root_folder_id = 0AFixtureRootFolderId_123$/m);
  for (const bad of ['short', 'has space in it 123', 'line\nbreak_1234567', '../../etc/passwd', 5, null]) assert.doesNotMatch(drive({ rootFolderId: bad }), /root_folder_id/, String(bad));
  assert.doesNotMatch(buildConfig({ backend: 'dropbox', settings: { rootFolderId: '0AFixtureRootFolderId_123' } }, {}), /root_folder_id/);
});
test('the page polls until the test is done, and surfaces a failure or a vanished test', async () => {
  const sleeps = [], notes = [];
  const sequence = answers => { let index = 0; return async () => answers[index++]; };
  const options = { sleep: async ms => { sleeps.push(ms); }, onWait: text => notes.push(text), everyMs: 10 };
  assert.deepEqual(await waitForTest(sequence([{ state: 'checking' }, { state: 'checking' }, { state: 'done', result: { connected: true } }]), '/p', options), { connected: true });
  assert.equal(sleeps.length, 3);
  assert.ok(notes.every(text => text === STILL_CHECKING));
  await assert.rejects(waitForTest(sequence([{ state: 'failed', error: 'Google is limiting the shared sign-in app.', code: 'rate_limited' }]), '/p', options), /Google is limiting/);
  await assert.rejects(waitForTest(sequence([{ state: 'none' }]), '/p', options), /no longer running/);
  await assert.rejects(waitForTest(async () => ({ state: 'checking' }), '/p', { ...options, tries: 3 }), /still running/);
});
