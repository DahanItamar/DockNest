// "Check again" for a domain path (docs/domains.md, "API"): the helper part runs through the job queue, so it waits
// for other work on the server like every job, and is read-only. Its own statuses (domain_queued, domain_running) mean a
// release without this module never claims it as a backup. The job reads the server's proxy routes (operation
// domain-routes), stores them with the certificate facts they carry, then checks the domains with a fresh DNS lookup.
import { db, id, audit } from '../db.js';
import { transport, jobRunners, siteInfo } from '../engine.js';
import { takeCertificates } from '../alerts/certificates.js';
import { recordRouting, checkDomains, siteDomains, domainClock } from './check.js';

const iso = () => new Date(domainClock.now()).toISOString();
const FAILED = 'DockNest could not read the proxy routes on this server. Test the server connection, then check again.';

// A request joins a check that has not started yet and covers it (the whole app, or the same domain).
export function enqueueDomainCheck(siteId, domain, actor) {
  const waiting = db.prepare("SELECT id FROM jobs WHERE site_id=? AND type='domain-check' AND status='domain_queued' AND (json_extract(details,'$.domain') IS NULL OR json_extract(details,'$.domain')=?)").get(siteId, domain ?? '');
  if (waiting) return { jobId: waiting.id, status: 'queued' };
  const jobId = id();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,'domain-check','domain_queued','queued',?,?)").run(jobId, siteId, iso(), JSON.stringify(domain ? { domain } : {}));
  audit(actor, 'domain.check', siteId, domain ? { domain } : {});
  return { jobId, status: 'queued' };
}

async function executeDomainCheck(job) {
  let details = {}; try { details = JSON.parse(job.details || '{}'); } catch { details = {}; }
  let error = null;
  try {
    const { server } = siteInfo(job.site_id);
    const answer = await transport.remote(server, { operation: 'domain-routes' });
    recordRouting(server.id, answer);
    takeCertificates({ serverId: server.id }, answer);
    await checkDomains(details.domain ? [details.domain] : await siteDomains(job.site_id), { trigger: 'manual', force: true });
  } catch { error = FAILED; }
  db.prepare("UPDATE jobs SET status=?,stage=?,finished_at=?,error=? WHERE id=? AND status='domain_running'").run(error ? 'failed' : 'completed', error ? 'failed' : 'completed', iso(), error, job.id);
}
jobRunners['domain-check'] = executeDomainCheck;

// A check is one helper call: an interrupted one is failed and can simply be run again.
export function recoverInterruptedDomainChecks() {
  db.prepare("UPDATE jobs SET status='failed',stage='failed',error='Worker interrupted. Check again.',finished_at=? WHERE status='domain_running'").run(iso());
}
