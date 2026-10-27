// The test server is held by the test row, not by a job (docs/restore-tests.md, "Concurrency and fairness"): from the
// moment a test starts until its clean-up is done or acknowledged, other work on that server waits. Other servers,
// and the tested site on its own server, are unaffected. The predicate matches the partial unique index
// restore_tests_server_active, so the database and the claim rules agree on what "held" means.
import { db } from '../db.js';

export const HELD = "t.started_at IS NOT NULL AND (t.result IS NULL OR t.cleanup IN ('pending','failed'))";
export const heldBy = serverId => db.prepare(`SELECT t.id FROM restore_tests t WHERE t.server_id=? AND ${HELD}`).get(serverId)?.id ?? null;
