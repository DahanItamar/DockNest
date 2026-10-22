// In-app upgrade requests (docs/update-center.md sections 4, 6 and 7). One service owns the update_requests rows and the
// in-memory snapshot that the public progress endpoint and the 423 lock read, so neither adds a database read per request.
// The snapshot is refreshed by sync(): read the updater's status files, reconcile the active row, rebuild. Only the API
// writes these rows; the broker's own history stays authoritative. Everything read from the updater is untrusted text.
import { db, audit, transaction, id as newId } from '../db.js';
import { createTransport, PHASES, REASONS } from './transport.js';

export const timing = Object.freeze({
  syncMs: 2000, heartbeatMs: 120_000, phaseMs: 15 * 60_000, buildMs: 45 * 60_000,
  // The broker's per-run hard stop (2 h), its 15 min grace, then 5 min more, measured from acceptedAt.
  lostMs: (2 * 3600 + 15 * 60 + 5 * 60) * 1000, recentMs: 24 * 3600 * 1000, settleMs: 10_000,
});
const ACTIVE = "('submitted','running','needs_action')";
const PUBLIC_STATE = { submitted: 'running', running: 'running', succeeded: 'succeeded', rolled_back: 'rolled_back', refused: 'not_changed', busy: 'not_changed', needs_action: 'needs_action', resolved: 'resolved', lost: 'lost' };
const EXIT_STATE = { 0: 'succeeded', 1: 'refused', 2: 'refused', 3: 'busy', 4: 'rolled_back', 5: 'needs_action', 6: 'needs_action' };
const clip = (value, max) => typeof value === 'string' && value ? value.slice(0, max) : null;
const ms = value => Date.parse(value);
const iso = at => new Date(at).toISOString();
const EMPTY = Object.freeze({ active: false, phase: null, to: null, state: null, stale: false, updatedAt: null, events: Object.freeze([]) });

export function recoveryReviewPending(database = db) {
  try {
    const jobs = database.prepare("SELECT (SELECT COUNT(*) FROM jobs WHERE status='recovery_required')+(SELECT COUNT(*) FROM restores WHERE status='recovery_required')+(SELECT COUNT(*) FROM artifact_operations WHERE state IN ('prepared','authenticated'))+(SELECT COUNT(*) FROM retention_operations) AS count").get().count;
    let reconciliation = {};
    try { reconciliation = JSON.parse(database.prepare("SELECT value FROM settings WHERE key='artifact_reconciliation'").get()?.value || '{}'); } catch { /* Unreadable means not pending. */ }
    return jobs > 0 || Boolean(reconciliation.pending);
  } catch { return false; }
}

export function createUpdateService({ release, transport = createTransport(), now = Date.now, log = message => console.warn(message) }) {
  let files = { service: null, current: null, status: null, socket: true };
  let snapshot = { locked: false, stale: false, progress: EMPTY, active: null, latest: null };
  let ended = new Set(), chain = Promise.resolve();
  const select = "SELECT r.*,u.name AS user_name,u.email AS user_email FROM update_requests r LEFT JOIN users u ON u.id=r.requested_by";
  const activeRow = () => db.prepare(`${select} WHERE r.state IN ${ACTIVE}`).get() ?? null;
  const latestRow = () => db.prepare(`${select} ORDER BY r.requested_at DESC,r.rowid DESC LIMIT 1`).get() ?? null;
  const eventsOf = requestId => db.prepare('SELECT phase,at FROM update_events WHERE request_id=? ORDER BY at,rowid LIMIT 32').all(requestId).map(({ phase, at }) => ({ phase, at }));

  function staleOf(row, events) {
    if (row.state !== 'running') return false;
    const t = now(), mine = files.current?.requestId === row.id ? files.current : null, service = files.service, status = files.status?.requestId === row.id ? files.status : null;
    const base = ms(mine?.acceptedAt ?? row.accepted_at ?? row.requested_at);
    const beat = service?.requestId === row.id && service.heartbeatAt ? ms(service.heartbeatAt) : null;
    const phase = status?.phase ?? events.at(-1)?.phase, changed = events.length ? ms(events.at(-1).at) : base;
    // One rule (D13): no heartbeat for 2 minutes (a missing one counts as none), or no phase change for 15 minutes (45 in build).
    return t - (beat ?? base) > timing.heartbeatMs || t - changed > (phase === 'build' ? timing.buildMs : timing.phaseMs);
  }

  function adminStatus(row, events, stale) {
    const running = ['submitted', 'running'].includes(row.state), status = files.status?.requestId === row.id ? files.status : null;
    const startedAt = row.accepted_at ?? row.requested_at;
    return {
      requestId: row.id, from: row.from_version, to: row.to_version, requestedBy: { id: row.requested_by, name: row.user_name || row.user_email || null },
      phase: running ? (status?.phase ?? events.at(-1)?.phase ?? null) : (events.at(-1)?.phase ?? null), startedAt,
      updatedAt: running ? (status?.updatedAt ?? events.at(-1)?.at ?? startedAt) : (row.finished_at ?? startedAt), stale, state: row.state, exitCode: row.exit_code,
      error: running ? null : row.error, rollbackHint: running ? null : row.rollback_hint, warning: running ? clip(status?.warning, 1024) : row.warning,
    };
  }

  // Rebuilds the snapshot from the database plus the last files read. Cheap; also called after every local change.
  function rebuild() {
    const active = activeRow(), row = active ?? latestRow();
    if (!row) { snapshot = { locked: false, stale: false, progress: EMPTY, active: null, latest: null }; return snapshot; }
    const events = eventsOf(row.id), stale = staleOf(row, events), admin = adminStatus(row, events, stale);
    const recent = Boolean(active) || (row.finished_at && now() - ms(row.finished_at) <= timing.recentMs);
    const progress = recent ? Object.freeze({
      active: Boolean(active), phase: PHASES.includes(admin.phase) ? admin.phase : null, to: row.to_version, state: PUBLIC_STATE[row.state], stale, updatedAt: admin.updatedAt,
      events: Object.freeze(events.map(event => Object.freeze({ phase: event.phase, at: event.at }))),
    }) : EMPTY;
    snapshot = { locked: Boolean(active), stale, progress, active: active ? admin : null, latest: admin };
    return snapshot;
  }

  function finalize(row, state, { code = null, reason = null, status = null, refusal = null } = {}) {
    db.prepare('UPDATE update_requests SET state=?,finished_at=COALESCE(finished_at,?),exit_code=?,refusal=?,reason=COALESCE(?,reason),to_schema=COALESCE(?,to_schema),warning=?,error=?,rollback_hint=? WHERE id=?')
      .run(state, iso(now()), code, refusal, REASONS.includes(reason ?? status?.reason) ? (reason ?? status.reason) : null, status?.schemaTo ?? null, clip(status?.warning, 1024), state === 'succeeded' ? null : clip(status?.error, 2048), state === 'succeeded' ? null : clip(status?.rollbackHint, 4096), row.id);
    audit('system', 'updater.finished', row.id, { state, exitCode: code });
    ended.add(row.id);
  }

  function reconcile() {
    const settled = ended; ended = new Set();
    const row = activeRow();
    if (!row) return;
    const t = now(), { service, current, status: any } = files;
    const mine = current?.requestId === row.id ? current : null, status = any?.requestId === row.id ? any : null;
    const result = service?.lastResult?.requestId === row.id ? service.lastResult : null, brokerActive = service?.requestId === row.id;
    if (row.state === 'needs_action') {
      // The lock ends only when the broker itself shows blocked:false (sudo scripts/install-updater.sh --ack). No service.json keeps it.
      if (service && service.blocked === false && !settled.has(row.id)) { db.prepare("UPDATE update_requests SET state='resolved' WHERE id=? AND state='needs_action'").run(row.id); audit('system', 'updater.resolved', row.id, {}); }
      return;
    }
    if (mine) {
      if (!row.accepted_at) db.prepare('UPDATE update_requests SET accepted_at=? WHERE id=?').run(mine.acceptedAt, row.id);
      for (const event of mine.events) db.prepare('INSERT OR IGNORE INTO update_events(request_id,at,phase) VALUES(?,?,?)').run(row.id, event.at, event.phase);
    }
    if (row.state === 'submitted' && (mine || status)) { db.prepare("UPDATE update_requests SET state='running' WHERE id=? AND state='submitted'").run(row.id); row.state = 'running'; }
    if (result) {
      const state = EXIT_STATE[result.exitCode] ?? 'needs_action';
      return finalize(row, state, { code: result.exitCode, reason: result.reason, status });
    }
    // A final status without the broker's result (it publishes status first): wait a moment for lastResult, then take the status.
    const final = status && !brokerActive && (status.ok === false || (status.ok === true && ['cleanup', 'done'].includes(status.phase)));
    if (final && status.updatedAt && t - ms(status.updatedAt) >= timing.settleMs) return finalize(row, status.ok ? 'succeeded' : 'needs_action', { code: status.ok ? 0 : null, status });
    // Reconciliation: no trace of the request, but the running release is the target (the new API answers /api/version).
    if (!mine && !status && !brokerActive && 'v' + release.version === row.to_version) return finalize(row, 'succeeded', { code: 0 });
    // The API closes a dead request itself once it is stale and past the broker's hard stop plus 5 minutes since acceptedAt.
    if (row.state === 'running' && mine && staleOf(row, eventsOf(row.id)) && t - ms(mine.acceptedAt) > timing.lostMs) return finalize(row, 'lost');
  }

  async function run() {
    try {
      const [service, current, status, socket] = await Promise.all([transport.readService(), transport.readCurrent(), transport.readStatus(), transport.socketPresent()]);
      files = { service, current, status, socket };
      if (activeRow()) transaction(reconcile);
    } catch (error) { log(`Update status refresh failed: ${error.message}`); }
    return rebuild();
  }
  const sync = () => (chain = chain.then(run, run));

  function updaterInfo() {
    const service = files.service, present = Boolean(service);
    return {
      present, version: service?.version ?? null, supported: Boolean(service && service.protocol === 1 && service.actions.includes('upgrade')), selfUpdateFailed: false, blocked: service?.blocked ?? false,
      status: !present ? 'not-installed' : service.blocked ? 'blocked' : !files.socket || snapshot.stale ? 'not-responding' : 'connected', lastHeartbeatAt: service?.heartbeatAt ?? null,
      consecutiveExit4: service?.consecutiveExit4 ?? {}, blockedReason: service?.blockedReason ?? null, installMode: service?.installMode ?? null, env: service?.env ?? {},
    };
  }

  // The submit row is inserted before the request is sent and finished from the answer, so the lock (which reads the
  // snapshot) is on for the whole exchange and one unique index allows a single active request.
  function create({ user, version, retryOf = null }) {
    const requestId = newId(), service = files.service;
    try {
      transaction(() => {
        db.prepare('INSERT INTO update_requests(id,from_version,to_version,from_schema,requested_by,requested_at,retry_of,install_mode,updater_version,env,state) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(requestId, release.version, version, release.schemaVersion, user.id, iso(now()), retryOf, service?.installMode ?? null, service?.version ?? null, service && JSON.stringify(service.env).length <= 1024 ? JSON.stringify(service.env) : null, 'submitted');
        audit(user.id, 'updater.requested', requestId, { from: release.version, to: version, retryOf });
      });
    } catch (error) { if (/UNIQUE|constraint/i.test(error.message)) return null; throw error; }
    rebuild();
    return requestId;
  }
  async function send(requestId, version, user) {
    const requestedAt = db.prepare('SELECT requested_at FROM update_requests WHERE id=?').get(requestId).requested_at;
    const answer = await transport.submitRequest({ id: requestId, version, requestedBy: user.id, requestedAt });
    if (answer.accepted) db.prepare('UPDATE update_requests SET accepted_at=COALESCE(accepted_at,?) WHERE id=?').run(iso(now()), requestId);
    return answer;
  }
  function refuse(requestId, refusal) {
    db.prepare("UPDATE update_requests SET state='refused',refusal=?,finished_at=? WHERE id=? AND state='submitted'").run(refusal, iso(now()), requestId);
    audit('system', 'updater.refused', requestId, { refusal }); rebuild();
  }
  // "I checked the host, close this record": only the active request, only a running one the server snapshot calls stale.
  async function acknowledge(requestId, user) {
    await sync();
    const row = activeRow();
    if (!row || row.id !== requestId || row.state !== 'running' || !snapshot.stale) return false;
    db.prepare("UPDATE update_requests SET state='lost',finished_at=? WHERE id=? AND state='running'").run(iso(now()), requestId);
    audit(user.id, 'updater.acknowledged', requestId, {}); rebuild();
    return true;
  }
  return {
    sync, rebuild, create, send, refuse, acknowledge, updaterInfo, transport, activeRow, latestRow,
    snapshot: () => snapshot, locked: () => snapshot.locked, progress: () => snapshot.progress,
    start() { const timer = setInterval(() => { sync(); }, timing.syncMs); timer.unref(); rebuild(); sync(); return timer; },
  };
}
