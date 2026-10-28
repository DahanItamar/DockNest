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
  if (!cursor) { write(CURSOR, { jobs: at, moves: at, tests: at, testCleanups: at, copies: at, radar: at }); return 0; }
  let count = 0, jobs = cursor.jobs, moves = cursor.moves;
  // Restore tests: a cursor from before 2.9.0 has no `tests` field, which means "start now", so no history is replayed.
  const tests = cursor.tests ? detectRestoreTests(cursor.tests, cursor.testCleanups ?? cursor.tests) : { count: 0, tests: at, cleanups: at };
  count += tests.count;
  // Backup copies: a cursor from before 2.11.0 has no `copies` field, which means "start now" (no history replayed).
  const copies = cursor.copies ? detectCopies(cursor.copies) : { count: 0, at };
  count += copies.count;
  // Vulnerability radar: a cursor from before 2.12.0 has no `radar` field, which means "start now" (no history replayed).
  const radar = cursor.radar ? detectRadar(cursor.radar, cursor.radarId ?? '') : { count: 0, at, id: '' };
  count += radar.count;
  const finished = db.prepare(`SELECT j.id,j.status,j.finished_at,j.details,s.id AS site_id,s.name AS site,v.id AS server_id,v.name AS server FROM jobs j JOIN sites s ON s.id=j.site_id JOIN servers v ON v.id=s.server_id
    WHERE j.type='backup' AND j.status IN ('completed','failed','recovery_required') AND j.finished_at>? ORDER BY j.finished_at LIMIT 100`).all(cursor.jobs);
  for (const job of finished) {
    jobs = job.finished_at;
    let details = {}; try { details = JSON.parse(job.details); } catch { /* keep {} */ }
    if (details.moveId) continue; // the backups a move takes are part of the move, reported by its own events
    count += emit({ type: job.status === 'completed' ? 'backup.succeeded' : 'backup.failed', key: `site:${job.site_id}`, at: job.finished_at, jobId: job.id, code: job.status, siteId: job.site_id, timeZone: zoneFor(job.site_id), serverId: job.server_id, siteName: job.site, serverName: job.server });
  }
  const changed = db.prepare(`SELECT m.id,m.state,m.waiting_for,m.updated_at,m.site_id,m.source_server_id,m.target_server_id,s.name AS site,a.name AS source,b.name AS target FROM site_moves m JOIN sites s ON s.id=m.site_id JOIN servers a ON a.id=m.source_server_id JOIN servers b ON b.id=m.target_server_id
    WHERE m.updated_at>? AND m.state IN ('completed','rolled_back','failed','waiting','recovery_required') ORDER BY m.updated_at LIMIT 100`).all(cursor.moves);
  for (const move of changed) {
    moves = move.updated_at;
    const needs = move.state === 'waiting' || move.state === 'recovery_required';
    count += emit({ type: needs ? 'move.needs_you' : 'move.finished', detail: needs ? (move.state === 'waiting' ? move.waiting_for : 'decision') : move.state, key: `occ:move:${move.id}:${move.state}:${move.waiting_for ?? ''}`, at: move.updated_at, siteId: move.site_id, serverId: move.source_server_id, targetServerId: move.target_server_id, siteName: move.site, serverName: move.source, targetName: move.target });
  }
  // Rows written in the same millisecond as the cursor are re-read next time; the queue's dedupe keys make that harmless.
  if (jobs !== cursor.jobs || moves !== cursor.moves || tests.tests !== cursor.tests || tests.cleanups !== cursor.testCleanups || copies.at !== cursor.copies || radar.at !== cursor.radar || radar.id !== (cursor.radarId ?? '')) write(CURSOR, { jobs, moves, tests: tests.tests, testCleanups: tests.cleanups, copies: copies.at, radar: radar.at, radarId: radar.id });
  return count;
}

// Finished restore tests (failed, couldn't run, passed after a failure) and clean-ups that failed after their retries.
// Clean-up failures are read from the audit row the engine writes, so a retried clean-up that fails again alerts again.
// The site's own server and the test server both match server rules; {server} in the message is the test server.
function detectRestoreTests(since, cleanupsSince) {
  let count = 0, last = since, lastCleanup = cleanupsSince;
  const finished = db.prepare(`SELECT t.id,t.site_id,t.result,t.finished_at,t.server_id,s.name AS site,s.server_id AS live_id,v.name AS server FROM restore_tests t JOIN sites s ON s.id=t.site_id JOIN servers v ON v.id=t.server_id
    WHERE t.finished_at>? AND t.result IN ('passed','failed','couldnt_run') ORDER BY t.finished_at,t.id LIMIT 100`).all(since);
  for (const test of finished) {
    last = test.finished_at;
    let type = test.result === 'failed' ? 'restore_test.failed' : test.result === 'couldnt_run' ? 'restore_test.couldnt_run' : null;
    if (test.result === 'passed') {
      const previous = db.prepare("SELECT result FROM restore_tests WHERE site_id=? AND id<>? AND result IN ('passed','failed') AND finished_at<=? ORDER BY finished_at DESC,id DESC LIMIT 1").get(test.site_id, test.id, test.finished_at);
      if (previous?.result === 'failed') type = 'restore_test.recovered';
    }
    if (type) count += emit({ type, key: `occ:restore-test:${test.id}:${type}`, at: test.finished_at, siteId: test.site_id, serverId: test.live_id, targetServerId: test.server_id, timeZone: zoneFor(test.site_id), siteName: test.site, serverName: test.server });
  }
  const failures = db.prepare(`SELECT a.id,a.created_at,a.target AS site_id,a.detail FROM audit_events a WHERE a.action='restore_test.cleanup_failed' AND a.created_at>? ORDER BY a.created_at,a.id LIMIT 100`).all(cleanupsSince);
  for (const row of failures) {
    lastCleanup = row.created_at;
    let details = {}; try { details = JSON.parse(row.detail || '{}'); } catch { /* keep {} */ }
    const info = db.prepare('SELECT s.name AS site,s.server_id AS live_id,v.id AS server_id,v.name AS server FROM sites s JOIN servers v ON v.id=? WHERE s.id=?').get(details.server ?? '', row.site_id);
    if (!info) continue;
    count += emit({ type: 'restore_test.needs_you', key: `occ:restore-test-cleanup:${row.id}`, at: row.created_at, siteId: row.site_id, serverId: info.live_id, targetServerId: info.server_id, timeZone: zoneFor(row.site_id), siteName: info.site, serverName: info.server });
  }
  return { count, tests: last, cleanups: lastCleanup };
}

// Backup copies (docs/backup-copies.md): read from the audit rows the copy step writes. backup.copy_failed is written once
// per copy (its first failure), backup.copy_recovered when that copy is verified later. Names only: the destination
// name the owner typed, never a host, bucket or error text.
function detectCopies(since) {
  let count = 0, last = since;
  const rows = db.prepare("SELECT id,action,target,detail,created_at FROM audit_events WHERE action IN ('backup.copy_failed','backup.copy_recovered','backup.copy_gave_up') AND created_at>? ORDER BY created_at,id LIMIT 100").all(since);
  for (const row of rows) {
    last = row.created_at;
    let detail = {}; try { detail = JSON.parse(row.detail || '{}'); } catch { /* keep {} */ }
    const info = db.prepare('SELECT s.id AS site_id,s.name AS site,v.id AS server_id,v.name AS server FROM sites s JOIN servers v ON v.id=s.server_id WHERE s.id=?').get(detail.siteId ?? '');
    if (!info) continue;
    const jobId = db.prepare('SELECT job_id FROM backups WHERE id=?').get(row.target)?.job_id;
    count += emit({ type: row.action, key: `occ:copy:${row.id}`, at: row.created_at, jobId, code: detail.reason, siteId: info.site_id, serverId: info.server_id, timeZone: zoneFor(info.site_id), siteName: info.site, serverName: info.server, destinationName: detail.targetName });
  }
  return { count, at: last };
}

// Vulnerability radar (docs/security.md): read from the audit rows a scan writes. A finding writes radar.finding_critical
// once (radar_findings.alerted_at) and radar.finding_resolved once when it goes away, so each audit row is one occurrence.
// Names only: the site (or, for a container no site lists, its container name), the server and the product.
// The cursor is (created_at, id): one scan writes many rows in the same millisecond, and a page of 100 may end inside them.
function detectRadar(since, sinceId) {
  let count = 0, last = since, lastId = sinceId;
  const rows = db.prepare("SELECT id,action,target,detail,created_at FROM audit_events WHERE action IN ('radar.finding_critical','radar.finding_resolved') AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT 100").all(since, since, sinceId);
  for (const row of rows) {
    last = row.created_at; lastId = row.id;
    let detail = {}; try { detail = JSON.parse(row.detail || '{}'); } catch { /* keep {} */ }
    const info = db.prepare('SELECT f.site_id,f.server_id,f.container_name,s.name AS site,v.name AS server FROM radar_findings f JOIN servers v ON v.id=f.server_id LEFT JOIN sites s ON s.id=f.site_id WHERE f.id=?').get(row.target ?? '');
    if (!info) continue;
    count += emit({ type: row.action, key: `occ:radar:${row.id}`, at: row.created_at, siteId: info.site_id, serverId: info.server_id, timeZone: info.site_id ? zoneFor(info.site_id) : selfBackupZone() || 'UTC', siteName: info.site ?? info.container_name, serverName: info.server, product: detail.product });
  }
  return { count, at: last, id: lastId };
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
