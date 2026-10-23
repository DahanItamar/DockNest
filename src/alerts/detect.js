// Turns state changes that already happen in the database into alert events (docs/alerts.md). It only READS the tables
// jobs, site_moves, servers and update_checks and changes none of them, so backups, moves, server checks and update checks
// behave exactly as before. A cursor in `settings` keeps each change from being seen twice; the first run starts at "now",
// so enabling alerts never replays history.
import net from 'node:net';
import { db } from '../db.js';
import { checksEnabled, compareSemver, packageVersion, finalTag } from '../updates/check.js';
import { emit, deliverDue } from './delivery.js';
import { DISK_USED_PERCENT, DISK_FREE_BYTES } from './events.js';
import { enabledRules } from './store.js';

const CURSOR = 'alerts_cursor', UPDATE_NOTIFIED = 'alerts_update_notified';
const read = key => { try { return JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? 'null'); } catch { return null; } };
// Time zone for message times: the site's schedule policy, else the self-backup schedule, else UTC (messageFor).
const selfBackupZone = () => { try { return JSON.parse(db.prepare("SELECT value FROM settings WHERE key='manager_backup_config'").get()?.value ?? 'null')?.timezone ?? null; } catch { return null; } };
const zoneFor = siteId => { try { return db.prepare('SELECT timezone FROM policies WHERE site_id=?').get(siteId)?.timezone || selfBackupZone() || 'UTC'; } catch { return 'UTC'; } };
const write = (key, value) => db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));

export function detectJobsAndMoves(at = new Date().toISOString()) {
  const cursor = read(CURSOR);
  if (!cursor) { write(CURSOR, { jobs: at, moves: at }); return 0; }
  let count = 0, jobs = cursor.jobs, moves = cursor.moves;
  const finished = db.prepare(`SELECT j.id,j.status,j.finished_at,j.details,s.id AS site_id,s.name AS site,v.id AS server_id,v.name AS server FROM jobs j JOIN sites s ON s.id=j.site_id JOIN servers v ON v.id=s.server_id
    WHERE j.type='backup' AND j.status IN ('completed','failed','recovery_required') AND j.finished_at>? ORDER BY j.finished_at LIMIT 100`).all(cursor.jobs);
  for (const job of finished) {
    jobs = job.finished_at;
    let details = {}; try { details = JSON.parse(job.details); } catch { /* keep {} */ }
    if (details.moveId) continue; // the backups a move takes are part of the move, reported by its own events
    count += emit({ type: job.status === 'completed' ? 'backup.succeeded' : 'backup.failed', key: `site:${job.site_id}`, at: job.finished_at, siteId: job.site_id, timeZone: zoneFor(job.site_id), serverId: job.server_id, siteName: job.site, serverName: job.server });
  }
  const changed = db.prepare(`SELECT m.id,m.state,m.waiting_for,m.updated_at,m.site_id,m.source_server_id,m.target_server_id,s.name AS site,a.name AS source,b.name AS target FROM site_moves m JOIN sites s ON s.id=m.site_id JOIN servers a ON a.id=m.source_server_id JOIN servers b ON b.id=m.target_server_id
    WHERE m.updated_at>? AND m.state IN ('completed','rolled_back','failed','waiting','recovery_required') ORDER BY m.updated_at LIMIT 100`).all(cursor.moves);
  for (const move of changed) {
    moves = move.updated_at;
    const needs = move.state === 'waiting' || move.state === 'recovery_required';
    count += emit({ type: needs ? 'move.needs_you' : 'move.finished', detail: needs ? (move.state === 'waiting' ? move.waiting_for : 'decision') : move.state, key: `occ:move:${move.id}:${move.state}:${move.waiting_for ?? ''}`, at: move.updated_at, siteId: move.site_id, serverId: move.source_server_id, targetServerId: move.target_server_id, siteName: move.site, serverName: move.source, targetName: move.target });
  }
  // Rows written in the same millisecond as the cursor are re-read next time; the queue's dedupe keys make that harmless.
  if (jobs !== cursor.jobs || moves !== cursor.moves) write(CURSOR, { jobs, moves });
  return count;
}

export function detectUpdate() {
  if (!checksEnabled(db)) return 0;
  const row = db.prepare('SELECT latest_version FROM update_checks WHERE id=?').get(1);
  if (!row?.latest_version || !finalTag(row.latest_version)) return 0;
  const version = row.latest_version.replace(/^v/, '');
  try { if (compareSemver(version, packageVersion) <= 0) return 0; } catch { return 0; }
  if (read(UPDATE_NOTIFIED) === version) return 0;
  write(UPDATE_NOTIFIED, version);
  return emit({ type: 'update.available', key: `occ:update:${version}`, version });
}

// Disk: judged from the facts DockNest last collected about each server (capabilities), never by a new remote command.
export function detectDisk() {
  let count = 0;
  for (const server of db.prepare('SELECT id,name,capabilities FROM servers').all()) {
    let facts; try { facts = JSON.parse(server.capabilities ?? 'null'); } catch { facts = null; }
    const free = Number(facts?.freeBytes), total = Number(facts?.totalBytes);
    if (!Number.isFinite(free) || free < 0) continue;
    const usedPercent = total > 0 ? Math.min(100, (1 - free / total) * 100) : 0;
    if (free < DISK_FREE_BYTES || usedPercent > DISK_USED_PERCENT) count += emit({ type: 'server.disk_low', key: `server:${server.id}`, serverId: server.id, serverName: server.name, freeBytes: free, usedPercent });
  }
  return count;
}

// Reachability: a plain TCP connect to the server's SSH port, the same address DockNest already uses. Two misses in a row
// (a few minutes apart) count as unreachable; one miss never alerts. Opens no session and runs no command.
export const probe = { connect: (host, port) => new Promise(resolve => { const socket = net.connect({ host, port, timeout: 5000 }); const done = ok => { socket.destroy(); resolve(ok); }; socket.once('connect', () => done(true)); socket.once('timeout', () => done(false)); socket.once('error', () => done(false)); }) };
const misses = new Map();
export async function detectUnreachable() {
  if (!enabledRules().some(rule => rule.events.includes('server.unreachable'))) return 0;
  let count = 0;
  for (const server of db.prepare('SELECT id,name,host,port FROM servers').all()) {
    if (await probe.connect(server.host, server.port)) { misses.delete(server.id); continue; }
    const seen = (misses.get(server.id) ?? 0) + 1; misses.set(server.id, seen);
    if (seen >= 2) count += emit({ type: 'server.unreachable', key: `server:${server.id}`, timeZone: selfBackupZone() || 'UTC', serverId: server.id, serverName: server.name });
  }
  return count;
}
export const resetProbeState = () => misses.clear();

// Worker entry points. Each swallows its own errors: alerting must never stop backups, moves or the update check.
const guard = (label, fn) => { try { return fn(); } catch (error) { console.error(`Alerts: ${label} skipped (${error.code ?? error.name})`); return 0; } };
export function tickAlerts() {
  guard('detect', detectJobsAndMoves); guard('update', detectUpdate); guard('disk', detectDisk);
  deliverDue().catch(error => console.error(`Alerts: delivery skipped (${error.code ?? error.name})`));
}
let nextProbe = 0, probing = false;
export function tickReachability(at = Date.now()) {
  if (probing || at < nextProbe) return;
  probing = true; nextProbe = at + 5 * 60_000;
  detectUnreachable().catch(error => console.error(`Alerts: reachability check skipped (${error.code ?? error.name})`)).finally(() => { probing = false; });
}
