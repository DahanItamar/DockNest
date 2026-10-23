// Optional "Install on server" (docs/moving-sites.md). A person can ask DockNest to install nginx, Docker, Docker
// Compose or certbot on a server a move is blocked on. Everything about WHAT runs lives in the helper
// (remote/helper.py: a fixed package name -> fixed argv table). This file never builds a command for execution; the
// `command` text it produces is only shown to the person ("Show command") so they can run it themselves.
import { z } from 'zod';
import { db, id, audit } from './db.js';
import { transport } from './engine.js';
import { INSTALL_PACKAGES, PACKAGE_MAP, installLabel, installSupported, installCommand, osFacts, installInfo } from './install-plan.js';

export { INSTALL_PACKAGES, PACKAGE_MAP, installLabel, installSupported, installCommand, osFacts, installInfo };
const LABELS = Object.fromEntries(INSTALL_PACKAGES.map(name => [name, installLabel(name)]));

// ---------- API ----------
const httpError = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const bodySchema = z.object({ package: z.enum(INSTALL_PACKAGES) }).strict();
const ACTIVE_JOB = "('queued','running','recovery_required','move_queued','move_running')";
const ENDED_MOVE = "('draft','rolled_back','cancelled','failed','switched_back','cleaned')";

// Any queued or running work that uses this server: site jobs on it, moves to or from it, or another install.
export function serverBusy(serverId) {
  return !!(
    db.prepare(`SELECT 1 FROM jobs j WHERE j.status IN ${ACTIVE_JOB} AND ? IN (COALESCE((SELECT server_id FROM sites WHERE id=j.site_id),''),COALESCE(json_extract(j.details,'$.targetServerId'),''),COALESCE(json_extract(j.details,'$.sourceServerId'),''))`).get(serverId)
    || db.prepare(`SELECT 1 FROM site_moves WHERE (source_server_id=? OR target_server_id=?) AND state NOT IN ${ENDED_MOVE}`).get(serverId, serverId)
    || db.prepare("SELECT 1 FROM server_installs WHERE server_id=? AND status IN ('queued','running')").get(serverId)
  );
}

const plainRemote = (error, name) => (error?.hostKeyRejected ? `The saved host key for ${name} no longer matches. Check the server on the Servers page.` : error?.remoteReported ? String(error.message).slice(0, 300) : `DockNest could not connect to ${name}. Test the connection on the Servers page.`);

export async function requestInstall(serverId, body, actor) {
  const { package: name } = bodySchema.parse(body ?? {});
  const server = db.prepare('SELECT * FROM servers WHERE id=?').get(serverId);
  if (!server) throw httpError(404, 'Server not found.');
  const busy = () => httpError(409, `${server.name} is busy with another job. Try again when it finishes.`, 'SERVER_BUSY');
  if (serverBusy(server.id)) throw busy();
  let status;
  try { status = await transport.remote(server, { operation: 'install-status' }); }
  catch (error) { throw httpError(409, plainRemote(error, server.name), 'SERVER_UNREACHABLE'); }
  // Re-verified here, not trusted from the browser: the person saw an earlier preview.
  const info = installInfo(status, name);
  if (!info.supported) throw httpError(409, `DockNest cannot install ${LABELS[name]} on ${server.name}. Use "Show command" or install it yourself.`, 'INSTALL_UNSUPPORTED');
  if (status?.installed?.[name] !== false) throw httpError(409, `${LABELS[name]} is already installed on ${server.name}.`, 'ALREADY_INSTALLED');
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
    const job = db.prepare("SELECT i.* FROM server_installs i WHERE i.status='queued' AND NOT EXISTS (SELECT 1 FROM jobs a WHERE a.status IN ('running','recovery_required','move_running') AND i.server_id IN (COALESCE((SELECT server_id FROM sites WHERE id=a.site_id),''),COALESCE(json_extract(a.details,'$.targetServerId'),''),COALESCE(json_extract(a.details,'$.sourceServerId'),''))) ORDER BY i.created_at LIMIT 1").get();
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
const plainError = (error, name) => String(error?.remoteReported ? error.message : error?.hostKeyRejected ? `The saved host key for ${name} no longer matches.` : `The connection to ${name} failed or was lost. The install may still be finishing on the server; check it before trying again.`).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '').slice(0, 400);

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
    if (!server) throw Object.assign(new Error('This server was removed.'), { remoteReported: true });
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
    save('failed', 'failed', { finished_at: new Date().toISOString(), error: plainError(error, server?.name ?? 'the server') });
    audit('worker', 'server.install.failed', job.server_id, { package: job.package, job: job.id, reachedHelper: reached });
  }
}
