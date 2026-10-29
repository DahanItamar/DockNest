// Optional "Install on server" (docs/moving-sites.md). A person can ask DockNest to install nginx, Docker, Docker
// Compose or certbot on a server a move is blocked on. Everything about WHAT runs lives in the helper
// (remote/helper.py: a fixed package name -> fixed argv table). This file never builds a command for execution; the
// `command` text it produces is only shown to the person ("Show command") so they can run it themselves.
import { z } from 'zod';
import { db, id, audit } from './db.js';
import { transport } from './engine.js';
import { HELD as TEST_HELD, heldBy } from './restore-tests/hold.js';
import { INSTALL_PACKAGES, PACKAGE_MAP, installLabel, installSupported, installCommand, osFacts, installInfo, installErrorText, dockerNeed } from './install-plan.js';

export { INSTALL_PACKAGES, PACKAGE_MAP, installLabel, installSupported, installCommand, osFacts, installInfo };
const LABELS = Object.fromEntries(INSTALL_PACKAGES.map(name => [name, installLabel(name)]));

// ---------- API ----------
const httpError = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
// siteId: the site whose move asked for the install, so its Docker need applies (the server panel sends none).
const bodySchema = z.object({ package: z.enum(INSTALL_PACKAGES), siteId: z.uuid().optional() }).strict();
const ACTIVE_JOB = "('queued','running','recovery_required','move_queued','move_running')";
const ENDED_MOVE = "('draft','rolled_back','cancelled','failed','switched_back','cleaned')";

// A site move to or from this server that has started and not ended.
export const moveActive = serverId => !!db.prepare(`SELECT 1 FROM site_moves WHERE (source_server_id=? OR target_server_id=?) AND state NOT IN ${ENDED_MOVE}`).get(serverId, serverId);
// An install on this server that is queued or running (the move start path refuses while one is).
export const installActive = serverId => !!db.prepare("SELECT 1 FROM server_installs WHERE server_id=? AND status IN ('queued','running')").get(serverId);

// Any queued or running work that uses this server: site jobs on it, moves to or from it, or another install.
export function serverBusy(serverId) {
  return !!(
    db.prepare(`SELECT 1 FROM jobs j WHERE j.status IN ${ACTIVE_JOB} AND ? IN (COALESCE((SELECT server_id FROM sites WHERE id=j.site_id),''),COALESCE(json_extract(j.details,'$.targetServerId'),''),COALESCE(json_extract(j.details,'$.sourceServerId'),''))`).get(serverId)
    || moveActive(serverId)
    || installActive(serverId)
    || heldBy(serverId)
  );
}

const plainRemote = (error, name) => (error?.hostKeyRejected ? `The saved host key for ${name} no longer matches. Check the server on the Servers page.` : `DockNest could not read ${name}. Test the connection on the Servers page.`);

// The site's own selected containers decide its Docker need, as in move preflight.
function siteNeed(siteId) {
  if (!siteId) return {};
  const site = db.prepare('SELECT config FROM sites WHERE id=?').get(siteId);
  if (!site) throw httpError(404, 'Site not found.');
  let config = {};
  try { config = JSON.parse(site.config); } catch { /* An unreadable configuration counts as several containers. */ }
  return dockerNeed(Array.isArray(config.containers) ? config.containers.length : 2);
}

export async function requestInstall(serverId, body, actor) {
  const { package: name, siteId } = bodySchema.parse(body ?? {});
  const server = db.prepare('SELECT * FROM servers WHERE id=?').get(serverId);
  if (!server) throw httpError(404, 'Server not found.');
  const need = siteNeed(siteId);
  const busy = () => httpError(409, `${server.name} is busy with another job. Try again when it finishes.`, 'SERVER_BUSY');
  if (serverBusy(server.id)) throw busy();
  let status;
  try { status = await transport.remote(server, { operation: 'install-status' }); }
  catch (error) { throw httpError(409, plainRemote(error, server.name), 'SERVER_UNREACHABLE'); }
  // Re-verified here, not trusted from the browser: the person saw an earlier preview.
  const info = installInfo(status, name, need);
  if (!info.supported) throw httpError(409, info.reason ?? `DockNest cannot install ${LABELS[name]} on ${server.name}. Use "Show command" or install it yourself.`, 'INSTALL_UNSUPPORTED');
  if (status?.installed?.[name] !== false) throw httpError(409, name === 'docker' ? installErrorText('DOCKER_NOT_RUNNING', name) : `${LABELS[name]} is already installed on ${server.name}.`, 'ALREADY_INSTALLED');
  // The checks above awaited the network; look again right before writing so two requests cannot both start.
  if (serverBusy(server.id)) throw busy();
  const steps = [{ name: 'Connected', status: 'queued' }, { name: 'Package list updated', status: 'queued' }, { name: `Installing ${LABELS[name]}`, status: 'queued' }, { name: `Checking ${LABELS[name]} works`, status: 'queued' }];
  const jobId = id(), at = new Date().toISOString();
  db.prepare("INSERT INTO server_installs(id,server_id,package,status,stage,steps,actor,created_at) VALUES(?,?,?,'queued','queued',?,?,?)").run(jobId, server.id, name, JSON.stringify(steps), actor, at);
  audit(actor, 'server.install.requested', server.id, { package: name, job: jobId });
  return { job: { id: jobId } };
}

// The same shape as a job (GET /api/jobs/:id), so the UI polls one thing.
export function installJobView(row) {
  if (!row) return row;
  let steps = [];
  try { steps = JSON.parse(row.steps); } catch { /* Shown without steps. */ }
  return { id: row.id, site_id: null, type: 'install', status: row.status, stage: row.stage, created_at: row.created_at, started_at: row.started_at, finished_at: row.finished_at, error: row.error, details: { serverId: row.server_id, package: row.package, steps } };
}
export const findInstall = jobId => installJobView(db.prepare('SELECT * FROM server_installs WHERE id=?').get(jobId));

// ---------- worker ----------
// Installs wait while any site job runs, or needs recovery, on the same server. The worker runs one thing at a time.
export function claimInstall() {
  db.exec('BEGIN IMMEDIATE');
  try {
    const job = db.prepare(`SELECT i.* FROM server_installs i WHERE i.status='queued' AND NOT EXISTS (SELECT 1 FROM site_moves m WHERE (m.source_server_id=i.server_id OR m.target_server_id=i.server_id) AND m.state NOT IN ${ENDED_MOVE}) AND NOT EXISTS (SELECT 1 FROM jobs a WHERE a.status IN ('running','recovery_required','move_running') AND i.server_id IN (COALESCE((SELECT server_id FROM sites WHERE id=a.site_id),''),COALESCE(json_extract(a.details,'$.targetServerId'),''),COALESCE(json_extract(a.details,'$.sourceServerId'),''))) AND NOT EXISTS (SELECT 1 FROM restore_tests t WHERE t.server_id=i.server_id AND ${TEST_HELD}) ORDER BY i.created_at LIMIT 1`).get();
    if (job) db.prepare("UPDATE server_installs SET status='running',stage='connecting',started_at=? WHERE id=?").run(new Date().toISOString(), job.id);
    db.exec('COMMIT');
    return job;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function failInterruptedInstalls(at = new Date().toISOString()) {
  db.prepare("UPDATE server_installs SET status='failed',stage='failed',error='DockNest stopped while installing. Check the server, then try again.',finished_at=? WHERE status='running'").run(at);
}

// Stage names the helper reports -> which step is running. Earlier steps are done when a later one starts.
const STAGE_STEP = { connected: 0, update: 1, install: 2, verify: 3 };
// Only the helper's short codes are understood; every other failure (lost connection, odd error) gets a fixed sentence.
const plainError = (error, name, label) => (error?.remoteReported ? installErrorText(String(error.message), label) : error?.hostKeyRejected ? `The saved host key for ${name} no longer matches.` : `The connection to ${name} failed or was lost. The install may still be finishing on the server; check it before trying again.`);

export async function executeInstall(job) {
  const server = db.prepare('SELECT * FROM servers WHERE id=?').get(job.server_id);
  let steps = JSON.parse(job.steps), current = 0, reached = false;
  const save = (status, stage, extra = {}) => {
    const fields = Object.keys(extra);
    db.prepare(`UPDATE server_installs SET steps=?,stage=?${status ? ',status=?' : ''}${fields.map(field => `,${field}=?`).join('')} WHERE id=? AND status='running'`).run(JSON.stringify(steps), stage, ...(status ? [status] : []), ...fields.map(field => extra[field]), job.id);
  };
  const mark = index => { steps = steps.map((step, position) => ({ ...step, status: position < index ? 'done' : position === index ? 'running' : 'queued' })); current = index; };
  mark(0); save(null, 'connecting');
  try {
    if (!server) throw Object.assign(new Error('GENERIC'), { remoteReported: true });
    await transport.remote(server, { operation: 'install', package: job.package }, stage => {
      const index = STAGE_STEP[stage];
      if (index === undefined || index < current) return;
      reached = true; mark(index); save(null, stage);
    });
    steps = steps.map(step => ({ ...step, status: 'done' }));
    save('completed', 'completed', { finished_at: new Date().toISOString() });
    audit('worker', 'server.install.completed', job.server_id, { package: job.package, job: job.id });
  } catch (error) {
    steps = steps.map((step, position) => ({ ...step, status: position < current ? 'done' : position === current ? 'failed' : 'queued' }));
    save('failed', 'failed', { finished_at: new Date().toISOString(), error: plainError(error, server?.name ?? 'the server', job.package) });
    audit('worker', 'server.install.failed', job.server_id, { package: job.package, job: job.id, reachedHelper: reached });
  }
}
