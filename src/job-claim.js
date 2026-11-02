// The job claimJob (src/engine.js) would start next: queued, and neither its server(s) nor a started restore test's
// server is held by running, recovery_required, move_running or edit_running work (a Safe Edit step, docs/safe-edit.md),
// or by a server cleanup (src/cleanup-hold.js). Shared with the backup-copy step, which steps
// aside only for a job that would really start (src/backup-copies.js).
//
// Self-heal restarts (docs/self-heal.md, "Security review changes" item 1) are site-scoped, not server-scoped:
// - A `heal_queued` job waits only for running work of its own site (running, recovery_required, move_running,
//   edit_running, edit_waiting between Safe Edit health polls, or another heal_running). It never waits for, and never blocks, work of other sites on the same
//   server: a restart takes seconds, touches one container of its own site, and the helper takes the site lock. Making
//   it server-scoped would let any long backup on a shared server pause healing for every other site there.
// - Every other job keeps exactly its server-level rule below, and additionally waits while a `heal_running` job of its
//   own site exists, so a backup, Safe Edit or move never starts while that site's container is being restarted.
//   Restore test steps run on their test server and are not held by a restart of the live site.
// - Heal jobs sort first (they take seconds). Further checks that can make a heal step aside (queued work for the site,
//   an unfinished move, maintenance, the settle time, the setting turned off) run inside claimJob's BEGIN IMMEDIATE
//   (src/self-heal/engine.js healClaimCheck): a heal that finds a queued backup yields and is recorded as skipped, so
//   the two queues can never wait for each other.
// Releases before 2.15.0 never select heal_queued, so after a rollback a queued restart simply never runs.
import { db } from './db.js';
import { HELD as TEST_HELD } from './restore-tests/hold.js';
import { CLEANUP_HELD } from './cleanup-hold.js';

// A package install on the site's server (Docker itself may be replaced) also holds restarts, and a running restart holds
// installs on its server (src/installs.js).
// A server cleanup (src/cleanup-hold.js) holds restarts on its server like every other job.
const HEAL_CLAIMABLE=`j.status='heal_queued' AND NOT EXISTS(SELECT 1 FROM jobs a WHERE a.site_id=j.site_id AND a.id<>j.id AND a.status IN ('running','recovery_required','move_running','edit_running','edit_waiting','heal_running')) AND NOT EXISTS(SELECT 1 FROM server_installs i WHERE i.status='running' AND i.server_id=(SELECT server_id FROM sites WHERE id=j.site_id)) AND NOT ${CLEANUP_HELD("COALESCE((SELECT server_id FROM sites WHERE id=j.site_id),'')")}`;
const NO_HEAL_RUNNING="(j.type='restore-test' OR NOT EXISTS(SELECT 1 FROM jobs h WHERE h.site_id=j.site_id AND h.status='heal_running'))";
export const CLAIMABLE_JOB_SQL=`SELECT j.* FROM jobs j WHERE (${HEAL_CLAIMABLE}) OR (j.status IN ('queued','move_queued','test_queued','edit_queued') AND NOT EXISTS(SELECT 1 FROM jobs a JOIN sites s ON a.site_id=s.id WHERE a.status IN ('running','recovery_required','move_running','edit_running') AND (COALESCE(json_extract(a.details,'$.targetServerId'),s.server_id) IN (COALESCE(json_extract(j.details,'$.targetServerId'),(SELECT server_id FROM sites WHERE id=j.site_id)),json_extract(j.details,'$.sourceServerId')) OR json_extract(a.details,'$.sourceServerId') IN (COALESCE(json_extract(j.details,'$.targetServerId'),(SELECT server_id FROM sites WHERE id=j.site_id)),json_extract(j.details,'$.sourceServerId')))) AND NOT EXISTS(SELECT 1 FROM restore_tests t WHERE ${TEST_HELD} AND t.server_id IN (COALESCE(json_extract(j.details,'$.targetServerId'),(SELECT server_id FROM sites WHERE id=j.site_id)),json_extract(j.details,'$.sourceServerId')) AND NOT (j.type='restore-test' AND json_extract(j.details,'$.testId')=t.id)) AND NOT ${CLEANUP_HELD("COALESCE(json_extract(j.details,'$.targetServerId'),(SELECT server_id FROM sites WHERE id=j.site_id),'')")} AND NOT ${CLEANUP_HELD("COALESCE(json_extract(j.details,'$.sourceServerId'),'')")} AND ${NO_HEAL_RUNNING}) ORDER BY j.status<>'heal_queued',j.type='restore-test',j.created_at LIMIT 1`;
// Only a self-heal restart: the worker starts these at once when an event queues one, beside any running job of another
// site, so a long backup elsewhere never delays a restart (src/self-heal/engine.js healNow).
export const CLAIMABLE_HEAL_SQL=`SELECT j.* FROM jobs j WHERE ${HEAL_CLAIMABLE} ORDER BY j.created_at LIMIT 1`;
export const claimableJobExists=()=>Boolean(db.prepare(CLAIMABLE_JOB_SQL).get());
