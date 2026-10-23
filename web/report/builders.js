// One builder per report type (docs/update-center.md sections 7.1 and 13). Each has a constant template, constant field
// ids and a typed allow-list. Builders take structured values only; free text (names, addresses, paths, error text)
// has no field to go into. Every builder adds the DockNest version and the install mode.
import { buildIssueUrl, TITLE, URL_LIMIT } from './core.js';
import { excerptFrom, excerptOk, redact, limitExcerpt } from './redact.js';
import { whatHappened, whatHappenedOk } from './catalogue.js';

export const VERSION = /^v\d{1,4}\.\d{1,4}\.\d{1,6}$/;
export const INSTALL_MODES = ['image', 'source'];
const MAJOR_MINOR = /^\d{1,3}\.\d{1,3}$/;
const OS_IDS = ['debian', 'ubuntu', 'fedora', 'rhel', 'centos', 'rocky', 'almalinux', 'alpine', 'arch', 'opensuse', 'sles', 'amzn', 'raspbian', 'ol'];
const OS = v => v === 'other' || OS_IDS.some(id => new RegExp('^' + id + '-\\d{1,3}$').test(v));
export const ARCHES = ['amd64', 'arm64', 'other'];
export const DISK_BUCKETS = ['<2GiB', '2-10GiB', '10-50GiB', '>50GiB'];
// Environment field ids, shared by every admin report and the issue templates.
export const ENV_FIELDS = { docker: MAJOR_MINOR, compose: MAJOR_MINOR, git: MAJOR_MINOR, cosign: /^v?\d{1,3}\.\d{1,3}\.\d{1,4}$/, os: OS, kernel: MAJOR_MINOR, arch: ARCHES, free_disk: DISK_BUCKETS };
const BASE_FIELDS = { title: TITLE, version: VERSION, install_mode: INSTALL_MODES };
const ENV_LABEL = { docker: 'Docker', compose: 'Compose', git: 'git', cosign: 'cosign', os: 'OS', kernel: 'Kernel', arch: 'Architecture', free_disk: 'Free disk' };

export const normVersion = v => { const m = /^v?(\d{1,4}\.\d{1,4}\.\d{1,6})$/.exec(typeof v === 'string' ? v.trim() : ''); return m ? 'v' + m[1] : null; };
const pick = (rule, v) => (typeof v === 'string' && (Array.isArray(rule) ? rule.includes(v) : rule instanceof RegExp ? new RegExp('^(?:' + rule.source + ')$').test(v) : rule(v)) ? v : null);
const majorMinor = v => { const m = /^(\d{1,3})\.(\d{1,3})/.exec(typeof v === 'string' ? v : ''); return m ? m[1] + '.' + m[2] : null; };
// The broker's coarse `env` object (service.json, docs/updater-threat-model.md section 8) to report fields.
export function environmentFields(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  const os = typeof env.os === 'string' && /^[a-z]{1,16}$/.test(env.os) ? (OS_IDS.includes(env.os) && /^\d{1,3}/.test(String(env.osVersion ?? '')) ? env.os + '-' + /^\d{1,3}/.exec(String(env.osVersion))[0] : 'other') : null;
  const arch = typeof env.arch === 'string' ? (env.arch === 'amd64' || env.arch === 'x86_64' ? 'amd64' : env.arch === 'arm64' || env.arch === 'aarch64' ? 'arm64' : 'other') : null;
  const out = { docker: majorMinor(env.docker), compose: majorMinor(env.compose), git: majorMinor(env.git), cosign: pick(ENV_FIELDS.cosign, env.cosign), os, kernel: majorMinor(env.kernel), arch, free_disk: pick(DISK_BUCKETS, env.disk ?? env.free_disk) };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
}

// Shared assembly: base fields, the area's fields, then the environment section when included.
function assemble({ template, title, version, installMode, fields, allow, labels, env, includeEnvironment = true, extra = {} }) {
  const v = normVersion(version), mode = INSTALL_MODES.includes(installMode) ? installMode : null;
  const envFields = environmentFields(env), withEnv = includeEnvironment && Object.keys(envFields).length > 0;
  const all = { title, version: v, install_mode: mode, ...fields, ...(withEnv ? envFields : {}), ...extra };
  const allowList = { ...BASE_FIELDS, ...allow, ...ENV_FIELDS, ...(extra.excerpt !== undefined ? { excerpt: excerptOk } : {}), ...(fields.what_happened !== undefined ? { what_happened: v => whatHappenedOk(v) || excerptOk(v) } : {}) };
  const { href, sent } = buildIssueUrl(template, all, allowList);
  const sentMap = Object.fromEntries(sent);
  const shared = [['Title', sentMap.title], ['DockNest', [sentMap.version, sentMap.install_mode].filter(Boolean).join(' · ') || 'Not available']];
  for (const [id, label] of Object.entries(labels)) if (sentMap[id] !== undefined) shared.push([label, sentMap[id]]);
  // Only a catalogue-built text is listed in the review; an opt-in excerpt is shown in its own editable box.
  if (whatHappenedOk(sentMap.what_happened)) shared.push(['What happened', sentMap.what_happened]);
  const environment = Object.entries(envFields).map(([id, value]) => [ENV_LABEL[id], value]);
  return { template, title: sentMap.title, href, sent, shared, environment, environmentIncluded: withEnv, version: sentMap.version || null, installMode: sentMap.install_mode || null };
}

// Report a bug (Settings > About, every signed-in user): version and install mode only. Same output as 2.2.0.
export const BUG_TEMPLATE = 'bug-report.yml';
export function buildBugReport({ version, installMode } = {}) {
  const v = normVersion(version), mode = INSTALL_MODES.includes(installMode) ? installMode : null;
  const r = assemble({ template: BUG_TEMPLATE, title: 'Bug report: DockNest' + (v ? ' ' + v : ''), version, installMode, fields: {}, allow: {}, labels: {}, env: null, includeEnvironment: false });
  return { ...r, version: v, installMode: mode, fields: [['DockNest version', v || 'Not available'], ['Install mode', mode ? (mode === 'source' ? 'source (git checkout)' : 'image') : 'Not available']] };
}

// "What happened?" (2.4.1): the catalogue text when the message is one of DockNest's own fixed messages, otherwise only the
// redacted excerpt the person opted into. The URL falls back to no text (and Copy excerpt) when it would be too long.
function withWhat({ message, explanation, excerpt }, make) {
  const auto = whatHappened(message, explanation);
  const cleaned = !auto && typeof excerpt === 'string' && excerpt.trim() ? limitExcerpt(redact(excerpt)) : null;
  const text = auto || cleaned;
  let report = null, tooLong = false;
  if (text) { try { report = make(text); } catch (e) { if (e.code !== 'TOO_LONG') throw e; tooLong = true; } }
  if (!report) report = make(null);
  return { ...report, whatHappened: auto, excerpt: cleaned, excerptIncluded: !!cleaned && !tooLong, excerptTooLong: !!cleaned && tooLong };
}

// Failed and recovery-required jobs (job-failure.yml). Existing structured fields only.
export const JOB_TYPES = ['backup', 'restore', 'scrub'];
export const JOB_PHASES = ['prep', 'finalCheck', 'stop', 'start', 'commit', 'save', 'pack', 'send', 'verify', 'health', 'same', 'fail', 'other'];
export const JOB_OUTCOMES = ['failed', 'recovery-required'];
export const JOB_ENDINGS = ['worker-interrupted', 'helper-stopped'];
export const SITE_KINDS = ['docker', 'static'];
export const STORAGE_TYPES = ['local', 'sftp', 's3'];
export const CONTAINER_BUCKETS = ['1', '2-5', '6-10', '>10'];
export const HELPER_OUTCOMES = ['timeout', 'failure', 'exit'];
export const containerBucket = n => (Number.isInteger(n) && n >= 1 ? (n === 1 ? '1' : n <= 5 ? '2-5' : n <= 10 ? '6-10' : '>10') : null);
const JOB_NAME = { backup: 'Backup', restore: 'Restore', scrub: 'Integrity check' };
export function buildJobReport({ version, installMode, env, includeEnvironment = true, jobType, outcome, phase, ended, siteKind, storage, containers, helperOutcome, message, explanation, excerpt } = {}) {
  const type = pick(JOB_TYPES, jobType), out = pick(JOB_OUTCOMES, outcome) || 'failed', ph = pick(JOB_PHASES, phase);
  const title = (type ? JOB_NAME[type] : 'Job') + (out === 'recovery-required' ? ' needs recovery review' : ' failed') + (ph ? ': ' + ph + ' step' : '');
  const fields = { job_type: type, outcome: out, phase: ph, ended: out === 'recovery-required' ? pick(JOB_ENDINGS, ended) : null, site_kind: pick(SITE_KINDS, siteKind), storage: pick(STORAGE_TYPES, storage), containers: Number.isInteger(containers) ? containerBucket(containers) : pick(CONTAINER_BUCKETS, containers), helper_outcome: pick(HELPER_OUTCOMES, helperOutcome) };
  return withWhat({ message, explanation, excerpt }, what => assemble({ template: 'job-failure.yml', title, version, installMode, env, includeEnvironment, fields: { ...fields, what_happened: what },
    allow: { job_type: JOB_TYPES, outcome: JOB_OUTCOMES, phase: JOB_PHASES, ended: JOB_ENDINGS, site_kind: SITE_KINDS, storage: STORAGE_TYPES, containers: CONTAINER_BUCKETS, helper_outcome: HELPER_OUTCOMES },
    labels: { job_type: 'Job', outcome: 'Outcome', phase: 'Failed at', ended: 'How it ended', site_kind: 'Site kind', storage: 'Storage', containers: 'Containers', helper_outcome: 'Helper outcome' } }));
}

// Storage target test failures (storage-failure.yml). Never the endpoint, bucket, host or port.
export const SFTP_CLASSES = ['host-key-mismatch', 'auth-failed', 'dns', 'refused', 'timeout', 'sftp-start', 'other'];
export const S3_CLASSES = ['AccessDenied', 'NoSuchBucket', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AuthorizationHeaderMalformed', 'PermanentRedirect', 'InvalidBucketName', 'ObjectLockConfigurationNotFoundError', 'NotImplemented', 'MethodNotAllowed', 'NotFound', 'SlowDown', 'InternalError', 'ServiceUnavailable', 'RequestTimeTooSkewed', 'Unreachable', 'other'];
export function buildStorageReport({ version, installMode, env, includeEnvironment = true, protocol, errorClass, message, explanation, excerpt } = {}) {
  const p = pick(['sftp', 's3'], protocol), cls = p ? pick(p === 'sftp' ? SFTP_CLASSES : S3_CLASSES, errorClass) || 'other' : null;
  return withWhat({ message, explanation, excerpt }, what => assemble({ template: 'storage-failure.yml', title: 'Storage test failed' + (p ? ': ' + p : '') + (cls ? ' (' + cls + ')' : ''), version, installMode, env, includeEnvironment,
    fields: { protocol: p, error_class: cls, what_happened: what }, allow: { protocol: ['sftp', 's3'], error_class: [...SFTP_CLASSES, ...S3_CLASSES] }, labels: { protocol: 'Protocol', error_class: 'Error class' } }));
}

// Server connection tests (server-connection.yml). Never the address.
export const SERVER_CHECKS = ['ssh', 'host-key', 'python', 'docker'];
export const SERVER_CLASSES = ['host-key-mismatch', 'auth-failed', 'dns', 'refused', 'timeout', 'not-found', 'helper-error', 'other'];
export function buildServerReport({ version, installMode, env, includeEnvironment = true, check, errorClass, message, explanation, excerpt } = {}) {
  const c = pick(SERVER_CHECKS, check), cls = pick(SERVER_CLASSES, errorClass) || (c ? 'other' : null);
  return withWhat({ message, explanation, excerpt }, what => assemble({ template: 'server-connection.yml', title: 'Server connection test failed' + (c ? ': ' + c : '') + (cls ? ' (' + cls + ')' : ''), version, installMode, env, includeEnvironment,
    fields: { check: c, error_class: cls, what_happened: what }, allow: { check: SERVER_CHECKS, error_class: SERVER_CLASSES }, labels: { check: 'Failed check', error_class: 'Error class' } }));
}

// DockNest self-backup failures (self-backup-failure.yml). The phase is not recorded yet (engine work); how it ended is.
export const SELF_BACKUP_DESTINATIONS = ['sftp', 's3', 'local'];
export const SELF_BACKUP_ENDINGS = ['failed', 'worker-interrupted', 'deployment-hold'];
export function buildSelfBackupReport({ version, installMode, env, includeEnvironment = true, destination, ended, message, explanation, excerpt } = {}) {
  const d = pick(SELF_BACKUP_DESTINATIONS, destination), e = pick(SELF_BACKUP_ENDINGS, ended) || 'failed';
  return withWhat({ message, explanation, excerpt }, what => assemble({ template: 'self-backup-failure.yml', title: 'DockNest backup failed' + (d ? ': ' + d : ''), version, installMode, env, includeEnvironment,
    fields: { destination: d, ended: e, what_happened: what }, allow: { destination: SELF_BACKUP_DESTINATIONS, ended: SELF_BACKUP_ENDINGS }, labels: { destination: 'Destination', ended: 'How it ended' } }));
}

// Unexpected app errors (app-error.yml): route name, area and error name. Never the message or stack.
export const APP_ROUTES = ['overview', 'servers', 'sites', 'backups', 'jobs', 'audit', 'maintenance', 'storage', 'self-backup', 'update-center', 'access', 'system-health', 'other'];
export const APP_AREAS = ['page', 'dialog', 'shell'];
export const ERROR_NAMES = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError', 'InvalidStateError', 'NotFoundError', 'NotAllowedError', 'AbortError', 'QuotaExceededError', 'SecurityError', 'other'];
export const errorName = e => { const n = e && typeof e === 'object' ? e.name : null; return ERROR_NAMES.includes(n) ? n : 'other'; };
export function buildAppErrorReport({ version, installMode, env, includeEnvironment = true, route, area, error } = {}) {
  const r = pick(APP_ROUTES, route) || 'other', a = pick(APP_AREAS, area) || 'page', n = error && typeof error === 'object' ? errorName(error) : pick(ERROR_NAMES, error) || 'other';
  return assemble({ template: 'app-error.yml', title: 'App error: ' + n + ' on ' + r, version, installMode, env, includeEnvironment,
    fields: { route: r, area: a, error_name: n }, allow: { route: APP_ROUTES, area: APP_AREAS, error_name: ERROR_NAMES }, labels: { route: 'Page', area: 'Area', error_name: 'Error type' } });
}

// Update failures (update-failure.yml, section 7.1).
export const UPDATE_OUTCOMES = ['rolled_back', 'needs_action', 'not_changed', 'lost'];
export const STAGE_IDS = ['verify', 'prepare', 'protect', 'install', 'confirm'];
export const PHASE_IDS = ['verify', 'preflight', 'fetch', 'idle', 'backup', 'checkout', 'build', 'stop', 'restore-snapshot', 'start', 'health', 'rollback', 'release', 'cleanup'];
const STAGE_OF = { verify: 'verify', preflight: 'prepare', fetch: 'prepare', idle: 'protect', backup: 'protect', checkout: 'install', build: 'install', stop: 'install', 'restore-snapshot': 'install', start: 'install', health: 'confirm', rollback: 'confirm', release: 'confirm', cleanup: 'confirm' };
// The fixed refusal codes of the broker (src/updates/transport.js REFUSALS).
export const REFUSAL_CODES = ['busy', 'invalid', 'rate-limited', 'version-refused', 'state-mismatch', 'low-disk', 'duplicate', 'stale', 'needs-host-ack'];
export const RESULTS = ['exit-1', 'exit-2', 'exit-3', 'exit-4', 'exit-5', 'exit-6', 'stale', 'lost', ...REFUSAL_CODES.map(c => 'refused-' + c)];
// Section 7.1 codes plus the codes the 2.2.0 broker and upgrade.sh already write (src/updates/transport.js REASONS).
export const REASON_CODES = [...new Set(['verify-signature-invalid', 'verify-not-on-main', 'verify-manifest-mismatch', 'state-mismatch', 'low-disk', 'fetch-failed', 'jobs-did-not-finish', 'checkout-failed', 'pull-failed', 'build-failed', 'start-failed', 'migration-failed', 'health-timeout-api', 'health-timeout-worker', 'rollback-failed', 'interrupted', 'runtime-limit',
  'tracked-files-edited', 'secret-missing', 'min-upgrade-from', 'compose-invalid', 'tag-missing', 'not-on-main', 'signature-invalid', 'jobs-active', 'backup-failed', 'health-timeout', 'snapshot-restore-failed', 'revert-failed', 'tag-moved', 'verify-unavailable', 'time-limit', 'unknown'])];
const TIMELINE_LINE = /^(?:[a-z-]{2,16} \d{1,6} \d{1,6}|earlier steps omitted)$/;
const timelineOk = v => { const lines = v.split('\n'); return lines.length <= 33 && lines.every(l => TIMELINE_LINE.test(l) && (l === 'earlier steps omitted' || PHASE_IDS.includes(l.split(' ')[0]))); };
const iso = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v) ? Date.parse(v) : NaN);
// One line per event: phase id, seconds since the run was accepted, duration in seconds. No clock times.
export function timelineLines(events, acceptedAt, finishedAt) {
  const list = (Array.isArray(events) ? events : []).filter(e => e && PHASE_IDS.includes(e.phase) && Number.isFinite(iso(e.at))).slice(0, 32);
  const t0 = Number.isFinite(iso(acceptedAt)) ? iso(acceptedAt) : list.length ? iso(list[0].at) : NaN, end = iso(finishedAt);
  if (!Number.isFinite(t0)) return [];
  return list.map((e, i) => { const at = iso(e.at), next = i + 1 < list.length ? iso(list[i + 1].at) : end; const since = Math.max(0, Math.round((at - t0) / 1000)), dur = Number.isFinite(next) ? Math.max(0, Math.round((next - at) / 1000)) : 0; return `${e.phase} ${Math.min(since, 999999)} ${Math.min(dur, 999999)}`; });
}
// Maps the admin status of one run (GET /api/updates/status) to the outcome and result classes.
export function updateOutcome(status, view) {
  const state = status?.state, code = Number.isInteger(status?.exitCode) ? status.exitCode : null;
  const stale = view === 'stale' || (status?.stale === true && state === 'running');
  const outcome = stale ? null : state === 'refused' || state === 'busy' ? 'not_changed' : pick(UPDATE_OUTCOMES, state);
  let result = null;
  if (stale) result = 'stale';
  else if (state === 'lost') result = 'lost';
  else if (pick(REFUSAL_CODES, status?.refusal)) result = 'refused-' + status.refusal;
  else if (code !== null && code >= 1 && code <= 6) result = 'exit-' + code;
  return { outcome, result };
}
const OUTCOME_TEXT = { rolled_back: 'rolled back', needs_action: 'needs manual action', not_changed: 'not changed', lost: 'closed without a result' };
export function buildUpdateReport({ version, installMode, env, includeEnvironment = true, status = {}, view, lastPhase, excerpt } = {}) {
  const from = normVersion(status.from), to = normVersion(status.to), { outcome, result } = updateOutcome(status, view);
  const phases = (Array.isArray(status.events) ? status.events : []).map(e => e?.phase).filter(p => PHASE_IDS.includes(p) && p !== 'rollback');
  const phase = pick(PHASE_IDS, lastPhase) && lastPhase !== 'rollback' ? lastPhase : phases.at(-1) || (pick(PHASE_IDS, status.phase) && status.phase !== 'rollback' ? status.phase : null);
  const fromSchema = Number.isInteger(status.fromSchema) && status.fromSchema >= 0 ? status.fromSchema : null, toSchema = Number.isInteger(status.toSchema) && status.toSchema >= 0 ? status.toSchema : null;
  const reason = typeof status.reason === 'string' ? (REASON_CODES.includes(status.reason) ? status.reason : 'unknown') : null;
  const mode = INSTALL_MODES.includes(status.installMode) ? status.installMode : installMode;
  const runEnv = status.env && typeof status.env === 'object' && Object.keys(status.env).length ? status.env : env;
  const title = 'Update failed: ' + (from || 'unknown') + ' to ' + (to || 'unknown') + ' (' + (OUTCOME_TEXT[outcome] || (result === 'stale' ? 'no progress' : 'unknown')) + ')';
  const fields = { from_version: from, to_version: to, outcome, result, stage: phase ? STAGE_OF[phase] : null, phase, install_mode: mode, updater_version: normVersion(status.updaterVersion), reason,
    migration_ran: fromSchema !== null && toSchema !== null ? (toSchema > fromSchema ? 'yes' : 'no') : null, schema: fromSchema !== null && toSchema !== null ? `v${fromSchema} to v${toSchema}` : null };
  const allow = { from_version: VERSION, to_version: VERSION, outcome: UPDATE_OUTCOMES, result: RESULTS, stage: STAGE_IDS, phase: PHASE_IDS, updater_version: VERSION, reason: REASON_CODES, migration_ran: ['yes', 'no'], schema: /^v\d{1,4} to v\d{1,4}$/, timeline: timelineOk };
  const labels = { outcome: 'Outcome', result: 'Result', stage: 'Failed stage', phase: 'Failed phase', reason: 'Reason', schema: 'Database', updater_version: 'Updater' };
  let lines = timelineLines(status.events, status.acceptedAt ?? status.startedAt, status.updatedAt);
  const cleaned = typeof excerpt === 'string' && excerpt.trim() ? limitExcerpt(redact(excerpt)) : null;
  const make = (tl, ex) => assemble({ template: 'update-failure.yml', title, version, installMode: mode, env: runEnv, includeEnvironment, fields: { ...fields, timeline: tl.length ? tl.join('\n') : null }, allow, labels, extra: ex ? { excerpt: ex } : {} });
  // The timeline gives way first (oldest lines dropped, with a fixed note); the excerpt then falls back to Copy excerpt.
  const fit = ex => { let tl = lines; for (;;) { try { return { report: make(tl, ex), timeline: tl }; } catch (e) { if (e.code !== 'TOO_LONG') throw e; const real = tl.filter(l => l !== 'earlier steps omitted'); if (ex || real.length === 0) return null; tl = ['earlier steps omitted', ...real.slice(1)]; } } };
  let excerptTooLong = false, built = cleaned ? fit(cleaned) : null;
  if (cleaned && !built) excerptTooLong = true;
  if (!built) built = fit(null);
  if (!built) throw new Error('Report URL too long');
  return { ...built.report, timeline: built.timeline, excerpt: cleaned, excerptIncluded: !!cleaned && !excerptTooLong, excerptTooLong, limit: URL_LIMIT };
}
export { excerptFrom };

// Field ids each template must define (checked against the YAML files by tests/problem-reports.test.js).
const ENV_IDS = Object.keys(ENV_FIELDS);
export const TEMPLATE_FIELDS = Object.freeze({
  'bug-report.yml': ['version', 'install_mode'],
  'job-failure.yml': ['version', 'install_mode', 'job_type', 'outcome', 'phase', 'ended', 'site_kind', 'storage', 'containers', 'helper_outcome', 'what_happened', ...ENV_IDS],
  'storage-failure.yml': ['version', 'install_mode', 'protocol', 'error_class', 'what_happened', ...ENV_IDS],
  'server-connection.yml': ['version', 'install_mode', 'check', 'error_class', 'what_happened', ...ENV_IDS],
  'self-backup-failure.yml': ['version', 'install_mode', 'destination', 'ended', 'what_happened', ...ENV_IDS],
  'app-error.yml': ['version', 'install_mode', 'route', 'area', 'error_name', ...ENV_IDS],
  'update-failure.yml': ['version', 'install_mode', 'from_version', 'to_version', 'outcome', 'result', 'stage', 'phase', 'timeline', 'updater_version', 'reason', 'migration_ran', 'schema', 'excerpt', ...ENV_IDS],
});
