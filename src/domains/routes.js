// Domain path API (docs/domains.md, "API"). Mounted under /api after session, CSRF and the API rate limit. Reading and
// "Check again" are open to operators and administrators. A check of a domain that belongs to an app runs through the job
// queue (src/domains/jobs.js); a domain only a stored check knows is looked up again at once (DNS only). Errors are plain
// sentences; nothing here echoes request bodies or remote output.
import express from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { userRateLimit } from '../auth.js';
import { domainName } from './facts.js';
import { domainsView, resolveDomain, checkDomains } from './check.js';
import { enqueueDomainCheck } from './jobs.js';

export const domainRoutes = express.Router();
export const domainCheckLimit = Object.freeze({ checks: 20, windowMs: 10 * 60_000 });
const fail = (res, status, error, code) => res.status(status).json({ error, code });
const operators = (req, res, next) => (['admin', 'operator'].includes(req.user?.role) ? next() : fail(res, 403, 'Operator access required.', 'FORBIDDEN'));
const checkLimit = userRateLimit('domain-check', domainCheckLimit.checks, domainCheckLimit.windowMs, 'Too many checks. Try again in a few minutes.');
const body = z.object({ domain: z.string().max(253).optional(), siteId: z.uuid().optional() }).strict().refine(value => Boolean(value.domain) !== Boolean(value.siteId), 'Name one domain or one app.');

domainRoutes.get('/domains', operators, (_req, res) => res.json(domainsView()));
domainRoutes.post('/domains/check', operators, checkLimit, async (req, res) => {
  const parsed = body.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, 'Name one domain or one app.', 'INVALID');
  if (parsed.data.siteId) {
    const site = db.prepare('SELECT id FROM sites WHERE id=? AND id NOT IN (SELECT site_id FROM site_archives)').get(parsed.data.siteId);
    if (!site) return fail(res, 404, 'App not found.', 'NOT_FOUND');
    return res.status(202).json(enqueueDomainCheck(site.id, null, req.user.id));
  }
  const domain = domainName(parsed.data.domain);
  if (!domain) return fail(res, 400, 'Enter a domain such as shop.example.com.', 'INVALID');
  const { site, known } = await resolveDomain(domain);
  if (site) return res.status(202).json(enqueueDomainCheck(site.id, domain, req.user.id));
  if (!known) return fail(res, 404, 'DockNest does not know this domain. Add it to an app first.', 'NOT_FOUND');
  const [row] = await checkDomains([domain], { trigger: 'manual', force: true });
  res.json({ domain: row });
});
