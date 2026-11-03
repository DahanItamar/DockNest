// Launch hold (docs/launch-site.md, "Locks" and "Security review changes" items 12 and 15). A launch holds its server like
// an install: no backup, restore, move, install, cleanup or restore test step starts there while it holds. The hold is
// read by every claim (CLAIMABLE_JOB_SQL, claimInstall, the restore test start) from the launch rows themselves, so the
// database and the claims agree on what "held" means and a worker restart cannot lose it.
//
// A launch holds its server while:
// - one of its server steps runs (launch_running), for example Check again's certificate step on a saved site. Never
//   first_backup: that step only queues a normal backup job, which must be able to run on this server (item 12);
// - it is `running` and its site is not saved yet (from the first step until `save`, also between health checks), so
//   scheduled backups of other sites queue behind it (item 12) and the first backup can start once the hold is released;
// - it is `needs_attention` (its teardown failed and something may be left on the server).
import { db } from '../db.js';

// SQL: true while the server named by `serverExpr` (an SQL expression) is held by a launch.
export const LAUNCH_HELD = serverExpr => `EXISTS(SELECT 1 FROM site_launches hl WHERE hl.server_id=(${serverExpr}) AND (hl.state='needs_attention' OR (hl.state='running' AND NOT EXISTS(SELECT 1 FROM site_launch_steps hs WHERE hs.launch_id=hl.id AND hs.step='save' AND hs.state='done')) OR EXISTS(SELECT 1 FROM site_launch_steps hr WHERE hr.launch_id=hl.id AND hr.state='launch_running' AND hr.step<>'first_backup')))`;
export const launchHeld = serverId => Boolean(db.prepare(`SELECT ${LAUNCH_HELD('?')} AS held`).get(String(serverId)).held);
// A launch on this server that has not ended or that needs the owner (one launch per server at a time).
export const launchActive = serverId => db.prepare("SELECT id FROM site_launches WHERE server_id=? AND state IN ('queued','running','needs_attention') LIMIT 1").get(String(serverId))?.id ?? null;
