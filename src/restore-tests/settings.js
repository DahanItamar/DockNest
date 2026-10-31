// Restore test settings per site (docs/restore-tests.md, "Choosing the test server", "Which backup and when" and
// "API contract"). No row means off, so an upgraded install behaves exactly as before until an administrator turns
// tests on. Settings hold no secrets: a server id, switches, three numbers and an optional internal web check.
import { z } from 'zod';
import { db, audit } from '../db.js';
import { validateLimits, LIMIT_DEFAULTS } from './limits.js';
import { testTransport } from './engine.js';

export const CADENCE_DAYS = Object.freeze({ daily: 1, weekly: 7, monthly: 30 });
// Tests run this long after the site's next scheduled backup, so they normally check a fresh backup.
export const AFTER_BACKUP_MS = 30 * 60_000;
const DAY_MS = 86_400_000;
const httpError = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const iso = ms => new Date(ms).toISOString();

const container = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
// The same path rule the helper applies (remote/helper/restore_test.py TEST_PATH): an absolute path with plain URL characters.
const probePath = z.string().max(200).regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/, 'The health check path must start with / and use plain URL characters.');
const probeSchema = z.object({ service: container.nullable().optional(), port: z.number().int().min(1).max(65535).nullable().optional(), path: probePath.optional() }).strict()
  .transform(value => ({ service: value.service ?? null, port: value.port ?? null, path: value.path || '/' }));
export const settingsInput = z.object({
  enabled: z.boolean(), cadence: z.enum(['daily', 'weekly', 'monthly']), serverId: z.uuid().nullable(),
  allowLiveServer: z.boolean().default(false), allowInternet: z.boolean().default(false),
  timeLimitMinutes: z.number().default(LIMIT_DEFAULTS.timeLimitMinutes), memoryMb: z.number().default(LIMIT_DEFAULTS.memoryMb), cpus: z.number().default(LIMIT_DEFAULTS.cpus),
  probe: probeSchema.nullable().default(null),
}).strict();

const parseProbe = text => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
export const settingsRow = siteId => db.prepare('SELECT * FROM restore_test_settings WHERE site_id=?').get(siteId) ?? null;
export function settingsView(row) {
  if (!row) return { enabled: false, cadence: 'weekly', serverId: null, allowLiveServer: false, allowInternet: false, ...LIMIT_DEFAULTS, probe: null, nextDueAt: null, skipReason: null };
  return { enabled: row.enabled === 1, cadence: row.cadence, serverId: row.server_id, allowLiveServer: row.allow_live_server === 1, allowInternet: row.allow_internet === 1, timeLimitMinutes: row.time_limit_minutes, memoryMb: row.memory_mb, cpus: row.cpus, probe: parseProbe(row.probe), nextDueAt: row.next_due_at, skipReason: row.skip_reason };
}

// The CPU count DockNest knows for a server: from its facts, recorded by "Check space" (src/restore-tests/engine.js).
export function serverCpus(server) {
  let facts; try { facts = typeof server?.capabilities === 'string' ? JSON.parse(server.capabilities) : server?.capabilities; } catch { facts = null; }
  const value = Number(facts?.cpus ?? facts?.cpuCount ?? facts?.nproc);
  return Number.isInteger(value) && value > 0 ? value : null;
}

// The first due time: the site's next scheduled backup plus 30 minutes, or one cadence period from now without one.
export function firstDueAt(siteId, cadence, nowMs = testTransport.now()) {
  const policy = db.prepare('SELECT enabled,next_run FROM policies WHERE site_id=?').get(siteId);
  const next = policy?.enabled === 1 && policy.next_run ? Date.parse(policy.next_run) : NaN;
  return iso(Number.isFinite(next) && next + AFTER_BACKUP_MS > nowMs ? next + AFTER_BACKUP_MS : nowMs + CADENCE_DAYS[cadence] * DAY_MS);
}
// After a test is queued or skipped: one cadence step at a time until the time is in the future, so a long outage
// never causes a burst of catch-up tests.
export function followingDueAt(dueAt, cadence, nowMs = testTransport.now()) {
  const step = CADENCE_DAYS[cadence] * DAY_MS;
  let next = Date.parse(dueAt);
  if (!Number.isFinite(next)) next = nowMs;
  while (next <= nowMs) next += step;
  return iso(next);
}

// PUT /api/sites/:id/restore-tests/settings. `recentlyVerified` says whether the session re-verified within 5 minutes;
// turning on the live server or internet needs it. Turning tests off never cancels a running test.
export function saveSettings(site, input, { actor, recentlyVerified }) {
  const parsed = settingsInput.safeParse(input);
  if (!parsed.success) throw httpError(400, 'INVALID', parsed.error.issues[0]?.message || 'The settings are not valid.');
  const data = parsed.data, limits = validateLimits({ timeLimitMinutes: data.timeLimitMinutes, memoryMb: data.memoryMb, cpus: data.cpus });
  const previous = settingsRow(site.id), before = settingsView(previous);
  const server = data.serverId ? db.prepare('SELECT * FROM servers WHERE id=?').get(data.serverId) : null;
  if (data.serverId && !server) throw httpError(400, 'INVALID', 'Choose a connected server.');
  if (data.enabled && !server) throw httpError(409, 'TEST_SERVER_REQUIRED', 'Choose a test server first.');
  const live = !!server && server.id === site.server_id;
  if (live && !data.allowLiveServer) throw httpError(409, 'LIVE_SERVER_NOT_ALLOWED', 'This is the site’s own server. Allow live server to test on it.');
  const allowLiveServer = live && data.allowLiveServer;
  // Re-verify whenever the result is "test on the live server" and it was not already allowed for this server:
  // turning the switch on, pointing tests at the site's own server, or a move that made the test server the live one.
  const liveBefore = before.allowLiveServer && before.serverId === site.server_id;
  if (((allowLiveServer && !liveBefore) || (data.allowInternet && !before.allowInternet)) && !recentlyVerified)
    throw httpError(403, 'REVERIFY_REQUIRED', 'Confirm it is you before allowing the live server or internet for restore tests.');
  const kind = typeof site.config === 'string' ? JSON.parse(site.config || '{}').kind : site.config?.kind;
  if (data.probe && kind === 'static') throw httpError(409, 'PROBE_STATIC', 'A static site has no container for a web check.');
  const cpus = serverCpus(server);
  if (cpus && limits.cpus > cpus) throw httpError(409, 'CPUS_ABOVE_SERVER', `The test server has ${cpus} CPU${cpus === 1 ? '' : 's'}, so it cannot give each container ${limits.cpus}. Lower the CPU limit.`);
  const probe = data.probe ? JSON.stringify(data.probe) : null;
  if (probe && probe.length > 512) throw httpError(400, 'INVALID', 'The web check settings are too long.');
  const nowMs = testTransport.now();
  // A new due time when tests are turned on or the cadence changes; none while off.
  const nextDueAt = !data.enabled ? null : before.enabled && before.cadence === data.cadence && previous?.next_due_at ? previous.next_due_at : firstDueAt(site.id, data.cadence, nowMs);
  const next = { enabled: data.enabled, cadence: data.cadence, serverId: server?.id ?? null, allowLiveServer, allowInternet: data.allowInternet, ...limits, probe: data.probe };
  const changed = Object.keys(next).filter(field => JSON.stringify(next[field]) !== JSON.stringify(before[field]));
  db.prepare(`INSERT INTO restore_test_settings(site_id,enabled,cadence,server_id,allow_live_server,allow_internet,time_limit_minutes,memory_mb,cpus,probe,next_due_at,skip_reason,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)
    ON CONFLICT(site_id) DO UPDATE SET enabled=excluded.enabled,cadence=excluded.cadence,server_id=excluded.server_id,allow_live_server=excluded.allow_live_server,allow_internet=excluded.allow_internet,time_limit_minutes=excluded.time_limit_minutes,memory_mb=excluded.memory_mb,cpus=excluded.cpus,probe=excluded.probe,next_due_at=excluded.next_due_at,skip_reason=NULL,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
    .run(site.id, data.enabled ? 1 : 0, data.cadence, next.serverId, allowLiveServer ? 1 : 0, data.allowInternet ? 1 : 0, limits.timeLimitMinutes, limits.memoryMb, limits.cpus, probe, nextDueAt, iso(nowMs), actor);
  // Field names only, plus the two risky switches: settings hold no secrets, and values stay out of the audit log.
  audit(actor, 'restore_test.settings', site.id, { changed, ...(changed.includes('allowLiveServer') ? { allowLiveServer } : {}), ...(changed.includes('allowInternet') ? { allowInternet: data.allowInternet } : {}) });
  return settingsView(settingsRow(site.id));
}
