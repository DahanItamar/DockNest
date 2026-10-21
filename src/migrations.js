import { DatabaseSync } from 'node:sqlite';
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, renameSync, chmodSync, statSync, statfsSync } from 'node:fs';
import path from 'node:path';

// Versioned metadata schema. PRAGMA user_version lives in the database header, changes inside the same
// transaction as the DDL, survives VACUUM INTO/backup copies and is readable without knowing any table,
// so a schema_migrations table would add nothing but a second source of truth. v2.0.0 databases report 0.
// `compatible: true` marks a purely additive migration (new tables/indexes only) that older code can ignore, so
// downgrading across it needs no data discard. Rules: never edit or renumber a released migration; append a new entry. Migration 1 is the v2.0.0
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
  { version: 2, name: 'boot-recovery-installs', compatible: true, up: db => db.exec('CREATE TABLE IF NOT EXISTS boot_recovery_installs (site_id TEXT PRIMARY KEY REFERENCES sites(id),bundle_sha256 TEXT NOT NULL,helper_version INTEGER NOT NULL,installed_at TEXT NOT NULL)') },
  // Single-worker lease (replaces worker.lock) and (timestamp,id) indexes for keyset-paginated history.
  { version: 3, name: 'worker-lease-and-history-indexes', compatible: true, up: db => db.exec(`
    CREATE TABLE IF NOT EXISTS worker_lease (name TEXT PRIMARY KEY,holder TEXT NOT NULL,acquired_at TEXT NOT NULL,renewed_at TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS backups_captured ON backups(captured_at,id);
    CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at,id);
    CREATE INDEX IF NOT EXISTS restores_created ON restores(created_at,id);
    CREATE INDEX IF NOT EXISTS audit_created ON audit_events(created_at,id);
  `) },
  // Per-destination settings for non-SFTP backends (S3-compatible endpoint, bucket, prefix, Object Lock), and
  // retention deferrals for packages a provider's Object Lock still protects.
  { version: 4, name: 'storage-targets-and-retention-deferrals', compatible: true, up: db => db.exec(`
    CREATE TABLE IF NOT EXISTS storage_target_settings (target_id TEXT PRIMARY KEY REFERENCES storage_targets(id) ON DELETE CASCADE,kind TEXT NOT NULL,settings TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS retention_deferrals (backup_id TEXT PRIMARY KEY REFERENCES backups(id) ON DELETE CASCADE,retry_after INTEGER NOT NULL,retain_until TEXT,first_seen INTEGER NOT NULL);
  `) },
];
export const schemaVersion = migrations.at(-1).version;
export const snapshotsKept = 5;
const snapshotName = /^state-v(\d+)-to-v(\d+)-(\d{8}T\d{9}Z)\.sqlite$/;
export const listSnapshots = directory => { try { return readdirSync(directory).map(name => ({ name, match: snapshotName.exec(name) })).filter(item => item.match).map(({ name, match }) => ({ name, path: path.join(directory, name), from: Number(match[1]), to: Number(match[2]), at: match[3] })).sort((a, b) => a.at.localeCompare(b.at) || a.name.localeCompare(b.name)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
export class SchemaTooNewError extends Error {}
export class SnapshotSpaceError extends Error {}
// Oldest schema whose code can still run on this database: the highest non-compatible migration applied so far.
// Pure additive migrations (`compatible: true`) do not raise it, so older code may keep using the newer schema.
export const compatFloor = (list, upTo = list.at(-1).version) => Math.max(0, ...list.filter(migration => migration.version <= upTo && !migration.compatible).map(migration => migration.version));
const floorKey = 'schema_compat_floor';
const storedFloor = db => { try { const row = db.prepare('SELECT value FROM settings WHERE key=?').get(floorKey); return row ? Number(row.value) : null; } catch { return null; } };
// Newest of every distinct from->to pair plus the newest `snapshotsKept` overall, so a crash loop cannot evict history.
function rotate(directory) {
  const all = listSnapshots(directory), keep = new Set(all.slice(-snapshotsKept).map(item => item.name));
  for (const item of all) keep.add(all.filter(other => other.from === item.from && other.to === item.to).at(-1).name);
  for (const old of all) if (!keep.has(old.name)) rmSync(old.path, { force: true });
}
function snapshot(file, directory, from, to, now, space) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Leftovers of an interrupted or failed copy never become snapshots and would only hold disk space.
  for (const name of readdirSync(directory)) if (/^state-v\d+-to-v\d+-.*\.sqlite\.partial$/.test(name)) rmSync(path.join(directory, name), { force: true });
  const sizes = [file, file + '-wal'].map(name => { try { return statSync(name).size; } catch { return 0; } }), needed = Math.ceil((sizes[0] + sizes[1]) * 1.2) + 64 * 1024 * 1024;
  const stats = space(directory), free = Number(stats.bavail) * Number(stats.bsize);
  if (free < needed) throw new SnapshotSpaceError(`Not enough free disk space for the pre-upgrade snapshot: ${Math.ceil(needed / 1048576)} MiB needed in ${directory}, ${Math.floor(free / 1048576)} MiB free. The database was not changed. Free up space on the state volume and start again.`);
  // A failed start under a restart policy must not copy the database again: reuse a snapshot taken after the last write.
  const modified = Math.max(...sizes.map((_size, index) => { try { return statSync(index ? file + '-wal' : file).mtimeMs; } catch { return 0; } }));
  const existing = listSnapshots(directory).filter(item => item.from === from && item.to === to).at(-1);
  if (existing && statSync(existing.path).mtimeMs >= modified) return existing.path;
  const target = path.join(directory, `state-v${from}-to-v${to}-${now.toISOString().replace(/[-:.]/g, '')}.sqlite`), partial = target + '.partial';
  // VACUUM INTO accepts an existing empty file, so the copy is never readable by other users.
  closeSync(openSync(partial, 'wx', 0o600));
  try {
    // A second connection reads the last committed state while this process holds the write lock.
    const reader = new DatabaseSync(file);
    try { reader.exec('PRAGMA busy_timeout=300000'); reader.prepare('VACUUM INTO ?').run(partial); } finally { reader.close(); }
    chmodSync(partial, 0o600); renameSync(partial, target);
  } catch (error) { rmSync(partial, { force: true }); throw error; }
  rotate(directory);
  return target;
}
// Holds the write lock across snapshot + migration so an API and worker starting together migrate once.
export function migrate(db, { file, snapshotDir = path.join(path.dirname(file), 'upgrade-snapshots'), list = migrations, now = () => new Date(), space = statfsSync, log = message => console.error(message) } = {}) {
  const latest = list.at(-1).version;
  const [timeout] = Object.values(db.prepare('PRAGMA busy_timeout').get());
  db.exec('PRAGMA busy_timeout=300000');
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('PRAGMA user_version').get().user_version;
    if (current > latest) {
      const floor = storedFloor(db);
      if (floor !== null && floor <= latest) { db.exec('COMMIT'); log(`DockNest metadata schema v${current} is newer than this release (v${latest}) but only adds compatible objects; continuing without changes.`); return { from: current, to: current, snapshot: null }; }
      const restore = listSnapshots(snapshotDir).filter(item => item.to === current && item.from <= latest).at(-1);
      throw new SchemaTooNewError(`DockNest metadata schema v${current} is newer than this release understands (v${latest}). The database was migrated by a newer DockNest version, so this older version must not open it. Either start the newer release again, or roll back fully: stop api and worker, replace ${file} with the pre-upgrade snapshot ${restore ? restore.path : `in ${snapshotDir} (state-v<old>-to-v${current}-*.sqlite)`}, remove state.sqlite-wal and state.sqlite-shm, then start the previous release. See docs/upgrading.md#rolling-back.`);
    }
    let taken = null;
    const existing = current === 0 && !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get() ? false : current < latest;
    if (existing) taken = snapshot(file, snapshotDir, current, latest, now(), space);
    for (const migration of list) if (migration.version > current || migration.repeatable) migration.up(db);
    if (current !== latest) {
      db.exec(`PRAGMA user_version=${latest}`);
      db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(floorKey, String(compatFloor(list)));
    }
    db.exec('COMMIT');
    if (current < latest) log(existing ? `DockNest metadata schema migrated from v${current} to v${latest}; pre-upgrade snapshot ${path.basename(taken)}.` : `DockNest metadata initialised at schema v${latest}.`);
    return { from: current, to: latest, snapshot: taken };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.exec(`PRAGMA busy_timeout=${Number(timeout) || 5000}`); }
}
