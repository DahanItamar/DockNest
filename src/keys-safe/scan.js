// Fresh key scans for known-good decisions (docs/keys-safe.md, "Changed since last known-good"): an administrator's
// "Mark as known-good", a Safe Edit that was applied and a move onto a new server each scan the app first, so known-good
// is always what runs now, never an older observation. A restore never does: it makes a separate copy and leaves the
// app as it is.
import { siteInfo, transport } from '../engine.js';
import { keysRequest } from './fingerprint.js';
import { recordScan } from './store.js';

const refusal = (code, message) => Object.assign(new Error(message), { status: 409, code });
// The scan and the known-good decision are one recorded transaction, so a trusted change never raises config.changed.
// - remote: the caller's SSH transport (Safe Edit and moves pass their own, which tests replace).
// - rekey: the app now runs on another server, whose fingerprint key differs; its key values are taken as unchanged.
// - blocked: checked again inside that transaction; when it says the app became busy, nothing is marked.
// Throws when the app has no configuration to scan or the scan fails, so nothing is marked from stale facts.
export async function confirmKnownGood(siteId, { source, actor, only = null, rekey = false, blocked = null, remote = transport.remote }) {
  const { site, server } = siteInfo(siteId);
  if (site.config.kind === 'static') throw refusal('NOT_APPLICABLE', 'A static website has no Compose or env files to mark.');
  const scan = await remote(server, { operation: 'key-scan', config: site.config, keys: keysRequest(server.id) });
  if (!recordScan(siteId, scan, { trust: { source, actor, only, rekey, blocked } })) throw refusal('SCAN_FAILED', 'DockNest could not read the configuration of this app. Nothing was marked.');
}
// What a Safe Edit that was applied may mark (progress.keysTrust, from its review): the files it wrote, the keys in
// them, and the container env of the services it recreated (`<project>-<service>-<n>` or the single container).
// Anything else, and everything when the record is missing, stays as observed.
export function safeEditItems(trust) {
  const written = new Set(Array.isArray(trust?.written) ? trust.written : []), project = typeof trust?.project === 'string' ? trust.project : null;
  const services = new Set(Array.isArray(trust?.recreated) ? trust.recreated : []);
  const recreated = container => services.has(container) || (project !== null && [...services].some(service => new RegExp(`^${literal(project)}[-_]${literal(service)}[-_]\\d+$`).test(container)));
  return item => {
    if (item.startsWith('/')) return written.has(item);
    const location = item.slice(item.indexOf('@') + 1);
    return location.startsWith('file:') ? written.has(location.slice(5)) : location.startsWith('env:') && recreated(location.slice(4));
  };
}
const literal = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
