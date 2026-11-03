// Launch engine (docs/launch-site.md): check, start, cancel, Check again, Remove launch and the worker that drives each
// launch step by step. The pure rules live in state.js; inputs are checked in validate.js; the hold in hold.js and the
// claim in claim.js.
// - Server steps run as short launch jobs (site_launch_steps rows in launch_queued/launch_running). Waiting between
//   health checks and for DNS holds no job; nothing polls DNS: the owner presses Check again.
// - Every created thing is journalled by the helper before it is created; any failure before `save` runs the teardown,
//   and a teardown that fails leaves the launch in needs_attention with its hold (alert launch.needs_you).
// - The pasted Compose text and environment values exist only in the sealed payload of the fetch step, wiped after it.
//   They never reach the launch row, a log line, an audit row or an answer. The deploy key is read from its sealed row
//   only for the helper request.
import { CronExpressionParser } from 'cron-parser';
import { isIP } from 'node:net';
import { db, id, audit, transaction } from '../db.js';
import { seal, open } from '../crypto.js';
import { deploymentHeld } from '../deployment-hold.js';
import { transport, enqueueBackup, setupMaintenance, movingSite } from '../engine.js';
import { classify } from '../alerts/addresses.js';
import { moveActive, installActive, installInfo, INSTALL_PACKAGES } from '../installs.js';
import { cleanupHeld } from '../cleanup-hold.js';
import { maintenanceDefaults, normalizeMaintenance } from '../../shared/maintenance-design.js';
import { firstDueAt } from '../restore-tests/settings.js';
import { LAUNCH_STEPS } from '../migrations.js';
import { launchActive } from './hold.js';
import { launchDomain, slugFor, parseRepoUrl, checkRef, checkComposePath, checkEnv, LaunchInputError } from './validate.js';
import { deployKeyForLaunch, deployKeyRow } from './deploy-keys.js';
import { STEP_ORDER, LABELS, STEP_LIMITS, HEALTH, REMOVE_WINDOW_MS, RATE, OPEN_STATES, nextAction, cancelable, busyStep, saved, plainReason } from './state.js';

const iso = ms => new Date(ms).toISOString();
const httpError = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const serverRow = serverId => db.prepare('SELECT * FROM servers WHERE id=?').get(serverId);
// SSH and the clock; tests replace members.
export const launchTransport = {
  remote: (server, request, options = {}) => transport.remote(server, request, () => {}, () => {}, options),
  now: () => Date.now(),
};
const now = () => iso(launchTransport.now());
// Long helper calls keep stdin open; closing it (abort) tells the helper to stop and clean up its process group.
const WATCHED = new Set(['launch-fetch', 'launch-build', 'launch-start', 'launch-teardown']);
export const SITE_ROOT = '/srv/docknest';
export const COMPOSE_TEXT_LIMIT = 96 * 1024;

// ---------- persistence ----------
const parseJson = (text, fallback) => { try { return JSON.parse(text ?? ''); } catch { return fallback; } };
export function loadLaunch(launchId) {
  const row = db.prepare('SELECT * FROM site_launches WHERE id=?').get(launchId);
  return row ? { ...row, options: parseJson(row.options, {}), cancel_requested: !!row.cancel_requested } : null;
}
export const loadSteps = launchId => db.prepare('SELECT * FROM site_launch_steps WHERE launch_id=?').all(launchId)
  .map(row => ({ ...row, result: parseJson(row.result, {}) }))
  .sort((a, b) => LAUNCH_STEPS.indexOf(a.step) - LAUNCH_STEPS.indexOf(b.step));
function setStep(launchId, step, fields, guard = null) {
  const keys = Object.keys(fields);
  const values = keys.map(key => (key === 'result' ? JSON.stringify(fields[key]) : fields[key]));
  return db.prepare(`UPDATE site_launch_steps SET ${keys.map(key => `${key}=?`).join(',')} WHERE launch_id=? AND step=?${guard ? ' AND state=?' : ''}`).run(...values, launchId, step, ...(guard ? [guard] : [])).changes === 1;
}
function setLaunch(launchId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const values = keys.map(key => (key === 'options' ? JSON.stringify(fields[key]) : key === 'cancel_requested' ? (fields[key] ? 1 : 0) : fields[key]));
  db.prepare(`UPDATE site_launches SET ${keys.map(key => `${key}=?`).join(',')},updated_at=? WHERE id=?`).run(...values, now(), launchId);
}
// The failure is written once (a trigger enforces it): the first step that failed and its reason.
function recordFailure(launch, step, reason) {
  if (launch.failed_step || launch.reason) return;
  setLaunch(launch.id, { failed_step: step, reason: plainReason(reason) });
}
const SAFE_RESULT = ['certCode', 'tries', 'services', 'commit', 'images', 'containerCount', 'containerNames', 'composeFiles', 'certName', 'state', 'removed', 'left', 'file', 'jobId', 'backupId', 'deadline', 'interrupted', 'recovered', 'gate', 'checks'];
const journalResult = (previous, extra) => Object.fromEntries(Object.entries({ ...previous, ...extra }).filter(([key]) => SAFE_RESULT.includes(key)));

// ---------- input ----------
// One normalised description of what to launch, from a check or launch request body. Never holds the deploy key.
export function launchInput(serverId, body) {
  const domain = launchDomain(body.domain), slug = slugFor(domain);
  const source = body.source;
  if (!['compose', 'git'].includes(source)) throw new LaunchInputError('INVALID_SOURCE', 'Choose a Compose file or a Git repository.', 'source');
  const input = { serverId, domain, slug, source, webService: null, webPort: null, env: checkEnv(body.env), allowPrivate: !!body.allowPrivate };
  if (body.webService !== undefined && body.webService !== null) {
    if (typeof body.webService !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(body.webService)) throw new LaunchInputError('INVALID_SERVICE', 'Choose the service that serves the website.', 'webService');
    input.webService = body.webService;
  }
  if (body.webPort !== undefined && body.webPort !== null) {
    if (!Number.isInteger(body.webPort) || body.webPort < 1 || body.webPort > 65535) throw new LaunchInputError('INVALID_PORT', 'The container port must be between 1 and 65535.', 'webPort');
    input.webPort = body.webPort;
  }
  if (source === 'compose') {
    if (typeof body.compose !== 'string' || !body.compose.trim()) throw new LaunchInputError('INVALID_COMPOSE', 'Paste or upload a Compose file.', 'compose');
    if (Buffer.byteLength(body.compose) > COMPOSE_TEXT_LIMIT || body.compose.includes('\u0000')) throw new LaunchInputError('INVALID_COMPOSE', 'The Compose file must be text of at most 96 KB.', 'compose');
    input.composeText = body.compose;
  } else {
    const repo = body.repo ?? {};
    input.repo = { ...parseRepoUrl(repo.url, { allowPrivate: input.allowPrivate }), ref: checkRef(repo.ref), composePath: checkComposePath(repo.composePath ?? 'compose.yaml') };
    if (input.repo.kind === 'ssh') {
      if (!body.deployKeyId) throw new LaunchInputError('DEPLOY_KEY_REQUIRED', 'Choose a deploy key for an SSH repository address.', 'deployKeyId');
      const key = deployKeyRow(body.deployKeyId);
      if (!key) throw httpError(409, 'DEPLOY_KEY_MISSING', 'The deploy key was not found. Create it on the Connections page first.');
      const host = input.repo.port === 22 ? input.repo.host : `${input.repo.host}:${input.repo.port}`;
      if (key.git_host.replace(/^\[|\]$/g, '') !== host && key.git_host !== host) throw new LaunchInputError('DEPLOY_KEY_HOST', `This deploy key is for ${key.git_host}, not ${host}.`, 'deployKeyId');
      input.deployKeyId = key.id;
    } else if (body.deployKeyId) throw new LaunchInputError('DEPLOY_KEY_HTTPS', 'Deploy keys are only for SSH repository addresses.', 'deployKeyId');
  }
  return input;
}
const repoRequest = input => (input.repo ? { url: input.repo.url, ref: input.repo.ref, composePath: input.repo.composePath, allowPrivate: input.allowPrivate } : undefined);
const keyRequest = (input, serverId) => (input.deployKeyId ? (({ privateKey, hostKeyLine }) => ({ privateKey, hostKeyLine }))(deployKeyForLaunch(input.deployKeyId, serverId)) : undefined);

// ---------- helper answers ----------
async function helper(server, request, { signal } = {}) {
  const watched = WATCHED.has(request.operation);
  try { return await launchTransport.remote(server, watched ? { ...request, watchStdin: true } : request, watched ? { keepStdinOpen: true, ...(signal ? { signal } : {}) } : (signal ? { signal } : {})); }
  catch (error) {
    if (error?.aborted) throw Object.assign(new Error('stopped'), { stopped: true });
    throw Object.assign(new Error(error?.remoteReported ? plainReason(error.message) : error?.hostKeyRejected ? `The saved host key for ${server.name} no longer matches. Check the server on the Servers page.` : `The connection to ${server.name} failed or was lost.`), { remote: true });
  }
}
// Helper refusals ({ ok:false, code, reason }): remote/helper/launch.py answers a code from its fixed LAUNCH_REASONS table
// with that table's sentence. A few codes get a sentence that names the domain; any other reason is sanitised.
const REFUSALS = {
  NGINX_DOMAIN_SERVED: domain => `nginx on this server already serves ${domain} (or a wildcard or default site that matches it). DockNest never takes over another site.`,
  CERT_LINEAGE_EXISTS: domain => `A certificate for ${domain} already exists on this server, so DockNest does not create another.`,
  PORT_IN_USE: () => 'The local port DockNest chose was taken meanwhile. Launch again.',
};
const refusalText = (answer, domain) => (Object.hasOwn(REFUSALS, answer?.code) ? REFUSALS[answer.code](domain) : plainReason(answer?.reason, 'The server refused this step.'));
// launch-poll answers a short code (and the service) as its reason; these are the sentences.
const POLL_REASONS = {
  NO_CONTAINERS: () => 'No container of the site is running.',
  RESTARTING: service => `${service ?? 'A service'} is restarting.`,
  CRASH_LOOP: service => `${service ?? 'A service'} keeps crashing and restarting.`,
  SERVICE_STOPPED: service => `${service ?? 'A service'} stopped.`,
  UNHEALTHY: service => `${service ?? 'A service'} reports that it is unhealthy.`,
  HEALTH_STARTING: service => `Waiting for ${service ?? 'a service'} to report healthy.`,
  NO_ANSWER: () => 'Waiting for the site to answer on its local port.',
  HTTP_ERROR: () => 'The site answers with a server error.',
  SETTLING: () => 'The site answers; waiting a moment to see it stays up.',
};
const pollText = (answer, fallback) => (Object.hasOwn(POLL_REASONS, answer?.reason) ? POLL_REASONS[answer.reason](typeof answer.service === 'string' ? answer.service.slice(0, 63) : null) : plainReason(answer?.reason, fallback));
const refused = answer => answer && typeof answer === 'object' && answer.ok === false;
const cleanCode = code => (/^[A-Z][A-Z0-9_]{1,40}$/.test(String(code)) ? code : 'REFUSED');

// Ports 80 and 443 held by anything other than the server's nginx block the launch (launch-facts `ports`: holder and
// the process name only).
function portChecks(facts) {
  return [80, 443].map(port => facts?.ports?.[String(port)]).filter(item => item && item.holder === 'other').map(item => {
    const name = typeof item.process === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,31}$/.test(item.process) ? item.process : 'another program';
    return { id: `port${item.port === 443 ? 443 : 80}`, ok: false, code: 'PORT_IN_USE', text: `Port ${item.port === 443 ? 443 : 80} is used by ${name}. Stop it, then Check again.` };
  });
}
// The checks shown before Launch, in the move shape: { id, ok, code?, text, install? }.
function checksOf(facts, domain) {
  return [...checkRows(facts, domain), ...portChecks(facts)];
}
function checkRows(facts, domain) {
  return (Array.isArray(facts?.checks) ? facts.checks : []).slice(0, 40).map(item => ({
    id: String(item?.id ?? 'check').slice(0, 40), ok: item?.ok === true, ...(item?.ok === true ? {} : { code: cleanCode(item?.code) }),
    text: item?.ok === true ? plainReason(item?.reason, '') : refusalText(item, domain),
    ...(item?.install && INSTALL_PACKAGES.includes(typeof item.install === 'string' ? item.install : item.install.package) ? { install: installInfo(facts, typeof item.install === 'string' ? item.install : item.install.package) } : {}),
  }));
}
function servicesOf(answer) {
  return (Array.isArray(answer?.services) ? answer.services : []).slice(0, 50).filter(item => typeof item?.name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(item.name))
    .map(item => ({ name: item.name, ports: (Array.isArray(item.ports) ? item.ports : []).filter(port => Number.isInteger(port) && port > 0 && port < 65536).slice(0, 20), build: item.build === true }));
}
// The DNS record the owner adds: A to the server's IPv4 address, AAAA to its IPv6 address (IPv6-only servers get AAAA only).
// Private, CGNAT, loopback and documentation addresses never go into a public record (classify, src/alerts/addresses.js).
function dnsView(facts, domain, serverHost = null) {
  const reported = (Array.isArray(facts?.serverIps) ? facts.serverIps : []).filter(value => isIP(value));
  const ips = [...reported.filter(value => classify(value) === 'public'), ...(serverHost && isIP(serverHost) && classify(serverHost) === 'public' && !reported.includes(serverHost) ? [serverHost] : [])];
  const answers = { A: (facts?.dnsAnswers?.A ?? []).filter(value => isIP(value) === 4), AAAA: (facts?.dnsAnswers?.AAAA ?? []).filter(value => isIP(value) === 6) };
  const v4 = ips.find(value => isIP(value) === 4) ?? null, v6 = ips.find(value => isIP(value) === 6) ?? null;
  const records = [...(v4 ? [{ type: 'A', name: domain, value: v4 }] : []), ...(v6 ? [{ type: 'AAAA', name: domain, value: v6 }] : [])];
  const pointsHere = [...answers.A, ...answers.AAAA].length > 0 && [...answers.A, ...answers.AAAA].every(value => ips.includes(value) || reported.includes(value));
  return { records, answers, pointsHere };
}
// A free 127.0.0.1 port: not listening on the server (launch-facts usedPorts) and not reserved by another live launch.
export function chooseLoopbackPort(serverId, used = [], random = Math.random) {
  const taken = new Set([...used.filter(Number.isInteger), ...db.prepare("SELECT loopback_port FROM site_launches WHERE server_id=? AND state NOT IN ('failed','cancelled','removed') AND loopback_port IS NOT NULL").all(serverId).map(row => row.loopback_port)]);
  const start = 20000 + Math.floor(random() * 10000);
  for (let offset = 0; offset < 10000; offset++) { const port = 20000 + ((start - 20000 + offset) % 10000); if (!taken.has(port)) return port; }
  throw httpError(409, 'NO_FREE_PORT', 'DockNest found no free local port on this server.');
}

// ---------- check ----------
async function readFacts(server, input, launchId) {
  const request = { operation: 'launch-facts', launchId, slug: input.slug, domain: input.domain, source: input.source, ...(input.webService ? { webService: input.webService } : {}), ...(input.repo ? { repo: repoRequest(input) } : {}), ...(input.composeText ? { composeText: input.composeText } : {}) };
  const deployKey = keyRequest(input, server.id);
  if (deployKey) request.deployKey = deployKey;
  try { return await helper(server, request); }
  catch (error) { throw httpError(409, 'SERVER_UNREACHABLE', error.message); }
}
function serverFor(serverId) {
  const server = serverRow(serverId);
  if (!server) throw httpError(404, 'NOT_FOUND', 'Server not found.');
  return server;
}
// POST /api/servers/:id/launch/check: read-only. For Git, only `git ls-remote` runs.
export async function checkLaunch(serverId, body) {
  const server = serverFor(serverId), input = launchInput(serverId, body);
  const facts = await readFacts(server, input, id());
  const checks = checksOf(facts, input.domain);
  if (db.prepare("SELECT 1 FROM site_launches WHERE server_id=? AND slug=? AND state NOT IN ('failed','cancelled','removed')").get(serverId, input.slug)) checks.push({ id: 'slug', ok: false, code: 'SLUG_EXISTS', text: `A launch for ${input.domain} already exists on ${server.name}.` });
  if (launchActive(serverId)) checks.push({ id: 'launch', ok: false, code: 'LAUNCH_RUNNING', text: `Another launch is running on ${server.name}. Wait for it to finish.` });
  const gate = gateOf(facts);
  const shown = (refused(facts) ? [{ id: 'server', ok: false, code: cleanCode(facts.code), text: refusalText(facts, input.domain) }, ...checks] : checks)
    .map(item => ({ ...item, title: CHECK_TITLES[item.id] ?? item.id, status: item.ok ? 'ok' : 'block', value: item.text }));
  const services = servicesOf(facts);
  return {
    blockers: shown.filter(item => !item.ok).map(item => item.text), warnings: [], builds: services.some(service => service.build),
    ok: !refused(facts) && checks.every(item => item.ok) && gate.ok, slug: input.slug, folder: `${SITE_ROOT}/${input.slug}`, domain: input.domain, www: `www.${input.domain}`,
    checks: shown, gate, services, composeName: typeof facts?.composeName === 'string' ? facts.composeName.slice(0, 63) : null,
    refHead: typeof facts?.refHead === 'string' && /^[0-9a-f]{40,64}$/.test(facts.refHead) ? facts.refHead : null,
    dns: dnsView(facts, input.domain, server.host), testServers: testServerChoices(serverId),
  };
}
const CHECK_TITLES = { port80: 'Port 80', port443: 'Port 443', server: 'Server', docker: 'Docker', compose: 'Docker Compose', git: 'Git', nginx: 'nginx', certbot: 'certbot', buildx: 'Builds', space: 'Free space', ports: 'Ports 80 and 443', dns: 'DNS', domain: 'Domain', certificate: 'Certificate', repository: 'Repository', slug: 'Site folder', launch: 'Another launch' };
function gateOf(answer) {
  const gate = answer?.gate;
  if (!gate || typeof gate !== 'object') return { ok: true, refusals: [] };
  const refusals = (Array.isArray(gate.refusals) ? gate.refusals : []).slice(0, 30).map(item => ({ code: cleanCode(item?.code), service: typeof item?.service === 'string' ? item.service.slice(0, 63) : null, field: typeof item?.field === 'string' ? item.field.slice(0, 80) : null }));
  return { ok: gate.ok === true && !refusals.length, refusals };
}
const testServerChoices = serverId => db.prepare('SELECT id,name FROM servers WHERE id<>? ORDER BY name').all(serverId).map(row => ({ id: row.id, name: row.name }));

// ---------- start ----------
const backupTime = text => { const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(text ?? '')); return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null; };
// POST /api/servers/:id/launch. The check is run again here (the browser is never trusted).
export async function startLaunch(serverId, body, actor) {
  const server = serverFor(serverId), input = launchInput(serverId, body);
  if (!input.webPort) throw new LaunchInputError('INVALID_PORT', 'Enter the container port that serves the website.', 'webPort');
  if (body.cleanShutdownConfirmed !== true) throw new LaunchInputError('SHUTDOWN_CONFIRM_REQUIRED', 'Confirm that the app saves its data when its containers stop, so backups are consistent.', 'cleanShutdownConfirmed');
  if (input.source === 'git' && body.trustConfirmed !== true) throw httpError(400, 'TRUST_REQUIRED', `Confirm that you trust this repository: it builds and runs its code on ${server.name}.`);
  if (body.backupTime !== undefined && !backupTime(body.backupTime)) throw new LaunchInputError('INVALID_TIME', 'Enter the backup time as HH:MM.', 'backupTime');
  if (body.testServerId !== undefined && body.testServerId !== null && (body.testServerId === serverId || !serverRow(body.testServerId))) throw new LaunchInputError('INVALID_TEST_SERVER', 'Choose another connected server for restore tests.', 'testServerId');
  if (deploymentHeld(db)) throw httpError(409, 'SERVER_BUSY', 'DockNest is being updated. Launch when the update has finished.');
  const refuseBusy = () => {
    if (launchActive(serverId)) throw httpError(409, 'LAUNCH_RUNNING', `Another launch is running on ${server.name}. Wait for it to finish.`);
    if (moveActive(serverId) || installActive(serverId) || cleanupHeld(serverId)) throw httpError(409, 'SERVER_BUSY', `${server.name} is busy with a move, an install or a cleanup. Launch when it has finished.`);
    if (db.prepare("SELECT 1 FROM site_launches WHERE server_id=? AND slug=? AND state NOT IN ('failed','cancelled','removed')").get(serverId, input.slug)) throw httpError(409, 'SLUG_EXISTS', `A launch for ${input.domain} already exists on ${server.name}.`);
    if (db.prepare('SELECT COUNT(*) AS n FROM site_launches WHERE server_id=? AND created_at>?').get(serverId, iso(launchTransport.now() - RATE.windowMs)).n >= RATE.perServer) throw httpError(429, 'RATE_LIMITED', `At most ${RATE.perServer} launches per server per hour. Try again later.`);
  };
  refuseBusy();
  const launchId = id(), facts = await readFacts(server, input, launchId);
  const gate = gateOf(facts);
  if (refused(facts) && gate.ok) throw httpError(409, cleanCode(facts.code), refusalText(facts, input.domain));
  if (!input.webService && servicesOf(facts).length > 1) throw new LaunchInputError('INVALID_SERVICE', 'Choose the service that serves the website.', 'webService');
  if (!gate.ok) throw httpError(422, gate.refusals[0]?.code ?? 'GATE_REFUSED', 'The Compose file asks for something DockNest does not allow.', { refusals: gate.refusals });
  const failing = checksOf(facts, input.domain).filter(item => !item.ok);
  if (failing.length) throw httpError(409, failing[0].code ?? 'CHECK_FAILED', failing[0].text, { checks: failing });
  const loopback = chooseLoopbackPort(serverId, Array.isArray(facts?.usedPorts) ? facts.usedPorts : []);
  const at = now(), options = { allowPrivate: input.allowPrivate, testServerId: body.testServerId ?? null, backupTime: body.backupTime ?? null, envKeys: Object.keys(input.env), dns: dnsView(facts, input.domain, server.host).records };
  // The sealed job payload: only what the fetch step needs and nothing that is stored elsewhere.
  const payload = seal(JSON.stringify({ ...(input.composeText ? { composeText: input.composeText } : {}), env: input.env }));
  try {
    transaction(() => {
      refuseBusy();
      db.prepare("INSERT INTO site_launches(id,server_id,slug,source,repo_url,ref,compose_path,deploy_key_id,domain,web_service,web_port,loopback_port,state,options,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?)")
        .run(launchId, serverId, input.slug, input.source, input.repo?.url ?? null, input.repo?.ref ?? null, input.repo?.composePath ?? null, input.deployKeyId ?? null, input.domain, input.webService, input.webPort, loopback, JSON.stringify(options), actor, at, at);
      const insert = db.prepare('INSERT INTO site_launch_steps(launch_id,step,state,payload) VALUES(?,?,?,?)');
      for (const step of LAUNCH_STEPS) insert.run(launchId, step, step === 'check' ? 'launch_queued' : 'pending', step === 'fetch' ? payload : null);
      audit(actor, 'launch.requested', launchId, { server: serverId, source: input.source, domain: input.domain, envKeys: options.envKeys.length, deployKey: input.deployKeyId ?? null });
    });
  } catch (error) {
    if (/UNIQUE constraint failed: site_launches\.server_id, site_launches\.slug/.test(error.message)) throw httpError(409, 'SLUG_EXISTS', `A launch for ${input.domain} already exists on ${server.name}.`);
    if (/UNIQUE constraint failed: site_launches\.server_id/.test(error.message)) throw httpError(409, 'LAUNCH_RUNNING', `Another launch is running on ${server.name}. Wait for it to finish.`);
    throw error;
  }
  return { launch: { id: launchId } };
}

// ---------- owner actions ----------
function launchFor(launchId) {
  const launch = loadLaunch(launchId);
  if (!launch) throw httpError(404, 'NOT_FOUND', 'Launch not found.');
  return launch;
}
export function cancelLaunch(launchId, actor) {
  transaction(() => {
    const launch = launchFor(launchId), steps = loadSteps(launchId);
    if (!cancelable(launch, steps)) throw httpError(409, 'CANCEL_NOT_ALLOWED', 'The site has started, so the launch can no longer be cancelled. Use Remove launch after it finishes.');
    // Not claimed yet: withdraw the first step and end at once.
    if (launch.state === 'queued' && setStep(launchId, 'check', { state: 'skipped', finished_at: now() }, 'launch_queued')) {
      db.prepare("UPDATE site_launch_steps SET payload=NULL WHERE launch_id=? AND step='fetch'").run(launchId);
      setLaunch(launchId, { state: 'cancelled', cancel_requested: true, finished_at: now() });
    } else {
      // Queued steps before start that no worker has claimed yet are withdrawn, so the site never starts.
      for (const name of ['check', 'fetch', 'build', 'start']) setStep(launchId, name, { state: 'pending' }, 'launch_queued');
      setLaunch(launchId, { cancel_requested: true });
    }
    audit(actor, 'launch.cancel', launchId, { server: launch.server_id });
  });
  safeAdvance(launchId);
  return launchView(launchId);
}
// POST /api/launches/:id/check-dns: runs the certificate step again ("Check again", also "Try again" after a failure).
export function checkDnsAgain(launchId, actor) {
  transaction(() => {
    const launch = launchFor(launchId), steps = loadSteps(launchId), certificate = steps.find(step => step.step === 'certificate');
    if (!['waiting_dns', 'done'].includes(launch.state) || !['waiting', 'failed'].includes(certificate?.state) || launch.options.removing) throw httpError(409, 'NOT_WAITING', 'This launch is not waiting for DNS or a certificate.');
    setStep(launchId, 'certificate', { state: 'launch_queued', detail: null });
    audit(actor, 'launch.check_dns', launchId, { server: launch.server_id });
  });
  return launchView(launchId);
}
// POST /api/launches/:id/remove: within 24 hours. Tears down what the launch made, archives the site, keeps backups.
export function removeLaunch(launchId, actor) {
  transaction(() => {
    const launch = launchFor(launchId), steps = loadSteps(launchId);
    if (!['done', 'waiting_dns'].includes(launch.state) || launch.options.removing || busyStep(steps)) throw httpError(409, 'REMOVE_NOT_ALLOWED', 'This launch cannot be removed now.');
    if (!launch.remove_until || Date.parse(launch.remove_until) <= launchTransport.now()) throw httpError(409, 'REMOVE_EXPIRED', 'Remove launch was offered for 24 hours after the launch. Remove the site from its settings instead.');
    const site = launch.site_id ? db.prepare('SELECT id,server_id FROM sites WHERE id=?').get(launch.site_id) : null;
    if (!site || db.prepare('SELECT 1 FROM site_archives WHERE site_id=?').get(site.id)) throw httpError(409, 'REMOVE_NOT_ALLOWED', 'The site of this launch was already removed.');
    if (site.server_id !== launch.server_id || db.prepare("SELECT 1 FROM site_moves WHERE site_id=? AND state NOT IN ('draft','rolled_back','cancelled','failed','switched_back','cleaned')").get(site.id) || movingSite(site.id)) throw httpError(409, 'SITE_MOVED', 'The site has been moved or is being moved, so Remove launch no longer applies. Remove the site from its settings instead.');
    if (db.prepare("SELECT 1 FROM jobs WHERE site_id=? AND status IN ('queued','running','recovery_required','move_queued','move_running','test_queued','test_running','edit_queued','edit_running','edit_waiting','heal_queued','heal_running')").get(site.id)) throw httpError(409, 'SITE_BUSY', 'The site has a job running. Remove the launch when it has finished.');
    if (db.prepare('SELECT 1 FROM site_edits WHERE site_id=? AND result IS NULL').get(site.id)) throw httpError(409, 'SITE_BUSY', 'A Safe Edit of the site has not finished. Remove the launch when it has.');
    // Schedules go off now, so no backup or restore test of the site starts while it is torn down.
    db.prepare('UPDATE policies SET enabled=0,next_run=NULL WHERE site_id=?').run(site.id);
    db.prepare('UPDATE restore_test_settings SET enabled=0,next_due_at=NULL WHERE site_id=?').run(site.id);
    // Self-heal must not restart a container while the site is torn down.
    db.prepare('UPDATE self_heal_settings SET enabled=0 WHERE site_id=?').run(site.id);
    setLaunch(launchId, { options: { ...launch.options, removing: true } });
    setStep(launchId, 'teardown', { state: 'launch_queued', detail: null, result: {} });
    audit(actor, 'launch.remove', launchId, { server: launch.server_id, site: launch.site_id });
  });
  return launchView(launchId);
}
// POST /api/launches/:id/retry: Try again after a teardown that did not finish.
export function retryLaunch(launchId, actor) {
  transaction(() => {
    const launch = launchFor(launchId);
    if (launch.state !== 'needs_attention') throw httpError(409, 'NOT_NEEDED', 'This launch does not need you.');
    setStep(launchId, 'teardown', { state: 'launch_queued', detail: null });
    audit(actor, 'launch.retry', launchId, { server: launch.server_id });
  });
  return launchView(launchId);
}

// ---------- views ----------
function statusLine(launch, steps, serverName) {
  const running = steps.find(step => step.state === 'launch_running' || step.state === 'launch_queued');
  switch (launch.state) {
    case 'queued': return `Waiting to start on ${serverName}.`;
    case 'running':
      if (launch.options.removing) return `Removing what the launch made on ${serverName}.`;
      if (running?.step === 'teardown') return `Something went wrong, so DockNest is removing what the launch made. ${launch.reason ?? ''}`.trim();
      return running ? `${LABELS[running.step]}: working on ${serverName}.` : `Launching ${launch.domain} on ${serverName}.`;
    case 'waiting_dns': return `${launch.domain} works on HTTP. Add the DNS record, then press Check again for the certificate.`;
    case 'done': return launch.options.removing ? `Removing what the launch made on ${serverName}.` : `${launch.domain} is live and backed up.`;
    case 'failed': return `The launch stopped and ${serverName} is as it was. ${launch.reason ?? ''}`.trim();
    case 'cancelled': return `Cancelled. ${serverName} is as it was.`;
    case 'removed': return `Removed. The site is archived; its backups are kept.`;
    case 'needs_attention': return `DockNest could not remove everything the launch made on ${serverName}. Check the server, then press Try again.`;
    default: return '';
  }
}
const PUBLIC_RESULT = ['services', 'commit', 'state', 'certName', 'left', 'removed'];
export function launchView(launchId) {
  const launch = launchFor(launchId), steps = loadSteps(launchId), server = serverRow(launch.server_id), at = launchTransport.now();
  const certificate = steps.find(step => step.step === 'certificate');
  return {
    id: launch.id, serverId: launch.server_id, serverName: server?.name ?? null, siteId: launch.site_id, slug: launch.slug, folder: `${SITE_ROOT}/${launch.slug}`,
    domain: launch.domain, source: launch.source, repo: launch.source === 'git' ? { url: launch.repo_url, ref: launch.ref, composePath: launch.compose_path, commit: launch.commit_sha } : null,
    deployKeyId: launch.deploy_key_id, webService: launch.web_service, webPort: launch.web_port, loopbackPort: launch.loopback_port,
    state: launch.state, failedStep: launch.failed_step, reason: launch.reason, removing: !!launch.options.removing, cancelRequested: launch.cancel_requested,
    envKeys: launch.options.envKeys ?? [],
    // The UI shows one record ({type,name,value}); `records` also lists AAAA when the server has IPv6.
    dns: (records => (records.length ? { ...records[0], records } : null))(launch.options.dns ?? []),
    progress: Math.round(steps.filter(step => STEP_ORDER.includes(step.step) && ['done', 'skipped'].includes(step.state)).length / STEP_ORDER.length * 100),
    statusLine: statusLine(launch, steps, server?.name ?? 'the server'),
    certificate: certificate ? { state: certificate.state === 'done' ? 'issued' : certificate.state === 'waiting' ? 'waiting_dns' : certificate.state === 'failed' ? 'failed' : ['launch_queued', 'launch_running'].includes(certificate.state) ? 'running' : 'pending', reason: certificate.state === 'failed' || certificate.state === 'waiting' ? certificate.detail : null } : null,
    backups: launch.site_id ? (policy => ({ firstBackup: steps.find(step => step.step === 'first_backup')?.state ?? null, schedule: policy?.schedule ?? null, timezone: policy?.timezone ?? null, nextRun: policy?.next_run ?? null }))(db.prepare('SELECT schedule,timezone,next_run FROM policies WHERE site_id=?').get(launch.site_id)) : null,
    restoreTests: launch.site_id ? (row => row ? { enabled: row.enabled === 1, serverId: row.server_id, reason: row.skip_reason } : null)(db.prepare('SELECT enabled,server_id,skip_reason FROM restore_test_settings WHERE site_id=?').get(launch.site_id)) : null,
    steps: steps.map(step => ({ step: step.step, label: LABELS[step.step], state: step.state === 'launch_queued' ? 'queued' : step.state === 'launch_running' ? 'running' : step.state, startedAt: step.started_at, finishedAt: step.finished_at, detail: step.detail, result: Object.fromEntries(Object.entries(step.result).filter(([key]) => PUBLIC_RESULT.includes(key))) })),
    actions: {
      cancel: cancelable(launch, steps),
      checkDns: ['waiting_dns', 'done'].includes(launch.state) && ['waiting', 'failed'].includes(certificate?.state) && !launch.options.removing,
      remove: ['waiting_dns', 'done'].includes(launch.state) && !launch.options.removing && !!launch.remove_until && Date.parse(launch.remove_until) > at && !busyStep(steps),
      retry: launch.state === 'needs_attention' && !busyStep(steps),
    },
    removeUntil: launch.remove_until, createdAt: launch.created_at, startedAt: launch.started_at, finishedAt: launch.finished_at,
  };
}
// The launch of a site, for /api/state (Remove launch on the site page): only while it is live or waiting for DNS.
export function launchOfSite(siteId) {
  const row = db.prepare("SELECT id,finished_at,started_at,remove_until FROM site_launches WHERE site_id=? AND state IN ('running','waiting_dns','done') ORDER BY created_at DESC LIMIT 1").get(siteId);
  return row ? { id: row.id, launchedAt: row.finished_at ?? row.started_at, removeUntil: row.remove_until } : null;
}
export const listLaunches = serverId => db.prepare(`SELECT id FROM site_launches WHERE ${serverId ? 'server_id=? AND ' : ''}(state IN ('queued','running','waiting_dns','needs_attention') OR (state='done' AND remove_until>?)) ORDER BY created_at DESC LIMIT 50`).all(...(serverId ? [serverId, now()] : [now()])).map(row => launchView(row.id));

// ---------- the tick ----------
export function tickLaunches() {
  for (const { id: launchId } of db.prepare(`SELECT id FROM site_launches WHERE state IN (${OPEN_STATES.map(state => `'${state}'`).join(',')}) ORDER BY created_at,id`).all()) {
    try { advanceLaunch(launchId); } catch (error) { console.error(`Launch ${launchId} could not advance: ${error.code ?? error.name}`); }
  }
}
// For callers that must not fail after their own work is done (a worker job, an owner action): the next tick retries.
function safeAdvance(launchId) {
  try { advanceLaunch(launchId); } catch (error) { console.error(`Launch ${launchId} could not advance: ${error.code ?? error.name}`); }
}
export function advanceLaunch(launchId) {
  for (let guard = 0; guard < 12; guard++) {
    const launch = loadLaunch(launchId);
    if (!launch || !OPEN_STATES.includes(launch.state)) return;
    const steps = loadSteps(launchId), action = nextAction(launch, steps, launchTransport.now());
    switch (action.type) {
      case 'none': case 'wait': return;
      case 'cancel':
        transaction(() => {
          for (const step of steps.filter(item => item.state === 'pending')) setStep(launchId, step.step, { state: 'skipped', finished_at: now() }, 'pending');
          db.prepare("UPDATE site_launch_steps SET payload=NULL WHERE launch_id=? AND step='fetch'").run(launchId);
          setLaunch(launchId, { state: 'cancelled', finished_at: now() });
        });
        audit('worker', 'launch.cancelled', launchId, { server: launch.server_id });
        return;
      case 'queue':
        setStep(launchId, action.step, { state: 'launch_queued' });
        return;
      case 'recover':
        setStep(launchId, action.step, { state: 'launch_queued', result: { ...steps.find(step => step.step === action.step).result, recover: 1 } }, 'failed');
        return;
      case 'fail':
        transaction(() => { setStep(launchId, action.step, { state: 'failed', finished_at: now(), detail: plainReason(action.reason) }); recordFailure(launch, action.step, action.reason); });
        continue;
      case 'teardown': {
        const failed = action.step && steps.find(step => step.step === action.step);
        transaction(() => {
          if (failed) recordFailure(launch, action.step, failed.detail ?? 'The step failed.');
          db.prepare("UPDATE site_launch_steps SET payload=NULL WHERE launch_id=? AND step='fetch'").run(launchId);
          for (const step of steps.filter(item => item.state === 'pending' && item.step !== 'teardown')) setStep(launchId, step.step, { state: 'skipped', finished_at: now() }, 'pending');
          setStep(launchId, 'teardown', { state: 'launch_queued' }, 'pending');
        });
        return;
      }
      case 'abort': {
        const failed = steps.find(step => step.step === action.step);
        transaction(() => {
          recordFailure(launch, action.step, failed?.detail ?? 'The check failed.');
          db.prepare("UPDATE site_launch_steps SET payload=NULL WHERE launch_id=? AND step='fetch'").run(launchId);
          for (const step of steps.filter(item => item.state === 'pending')) setStep(launchId, step.step, { state: 'skipped', finished_at: now() }, 'pending');
        });
        finish(loadLaunch(launchId), 'failed');
        return;
      }
      case 'save':
        try { saveSite(launch, steps); }
        catch (error) {
          console.error(`Launch ${launchId} could not save its site: ${error.code ?? error.name}`);
          setStep(launchId, 'save', { state: 'failed', finished_at: now(), attempt: 1, detail: 'DockNest could not save the site record, so it removes what the launch made.' });
        }
        continue;
      case 'first_backup':
        if (!firstBackup(launch, steps, action.poll)) return;
        continue;
      case 'finish':
        finish(launch, action.to);
        return;
      default: return;
    }
  }
}
function finish(launch, to) {
  const at = now(), ended = ['failed', 'cancelled', 'removed'].includes(to);
  transaction(() => {
    if (to === 'removed' && launch.site_id) archiveSite(launch.site_id);
    setLaunch(launch.id, { state: to, ...(ended || ['done', 'waiting_dns'].includes(to) ? { finished_at: launch.finished_at ?? at } : {}), ...(['done', 'waiting_dns'].includes(to) && !launch.remove_until ? { remove_until: iso(launchTransport.now() + REMOVE_WINDOW_MS) } : {}) });
  });
  audit('worker', 'launch.' + to, launch.id, { server: launch.server_id, ...(launch.site_id ? { site: launch.site_id } : {}) });
}
// Remove launch: the site stays in DockNest as an archived site, so its backups stay listed and restorable.
function archiveSite(siteId) {
  db.prepare('INSERT OR IGNORE INTO site_archives(site_id,archived_at) VALUES (?,?)').run(siteId, now());
  db.prepare('UPDATE policies SET enabled=0,next_run=NULL WHERE site_id=?').run(siteId);
  db.prepare('UPDATE restore_test_settings SET enabled=0,next_due_at=NULL WHERE site_id=?').run(siteId);
}

// ---------- save and first backup (inside the tick) ----------
// A quiet daily time: the owner's choice, else the first free quarter hour from 02:00 to 05:45 among this server's sites.
function quietTime(serverId, chosen) {
  if (chosen) return chosen;
  const used = new Set(db.prepare('SELECT p.schedule FROM policies p JOIN sites s ON s.id=p.site_id WHERE s.server_id=? AND p.enabled=1').all(serverId).map(row => row.schedule));
  for (let slot = 0; slot < 16; slot++) { const hour = 2 + Math.floor(slot / 4), minute = (slot % 4) * 15; if (!used.has(`${minute} ${hour} * * *`)) return { hour, minute }; }
  return { hour: 3, minute: 0 };
}
const policyZone = serverId => db.prepare('SELECT p.timezone FROM policies p JOIN sites s ON s.id=p.site_id WHERE s.server_id=? ORDER BY s.created_at LIMIT 1').get(serverId)?.timezone ?? 'UTC';
// Certificate failures that happen after certbot found the domain pointing here (remote/helper/launch.py): only these
// mean http:// reaches this server. Refusals and a missing certbot say nothing about DNS.
export const AFTER_DNS_FAILURES = Object.freeze(['RATE_LIMITED', 'CAA_REFUSED', 'CERT_FAILED', 'NO_ACCOUNT_EMAIL']);
const certificateState = steps => {
  const step = steps.find(item => item.step === 'certificate');
  if (step?.state === 'done') return 'issued';
  return step?.state === 'failed' && AFTER_DNS_FAILURES.includes(step.result?.certCode) ? 'failed' : 'waiting';
};
// The site's URLs follow the certificate: https once issued, http after a failure (the domain points here). While DNS
// does not point here yet the health check uses the containers only (a URL that cannot reach this server would fail
// every backup's health check), and Check again switches it on.
export function siteUrls(domain, certificate) {
  if (certificate === 'issued') return { healthUrl: `https://${domain}/`, publicUrl: `https://${domain}` };
  if (certificate === 'failed') return { healthUrl: `http://${domain}/`, publicUrl: `http://${domain}` };
  return { healthUrl: '', publicUrl: `http://${domain}` };
}
function updateSiteUrls(siteId, domain, certificate) {
  const row = db.prepare('SELECT config FROM sites WHERE id=?').get(siteId);
  if (!row) return;
  const config = parseJson(row.config, null);
  if (!config) return;
  const urls = siteUrls(domain, certificate);
  db.prepare('UPDATE sites SET config=? WHERE id=?').run(JSON.stringify({ ...config, healthUrl: urls.healthUrl, maintenance: { ...(config.maintenance ?? {}), publicUrl: urls.publicUrl } }), siteId);
}
export function siteConfig(launch, steps, siteId) {
  const fetch = steps.find(step => step.step === 'fetch')?.result ?? {}, start = steps.find(step => step.step === 'start')?.result ?? {};
  const folder = `${SITE_ROOT}/${launch.slug}`;
  const services = fetch.services ?? [];
  const containers = (start.containerNames?.length ? start.containerNames : services.map(service => `${launch.slug}-${service.name}-1`)).filter(name => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)).slice(0, 30);
  // The helper answers the real Compose file and the override (both in the site folder); without them, the layout it uses.
  const composeFiles = (start.composeFiles?.length ? start.composeFiles : [`${folder}/app/${launch.compose_path ?? 'compose.yaml'}`]).filter(path => typeof path === 'string' && path.startsWith(folder + '/') && !path.split('/').includes('..')).slice(0, 20);
  const maintenanceRow = db.prepare("SELECT value FROM settings WHERE key='maintenance'").get();
  const stagingRoot = '/var/lib/docknest';
  return {
    // DockNest created the whole project, so nothing outside it writes its data and its references are known (confirmed
    // here and recorded in the launch.saved audit); the clean shutdown was confirmed by the owner at Launch.
    kind: 'docker', containers, stagingRoot, deliveryMode: 'staged', exclusiveSourcesConfirmed: true, stopTimeout: 60, shutdownProfile: 'generic', cleanShutdownConfirmed: true, unresolvedDependencies: [], services: [],
    configFiles: [`${folder}/.env`], mountExclusions: [], mountExclusionsConfirmed: false, restoreReferences: [], temporaryMemoryFolders: [], composeFiles,
    externalReferencesConfirmed: true, maintenanceRequired: true, domains: [launch.domain], ...siteUrls(launch.domain, certificateState(steps)),
    maintenance: { required: true, directory: `${stagingRoot}/maintenance/${siteId}`, publicUrl: siteUrls(launch.domain, certificateState(steps)).publicUrl, healthUrl: '', probeOrigin: true, readableFlag: false },
    maintenancePage: maintenanceRow ? normalizeMaintenance(JSON.parse(maintenanceRow.value)) : maintenanceDefaults,
    launch: { id: launch.id, folder },
  };
}
function saveSite(launch, steps) {
  const siteId = id(), at = now(), time = quietTime(launch.server_id, backupTime(launch.options.backupTime)), zone = policyZone(launch.server_id);
  const schedule = `${time.minute} ${time.hour} * * *`;
  const nextRun = CronExpressionParser.parse(schedule, { tz: zone, currentDate: new Date(launchTransport.now()) }).next().toISOString();
  transaction(() => {
    const config = siteConfig(launch, steps, siteId);
    db.prepare('INSERT INTO sites VALUES (?,?,?,?,?)').run(siteId, launch.server_id, launch.domain, JSON.stringify(config), at);
    db.prepare('INSERT INTO policies(site_id,enabled,schedule,timezone,retention,next_run) VALUES(?,1,?,?,7,?)').run(siteId, schedule, zone, nextRun);
    // Restore tests weekly on the chosen test server; with none, off with the reason the site page shows.
    const testServer = launch.options.testServerId && launch.options.testServerId !== launch.server_id ? serverRow(launch.options.testServerId) : null;
    const others = db.prepare('SELECT COUNT(*) AS n FROM servers WHERE id<>?').get(launch.server_id).n;
    const reason = testServer ? null : others ? 'Choose a test server to turn on restore tests.' : 'Add a test server to turn on restore tests.';
    db.prepare("INSERT INTO restore_test_settings(site_id,enabled,cadence,server_id,next_due_at,skip_reason,updated_at,updated_by) VALUES(?,?,'weekly',?,?,?,?,?)")
      .run(siteId, testServer ? 1 : 0, testServer?.id ?? null, testServer ? firstDueAt(siteId, 'weekly', launchTransport.now()) : null, reason, at, launch.created_by);
    db.prepare('UPDATE site_launches SET site_id=?,updated_at=? WHERE id=?').run(siteId, at, launch.id);
    setStep(launch.id, 'save', { state: 'done', started_at: at, finished_at: at, attempt: 1 });
    audit('worker', 'launch.saved', launch.id, { server: launch.server_id, site: siteId, schedule, restoreTests: !!testServer, confirmed: ['exclusiveSources', 'externalReferences', 'cleanShutdown'] });
  });
}
// The first backup is a normal backup job, queued once the hold is released (save done). Returns true to advance again.
export const FIRST_BACKUP_TRIES = 200; // about 10 minutes of worker ticks
function firstBackup(launch, steps, poll) {
  const step = steps.find(item => item.step === 'first_backup');
  if (!poll) {
    if (deploymentHeld(db)) return false;
    let job;
    try { job = enqueueBackup(launch.site_id, 'launch:' + launch.id); }
    catch (error) {
      const tries = (step.result.tries ?? 0) + 1;
      // 409 (removed or moving site) and a missing site never change; other work on the site first is retried.
      if (error?.status === 409 || /not found/i.test(String(error?.message)) || tries >= FIRST_BACKUP_TRIES) {
        setStep(launch.id, 'first_backup', { state: 'failed', finished_at: now(), detail: 'The first backup could not be queued. The daily backup runs as scheduled; open the site to back it up now.', result: { ...step.result, tries } });
        return true;
      }
      setStep(launch.id, 'first_backup', { result: { ...step.result, tries } });
      return false;
    }
    setStep(launch.id, 'first_backup', { state: 'waiting', started_at: now(), attempt: step.attempt + 1, result: { jobId: job.id } });
    return false;
  }
  const job = db.prepare('SELECT status FROM jobs WHERE id=?').get(step.result.jobId);
  if (job && ['queued', 'running'].includes(job.status)) return false;
  const backup = job?.status === 'completed' ? db.prepare('SELECT id FROM backups WHERE job_id=? AND verified=1').get(step.result.jobId) : null;
  setStep(launch.id, 'first_backup', backup ? { state: 'done', finished_at: now(), result: { ...step.result, backupId: backup.id } } : { state: 'failed', finished_at: now(), detail: 'The first backup did not finish. The daily backup tries again; open the site to see why.' });
  return true;
}

// ---------- the worker job ----------
export async function executeLaunchStep(claimed) {
  const { launchId, step: name } = claimed;
  const launch = loadLaunch(launchId), steps = loadSteps(launchId), step = steps.find(item => item.step === name);
  const server = serverRow(launch?.server_id);
  let outcome;
  const controller = new AbortController(), limit = (STEP_LIMITS[name] ?? 300) * 1000 * launchLimits.scale;
  const timer = setTimeout(() => controller.abort(), limit);
  try {
    if (!launch || !server) throw new Error('The launch or its server is gone.');
    if (step.result.recover) outcome = await recover(launch, steps, step, server, controller.signal);
    else outcome = await RUN[name](launch, steps, server, controller.signal);
  } catch (error) {
    outcome = { state: 'failed', detail: error?.stopped ? `${LABELS[name]} took longer than ${Math.max(1, Math.round(limit / 60000))} minutes, so DockNest stopped it.` : plainReason(error?.message) };
  } finally { clearTimeout(timer); }
  if (name === 'fetch') db.prepare("UPDATE site_launch_steps SET payload=NULL WHERE launch_id=? AND step='fetch'").run(launchId); // wiped after deploy, whatever happened
  const fields = { state: outcome.state, finished_at: ['done', 'failed', 'skipped'].includes(outcome.state) ? now() : null, detail: outcome.detail ? plainReason(outcome.detail) : null, result: journalResult({ ...step.result, recover: undefined }, outcome.result ?? {}) };
  if (outcome.nextAt) fields.next_at = outcome.nextAt;
  transaction(() => {
    if (!setStep(launchId, name, fields, 'launch_running')) return;
    if (outcome.launch) setLaunch(launchId, outcome.launch);
    for (const skip of outcome.skip ?? []) setStep(launchId, skip, { state: 'skipped', finished_at: now() }, 'pending');
    for (const again of outcome.requeue ?? []) setStep(launchId, again, { state: 'launch_queued', detail: null }, 'done');
  });
  audit('worker', `launch.step.${name}.${outcome.state}`, launchId, { server: launch?.server_id });
  // Try again on a launch that needs you, failing again: alert again (detection reads this audit row).
  if (name === 'teardown' && outcome.state === 'failed' && launch?.state === 'needs_attention') audit('worker', 'launch.needs_attention', launchId, { server: launch.server_id, again: true });
  safeAdvance(launchId);
}
export const launchLimits = { scale: 1 };
// The maintenance page setup of 2.13 (src/engine.js setupMaintenance: deploy, nginx integration, test, rollback); tests replace it.
export const launchMaintenance = { setup: (siteId, actor) => setupMaintenance(siteId, actor) };
const base = (launch, operation) => ({ operation, launchId: launch.id, slug: launch.slug, domain: launch.domain, source: launch.source });
const launchRepo = launch => (launch.source === 'git' ? { url: launch.repo_url, ref: launch.ref, composePath: launch.compose_path, allowPrivate: !!launch.options.allowPrivate } : undefined);
const launchKey = launch => (launch.deploy_key_id ? (({ privateKey, hostKeyLine }) => ({ privateKey, hostKeyLine }))(deployKeyForLaunch(launch.deploy_key_id, launch.server_id)) : undefined);
const failedWith = (answer, launch) => ({ state: 'failed', detail: refusalText(answer, launch.domain) });

// The sealed job payload. A payload that cannot be opened gives one fixed sentence (never the parser's text).
function readPayload(step) {
  if (!step?.payload) return {};
  try { return JSON.parse(open(step.payload)); } catch { throw new Error('DockNest could not read the launch details. Start a new launch.'); }
}
const RUN = {
  async check(launch, steps, server, signal) {
    const fetch = steps.find(step => step.step === 'fetch'), payload = readPayload(fetch);
    const key = launch.source === 'git' && launch.deploy_key_id ? launchKey(launch) : undefined;
    const facts = await helper(server, { ...base(launch, 'launch-facts'), ...(launch.source === 'git' ? { repo: launchRepo(launch) } : { composeText: payload.composeText }), ...(key ? { deployKey: key } : {}) }, { signal });
    if (refused(facts)) return failedWith(facts, launch);
    const failing = checksOf(facts, launch.domain).filter(item => !item.ok);
    if (failing.length) return { state: 'failed', detail: failing[0].text };
    if (Array.isArray(facts?.usedPorts) && facts.usedPorts.includes(launch.loopback_port)) return { state: 'failed', detail: REFUSALS.PORT_IN_USE() };
    return { state: 'done', result: { checks: checksOf(facts, launch.domain).length } };
  },
  async fetch(launch, steps, server, signal) {
    const fetch = steps.find(step => step.step === 'fetch');
    if (!fetch.payload) return { state: 'failed', detail: 'The launch details were already removed. Start a new launch.' };
    const payload = readPayload(fetch);
    const answer = await helper(server, { ...base(launch, 'launch-fetch'), ...(launch.source === 'git' ? { repo: launchRepo(launch) } : { composeText: payload.composeText }), env: payload.env ?? {}, ...(launch.web_service ? { webService: launch.web_service } : {}), ...(launch.deploy_key_id ? { deployKey: launchKey(launch) } : {}) }, { signal });
    // Gate refusals come with ok:false (GATE_REFUSED): read them first so the owner sees which service and setting.
    const gate = gateOf(answer);
    if (refused(answer) && gate.ok) return failedWith(answer, launch);
    if (!gate.ok) return { state: 'failed', detail: `The Compose file asks for something DockNest does not allow (${gate.refusals.map(item => [item.service, item.code].filter(Boolean).join(': ')).slice(0, 3).join(', ') || 'gate'}).`, result: { gate: gate.refusals } };
    const services = servicesOf(answer);
    if (!services.length) return { state: 'failed', detail: 'The Compose file has no services.' };
    if (launch.web_service && !services.some(service => service.name === launch.web_service)) return { state: 'failed', detail: `The Compose file has no service named ${launch.web_service}.`, result: { services } };
    const commit = typeof answer.commit === 'string' && /^[0-9a-f]{40,64}$/.test(answer.commit) ? answer.commit : null;
    return { state: 'done', result: { services, ...(commit ? { commit } : {}) }, launch: { ...(commit ? { commit_sha: commit } : {}), ...(!launch.web_service && services.length === 1 ? { web_service: services[0].name } : {}) }, skip: services.some(service => service.build) ? [] : ['build'] };
  },
  async build(launch, _steps, server, signal) {
    const answer = await helper(server, base(launch, 'launch-build'), { signal });
    if (refused(answer)) return failedWith(answer, launch);
    return { state: 'done', result: { images: (Array.isArray(answer?.images) ? answer.images : []).length } };
  },
  async start(launch, _steps, server, signal) {
    if (!launch.web_service || !launch.web_port) return { state: 'failed', detail: 'Choose the service and container port that serve the website.' };
    const answer = await helper(server, { ...base(launch, 'launch-start'), webService: launch.web_service, webPort: launch.web_port, loopbackPort: launch.loopback_port }, { signal });
    if (refused(answer)) return failedWith(answer, launch);
    const names = (Array.isArray(answer?.containerNames) ? answer.containerNames : []).filter(name => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)).slice(0, 30);
    const files = (Array.isArray(answer?.composeFiles) ? answer.composeFiles : []).filter(path => typeof path === 'string' && path.length < 512).slice(0, 20);
    return { state: 'done', result: { containerCount: (answer?.containers ?? []).length, ...(names.length ? { containerNames: names } : {}), ...(files.length ? { composeFiles: files } : {}) } };
  },
  async check_health(launch, steps, server, signal) {
    const step = steps.find(item => item.step === 'check_health');
    const deadline = step.result.deadline ?? iso(launchTransport.now() + HEALTH.limitSeconds * 1000 * launchLimits.scale);
    const answer = await helper(server, { ...base(launch, 'launch-poll'), loopbackPort: launch.loopback_port }, { signal });
    if (refused(answer) || answer?.state === 'failed') return { state: 'failed', detail: answer?.state === 'failed' ? pollText(answer, 'The site did not start.') : refusalText(answer, launch.domain), result: { deadline } };
    if (answer?.state === 'passed') return { state: 'done', result: { deadline } };
    return { state: 'waiting', detail: pollText(answer, 'Waiting for the site to answer.'), result: { deadline }, nextAt: iso(launchTransport.now() + HEALTH.pollSeconds * 1000 * launchLimits.scale) };
  },
  async web(launch, _steps, server, signal) {
    const answer = await helper(server, { ...base(launch, 'launch-web'), loopbackPort: launch.loopback_port }, { signal });
    if (refused(answer)) return failedWith(answer, launch);
    return { state: 'done', result: { file: typeof answer?.file === 'string' ? answer.file.slice(0, 200) : null } };
  },
  // Never fatal: dns_waiting -> waiting (Check again), failed -> failed with the reason (Try again); the site stays on HTTP.
  async certificate(launch, steps, server, signal) {
    // On a saved site whose maintenance page is set up, issuing the certificate rewrites the launch's nginx file: the
    // helper clears <maintenanceDirectory>/ready and the maintenance step runs again, so its include is never lost.
    const maintenance = steps.find(step => step.step === 'maintenance');
    // Only the default folder (remote/helper/launch.py accepts exactly /var/lib/docknest/maintenance/<uuid>); a site whose
    // owner changed its staging root keeps its own setup and the field is left out.
    const expected = launch.site_id ? `/var/lib/docknest/maintenance/${launch.site_id}` : null;
    const siteMaintenance = launch.site_id ? parseJson(db.prepare('SELECT config FROM sites WHERE id=?').get(launch.site_id)?.config, {})?.maintenance : null;
    const maintenanceDirectory = expected && maintenance?.state === 'done' && siteMaintenance?.directory === expected ? expected : null;
    const answer = await helper(server, { ...base(launch, 'launch-certificate'), serverIps: (launch.options.dns ?? []).map(record => record.value), ...(maintenanceDirectory ? { maintenanceDirectory } : {}) }, { signal });
    const certName = typeof answer?.certName === 'string' ? answer.certName.slice(0, 80) : null;
    const settled = ['waiting_dns', 'done'].includes(launch.state);
    if (answer?.state === 'issued') { if (launch.site_id) updateSiteUrls(launch.site_id, launch.domain, 'issued'); return { state: 'done', result: { state: 'issued', certName, certCode: null }, ...(settled ? { launch: { state: 'done' } } : {}), ...(maintenanceDirectory && answer.maintenanceReset === true ? { requeue: ['maintenance'] } : {}) }; }
    if (answer?.state === 'dns_waiting') return { state: 'waiting', detail: `${launch.domain} does not point to this server yet. Add the DNS record, then press Check again.`, result: { state: 'dns_waiting' }, ...(settled ? { launch: { state: 'waiting_dns' } } : {}) };
    const certCode = typeof answer?.code === 'string' ? cleanCode(answer.code) : null;
    if (launch.site_id && AFTER_DNS_FAILURES.includes(certCode)) updateSiteUrls(launch.site_id, launch.domain, 'failed');
    return { state: 'failed', detail: refused(answer) ? refusalText(answer, launch.domain) : plainReason(answer?.reason, 'The certificate could not be issued.') + ' The site works on HTTP; press Try again later.', result: { state: 'failed', certCode } };
  },
  // The 2.13 setup has no stop signal of its own; DockNest stops waiting at the step limit (the helper's own test and
  // rollback still finish on the server) and the step fails without a teardown.
  async maintenance(launch, _steps, _server, signal) {
    const stopped = new Promise((_resolve, reject) => { if (signal?.aborted) reject(Object.assign(new Error('stopped'), { stopped: true })); signal?.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { stopped: true })), { once: true }); });
    try { await Promise.race([launchMaintenance.setup(launch.site_id, 'launch:' + launch.id), stopped]); return { state: 'done' }; }
    catch (error) { return { state: 'failed', detail: error?.stopped ? 'Setting up the maintenance page took too long. The site works; set it up from the site page.' : 'The maintenance page could not be set up automatically. The site works; set it up from the site page.' }; }
  },
  async teardown(launch, _steps, server, signal) {
    const answer = await helper(server, { ...base(launch, 'launch-teardown'), keepBackup: true }, { signal });
    if (refused(answer)) return failedWith(answer, launch);
    const left = (Array.isArray(answer?.left) ? answer.left : []).length, removed = (Array.isArray(answer?.removed) ? answer.removed : []).length;
    if (left) return { state: 'failed', detail: `DockNest could not remove ${left} thing${left === 1 ? '' : 's'} the launch made. Check ${server.name}, then press Try again.`, result: { removed, left } };
    return { state: 'done', result: { removed, left } };
  },
};

// A step a stopped worker left behind (docs/launch-site.md, "Worker restart"): launch-status says whether the journal
// is consistent for this step to run again (resumable) or what is left must be torn down.
async function recover(launch, steps, step, server, signal) {
  let status;
  try { status = await helper(server, base(launch, 'launch-status'), { signal }); }
  catch (error) { return { state: 'failed', detail: `DockNest stopped while ${LABELS[step.step].toLowerCase()} ran and could not check the server: ${error.message}`, result: { recovered: 1 } }; }
  // A step runs again only when the server's journal says so: remote/helper/launch.py launch-status answers `resumable`
  // as the list of steps that can continue from its journal (or false). Anything else is torn down.
  const resumable = status?.busy !== true && Array.isArray(status?.resumable) && status.resumable.includes(step.step);
  if (resumable) {
    const outcome = await RUN[step.step](launch, steps, server, signal);
    return { ...outcome, result: { ...(outcome.result ?? {}), recovered: 1 } };
  }
  // Certificate and maintenance never tear the site down: they fail with their own next step for the owner.
  if (step.step === 'certificate') return { state: 'failed', detail: 'DockNest stopped while the certificate was being issued. The site works on HTTP; press Try again.', result: { recovered: 1 } };
  if (step.step === 'maintenance') return { state: 'failed', detail: 'DockNest stopped while the maintenance page was being set up. The site works; set it up from the site page.', result: { recovered: 1 } };
  return { state: 'failed', detail: `DockNest stopped while ${LABELS[step.step].toLowerCase()} ran, so it removes what the launch made.`, result: { recovered: 1 } };
}
