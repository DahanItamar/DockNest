// Keys safe API (docs/keys-safe.md). Mounted under /api after session, CSRF and the API rate limit. The padlock of each
// app is part of /api/state; this route is the one trust decision. Known-good is administrators only, with a
// re-verification within the last 5 minutes, and DockNest scans the app afresh before marking it. Answers never carry a
// value, a fingerprint beyond its first 8 characters or a helper message.
import express from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAdmin, requireRecentAuth, rateLimit } from '../auth.js';
import { busySite } from '../engine.js';
import { confirmKnownGood } from './scan.js';
import { keysView } from './padlock.js';

export const keysSafeRoutes = express.Router();
keysSafeRoutes.post('/sites/:id/keys/known-good', requireAdmin, requireRecentAuth, rateLimit('keys-known-good', 20, 10 * 60_000), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const parsed = z.uuid().safeParse(req.params.id);
  if (!parsed.success) return res.status(400).json({ error: 'The request is not valid.', code: 'INVALID' });
  const siteId = parsed.data;
  if (!db.prepare('SELECT 1 FROM sites WHERE id=? AND id NOT IN (SELECT site_id FROM site_archives)').get(siteId)) return res.status(404).json({ error: 'App not found.', code: 'NOT_FOUND' });
  if (busySite(siteId)) return res.status(409).json({ error: 'This app is busy. Try again when its job finishes.', code: 'SITE_BUSY' });
  try { await confirmKnownGood(siteId, { source: 'admin', actor: req.user.id }); }
  catch (error) {
    console.error(`Mark as known-good failed: ${error?.code ?? error?.name}`);
    return res.status(409).json({ error: 'DockNest could not read the configuration of this app. Nothing was marked.', code: 'SCAN_FAILED' });
  }
  res.json(keysView(siteId));
});
