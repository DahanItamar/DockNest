// Launch API (docs/launch-site.md, "API"): administrators only, CSRF (the /api middleware), re-verification within
// 5 minutes for Launch and Remove launch. Answers never hold the pasted Compose text, environment values, deploy keys
// or raw helper output.
import express from 'express';
import { z } from 'zod';
import { requireAdmin, requireRecentAuth, rateLimit } from '../auth.js';
import { LaunchInputError } from './validate.js';
import { checkLaunch, startLaunch, launchView, listLaunches, cancelLaunch, checkDnsAgain, removeLaunch, retryLaunch } from './engine.js';

const uuid = z.uuid();
// Shapes only; the rules (domain, URL, ref, path, environment) live in validate.js and engine.launchInput.
const common = {
  source: z.enum(['compose', 'git']), domain: z.string().max(300), compose: z.string().max(200_000).optional(),
  repo: z.object({ url: z.string().max(600), ref: z.string().max(250), composePath: z.string().max(350).optional() }).strict().optional(),
  deployKeyId: uuid.optional(), allowPrivate: z.boolean().optional(), webService: z.string().max(80).nullable().optional(), webPort: z.number().int().nullable().optional(),
  env: z.record(z.string().max(200), z.string().max(10_000)).optional(),
};
const checkBody = z.object(common).strict();
const launchBody = z.object({ ...common, testServerId: uuid.nullable().optional(), backupTime: z.string().max(5).optional(), trustConfirmed: z.boolean().optional(), cleanShutdownConfirmed: z.boolean().optional() }).strict();
const empty = z.object({}).strict();

const handle = fn => async (req, res, next) => {
  try { await fn(req, res); }
  catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'The request is not valid.', code: 'INVALID' }); // never echo values back
    if (error instanceof LaunchInputError || error.status) return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.field ? { field: error.field } : {}), ...(error.refusals ? { refusals: error.refusals } : {}), ...(error.checks ? { checks: error.checks } : {}), ...(error.keyId ? { keyId: error.keyId } : {}) });
    next(error);
  }
};

// Mounted at /api/servers/:serverId/launch.
export const serverLaunchRoutes = express.Router({ mergeParams: true });
serverLaunchRoutes.use(requireAdmin);
serverLaunchRoutes.get('/', handle(async (req, res) => res.json({ launches: listLaunches(uuid.parse(req.params.serverId)) })));
serverLaunchRoutes.post('/check', rateLimit('launch-check', 30, 10 * 60_000), handle(async (req, res) => res.json(await checkLaunch(uuid.parse(req.params.serverId), checkBody.parse(req.body ?? {})))));
serverLaunchRoutes.post('/', requireRecentAuth, rateLimit('launch-start', 20, 10 * 60_000), handle(async (req, res) => res.status(202).json(await startLaunch(uuid.parse(req.params.serverId), launchBody.parse(req.body ?? {}), req.user.id))));

// Mounted at /api/launches.
export const launchRoutes = express.Router();
launchRoutes.use(requireAdmin);
launchRoutes.get('/', handle(async (_req, res) => res.json({ launches: listLaunches(null) })));
launchRoutes.get('/:id', handle(async (req, res) => res.json(launchView(uuid.parse(req.params.id)))));
launchRoutes.post('/:id/cancel', handle(async (req, res) => { empty.parse(req.body ?? {}); res.json(cancelLaunch(uuid.parse(req.params.id), req.user.id)); }));
launchRoutes.post('/:id/check-dns', rateLimit('launch-check-dns', 30, 10 * 60_000), handle(async (req, res) => { empty.parse(req.body ?? {}); res.status(202).json(checkDnsAgain(uuid.parse(req.params.id), req.user.id)); }));
launchRoutes.post('/:id/remove', requireRecentAuth, handle(async (req, res) => { empty.parse(req.body ?? {}); res.status(202).json(removeLaunch(uuid.parse(req.params.id), req.user.id)); }));
launchRoutes.post('/:id/retry', requireRecentAuth, handle(async (req, res) => { empty.parse(req.body ?? {}); res.status(202).json(retryLaunch(uuid.parse(req.params.id), req.user.id)); }));
