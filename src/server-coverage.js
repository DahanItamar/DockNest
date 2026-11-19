// Coverage view (docs/coverage-and-restore-check.md A4): every container and volume on a server, classified as backed
// up (with its app), first backup pending, not backed up, or skipped on purpose. On demand only: each request runs the
// existing discover, nothing is stored but the skip list. An incomplete scan says so and never reads as all clear.
import express from 'express';
import { z } from 'zod';
import { db, audit } from './db.js';
import { discover } from './engine.js';
import { activeApps } from './site-coverage.js';
import { coverageIndex } from '../shared/backup-coverage.js';

export const coverageRoutes = express.Router();
const KIND = z.enum(['container', 'volume']);
// Docker container and volume names; 255 matches the table's limit.
const NAME = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/);
const IGNORE = z.object({ kind: KIND, name: NAME, note: z.string().trim().max(200).regex(/^[^\x00-\x1f\x7f]*$/).optional() }).strict();
const notFound = () => { throw Object.assign(new Error('Server not found.'), { status: 404 }); };
const serverOf = id => db.prepare('SELECT * FROM servers WHERE id=?').get(id) || notFound();

// DockNest's own copies, never anything to back up: restore copies, restore test copies, Safe Edit image holders and
// move test copies. A moved app's live copy keeps its docknest.move label, so only the test mode is DockNest's.
const OWN_LABELS = ['docker-backup-manager.restore', 'docknest.restore-test', 'docknest.edit.hold'];
export function dockNestOwn(name, labels = {}) {
  return String(name).startsWith('dbm-restore-') || labels['docknest.move.mode'] === 'test'
    || Object.keys(labels).some(key => OWN_LABELS.some(own => key === own || key.startsWith(own + '.')));
}

const status = (owner, verified, ignore) => owner ? (verified.has(owner.siteId) ? 'backed-up' : 'pending') : ignore ? 'skipped' : 'not-backed-up';
// A covered item names its app; a skip only shows on an item nothing backs up.
function ownerFields(owner, ignore) {
  if (owner) return { app: { id: owner.siteId, name: owner.name } };
  if (!ignore) return {};
  return { ...(ignore.note ? { note: ignore.note } : {}), ...(ignore.skippedBy ? { skippedBy: ignore.skippedBy } : {}), skippedAt: ignore.createdAt };
}

// Pure: the scan (discover's result), the server's active apps, the ids of apps with a verified backup and the skip
// list ({kind,name,note,skippedBy,createdAt}) become the response. A volume is covered by the first app whose
// container mounts it.
export function classifyCoverage(scan, apps, serverId, { verified = new Set(), ignores = [] } = {}) {
  const index = coverageIndex(apps, serverId), skipped = new Map(ignores.map(item => [item.kind + ':' + item.name, item]));
  const containers = (scan.containers || []).filter(container => !dockNestOwn(container.name, container.labels || {}));
  const items = containers.map(container => {
    const owner = index.containers.get(container.name), ignore = skipped.get('container:' + container.name);
    return { kind: 'container', name: container.name, image: container.image, state: container.state, status: status(owner, verified, ignore), ...ownerFields(owner, ignore) };
  });
  for (const volume of (scan.volumes || []).filter(volume => !dockNestOwn(volume.name, volume.labels || {}))) {
    const users = containers.filter(container => (container.mounts || []).some(mount => mount.Type === 'volume' && mount.Name === volume.name)).map(container => container.name);
    const owner = users.map(name => index.containers.get(name)).find(Boolean), ignore = skipped.get('volume:' + volume.name);
    items.push({ kind: 'volume', name: volume.name, usedBy: users, status: status(owner, verified, ignore), ...ownerFields(owner, ignore) });
  }
  const problems = [
    ...(scan.volumes === null || scan.volumes === undefined ? ['DockNest could not list the volumes on this server, so volumes are missing from this list.'] : []),
    ...(scan.uninspected > 0 ? [`DockNest could not read ${scan.uninspected} ${scan.uninspected === 1 ? 'container' : 'containers'} on this server. Scan again.`] : []),
  ];
  return { complete: !problems.length, problems, items };
}

const ignoresOf = serverId => db.prepare('SELECT i.kind,i.name,i.note,i.created_at AS createdAt,u.name AS skippedBy FROM server_coverage_ignores i LEFT JOIN users u ON u.id=i.created_by WHERE i.server_id=?').all(serverId);
const verifiedApps = serverId => new Set(db.prepare('SELECT DISTINCT b.site_id FROM backups b JOIN sites s ON s.id=b.site_id WHERE s.server_id=? AND b.verified=1').all(serverId).map(row => row.site_id));

// Any signed-in role may read it: discover returns no environment values.
coverageRoutes.get('/servers/:id/coverage', async (req, res) => {
  const server = serverOf(req.params.id);
  res.json(classifyCoverage(await discover(server), activeApps(server.id), server.id, { verified: verifiedApps(server.id), ignores: ignoresOf(server.id) }));
});
// Admins and operators (every signed-in role) mark an item skipped on purpose. The note is never audited.
coverageRoutes.put('/servers/:id/coverage/ignores', (req, res) => {
  const server = serverOf(req.params.id), { kind, name, note } = IGNORE.parse(req.body);
  db.prepare('INSERT INTO server_coverage_ignores(server_id,kind,name,note,created_by,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(server_id,kind,name) DO UPDATE SET note=excluded.note,created_by=excluded.created_by,created_at=excluded.created_at')
    .run(server.id, kind, name, note || null, req.user.id, new Date().toISOString());
  audit(req.user.id, 'coverage.skip', server.id, { kind, name });
  res.json(ignoresOf(server.id).find(item => item.kind === kind && item.name === name));
});
coverageRoutes.delete('/servers/:id/coverage/ignores/:kind/:name', (req, res) => {
  const server = serverOf(req.params.id), kind = KIND.parse(req.params.kind), name = NAME.parse(req.params.name);
  if (!db.prepare('DELETE FROM server_coverage_ignores WHERE server_id=? AND kind=? AND name=?').run(server.id, kind, name).changes) return res.status(404).json({ error: 'This item is not skipped.' });
  audit(req.user.id, 'coverage.unskip', server.id, { kind, name });
  res.status(204).end();
});
