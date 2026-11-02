// Server cleanup (docs/server-cleanup.md). An administrator scans a server for reclaimable Docker space (stopped
// containers, dangling images, anonymous unused volumes, unused build cache), reviews the preview and confirms; the
// helper then removes exactly the previewed items that are still eligible, one by one by ID (remote/helper/cleanup.py).
// Protection is decided twice and fails closed: DockNest sends what its records say a server must keep (site
// containers, the volumes their backups list, kept old copies after a move), and the helper adds what the server says
// (DockNest labels and journals, backups in progress, restore tests, move copies, DockNest itself).
// A preview lives in memory for 15 minutes and is used once. While a clean runs, a database hold on the server
// (src/cleanup-hold.js) defers every job there, and the helper's shared lock keeps Docker steps out. No timer runs.
import express from 'express';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { db, audit } from './db.js';
import { requireAdmin } from './auth.js';
import { transport } from './engine.js';
import { heldBy } from './restore-tests/hold.js';
import { cleanupHeld, takeCleanupHold, releaseCleanupHold } from './cleanup-hold.js';

export const serverCleanupRoutes = express.Router();
// Test only: the Linux integration test cannot wait an hour for its fixtures to age. DockNest itself never calls this.
let testMinAgeSeconds = null;
export function setCleanupTestMinAge(seconds) { testMinAgeSeconds = seconds === null ? null : z.number().int().min(0).max(86400).parse(seconds); }
const testFields = () => (testMinAgeSeconds === null ? {} : { minAgeSeconds: testMinAgeSeconds });
export const CLEANUP_KINDS = Object.freeze(['containers', 'images', 'volumes', 'buildCache']);
const PREVIEW_MS = 15 * 60_000, MAX_PREVIEWS = 50, MAX_ITEMS = 500, MAX_REFS = 2000;
const REF = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,254}$/;
const ACTIVE_JOB = "('queued','running','recovery_required','move_queued','move_running','test_queued','test_running')";
// A move that is copying, switching or undoing uses both servers. A completed move only keeps its stopped old copy,
// which the protection lists below cover, so it does not block a clean.
const RUNNING_MOVE = "('queued','running','waiting','rolling_back','recovery_required','switching_back')";
const ENDED_MOVE = "('rolled_back','cancelled','failed','switched_back','cleaned')";
const previews = new Map();
const httpError = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

const parse = text => { try { return JSON.parse(text); } catch { return null; } };
const manifestContainers = manifest => (Array.isArray(manifest?.containers) ? manifest.containers : []);
// Volume names of the containers a stored backup manifest lists (the full capture manifest).
export function manifestVolumes(manifest) {
  const names = [];
  for (const container of manifestContainers(manifest))
    for (const mount of Array.isArray(container?.Mounts) ? container.Mounts : []) if (mount?.Type === 'volume' && typeof mount.Name === 'string') names.push(mount.Name);
  return names;
}
// Compose projects of those containers: a stack that is down keeps its anonymous volumes through them.
export const manifestProjects = manifest => manifestContainers(manifest).map(container => container?.Config?.Labels?.['com.docker.compose.project']).filter(project => typeof project === 'string' && project);
// What DockNest's records say this server must keep. Archived sites count too; a moved site counts on its old server
// until its move has ended (its old copy is kept there, stopped).
export function protectionFor(serverId) {
  const siteIds = new Set(db.prepare('SELECT id FROM sites WHERE server_id=?').all(serverId).map(row => row.id));
  for (const row of db.prepare(`SELECT site_id FROM site_moves WHERE (source_server_id=? OR target_server_id=?) AND state NOT IN ${ENDED_MOVE}`).all(serverId, serverId)) siteIds.add(row.site_id);
  const containers = new Set(), volumes = new Set(), projects = new Set(), stagingRoots = new Set();
  for (const siteId of siteIds) {
    const config = parse(db.prepare('SELECT config FROM sites WHERE id=?').get(siteId)?.config) ?? {};
    for (const name of Array.isArray(config.containers) ? config.containers : []) containers.add(String(name));
    if (typeof config.stagingRoot === 'string' && config.stagingRoot.startsWith('/')) stagingRoots.add(config.stagingRoot);
    for (const row of db.prepare('SELECT manifest FROM backups WHERE site_id=? ORDER BY captured_at DESC,id DESC LIMIT 5').all(siteId))
    { const manifest = parse(row.manifest); for (const name of manifestVolumes(manifest)) volumes.add(name); for (const project of manifestProjects(manifest)) projects.add(project); }
  }
  const list = set => {
    const values = [...set];
    // Never trimmed: a list DockNest cannot send whole would leave something unprotected.
    if (values.length > MAX_REFS || values.some(value => !REF.test(value))) throw httpError(409, 'DockNest cannot describe what this server must keep, so it will not clean it.', 'PROTECTION_UNAVAILABLE');
    return values;
  };
  return { containers: list(containers), volumes: list(volumes), projects: list(projects), stagingRoots: [...stagingRoots].filter(root => root.length <= 512 && !root.split('/').includes('..')) };
}
// Why a clean must wait: work that uses this server, or another clean of it.
export function busyReason(serverId) {
  const job = db.prepare(`SELECT j.type FROM jobs j WHERE j.status IN ${ACTIVE_JOB} AND ? IN (COALESCE((SELECT server_id FROM sites WHERE id=j.site_id),''),COALESCE(json_extract(j.details,'$.targetServerId'),''),COALESCE(json_extract(j.details,'$.sourceServerId'),'')) LIMIT 1`).get(serverId);
  if (job) return { restore: 'A restore is running on this server.', 'restore-test': 'A restore test is running on this server.', 'site-move': 'A site move is running on this server.' }[job.type] ?? 'A backup is running on this server.';
  if (heldBy(serverId)) return 'A restore test is running on this server.';
  if (db.prepare(`SELECT 1 FROM site_moves WHERE (source_server_id=? OR target_server_id=?) AND state IN ${RUNNING_MOVE}`).get(serverId, serverId)) return 'A site move is running on this server.';
  if (cleanupHeld(serverId)) return 'A cleanup is already running on this server.';
  return null;
}

const itemOf = item => ({ kind: item.kind, id: String(item.id), name: String(item.name ?? '').slice(0, 128), bytes: Number.isFinite(item.bytes) ? item.bytes : null, fingerprint: String(item.fingerprint ?? '') });
const REASONS = new Set(['site', 'oldCopy', 'move', 'restoreTest', 'restoreCopy', 'backup', 'docknest', 'inUse', 'runningStack', 'named', 'tooNew']);
// A reason this release does not know (a newer helper) is shown as unknown; the item is kept either way.
function remember(preview) {
  const now = Date.now();
  for (const [token, entry] of previews) if (entry.expires <= now) previews.delete(token);
  while (previews.size >= MAX_PREVIEWS) previews.delete(previews.keys().next().value);
  const token = randomBytes(24).toString('base64url');
  previews.set(token, { ...preview, expires: now + PREVIEW_MS });
  return { token, expiresAt: new Date(now + PREVIEW_MS).toISOString() };
}
const serverOf = serverId => db.prepare('SELECT * FROM servers WHERE id=?').get(String(serverId)) ?? (() => { throw httpError(404, 'Server not found.', 'NOT_FOUND'); })();
const unreachable = (error, server) => httpError(502, error?.hostKeyRejected ? `The saved host key for ${server.name} no longer matches. Check the server on the Servers page.` : `DockNest could not reach ${server.name}. Test the connection on the Servers page.`, 'SERVER_UNREACHABLE');
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); }
  catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'The request is not valid.', code: 'INVALID' });
    if (error.status && error.status < 600) return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    next(error);
  }
};

export async function scanServer(serverId, actor) {
  const server = serverOf(serverId), protect = protectionFor(server.id);
  let result;
  try { result = await transport.remote(server, { ...testFields(), operation: 'cleanup-scan', protect }); }
  catch (error) { if (error.remoteReported) throw httpError(409, error.message, 'CLEANUP_REFUSED'); throw unreachable(error, server); }
  const items = (Array.isArray(result?.items) ? result.items : []).filter(item => CLEANUP_KINDS.includes(item?.kind) && REF.test(String(item?.id))).map(itemOf).slice(0, MAX_ITEMS);
  const kept = (Array.isArray(result?.protected) ? result.protected : []).filter(item => CLEANUP_KINDS.includes(item?.kind)).map(item => ({ ...itemOf(item), reason: REASONS.has(item.reason) ? item.reason : 'unknown' })).map(({ fingerprint: _f, ...item }) => item);
  const busy = busyReason(server.id) ?? (result?.busy === 'restore' ? 'A restore is running on this server.' : result?.busy ? 'A backup is running on this server.' : null);
  const { token, expiresAt } = remember({ serverId: server.id, actor, items: new Map(items.map(item => [item.kind + '\0' + item.id, item])) });
  return { token, expiresAt, busy, items: items.map(({ fingerprint: _f, ...item }) => item), protected: kept, totalBytes: items.reduce((sum, item) => sum + (item.bytes ?? 0), 0) };
}

const cleanSchema = z.object({ token: z.string().min(1).max(64), items: z.array(z.object({ kind: z.enum(CLEANUP_KINDS), id: z.string().regex(REF) }).strict()).min(1).max(MAX_ITEMS) }).strict();
export async function cleanServer(serverId, body, actor) {
  const server = serverOf(serverId), { token, items } = cleanSchema.parse(body ?? {});
  const preview = previews.get(token);
  if (!preview || preview.expires <= Date.now() || preview.serverId !== server.id || preview.actor !== actor) throw httpError(409, 'This preview has expired. Scan again.', 'PREVIEW_EXPIRED');
  const chosen = [];
  for (const item of items) {
    const known = preview.items.get(item.kind + '\0' + item.id);
    if (!known) throw httpError(400, 'Only items from the preview can be cleaned.', 'NOT_IN_PREVIEW');
    if (!chosen.includes(known)) chosen.push(known);
  }
  // The busy check and the hold commit together, so no job can be claimed in between.
  const busy = takeCleanupHold(server.id, actor, () => busyReason(server.id));
  if (busy) { audit(actor, 'server.cleanup', server.id, { result: 'refused', reason: busy, requested: chosen.length }); throw httpError(409, busy + ' Clean up after it finishes.', 'SERVER_BUSY'); }
  previews.delete(token);  // used once, whatever happens next
  try {
    let result;
    try { result = await transport.remote(server, { ...testFields(), operation: 'cleanup-apply', protect: protectionFor(server.id), items: chosen.map(({ kind, id, fingerprint }) => ({ kind, id, fingerprint })) }); }
    catch (error) {
      audit(actor, 'server.cleanup', server.id, { result: error.remoteReported ? 'refused' : 'failed', requested: chosen.length, removed: 0, bytes: 0 });
      if (error.remoteReported) throw httpError(409, error.message, 'CLEANUP_REFUSED');
      throw unreachable(error, server);
    }
    const byKey = new Map(chosen.map(item => [item.kind + '\0' + item.id, item]));
    const results = (Array.isArray(result?.results) ? result.results : []).filter(row => byKey.has(row?.kind + '\0' + row?.id)).map(row => {
      const known = byKey.get(row.kind + '\0' + row.id), status = ['removed', 'skipped', 'failed'].includes(row.status) ? row.status : 'failed';
      return { kind: row.kind, id: row.id, name: known.name, status, ...(status === 'removed' ? { bytes: Number.isFinite(row.bytes) && row.kind === 'buildCache' ? row.bytes : known.bytes } : {}), ...(status !== 'removed' ? { reason: typeof row.reason === 'string' ? row.reason.slice(0, 32) : null } : {}) };
    });
    const count = status => results.filter(row => row.status === status).length;
    const summary = { removed: count('removed'), skipped: count('skipped'), failed: count('failed'), bytes: results.reduce((sum, row) => sum + (row.status === 'removed' ? row.bytes ?? 0 : 0), 0) };
    const outcome = summary.removed === chosen.length ? 'completed' : summary.removed ? 'partial' : 'nothing_removed';
    audit(actor, 'server.cleanup', server.id, { result: outcome, requested: chosen.length, ...summary, items: results.filter(row => row.status === 'removed').slice(0, 100).map(row => ({ kind: row.kind, name: row.name })) });
    return { result: outcome, ...summary, results };
  } finally { releaseCleanupHold(server.id); }
}

serverCleanupRoutes.post('/servers/:id/cleanup/scan', requireAdmin, handle(async (req, res) => res.json(await scanServer(req.params.id, req.user.id))));
serverCleanupRoutes.post('/servers/:id/cleanup', requireAdmin, handle(async (req, res) => res.json(await cleanServer(req.params.id, req.body, req.user.id))));
