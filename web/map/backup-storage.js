// Which backup storage each app uses on the Map. The app's own main destination (per-app storage) wins, then the
// destination the backup itself names, then the default destination. Only destinations in `known` count.
export function backupStorageOf({sites = [], backups = [], policies = [], activeTargetId = null, known = new Set()}) {
  const out = {}, own = {};
  for (const s of sites) if (s.storage?.mainTargetId && known.has(s.storage.mainTargetId)) own[s.id] = s.storage.mainTargetId;
  for (const b of backups) {
    const t = own[b.siteId] || b.mainTarget?.id || b.targetId || b.storageTargetId || activeTargetId;
    if (b.siteId && known.has(t) && !out[b.siteId]) out[b.siteId] = t;
  }
  for (const p of policies) {
    const t = own[p.siteId] || activeTargetId;
    if (p.enabled && p.siteId && !out[p.siteId] && known.has(t)) out[p.siteId] = t;
  }
  return out;
}
