// /api/alerts (docs/alerts.md). Administrators only. Credentials carry the secrets (bot token, SMTP login): creating,
// replacing or deleting one needs a recent re-verification, like the Cloudflare token, and secrets are write-only.
// Channels (the Map nodes) and rules (the lines) hold no secrets, so they need an administrator only.
import express from 'express';
import { z } from 'zod';
import { requireAdmin, requireRecentAuth, rateLimit } from '../auth.js';
import { EVENTS, SOURCE_KINDS, DISK_USED_PERCENT, DISK_FREE_BYTES } from './events.js';
import { listCredentials, createCredential, updateCredential, deleteCredential, listChannels, createChannel, updateChannel, deleteChannel, listRules, createRule, updateRule, deleteRule, limits } from './store.js';
import { sendTest, verifyCredential } from './delivery.js';

const uuid = z.uuid();
export const alertRoutes = express.Router();
alertRoutes.use(requireAdmin);
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); }
  catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message ?? 'The request is not valid.' });
    if (error.status) return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.nodes ? { nodes: error.nodes } : {}) });
    next(error);
  }
};

alertRoutes.get('/', handle((_req, res) => res.json({ credentials: listCredentials(), channels: listChannels(), rules: listRules(), events: EVENTS, sourceKinds: SOURCE_KINDS, diskLow: { usedPercent: DISK_USED_PERCENT, freeBytes: DISK_FREE_BYTES }, limits })));

alertRoutes.get('/credentials', handle((_req, res) => res.json({ credentials: listCredentials() })));
alertRoutes.post('/credentials', requireRecentAuth, rateLimit('alert-credential', 20), handle((req, res) => res.status(201).json(createCredential(req.body, req.user.id))));
alertRoutes.patch('/credentials/:id', requireRecentAuth, rateLimit('alert-credential', 20), handle((req, res) => res.json(updateCredential(uuid.parse(req.params.id), req.body, req.user.id))));
alertRoutes.delete('/credentials/:id', requireRecentAuth, handle((req, res) => res.json(deleteCredential(uuid.parse(req.params.id), req.user.id))));
alertRoutes.post('/credentials/:id/test', rateLimit('alert-test', 10, 10 * 60_000), handle(async (req, res) => res.json(await verifyCredential(uuid.parse(req.params.id), req.user.id))));

alertRoutes.get('/channels', handle((_req, res) => res.json({ channels: listChannels() })));
alertRoutes.post('/channels', rateLimit('alert-channel', 40), handle((req, res) => res.status(201).json(createChannel(req.body, req.user.id))));
alertRoutes.patch('/channels/:id', rateLimit('alert-channel', 40), handle((req, res) => res.json(updateChannel(uuid.parse(req.params.id), req.body, req.user.id))));
alertRoutes.delete('/channels/:id', handle((req, res) => res.json(deleteChannel(uuid.parse(req.params.id), req.user.id))));
alertRoutes.post('/channels/:id/test', rateLimit('alert-test', 10, 10 * 60_000), handle(async (req, res) => res.json(await sendTest(uuid.parse(req.params.id), req.user.id))));

alertRoutes.get('/rules', handle((_req, res) => res.json({ rules: listRules() })));
alertRoutes.post('/rules', rateLimit('alert-rule', 60), handle((req, res) => res.status(201).json(createRule(req.body, req.user.id))));
alertRoutes.patch('/rules/:id', rateLimit('alert-rule', 60), handle((req, res) => res.json(updateRule(uuid.parse(req.params.id), req.body, req.user.id))));
alertRoutes.delete('/rules/:id', handle((req, res) => res.json(deleteRule(uuid.parse(req.params.id), req.user.id))));
