// /api/moves (docs/moving-sites.md, "API for the UI"). Administrators only; starting a move also needs a recent
// re-verification, like other sensitive actions. The JSON shapes here are the contract the Map UI builds against.
import express from 'express';
import { z } from 'zod';
import { requireAdmin, requireRecentAuth, rateLimit } from '../auth.js';
import { previewMove, startMove, cancelMove, continueMove, moveView, listMoves } from './engine.js';

const uuid = z.uuid();
const options = z.object({
  dnsMode: z.enum(['manual', 'cloudflare']).default('manual'),
  envRewrite: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/)).max(100).default([]),
  askBeforeSwitch: z.boolean().default(false),
}).strict().default({ dnsMode: 'manual', envRewrite: [], askBeforeSwitch: false });

export const moveRoutes = express.Router();
moveRoutes.use(requireAdmin);
// Errors from the engine carry a plain sentence, and for a changed preview the fresh preview to show instead.
const send = (res, error) => res.status(error.status || 500).json({ error: error.status ? error.message : 'The move could not be updated. Try again.', ...(error.code ? { code: error.code } : {}), ...(error.preview ? { preview: error.preview } : {}), ...(error.moveId ? { moveId: error.moveId } : {}) });
const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { if (error.status) return send(res, error); next(error); } };

moveRoutes.get('/', (_req, res) => res.json({ moves: listMoves() }));
moveRoutes.post('/', rateLimit('move-preview', 40, 10 * 60_000), handle(async (req, res) => {
  const body = z.object({ siteId: uuid, targetServerId: uuid, options }).strict().parse(req.body);
  res.status(201).json(await previewMove(body, req.user.id));
}));
moveRoutes.get('/:id', handle(async (req, res) => res.json(moveView(uuid.parse(req.params.id)))));
moveRoutes.post('/:id/start', requireRecentAuth, rateLimit('move-start', 30, 10 * 60_000), handle(async (req, res) => {
  const body = z.object({ preflightHash: z.string().regex(/^[0-9a-f]{64}$/), moveAnyway: z.boolean().default(false) }).strict().parse(req.body);
  res.status(202).json(await startMove(uuid.parse(req.params.id), body, req.user.id));
}));
moveRoutes.post('/:id/cancel', handle(async (req, res) => res.json(cancelMove(uuid.parse(req.params.id), req.user.id))));
moveRoutes.post('/:id/continue', handle(async (req, res) => {
  const body = z.object({ gate: z.enum(['owner-switch', 'dns']) }).strict().parse(req.body);
  res.json(await continueMove(uuid.parse(req.params.id), body.gate, req.user.id));
}));
