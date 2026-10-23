// Site move engine (docs/moving-sites.md): preview, start, cancel and the worker that drives each move step by step.
// The pure rules live in state.js (transitions, journal, rollback, crash recovery) and preflight.js (checks). This
// module persists them in site_moves/site_move_steps and carries out each step:
// - DB-only steps (backup, final_sync, the manual switch) run inside tickMoves(); a step that waits for a backup holds
//   no job, so it never blocks other servers.
// - Steps that touch a server run as one short `site-move` job each. claimJob treats both servers of the move as busy.
// - Nothing on the source changes before final_sync. A move never deletes a backup or data it did not create.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { db, id, audit, transaction } from '../db.js';
import { deploymentHeld } from '../deployment-hold.js';
import { storageCapacity } from '../storage.js';
import { transport, siteInfo, enqueueBackup, uploadBackupTo, maintenanceHtml, jobRunners } from '../engine.js';
import { evaluateMove, preflightHash, describeDuration } from './preflight.js';
import { initialSteps, planSteps, stepDefinition, nextAction, beginStep, completeStep, failStep, skipStep, undoneStep, undoFailedStep, applyTransition, answerGate, cancelDecision, recoverStep, isTerminal, MoveStateError } from './state.js';
import { checkDns, currentRecords, cloudflare, ipv4 } from './dns.js';

export const RETENTION_DAYS = 7;
export const DRAFT_TTL_MS = 60 * 60 * 1000;
export const FRESH_BACKUP_MS = 10 * 60 * 1000;
const now = () => new Date().toISOString();
const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const tableReady = () => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='site_moves'").get();

// ---------- persistence ----------
export function loadMove(moveId) {
  const row = db.prepare('SELECT * FROM site_moves WHERE id=?').get(moveId);
  return row ? { ...row, options: JSON.parse(row.options), preflight: JSON.parse(row.preflight), cancel_requested: !!row.cancel_requested } : null;
}
export function loadSteps(move) {
  const order = planSteps(move.options).map(step => step.name);
  return db.prepare('SELECT * FROM site_move_steps WHERE move_id=?').all(move.id)
    .map(row => ({ ...row, resources: JSON.parse(row.resources), result: JSON.parse(row.result) }))
    .sort((a, b) => order.indexOf(a.step) - order.indexOf(b.step));
}
function saveMove(move) {
  db.prepare('UPDATE site_moves SET state=?,waiting_for=?,cancel_requested=?,error=?,updated_at=?,switched_at=?,retain_until=?,finished_at=?,backup_id=?,final_backup_id=?,preflight=?,preflight_hash=? WHERE id=?')
    .run(move.state, move.waiting_for ?? null, move.cancel_requested ? 1 : 0, move.error ? String(move.error).slice(0, 2000) : null, move.updated_at ?? now(), move.switched_at ?? null, move.retain_until ?? null, move.finished_at ?? null, move.backup_id ?? null, move.final_backup_id ?? null, JSON.stringify(move.preflight), move.preflight_hash, move.id);
}
function saveStep(step) {
  db.prepare('UPDATE site_move_steps SET attempt=?,state=?,started_at=?,finished_at=?,resources=?,result=? WHERE move_id=? AND step=?')
    .run(step.attempt, step.state, step.started_at, step.finished_at, JSON.stringify(step.resources ?? {}), JSON.stringify(step.result ?? {}), step.move_id, step.step);
}
function transition(move, to, changes = {}) {
  const next = applyTransition(move, to, now(), changes);
  saveMove(next);
  if (['rolled_back', 'cancelled', 'failed', 'recovery_required'].includes(to)) audit('worker', 'move.' + to, move.id, { site: move.site_id });
  return next;
}

// ---------- SSH (tests replace members) ----------
export const moveTransport = { remote: (...args) => transport.remote(...args), upload: uploadBackupTo, wait: ms => new Promise(resolve => setTimeout(resolve, ms)) };
async function remote(server, request) {
  for (let attempt = 1; ; attempt++) {
    try { return await moveTransport.remote(server, request); }
    catch (error) { if (error.remoteReported || attempt >= 3) throw error; await moveTransport.wait(2000 * attempt); }
  }
}
const plain = error => String(error?.remoteReported || error?.status ? error.message : `The server connection failed (${error?.code || error?.name || 'error'}). DockNest tried 3 times.`).replace(/[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/gi, '').slice(0, 500);
const server = serverId => db.prepare('SELECT * FROM servers WHERE id=?').get(serverId);

// ---------- facts and preview ----------
const literal = host => (isIP(host) ? [host] : []);
async function resolved(host) { if (isIP(host)) return [host]; try { return (await lookup(host, { all: true })).map(entry => entry.address); } catch { return []; } }
function lastBackup(siteId) {
  const backup = db.prepare('SELECT b.id,b.size,b.captured_at,j.started_at,j.finished_at FROM backups b JOIN jobs j ON j.id=b.job_id WHERE b.site_id=? AND b.verified=1 ORDER BY b.captured_at DESC LIMIT 1').get(siteId);
  if (!backup) return null;
  const seconds = backup.started_at && backup.finished_at ? Math.max(1, (Date.parse(backup.finished_at) - Date.parse(backup.started_at)) / 1000) : undefined;
  return { ...backup, seconds };
}
function healthPath(cfg) { try { const url = new URL(cfg.healthUrl); return (url.pathname || '/') + url.search; } catch { return '/'; } }

// Collects facts from both servers (read-only) and evaluates them. Returns the owner-facing result and the private
// execution plan the worker needs. Neither holds secret values: env findings are masked by the helper and again here.
export async function previewFacts(siteId, targetServerId, options, ownMove = null) {
  const { site, server: source } = siteInfo(siteId);
  const target = server(targetServerId);
  if (!target) throw httpError(404, 'Target server not found.');
  const cfg = site.config;
  let sourceFacts;
  try { sourceFacts = await remote(source, { operation: 'move-facts', role: 'source', config: cfg, hosts: [source.host] }); }
  catch (error) { throw httpError(409, error.remoteReported ? `DockNest could not read ${site.name} on ${source.name}: ${error.message}` : `${source.name} could not be reached. Open Servers and test the connection.`); }
  const sf = sourceFacts.site;
  let targetFacts = null, hostKeyOk = true;
  if (target.id !== source.id) {
    try { targetFacts = await remote(target, { operation: 'move-facts', role: 'target', config: { stagingRoot: cfg.stagingRoot || '/var/lib/docknest' }, probe: { paths: sf.bindPaths, names: sf.names } }); }
    catch (error) { hostKeyOk = !error.hostKeyRejected; }
  }
  const backup = lastBackup(site.id);
  const others = db.prepare("SELECT preflight FROM site_moves WHERE target_server_id=? AND site_id<>? AND state NOT IN ('draft','rolled_back','cancelled','failed','switched_back','cleaned')").all(target.id, site.id);
  const reservedPorts = others.flatMap(row => { try { return JSON.parse(row.preflight).plan.portMap.map(entry => entry.to); } catch { return []; } });
  const capacity = await storageCapacity().catch(() => null);
  const domain = sf.domains[0];
  const records = domain ? await currentRecords(domain) : [];
  const targetAddresses = [...new Set([...(await resolved(target.host)), ...(targetFacts?.addresses ?? [])])];
  const recordValue = [...literal(target.host), ...targetAddresses].find(ipv4) ?? null;
  const facts = {
    site: { id: site.id, name: site.name, kind: sf.kind, domains: sf.domains, containerCount: sf.containerCount, architecture: sf.architecture, packageBytes: backup?.size ?? 0,
      ports: sf.ports, bindPaths: sf.bindPaths, names: sf.names, networks: sf.networks, nginxDirectives: sf.nginxDirectives, maintenanceReady: sf.maintenanceReady ?? undefined, env: sf.env,
      timings: backup?.seconds ? { backupSeconds: backup.seconds } : undefined },
    source: { id: source.id, name: source.name, addresses: [...new Set([...(await resolved(source.host)), ...(sourceFacts.addresses ?? [])])] },
    target: targetFacts ? { id: target.id, name: target.name, reachable: true, hostKeyOk, ...targetFacts, existingPaths: targetFacts.probe?.existingPaths ?? [], conflicts: targetFacts.probe?.conflicts ?? {}, reservedPorts }
      : { id: target.id, name: target.name, reachable: target.id === source.id, hostKeyOk, freeBytes: 0 },
    state: { sameServer: target.id === source.id, busy: !!db.prepare("SELECT 1 FROM jobs WHERE site_id=? AND type<>'site-move' AND status IN ('queued','running','recovery_required')").get(site.id),
      archived: !!db.prepare('SELECT 1 FROM site_archives WHERE site_id=?').get(site.id), deploymentHold: deploymentHeld(db),
      activeMove: !!db.prepare("SELECT 1 FROM site_moves WHERE site_id=? AND id<>? AND state NOT IN ('draft','rolled_back','cancelled','failed','switched_back','cleaned')").get(site.id, ownMove ?? '') },
    backupStorage: capacity && capacity.available !== null ? { freeBytes: capacity.available } : undefined,
    dns: { mode: options.dnsMode, records },
  };
  const result = evaluateMove(facts, { envRewrite: options.envRewrite });
  if (domain && !recordValue && result.canStart) {
    result.details.checks.push({ id: 'dns', status: 'block', title: 'DNS', text: `DockNest could not find the IPv4 address of ${target.name} to show in the DNS record.` });
    Object.assign(result, { verdict: 'blocked', canStart: false, sentence: result.details.checks.at(-1).text });
  }
  const plan = { kind: sf.kind, domains: sf.domains, nginxDirectives: sf.nginxDirectives ?? [], web: sf.web ?? null, running: sf.running, networks: sf.networks, portMap: result.details.portMap, healthPath: healthPath(cfg),
    targetAddresses, recordValue, oldAddresses: [source.host, ...(sourceFacts.addresses ?? [])].filter(value => !/^127\.|^::1$/.test(value)), estimateSeconds: estimateTotal(facts, result) };
  return { site, source, target, result, plan, hash: preflightHash(result, options) };
}
function estimateTotal(facts, result) {
  const backup = facts.site.timings?.backupSeconds;
  if (!Number.isFinite(backup)) return null;
  return Math.ceil(backup * 2 + (result.details.downtime?.seconds ?? backup) + 120); // two backups, two deploys, test and checks
}

const MOVE_OPTIONS = ['dnsMode', 'envRewrite', 'askBeforeSwitch'];
export function normaliseOptions(options = {}) {
  const dnsMode = options.dnsMode ?? 'manual';
  if (dnsMode === 'cloudflare' && !cloudflare.available) throw httpError(400, 'Automatic Cloudflare switching is not available yet. Choose "I\'ll change DNS myself".');
  if (dnsMode !== 'manual') throw httpError(400, 'Unknown DNS choice.');
  const envRewrite = [...new Set((options.envRewrite ?? []).map(String))].filter(key => /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key)).sort();
  return Object.fromEntries(Object.entries({ dnsMode, envRewrite, askBeforeSwitch: !!options.askBeforeSwitch }).filter(([key]) => MOVE_OPTIONS.includes(key)));
}

// POST /api/moves: a preview. It is stored as a draft so Start is bound to exactly what the owner reviewed; a newer
// preview for the same site replaces it. Drafts block no other work and expire after an hour.
export async function previewMove({ siteId, targetServerId, options: raw }, actor) {
  const options = normaliseOptions(raw);
  const preview = await previewFacts(siteId, targetServerId, options);
  const moveId = id(), at = now();
  transaction(() => {
    const active = db.prepare("SELECT id,state FROM site_moves WHERE site_id=? AND state NOT IN ('rolled_back','cancelled','failed','switched_back','cleaned')").get(siteId);
    if (active && active.state !== 'draft') throw httpError(409, 'This site is already being moved. Open the move to follow it or cancel it first.', { moveId: active.id });
    if (active) db.prepare("UPDATE site_moves SET state='cancelled',finished_at=?,updated_at=? WHERE id=?").run(at, at, active.id);
    // A preview to the site's own server is still answered (with its reason) but never stored.
    if (preview.source.id !== preview.target.id) db.prepare("INSERT INTO site_moves(id,site_id,source_server_id,target_server_id,state,options,preflight,preflight_hash,actor,created_at,updated_at) VALUES(?,?,?,?,'draft',?,?,?,?,?,?)")
      .run(moveId, siteId, preview.source.id, preview.target.id, JSON.stringify(options), JSON.stringify({ result: preview.result, plan: preview.plan }), preview.hash, actor, at, at);
    audit(actor, 'move.preview', siteId, { move: moveId, target: targetServerId, verdict: preview.result.verdict });
  });
  return previewView(preview.source.id === preview.target.id ? null : moveId, preview);
}
export function previewView(moveId, { result, plan, hash, target, site }) {
  const checks = result.details.checks;
  return {
    id: moveId, siteId: site.id, targetServerId: target.id, ok: result.canStart, verdict: result.verdict, sentence: result.sentence,
    needsMoveAnyway: !!result.needsMoveAnyway, estimateSeconds: plan.estimateSeconds, downtimeSeconds: result.details.downtime?.seconds ?? null,
    downtimeText: result.details.downtime?.text ?? null, undoDays: RETENTION_DAYS, preflightHash: hash,
    blockers: checks.filter(item => item.status === 'block').map(item => item.text),
    warnings: checks.filter(item => item.status === 'warn').map(item => ({ id: item.id, text: item.text, advanced: !!item.advanced, requiresConfirmation: !!item.requiresConfirmation })),
    advanced: {
      ports: result.details.portMap.map(({ from, to, containerPort, protocol, hostIp }) => ({ from, to, containerPort, protocol, hostIp, changed: from !== to })),
      nginx: { file: plan.domains.length ? `/etc/nginx/conf.d/docknest-${site.id}.conf` : null, notCopied: plan.nginxDirectives ?? [] },
      envKeys: result.details.env.map(({ key, where, kind, masked, rewrite }) => ({ key, where, kind, masked, rewrite })),
      dns: { mode: 'manual', record: plan.domains.length && plan.recordValue ? { type: 'A', name: plan.domains[0], value: plan.recordValue } : null, cloudflareAvailable: cloudflare.available },
      tests: { http: plan.domains.length && plan.web ? { host: plan.domains[0], path: plan.healthPath } : null, mailBlocking: 'where the server firewall allows it', note: 'The test copy runs your real app on a copy of your data. Scheduled jobs and webhooks may run once.' },
      checks: checks.map(({ id: checkId, status, title, text }) => ({ id: checkId, status, title, text })),
    },
  };
}

// POST /api/moves/:id/start. The preview is re-run here (the client is never trusted) and must still match.
export async function startMove(moveId, { preflightHash: reviewed, moveAnyway = false }, actor) {
  const move = loadMove(moveId);
  if (!move) throw httpError(404, 'Move not found.');
  if (move.state !== 'draft') throw httpError(409, 'This move has already started.');
  if (Date.parse(move.created_at) + DRAFT_TTL_MS < Date.now()) throw httpError(409, 'This check is more than an hour old. Press Save changes to check again.');
  const preview = await previewFacts(move.site_id, move.target_server_id, move.options);
  if (!preview.result.canStart) throw httpError(409, preview.result.sentence, { preview: previewView(move.id, preview) });
  if (reviewed !== move.preflight_hash || preview.hash !== move.preflight_hash) throw httpError(409, 'Something changed since you reviewed this move. Press Save changes to check again.', { code: 'PREFLIGHT_CHANGED', preview: previewView(move.id, preview) });
  if (preview.result.needsMoveAnyway && moveAnyway !== true) throw httpError(409, 'This move has a long downtime. Confirm with Move anyway to start it.', { code: 'MOVE_ANYWAY_REQUIRED' });
  transaction(() => {
    const current = loadMove(moveId);
    if (current.state !== 'draft') throw httpError(409, 'This move has already started.');
    const started = applyTransition({ ...current, preflight: { result: preview.result, plan: preview.plan, moveAnyway: !!moveAnyway } }, 'queued', now());
    saveMove(started);
    const insert = db.prepare('INSERT INTO site_move_steps(move_id,step,attempt,state,started_at,finished_at,resources,result) VALUES(?,?,?,?,?,?,?,?)');
    for (const step of initialSteps(moveId, move.options)) {
      const row = !preview.plan.domains.length && ['switch_dns', 'verify_dns', 'certificate'].includes(step.step) ? skipStep(step, 'The site has no domain.', now()) : step;
      insert.run(row.move_id, row.step, row.attempt, row.state, row.started_at, row.finished_at, JSON.stringify(row.resources), JSON.stringify(row.result));
    }
    audit(actor, 'move.start', move.site_id, { move: moveId, target: move.target_server_id, moveAnyway: !!moveAnyway });
  });
  return moveView(moveId);
}

export function cancelMove(moveId, actor) {
  return transaction(() => {
    const move = loadMove(moveId);
    if (!move) throw httpError(404, 'Move not found.');
    const decision = cancelDecision(move, loadSteps(move));
    if (!decision.allowed) throw httpError(409, decision.reason);
    if (move.state === 'draft' || move.state === 'queued') transition(move, 'cancelled', { cancel_requested: true });
    else saveMove({ ...move, cancel_requested: true, updated_at: now() });
    audit(actor, 'move.cancel', move.site_id, { move: moveId });
    return moveView(moveId);
  });
}

// POST /api/moves/:id/continue: "Switch now" (owner-switch) or "Check DNS now" (dns).
export async function continueMove(moveId, gate, actor) {
  const move = loadMove(moveId);
  if (!move) throw httpError(404, 'Move not found.');
  if (move.state !== 'waiting' || move.waiting_for !== gate) throw httpError(409, 'This move is not waiting for that.');
  if (gate === 'dns') {
    const check = await checkDns(move.preflight.plan.domains[0], move.preflight.plan.targetAddresses);
    if (!check.ok) { recordDnsCheck(move, check); throw httpError(409, `${move.preflight.plan.domains[0]} does not point to the new server yet. ${check.reason}`); }
  }
  passGate(move, gate);
  audit(actor, 'move.continue', move.site_id, { move: moveId, gate });
  return moveView(moveId);
}
function passGate(move, gate) {
  transaction(() => {
    const current = loadMove(move.id), steps = loadSteps(current);
    const { move: next, step } = answerGate(current, steps, gate, now(), gate === 'dns' ? { verifiedAt: now() } : {});
    saveMove(next); saveStep(step);
  });
}
function recordDnsCheck(move, check) {
  const step = loadSteps(move).find(item => item.step === 'verify_dns');
  if (step?.state === 'pending') saveStep({ ...step, result: { ...step.result, lastCheckAt: now(), lastCheck: check.reason ?? 'ok' } });
}

// ---------- views ----------
const LABELS = { preflight: 'Check both servers', backup: 'Fresh backup', deploy_test: 'Copy to the new server', test: 'Test the copy', await_switch: 'Ready to switch', final_sync: 'Final copy', deploy_final: 'Start on the new server', switch_dns: 'Switch DNS', verify_dns: 'Wait for DNS', certificate: 'Certificate', finalize: 'Finish' };
export function publicState(move) {
  switch (move.state) {
    case 'waiting': return move.waiting_for === 'dns' ? 'waiting_dns' : 'waiting_switch';
    case 'rolling_back': return move.cancel_requested ? 'cancelling' : 'rolling_back';
    case 'recovery_required': return 'needs_attention';
    case 'completed': case 'retention_expired': return 'done';
    default: return move.state;
  }
}
function statusLine(move, steps, names) {
  const { site, source, target } = names, record = dnsRecord(move);
  const running = steps.find(step => step.state === 'running');
  switch (move.state) {
    case 'draft': return move.preflight.result.sentence;
    case 'queued': return `Starting the move of ${site} to ${target}.`;
    case 'waiting': return move.waiting_for === 'dns' ? `Change the DNS record: ${record.type} ${record.name} -> ${record.value}. DockNest checks every minute and finishes by itself.` : `The copy on ${target} works. Press Switch now when you are ready for ${move.preflight.result.details.downtime?.text ?? 'a short'} downtime.`;
    case 'rolling_back': return move.cancel_requested ? `Cancelling. DockNest is undoing the move; ${site} stays on ${source}.` : `Something went wrong, so DockNest is undoing the move. ${site} stays on ${source}.`;
    case 'recovery_required': return move.error ?? 'This move needs your decision.';
    case 'completed': return `Done. ${site} now runs on ${target}. The old copy on ${source} is kept, stopped, until ${move.retain_until?.slice(0, 10)}.`;
    case 'retention_expired': return `Done. The old copy of ${site} on ${source} has been kept for ${RETENTION_DAYS} days. Decide whether to remove it.`;
    case 'rolled_back': return `The move was undone. ${site} runs on ${source} as before.${move.error ? ' Reason: ' + move.error : ''}`;
    case 'cancelled': return `Cancelled. ${site} stays on ${source}.`;
    case 'failed': return `The move stopped before changing anything. ${move.error ?? ''}`.trim();
    default: {
      if (!running) return `Moving ${site} to ${target}.`;
      const text = { preflight: `Checking ${source} and ${target}.`, backup: `Taking a fresh backup of ${site}.`, deploy_test: `Copying ${site} to ${target}. ${site} stays online.`, test: `Testing the copy on ${target}.`, final_sync: `Final copy: ${site} shows its maintenance page for ${move.preflight.result.details.downtime?.text ?? 'a short time'}.`, deploy_final: `Starting ${site} on ${target}.`, certificate: `Setting up the certificate on ${target}.`, finalize: 'Finishing the move.' };
      return text[running.step] ?? `Moving ${site} to ${target}.`;
    }
  }
}
function dnsRecord(move) {
  const plan = move.preflight.plan;
  return plan.domains?.length && plan.recordValue ? { type: 'A', name: plan.domains[0], value: plan.recordValue } : null;
}
export function moveView(moveId) {
  const move = loadMove(moveId);
  if (!move) throw httpError(404, 'Move not found.');
  const steps = move.state === 'draft' ? [] : loadSteps(move);
  const site = db.prepare('SELECT name FROM sites WHERE id=?').get(move.site_id)?.name ?? 'The site';
  const names = { site, source: server(move.source_server_id)?.name ?? 'the old server', target: server(move.target_server_id)?.name ?? 'the new server' };
  const finished = steps.filter(step => ['done', 'skipped'].includes(step.state)).length;
  const decision = isTerminal(move.state) ? { allowed: false } : cancelDecision(move, steps);
  return {
    id: move.id, siteId: move.site_id, siteName: site, sourceServerId: move.source_server_id, sourceName: names.source, targetServerId: move.target_server_id, targetName: names.target,
    state: publicState(move), engineState: move.state, waitingFor: move.waiting_for, statusLine: statusLine(move, steps, names),
    progress: steps.length ? Math.round(finished / steps.length * 100) : 0, cancelable: !!decision.allowed && !move.cancel_requested, cancelLabel: decision.label ?? null,
    dns: dnsRecord(move), downtimeText: move.preflight.result.details.downtime?.text ?? null, error: move.error ?? null,
    steps: steps.map(step => ({ step: step.step, label: LABELS[step.step] ?? step.step, state: step.state, startedAt: step.started_at, finishedAt: step.finished_at, result: publicResult(step.result) })),
    createdAt: move.created_at, updatedAt: move.updated_at, switchedAt: move.switched_at, retainUntil: move.retain_until, finishedAt: move.finished_at,
  };
}
const publicResult = result => Object.fromEntries(Object.entries(result ?? {}).filter(([key]) => ['error', 'status', 'skipped', 'mailBlocked', 'ports', 'http', 'lastCheck', 'lastCheckAt', 'record', 'backupId', 'undoError'].includes(key)));
export function listMoves() {
  if (!tableReady()) return [];
  return db.prepare("SELECT id FROM site_moves WHERE state NOT IN ('draft','rolled_back','cancelled','failed','switched_back','cleaned') ORDER BY created_at DESC LIMIT 100").all().map(row => moveView(row.id));
}

// ---------- worker ----------
const INLINE_RUN = new Set(['backup', 'final_sync', 'switch_dns']);
const POLLED = new Set(['backup', 'final_sync']);
const dnsSchedule = new Map();

export function tickMoves(at = now()) {
  if (!tableReady()) return;
  db.prepare("UPDATE site_moves SET state='cancelled',finished_at=?,updated_at=? WHERE state='draft' AND created_at<?").run(at, at, new Date(Date.parse(at) - DRAFT_TTL_MS).toISOString());
  for (const { id: moveId } of db.prepare("SELECT id FROM site_moves WHERE state NOT IN ('draft','rolled_back','cancelled','failed','switched_back','cleaned')").all()) {
    try { advance(moveId, at); } catch (error) { console.error(`Move ${moveId} could not advance: ${error.code ?? error.name}`); }
  }
}
function advance(moveId, at) {
  for (let guard = 0; guard < 12; guard++) {
    const move = loadMove(moveId), steps = loadSteps(move);
    const action = nextAction(move, steps, { now: at });
    if (action.type === 'none' || action.type === 'owner') return;
    if (action.type === 'transition') {
      if (action.to === 'completed') return; // only finalize completes a move, inside its transaction
      transition(move, action.to, action.waiting_for ? { waiting_for: action.waiting_for } : {});
      continue;
    }
    if (action.type === 'wait') {
      if (action.for === 'owner-switch' && !move.options.askBeforeSwitch) { passGate(move, 'owner-switch'); continue; }
      if (action.for === 'dns') scheduleDnsCheck(move);
      return;
    }
    if (action.type === 'run' && INLINE_RUN.has(action.step)) { if (runInline(move, steps, action.step)) continue; return; }
    if (action.type === 'recover' && POLLED.has(action.step)) { pollBackupStep(move, steps, action.step); return; }
    if (action.type === 'undo' && action.undo === 'remove-certificate-block') { saveStep(undoneStep(steps.find(step => step.step === action.step), { note: 'Removed with the nginx file.' }, now())); continue; }
    ensureJob(move);
    return;
  }
}
function ensureJob(move) {
  if (db.prepare("SELECT 1 FROM jobs WHERE type='site-move' AND json_extract(details,'$.moveId')=? AND status IN ('queued','running')").get(move.id)) return;
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,'site-move','queued','queued',?,?)")
    .run(id(), move.site_id, now(), JSON.stringify({ moveId: move.id, sourceServerId: move.source_server_id, targetServerId: move.target_server_id }));
}

// DB-only steps. Returns true when the move can advance again in this tick.
function runInline(move, steps, name) {
  const step = steps.find(item => item.step === name), plan = move.preflight.plan;
  if (name === 'switch_dns') {
    transaction(() => {
      saveStep(completeStep(beginStep(step, now()), { result: { record: dnsRecord(move) } }, now()));
      saveMove({ ...move, switched_at: now(), updated_at: now() });
      audit('worker', 'move.step.switch_dns', move.site_id, { move: move.id });
    });
    return true;
  }
  if (name === 'backup') {
    const fresh = lastBackup(move.site_id);
    if (fresh && Date.now() - Date.parse(fresh.captured_at) < FRESH_BACKUP_MS && Date.parse(fresh.captured_at) >= Date.parse(move.created_at) - FRESH_BACKUP_MS) {
      transaction(() => { saveStep(completeStep(beginStep(step, now()), { result: { backupId: fresh.id, reused: true } }, now())); saveMove({ ...move, backup_id: fresh.id, updated_at: now() }); });
      return true;
    }
  }
  if (deploymentHeld(db)) return false;
  let job;
  try { job = enqueueBackup(move.site_id, 'move:' + move.id, { moveId: move.id, keepStopped: name === 'final_sync' && plan.kind !== 'static' }); }
  catch { return false; } // other work on the site first; the next tick tries again
  saveStep({ ...beginStep(step, now()), resources: { jobId: job.id, ...(name === 'final_sync' ? { running: plan.running } : {}) } });
  return false;
}
function pollBackupStep(move, steps, name) {
  const step = steps.find(item => item.step === name), jobId = step.resources.jobId;
  const job = jobId && db.prepare('SELECT status,error FROM jobs WHERE id=?').get(jobId);
  if (!job) { saveStep(failStep(step, { result: { error: 'The backup for this move was not found.' } }, now())); return; }
  if (['queued', 'running'].includes(job.status)) return;
  const backup = db.prepare('SELECT id FROM backups WHERE job_id=? AND verified=1').get(jobId);
  if (job.status === 'completed' && backup) {
    transaction(() => {
      saveStep(completeStep(step, { result: { backupId: backup.id } }, now()));
      saveMove({ ...move, [name === 'backup' ? 'backup_id' : 'final_backup_id']: backup.id, updated_at: now() });
      audit('worker', 'move.step.' + name, move.site_id, { move: move.id, backupId: backup.id });
    });
    return;
  }
  const error = job.status === 'recovery_required' ? 'The final copy stopped partway. Resolve the backup job on the Jobs page; then DockNest restarts the old site.' : 'The backup did not finish, so nothing was changed.';
  transaction(() => { saveStep(failStep(step, { result: { error } }, now())); saveMove({ ...move, error, updated_at: now() }); });
}
function scheduleDnsCheck(move) {
  const entry = dnsSchedule.get(move.id) ?? { next: 0, count: 0, busy: false };
  if (entry.busy || Date.now() < entry.next) return;
  entry.busy = true; dnsSchedule.set(move.id, entry);
  checkDns(move.preflight.plan.domains[0], move.preflight.plan.targetAddresses)
    .then(check => { if (check.ok) passGate(move, 'dns'); else recordDnsCheck(move, check); })
    .catch(() => {})
    .finally(() => { entry.busy = false; entry.count++; entry.next = Date.now() + (entry.count < 20 ? 15000 : 60000); });
}

// One server step per job.
jobRunners['site-move'] = executeMoveJob;
export async function executeMoveJob(job) {
  const { moveId } = JSON.parse(job.details || '{}');
  let error = null;
  try {
    const move = loadMove(moveId), steps = loadSteps(move);
    const action = nextAction(move, steps);
    const context = contextFor(move, job);
    if (action.type === 'run') await runStep(context, steps.find(step => step.step === action.step));
    else if (action.type === 'undo') await runUndo(context, steps.find(step => step.step === action.step), action.undo);
    else if (action.type === 'recover') await recover(context, steps.find(step => step.step === action.step));
  } catch (caught) { error = plain(caught); }
  db.prepare("UPDATE jobs SET status=?,stage=?,finished_at=?,error=? WHERE id=? AND status='running'").run(error ? 'failed' : 'completed', error ? 'failed' : 'completed', now(), error, job.id);
}
function contextFor(move, job) {
  const { site } = siteInfo(move.site_id);
  return { move, job, site, source: server(move.source_server_id), target: server(move.target_server_id), plan: move.preflight.plan };
}
async function runStep(context, step) {
  const { move } = context;
  let current = beginStep(step, now());
  saveStep(current);
  try {
    const outcome = await STEPS[step.step](context) ?? {};
    if (step.step === 'finalize') return; // finalize journals itself inside its transaction
    current = completeStep(current, outcome, now());
    saveStep(current);
    audit('worker', 'move.step.' + step.step, move.site_id, { move: move.id });
  } catch (error) {
    const message = plain(error);
    transaction(() => { saveStep(failStep(current, { result: { error: message } }, now())); saveMove({ ...loadMove(move.id), error: message, updated_at: now() }); });
    audit('worker', 'move.step.' + step.step + '.failed', move.site_id, { move: move.id });
  }
}
async function runUndo(context, step, undo) {
  const { move, site, source, target } = context;
  try {
    if (undo === 'move-undo') await remote(target, { operation: 'deploy-teardown', moveId: move.id });
    else if (undo === 'resume-source') await remote(source, { operation: 'move-resume-source', config: site.config, running: step.resources.running ?? [] });
    else if (undo === 'revert-dns') await cloudflare.revertRecord(step.resources);
    saveStep(undoneStep(step, { undoneAt: now() }, now()));
    audit('worker', 'move.undo.' + step.step, move.site_id, { move: move.id });
  } catch (error) {
    const message = plain(error);
    const plainState = undo === 'resume-source' ? `${site.name} is stopped on ${source.name} and shows its maintenance page. ${message}` : `DockNest could not remove the copy on ${target.name}. ${message}`;
    transaction(() => { saveStep(undoFailedStep(step, { undoError: message }, now())); saveMove({ ...loadMove(move.id), error: plainState, updated_at: now() }); });
  }
}
// A step the journal shows as running but whose job is gone: check the real state (state.js decides what to do).
async function recover(context, step) {
  const { move, target } = context;
  const definition = stepDefinition(move.options, step.step);
  let observed = 'unknown';
  try {
    if (step.step === 'deploy_test' || step.step === 'deploy_final') {
      const status = await remote(target, { operation: 'deploy-status', moveId: move.id });
      observed = status.deployed.includes(step.step === 'deploy_test' ? 'test' : 'live') ? 'done' : 'absent';
    } else if (step.step === 'finalize') observed = loadMove(move.id).state === 'completed' ? 'done' : 'absent';
    else if (step.step === 'certificate') observed = 'absent';
  } catch { observed = 'unknown'; }
  const decision = recoverStep(move, step, observed);
  if (decision.action === 'rerun' || decision.action === 'mark_done') return runStep(context, step); // deploys are idempotent and return their stored result
  if (decision.action === 'undo_then_rerun') {
    if (definition.undo === 'move-undo') await remote(target, { operation: 'deploy-teardown', moveId: move.id });
    saveStep({ ...step, state: 'pending', finished_at: null });
    return;
  }
  if (decision.action === 'recovery_required') transition(loadMove(move.id), 'recovery_required', { error: decision.reason });
}

const mappedPort = (plan, port) => plan.portMap.find(entry => entry.from === port)?.to ?? port;
async function fallbackHtml() { try { return await maintenanceHtml(); } catch { return (await readFile(new URL('../../remote/maintenance.html', import.meta.url))).toString('base64'); } }
async function deploy(context, mode, backupId) {
  const { move, job, site, target, plan } = context;
  const request = { operation: 'deploy-restore', moveId: move.id, job: job.id, mode, portMap: plan.portMap, networks: plan.networks,
    ...(move.options.envRewrite.length && plan.recordValue ? { envRewrite: { keys: move.options.envRewrite, from: plan.oldAddresses, to: plan.recordValue } } : {}),
    ...(mode === 'live' && plan.domains.length ? { nginx: { siteId: site.id, domains: plan.domains, upstreamPort: plan.web ? mappedPort(plan, plan.web) : null, maintenanceDirectory: site.config.maintenance.directory, maintenanceHtml: await fallbackHtml(), path: plan.healthPath } } : {}) };
  if (mode === 'live' && plan.kind !== 'static' && plan.domains.length && !plan.web) throw new Error('DockNest could not find which port serves the website, so it cannot route the domain on the new server.');
  const status = await remote(target, { operation: 'deploy-status', moveId: move.id });
  if (status.deployed.includes(mode)) return remote(target, request);
  if (mode === 'live' && status.present) await remote(target, { operation: 'deploy-teardown', moveId: move.id });
  const { plaintextChecksum } = await moveTransport.upload(target, backupId, job.id);
  return remote(target, { ...request, plaintextChecksum });
}
const deployOutcome = result => ({ resources: { mode: result.mode, containers: result.containers, running: result.running ?? [], paths: result.paths ?? [], nginx: result.nginx ?? null }, result: { ports: result.ports, mailBlocked: result.mailBlocked, status: 'deployed' } });

const STEPS = {
  async preflight({ move, plan }) {
    const preview = await previewFacts(move.site_id, move.target_server_id, move.options, move.id);
    if (!preview.result.canStart) throw new Error(preview.result.sentence);
    if (JSON.stringify(preview.plan.portMap) !== JSON.stringify(plan.portMap)) throw new Error('A port on the new server was taken since you reviewed the move. Start the move again.');
    return { result: { status: preview.result.verdict } };
  },
  deploy_test: async context => deployOutcome(await deploy(context, 'test', loadMove(context.move.id).backup_id)),
  async test({ move, target, plan }) {
    if (plan.kind === 'static') return { result: { status: 'passed', static: true } };
    const deployed = loadSteps(move).find(step => step.step === 'deploy_test');
    const http = plan.domains.length && plan.web ? { port: mappedPort(plan, plan.web), host: plan.domains[0], path: plan.healthPath } : null;
    const result = await remote(target, { operation: 'move-test', moveId: move.id, running: deployed.resources.running ?? [], http });
    return { result: { status: 'passed', http: result.http } };
  },
  deploy_final: async context => deployOutcome(await deploy(context, 'live', loadMove(context.move.id).final_backup_id)),
  async certificate({ move, target }) { const result = await remote(target, { operation: 'move-certificate', moveId: move.id }); return { result: { status: result.status } }; },
  async finalize({ move, site, source, target }) {
    await remote(target, { operation: 'move-finalize-target', moveId: move.id });
    const retired = await remote(source, { operation: 'move-retire-source', moveId: move.id, config: site.config });
    // The single irreversible database change: the site record moves to the new server.
    transaction(() => {
      const current = loadMove(move.id);
      if (current.state === 'completed') return;
      db.prepare('UPDATE sites SET server_id=? WHERE id=?').run(target.id, site.id);
      const step = loadSteps(current).find(item => item.step === 'finalize');
      saveStep(completeStep(step.state === 'running' ? step : beginStep(step, now()), { resources: { retired: retired.containers.map(({ name, restartPolicy }) => ({ name, restartPolicy })) }, result: { status: 'done' } }, now()));
      const retainUntil = new Date(Date.now() + RETENTION_DAYS * 86400000).toISOString();
      saveMove(applyTransition(current, 'completed', now(), { retain_until: retainUntil, error: null }));
      audit('worker', 'move.complete', site.id, { move: move.id, from: source.id, to: target.id });
    });
  },
};

export { MoveStateError, describeDuration };
