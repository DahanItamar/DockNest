// Update Center routes (docs/update-center.md section 4). Mounted behind the /api chain in src/server.js: session,
// requireAuth, CSRF, the APP_ORIGIN check on every non-GET, no-store and the global rate limit; admin-only here.
// This PR holds consent, settings and the check; the updater, offer and active request join UpdateState in PR 8.
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { db, audit, transaction } from '../db.js';
import { checksEnabled, ensureCheckRow, checkNow, startCheck, compareSemver, finalTag, releaseUrl, limits } from './check.js';

const answer = z.strictObject({ checkEnabled: z.boolean() });
const iso = ms => Number.isFinite(ms) ? new Date(ms).toISOString() : null;
function cachedManifest(row) { try { const value = row?.manifest ? JSON.parse(row.manifest) : null; return value?.tag === row.latest_version ? value : null; } catch { return null; } }

export function updateState(database, release) {
  const preference = database.prepare('SELECT update_preferences.check_enabled,update_preferences.decided_by,update_preferences.decided_at,users.name,users.email FROM update_preferences LEFT JOIN users ON users.id=update_preferences.decided_by WHERE update_preferences.id=1').get();
  const enabled = preference ? preference.check_enabled === 1 : null;
  const row = database.prepare('SELECT * FROM update_checks WHERE id=1').get(), manifest = cachedManifest(row);
  const latest = row && finalTag(row.latest_version) ? { version: row.latest_version, publishedAt: row.published_at, releaseUrl: releaseUrl(row.latest_version), minUpgradeFrom: manifest?.minUpgradeFrom ?? null } : null;
  // Turning checks off keeps the cache; it is still shown, without a next check.
  const attempted = row && (row.last_success_at || row.status === 'failed');
  const check = row ? { status: row.status, checkedAt: attempted ? row.checked_at : null, lastSuccessAt: row.last_success_at, nextCheckAt: enabled ? iso(row.next_check_at) : null, error: row.status === 'failed' ? row.error : null, latest } : null;
  let state;
  if (enabled === null) state = 'consent-pending';
  else if (!enabled) state = 'checks-off';
  else if (!attempted) state = 'checking';
  else if (row.status === 'failed') state = 'check-failed';
  else { let available = false; try { available = Boolean(latest) && compareSemver(latest.version, release.version) > 0; } catch { /* An unparsable running version offers nothing. */ } state = available ? 'update-available' : 'up-to-date'; }
  return {
    state, current: { version: release.version, schemaVersion: release.schemaVersion },
    consent: { checkEnabled: enabled, decidedBy: preference ? { id: preference.decided_by, name: preference.name || preference.email || null } : null, decidedAt: preference?.decided_at ?? null },
    check,
  };
}

export function updateRoutes({ release, fetch } = {}) {
  const router = Router(), options = () => ({ db, fetch, version: release.version });
  router.use(requireAdmin);
  router.get('/', (_req, res) => res.json(updateState(db, release)));
  // Asked once. The first answer wins atomically; a second admin gets ALREADY_DECIDED with the recorded answer.
  router.post('/consent', (req, res) => {
    const { checkEnabled } = answer.parse(req.body), now = Date.now();
    const decided = transaction(() => {
      if (db.prepare('INSERT INTO update_preferences(id,check_enabled,decided_by,decided_at) VALUES(1,?,?,?) ON CONFLICT(id) DO NOTHING').run(checkEnabled ? 1 : 0, req.user.id, new Date(now).toISOString()).changes !== 1) return false;
      if (checkEnabled) ensureCheckRow(db, now);
      return true;
    });
    if (!decided) return res.status(409).json({ error: 'Another administrator already answered the update check question. You can change it in the Update Center.', code: 'ALREADY_DECIDED', consent: updateState(db, release).consent });
    audit(req.user.id, 'update.consent', null, { checkEnabled });
    // After "Yes" the API checks once straight away; the response does not wait for it.
    if (checkEnabled) startCheck(options());
    res.json(updateState(db, release));
  });
  router.patch('/settings', (req, res) => {
    const { checkEnabled } = answer.parse(req.body), now = Date.now();
    const turnedOn = transaction(() => {
      const current = db.prepare('SELECT check_enabled FROM update_preferences WHERE id=1').get();
      if (!current) return null;
      db.prepare('UPDATE update_preferences SET check_enabled=?,changed_by=?,changed_at=? WHERE id=1').run(checkEnabled ? 1 : 0, req.user.id, new Date(now).toISOString());
      if (checkEnabled) ensureCheckRow(db, now);
      return checkEnabled && current.check_enabled !== 1;
    });
    if (turnedOn === null) return res.status(409).json({ error: 'Answer the update check question first.', code: 'CONSENT_PENDING' });
    audit(req.user.id, 'update.settings', null, { checkEnabled });
    if (turnedOn) startCheck(options());
    res.json(updateState(db, release));
  });
  // Check now: 10 s budget; within a minute of the last attempt the cached result is returned without a call.
  router.post('/check', async (_req, res) => {
    if (!checksEnabled(db)) return res.status(409).json({ error: 'Update checks are off. Turn them on in the Update Center to check for updates.', code: 'CHECKS_OFF' });
    await checkNow({ ...options(), signal: AbortSignal.timeout(limits.timeoutMs) });
    res.json(updateState(db, release));
  });
  return router;
}
