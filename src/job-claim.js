// The job claimJob (src/engine.js) would start next: queued, and neither its server(s) nor a started restore test's
// server is held by running, recovery_required or move_running work. Shared with the backup-copy step, which steps
// aside only for a job that would really start (src/backup-copies.js).
import { db } from './db.js';
import { HELD as TEST_HELD } from './restore-tests/hold.js';

export const CLAIMABLE_JOB_SQL=`SELECT j.* FROM jobs j WHERE j.status IN ('queued','move_queued','test_queued') AND NOT EXISTS(SELECT 1 FROM jobs a JOIN sites s ON a.site_id=s.id WHERE a.status IN ('running','recovery_required','move_running') AND (COALESCE(json_extract(a.details,'$.targetServerId'),s.server_id) IN (COALESCE(json_extract(j.details,'$.targetServerId'),(SELECT server_id FROM sites WHERE id=j.site_id)),json_extract(j.details,'$.sourceServerId')) OR json_extract(a.details,'$.sourceServerId') IN (COALESCE(json_extract(j.details,'$.targetServerId'),(SELECT server_id FROM sites WHERE id=j.site_id)),json_extract(j.details,'$.sourceServerId')))) AND NOT EXISTS(SELECT 1 FROM restore_tests t WHERE ${TEST_HELD} AND t.server_id IN (COALESCE(json_extract(j.details,'$.targetServerId'),(SELECT server_id FROM sites WHERE id=j.site_id)),json_extract(j.details,'$.sourceServerId')) AND NOT (j.type='restore-test' AND json_extract(j.details,'$.testId')=t.id)) ORDER BY j.type='restore-test',j.created_at LIMIT 1`;
export const claimableJobExists=()=>Boolean(db.prepare(CLAIMABLE_JOB_SQL).get());
