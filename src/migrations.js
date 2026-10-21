import { DatabaseSync } from 'node:sqlite';
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, renameSync, chmodSync } from 'node:fs';
import path from 'node:path';

// Versioned metadata schema. PRAGMA user_version lives in the database header, changes inside the same
// transaction as the DDL, survives VACUUM INTO/backup copies and is readable without knowing any table,
// so a schema_migrations table would add nothing but a second source of truth. v2.0.0 databases report 0.
// Rules: never edit or renumber a released migration; append a new entry. Migration 1 is the v2.0.0
// startup schema and stays idempotent: it is re-applied on every start exactly as v2.0.0 did, so
// additive CREATE ... IF NOT EXISTS objects may still be appended to it. Anything else needs a new entry.
const baselineSchema = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,totp_secret TEXT NOT NULL,totp_last_counter INTEGER NOT NULL DEFAULT -1,recovery_codes TEXT NOT NULL,enrolled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf_token TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS challenges (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,reset_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS manager_backups (id TEXT PRIMARY KEY,status TEXT NOT NULL,created_at TEXT NOT NULL,finished_at TEXT,checksum TEXT,size INTEGER,release TEXT,error TEXT);
CREATE TABLE IF NOT EXISTS manager_backup_downloads (id TEXT PRIMARY KEY,backup_id TEXT NOT NULL REFERENCES manager_backups(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS manager_backup_active ON manager_backups((1)) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS storage_targets (id TEXT PRIMARY KEY,name TEXT NOT NULL,host TEXT NOT NULL,port INTEGER NOT NULL,username TEXT NOT NULL,host_key TEXT NOT NULL,auth_type TEXT NOT NULL,credential TEXT NOT NULL,root TEXT NOT NULL,capacity_bytes INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'unchecked',created_at TEXT NOT NULL,last_tested_at TEXT);
CREATE TABLE IF NOT EXISTS servers (id TEXT PRIMARY KEY,name TEXT NOT NULL,host TEXT NOT NULL,port INTEGER NOT NULL,username TEXT NOT NULL,private_key TEXT NOT NULL,host_key TEXT NOT NULL,capabilities TEXT,status TEXT NOT NULL DEFAULT 'unchecked',created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sites (id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id),name TEXT NOT NULL,config TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS site_archives (site_id TEXT PRIMARY KEY REFERENCES sites(id),archived_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS policies (site_id TEXT PRIMARY KEY REFERENCES sites(id),enabled INTEGER NOT NULL DEFAULT 0,schedule TEXT NOT NULL,timezone TEXT NOT NULL,retention INTEGER NOT NULL DEFAULT 7,next_run TEXT);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,site_id TEXT NOT NULL REFERENCES sites(id),type TEXT NOT NULL,status TEXT NOT NULL,stage TEXT NOT NULL,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,error TEXT,details TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY,site_id TEXT NOT NULL REFERENCES sites(id),job_id TEXT NOT NULL REFERENCES jobs(id),captured_at TEXT NOT NULL,path TEXT NOT NULL,size INTEGER NOT NULL,checksum TEXT NOT NULL,manifest TEXT NOT NULL,pinned INTEGER NOT NULL DEFAULT 0,verified INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS restores (id TEXT PRIMARY KEY,backup_id TEXT REFERENCES backups(id) ON DELETE SET NULL,server_id TEXT NOT NULL REFERENCES servers(id),mode TEXT NOT NULL,plan TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT,detail TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS leases (site_id TEXT PRIMARY KEY REFERENCES sites(id),job_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS downloads (id TEXT PRIMARY KEY,backup_id TEXT NOT NULL REFERENCES backups(id),expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status,created_at);
CREATE INDEX IF NOT EXISTS backups_site ON backups(site_id,created_at);
CREATE INDEX IF NOT EXISTS audit_date ON audit_events(created_at);
CREATE TABLE IF NOT EXISTS backup_verifications (backup_id TEXT NOT NULL REFERENCES backups(id) ON DELETE CASCADE,kind TEXT NOT NULL,status TEXT NOT NULL,evidence TEXT NOT NULL,job_id TEXT,checked_at TEXT NOT NULL,PRIMARY KEY(backup_id,kind));
CREATE TABLE IF NOT EXISTS backup_verification_history (id INTEGER PRIMARY KEY,backup_id TEXT NOT NULL REFERENCES backups(id) ON DELETE CASCADE,kind TEXT NOT NULL,status TEXT NOT NULL,evidence TEXT NOT NULL,job_id TEXT,checked_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifact_operations (backup_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),site_id TEXT NOT NULL REFERENCES sites(id),temporary TEXT NOT NULL,published TEXT NOT NULL,state TEXT NOT NULL,metadata TEXT NOT NULL,checksum TEXT,size INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS retention_operations (backup_id TEXT PRIMARY KEY REFERENCES backups(id) ON DELETE CASCADE,state TEXT NOT NULL,created_at TEXT NOT NULL);
`;
function baseline(db) {
  db.exec(baselineSchema);
  // Finished restore history must not retain its source package forever.
  // Plans preserve the original backupId after retention clears the live FK.
  const restoreSchema=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='restores'").get().sql;
  if(!/ON DELETE SET NULL/i.test(restoreSchema))db.exec(`
    CREATE TABLE restores_next (id TEXT PRIMARY KEY,backup_id TEXT REFERENCES backups(id) ON DELETE SET NULL,server_id TEXT NOT NULL REFERENCES servers(id),mode TEXT NOT NULL,plan TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
    INSERT INTO restores_next SELECT id,backup_id,server_id,mode,plan,status,created_at FROM restores;
    DROP TABLE restores;
    ALTER TABLE restores_next RENAME TO restores;
  `);
  const extend = (table, columns) => {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
    for (const [name, definition] of Object.entries(columns)) if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };
  extend('users', { name: "TEXT NOT NULL DEFAULT ''", role: "TEXT NOT NULL DEFAULT 'operator'", disabled: 'INTEGER NOT NULL DEFAULT 0', revoked_at: 'TEXT' });
  extend('servers', { note: "TEXT NOT NULL DEFAULT ''" });
  extend('manager_backups', {target_id:'TEXT',path:'TEXT'});
  extend('sessions', { last_activity_at: 'INTEGER NOT NULL DEFAULT 0', created_at: 'INTEGER NOT NULL DEFAULT 0', authenticated_at: 'INTEGER NOT NULL DEFAULT 0' });
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_challenges (token_hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,credential_epoch INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),token_hash TEXT UNIQUE NOT NULL,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL,created_by TEXT NOT NULL,revoked_at INTEGER,consumed_at INTEGER,attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS enrollment_challenges (token_hash TEXT PRIMARY KEY,invitation_id TEXT NOT NULL REFERENCES invitations(id),expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS invitations_user ON invitations(user_id,created_at);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  `);
  db.prepare("UPDATE users SET name=email WHERE name=''").run();
  const firstUser = db.prepare('SELECT * FROM users ORDER BY created_at,id LIMIT 1').get();
  if (firstUser && !db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) db.prepare("UPDATE users SET role='admin' WHERE id=?").run(firstUser.id);
  if (firstUser && !db.prepare("SELECT 1 FROM settings WHERE key='shared_password_hash'").get()) db.prepare("INSERT INTO settings VALUES ('shared_password_hash',?)").run(firstUser.password_hash);
  db.prepare("INSERT OR IGNORE INTO settings VALUES ('auth_epoch','0')").run();
  // Legacy sessions lack trustworthy idle/re-auth timestamps; require a fresh login.
  db.prepare('DELETE FROM sessions WHERE created_at=0').run();
  db.prepare('DELETE FROM challenges').run();
}
export const migrations = [
  { version: 1, name: 'baseline', repeatable: true, up: baseline },
  // Fingerprint of the helper bundle copied onto hosts by boot recovery, to flag stale copies after upgrades.
  { version: 2, name: 'boot-recovery-installs', up: db => db.exec('CREATE TABLE IF NOT EXISTS boot_recovery_installs (site_id TEXT PRIMARY KEY REFERENCES sites(id),bundle_sha256 TEXT NOT NULL,helper_version INTEGER NOT NULL,installed_at TEXT NOT NULL)') },
];
export const schemaVersion = migrations.at(-1).version;
export const snapshotsKept = 5;
const snapshotName = /^state-v(\d+)-to-v(\d+)-(\d{8}T\d{9}Z)\.sqlite$/;
export const listSnapshots = directory => { try { return readdirSync(directory).map(name => ({ name, match: snapshotName.exec(name) })).filter(item => item.match).map(({ name, match }) => ({ name, path: path.join(directory, name), from: Number(match[1]), to: Number(match[2]), at: match[3] })).sort((a, b) => a.at.localeCompare(b.at) || a.name.localeCompare(b.name)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
export class SchemaTooNewError extends Error {}
function snapshot(file, directory, from, to, now) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `state-v${from}-to-v${to}-${now.toISOString().replace(/[-:.]/g, '')}.sqlite`), partial = target + '.partial';
  // VACUUM INTO accepts an existing empty file, so the copy is never readable by other users.
  rmSync(partial, { force: true }); closeSync(openSync(partial, 'wx', 0o600));
  // A second connection reads the last committed state while this process holds the write lock.
  const reader = new DatabaseSync(file);
  try { reader.exec('PRAGMA busy_timeout=300000'); reader.prepare('VACUUM INTO ?').run(partial); } finally { reader.close(); }
  chmodSync(partial, 0o600); renameSync(partial, target);
  for (const old of listSnapshots(directory).slice(0, -snapshotsKept)) rmSync(old.path, { force: true });
  return target;
}
// Holds the write lock across snapshot + migration so an API and worker starting together migrate once.
export function migrate(db, { file, snapshotDir = path.join(path.dirname(file), 'upgrade-snapshots'), list = migrations, now = () => new Date(), log = message => console.error(message) } = {}) {
  const latest = list.at(-1).version;
  const [timeout] = Object.values(db.prepare('PRAGMA busy_timeout').get());
  db.exec('PRAGMA busy_timeout=300000');
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('PRAGMA user_version').get().user_version;
    if (current > latest) {
      const snapshots = listSnapshots(snapshotDir).filter(item => item.to === current), restore = snapshots.at(-1);
      throw new SchemaTooNewError(`DockNest metadata schema v${current} is newer than this release understands (v${latest}). The database was migrated by a newer DockNest version, so this older version must not open it. Either start the newer release again, or roll back fully: stop api and worker, replace ${file} with the pre-upgrade snapshot ${restore ? restore.path : `in ${snapshotDir} (state-v<old>-to-v${current}-*.sqlite)`}, remove state.sqlite-wal and state.sqlite-shm, then start the previous release. See docs/upgrading.md#rolling-back.`);
    }
    let taken = null;
    if (current < latest && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get()) taken = snapshot(file, snapshotDir, current, latest, now());
    for (const migration of list) if (migration.version > current || migration.repeatable) migration.up(db);
    if (current !== latest) db.exec(`PRAGMA user_version=${latest}`);
    db.exec('COMMIT');
    if (current < latest) log(`DockNest metadata schema migrated from v${current} to v${latest}${taken ? '; pre-upgrade snapshot ' + path.basename(taken) : ''}.`);
    return { from: current, to: latest, snapshot: taken };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.exec(`PRAGMA busy_timeout=${Number(timeout) || 5000}`); }
}
