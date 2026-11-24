// Notification API (docs/notifications.md). Mounted under /api, which already requires a session and the CSRF header.
// Every query is scoped to the signed-in user's id, so one user can never see or change another user's rows.
import express from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { SEVERITIES } from './catalog.js';
import { TABS, list, counts, unreadCount, markRead, markAllRead, archive, unarchive } from './store.js';

export const notificationRoutes = express.Router();
const flag = z.enum(['1', '0', 'true', 'false']).transform(value => value === '1' || value === 'true');
const query = z.object({ tab: z.enum(TABS).default('all'), severity: z.enum(SEVERITIES).optional(), unread: flag.optional(), limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).max(100_000).default(0) }).strict();
const ids = z.object({ ids: z.array(z.number().int().positive()).min(1).max(100) }).strict();
const bad = (res, error) => res.status(400).json({ error: error.issues?.[0]?.message ?? 'The request is not valid.' });

notificationRoutes.use('/notifications', requireAdmin);
notificationRoutes.get('/notifications', (req, res) => {
  const parsed = query.safeParse(req.query); if (!parsed.success) return bad(res, parsed.error);
  const { unread, severity, ...rest } = parsed.data;
  res.json({ ...list(req.user.id, { ...rest, severity: severity ?? null, unread: unread === true }), counts: counts(req.user.id) });
});
notificationRoutes.get('/notifications/unread-count', (req, res) => res.json({ unread: unreadCount(req.user.id) }));
notificationRoutes.post('/notifications/read', (req, res) => { const parsed = ids.safeParse(req.body); if (!parsed.success) return bad(res, parsed.error); res.json({ changed: markRead(req.user.id, parsed.data.ids) }); });
notificationRoutes.post('/notifications/read-all', (req, res) => res.json({ changed: markAllRead(req.user.id) }));
notificationRoutes.post('/notifications/archive', (req, res) => { const parsed = ids.safeParse(req.body); if (!parsed.success) return bad(res, parsed.error); res.json({ changed: archive(req.user.id, parsed.data.ids) }); });
notificationRoutes.post('/notifications/unarchive', (req, res) => { const parsed = ids.safeParse(req.body); if (!parsed.success) return bad(res, parsed.error); res.json({ changed: unarchive(req.user.id, parsed.data.ids) }); });
