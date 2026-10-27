// Restore test API (docs/restore-tests.md, "API contract"). Mounted under /api after session, CSRF and the API rate
// limit. Settings and clean-up are administrator only; reading, Run test and Cancel are open to operators too (as safe
// as a manual restore). Errors carry a plain sentence and the contract's code; nothing here echoes request bodies,
// paths or remote output.
import express from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAdmin, recentlyVerified } from '../auth.js';
import { cancelRestoreTest, retryRestoreTestCleanup, acknowledgeRestoreTestCleanup, advanceRestoreTest, loadTest } from './engine.js';
import { saveSettings, settingsRow, settingsView } from './settings.js';
import { runTestNow } from './scheduler.js';
import { cardFor, cardQuery, detailFor } from './views.js';

export const restoreTestRoutes = express.Router();
const send = (res, error) => res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.field ? { field: error.field } : {}) });
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); }
  catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message || 'The request is not valid.', code: 'INVALID' });
    if (error.status && error.status < 500) return send(res, error);
    next(error);
  }
};
const notFound = message => Object.assign(new Error(message), { status: 404, code: 'NOT_FOUND' });
const siteOf = siteId => db.prepare('SELECT * FROM sites WHERE id=?').get(String(siteId)) ?? (() => { throw notFound('Site not found.'); })();
const testOf = testId => loadTest(String(testId)) ?? (() => { throw notFound('Restore test not found.'); })();

restoreTestRoutes.get('/sites/:id/restore-tests', handle((req, res) => {
  const site = siteOf(req.params.id), query = cardQuery.parse(req.query);
  res.json(cardFor(site.id, query));
}));
restoreTestRoutes.get('/sites/:id/restore-tests/settings', requireAdmin, handle((req, res) => res.json(settingsView(settingsRow(siteOf(req.params.id).id)))));
restoreTestRoutes.put('/sites/:id/restore-tests/settings', requireAdmin, handle((req, res) => {
  res.json(saveSettings(siteOf(req.params.id), req.body, { actor: req.user.id, recentlyVerified: recentlyVerified(req) }));
}));
restoreTestRoutes.post('/sites/:id/restore-tests', handle((req, res) => {
  const body = z.object({ backupId: z.uuid().optional() }).strict().parse(req.body ?? {});
  res.status(202).json(runTestNow(siteOf(req.params.id), { backupId: body.backupId ?? null, actor: req.user.id }));
}));
restoreTestRoutes.get('/restore-tests/:id', handle((req, res) => res.json(detailFor(testOf(req.params.id).id))));
restoreTestRoutes.post('/restore-tests/:id/cancel', handle((req, res) => {
  const test = testOf(req.params.id);
  if (test.result !== null) return res.status(409).json({ error: 'This test has already finished.', code: 'NOT_ACTIVE' });
  const result = cancelRestoreTest(test.id, req.user.id);
  advanceRestoreTest(test.id); // a test that has not started ends at once
  res.status(202).json(result);
}));
restoreTestRoutes.post('/restore-tests/:id/cleanup', requireAdmin, handle((req, res) => {
  const result = retryRestoreTestCleanup(testOf(req.params.id).id, req.user.id);
  advanceRestoreTest(req.params.id);
  res.status(202).json(result);
}));

// The restore-test branch of POST /api/jobs/:id/recovery: acknowledge a test whose clean-up failed, only when the test
// server reports nothing left. Administrator only, with the same site-name confirmation as other recovery reviews.
export async function acknowledgeTestJob(req, res, job) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.', code: 'ADMIN_REQUIRED' });
  let details = {}; try { details = JSON.parse(job.details || '{}'); } catch { details = {}; }
  const test = details.testId ? loadTest(details.testId) : null;
  if (!test) return res.status(404).json({ error: 'Restore test not found.', code: 'NOT_FOUND' });
  const site = db.prepare('SELECT name FROM sites WHERE id=?').get(test.site_id);
  const body = z.object({ confirmation: z.string().max(200), reviewedRemoteRecovery: z.literal(true) }).safeParse(req.body);
  if (!body.success || body.data.confirmation !== site?.name) return res.status(409).json({ error: 'Type the site name and confirm you checked the test server.', code: 'CONFIRMATION_REQUIRED' });
  try { res.json(await acknowledgeRestoreTestCleanup(test.id, req.user.id)); }
  catch (error) {
    if (error.status) return send(res, error);
    // SSH failures stay generic: remote output never reaches the browser.
    res.status(502).json({ error: 'The test server could not be reached to check for leftovers.', code: 'UNREACHABLE' });
  }
}
