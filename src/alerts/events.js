import { formatBytes } from '../../shared/format-bytes.js';
// Alert events: the fixed catalogue, the short plain message for each and the rule matching (docs/alerts.md).
// Messages carry only names the owner typed (site, server) and a time. Never hostnames, addresses, paths, logs or errors.
export const EVENTS = Object.freeze(['backup.failed', 'backup.succeeded', 'move.finished', 'move.needs_you', 'server.unreachable', 'server.disk_low', 'update.available', 'restore_test.failed', 'restore_test.couldnt_run', 'restore_test.recovered', 'restore_test.needs_you']);
export const SOURCE_KINDS = Object.freeze(['docknest', 'server', 'site']);
// Disk threshold: low when more than 90 percent is used or less than 5 GB is free.
export const DISK_USED_PERCENT = 90;
export const DISK_FREE_BYTES = 5 * 1024 ** 3;
// How long an identical event (same key) is suppressed for one channel. Occurrence events (one backup, one move state,
// one release) are keyed by their own id and never repeat; the state-like ones are rate limited instead.
export const DEDUPE_MS = 10 * 60_000;
export const STATE_DEDUPE_MS = Object.freeze({ 'server.unreachable': 6 * 3600_000, 'server.disk_low': 24 * 3600_000 });

const clean = (value, fallback = 'a site') => String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || fallback;
// Time of day in the event's IANA time zone (the site's schedule zone, else the self-backup schedule zone, else UTC),
// with the zone abbreviation, for example " at 03:00 UTC" or " at 06:00 GMT+3". An unknown zone falls back to UTC.
const clock = (iso, timeZone = 'UTC') => {
  const date = new Date(iso); if (Number.isNaN(date.getTime())) return '';
  const format = zone => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(date);
  try { return ` at ${format(timeZone)}`.replace(',', ''); } catch { return ` at ${format('UTC')}`; }
};
const gb = formatBytes;

// event: { type, at, siteName?, serverName?, targetName?, detail?, version?, freeBytes?, usedPercent?, key, siteId?, serverId? }
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
