// Server cleanup hold (docs/server-cleanup.md). While a clean runs on a server, no job may start there: claimJob, the
// install claim and a restore test's first step defer (never fail) work on a held server. The hold is a row in the
// existing settings table (no schema change), so the worker process sees it. It is released when the clean ends, and a
// hold left by a crashed API process goes stale after HOLD_MS, so it can never block a server for good.
import { db } from './db.js';

export const HOLD_MS = 45 * 60_000;
const PREFIX = 'cleanup_hold:';
// SQL: true while the server named by `serverExpr` (an SQL expression) has a live cleanup hold.
export const CLEANUP_HELD = serverExpr => `EXISTS(SELECT 1 FROM settings h WHERE h.key='${PREFIX}'||(${serverExpr}) AND CAST(json_extract(h.value,'$.expiresAt') AS INTEGER)>CAST(strftime('%s','now') AS INTEGER)*1000)`;
export const cleanupHeld = serverId => Boolean(db.prepare(`SELECT ${CLEANUP_HELD('?')} AS held`).get(String(serverId)).held);

// Takes the hold in one immediate transaction with `check` (returns a reason to refuse, or null), so a job cannot be
// claimed between the busy check and the hold: claimJob also runs under BEGIN IMMEDIATE.
export function takeCleanupHold(serverId, actor, check) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const reason = check();
    if (reason) { db.exec('ROLLBACK'); return reason; }
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(PREFIX + serverId, JSON.stringify({ actor, at: new Date().toISOString(), expiresAt: Date.now() + HOLD_MS }));
    db.exec('COMMIT');
    return null;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export const releaseCleanupHold = serverId => { db.prepare('DELETE FROM settings WHERE key=?').run(PREFIX + serverId); };
