import { formatBytes } from '../../shared/format-bytes.js';
import { config } from '../config.js';
import { isIP } from 'node:net';
import { classify } from './addresses.js';
import { reasonFor } from './reasons.js';
// Alert events: the fixed catalogue, the short plain message for each and the rule matching (docs/alerts.md).
// Messages carry only names the owner typed (site, server) and a time. Never hostnames, addresses, paths, logs or errors.
export const EVENTS = Object.freeze(['backup.failed', 'backup.succeeded', 'move.finished', 'move.needs_you', 'server.unreachable', 'server.disk_low', 'update.available', 'restore_test.failed', 'restore_test.couldnt_run', 'restore_test.recovered', 'restore_test.needs_you', 'backup.copy_failed', 'backup.copy_recovered', 'backup.copy_gave_up', 'radar.finding_critical', 'radar.finding_resolved']);
export const SOURCE_KINDS = Object.freeze(['docknest', 'server', 'site']);
// Disk threshold: low when more than 90 percent is used or less than 5 GB is free.
export const DISK_USED_PERCENT = 90;
export const DISK_FREE_BYTES = 5 * 1024 ** 3;
// How long an identical event (same key) is suppressed for one channel. Occurrence events (one backup, one move state,
// one release) are keyed by their own id and never repeat; the state-like ones are rate limited instead.
export const DEDUPE_MS = 10 * 60_000;
export const STATE_DEDUPE_MS = Object.freeze({ 'server.unreachable': 6 * 3600_000, 'server.disk_low': 24 * 3600_000 });

// Bidi override and isolate characters (U+202A-202E, U+2066-2069) are dropped: they could make a name read as something
// else in the alert ("gnp.exe" shown as "exe.png"). Hebrew and other right-to-left text needs none of them.
const clean = (value, fallback = 'a site') => String(value ?? '').replace(/[\u202a-\u202e\u2066-\u2069]/g, '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || fallback;
// Time of day in the event's IANA time zone (the site's schedule zone, else the self-backup schedule zone, else UTC),
// with the zone abbreviation, for example " at 03:00 UTC" or " at 06:00 GMT+3". An unknown zone falls back to UTC.
const timeOf = (iso, timeZone = 'UTC') => {
  const date = new Date(iso); if (Number.isNaN(date.getTime())) return '';
  const format = zone => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(date);
  try { return format(timeZone).replace(',', ''); } catch { return format('UTC'); }
};
const clock = (iso, timeZone) => { const time = timeOf(iso, timeZone); return time ? ` at ${time}` : ''; };
const gb = formatBytes;
const product = value => ({ php: 'PHP', node: 'Node.js' }[value] ?? 'software');

// event: { type, at, siteName?, serverName?, targetName?, destinationName?, detail?, version?, freeBytes?, usedPercent?, key, siteId?, serverId? }
// destinationName: the storage destination's name as the owner typed it (backup copies), never a host or bucket.
export function messageFor(event) {
  const site = clean(event.siteName), server = clean(event.serverName, 'your server'), target = clean(event.targetName, 'the new server'), when = clock(event.at, event.timeZone);
  switch (event.type) {
    case 'backup.failed': return `Backup failed: ${site} on ${server}${when}. Open DockNest to see why.`;
    case 'backup.succeeded': return `Backup finished: ${site} on ${server}${when}.`;
    case 'move.finished':
      if (event.detail === 'rolled_back') return `Move undone: ${site} is back on ${server}. Open DockNest for details.`;
      if (event.detail === 'failed') return `Move stopped: ${site} did not move to ${target}. Open DockNest to see why.`;
      return `Move finished: ${site} now runs on ${target}.`;
    case 'move.needs_you':
      if (event.detail === 'dns') return `Move waiting for you: change the DNS record for ${site} to ${target}. Open DockNest for the record.`;
      if (event.detail === 'owner-switch') return `Move waiting for you: ${site} is ready on ${target}. Open DockNest to switch when you are ready.`;
      return `Move needs your decision: ${site}. Open DockNest to continue.`;
    case 'server.unreachable': return `Server unreachable: ${server} has not answered${when}. Open DockNest to check it.`;
    case 'server.disk_low': return `Low disk space on ${server}: ${gb(event.freeBytes)} free (${Math.round(event.usedPercent)}% used). Open DockNest to review.`;
    // Restore tests (docs/restore-tests.md, "Alerts"): {server} is the test server.
    case 'restore_test.failed': return `Restore test failed: ${site} on ${server}${when}. Open DockNest to see why.`;
    case 'restore_test.couldnt_run': return `Restore test couldn't run: ${site} on ${server}${when}. Open DockNest to see why.`;
    case 'restore_test.recovered': return `Restore test passed again: ${site} on ${server}${when}.`;
    case 'restore_test.needs_you': return `Restore test could not clean up on ${server}. Open DockNest to check it.`;
    case 'update.available': return `DockNest ${clean(event.version, 'update')} is available. Open DockNest to update.`;
    // Backup copies (docs/backup-copies.md): {destination} is the copy destination's name.
    case 'backup.copy_failed': return `Backup copy failed: ${site} to ${clean(event.destinationName, 'the copy destination')}${when}. DockNest retries automatically.`;
    case 'backup.copy_recovered': return `Backup copy saved: ${site} to ${clean(event.destinationName, 'the copy destination')}${when}.`;
    case 'backup.copy_gave_up': return `Backup copy stopped: ${site} to ${clean(event.destinationName, 'the copy destination')} failed for 7 days${when}. Open DockNest to retry it.`;
    // Vulnerability radar (docs/security.md): names and the product only, never a version string, image or container detail.
    case 'radar.finding_critical': return `Security finding: ${site} on ${server} runs ${product(event.product)} with a known serious flaw. Open DockNest to see what to do.`;
    case 'radar.finding_resolved': return `Security finding resolved: ${site} on ${server} no longer shows the ${product(event.product)} flaw.`;
    default: return null;
  }
}

// A DockNest line matches every event of the install, a server line the events of that server (and of the sites on it),
// a site line the events of that site. Disabled rules and events outside the rule's list never match.
export function ruleMatches(rule, event) {
  if (!rule.enabled || !rule.events.includes(event.type)) return false;
  if (rule.source_kind === 'docknest') return true;
  if (rule.source_kind === 'server') return Boolean(event.serverId) && rule.source_id === event.serverId || Boolean(event.targetServerId) && rule.source_id === event.targetServerId;
  return Boolean(event.siteId) && rule.source_id === event.siteId;
}

// ---- The message template (docs/alert-channels.md, "Message template") ----------------------------------------------------
// One structured message for every provider: { title, site, server, reason, time, url, event, at }. Each provider renders
// it natively (providers/). It is stored as the outbox `payload`, so a retry sends exactly what the first try would have.
// - site, server: names the owner typed, cleaned as above ('' when the event has none).
// - reason: one fixed sentence from the reasons catalogue (reasons.js), keyed by event type and `event.code` / `event.detail`.
// - time: the event's time of day in its time zone, for example "03:00 UTC" ('' for events without one).
// - url: the job deep link, only when APP_ORIGIN is not a loopback address (no link a phone cannot open).
const TITLES = { 'backup.failed': 'Backup failed', 'backup.succeeded': 'Backup finished', 'move.needs_you': 'Move waiting for you', 'server.unreachable': 'Server unreachable', 'server.disk_low': 'Low disk space', 'restore_test.failed': 'Restore test failed', 'restore_test.couldnt_run': "Restore test couldn't run", 'restore_test.recovered': 'Restore test passed again', 'restore_test.needs_you': 'Restore test needs you', 'backup.copy_failed': 'Backup copy failed', 'backup.copy_recovered': 'Backup copy saved', 'backup.copy_gave_up': 'Backup copy stopped', 'radar.finding_critical': 'Security finding', 'radar.finding_resolved': 'Security finding resolved' };
const timed = new Set(['backup.failed', 'backup.succeeded', 'server.unreachable', 'restore_test.failed', 'restore_test.couldnt_run', 'restore_test.recovered', 'backup.copy_failed', 'backup.copy_recovered', 'backup.copy_gave_up']);
const siteEvents = new Set(['backup.failed', 'backup.succeeded', 'move.finished', 'move.needs_you', 'restore_test.failed', 'restore_test.couldnt_run', 'restore_test.recovered', 'backup.copy_failed', 'backup.copy_recovered', 'backup.copy_gave_up', 'radar.finding_critical', 'radar.finding_resolved']);
const serverEvents = new Set([...siteEvents, 'server.unreachable', 'server.disk_low', 'restore_test.needs_you']);
export const loopbackOrigin = origin => {
  try { const host = new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase(); return host === 'localhost' || host.endsWith('.localhost') || (isIP(host) !== 0 && classify(host) === 'refused'); } catch { return true; }
};
// The deep link: opens a job after sign-in (`/?job=<id>`); an event without a job links to the app itself.
export function jobLink(jobId, origin = config.origin) {
  if (loopbackOrigin(origin)) return null;
  return /^[A-Za-z0-9-]{8,64}$/.test(String(jobId ?? '')) ? `${origin}/?job=${jobId}` : `${origin}/`;
}
export function templateFor(event, { origin = config.origin } = {}) {
  const at = event.at ?? new Date().toISOString();
  if (event.type === 'move.finished' && !event.detail) event = { ...event, detail: 'completed' };
  const title = event.type === 'move.finished' ? ({ rolled_back: 'Move undone', failed: 'Move stopped' }[event.detail] ?? 'Move finished') : event.type === 'update.available' ? 'Update available' : event.type === 'test' ? 'DockNest test message' : TITLES[event.type];
  if (!title) return null;
  const reason = reasonFor(event.type, event.code ?? event.detail, { target: clean(event.targetName, 'the new server'), version: event.type === 'update.available' ? clean(event.version, 'update') : '', destination: clean(event.destinationName, 'the copy destination'), free: event.freeBytes === undefined ? '' : gb(event.freeBytes), product: product(event.product), used: Math.round(Number(event.usedPercent) || 0) });
  return {
    title, site: siteEvents.has(event.type) ? clean(event.siteName) : '', server: serverEvents.has(event.type) ? clean(event.serverName, 'your server') : '', reason,
    time: timed.has(event.type) ? timeOf(at, event.timeZone) : '', url: event.type === 'test' ? null : jobLink(event.jobId, origin), event: event.type, at,
  };
}
export const testMessage = () => ({ ...templateFor({ type: 'test' }), url: null });
// The message of an outbox item: its stored template, or for a 2.8 item (payload NULL) and the "N more alerts" item the
// plain text it has, as a title and a reason.
export function messageOf(item) {
  try {
    const stored = JSON.parse(item.payload ?? 'null');
    if (stored && typeof stored.title === 'string' && typeof stored.event === 'string') return { ...stored, id: item.id };
  } catch { /* plain */ }
  return { ...plainTemplate(item.message), id: item.id };
}
export function plainTemplate(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim(), split = /^([^:.]{1,80})(?::\s*|\.\s+)(.*)$/s.exec(value);
  return { title: split ? split[1].trim() : value.slice(0, 80) || 'DockNest alert', site: '', server: '', reason: split ? split[2].trim() : '', time: '', url: null, event: 'plain', at: '', text: value };
}
