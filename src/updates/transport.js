// Host updater transport (docs/update-center.md section 2, threat model sections 3 and 4): the only module that touches the
// updater. One bounded JSON request over the Unix socket, and allow-listed reads of service.json, current.json and status.json
// from the read-only mount. Every value is untrusted display data: caps, enums and regexes here, plain text everywhere else.
// It never writes into the updater volume (the mount is read-only) and never decides eligibility.
import net from 'node:net';
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { updaterRunActive } from '../recovery-kit.js';

export const updaterDirectory = process.env.DOCKNEST_UPDATER_DIR || '/run/docknest-updater';
export const PHASES = Object.freeze(['verify', 'preflight', 'fetch', 'idle', 'backup', 'checkout', 'build', 'stop', 'restore-snapshot', 'start', 'health', 'rollback', 'release', 'cleanup', 'done', 'failed']);
export const REFUSALS = Object.freeze(['busy', 'invalid', 'rate-limited', 'version-refused', 'state-mismatch', 'low-disk', 'duplicate', 'stale', 'needs-host-ack']);
export const REASONS = Object.freeze(['tracked-files-edited', 'secret-missing', 'min-upgrade-from', 'compose-invalid', 'tag-missing', 'not-on-main', 'signature-invalid', 'jobs-active', 'backup-failed', 'checkout-failed', 'build-failed', 'pull-failed', 'health-timeout', 'snapshot-restore-failed', 'revert-failed', 'interrupted', 'low-disk', 'state-mismatch', 'tag-moved', 'verify-unavailable', 'time-limit', 'unknown']);
export const BLOCK_REASONS = Object.freeze(['exit-5', 'exit-6', 'interrupted', 'repeated-rollback']);
const ACTIONS = ['upgrade', 'check'], ENV_KEYS = ['docker', 'compose', 'os', 'osVersion', 'kernel', 'arch', 'git', 'cosign', 'disk'];
export const limits = Object.freeze({ fileBytes: 16384, answerBytes: 1024, answerMs: 3000, events: 32, text: 4096, warning: 1024 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, TAG = /^v\d{1,6}\.\d{1,6}\.\d{1,6}$/, SEMVER = /^v?\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/, ENV_VALUE = /^[A-Za-z0-9_.<>-]{1,16}$/;
const CONTROLS = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]', 'g');
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTime = value => typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value));
const isInt = (value, max = 1_000_000) => Number.isInteger(value) && value >= 0 && value <= max;
const text = (value, max) => value === null || value === undefined ? null : typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(CONTROLS, '').slice(0, max) : false;
export const isUuid = value => typeof value === 'string' && UUID.test(value);

// Thrown for socket trouble. delivered is true once the request was written, so the caller can tell "never reached the
// updater" (safe to mark refused) from "no usable answer" (the updater may still run it).
export class TransportError extends Error {
  constructor(code, delivered = false) { super(code); this.code = code; this.delivered = delivered; }
}

export function parseService(value) {
  if (!isObject(value) || value.schema !== 1 || typeof value.version !== 'string' || !SEMVER.test(value.version) || !isInt(value.protocol, 1000)) return null;
  const actions = Array.isArray(value.actions) ? [...new Set(value.actions.filter(action => ACTIONS.includes(action)))] : [];
  const env = {};
  if (isObject(value.env)) for (const key of ENV_KEYS) if (typeof value.env[key] === 'string' && ENV_VALUE.test(value.env[key])) env[key] = value.env[key];
  const exit4 = {};
  if (isObject(value.consecutiveExit4)) for (const [tag, count] of Object.entries(value.consecutiveExit4).slice(0, 64)) if (TAG.test(tag) && isInt(count, 1000)) exit4[tag] = count;
  const blocked = value.blocked === true, last = isObject(value.lastResult) ? value.lastResult : null;
  return {
    version: value.version, protocol: value.protocol, actions, installMode: ['image', 'source'].includes(value.installMode) ? value.installMode : null, env,
    blocked, blockedReason: blocked ? (BLOCK_REASONS.includes(value.blockedReason) ? value.blockedReason : 'unknown') : null, consecutiveExit4: exit4,
    heartbeatAt: isTime(value.heartbeatAt) ? value.heartbeatAt : null, requestId: isUuid(value.requestId) ? value.requestId : null,
    lastResult: last && isUuid(last.requestId) ? {
      requestId: last.requestId, exitCode: isInt(last.exitCode, 255) ? last.exitCode : null, refusal: REFUSALS.includes(last.refusal) ? last.refusal : null,
      reason: typeof last.reason === 'string' ? (REASONS.includes(last.reason) ? last.reason : 'unknown') : null, finishedAt: isTime(last.finishedAt) ? last.finishedAt : null,
    } : null,
  };
}

// Events belong to current.json's request only: unknown phases and unparsable times are dropped, times never go backwards,
// at most 32. Each event is exactly {phase, at}.
export function parseCurrent(value) {
  if (!isObject(value) || !isUuid(value.requestId) || !TAG.test(value.target) || !isTime(value.acceptedAt) || !Array.isArray(value.events)) return null;
  const events = [];
  for (const event of value.events.slice(0, limits.events)) {
    if (!isObject(event) || !PHASES.includes(event.phase) || !isTime(event.at) || (events.length && event.at < events.at(-1).at)) continue;
    events.push({ phase: event.phase, at: event.at });
  }
  return { requestId: value.requestId, target: value.target, acceptedAt: value.acceptedAt, events, truncated: value.truncated === true };
}

// Known fields only; a known field with an invalid value makes the whole document unusable (the broker would have published
// "failed" itself). Unknown fields are dropped.
export function parseStatus(value) {
  if (!isObject(value) || !PHASES.includes(value.phase) || !isUuid(value.requestId)) return null;
  const out = { phase: value.phase, requestId: value.requestId };
  for (const key of ['from', 'to']) { if (value[key] === undefined) continue; if (typeof value[key] !== 'string' || (value[key] && !SEMVER.test(value[key]))) return null; out[key] = value[key]; }
  for (const key of ['startedAt', 'updatedAt']) { if (value[key] === undefined) continue; if (!isTime(value[key])) return null; out[key] = value[key]; }
  if (value.ok !== undefined) { if (![true, false, null].includes(value.ok)) return null; out.ok = value.ok; }
  for (const key of ['error', 'rollbackHint', 'warning']) { if (value[key] === undefined) continue; const clean = text(value[key], key === 'warning' ? limits.warning : limits.text); if (clean === false) return null; out[key] = clean; }
  if (value.reason !== undefined && value.reason !== null) out.reason = REASONS.includes(value.reason) ? value.reason : 'unknown';
  for (const key of ['schemaFrom', 'schemaTo']) { if (value[key] === undefined || value[key] === null) continue; if (!isInt(value[key], 100000)) return null; out[key] = value[key]; }
  return out;
}

export function createTransport({ dir = updaterDirectory, socket = process.env.DOCKNEST_UPDATER_SOCKET || join(dir, 'updater.sock') } = {}) {
  const statusDir = join(dir, 'status');
  async function readJson(name, parse) {
    const file = join(statusDir, name);
    let info;
    try { info = await lstat(file); } catch { return null; }
    if (!info.isFile() || info.size > limits.fileBytes) return null;
    try { return parse(JSON.parse(await readFile(file, 'utf8'))); } catch { return null; }
  }
  // One request: schema 1, action always "upgrade", written then half-closed; the answer is read within 3 s and 1 KiB.
  function submitRequest({ id, version, requestedBy, requestedAt }) {
    return new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({ schema: 1, id, action: 'upgrade', version, requestedBy, requestedAt }));
      const connection = net.createConnection({ path: socket }), chunks = [];
      let sent = false, size = 0, done = false;
      const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); connection.destroy(); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => finish(new TransportError(sent ? 'no-answer' : 'unreachable', sent)), limits.answerMs);
      // The broker reads until the client's half-close. Windows named pipes (development machines only) have none.
      connection.on('connect', () => { sent = true; if (process.platform === 'win32') connection.write(body); else connection.end(body); });
      connection.on('data', chunk => { size += chunk.length; if (size > limits.answerBytes) return finish(new TransportError('invalid-answer', true)); chunks.push(chunk); });
      connection.on('error', () => finish(new TransportError(sent ? 'no-answer' : 'unreachable', sent)));
      connection.on('end', () => {
        let answer;
        try { answer = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return finish(new TransportError('invalid-answer', true)); }
        if (isObject(answer) && answer.accepted === true && answer.id === id) return finish(null, { accepted: true, code: null });
        if (isObject(answer) && answer.accepted === false && REFUSALS.includes(answer.code)) return finish(null, { accepted: false, code: answer.code });
        finish(new TransportError('invalid-answer', true));
      });
    });
  }
  // The socket is only looked up, never connected to (a connect would start the socket-activated broker). Unknown is present.
  async function socketPresent() { try { await lstat(socket); return true; } catch (error) { return !['ENOENT', 'ENOTDIR'].includes(error.code); } }
  return {
    directory: dir, socket, submitRequest, socketPresent,
    readService: () => readJson('service.json', parseService), readCurrent: () => readJson('current.json', parseCurrent), readStatus: () => readJson('status.json', parseStatus),
    // The same guard the recovery-kit restore uses: true while current.json shows an unfinished run.
    runActive: () => updaterRunActive(statusDir),
  };
}
