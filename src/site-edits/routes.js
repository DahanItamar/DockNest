// Safe Edit API (docs/safe-edit.md, "API"). Mounted under /api after session, CSRF and the API rate limit.
// - Load, review, apply, cancel, retry and Restore backup are administrators only, with a re-verification within the
//   last 5 minutes (Compose text may hold secrets). Reading an edit and the history is open to every signed-in user.
// - Every answer is `Cache-Control: no-store`. Nothing here logs a request, echoes a body or returns a value, a payload,
//   a helper message or Docker output; errors are one fixed sentence and a code. DockNest keeps no request log, and
//   problem reports are built in the browser from fixed allow-lists, so these routes never reach either.
import express from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAdmin, requireRecentAuth, rateLimit } from '../auth.js';
import { LIMITS } from './state.js';
import { editView, reviewSiteEdit, reviewUndoSiteEdit, applySiteEdit, cancelSiteEdit, retrySiteEdit, restoreSiteEditBackup } from './engine.js';
import { detailOf, historyOf, historyQuery } from './views.js';

// The review body carries whole Compose files (at most 10 of 256 KB) and environment values (at most 200 of 8 KB), so it
// gets its own body limit; src/server.js skips the general 128 KB parser for this one path.
export const REVIEW_PATH = /^\/api\/sites\/[^/]+\/edit\/review\/?$/;
const reviewBody = express.json({ limit: '4mb' });

const uuid = z.uuid();
const absolute = z.string().min(2).max(4096).regex(/^\/[^\0\r\n]*$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const reviewSchema = z.object({
  files: z.array(z.object({ path: absolute, sha256: hex64, text: z.string().max(LIMITS.fileBytes) }).strict()).max(LIMITS.files).optional(),
  // A single-container site's environment is the file "container" (remote/helper/edit.py).
  env: z.array(z.object({ file: z.union([absolute, z.literal('container')]), key: z.string().min(1).max(128), value: z.string().max(LIMITS.valueBytes).optional(), remove: z.literal(true).optional() }).strict().refine(entry => (entry.value === undefined) !== (entry.remove === undefined), 'Give a value or remove: true.')).max(LIMITS.envKeys).optional(),
  containerChanges: z.object({ image: z.string().min(1).max(512).regex(/^[^\s\0]+$/).optional(), ports: z.array(z.object({ host: z.number().int().min(1).max(65535), container: z.number().int().min(1).max(65535), protocol: z.enum(['tcp', 'udp']).optional(), hostIp: z.string().max(64).optional() }).strict()).max(50).optional() }).strict().optional(),
}).strict();
const applySchema = z.object({ token: z.string().min(1).max(128), timeLimitSeconds: z.number().int().min(LIMITS.timeLimit.min).max(LIMITS.timeLimit.max).optional() }).strict();

export const siteEditRoutes = express.Router();
const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
const send = (res, error) => res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.field ? { field: error.field } : {}) });
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); }
  catch (error) {
    // Zod messages name limits, never the rejected value; still, only a fixed sentence goes back.
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'The request is not valid.', code: 'INVALID' });
    if (error.status && error.status < 600) return send(res, error);
    console.error(`Safe Edit request failed: ${error?.code ?? error?.name}`);
    res.status(500).json({ error: 'The change could not be handled. Try again.', code: 'FAILED' });
  }
};
const bound = req => ({ userId: req.user.id, sessionHash: req.session.token_hash });
const siteId = req => uuid.parse(req.params.id);
const bytes = text => Buffer.byteLength(text, 'utf8');

siteEditRoutes.use(['/sites/:id/edit', '/sites/:id/edits', '/site-edits'], noStore);
siteEditRoutes.get('/sites/:id/edit', requireAdmin, requireRecentAuth, handle(async (req, res) => res.json(await editView(siteId(req)))));
siteEditRoutes.post('/sites/:id/edit/review', requireAdmin, requireRecentAuth, rateLimit('site-edit-review', 60, 10 * 60_000), reviewBody, handle(async (req, res) => {
  const id = siteId(req), body = reviewSchema.parse(req.body ?? {});
  if ((body.files ?? []).some(file => bytes(file.text) > LIMITS.fileBytes)) return res.status(422).json({ error: 'This file is larger than 256 KB.', code: 'FILE_TOO_LARGE', field: 'files' });
  res.json(await reviewSiteEdit(id, body, bound(req)));
}));
siteEditRoutes.post('/sites/:id/edit/apply', requireAdmin, requireRecentAuth, handle(async (req, res) => {
  const id = siteId(req), body = applySchema.parse(req.body ?? {});
  res.status(202).json(applySiteEdit(id, body, bound(req)));
}));
siteEditRoutes.get('/sites/:id/edits', handle(async (req, res) => {
  const id = siteId(req);
  if (!db.prepare('SELECT 1 FROM sites WHERE id=?').get(id)) return res.status(404).json({ error: 'Site not found.', code: 'NOT_FOUND' });
  res.json(historyOf(id, historyQuery.parse(req.query)));
}));
siteEditRoutes.get('/site-edits/:id', handle(async (req, res) => {
  const detail = detailOf(uuid.parse(req.params.id), { admin: req.user.role === 'admin' });
  if (!detail) return res.status(404).json({ error: 'Safe Edit not found.', code: 'NOT_FOUND' });
  res.json(detail);
}));
const empty = req => z.object({}).strict().parse(req.body ?? {});
siteEditRoutes.post('/site-edits/:id/cancel', requireAdmin, requireRecentAuth, handle(async (req, res) => { empty(req); res.json(cancelSiteEdit(uuid.parse(req.params.id), req.user.id)); }));
siteEditRoutes.post('/site-edits/:id/undo/review', requireAdmin, requireRecentAuth, rateLimit('site-edit-review', 60, 10 * 60_000), handle(async (req, res) => { empty(req); res.json(await reviewUndoSiteEdit(uuid.parse(req.params.id), bound(req))); }));
siteEditRoutes.post('/site-edits/:id/retry', requireAdmin, requireRecentAuth, handle(async (req, res) => { empty(req); res.status(202).json(retrySiteEdit(uuid.parse(req.params.id), req.user.id)); }));
siteEditRoutes.post('/site-edits/:id/restore-backup', requireAdmin, requireRecentAuth, handle(async (req, res) => { empty(req); res.status(202).json(await restoreSiteEditBackup(uuid.parse(req.params.id), req.user.id)); }));
