// Back up any container (docs/coverage-and-restore-check.md A2/A3): the read-only describe-containers route and the
// additive discovery fields. The helper is stubbed; remote/test_runspec.py covers what it returns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-describe-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js');
const { db, id } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const { transport } = await import('../src/engine.js');
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
test.after(() => listener.close());
const base = `http://127.0.0.1:${listener.address().port}/api`, host = id(), operator = randomBytes(32).toString('base64url');
db.prepare("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)").run('operator', 'operator@example.invalid', 'fixture', 'fixture', '[]', new Date().toISOString(), 'Operator', 'operator');
db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(operator), 'operator', 'csrf', Date.now() + 3600000, Date.now(), Date.now(), Date.now());
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(host, 'QA', 'localhost', 22, 'root', 'fixture', '0'.repeat(64), new Date().toISOString());
const get = (route, token = operator) => fetch(base + route, { headers: token ? { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN } : {} });
const requests = [];
transport.remote = async (_server, request) => {
  requests.push(request);
  if (request.operation === 'describe-containers') return { containers: [{ name: 'shop', environment: ['PASSWORD'], unsupported: [] }], compose: 'services: {}\n' };
  if (request.operation === 'discover') return { staticSites: [], containers: [{ name: 'shop', networks: ['shopnet'], Config: { Env: ['PASSWORD=secret'] } }], volumes: [{ name: 'shop_data', driver: 'local', labels: {} }], certificates: [] };
  throw new Error('unexpected operation ' + request.operation);
};

test('any signed-in role reads how plain containers would be recreated; only names reach the helper', async () => {
  const response = await get(`/servers/${host}/describe-containers?containers=shop,db`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { containers: [{ name: 'shop', environment: ['PASSWORD'], unsupported: [] }], compose: 'services: {}\n' });
  assert.deepEqual(requests.at(-1), { operation: 'describe-containers', containers: ['shop', 'db'] });
});

test('describe-containers refuses bad, missing or too many names and anonymous callers before asking the server', async () => {
  const before = requests.length;
  for (const query of ['', '?containers=', '?containers=../etc', '?containers=-rf', '?containers=' + Array.from({ length: 31 }, (_, i) => 'c' + i).join(',')]) {
    assert.equal((await get(`/servers/${host}/describe-containers${query}`)).status, 400, query);
  }
  assert.equal((await get(`/servers/${host}/describe-containers?containers=shop`, null)).status, 401);
  assert.equal((await get('/servers/unknown/describe-containers?containers=shop')).status, 404);
  assert.equal(requests.length, before);
});

test('discovery adds each container\'s user networks and the server\'s volumes, and still redacts env values', async () => {
  const result = await (await get(`/servers/${host}/discover`)).json();
  assert.deepEqual(result.containers[0].networks, ['shopnet']);
  assert.deepEqual(result.containers[0].Config.Env, ['PASSWORD=[redacted]']);
  assert.deepEqual(result.volumes, [{ name: 'shop_data', driver: 'local', labels: {} }]);
});

test('volumes the server could not list stay null, never an empty list', async () => {
  const original = transport.remote;
  transport.remote = async () => ({ staticSites: [], containers: [], volumes: null, certificates: [] });
  try { assert.equal((await (await get(`/servers/${host}/discover`)).json()).volumes, null); }
  finally { transport.remote = original; }
});
