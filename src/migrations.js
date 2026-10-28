import { DatabaseSync } from 'node:sqlite';
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, renameSync, chmodSync, statSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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
// Migration 5, kept verbatim with docs/update-center.md section 3 (tests compare both). Consent, the single-row check
// cache, every version this database ran, in-app upgrade requests (at most one active; needs_action stays active until
// resolved) with their phase timeline, and What's new. The CHECK limits back up the caps in code.
const updateCenterSchema = `
CREATE TABLE IF NOT EXISTS update_preferences (id INTEGER PRIMARY KEY CHECK (id = 1), check_enabled INTEGER NOT NULL CHECK (check_enabled IN (0,1)), decided_by TEXT NOT NULL REFERENCES users(id), decided_at TEXT NOT NULL, changed_by TEXT REFERENCES users(id), changed_at TEXT);
CREATE TABLE IF NOT EXISTS update_checks (id INTEGER PRIMARY KEY CHECK (id = 1), status TEXT NOT NULL CHECK (status IN ('ok','failed')), checked_at TEXT NOT NULL, last_success_at TEXT, next_check_at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, latest_version TEXT CHECK (length(latest_version) <= 32), published_at TEXT, manifest TEXT CHECK (length(manifest) <= 65536), release_notes TEXT CHECK (length(release_notes) <= 65536), releases TEXT CHECK (length(releases) <= 16384), etag TEXT CHECK (length(etag) <= 256), error TEXT CHECK (length(error) <= 2048));
CREATE TABLE IF NOT EXISTS release_history (version TEXT PRIMARY KEY CHECK (length(version) <= 32), schema_version INTEGER NOT NULL CHECK (typeof(schema_version) = 'integer' AND schema_version >= 0), first_started_at TEXT NOT NULL, last_started_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS update_requests (id TEXT PRIMARY KEY, from_version TEXT NOT NULL, to_version TEXT NOT NULL, from_schema INTEGER NOT NULL, to_schema INTEGER, requested_by TEXT NOT NULL REFERENCES users(id), requested_at TEXT NOT NULL, accepted_at TEXT, finished_at TEXT, state TEXT NOT NULL CHECK (state IN ('submitted','running','succeeded','refused','busy','rolled_back','needs_action','resolved','lost')), refusal TEXT CHECK (length(refusal) <= 64), exit_code INTEGER, retry_of TEXT REFERENCES update_requests(id), warning TEXT CHECK (length(warning) <= 1024), error TEXT CHECK (length(error) <= 2048), rollback_hint TEXT CHECK (length(rollback_hint) <= 4096), reason TEXT CHECK (reason IS NULL OR length(reason) <= 64), install_mode TEXT CHECK (install_mode IS NULL OR install_mode IN ('image','source')), updater_version TEXT CHECK (updater_version IS NULL OR length(updater_version) <= 32), env TEXT CHECK (env IS NULL OR length(env) <= 1024));
CREATE TABLE IF NOT EXISTS update_events (request_id TEXT NOT NULL REFERENCES update_requests(id), at TEXT NOT NULL, phase TEXT NOT NULL CHECK (length(phase) <= 32), PRIMARY KEY (request_id, at, phase));
CREATE UNIQUE INDEX IF NOT EXISTS update_requests_active ON update_requests((1)) WHERE state IN ('submitted','running','needs_action');
CREATE TABLE IF NOT EXISTS whats_new_seen (user_id TEXT PRIMARY KEY REFERENCES users(id), version TEXT NOT NULL, seen_at TEXT NOT NULL);
`;
// Site moves (docs/moving-sites.md): one row per move plus a per-step journal. Additive only: new tables and indexes,
// no rows, nothing altered. Backup ids carry no foreign key because retention may delete old backups; a move never does.
// The partial unique index keeps one unfinished move per site; its list must equal TERMINAL_STATES in src/moves/state.js.
export const siteMovesSchema = `
CREATE TABLE IF NOT EXISTS site_moves (id TEXT PRIMARY KEY,site_id TEXT NOT NULL REFERENCES sites(id),source_server_id TEXT NOT NULL REFERENCES servers(id),target_server_id TEXT NOT NULL REFERENCES servers(id),state TEXT NOT NULL CHECK (length(state) <= 32),waiting_for TEXT CHECK (waiting_for IS NULL OR length(waiting_for) <= 32),options TEXT NOT NULL CHECK (length(options) <= 65536),preflight TEXT NOT NULL CHECK (length(preflight) <= 262144),preflight_hash TEXT NOT NULL CHECK (length(preflight_hash) <= 128),backup_id TEXT,final_backup_id TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),actor TEXT NOT NULL,error TEXT CHECK (error IS NULL OR length(error) <= 2048),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,switched_at TEXT,retain_until TEXT,finished_at TEXT,CHECK (source_server_id <> target_server_id));
CREATE UNIQUE INDEX IF NOT EXISTS site_moves_active ON site_moves(site_id) WHERE state NOT IN ('rolled_back','cancelled','failed','switched_back','cleaned');
CREATE INDEX IF NOT EXISTS site_moves_created ON site_moves(created_at,id);
CREATE TABLE IF NOT EXISTS site_move_steps (move_id TEXT NOT NULL REFERENCES site_moves(id) ON DELETE CASCADE,step TEXT NOT NULL CHECK (length(step) <= 32),attempt INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempt) = 'integer' AND attempt >= 0),state TEXT NOT NULL CHECK (state IN ('pending','running','done','failed','skipped','undone','undo_failed')),started_at TEXT,finished_at TEXT,resources TEXT NOT NULL DEFAULT '{}' CHECK (length(resources) <= 65536),result TEXT NOT NULL DEFAULT '{}' CHECK (length(result) <= 65536),PRIMARY KEY (move_id,step));
`;
// Optional "Install on server" runs (docs/moving-sites.md). Kept apart from jobs because a job always belongs to a site.
export const serverInstallsSchema = `
CREATE TABLE IF NOT EXISTS server_installs (id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,package TEXT NOT NULL CHECK (package IN ('nginx','docker','compose','certbot')),status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),stage TEXT NOT NULL CHECK (length(stage) <= 32),steps TEXT NOT NULL CHECK (length(steps) <= 8192),actor TEXT NOT NULL,error TEXT CHECK (error IS NULL OR length(error) <= 1024),created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT);
CREATE INDEX IF NOT EXISTS server_installs_status ON server_installs(status,created_at);
`;
// Alerts (docs/alerts.md): credentials (secrets sealed with the master key), channels (the Map nodes, non-secret), rules (the lines on the Map) and the
// delivery queue the worker drains. Additive only: new tables and indexes, no rows, nothing altered. Rules carry no
// foreign key to servers or sites, so deleting those never fails; a rule for something gone simply never matches.
export const alertsSchema = `
CREATE TABLE IF NOT EXISTS alert_credentials (id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK (kind IN ('telegram','smtp')),name TEXT NOT NULL CHECK (length(name) <= 80),config TEXT NOT NULL CHECK (length(config) <= 8192),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_test TEXT CHECK (last_test IS NULL OR last_test IN ('ok','failed')),last_test_at TEXT,last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 200));
CREATE TABLE IF NOT EXISTS alert_channels (id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK (kind IN ('telegram','email')),name TEXT NOT NULL CHECK (length(name) <= 80),config TEXT NOT NULL CHECK (length(config) <= 8192),credential_id TEXT REFERENCES alert_credentials(id) ON DELETE SET NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_result TEXT CHECK (last_result IS NULL OR last_result IN ('ok','failed')),last_result_at TEXT,last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 200));
CREATE TABLE IF NOT EXISTS alert_rules (id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES alert_channels(id) ON DELETE CASCADE,source_kind TEXT NOT NULL CHECK (source_kind IN ('docknest','server','site')),source_id TEXT,events TEXT NOT NULL CHECK (length(events) <= 2048),enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,CHECK ((source_kind = 'docknest') = (source_id IS NULL)));
CREATE INDEX IF NOT EXISTS alert_rules_channel ON alert_rules(channel_id);
CREATE TABLE IF NOT EXISTS alert_queue (id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES alert_channels(id) ON DELETE CASCADE,event TEXT NOT NULL,dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) <= 200),message TEXT NOT NULL CHECK (length(message) <= 1000),status TEXT NOT NULL CHECK (status IN ('pending','sent','failed')),attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,created_at TEXT NOT NULL,finished_at TEXT);
CREATE INDEX IF NOT EXISTS alert_queue_due ON alert_queue(status,next_attempt_at);
CREATE INDEX IF NOT EXISTS alert_queue_dedupe ON alert_queue(channel_id,dedupe_key,created_at);
`;
// Automatic restore tests (docs/restore-tests.md): per-site settings (no row means off), one append-only row per test and
// its step journal. Additive only: new tables, indexes and triggers, no rows, nothing altered. The CHECK limits back up
// the ranges in src/restore-tests/limits.js. The partial unique indexes keep one unfinished test per site and one
// started, unfinished test (or clean-up) per test server, so queued tests for a server wait in line.
export const restoreTestsSchema = `
CREATE TABLE IF NOT EXISTS restore_test_settings (site_id TEXT PRIMARY KEY REFERENCES sites(id),enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),cadence TEXT NOT NULL DEFAULT 'weekly' CHECK (cadence IN ('daily','weekly','monthly')),server_id TEXT REFERENCES servers(id),allow_live_server INTEGER NOT NULL DEFAULT 0 CHECK (allow_live_server IN (0,1)),allow_internet INTEGER NOT NULL DEFAULT 0 CHECK (allow_internet IN (0,1)),time_limit_minutes INTEGER NOT NULL DEFAULT 30 CHECK (typeof(time_limit_minutes) = 'integer' AND time_limit_minutes BETWEEN 10 AND 120),memory_mb INTEGER NOT NULL DEFAULT 1024 CHECK (typeof(memory_mb) = 'integer' AND memory_mb BETWEEN 256 AND 16384),cpus REAL NOT NULL DEFAULT 1 CHECK (cpus BETWEEN 0.5 AND 16 AND cpus * 4 = CAST(cpus * 4 AS INTEGER)),probe TEXT CHECK (probe IS NULL OR length(probe) <= 512),next_due_at TEXT,skip_reason TEXT CHECK (skip_reason IS NULL OR length(skip_reason) <= 300),updated_at TEXT NOT NULL,updated_by TEXT);
CREATE INDEX IF NOT EXISTS restore_test_settings_due ON restore_test_settings(next_due_at) WHERE enabled = 1;
CREATE TABLE IF NOT EXISTS restore_tests (id TEXT PRIMARY KEY,site_id TEXT NOT NULL REFERENCES sites(id),backup_id TEXT REFERENCES backups(id) ON DELETE SET NULL,backup_captured_at TEXT NOT NULL,server_id TEXT NOT NULL REFERENCES servers(id),job_id TEXT REFERENCES jobs(id),trigger TEXT NOT NULL CHECK (trigger IN ('schedule','manual')),step TEXT CHECK (step IS NULL OR step IN ('check_space','copy_backup','restore_copy','start_containers','check_health','clean_up')),result TEXT CHECK (result IS NULL OR result IN ('passed','failed','couldnt_run','cancelled')),failed_step TEXT CHECK (failed_step IS NULL OR failed_step IN ('check_space','copy_backup','restore_copy','start_containers','check_health','clean_up')),reason TEXT CHECK (reason IS NULL OR length(reason) <= 300),restore_seconds INTEGER,total_seconds INTEGER,checks TEXT NOT NULL DEFAULT '[]' CHECK (length(checks) <= 8192),limits TEXT NOT NULL CHECK (length(limits) <= 1024),progress TEXT NOT NULL DEFAULT '{}' CHECK (length(progress) <= 16384),cleanup TEXT CHECK (cleanup IS NULL OR cleanup IN ('pending','done','failed','acknowledged')),cleanup_attempts INTEGER NOT NULL DEFAULT 0,cleanup_next_at TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),deadline_at TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS restore_tests_site_active ON restore_tests(site_id) WHERE result IS NULL OR cleanup IN ('pending','failed');
CREATE UNIQUE INDEX IF NOT EXISTS restore_tests_server_active ON restore_tests(server_id) WHERE started_at IS NOT NULL AND (result IS NULL OR cleanup IN ('pending','failed'));
CREATE INDEX IF NOT EXISTS restore_tests_site_created ON restore_tests(site_id,created_at,id);
CREATE INDEX IF NOT EXISTS restore_tests_backup ON restore_tests(backup_id,created_at);
CREATE TABLE IF NOT EXISTS restore_test_steps (test_id TEXT NOT NULL REFERENCES restore_tests(id),step TEXT NOT NULL CHECK (step IN ('check_space','copy_backup','restore_copy','start_containers','check_health','clean_up')),state TEXT NOT NULL CHECK (state IN ('pending','running','done','failed','skipped')),started_at TEXT,finished_at TEXT,detail TEXT CHECK (detail IS NULL OR length(detail) <= 500),PRIMARY KEY (test_id,step));
CREATE TRIGGER IF NOT EXISTS restore_tests_no_delete BEFORE DELETE ON restore_tests BEGIN SELECT RAISE(ABORT,'restore test history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS restore_test_steps_no_delete BEFORE DELETE ON restore_test_steps BEGIN SELECT RAISE(ABORT,'restore test steps are append-only'); END;
CREATE TRIGGER IF NOT EXISTS restore_tests_result_once BEFORE UPDATE OF result,failed_step,reason,checks,restore_seconds,total_seconds ON restore_tests WHEN OLD.result IS NOT NULL AND (NEW.result IS NOT OLD.result OR NEW.failed_step IS NOT OLD.failed_step OR NEW.reason IS NOT OLD.reason OR NEW.checks IS NOT OLD.checks OR NEW.restore_seconds IS NOT OLD.restore_seconds OR NEW.total_seconds IS NOT OLD.total_seconds) BEGIN SELECT RAISE(ABORT,'a restore test result is written once'); END;
`;
// Alert channels and Connections (docs/alert-channels.md, "Data model"). New tables only: the 2.8 alert tables have CHECK
// lists of kinds that SQLite cannot change without a rebuild, and a rebuild would fire ON DELETE CASCADE on the lines.
// The 2.8 tables stay frozen for a rollback to 2.9. `provider` is checked in code against the registry, never in SQL.
// `alert_legacy_import` records when the 2.8 rows were copied, so a later start can tell an older version changed them.
export const alertConnectionsSchema = `
CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY,provider TEXT NOT NULL CHECK (length(provider) <= 32),name TEXT NOT NULL CHECK (length(name) <= 80),secret TEXT NOT NULL CHECK (length(secret) <= 8192),settings TEXT NOT NULL CHECK (length(settings) <= 4096),origin TEXT,private_ok INTEGER NOT NULL DEFAULT 0 CHECK (private_ok IN (0,1)),created_by TEXT,updated_by TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_test TEXT CHECK (last_test IS NULL OR last_test IN ('ok','failed')),last_test_at TEXT,last_send TEXT CHECK (last_send IS NULL OR last_send IN ('ok','failed')),last_send_at TEXT,last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 200));
CREATE INDEX IF NOT EXISTS connections_origin ON connections(origin);
CREATE TABLE IF NOT EXISTS alert_nodes (id TEXT PRIMARY KEY,provider TEXT NOT NULL CHECK (length(provider) <= 32),name TEXT NOT NULL CHECK (length(name) <= 80),connection_id TEXT REFERENCES connections(id) ON DELETE RESTRICT,prefill TEXT CHECK (prefill IS NULL OR length(prefill) <= 2048),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS alert_nodes_connection ON alert_nodes(connection_id);
CREATE TABLE IF NOT EXISTS alert_lines (id TEXT PRIMARY KEY,node_id TEXT NOT NULL REFERENCES alert_nodes(id) ON DELETE CASCADE,source_kind TEXT NOT NULL CHECK (source_kind IN ('docknest','server','site')),source_id TEXT,events TEXT NOT NULL CHECK (length(events) <= 2048),enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,CHECK ((source_kind = 'docknest') = (source_id IS NULL)));
CREATE INDEX IF NOT EXISTS alert_lines_node ON alert_lines(node_id);
CREATE TABLE IF NOT EXISTS alert_outbox (id TEXT PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,node_id TEXT REFERENCES alert_nodes(id) ON DELETE SET NULL,event TEXT NOT NULL,dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) <= 200),message TEXT NOT NULL CHECK (length(message) <= 1000),payload TEXT CHECK (payload IS NULL OR length(payload) <= 4096),status TEXT NOT NULL CHECK (status IN ('pending','sent','failed')),attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL,finished_at TEXT);
CREATE INDEX IF NOT EXISTS alert_outbox_due ON alert_outbox(status,next_attempt_at);
CREATE INDEX IF NOT EXISTS alert_outbox_dedupe ON alert_outbox(connection_id,dedupe_key,created_at);
CREATE TABLE IF NOT EXISTS alert_legacy_import (id INTEGER PRIMARY KEY CHECK (id = 1),imported_at TEXT NOT NULL);
`;
// The 2.8 copy (docs/alert-channels.md, "Migrating 2.8 alerts"). Pure SQL and JSON: sealed values are copied byte for
// byte and never opened, so the master key is not needed. Nodes and lines keep their ids. It reads the 2.8 tables and
// never writes them. It runs once: the import row makes a repeated run (an interrupted start, a restart) a no-op.
const LEGACY_PROVIDER = Object.freeze({ telegram: 'telegram', smtp: 'email' }), OUTBOX_MAX_AGE_MS = 24 * 3600_000;
export const cutName = (text, max = 80) => [...String(text)].slice(0, max).join(''); // never inside a character
function legacyDestination(kind, config) {
  let value; try { value = JSON.parse(config); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  if (kind === 'telegram') return typeof value.chatId === 'string' && value.chatId ? { chatId: value.chatId } : null;
  return Array.isArray(value.to) && value.to.length ? { to: value.to, subjectPrefix: typeof value.subjectPrefix === 'string' ? value.subjectPrefix : '' } : null;
}
export function importLegacyAlerts(db, { at = new Date().toISOString(), newId = randomUUID } = {}) {
  if (db.prepare('SELECT 1 FROM alert_legacy_import WHERE id=1').get()) return;
  const insertConnection = db.prepare('INSERT INTO connections(id,provider,name,secret,settings,origin,private_ok,created_at,updated_at,last_test,last_test_at,last_send,last_send_at,last_error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const channels = db.prepare('SELECT * FROM alert_channels ORDER BY created_at,id').all(), nodeConnection = new Map();
  for (const credential of db.prepare('SELECT * FROM alert_credentials ORDER BY created_at,id').all()) {
    const provider = LEGACY_PROVIDER[credential.kind]; if (!provider) continue;
    // Group this credential's nodes by destination, first seen first. The first group keeps the credential's id and name.
    const groups = new Map();
    for (const node of channels.filter(row => row.credential_id === credential.id && row.kind === provider)) {
      const destination = legacyDestination(credential.kind, node.config), settings = destination && JSON.stringify(destination);
      if (!settings || settings.length > 4096) continue; // an unreadable destination: the node keeps it as prefill below
      if (!groups.has(settings)) groups.set(settings, []);
      groups.get(settings).push(node);
    }
    if (!groups.size) groups.set('{}', []); // unused: "Add the chat ID" or "Add recipients"; sends nothing until completed
    let first = true;
    for (const [settings, nodes] of groups) {
      const connectionId = first ? credential.id : newId(), name = first ? credential.name : cutName(`${credential.name} (${nodes[0].name})`);
      // The newest node result becomes the Connection's last send, so the Map keeps its "Sent" or "Could not send" caption.
      const last = nodes.filter(node => node.last_result).sort((a, b) => String(b.last_result_at).localeCompare(String(a.last_result_at)))[0];
      // Email keeps the 2.8 address rule for its relay (private_ok = 1); Telegram only ever reaches its fixed host.
      insertConnection.run(connectionId, provider, name, credential.config, settings, `legacy:${credential.id}`, provider === 'email' ? 1 : 0, credential.created_at, credential.updated_at, credential.last_test, credential.last_test_at, last?.last_result ?? null, last?.last_result_at ?? null, last ? last.last_error : credential.last_error);
      for (const node of nodes) nodeConnection.set(node.id, connectionId);
      first = false;
    }
  }
  // A node without a matching credential keeps its old destination as `prefill` (never a secret) and sends nothing.
  const insertNode = db.prepare('INSERT INTO alert_nodes(id,provider,name,connection_id,prefill,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
  for (const node of channels) { const connectionId = nodeConnection.get(node.id) ?? null; insertNode.run(node.id, node.kind, node.name, connectionId, connectionId || node.config.length > 2048 ? null : node.config, node.created_at, node.updated_at); }
  db.exec('INSERT INTO alert_lines(id,node_id,source_kind,source_id,events,enabled,created_at,updated_at) SELECT id,channel_id,source_kind,source_id,events,enabled,created_at,updated_at FROM alert_rules');
  // Every queue row of a node with a Connection, so occurrence keys are never sent twice and repeat windows still hold.
  // Pending ones are sent as their plain 2.8 text (payload NULL). A node without a Connection could never send its rows.
  const insertItem = db.prepare('INSERT INTO alert_outbox(id,connection_id,node_id,event,dedupe_key,message,payload,status,attempts,next_attempt_at,expires_at,created_at,finished_at) VALUES(?,?,?,?,?,?,NULL,?,?,?,?,?,?)');
  for (const item of db.prepare('SELECT * FROM alert_queue ORDER BY created_at,id').all()) {
    const connectionId = nodeConnection.get(item.channel_id), created = Date.parse(item.created_at); if (!connectionId) continue;
    insertItem.run(item.id, connectionId, item.channel_id, item.event, item.dedupe_key, item.message, item.status, item.attempts, item.next_attempt_at, Number.isFinite(created) ? created + OUTBOX_MAX_AGE_MS : 0, item.created_at, item.finished_at);
  }
  db.prepare('INSERT INTO alert_legacy_import(id,imported_at) VALUES(1,?)').run(at);
}
// Storage per site and backup copies (docs/backup-copies.md). Additive only: new tables and indexes, no rows, nothing
// altered. No foreign key points at backups or storage_targets: an older release deleting a backup row (its retention)
// must never fail or cascade, and the copy files it leaves are cleaned up when this release starts again.
// - site_storage: a site's own main destination (NULL main_target_id = the default destination, as before).
// - site_storage_copies: up to 3 extra destinations per site, each with its own retention (NULL = the site's count).
// - backup_copies: one row per backup and copy destination. status pending|copying|verified|failed|gave_up|deleted;
//   next_attempt_at (epoch ms) is read by the existing worker loop. delete_state/delete_after hold a copy's own
//   retention (and its Object Lock deferral) apart from the backup's.
// - backup_main_removed: the main package aged out while a copy is still kept; backups.path then names that copy.
// - manager_backup_copies: the recovery kit written to each other destination that holds copies.
export const backupCopiesSchema = `
CREATE TABLE IF NOT EXISTS site_storage (site_id TEXT PRIMARY KEY,main_target_id TEXT CHECK (main_target_id IS NULL OR length(main_target_id) <= 64),updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS site_storage_main ON site_storage(main_target_id);
CREATE TABLE IF NOT EXISTS site_storage_copies (site_id TEXT NOT NULL,target_id TEXT NOT NULL CHECK (length(target_id) <= 64),retention INTEGER CHECK (retention IS NULL OR (typeof(retention) = 'integer' AND retention BETWEEN 1 AND 365)),created_at TEXT NOT NULL,PRIMARY KEY(site_id,target_id));
CREATE INDEX IF NOT EXISTS site_storage_copies_target ON site_storage_copies(target_id);
CREATE TABLE IF NOT EXISTS backup_copies (backup_id TEXT NOT NULL,target_id TEXT NOT NULL CHECK (length(target_id) <= 64),path TEXT NOT NULL,status TEXT NOT NULL CHECK (status IN ('pending','copying','verified','failed','gave_up','deleted')),attempts INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer' AND attempts >= 0),next_attempt_at INTEGER,last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 300),verified_at TEXT,first_failed_at INTEGER,alerted INTEGER NOT NULL DEFAULT 0 CHECK (alerted IN (0,1)),delete_state TEXT CHECK (delete_state IS NULL OR delete_state IN ('pending','deferred')),delete_after INTEGER,retain_until TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(backup_id,target_id));
CREATE INDEX IF NOT EXISTS backup_copies_due ON backup_copies(status,next_attempt_at);
CREATE INDEX IF NOT EXISTS backup_copies_target ON backup_copies(target_id,status);
CREATE TABLE IF NOT EXISTS backup_main_removed (backup_id TEXT PRIMARY KEY,original_path TEXT NOT NULL,removed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS manager_backup_copies (backup_id TEXT NOT NULL,target_id TEXT NOT NULL,path TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(backup_id,target_id));
`;
// Migration 12: vulnerability radar (docs/security.md "Vulnerability radar"). Additive only: new tables and indexes, no rows,
// nothing altered, so 2.11 code ignores them (downgrade-safe). No foreign key points at users, so an older release can still
// remove a user who dismissed a finding; rows cascade only with their server, and lose their site link when a site goes.
// A missing radar_preferences row means the defaults (container probes on).
// Findings are one row per container_key+advisory_id: resolved_at keeps the history, dismissed_* records an admin decision,
// alerted_at marks a finding whose radar.finding_critical alert was written (cleared when radar.finding_resolved is).
export const radarSchema = `
CREATE TABLE IF NOT EXISTS radar_scans (id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, reason TEXT NOT NULL CHECK (reason IN ('scheduled','discovery','manual')), status TEXT NOT NULL CHECK (status IN ('requested','running','completed','failed')), requested_by TEXT, requested_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, containers INTEGER, findings INTEGER, feed_serial INTEGER, probes INTEGER CHECK (probes IS NULL OR probes IN (0,1)), error TEXT CHECK (error IS NULL OR length(error) <= 1024));
CREATE INDEX IF NOT EXISTS radar_scans_server ON radar_scans(server_id,requested_at);
CREATE UNIQUE INDEX IF NOT EXISTS radar_scans_active ON radar_scans(server_id) WHERE status IN ('requested','running');
CREATE TABLE IF NOT EXISTS radar_inventory (server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, container_key TEXT NOT NULL CHECK (length(container_key) <= 512), container_id TEXT, name TEXT, site_id TEXT REFERENCES sites(id) ON DELETE SET NULL, scan_id TEXT NOT NULL, data TEXT NOT NULL CHECK (length(data) <= 16384), seen_at TEXT NOT NULL, PRIMARY KEY (server_id, container_key));
CREATE TABLE IF NOT EXISTS radar_findings (id TEXT PRIMARY KEY, container_key TEXT NOT NULL CHECK (length(container_key) <= 512), server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, site_id TEXT REFERENCES sites(id) ON DELETE SET NULL, container_name TEXT, advisory_id TEXT NOT NULL CHECK (length(advisory_id) <= 64), kind TEXT NOT NULL CHECK (kind IN ('vulnerable','likely','eol','unknown')), severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','info')), product TEXT NOT NULL, version TEXT, source TEXT NOT NULL, fixed_in TEXT, evidence TEXT CHECK (evidence IS NULL OR length(evidence) <= 512), first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, resolved_at TEXT, dismissed_at TEXT, dismissed_by TEXT, dismiss_reason TEXT CHECK (dismiss_reason IS NULL OR length(dismiss_reason) <= 500), alerted_at TEXT, UNIQUE (container_key, advisory_id));
CREATE INDEX IF NOT EXISTS radar_findings_server ON radar_findings(server_id,resolved_at);
CREATE INDEX IF NOT EXISTS radar_findings_site ON radar_findings(site_id,resolved_at);
CREATE TABLE IF NOT EXISTS radar_advisories (id TEXT PRIMARY KEY CHECK (length(id) <= 64), feed_serial INTEGER NOT NULL, data TEXT NOT NULL CHECK (length(data) <= 16384), updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS radar_preferences (id INTEGER PRIMARY KEY CHECK (id = 1), container_probes INTEGER NOT NULL DEFAULT 1 CHECK (container_probes IN (0,1)), changed_by TEXT, changed_at TEXT);
`;
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
  // Update Center (docs/update-center.md section 3): tables and one partial unique index, no rows, nothing altered.
  { version: 5, name: 'update-center', compatible: true, up: db => db.exec(updateCenterSchema) },
  // Site moves (docs/moving-sites.md): two tables and their indexes, no rows, nothing altered.
  { version: 6, name: 'site-moves', compatible: true, up: db => db.exec(siteMovesSchema) },
  // Install on server: one additive table, nothing altered.
  { version: 7, name: 'server-installs', compatible: true, up: db => db.exec(serverInstallsSchema) },
  // Alert channels, rules and delivery queue (docs/alerts.md). Purely additive: renumber before release if another migration lands first.
  { version: 8, name: 'alerts', compatible: true, up: db => db.exec(alertsSchema) },
  // Automatic restore tests (docs/restore-tests.md). Purely additive: renumber before release if another migration lands first.
  { version: 9, name: 'restore-tests', compatible: true, up: db => db.exec(restoreTestsSchema) },
  // Alert Connections (docs/alert-channels.md): new tables plus a copy of the 2.8 alerts into them. The 2.8 tables are left
  // as they are, so older code can ignore the new ones and a downgrade keeps the alerts as they were at upgrade time.
  { version: 10, name: 'alert-connections', compatible: true, up: db => { db.exec(alertConnectionsSchema); importLegacyAlerts(db); } },
  // Storage per site and backup copies (docs/backup-copies.md): new tables and indexes only, so 2.10 code ignores them.
  { version: 11, name: 'backup-copies', compatible: true, up: db => db.exec(backupCopiesSchema) },
  // Vulnerability radar (docs/security.md): new tables and indexes only, so 2.11 code ignores them. Incremental backups take 13.
  { version: 12, name: 'vulnerability-radar', compatible: true, up: db => db.exec(radarSchema) },
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
