// Proves that metadata written by a released DockNest version survives starting this checkout on the same DATA_DIR,
// that a pre-upgrade snapshot is written and that the previous release can be restored from it.
// Usage: node scripts/upgrade-compat.js [vX.Y.Z]   (needs the tag locally: fetch-depth 0 in CI). Synthetic data only.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, copyFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { schemaVersion } from '../src/migrations.js';

const tag = process.argv[2] || 'v2.0.0', root = new URL('..', import.meta.url), cwd = root.pathname.replace(/^\/([A-Za-z]:)/, '$1');
const work = await mkdtemp(join(tmpdir(), 'docknest-upgrade-compat-')), data = join(work, 'data'), old = join(work, 'old');
const env = { ...process.env, DATA_DIR: data, BACKUP_DIR: join(data, 'backups'), BACKUP_STORAGE: 'unconfigured', NODE_ENV: 'test', SECURE_COOKIES: 'false', APP_ORIGIN: 'http://127.0.0.1:3000', MASTER_KEY_FILE: join(data, 'master.key'), SETUP_TOKEN_FILE: join(data, 'setup.token') };
const node = (code, options = {}) => execFileSync(process.execPath, ['--no-addons', '--input-type=module', '-e', code], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
const version = file => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare('PRAGMA user_version').get().user_version; } finally { db.close(); } };
try {
  await mkdir(join(old, 'src'), { recursive: true }); await mkdir(data, { recursive: true });
  // The metadata layer of a release (src/db.js and what it imports) only needs Node built-ins, so it runs unmodified.
  execFileSync('tar', ['-x', '-C', old], { input: execFileSync('git', ['archive', '--format=tar', tag, 'src'], { cwd, maxBuffer: 64 * 1024 * 1024 }) });
  await writeFile(env.MASTER_KEY_FILE, randomBytes(32).toString('base64') + '\n', { mode: 0o600 });
  await writeFile(env.SETUP_TOKEN_FILE, randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
  node(`const {db}=await import('./src/db.js');const now=new Date().toISOString();
db.prepare("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES('admin','admin@example.invalid','fixture-hash','fixture-totp','[]',1,?,'Admin','admin')").run(now);
db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run('fixture-session','admin','fixture-csrf',Date.now()+3600000,Date.now(),Date.now(),Date.now());
db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('server','Fixture host','host.example.invalid',22,'docknest','sealed-fixture','${'0'.repeat(64)}',?)").run(now);
db.prepare("INSERT INTO sites VALUES('site','server','Fixture site',?,?)").run(JSON.stringify({containers:['app'],domains:['site.example.invalid']}),now);
db.prepare("INSERT INTO policies(site_id,enabled,schedule,timezone,retention) VALUES('site',1,'0 3 * * *','UTC',7)").run();
db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES('job','site','backup','completed','completed',?)").run(now);
db.prepare("INSERT INTO backups VALUES('backup','site','job',?,'fixture/site.enc',1024,?,'{}',1,1,?)").run(now,'a'.repeat(64),now);
db.close();`, { cwd: old });
  const state = join(data, 'state.sqlite');
  const from = version(state);
  assert.ok(from <= schemaVersion, `${tag} schema v${from} must not be newer than this checkout`);

  // Start this checkout's real API on the old state and read it through HTTP.
  const port = 3900 + Math.floor(Math.random() * 90);
  const api = spawn(process.execPath, ['--no-addons', 'src/server.js'], { cwd, env: { ...env, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; api.stdout.on('data', chunk => { logs += chunk; }); api.stderr.on('data', chunk => { logs += chunk; });
  let release;
  for (let attempt = 0; attempt < 60 && !release; attempt++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/api/version`); if (response.ok) release = await response.json(); } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  api.kill(); await new Promise(resolve => api.once('exit', resolve));
  assert.ok(release, 'API did not start on upgraded state:\n' + logs);
  assert.deepEqual(release, { version: JSON.parse(execFileSync('git', ['show', 'HEAD:package.json'], { cwd, encoding: 'utf8' })).version, schemaVersion });
  const migrated = from < schemaVersion;
  if (migrated) assert.match(logs, new RegExp(`schema migrated from v${from} to v${schemaVersion}`));
  assert.equal(version(state), schemaVersion);
  const snapshots = migrated ? (await readdir(join(data, 'upgrade-snapshots'))).filter(name => name.endsWith('.sqlite')) : [];
  if (migrated) assert.equal(snapshots.length, 1), assert.match(snapshots[0], new RegExp(`^state-v${from}-to-v${schemaVersion}-\\d{8}T\\d{9}Z\\.sqlite$`));

  const db = new DatabaseSync(state, { readOnly: true });
  assert.equal(db.prepare("SELECT role FROM users WHERE email='admin@example.invalid'").get().role, 'admin');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE token_hash='fixture-session'").get().count, 1, 'signed-in sessions survive');
  assert.equal(db.prepare("SELECT host FROM servers WHERE id='server'").get().host, 'host.example.invalid');
  assert.deepEqual(JSON.parse(db.prepare("SELECT config FROM sites WHERE id='site'").get().config).domains, ['site.example.invalid']);
  assert.equal(db.prepare("SELECT schedule FROM policies WHERE site_id='site'").get().schedule, '0 3 * * *');
  assert.equal(db.prepare("SELECT pinned FROM backups WHERE id='backup'").get().pinned, 1);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual({ ...db.prepare('SELECT version,schema_version FROM release_history WHERE version=?').get(release.version) }, { version: release.version, schema_version: schemaVersion }, 'the started API records its release');
  db.close();

  // Downgrade guard: a schema newer than this code that needs newer code (compat floor above ours) refuses to start and leaves the database alone.
  const future = new DatabaseSync(state); future.exec(`PRAGMA user_version=${schemaVersion + 1}`); future.prepare("UPDATE settings SET value=? WHERE key='schema_compat_floor'").run(String(schemaVersion + 1)); future.close();
  assert.throws(() => node("await import('./src/db.js');", { cwd }), error => /newer than this release understands/.test(error.stderr) && /upgrade-snapshots/.test(error.stderr));
  assert.equal(version(state), schemaVersion + 1);

  // Rollback: restoring the snapshot lets the previous release open its own data again.
  if (migrated) { for (const suffix of ['', '-wal', '-shm']) await rm(state + suffix, { force: true }); await copyFile(join(data, 'upgrade-snapshots', snapshots[0]), state); }
  else { const reset = new DatabaseSync(state); reset.exec(`PRAGMA user_version=${from}`); reset.close(); }
  const restored = node("const {db}=await import('./src/db.js');console.log(db.prepare(\"SELECT COUNT(*) AS count FROM backups\").get().count);db.close();", { cwd: old });
  assert.equal(restored.trim(), '1'); assert.equal(version(state), from);
  console.log(JSON.stringify({ from: tag, schemaVersion, snapshot: snapshots[0] || null, dataIntact: true, downgradeRefused: true, rollbackRestored: true }));
} finally { await rm(work, { recursive: true, force: true }); }
