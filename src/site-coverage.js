import { db } from './db.js';
import { coverageIndex, overlaps, overlapMessage } from '../shared/backup-coverage.js';

// The active (not removed) apps on a server, as shared/backup-coverage.js reads them.
export const activeApps = serverId => db.prepare('SELECT id,name,server_id AS serverId,config FROM sites WHERE server_id=? AND id NOT IN (SELECT site_id FROM site_archives)').all(serverId).map(row => ({ ...row, config: JSON.parse(row.config) }));
// The refusal for a configuration that takes a container or static website folder another active app on the server
// already backs up, or null. Synchronous on purpose: callers run it in the same section as their INSERT or UPDATE.
export function coverageConflict(serverId, config, { exceptSiteId, keep } = {}) {
  const overlap = overlaps(config, coverageIndex(activeApps(serverId), serverId, { exceptSiteId, keep }));
  return overlap.items.length ? { error: overlapMessage(overlap), code: 'CONTAINER_ALREADY_BACKED_UP' } : null;
}
