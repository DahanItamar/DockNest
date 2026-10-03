import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';

export const db = new DatabaseSync(path.join(config.dataDir, 'state.sqlite'));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,totp_secret TEXT NOT NULL,totp_last_counter INTEGER NOT NULL DEFAULT -1,recovery_codes TEXT NOT NULL,enrolled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf_token TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS challenges (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,reset_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS manager_backups (id TEXT PRIMARY KEY,status TEXT NOT NULL,created_at TEXT NOT NULL,finished_at TEXT,checksum TEXT,size INTEGER,release TEXT,error TEXT);
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
`);
// Additive, serialized migration preserves existing administrators and sessions.
db.exec('BEGIN IMMEDIATE');
try {
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
  db.exec('COMMIT');
} catch (error) { db.exec('ROLLBACK'); throw error; }
export const id = () => randomUUID();
export function parse(row) {
  if (!row) return row;
  const result = { ...row };
  for (const field of ['config','manifest','results','details','capabilities','plan','detail']) {
    if (typeof result[field] === 'string') { try { result[field] = JSON.parse(result[field]); } catch { /* Legacy text remains readable. */ } }
  }
  return result;
}
export function audit(actor, action, target = null, detail = {}) {
  db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?)').run(id(), actor, action, target, JSON.stringify(detail), new Date().toISOString());
}
export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
