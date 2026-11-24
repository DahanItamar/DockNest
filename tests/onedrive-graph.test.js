import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listOneDrives } from '../src/storage/onedrive-graph.js';

// A fake Microsoft Graph on a local port: no network, no accounts.
const TOKEN = 'fixture-graph-access-token-123';
let mode = 'ok';
const requests = [];
const server = http.createServer((request, response) => {
  requests.push({ url: request.url, authorization: request.headers.authorization });
  const json = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (request.headers.authorization !== 'Bearer ' + TOKEN) return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'secret-body-text' } });
  if (mode === 'huge') return json(200, JSON.stringify({ value: [], pad: 'x'.repeat(2 * 1024 * 1024) }));
  if (mode === 'garbage') return json(200, 'not json');
  if (mode === 'server-error') return json(500, { error: 'secret-body-text' });
  if (request.url === '/v1.0/me/drive') return json(200, { id: 'b!personalDrive_1', name: 'OneDrive', driveType: 'personal' });
  if (request.url === '/v1.0/me/drives') {
    if (mode === 'drives-denied') return json(403, {});
    return json(200, { value: [{ id: 'b!personalDrive_1', name: 'OneDrive', driveType: 'personal' }, { id: 'b!libraryA-2', name: 'Team site', driveType: 'documentLibrary' }, { id: 'bad id with spaces', name: 'x', driveType: 'business' }, { id: 'b!work3', name: 'Work\u0007 drive', driveType: 'business' }, { id: 'b!odd4', name: '', driveType: 'unknown' }] });
  }
  json(404, {});
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
Object.assign(process.env, { NODE_ENV: 'test', DOCKNEST_TEST_GRAPH_URL: `http://127.0.0.1:${server.address().port}` });
after(() => server.close());

test('OneDrive drives come from Graph with the access token, deduplicated, typed and cleaned', async () => {
  mode = 'ok'; requests.length = 0;
  const list = await listOneDrives(TOKEN);
  assert.deepEqual(list, [
    { id: 'b!personalDrive_1', name: 'OneDrive', type: 'personal' },
    { id: 'b!libraryA-2', name: 'Team site', type: 'documentLibrary' },
    { id: 'b!work3', name: 'Work drive', type: 'business' },
    { id: 'b!odd4', name: 'OneDrive', type: 'personal' },
  ]);
  assert.deepEqual(requests.map(item => item.url), ['/v1.0/me/drive', '/v1.0/me/drives']);
});
test('a refused list of other drives still returns the default drive', async () => {
  mode = 'drives-denied';
  assert.deepEqual(await listOneDrives(TOKEN), [{ id: 'b!personalDrive_1', name: 'OneDrive', type: 'personal' }]);
});
test('failures are plain errors, never an empty list, and never carry the token or the body', async () => {
  for (const [modeName, token, code] of [['ok', 'wrong-token-value', 'onedrive_denied'], ['ok', '', 'onedrive_denied'], ['server-error', TOKEN, 'onedrive_drives'], ['garbage', TOKEN, 'onedrive_drives'], ['huge', TOKEN, 'onedrive_drives']]) {
    mode = modeName;
    await assert.rejects(listOneDrives(token), error => {
      assert.equal(error.publicCode, code, modeName);
      assert.equal(error.expose, true);
      for (const secret of [TOKEN, 'wrong-token-value', 'secret-body-text']) assert.ok(!error.message.includes(secret));
      return true;
    });
  }
});
test('an unreachable Graph is a plain network error', async () => {
  const saved = process.env.DOCKNEST_TEST_GRAPH_URL;
  const closed = http.createServer().listen(0, '127.0.0.1'); await new Promise(resolveListen => closed.once('listening', resolveListen)); const port = closed.address().port; await new Promise(resolveClose => closed.close(resolveClose));
  process.env.DOCKNEST_TEST_GRAPH_URL = 'http://127.0.0.1:' + port;
  try { await assert.rejects(listOneDrives(TOKEN), /could not be reached/); } finally { process.env.DOCKNEST_TEST_GRAPH_URL = saved; }
});
