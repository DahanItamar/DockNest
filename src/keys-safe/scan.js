// Fresh key scans for known-good decisions (docs/keys-safe.md, "Changed since last known-good"): an administrator's
// "Mark as known-good", a Safe Edit that was applied and a restore onto the app each scan the app first, so known-good
// is always what runs now, never an older observation.
import { siteInfo, transport } from '../engine.js';
import { keysRequest } from './fingerprint.js';
import { recordScan } from './store.js';

// `remote`: the caller's SSH transport (Safe Edit and moves pass their own, which tests replace).
// The scan and the known-good decision are one recorded transaction, so a trusted change never raises config.changed.
// Throws when the scan fails, so nothing is marked from stale facts.
export async function confirmKnownGood(siteId, { source, actor, only = null, remote = transport.remote }) {
  const { site, server } = siteInfo(siteId);
  const recorded = site.config.kind !== 'static' && recordScan(siteId, await remote(server, { operation: 'key-scan', config: site.config, keys: keysRequest() }), { trust: { source, actor, only } });
  if (!recorded) throw Object.assign(new Error('DockNest could not read the configuration of this app. Nothing was marked.'), { status: 409, code: 'SCAN_FAILED' });
}
// A Safe Edit that was applied: the files it wrote and the keys in them, and the container env it recreated.
export function safeEditItems(changes) {
  const written = new Set((changes?.files ?? []).map(file => file.path));
  const env = changes?.env ?? {}, recreated = written.size > 0 || ['added', 'replaced', 'removed'].some(kind => env[kind]?.length);
  return item => {
    if (item.startsWith('/')) return written.has(item);
    const location = item.slice(item.indexOf('@') + 1);
    return location.startsWith('file:') ? written.has(location.slice(5)) : recreated && location.startsWith('env:');
  };
}
