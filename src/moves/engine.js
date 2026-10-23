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
import { checkDns, currentRecords, cloudflare, ipv4, cloudflareProxied } from './dns.js';

export const RETENTION_DAYS = 7;
export const DRAFT_TTL_MS = 60 * 60 * 1000;
// Every move takes its own fresh verified backup: an older one would miss changes made since, and the test copy
// would not show the site as it is now.
const now = () => new Date().toISOString();
const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const tableReady = () => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='site_moves'").get();

// ---------- persistence ----------
export function loadMove(moveId) {
  const row = db.prepare('SELECT * FROM site_moves WHERE id=?').get(moveId);
  return row ? { ...row, options: JSON.parse(row.options), preflight: JSON.parse(row.preflight), cancel_requested: !!row.cancel_requested } : null;
}
// Owner actions after a move add their own journaled steps to the same move.
export const SWITCH_BACK_STEPS = Object.freeze(['sb_stop_new', 'sb_start_old', 'sb_dns', 'sb_finalize']);
export const REMOVE_STEP = 'remove_old';
// Tests shrink step time limits with `moveLimits.scale`.
export const moveLimits = { scale: 1 };
export function loadSteps(move) {
  const order = [...planSteps(move.options).map(step => step.name), ...SWITCH_BACK_STEPS, REMOVE_STEP];
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
export const moveTransport = { remote: (server, request, options) => transport.remote(server, request, () => {}, () => {}, options), upload: uploadBackupTo, wait: ms => new Promise(resolve => setTimeout(resolve, ms)) };
// Operations that change a server hold the move's lock there and stop when DockNest stops waiting (stdin closes).
const LOCKED = new Set(['deploy-restore', 'deploy-teardown', 'move-test', 'move-resume-source', 'move-retire-source', 'move-finalize-target', 'move-certificate', 'move-stop-target', 'move-unretire-source', 'move-remove-old']);
let activeStep = null; // the worker runs one job at a time
async function remote(server, request) {
  const locked = LOCKED.has(request.operation);
  const options = locked ? { keepStdinOpen: true, signal: activeStep?.signal } : {};
  for (let attempt = 1; ; attempt++) {
    try { return await moveTransport.remote(server, locked ? { ...request, watchStdin: true } : request, options); }
    catch (error) { if (error.remoteReported || error.aborted || attempt >= 3) throw error; await moveTransport.wait(2000 * attempt); }
  }
}
async function serversIdle(move) {
  for (const serverId of [move.source_server_id, move.target_server_id]) {
    try { if ((await moveTransport.remote(server(serverId), { operation: 'move-lock-status', moveId: move.id }, {})).busy) return false; }
    catch { return false; }
  }
  return true;
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
    try { targetFacts = await remote(target, { operation: 'move-facts', role: 'target', config: { stagingRoot: cfg.stagingRoot || '/var/lib/docknest' }, probe: { paths: sf.bindPaths, names: { ...sf.names, composeProject: sf.compose?.project ?? null } } }); }
    catch (error) { hostKeyOk = !error.hostKeyRejected; }
  }
  const backup = lastBackup(site.id);
  const others = db.prepare("SELECT preflight FROM site_moves WHERE target_server_id=? AND site_id<>? AND state NOT IN ('draft','rolled_back','cancelled','failed','switched_back','cleaned')").all(target.id, site.id);
  const reservedPorts = others.flatMap(row => { try { return JSON.parse(row.preflight).plan.portMap.map(entry => entry.to); } catch { return []; } });
  const capacity = await storageCapacity().catch(() => null);
  const domain = sf.domains[0];
  const records = !domain ? [] : options.dnsMode === 'cloudflare' ? (await cloudflare.records(domain)) ?? [] : await currentRecords(domain);
  if (domain && options.dnsMode === 'cloudflare' && !cloudflare.zoneFor(domain)) throw httpError(400, `The saved Cloudflare token does not cover ${domain}. Choose "I'll change DNS myself" or connect a token for that zone.`);
  const targetAddresses = [...new Set([...(await resolved(target.host)), ...(targetFacts?.addresses ?? [])])];
  const recordValue = [...literal(target.host), ...targetAddresses].find(ipv4) ?? null;
  const recordValue6 = (targetFacts?.addresses ?? []).find(value => isIP(value) === 6 && !/^f[cde]|^::1$/i.test(value)) ?? null;
  const sourceValue = [...literal(source.host), ...(await resolved(source.host)), ...(sourceFacts.addresses ?? [])].find(ipv4) ?? null;
  const composeOverride = sf.kind === 'compose' && !!sf.compose && composeAtLeast(targetFacts?.composeVersion, [2, 24]);
  const mailBlocking = sf.kind !== 'static' && !!targetFacts?.firewall?.mailBlocking;
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
  if (options.dnsMode === 'manual' && records.some(record => cloudflareProxied(record.value))) {
    result.details.checks.push({ id: 'dns', status: 'warn', title: 'DNS', text: `${domain} is behind Cloudflare's proxy (orange cloud). Public DNS will not show the new server, so after changing the record in Cloudflare you confirm it yourself.`, advanced: true });
    result.details.warnings++; if (result.verdict === 'ready') result.verdict = 'ready-with-notes';
  }
  if (sf.kind !== 'static' && targetFacts && !mailBlocking) {
    const text = `${target.name} has no Docker firewall chain DockNest can use, so the test copy could send email. Pause scheduled mail in your app before the move if that matters.`;
    result.details.checks.push({ id: 'test', status: 'warn', title: 'Email during the test', text, advanced: true });
    result.details.warnings++; if (result.verdict === 'ready') result.verdict = 'ready-with-notes';
  }
  if (domain && !recordValue && result.canStart) {
    result.details.checks.push({ id: 'dns', status: 'block', title: 'DNS', text: `DockNest could not find the IPv4 address of ${target.name} to show in the DNS record.` });
    Object.assign(result, { verdict: 'blocked', canStart: false, sentence: result.details.checks.at(-1).text });
  }
  const plan = { kind: sf.kind, domains: sf.domains, nginxDirectives: sf.nginxDirectives ?? [], web: sf.web ?? null, running: sf.running, networks: sf.networks, portMap: result.details.portMap, healthPath: healthPath(cfg),
    targetAddresses, recordValue, recordValue6, sourceValue, maintenanceDirectory: targetMaintenanceDirectory(site), compose: composeOverride ? sf.compose : null, volumes: sf.volumes ?? [], mailBlocking, oldAddresses: [source.host, ...(sourceFacts.addresses ?? [])].filter(value => !/^127\.|^::1$/.test(value)), estimateSeconds: estimateTotal(facts, result) };
  return { site, source, target, result, plan, hash: preflightHash(result, options) };
}
function composeAtLeast(text, need) {
  const match = /(\d+)\.(\d+)/.exec(String(text ?? ''));
  return !!match && (Number(match[1]) > need[0] || (Number(match[1]) === need[0] && Number(match[2]) >= need[1]));
}
function estimateTotal(facts, result) {
  const backup = facts.site.timings?.backupSeconds;
  if (!Number.isFinite(backup)) return null;
  return Math.ceil(backup * 2 + (result.details.downtime?.seconds ?? backup) + 120); // two backups, two deploys, test and checks
}

const MOVE_OPTIONS = ['dnsMode', 'envRewrite', 'askBeforeSwitch'];
export function normaliseOptions(options = {}) {
  const dnsMode = options.dnsMode ?? 'manual';
  if (dnsMode === 'cloudflare' && !cloudflare.available()) throw httpError(400, 'Connect Cloudflare in Settings first, or choose "I\'ll change DNS myself".');
  if (!['manual', 'cloudflare'].includes(dnsMode)) throw httpError(400, 'Unknown DNS choice.');
  const envRewrite = [...new Set((options.envRewrite ?? []).map(String))].filter(key => /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key)).sort();
  return Object.fromEntries(Object.entries({ dnsMode, envRewrite, askBeforeSwitch: !!options.askBeforeSwitch }).filter(([key]) => MOVE_OPTIONS.includes(key)));
}

// POST /api/moves: a preview. It is stored as a draft so Start is bound to exactly what the owner reviewed; a newer
// preview for the same site replaces it. Drafts block no other work and expire after an hour.
export async function previewMove({ siteId, targetServerId, options: raw }, actor) {
  const options = normaliseOptions(raw);
  const preview = await previewFacts(siteId, targetServerId, options);
  preview.plan.dnsMode = options.dnsMode;
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
    id: moveId, siteId: site.id, targetServerId: target.id, ok: result.canStart, mailBlocked: !!plan.mailBlocking, verdict: result.verdict, sentence: result.sentence,
    needsMoveAnyway: !!result.needsMoveAnyway, estimateSeconds: plan.estimateSeconds, downtimeSeconds: result.details.downtime?.seconds ?? null,
    downtimeText: result.details.downtime?.text ?? null, undoDays: RETENTION_DAYS, preflightHash: hash,
    blockers: checks.filter(item => item.status === 'block').map(item => item.text),
    warnings: checks.filter(item => item.status === 'warn').map(item => ({ id: item.id, text: item.text, advanced: !!item.advanced, requiresConfirmation: !!item.requiresConfirmation })),
    advanced: {
      ports: result.details.portMap.map(({ from, to, containerPort, protocol, hostIp }) => ({ from, to, containerPort, protocol, hostIp, changed: from !== to })),
      nginx: { file: plan.domains.length ? `/etc/nginx/conf.d/docknest-${site.id}.conf` : null, notCopied: plan.nginxDirectives ?? [] },
      envKeys: result.details.env.map(({ key, where, kind, masked, rewrite }) => ({ key, where, kind, masked, rewrite })),
      dns: { mode: plan.dnsMode ?? 'manual', record: plan.domains.length && plan.recordValue ? { type: 'A', name: plan.domains[0], value: plan.recordValue } : null, cloudflareAvailable: cloudflare.available() },
      deployMethod: plan.compose ? 'compose-override' : plan.kind === 'static' ? 'files' : 'docker-create',
      tests: { http: plan.domains.length && plan.web ? { host: plan.domains[0], path: plan.healthPath } : null,
        mailBlocking: { blocked: !!plan.mailBlocking, method: plan.mailBlocking ? 'firewall' : 'none', text: plan.kind === 'static' ? 'A static website sends no email.' : plan.mailBlocking ? 'Outgoing email (ports 25, 465 and 587) from the test copy is blocked by the new server\'s firewall.' : 'DockNest cannot block outgoing email on the new server, so the test copy could send email.' },
        note: 'The test copy runs your real app on a copy of your data. Scheduled jobs and webhooks may run once.' },
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
  preview.plan.dnsMode = move.options.dnsMode;
  if (!preview.result.canStart) throw httpError(409, preview.result.sentence, { code: 'PREFLIGHT_CHANGED', preview: previewView(move.id, preview) });
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
export async function continueMove(moveId, gate, actor, { confirmed = false } = {}) {
  const move = loadMove(moveId);
  if (!move) throw httpError(404, 'Move not found.');
  if (move.state !== 'waiting' || move.waiting_for !== gate) throw httpError(409, 'This move is not waiting for that.');
  if (gate === 'dns') {
    const check = await dnsCheck(move);
    // Behind Cloudflare's proxy public DNS never shows the server, so the owner confirms the change themselves.
    if (!check.ok && !(confirmed && check.proxied)) { recordDnsCheck(move, check); throw httpError(409, check.proxied ? check.reason : `${move.preflight.plan.domains[0]} does not point to the new server yet. ${check.reason}`, check.proxied ? { code: 'DNS_PROXIED' } : {}); }
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
const dnsCheck = move => move.options.dnsMode === 'cloudflare' ? cloudflare.pointsAt(move.preflight.plan.domains[0], move.preflight.plan.recordValue) : checkDns(move.preflight.plan.domains[0], move.preflight.plan.targetAddresses);
function recordDnsCheck(move, check) {
  const step = loadSteps(move).find(item => item.step === 'verify_dns');
  if (step?.state === 'pending') saveStep({ ...step, result: { ...step.result, lastCheckAt: now(), lastCheck: check.reason ?? 'ok', proxied: !!check.proxied } });
}
export const DNS_WAIT_HOURS = 48;
function markDnsWait(moveId) {
  const move = loadMove(moveId), step = loadSteps(move).find(item => item.step === 'verify_dns');
  if (step?.state === 'pending') saveStep({ ...step, result: { ...step.result, waitingSince: now() } });
}

// ---------- views ----------
const LABELS = { sb_stop_new: 'Stop the new copy', sb_start_old: 'Start the old copy', sb_dns: 'Switch DNS back', sb_finalize: 'Finish switching back', remove_old: 'Remove old copy', preflight: 'Check both servers', backup: 'Fresh backup', deploy_test: 'Copy to the new server', test: 'Test the copy', await_switch: 'Ready to switch', final_sync: 'Final copy', deploy_final: 'Start on the new server', switch_dns: 'Switch DNS', verify_dns: 'Wait for DNS', certificate: 'Certificate', finalize: 'Finish' };
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
    case 'switching_back': return `Switching back: ${site} starts again on ${source}; the copy on ${target} is stopped and kept.`;
    case 'switched_back': return move.options.dnsMode === 'cloudflare' ? `Switched back. ${site} runs on ${source} again and its DNS record points there. The stopped copy stays on ${target}.` : `Switched back. ${site} runs on ${source} again. Change the DNS record back: ${record?.type} ${record?.name} -> ${record?.value}. The stopped copy stays on ${target}.`;
    case 'cleaned': return `Done. ${site} runs on ${target}; the old copy on ${source} was removed${move.preflight.removed?.dataKept === false ? ' with its data' : ', its data folders were kept'}.`;
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
  const plan = move.preflight.plan, back = ['switching_back', 'switched_back'].includes(move.state);
  const value = back ? plan.sourceValue : plan.recordValue;
  return plan.domains?.length && value ? { type: 'A', name: plan.domains[0], value } : null;
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
    dnsMode: move.options.dnsMode, mailBlocked: !!move.preflight.plan.mailBlocking,
    actions: { cancel: !!decision.allowed && !move.cancel_requested, switchBack: ['completed', 'retention_expired'].includes(move.state) || (move.state === 'waiting' && move.waiting_for === 'dns') || (move.state === 'recovery_required' && !!move.switched_at && !steps.some(step => SWITCH_BACK_STEPS.includes(step.step))), dnsProxied: !!steps.find(step => step.step === 'verify_dns')?.result.proxied, removeOldCopy: ['completed', 'retention_expired'].includes(move.state), askRemoveOldCopy: move.state === 'retention_expired', resolve: move.state === 'recovery_required' ? ['retry', ...(move.switched_at ? [] : ['undo']), ...(['failed', 'running'].includes(steps.find(step => step.step === 'finalize')?.state) ? ['finish-without-old-server'] : [])] : [] },
    dns: dnsRecord(move), downtimeText: move.preflight.result.details.downtime?.text ?? null, error: move.error ?? null,
    steps: steps.map(step => ({ step: step.step, label: LABELS[step.step] ?? step.step, state: step.state, startedAt: step.started_at, finishedAt: step.finished_at, result: publicResult(step.result) })),
    createdAt: move.created_at, updatedAt: move.updated_at, switchedAt: move.switched_at, retainUntil: move.retain_until, finishedAt: move.finished_at,
  };
}
const publicResult = result => Object.fromEntries(Object.entries(result ?? {}).filter(([key]) => ['error', 'status', 'skipped', 'mailBlocked', 'ports', 'http', 'lastCheck', 'lastCheckAt', 'record', 'backupId', 'undoError', 'command', 'reason', 'dataKept', 'volumes', 'paths', 'kept', 'proxied', 'waitingSince'].includes(key)));
export function listMoves() {
  if (!tableReady()) return [];
  return db.prepare("SELECT id FROM site_moves WHERE state NOT IN ('draft','rolled_back','cancelled','failed','switched_back','cleaned') ORDER BY created_at DESC LIMIT 100").all().map(row => moveView(row.id));
}

// ---------- worker ----------
const INLINE_RUN = new Set(['backup', 'final_sync', 'switch_dns']); // switch_dns only for manual DNS
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
    if (move.state === 'switching_back') { if (steps.some(step => SWITCH_BACK_STEPS.includes(step.step) && ['pending', 'running'].includes(step.state))) ensureJob(move); return; }
    if (['completed', 'retention_expired'].includes(move.state) && steps.some(step => step.step === REMOVE_STEP && ['pending', 'running'].includes(step.state))) { ensureJob(move); return; }
    if (enforcePolledLimit(move, steps)) continue;
    const action = nextAction(move, steps, { now: at });
    if (action.type === 'none' || action.type === 'owner') return;
    if (action.type === 'transition') {
      if (action.to === 'completed') return; // only finalize completes a move, inside its transaction
      const extra = action.waiting_for ? { waiting_for: action.waiting_for } : {};
      if (action.to === 'recovery_required' && move.switched_at) {
        const target = server(move.target_server_id)?.name ?? 'the new server';
        extra.error = `${move.error ?? 'A step failed after the switch.'} The site already runs on ${target}, so DockNest did not undo anything. Press Try again, or Switch back.`;
      }
      transition(move, action.to, extra);
      if (action.waiting_for === 'dns') markDnsWait(moveId);
      continue;
    }
    if (action.type === 'wait') {
      if (action.for === 'owner-switch' && !move.options.askBeforeSwitch) { passGate(move, 'owner-switch'); continue; }
      if (action.for === 'dns') {
        const since = steps.find(step => step.step === 'verify_dns')?.result.waitingSince ?? move.updated_at;
        if (Date.now() - Date.parse(since) > DNS_WAIT_HOURS * 3600000 * moveLimits.scale) {
          const domain = move.preflight.plan.domains[0], target = server(move.target_server_id)?.name ?? 'the new server';
          transition(move, 'recovery_required', { error: `${domain} still does not point to ${target} after ${DNS_WAIT_HOURS} hours. Check the DNS record, then press Try again, or Switch back to run the site on the old server again.` });
          return;
        }
        scheduleDnsCheck(move);
      }
      return;
    }
    if (action.type === 'run' && INLINE_RUN.has(action.step) && !(action.step === 'switch_dns' && move.options.dnsMode === 'cloudflare')) { if (runInline(move, steps, action.step)) continue; return; }
    if (action.type === 'recover' && POLLED.has(action.step)) { pollBackupStep(move, steps, action.step); return; }
    if (action.type === 'undo' && action.undo === 'remove-certificate-block') { saveStep(undoneStep(steps.find(step => step.step === action.step), { note: 'Removed with the nginx file.' }, now())); continue; }
    ensureJob(move);
    return;
  }
}
function ensureJob(move) {
  if (db.prepare("SELECT 1 FROM jobs WHERE type='site-move' AND json_extract(details,'$.moveId')=? AND status IN ('move_queued','move_running')").get(move.id)) return;
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,'site-move','move_queued','queued',?,?)")
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
// A backup step that runs longer than its limit stops the move; the backup itself finishes on its own.
function enforcePolledLimit(move, steps) {
  const step = steps.find(item => item.state === 'running' && POLLED.has(item.step));
  const limit = step && stepDefinition(move.options, step.step)?.limitSeconds;
  if (!limit || Date.now() - Date.parse(step.started_at) < limit * 1000 * moveLimits.scale) return false;
  const error = `${LABELS[step.step]} took longer than ${Math.round(limit / 60)} minutes, so DockNest stopped the move and undoes it.`;
  transaction(() => { saveStep(failStep(step, { result: { error } }, now())); saveMove({ ...move, error, updated_at: now() }); });
  return true;
}
function scheduleDnsCheck(move) {
  const entry = dnsSchedule.get(move.id) ?? { next: 0, count: 0, busy: false };
  if (entry.busy || Date.now() < entry.next) return;
  entry.busy = true; dnsSchedule.set(move.id, entry);
  dnsCheck(move)
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
    const context = contextFor(move, job);
    const extra = move.state === 'switching_back' ? steps.find(step => SWITCH_BACK_STEPS.includes(step.step) && ['pending', 'running'].includes(step.state))
      : ['completed', 'retention_expired'].includes(move.state) ? steps.find(step => step.step === REMOVE_STEP && ['pending', 'running'].includes(step.state)) : null;
    if (extra) await withLimit(context, extra.step, 900, () => runOwnerStep(context, extra));
    else {
      const action = nextAction(move, steps);
      const limit = stepDefinition(move.options, action.step)?.limitSeconds ?? 600;
      if (action.type === 'run') await withLimit(context, action.step, limit, () => runStep(context, steps.find(step => step.step === action.step)));
      else if (action.type === 'undo') await withLimit(context, action.step, 1800, () => runUndo(context, steps.find(step => step.step === action.step), action.undo));
      else if (action.type === 'recover') await withLimit(context, action.step, limit, () => recover(context, steps.find(step => step.step === action.step)));
    }
  } catch (caught) { error = plain(caught); }
  db.prepare("UPDATE jobs SET status=?,stage=?,finished_at=?,error=? WHERE id=? AND status='move_running'").run(error ? 'failed' : 'completed', error ? 'failed' : 'completed', now(), error, job.id);
}
// A server step that runs past its limit: DockNest stops waiting and asks the owner. The outcome is unknown (the
// server may still be working), so nothing is undone automatically; late results of the abandoned call are ignored.
async function withLimit(context, name, seconds, work) {
  let timer;
  const limit = Math.max(seconds, 120) * 1000 * moveLimits.scale, controller = new AbortController();
  activeStep = controller;
  const expired = new Promise(resolve => { timer = setTimeout(() => resolve('expired'), limit); });
  const outcome = await Promise.race([work().then(() => 'done'), expired]).finally(() => { clearTimeout(timer); activeStep = null; });
  if (outcome !== 'expired') return;
  // Stop the work on the server (its SSH channel closes and the helper ends itself), then keep this job, and so both
  // servers, busy until the server confirms the step is no longer running.
  context.abandoned = true;
  controller.abort();
  let stopped = false;
  for (let check = 0; check < 12 && !stopped; check++) { await moveTransport.wait(5000); stopped = await serversIdle(context.move); }
  const where = ['sb_start_old', 'final_sync', 'remove_old'].includes(name) ? context.source.name : context.target.name;
  const choices = context.move.switched_at ? 'Try again or Switch back' : 'Try again or Undo';
  const error = stopped ? `${LABELS[name] ?? name} took longer than ${Math.round(limit / 60000) || 1} minutes, so DockNest stopped it. Check ${where}, then choose ${choices}.`
    : `${LABELS[name] ?? name} took longer than ${Math.round(limit / 60000) || 1} minutes. DockNest asked ${where} to stop it but cannot confirm it stopped yet; ${choices} becomes possible once it has.`;
  const current = loadMove(context.move.id);
  if (!isTerminal(current.state) && current.state !== 'recovery_required') transition(current, 'recovery_required', { error });
}
function contextFor(move, job) {
  const { site } = siteInfo(move.site_id);
  return { move, job, site, source: server(move.source_server_id), target: server(move.target_server_id), plan: move.preflight.plan };
}
async function runStep(context, step) {
  const { move } = context;
  let current = beginStep(step, now());
  saveStep(current);
  context.current = current;
  try {
    const outcome = await STEPS[step.step](context) ?? {};
    if (context.abandoned) return;
    if (step.step === 'finalize') return; // finalize journals itself inside its transaction
    current = { ...current, resources: loadSteps(move).find(item => item.step === step.step).resources };
    current = completeStep(current, outcome, now());
    saveStep(current);
    audit('worker', 'move.step.' + step.step, move.site_id, { move: move.id });
  } catch (error) {
    if (context.abandoned) return;
    const message = plain(error);
    current = { ...current, resources: loadSteps(move).find(item => item.step === step.step).resources };
    transaction(() => { saveStep(failStep(current, { result: { error: message } }, now())); saveMove({ ...loadMove(move.id), error: message, updated_at: now() }); });
    audit('worker', 'move.step.' + step.step + '.failed', move.site_id, { move: move.id });
  }
}
// Switch back and Remove old copy: each step is idempotent on the server, so a crash simply runs it again.
async function runOwnerStep(context, step) {
  const { move } = context;
  let current = step.state === 'running' ? step : beginStep(step, now());
  saveStep(current);
  try {
    const outcome = await OWNER_STEPS[step.step](context, current) ?? {};
    if (context.abandoned) return;
    if (outcome.final) return;
    saveStep(completeStep(current, outcome, now()));
    audit('worker', 'move.step.' + step.step, move.site_id, { move: move.id });
  } catch (error) {
    if (context.abandoned) return;
    const message = plain(error);
    transaction(() => {
      saveStep(failStep(current, { result: { error: message } }, now()));
      const latest = loadMove(move.id);
      if (step.step === REMOVE_STEP) saveMove({ ...latest, error: `The old copy was not removed. ${message}`, updated_at: now() });
      else transition(latest, 'recovery_required', { error: `Switching back stopped: ${message} Press Try again.` });
    });
  }
}
async function runUndo(context, step, undo) {
  const { move, site, source, target } = context;
  try {
    if (undo === 'move-undo') await remote(target, { operation: 'deploy-teardown', moveId: move.id });
    else if (undo === 'resume-source') await remote(source, { operation: 'move-resume-source', config: site.config, running: step.resources.running ?? [] });
    else if (undo === 'revert-dns') await cloudflare.revertRecord(step.resources.records ?? []);
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
    else if (step.step === 'switch_dns') observed = (await cloudflare.pointsAt(context.plan.domains[0], context.plan.recordValue)).ok ? 'done' : 'absent';
    else if (step.step === 'certificate') observed = 'absent';
  } catch { observed = 'unknown'; }
  const decision = recoverStep(move, step, observed);
  if (decision.action === 'rerun' || decision.action === 'mark_done') return runStep(context, step); // deploys are idempotent and return their stored result
  if (decision.action === 'undo_then_rerun') {
    if (definition.undo === 'move-undo') await remote(target, { operation: 'deploy-teardown', moveId: move.id });
    if (definition.undo === 'revert-dns') await cloudflare.revertRecord(step.resources.records ?? []);
    saveStep({ ...step, state: 'pending', finished_at: null });
    return;
  }
  if (decision.action === 'recovery_required') transition(loadMove(move.id), 'recovery_required', { error: decision.reason });
}

const mappedPort = (plan, port) => plan.portMap.find(entry => entry.from === port)?.to ?? port;
const WEB_ROOTS = ['/var/www/', '/srv/', '/usr/share/nginx/', '/var/lib/docknest/maintenance/'];
export function targetMaintenanceDirectory(site) {
  const current = String(site.config.maintenance?.directory ?? '');
  return WEB_ROOTS.some(root => current.startsWith(root)) && !current.includes('..') ? current : `/var/lib/docknest/maintenance/${site.id}`;
}
async function fallbackHtml() { try { return await maintenanceHtml(); } catch { return (await readFile(new URL('../../remote/maintenance.html', import.meta.url))).toString('base64'); } }
async function deploy(context, mode, backupId) {
  const { move, job, site, target, plan } = context;
  const request = { operation: 'deploy-restore', moveId: move.id, job: job.id, mode, portMap: plan.portMap, networks: plan.networks, volumes: plan.volumes ?? [], ...(plan.compose ? { compose: plan.compose } : {}),
    ...(move.options.envRewrite.length && plan.recordValue ? { envRewrite: { keys: move.options.envRewrite, from: plan.oldAddresses, to: plan.recordValue } } : {}),
    ...(mode === 'live' && plan.domains.length ? { nginx: { siteId: site.id, domains: plan.domains, upstreamPort: plan.web ? mappedPort(plan, plan.web) : null, maintenanceDirectory: plan.maintenanceDirectory ?? targetMaintenanceDirectory(site), stagingRoot: site.config.stagingRoot || '/var/lib/docknest', maintenanceHtml: await fallbackHtml(), path: plan.healthPath } } : {}) };
  if (mode === 'live' && plan.kind !== 'static' && plan.domains.length && !plan.web) throw new Error('DockNest could not find which port serves the website, so it cannot route the domain on the new server.');
  const status = await remote(target, { operation: 'deploy-status', moveId: move.id });
  if (status.deployed.includes(mode)) return remote(target, request);
  if (mode === 'live' && status.present) await remote(target, { operation: 'deploy-teardown', moveId: move.id });
  const { plaintextChecksum } = await moveTransport.upload(target, backupId, job.id);
  return remote(target, { ...request, plaintextChecksum });
}
const deployOutcome = result => ({ resources: { mode: result.mode, containers: result.containers, running: result.running ?? [], paths: result.paths ?? [], nginx: result.nginx ?? null }, result: { ports: result.ports, mailBlocked: result.mailBlocked, method: result.method ?? null, status: 'deployed' } });

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
  async certificate({ move, target }) {
    const result = await remote(target, { operation: 'move-certificate', moveId: move.id });
    // No certbot account: the move still finishes; the owner gets the one command to run (DockNest never installs certbot).
    return { result: { status: result.status, ...(result.reason ? { reason: result.reason } : {}), ...(result.command ? { command: result.command } : {}) } };
  },
  async switch_dns({ move, plan, current }) {
    const existing = loadSteps(move).find(step => step.step === 'switch_dns')?.resources.records ?? null;
    const journal = await cloudflare.switchRecord(plan.domains[0], { ipv4: plan.recordValue, ipv6: plan.recordValue6 }, { existing, onJournal: records => saveStep({ ...current, resources: { ...current.resources, records } }) });
    db.prepare('UPDATE site_moves SET switched_at=?,updated_at=? WHERE id=?').run(now(), now(), move.id);
    return { resources: { records: journal }, result: { status: 'switched' } };
  },
  async finalize({ move, site, source, target, plan }) {
    await remote(target, { operation: 'move-finalize-target', moveId: move.id });
    const latest = loadMove(move.id);
    const retired = latest.preflight.skipRetire ? { containers: [], skipped: true } : await remote(source, { operation: 'move-retire-source', moveId: move.id, config: site.config });
    // The single irreversible database change: the site record moves to the new server.
    transaction(() => {
      const current = loadMove(move.id);
      if (current.state === 'completed') return;
      db.prepare('UPDATE sites SET server_id=? WHERE id=?').run(target.id, site.id);
      // The maintenance folder moves to a DockNest folder on the new server when the old one is not allowed there.
      const row = db.prepare('SELECT config FROM sites WHERE id=?').get(site.id), config = JSON.parse(row.config), previousDirectory = config.maintenance?.directory ?? null;
      if (plan.maintenanceDirectory && plan.maintenanceDirectory !== site.config.maintenance.directory) db.prepare('UPDATE sites SET config=? WHERE id=?').run(JSON.stringify({ ...config, maintenance: { ...config.maintenance, directory: plan.maintenanceDirectory } }), site.id);
      const step = loadSteps(current).find(item => item.step === 'finalize');
      saveStep(completeStep(step.state === 'running' ? step : beginStep(step, now()), { resources: { retired: retired.containers.map(({ name, restartPolicy }) => ({ name, restartPolicy })), previousMaintenanceDirectory: previousDirectory, oldServerSkipped: !!retired.skipped }, result: { status: 'done' } }, now()));
      const retainUntil = new Date(Date.now() + RETENTION_DAYS * 86400000).toISOString();
      saveMove(applyTransition(current, 'completed', now(), { retain_until: retainUntil, error: null }));
      audit('worker', 'move.complete', site.id, { move: move.id, from: source.id, to: target.id });
    });
  },
};

// ---------- owner actions after a move ----------
const OWNER_STEPS = {
  async sb_stop_new({ move, target }) { const result = await remote(target, { operation: 'move-stop-target', moveId: move.id }); return { resources: { stopped: result.containers.map(({ name, restartPolicy }) => ({ name, restartPolicy })) }, result: { status: 'stopped' } }; },
  async sb_start_old({ move, site, source, plan }) {
    // Before finalize the old copy was only stopped by the final copy; after it, it was also retired (restart off).
    const finalized = loadSteps(move).find(step => step.step === 'finalize')?.state === 'done';
    const config = { ...site.config, maintenance: { ...site.config.maintenance, directory: loadSteps(move).find(step => step.step === 'finalize')?.resources.previousMaintenanceDirectory ?? site.config.maintenance.directory } };
    await remote(source, { operation: finalized ? 'move-unretire-source' : 'move-resume-source', moveId: move.id, config, running: plan.running ?? [] });
    return { result: { status: 'started' } };
  },
  async sb_dns({ move, plan }) {
    if (!plan.domains.length) return { result: { skipped: 'The site has no domain.' } };
    if (move.options.dnsMode === 'cloudflare') { await cloudflare.revertRecord(loadSteps(move).find(step => step.step === 'switch_dns')?.resources.records ?? []); return { result: { status: 'reverted' } }; }
    return { result: { record: { type: 'A', name: plan.domains[0], value: plan.sourceValue } } };
  },
  async sb_finalize({ move, site, source, target }, step) {
    transaction(() => {
      const current = loadMove(move.id);
      if (current.state !== 'switching_back') return;
      db.prepare('UPDATE sites SET server_id=? WHERE id=?').run(source.id, site.id);
      const finalizeStep = loadSteps(current).find(item => item.step === 'finalize');
      if (finalizeStep?.state === 'done' && 'previousMaintenanceDirectory' in finalizeStep.resources) {
        const config = JSON.parse(db.prepare('SELECT config FROM sites WHERE id=?').get(site.id).config), previous = finalizeStep.resources.previousMaintenanceDirectory;
        const maintenance = { ...config.maintenance }; if (previous) maintenance.directory = previous; else delete maintenance.directory;
        db.prepare('UPDATE sites SET config=? WHERE id=?').run(JSON.stringify({ ...config, maintenance }), site.id);
      }
      saveStep(completeStep(step, { result: { status: 'done' } }, now()));
      saveMove(applyTransition(current, 'switched_back', now(), { error: null }));
      audit('worker', 'move.switch_back', site.id, { move: move.id, from: target.id, to: source.id });
    });
    return { final: true };
  },
  async remove_old({ move, site, source }, step) {
    const keepPaths = [];
    const collect = value => { if (typeof value === 'string' && value.startsWith('/')) keepPaths.push(value); else if (value && typeof value === 'object') Object.values(value).forEach(collect); };
    for (const row of db.prepare('SELECT config FROM sites WHERE id<>?').all(site.id)) { try { collect(JSON.parse(row.config)); } catch { /* unreadable config: nothing to add */ } }
    const result = await remote(source, { operation: 'move-remove-old', moveId: move.id, config: site.config, deleteData: !!step.resources.deleteData, keepPaths: [...new Set(keepPaths)].slice(0, 2000) });
    transaction(() => {
      const current = loadMove(move.id);
      saveStep(completeStep(step, { result: { status: 'removed', dataKept: result.dataKept, volumes: result.volumes, paths: result.paths, kept: result.kept ?? [] } }, now()));
      saveMove(applyTransition({ ...current, preflight: { ...current.preflight, removed: { dataKept: result.dataKept } } }, 'cleaned', now(), { error: null }));
      audit('worker', 'move.cleanup', site.id, { move: move.id, dataDeleted: !result.dataKept });
    });
    return { final: true };
  },
};
function addOwnerSteps(moveId, names, resources = {}) {
  const insert = db.prepare("INSERT INTO site_move_steps(move_id,step,attempt,state,resources,result) VALUES(?,?,0,'pending',?,'{}') ON CONFLICT(move_id,step) DO UPDATE SET state='pending',started_at=NULL,finished_at=NULL,resources=excluded.resources,result='{}'");
  for (const name of names) insert.run(moveId, name, JSON.stringify(resources));
}
// POST /api/moves/:id/switch-back: within the 7 days, the stopped old copy becomes the site again.
export function switchBack(moveId, actor) {
  return transaction(() => {
    const move = loadMove(moveId);
    if (!move) throw httpError(404, 'Move not found.');
    const allowed = ['completed', 'retention_expired'].includes(move.state) || (move.state === 'waiting' && move.waiting_for === 'dns') || (move.state === 'recovery_required' && !!move.switched_at && !loadSteps(move).some(step => SWITCH_BACK_STEPS.includes(step.step)));
    if (!allowed) throw httpError(409, 'Switch back is possible after the switch, while the old copy is kept.');
    if (loadSteps(move).some(step => step.step === REMOVE_STEP && ['pending', 'running', 'done'].includes(step.state))) throw httpError(409, 'The old copy is being removed or was removed, so DockNest cannot switch back.');
    addOwnerSteps(moveId, SWITCH_BACK_STEPS);
    transition(move, 'switching_back');
    audit(actor, 'move.switch_back.start', move.site_id, { move: moveId });
    return moveView(moveId);
  });
}
// POST /api/moves/:id/remove-old-copy: never automatic. Data folders stay unless the owner ticks "also delete the old data".
export function removeOldCopy(moveId, { confirmation, deleteData = false }, actor) {
  return transaction(() => {
    const move = loadMove(moveId);
    if (!move) throw httpError(404, 'Move not found.');
    if (!['completed', 'retention_expired'].includes(move.state)) throw httpError(409, 'There is no stopped old copy to remove for this move.');
    const site = db.prepare('SELECT name FROM sites WHERE id=?').get(move.site_id);
    if (confirmation !== site?.name) throw httpError(409, 'Type the site name to confirm removing the old copy.');
    if (loadSteps(move).some(step => step.step === REMOVE_STEP && step.state === 'running')) throw httpError(409, 'The old copy is already being removed.');
    addOwnerSteps(moveId, [REMOVE_STEP], { deleteData: !!deleteData });
    saveMove({ ...move, error: null, updated_at: now() });
    audit(actor, 'move.cleanup.start', move.site_id, { move: moveId, deleteData: !!deleteData });
    return moveView(moveId);
  });
}
// POST /api/moves/:id/resolve: the owner's answer when a move needs attention. Try again re-runs the stopped step;
// Undo (only before the switch) rolls the move back.
export async function resolveMove(moveId, action, actor, { confirmation } = {}) {
  const pending = loadMove(moveId);
  if (pending?.state === 'recovery_required' && !(await serversIdle(pending))) throw httpError(409, 'A step of this move is still running on a server. Try again in a minute.');
  return transaction(() => {
    const move = loadMove(moveId);
    if (!move) throw httpError(404, 'Move not found.');
    if (move.state !== 'recovery_required') throw httpError(409, 'This move does not need a decision.');
    if (db.prepare("SELECT 1 FROM jobs WHERE type='site-move' AND json_extract(details,'$.moveId')=? AND status IN ('move_queued','move_running')").get(moveId)) throw httpError(409, 'DockNest is still working on this move. Try again in a minute.');
    const steps = loadSteps(move), switchingBack = steps.some(step => SWITCH_BACK_STEPS.includes(step.step) && step.state !== 'pending' || SWITCH_BACK_STEPS.includes(step.step) && step.state === 'pending');
    const stuck = steps.filter(step => ['running', 'failed', 'undo_failed'].includes(step.state));
    if (action === 'finish-without-old-server') {
      const site = db.prepare('SELECT name FROM sites WHERE id=?').get(move.site_id);
      const finalize = steps.find(step => step.step === 'finalize');
      if (!['failed', 'running'].includes(finalize?.state)) throw httpError(409, 'This is possible only when finishing the move failed.');
      if (confirmation !== site?.name) throw httpError(409, 'Type the site name to confirm finishing without the old server.');
      saveStep({ ...finalize, state: 'pending', finished_at: null });
      saveMove(applyTransition({ ...move, preflight: { ...move.preflight, skipRetire: true } }, 'running', now(), { error: null }));
      audit(actor, 'move.resolve', move.site_id, { move: moveId, action });
      return moveView(moveId);
    }
    if (action === 'undo') {
      if (move.switched_at || switchingBack) throw httpError(409, 'The switch has happened, so this move cannot be undone. Use Switch back.');
      for (const step of stuck) if (step.state === 'running') saveStep({ ...step, state: 'failed', finished_at: now() });
      for (const step of stuck) if (step.state === 'undo_failed') saveStep({ ...step, state: 'failed' });
      saveMove(applyTransition(move, 'rolling_back', now(), { error: null }));
    } else {
      for (const step of stuck) saveStep(step.state === 'undo_failed' ? { ...step, state: 'failed' } : { ...step, state: 'pending', finished_at: null });
      const undoing = stuck.some(step => step.state === 'undo_failed');
      saveMove(applyTransition(move, switchingBack ? 'switching_back' : undoing ? 'rolling_back' : 'running', now(), { error: null }));
    }
    audit(actor, 'move.resolve', move.site_id, { move: moveId, action });
    return moveView(moveId);
  });
}

export { MoveStateError, describeDuration };
