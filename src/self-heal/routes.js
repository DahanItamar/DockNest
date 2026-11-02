// Self-heal API (docs/self-heal.md, "API"). Mounted under /api after session, CSRF and the API rate limit.
// - GET  /api/sites/:id/self-heal   any signed-in user: settings, watched containers, stream state, recent history.
// - PUT  /api/sites/:id/self-heal   administrators: { enabled, maxRestarts, windowMinutes }. Turning it on finds the
//   site's containers with a Docker health check on the server (read-only helper call); none gives 422 NO_HEALTHCHECK.
// - GET  /api/self-heal/events      the history table, newest first, keyset paged (`after` is the cursor).
// Responses carry names, codes and fixed sentences only: never a host, a label value other than the Compose project
// and service, an environment value or remote output.
import express from 'express';
import { z } from 'zod';
import { db, audit, transaction } from '../db.js';
import { requireAdmin } from '../auth.js';
import { remote } from '../ssh.js';
import { LIMITS, MIN_GAP_MS, CONTAINER, NOT_WATCHING, reasonText } from './limits.js';

// SSH from the API for "find containers with a health check"; tests replace it.
export const healApi = { resolve: (server, names) => remote(server, { operation: 'self-heal-resolve', names }) };
export const selfHealRoutes = express.Router();
const RUNTIME = 'self_heal_runtime';
const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); }
  catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message || 'The request is not valid.', code: 'INVALID' });
    if (error.status && error.status < 500) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error.status === 502) return res.status(502).json({ error: error.message, code: error.code });
    next(error);
  }
};
const siteOf = siteId => {
  const site = db.prepare('SELECT * FROM sites WHERE id=?').get(String(siteId));
  if (!site) throw httpError(404, 'NOT_FOUND', 'Site not found.');
  let config = {}; try { config = JSON.parse(site.config); } catch { config = {}; }
  return { ...site, config };
};
const settingsRow = siteId => db.prepare('SELECT * FROM self_heal_settings WHERE site_id=?').get(siteId) ?? null;
const watchedOf = row => { try { const list = JSON.parse(row?.watched ?? '[]'); return Array.isArray(list) ? list : []; } catch { return []; } };
const readJson = key => { try { return JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? 'null'); } catch { return null; } };
const workerOnline = () => { const beat = readJson('worker_heartbeat'); return Boolean(beat?.running) && Date.now() - Date.parse(beat.lastSeen) < 60_000; };

// Keyset cursor over (at, id), newest first.
const cursorSchema = z.string().max(512).transform((value, context) => {
  try { return z.tuple([z.string().min(1).max(40), z.string().min(1).max(64)]).parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))); }
  catch { context.addIssue({ code: 'custom', message: 'Invalid pagination cursor.' }); return z.NEVER; }
});
const encode = row => Buffer.from(JSON.stringify([row.at, row.id])).toString('base64url');
const eventView = row => ({ id: row.id, at: row.at, container: row.container, kind: row.kind, reasonCode: row.reason ?? null, reason: reasonText(row.reason), jobId: row.job_id ?? null });
export function eventsPage({ siteId = null, after = null, limit = 20 }) {
  const where = [], args = [];
  if (siteId) { where.push('e.site_id=?'); args.push(siteId); }
  if (after) { where.push('(e.at,e.id)<(?,?)'); args.push(...after); }
  const rows = db.prepare(`SELECT e.*,s.name AS site_name FROM self_heal_events e JOIN sites s ON s.id=e.site_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.at DESC,e.id DESC LIMIT ?`).all(...args, limit + 1);
  const page = rows.slice(0, limit);
  return { items: page.map(row => ({ ...eventView(row), siteId: row.site_id, siteName: row.site_name })), nextCursor: rows.length > limit ? encode(page.at(-1)) : null };
}

// connected | connecting | off, and "Not watching: {reason}" when it is not watching.
export function streamView(site, row) {
  const notWatching = code => (code && NOT_WATCHING[code] ? `Not watching: ${NOT_WATCHING[code]}` : null);
  if (site.config.kind === 'static') return { state: 'off', reason: 'static', notWatching: notWatching('static') };
  if (!row?.enabled) return { state: 'off', reason: null, notWatching: null };
  if (!watchedOf(row).length) return { state: 'off', reason: 'no_healthcheck', notWatching: notWatching('no_healthcheck') };
  if (!workerOnline()) return { state: 'off', reason: 'worker_offline', notWatching: notWatching('worker_offline') };
  const runtime = readJson(RUNTIME), server = runtime?.servers?.[site.server_id];
  if (!server) return { state: 'connecting', reason: null, notWatching: null };
  if (server.state !== 'connected') return { state: server.state === 'off' ? 'off' : 'connecting', reason: server.reason ?? null, notWatching: notWatching(server.reason) };
  if (runtime.sites?.[site.id]?.missing?.length) return { state: 'connected', reason: 'recreated', notWatching: notWatching('recreated') };
  return { state: 'connected', reason: null, notWatching: null };
}
export function selfHealView(site, { after = null, limit = 20, canEdit = false } = {}) {
  const row = settingsRow(site.id), health = readJson(RUNTIME)?.sites?.[site.id]?.health ?? {}, missing = new Set(readJson(RUNTIME)?.sites?.[site.id]?.missing ?? []);
  const updatedBy = row?.updated_by ? db.prepare('SELECT name FROM users WHERE id=?').get(row.updated_by)?.name ?? null : null;
  return {
    siteId: site.id,
    available: site.config.kind !== 'static',
    enabled: row?.enabled === 1,
    maxRestarts: row?.max_restarts ?? LIMITS.maxRestarts.default,
    windowMinutes: row?.window_minutes ?? LIMITS.windowMinutes.default,
    minGapSeconds: MIN_GAP_MS / 1000,
    limits: LIMITS,
    canEdit,
    updatedAt: row?.updated_at ?? null,
    updatedBy,
    lastEventAt: row?.last_event_at ?? null,
    watched: watchedOf(row).map(item => ({ name: item.name, project: item.project ?? null, service: item.service ?? null, health: missing.has(item.name) ? null : health[item.name] ?? null, found: !missing.has(item.name) })),
    stream: streamView(site, row),
    note: 'Works while DockNest is running.',
    events: eventsPage({ siteId: site.id, after, limit }),
  };
}

const pageQuery = z.object({ after: cursorSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(20) });
selfHealRoutes.get('/sites/:id/self-heal', handle((req, res) => {
  const { after, limit } = pageQuery.parse(req.query);
  res.json(selfHealView(siteOf(req.params.id), { after: after ?? null, limit, canEdit: req.user.role === 'admin' }));
}));

const input = z.object({
  enabled: z.boolean(),
  maxRestarts: z.number().int().min(LIMITS.maxRestarts.min, `Choose ${LIMITS.maxRestarts.min} to ${LIMITS.maxRestarts.max} restarts.`).max(LIMITS.maxRestarts.max, `Choose ${LIMITS.maxRestarts.min} to ${LIMITS.maxRestarts.max} restarts.`).default(LIMITS.maxRestarts.default),
  windowMinutes: z.number().int().min(LIMITS.windowMinutes.min, 'Choose a window from 10 minutes to 24 hours.').max(LIMITS.windowMinutes.max, 'Choose a window from 10 minutes to 24 hours.').default(LIMITS.windowMinutes.default),
}).strict();
const NO_HEALTHCHECK = () => httpError(422, 'NO_HEALTHCHECK', 'No container in this site has a health check.');
selfHealRoutes.put('/sites/:id/self-heal', requireAdmin, handle(async (req, res) => {
  const site = siteOf(req.params.id), data = input.parse(req.body ?? {});
  if (db.prepare('SELECT 1 FROM site_archives WHERE site_id=?').get(site.id)) throw httpError(409, 'SITE_REMOVED', 'This site was removed from active sites.');
  const current = settingsRow(site.id);
  let watched = watchedOf(current);
  if (data.enabled) {
    if (site.config.kind === 'static') throw NO_HEALTHCHECK();
    // Turning it on (or on again) finds the watched containers on the server; a change of limits keeps them.
    if (!current?.enabled || !watched.length) {
      const names = (site.config.containers ?? []).filter(name => typeof name === 'string' && CONTAINER.test(name));
      if (!names.length) throw NO_HEALTHCHECK();
      const server = db.prepare('SELECT * FROM servers WHERE id=?').get(site.server_id);
      if (!server) throw httpError(409, 'NOT_FOUND', 'Server not found.');
      let result;
      try { result = await healApi.resolve(server, names); }
      catch { throw httpError(502, 'UNREACHABLE', 'The server could not be reached to find containers with a health check. Try again.'); }
      const valid = value => value === null || (typeof value === 'string' && CONTAINER.test(value));
      watched = (Array.isArray(result?.containers) ? result.containers : [])
        .filter(item => item?.healthcheck === true && names.includes(item.name) && valid(item.project ?? null) && valid(item.service ?? null) && (item.project == null) === (item.service == null))
        .map(item => ({ name: item.name, project: item.project ?? null, service: item.service ?? null }));
      if (!watched.length) throw NO_HEALTHCHECK();
    }
  }
  const at = new Date().toISOString(), text = JSON.stringify(watched);
  if (text.length > 4096) throw httpError(422, 'TOO_MANY', 'Too many containers to watch in one site.');
  const action = !current?.enabled && data.enabled ? 'self_heal.enabled' : current?.enabled && !data.enabled ? 'self_heal.disabled' : (current && (current.max_restarts !== data.maxRestarts || current.window_minutes !== data.windowMinutes)) ? 'self_heal.changed' : null;
  transaction(() => {
    db.prepare(`INSERT INTO self_heal_settings(site_id,enabled,max_restarts,window_minutes,watched,updated_at,updated_by) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(site_id) DO UPDATE SET enabled=excluded.enabled,max_restarts=excluded.max_restarts,window_minutes=excluded.window_minutes,watched=excluded.watched,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .run(site.id, Number(data.enabled), data.maxRestarts, data.windowMinutes, text, at, req.user.id);
    if (action) audit(req.user.id, action, site.id, { maxRestarts: data.maxRestarts, windowMinutes: data.windowMinutes, watched: watched.length });
  });
  res.json(selfHealView(site, { canEdit: true }));
}));

const listQuery = z.object({ siteId: z.uuid().optional(), after: cursorSchema.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
selfHealRoutes.get('/self-heal/events', handle((req, res) => {
  const { siteId, after, limit } = listQuery.parse(req.query);
  res.json(eventsPage({ siteId: siteId ?? null, after: after ?? null, limit }));
}));
