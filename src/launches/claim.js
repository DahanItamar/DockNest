// Launch step claim (docs/launch-site.md, "Security review changes" item 11). A launch's server steps are its jobs: rows
// in site_launch_steps with the statuses launch_queued/launch_running (releases without launches never read them, and
// their startup never turns them into backup recovery). The worker claims one like an install: only while nothing else
// uses the server (site jobs, moves, installs, a started restore test, a cleanup) and no deployment hold is on. The claim
// and the start of the hold (the launch becomes `running`) commit together under BEGIN IMMEDIATE, the same lock every
// other claim takes, so a backup and a launch step can never both start on one server.
import { db } from '../db.js';
import { deploymentHeld } from '../deployment-hold.js';
import { HELD as TEST_HELD } from '../restore-tests/hold.js';
import { CLEANUP_HELD } from '../cleanup-hold.js';

const ENDED_MOVE = "('draft','rolled_back','cancelled','failed','switched_back','cleaned')";
export const CLAIMABLE_LAUNCH_SQL = `SELECT st.launch_id,st.step,st.attempt,l.server_id FROM site_launch_steps st JOIN site_launches l ON l.id=st.launch_id
 WHERE st.state='launch_queued' AND l.state IN ('queued','running','waiting_dns','done','needs_attention')
 AND NOT EXISTS(SELECT 1 FROM jobs a WHERE a.status IN ('running','recovery_required','move_running','test_running') AND l.server_id IN (COALESCE((SELECT server_id FROM sites WHERE id=a.site_id),''),COALESCE(json_extract(a.details,'$.targetServerId'),''),COALESCE(json_extract(a.details,'$.sourceServerId'),'')))
 AND NOT EXISTS(SELECT 1 FROM site_moves m WHERE (m.source_server_id=l.server_id OR m.target_server_id=l.server_id) AND m.state NOT IN ${ENDED_MOVE})
 AND NOT EXISTS(SELECT 1 FROM server_installs i WHERE i.server_id=l.server_id AND i.status='running')
 AND NOT EXISTS(SELECT 1 FROM restore_tests t WHERE t.server_id=l.server_id AND ${TEST_HELD})
 AND NOT ${CLEANUP_HELD('l.server_id')}
 AND NOT EXISTS(SELECT 1 FROM site_launch_steps o JOIN site_launches ol ON ol.id=o.launch_id WHERE ol.server_id=l.server_id AND o.state='launch_running')
 ORDER BY l.created_at,l.id LIMIT 1`;

export function claimLaunch(at = new Date().toISOString()) {
  if (deploymentHeld(db)) return null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare(CLAIMABLE_LAUNCH_SQL).get();
    if (!row) { db.exec('COMMIT'); return null; }
    const claimed = db.prepare("UPDATE site_launch_steps SET state='launch_running',attempt=attempt+1,started_at=?,finished_at=NULL WHERE launch_id=? AND step=? AND state='launch_queued'").run(at, row.launch_id, row.step).changes === 1;
    if (claimed) db.prepare("UPDATE site_launches SET state='running',started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND state='queued'").run(at, at, row.launch_id);
    db.exec('COMMIT');
    return claimed ? { launchId: row.launch_id, step: row.step, attempt: row.attempt + 1, serverId: row.server_id } : null;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

// A launch stays `running` from its first claimed step until it is done, waiting for DNS, or its teardown has finished
// (then failed or cancelled); a teardown that fails leaves it in needs_attention. The engine never ends a launch while
// its teardown is queued or running, so the hold (src/launches/hold.js) covers the whole teardown. Remove launch tears
// down a done launch; its running teardown step holds the server the same way.
// Worker start: a step that was running belonged to a worker that stopped. It is marked failed (never resumed blindly);
// the launch engine then asks the server (`launch-status`) what is left and resumes or tears down (src/launches/engine.js).
// The launch keeps holding its server meanwhile.
export function interruptLaunchSteps(at = new Date().toISOString()) {
  return db.prepare("UPDATE site_launch_steps SET state='failed',finished_at=?,detail='DockNest stopped while this step ran.',result=json_set(result,'$.interrupted',1) WHERE state='launch_running'").run(at).changes;
}
