// Update Center routes (docs/update-center.md section 4). Mounted behind the /api chain in src/server.js: session,
// requireAuth, CSRF, the APP_ORIGIN check on every non-GET, no-store and the global rate limit; admin-only here.
// Consent, settings and the check (PR 6), then the updater, offer, upgrade requests, status and history (PR 8).
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireRecentAuth } from '../auth.js';
import { db, audit, transaction } from '../db.js';
import { deploymentHeld } from '../deployment-hold.js';
import { checksEnabled, ensureCheckRow, checkNow, startCheck, compareSemver, finalTag, releaseUrl, limits } from './check.js';
import { eligibility } from './eligibility.js';
import { recoveryReviewPending } from './requests.js';
import { TransportError } from './transport.js';

const answer = z.strictObject({ checkEnabled: z.boolean() });
const iso = ms => Number.isFinite(ms) ? new Date(ms).toISOString() : null;
function cachedManifest(row) { try { const value = row?.manifest ? JSON.parse(row.manifest) : null; return value?.tag === row.latest_version ? value : null; } catch { return null; } }

export function updateState(database, release, service = null) {
  const base = baseState(database, release);
  if (!service) return base;
  const info = service.updaterInfo(), snapshot = service.snapshot(), last = service.latestRow();
  const offer = eligibility({ base: base.state, current: release.version, latest: base.check?.latest ?? null, minUpgradeFrom: base.check?.latest?.minUpgradeFrom ?? null, updater: info, active: service.activeRow(), lastRequest: last, hold: deploymentHeld(database), recoveryPending: recoveryReviewPending(database) });
  const retry = last?.state === 'rolled_back' && offer.offer.update?.version === last.to_version ? { requestId: last.id, version: last.to_version, allowed: (info.consecutiveExit4[last.to_version] ?? 0) < 2 } : null;
  const { present, version, supported, selfUpdateFailed, blocked, status, lastHeartbeatAt } = info;
  return { ...base, state: offer.state, updater: { present, version, supported, selfUpdateFailed, blocked, status, lastHeartbeatAt }, offer: offer.offer, active: snapshot.active, retry };
}
// The admin-only update.available field of /api/state: the cached latest release when it is newer and checks are on. Never a network call.
export function cachedOffer(database, release) {
  const state = baseState(database, release);
  try { return state.consent.checkEnabled === true && state.check?.latest && compareSemver(state.check.latest.version, release.version) > 0 ? state.check.latest.version : null; } catch { return null; }
}
function baseState(database, release) {
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

const submitBody = z.strictObject({ version: z.string().regex(/^v\d{1,6}\.\d{1,6}\.\d{1,6}$/), retryOf: z.uuid().optional() });
const refusals = { 'needs-host-ack': [409, 'UPDATER_BLOCKED'], 'state-mismatch': [409, 'UPDATER_STATE_MISMATCH'], 'low-disk': [409, 'UPDATER_LOW_DISK'], busy: [409, 'UPDATER_BUSY'], duplicate: [409, 'UPDATER_BUSY'], invalid: [409, 'UPDATER_REFUSED'], 'version-refused': [409, 'UPDATER_REFUSED'], stale: [409, 'UPDATER_REFUSED'], 'rate-limited': [429, 'UPDATER_RATE_LIMITED'] };
const outcomes = { succeeded: 'installed', rolled_back: 'rolled_back', needs_action: 'needs_action', resolved: 'needs_action', refused: 'not_changed', busy: 'not_changed', lost: 'lost', submitted: 'running', running: 'running' };
const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(512).optional() });
// In-app runs joined with the versions this database has run (installed from the command line when no run explains them).
export function updateHistory(database, { limit = 50, cursor = null } = {}) {
  const runs = database.prepare('SELECT id,to_version,requested_at,finished_at,state FROM update_requests').all().map(row => ({ id: row.id, version: row.to_version, at: row.finished_at ?? row.requested_at, outcome: outcomes[row.state], source: 'in-app', key: row.id }));
  const installed = new Set(database.prepare("SELECT to_version FROM update_requests WHERE state='succeeded'").all().map(row => row.to_version.replace(/^v/, '')));
  const cli = database.prepare('SELECT version,first_started_at FROM release_history').all().filter(row => !installed.has(row.version)).map(row => ({ id: null, version: row.version, at: row.first_started_at, outcome: 'installed', source: 'cli', key: 'v:' + row.version }));
  const all = [...runs, ...cli].sort((a, b) => b.at.localeCompare(a.at) || b.key.localeCompare(a.key));
  let start = 0;
  if (cursor) { const [at, key] = cursor; start = all.findIndex(item => item.at < at || (item.at === at && item.key < key)); if (start < 0) start = all.length; }
  const page = all.slice(start, start + limit), more = start + limit < all.length;
  return { items: page.map(({ key: _key, ...item }) => item), next: more ? Buffer.from(JSON.stringify([page.at(-1).at, page.at(-1).key])).toString('base64url') : null };
}

export function updateRoutes({ release, fetch, service } = {}) {
  const router = Router(), options = () => ({ db, fetch, version: release.version }), state = () => updateState(db, release, service);
  router.use(requireAdmin);
  router.get('/', async (_req, res) => { await service?.sync(); res.json(state()); });
  router.get('/status', async (_req, res) => {
    await service.sync();
    const snapshot = service.snapshot(), status = snapshot.active ?? snapshot.latest;
    if (!status) return res.status(404).json({ error: 'No update has been requested.', code: 'NO_UPDATE_REQUEST' });
    res.json(status);
  });
  router.get('/history', (req, res) => {
    const { limit, cursor } = historyQuery.parse(req.query);
    let decoded = null;
    if (cursor) { try { decoded = z.tuple([z.string().max(64), z.string().max(128)]).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))); } catch { return res.status(400).json({ error: 'Invalid pagination cursor.' }); } }
    res.json(updateHistory(db, { limit, cursor: decoded }));
  });
  // Upgrade only: the action is fixed in the transport. Re-authentication (requireRecentAuth) and the server's own eligibility
  // decide; the browser's view of the offer is never trusted.
  router.post('/requests', requireRecentAuth, async (req, res) => {
    const { version, retryOf } = submitBody.parse(req.body), fail = (status, code, error, extra = {}) => res.status(status).json({ error, code, ...extra });
    await service.sync();
    const current = state(), offered = current.offer.update?.version;
    if (current.state === 'update-in-progress') return fail(409, 'UPDATE_IN_PROGRESS', 'An update is already in progress.');
    if (current.offer.blocked && current.offer.blocked.code !== 'UPDATE_ON_HOLD' && current.offer.blocked.code !== 'RECOVERY_REVIEW_REQUIRED') return fail(409, current.offer.blocked.code, current.offer.blocked.message);
    if (current.offer.cli?.reason?.startsWith('updater-')) return fail(503, 'UPDATER_UNAVAILABLE', 'The host updater is not installed or is out of date.');
    if (offered !== version) return fail(409, 'NOT_OFFERED', 'That version is not the current offer.');
    if (current.offer.blocked) return fail(409, current.offer.blocked.code, current.offer.blocked.message);
    if (retryOf) {
      const earlier = db.prepare('SELECT state,to_version FROM update_requests WHERE id=?').get(retryOf);
      if (earlier?.state !== 'rolled_back' || earlier.to_version !== version || current.retry?.requestId !== retryOf || !current.retry.allowed) return fail(409, 'NOT_OFFERED', 'That update cannot be retried.');
    }
    const requestId = service.create({ user: req.user, version, retryOf });
    if (!requestId) return fail(409, 'UPDATE_IN_PROGRESS', 'An update is already in progress.');
    let answer;
    try { answer = await service.send(requestId, version, req.user); } catch (error) {
      // Never delivered: the row is finished as refused. Delivered but unanswered: the updater may still run it, so the row stays submitted.
      if (!(error instanceof TransportError) || !error.delivered) service.refuse(requestId, 'unavailable');
      return fail(503, 'UPDATER_UNAVAILABLE', 'The host updater did not answer. Check that it is running on the DockNest host.');
    }
    if (!answer.accepted) { service.refuse(requestId, answer.code); const [status, code] = refusals[answer.code]; return fail(status, code, 'The host updater refused the update.', { refusal: answer.code }); }
    service.rebuild();
    res.status(202).json({ requestId });
  });
  // No step-up (the lock view may have no fresh authentication). Only the active, running, stale request; never needs_action.
  router.post('/requests/:id/acknowledge', async (req, res) => {
    if (!await service.acknowledge(req.params.id, req.user)) return res.status(409).json({ error: 'Only the active request, when the updater has stopped reporting progress, can be closed.', code: 'NOT_ACKNOWLEDGEABLE' });
    res.json(state());
  });
  // Asked once. The first answer wins atomically; a second admin gets ALREADY_DECIDED with the recorded answer.
  router.post('/consent', (req, res) => {
    const { checkEnabled } = answer.parse(req.body), now = Date.now();
    const decided = transaction(() => {
      if (db.prepare('INSERT INTO update_preferences(id,check_enabled,decided_by,decided_at) VALUES(1,?,?,?) ON CONFLICT(id) DO NOTHING').run(checkEnabled ? 1 : 0, req.user.id, new Date(now).toISOString()).changes !== 1) return false;
      if (checkEnabled) ensureCheckRow(db, now);
      audit(req.user.id, 'update.consent', null, { checkEnabled });
      return true;
    });
    if (!decided) return res.status(409).json({ error: 'Another administrator already answered the update check question. You can change it in the Update Center.', code: 'ALREADY_DECIDED', consent: state().consent });
    // After "Yes" the API checks once straight away; the response does not wait for it.
    if (checkEnabled) startCheck(options());
    res.json(state());
  });
  router.patch('/settings', (req, res) => {
    const { checkEnabled } = answer.parse(req.body), now = Date.now();
    const turnedOn = transaction(() => {
      const current = db.prepare('SELECT check_enabled FROM update_preferences WHERE id=1').get();
      if (!current) return null;
      db.prepare('UPDATE update_preferences SET check_enabled=?,changed_by=?,changed_at=? WHERE id=1').run(checkEnabled ? 1 : 0, req.user.id, new Date(now).toISOString());
      if (checkEnabled) ensureCheckRow(db, now);
      audit(req.user.id, 'update.settings', null, { checkEnabled });
      return checkEnabled && current.check_enabled !== 1;
    });
    if (turnedOn === null) return res.status(409).json({ error: 'Answer the update check question first.', code: 'CONSENT_PENDING' });
    if (turnedOn) startCheck(options());
    res.json(state());
  });
  // Check now: 10 s budget; within a minute of the last attempt the cached result is returned without a call.
  router.post('/check', async (_req, res) => {
    if (!checksEnabled(db)) return res.status(409).json({ error: 'Update checks are off. Turn them on in the Update Center to check for updates.', code: 'CHECKS_OFF' });
    await checkNow({ ...options(), signal: AbortSignal.timeout(limits.timeoutMs) });
    res.json(state());
  });
  return router;
}
