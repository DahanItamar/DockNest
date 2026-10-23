// Alert events: the fixed catalogue, the short plain message for each and the rule matching (docs/alerts.md).
// Messages carry only names the owner typed (site, server) and a time. Never hostnames, addresses, paths, logs or errors.
export const EVENTS = Object.freeze(['backup.failed', 'backup.succeeded', 'move.finished', 'move.needs_you', 'server.unreachable', 'server.disk_low', 'update.available']);
export const SOURCE_KINDS = Object.freeze(['docknest', 'server', 'site']);
// Disk threshold: low when more than 90 percent is used or less than 5 GB is free.
export const DISK_USED_PERCENT = 90;
export const DISK_FREE_BYTES = 5 * 1024 ** 3;
// How long an identical event (same key) is suppressed for one channel. Occurrence events (one backup, one move state,
// one release) are keyed by their own id and never repeat; the state-like ones are rate limited instead.
export const DEDUPE_MS = 10 * 60_000;
export const STATE_DEDUPE_MS = Object.freeze({ 'server.unreachable': 6 * 3600_000, 'server.disk_low': 24 * 3600_000 });

const clean = (value, fallback = 'a site') => String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || fallback;
const clock = (iso) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? '' : ` at ${date.toISOString().slice(11, 16)} UTC`; };
const gb = bytes => `${(Number(bytes) / 1024 ** 3).toFixed(1)} GB`;

// event: { type, at, siteName?, serverName?, targetName?, detail?, version?, freeBytes?, usedPercent?, key, siteId?, serverId? }
export function messageFor(event) {
  const site = clean(event.siteName), server = clean(event.serverName, 'your server'), target = clean(event.targetName, 'the new server'), when = clock(event.at);
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
