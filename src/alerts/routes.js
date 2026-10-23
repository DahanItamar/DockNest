// /api/alerts (docs/alerts.md). Administrators only. Writing a channel (it carries a credential) needs a recent
// re-verification, like the Cloudflare token. Secrets are write-only: no response ever contains them.
import express from 'express';
import { z } from 'zod';
import { requireAdmin, requireRecentAuth, rateLimit } from '../auth.js';
import { EVENTS, SOURCE_KINDS, DISK_USED_PERCENT, DISK_FREE_BYTES } from './events.js';
import { listChannels, createChannel, updateChannel, deleteChannel, listRules, createRule, updateRule, deleteRule, limits } from './store.js';
import { sendTest } from './delivery.js';

const uuid = z.uuid();
export const alertRoutes = express.Router();
alertRoutes.use(requireAdmin);
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); }
  catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message ?? 'The request is not valid.' });
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
};

alertRoutes.get('/', handle((_req, res) => res.json({ channels: listChannels(), rules: listRules(), events: EVENTS, sourceKinds: SOURCE_KINDS, diskLow: { usedPercent: DISK_USED_PERCENT, freeBytes: DISK_FREE_BYTES }, limits })));
alertRoutes.get('/channels', handle((_req, res) => res.json({ channels: listChannels() })));
alertRoutes.post('/channels', requireRecentAuth, rateLimit('alert-channel', 20), handle((req, res) => res.status(201).json(createChannel(req.body, req.user.id))));
alertRoutes.patch('/channels/:id', requireRecentAuth, rateLimit('alert-channel', 20), handle((req, res) => res.json(updateChannel(uuid.parse(req.params.id), req.body, req.user.id))));
alertRoutes.delete('/channels/:id', requireRecentAuth, handle((req, res) => res.json(deleteChannel(uuid.parse(req.params.id), req.user.id))));
alertRoutes.post('/channels/:id/test', rateLimit('alert-test', 10, 10 * 60_000), handle(async (req, res) => res.json(await sendTest(uuid.parse(req.params.id), req.user.id))));

alertRoutes.get('/rules', handle((_req, res) => res.json({ rules: listRules() })));
alertRoutes.post('/rules', rateLimit('alert-rule', 60), handle((req, res) => res.status(201).json(createRule(req.body, req.user.id))));
alertRoutes.patch('/rules/:id', rateLimit('alert-rule', 60), handle((req, res) => res.json(updateRule(uuid.parse(req.params.id), req.body, req.user.id))));
alertRoutes.delete('/rules/:id', handle((req, res) => res.json(deleteRule(uuid.parse(req.params.id), req.user.id))));
