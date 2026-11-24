// Unraid app restore: the saved template is put back after the container restore succeeds; never on other servers, and a failure never fails the restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-nas-restore-'));
Object.assign(process.env, { DATA_DIR: join(directory, 'data'), BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
const masterKey = randomBytes(32);
await writeFile(process.env.MASTER_KEY_FILE, masterKey.toString('base64'));
const { db } = await import('../src/db.js');
const engine = await import('../src/engine.js');
const at = new Date().toISOString();
const serverRow = name => { const serverId = randomUUID(); db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(serverId, name, '192.0.2.10', 22, 'root', 'unused', 'a'.repeat(64), 'connected', at); return serverId; };
const siteRow = (serverId, name, config = { containers: ['wiki-web-1'], composeFiles: ['/srv/wiki/compose.yaml'], configFiles: ['/srv/wiki/.env'] }) => { const siteId = randomUUID(); db.prepare('INSERT INTO sites(id,server_id,name,config,created_at) VALUES(?,?,?,?,?)').run(siteId, serverId, name, JSON.stringify(config), at); return siteId; };
const backupRow = (siteId, capturedAt, manifest = {}) => { const backupId = randomUUID(), jobId = randomUUID(); db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','completed','completed',?)").run(jobId, siteId, capturedAt); db.prepare('INSERT INTO backups(id,site_id,job_id,captured_at,path,size,checksum,manifest,verified,pinned,created_at) VALUES(?,?,?,?,?,?,?,?,1,0,?)').run(backupId, siteId, jobId, capturedAt, 'fixture/' + backupId + '.enc', 1, 'a'.repeat(64), JSON.stringify(manifest), capturedAt); return backupId; };

const setup = capabilities => {
  const serverId = serverRow('NAS server'), siteId = siteRow(serverId, 'Journal');
  if (capabilities) db.prepare('UPDATE servers SET capabilities=? WHERE id=?').run(JSON.stringify(capabilities), serverId);
  return { serverId, siteId };
};
async function runRestore({ capabilities, hook }) {
  const { serverId, siteId } = setup(capabilities), requests = [];
  engine.transport.remote = async (_server, request) => {
    requests.push(request.operation);
    if (request.operation === 'plan') return { fingerprint: 'plan' };
    if (request.operation === 'capture') return { remotePath: '/var/lib/docknest/job/payload.tar.gz', root: '/var/lib/docknest/' + request.job, manifest: { kind: 'docker', complete: true, capturedAt: Date.now() / 1000, downtimeSeconds: 1, originalImages: [], architecture: 'x86_64', containers: [], snapshotImages: [], configurationFiles: [] } };
    if (request.operation === 'list-staging') return { root: '/var/lib/docknest', jobs: [] };
    if (request.operation === 'prepare-restore') return { remotePath: '/var/lib/docker-backup-manager/restore/' + request.job + '/payload.tar.gz' };
    if (request.operation === 'restore') return { verification: { isolatedRestore: { status: 'passed' } } };
    if (request.operation === 'nas-template-restore') return hook(request);
    return {};
  };
  engine.transport.download = async (_server, _path, output) => { output.end(Buffer.from('authenticated fixture payload')); };
  engine.transport.uploadStream = async (_server, input) => { for await (const _chunk of input); };
  engine.enqueueBackup(siteId, 'test'); await engine.executeJob(engine.claimJob());
  const backup = db.prepare('SELECT * FROM backups WHERE site_id=?').get(siteId);
  const restoreId = randomUUID(), jobId = randomUUID();
  db.prepare("INSERT INTO restores(id,backup_id,server_id,mode,plan,status,created_at) VALUES(?,?,?,'new-copy',?,'queued',?)").run(restoreId, backup.id, serverId, JSON.stringify({ mappings: {} }), at);
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,'restore','queued','queued',?,?)").run(jobId, siteId, at, JSON.stringify({ restoreId, backupId: backup.id, targetServerId: serverId }));
  await engine.executeJob(engine.claimJob());
  return { requests, job: db.prepare('SELECT status,details FROM jobs WHERE id=?').get(jobId) };
}

test('an Unraid restore puts the template back after the app restored', async () => {
  const done = await runRestore({ capabilities: { nas: { kind: 'unraid' } }, hook: request => ({ templates: [{ status: 'restored', path: '/boot/x' }], job: request.job }) });
  assert.equal(done.job.status, 'completed');
  assert.ok(done.requests.indexOf('nas-template-restore') > done.requests.indexOf('restore'));
  const result = JSON.parse(done.job.details).result;
  assert.deepEqual(result.nasTemplates, [{ status: 'restored' }], 'only the status is kept, never a path');
});
test('a template failure is a note, never a failed restore', async () => {
  const done = await runRestore({ capabilities: { nas: { kind: 'unraid' } }, hook: () => { throw new Error('boom'); } });
  assert.equal(done.job.status, 'completed');
  assert.deepEqual(JSON.parse(done.job.details).result.nasTemplates, [{ status: 'failed' }]);
});
test('other servers never get the call', async () => {
  for (const capabilities of [null, { nas: { kind: 'truenas' } }, { nas: { kind: 'synology' } }]) {
    const done = await runRestore({ capabilities, hook: () => { throw new Error('must not run'); } });
    assert.equal(done.job.status, 'completed'); assert.ok(!done.requests.includes('nas-template-restore'));
  }
});
