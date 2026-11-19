// Recovery Guide API (docs/recovery-guide.md "API"), administrators only:
// - GET /api/runbook: the page data (the guide for every app, without addresses or login details), whether it is out of
//   date and what changed, and the owner's note.
// - POST /api/runbook/notes { notes }: the "who to ask" note, at most 4,000 characters.
// - POST /api/runbook/pdf { apps[], include{} }: the PDF, built in memory and sent as a download that is never cached.
//   Login details need a re-verification in the last 5 minutes, checked here. The audit entry records who, when, the
//   app ids and the option flags, never the content; nothing of the PDF is written, kept or logged.
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, recentlyVerified, rateLimit } from '../auth.js';
import { audit } from '../db.js';
import { loadInventory } from './inventory.js';
import { buildGuide, INCLUDE_DEFAULTS } from './guide.js';
import { VERSION, guidePdf } from './render.js';
import { runbookStatus, saveNotes, markMade, inventoryParts } from './state.js';

export const MAX_APPS = 200;
const flag = name => z.boolean().default(INCLUDE_DEFAULTS[name]);
const pdfSchema = z.object({
  apps: z.array(z.uuid()).min(1, 'Choose at least one app.').max(MAX_APPS, `Choose at most ${MAX_APPS} apps.`),
  include: z.object(Object.fromEntries(Object.keys(INCLUDE_DEFAULTS).map(name => [name, flag(name)]))).strict().prefault({}),
}).strict();
const notesSchema = z.object({ notes: z.string().max(4000, 'Keep the note under 4,000 characters.') }).strict();
const failed = () => Object.assign(new Error('The PDF could not be created. Nothing was saved. Try again.'), { status: 500 });

export const runbookRoutes = Router();
runbookRoutes.use(requireAdmin);
runbookRoutes.get('/', async (_req, res) => res.json({ ...(await runbookStatus()), guide: buildGuide(await loadInventory(), { version: VERSION }) }));
runbookRoutes.post('/notes', rateLimit('runbook-notes', 30), (req, res) => { saveNotes(notesSchema.parse(req.body).notes, req.user.id); res.json({ saved: true }); });
runbookRoutes.post('/pdf', rateLimit('runbook-pdf', 20), async (req, res) => {
  const { apps, include } = pdfSchema.parse(req.body);
  if (include.logins && !recentlyVerified(req)) return res.status(403).json({ error: 'Verify your own authenticator or recovery code before this change.', code: 'REAUTH_REQUIRED' });
  const inventory = await loadInventory({ logins: include.logins }), known = new Set(inventory.apps.map(app => app.id));
  if (apps.some(appId => !known.has(appId))) return res.status(400).json({ error: 'One of the chosen apps no longer exists. Reload and choose again.' });
  const madeAt = new Date().toISOString();
  let pdf;
  try { pdf = guidePdf(inventory, { appIds: apps, include, madeAt }); } catch (error) { throw error.status === 413 ? error : failed(); }
  markMade(inventoryParts(inventory), req.user.id, madeAt);
  audit(req.user.id, 'runbook.pdf', null, { apps: [...new Set(apps)].sort(), include });
  res.set('Cache-Control', 'no-store').attachment('recovery-guide.pdf').type('application/pdf').send(pdf);
});
