import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
// Security regression: operators could set any host path as a site's configuration file (captured as root and
// downloadable as a decrypted ZIP) or as its maintenance directory (written as root).
const directory = await mkdtemp(join(tmpdir(), 'docknest-paths-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app, sitePathChanges, discoveredSitePaths } = await import('../src/server.js');
const { db, id } = await import('../src/db.js');
const { digest } = await import('../src/crypto.js');
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
const token = randomBytes(32).toString('base64url'), csrf = 'fixture-csrf', user = id(), host = id(), other = id();
db.prepare("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)").run(user, 'paths@example.invalid', 'fixture', 'fixture', '[]', new Date().toISOString(), 'Paths', 'admin');
db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), user, csrf, Date.now() + 3600000, Date.now(), Date.now(), Date.now());
// The private key is not a sealed value, so discovery fails without contacting anything: no path is confirmed.
for (const server of [host, other]) db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(server, 'Fixture', '127.0.0.1', 1, 'root', 'fixture', '0'.repeat(64), new Date().toISOString());
const role = value => db.prepare('UPDATE users SET role=? WHERE id=?').run(value, user);
const call = (route, method, body) => fetch(base + route, { method, headers: { Cookie: 'dbm_session=' + token, Origin: process.env.APP_ORIGIN, 'x-csrf-token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const docker = { serverId: host, name: 'Path fixture', config: { containers: ['fixture-app'] } };
const staticSite = { serverId: host, name: 'Static fixture', config: { kind: 'static', containers: [], documentRoot: '/var/www/example.org' } };
const maintenance = { required: true, directory: '/var/www/example.org/maintenance', publicUrl: 'https://www.example.org', healthUrl: '' };
const edits = {
  configFiles: { ...docker.config, configFiles: ['/opt/other/.env'] },
  composeFiles: { ...docker.config, composeFiles: ['/opt/other/compose.yaml'] },
  stagingRoot: { ...docker.config, stagingRoot: '/srv/docknest-staging' },
  maintenanceDirectory: { ...docker.config, maintenance },
};

test('operators get 403 for each path field they add or change; administrators may set them', async () => {
  role('operator');
  try {
    for (const [field, config] of Object.entries(edits)) {
      const response = await call('/sites', 'POST', { ...docker, config });
      assert.equal(response.status, 403, field);
      const body = await response.json();
      assert.equal(body.code, 'ADMIN_REQUIRED'); assert.match(body.error, /^Only an administrator can change the /);
    }
    assert.equal((await call('/sites', 'POST', staticSite)).status, 403, 'documentRoot');
    assert.equal((await call('/sites', 'POST', docker)).status, 201, 'a site without host paths is still an operator action');
  } finally { role('admin'); }
  const created = {};
  for (const [field, config] of Object.entries(edits)) { const response = await call('/sites', 'POST', { ...docker, config }); assert.equal(response.status, 201, field); created[field] = await response.json(); }
  const savedStatic = await call('/sites', 'POST', staticSite); assert.equal(savedStatic.status, 201);
  created.documentRoot = await savedStatic.json();
  role('operator');
  try {
    // Saved values set by an administrator stay usable: an operator can edit other fields, or remove paths.
    for (const [field, site] of Object.entries(created)) {
      const response = await call('/sites/' + site.id, 'PATCH', { serverId: host, name: 'Renamed by operator', config: site.config });
      assert.equal(response.status, 200, field);
    }
    assert.equal((await call('/sites/' + created.configFiles.id, 'PATCH', { serverId: host, name: 'Removed', config: { ...created.configFiles.config, configFiles: [] } })).status, 200);
    const site = created.maintenanceDirectory;
    for (const config of [{ ...site.config, configFiles: ['/opt/app/.env'] }, { ...site.config, maintenance: { ...site.config.maintenance, directory: '/var/www/other' } }, { ...site.config, stagingRoot: '/srv/staging' }]) {
      const response = await call('/sites/' + site.id, 'PATCH', { serverId: host, name: 'Changed by operator', config });
      assert.equal(response.status, 403);
    }
    assert.equal((await call('/sites/' + created.composeFiles.id, 'PATCH', { serverId: other, name: 'Moved', config: created.composeFiles.config })).status, 403, 'moving a site to another server re-checks its paths');
    assert.equal(JSON.parse(db.prepare('SELECT config FROM sites WHERE id=?').get(site.id).config).maintenance.directory, maintenance.directory);
  } finally { role('admin'); }
  assert.equal((await call('/sites/' + created.composeFiles.id, 'PATCH', { serverId: other, name: 'Moved', config: created.composeFiles.config })).status, 200);
});

test('paths reported by discovery are accepted for operators; stagingRoot and the maintenance directory never are', () => {
  const found = discoveredSitePaths({ staticSites: [{ documentRoot: '/var/www/example.org', configFiles: ['/etc/nginx/sites-enabled/example.org'] }], containers: [{ backupConfiguration: { composeFiles: ['/opt/app/compose.yaml'], configFiles: ['/opt/app/.env'] } }] });
  assert.deepEqual([...found.configFiles], ['/opt/app/.env', '/etc/nginx/sites-enabled/example.org']);
  assert.deepEqual([...found.composeFiles], ['/opt/app/compose.yaml']);
  assert.deepEqual([...found.documentRoot], ['/var/www/example.org']);
  assert.deepEqual(discoveredSitePaths(null).configFiles.size, 0);
  const changes = sitePathChanges(null, { serverId: host, config: { configFiles: ['/opt/app/.env'], composeFiles: [], stagingRoot: '/var/lib/docknest', maintenance: { directory: '/var/lib/docknest/maintenance/s1' } } }, 's1');
  assert.deepEqual(Object.fromEntries(Object.entries(changes).filter(([, value]) => value.length)), { configFiles: ['/opt/app/.env'] }, 'the default staging root and derived maintenance directory are not changes');
  const saved = { serverId: host, config: { configFiles: ['/opt/app/.env'], stagingRoot: '/var/lib/docknest', maintenance: { directory: '/srv/m' } } };
  assert.deepEqual(sitePathChanges(saved, { serverId: host, config: { ...saved.config, configFiles: ['/opt/app/.env', '/opt/app/extra.env'] } }, 's1').configFiles, ['/opt/app/extra.env']);
  assert.deepEqual(sitePathChanges(saved, { serverId: other, config: saved.config }, 's1').maintenanceDirectory, ['/srv/m']);
});

test.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); await rm(directory, { recursive: true, force: true }); });
