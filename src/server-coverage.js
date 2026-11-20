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
// A note is one line: whitespace (a pasted line break too) is collapsed before it is checked.
const NOTE = z.string().transform(note => note.replace(/\s+/g, ' ').trim()).pipe(z.string().max(200).regex(/^[^\x00-\x1f\x7f]*$/));
const IGNORE = z.object({ kind: KIND, name: NAME, note: NOTE.optional() }).strict();
export const MAX_IGNORES = 1000;
const notFound = () => { throw Object.assign(new Error('Server not found.'), { status: 404 }); };
const serverOf = id => db.prepare('SELECT * FROM servers WHERE id=?').get(id) || notFound();

// DockNest's own copies, never anything to back up: restore copies, restore test copies, Safe Edit image holders and
// move test copies. A moved app's live copy keeps its docknest.move label, so only the test mode is DockNest's.
const OWN_LABELS = ['docker-backup-manager.restore', 'docknest.restore-test', 'docknest.edit.hold'];
export function dockNestOwn(name, labels = {}) {
  return String(name).startsWith('dbm-restore-') || labels['docknest.move.mode'] === 'test'
    || Object.keys(labels).some(key => OWN_LABELS.some(own => key === own || key.startsWith(own + '.')));
}

// Backed up only when the app's latest verified backup holds the container; one added to the app since is pending.
const status = (owner, verified, ignore, names) => owner ? (names.some(name => verified.get(owner.siteId)?.has(name)) ? 'backed-up' : 'pending') : ignore ? 'skipped' : 'not-backed-up';
// A covered item names its app; a skip only shows on an item nothing backs up.
function ownerFields(owner, ignore) {
  if (owner) return { app: { id: owner.siteId, name: owner.name } };
  if (!ignore) return {};
  return { ...(ignore.note ? { note: ignore.note } : {}), ...(ignore.skippedBy ? { skippedBy: ignore.skippedBy } : {}), skippedAt: ignore.createdAt };
}

// Pure: the scan (discover's result), the server's active apps, app id -> the containers its latest verified backup
// holds, and the skip list ({kind,name,note,skippedBy,createdAt}) become the response. A volume is covered by the first app whose
// container mounts it.
export function classifyCoverage(scan, apps, serverId, { verified = new Map(), ignores = [] } = {}) {
  const index = coverageIndex(apps, serverId), skipped = new Map(ignores.map(item => [item.kind + ':' + item.name, item]));
  const containers = (scan.containers || []).filter(container => !dockNestOwn(container.name, container.labels || {}));
  const items = containers.map(container => {
    const owner = index.containers.get(container.name), ignore = skipped.get('container:' + container.name);
    return { kind: 'container', name: container.name, image: container.image, state: container.state, status: status(owner, verified, ignore, [container.name]), ...ownerFields(owner, ignore) };
  });
  for (const volume of (scan.volumes || []).filter(volume => !dockNestOwn(volume.name, volume.labels || {}))) {
    const users = containers.filter(container => (container.mounts || []).some(mount => mount.Type === 'volume' && mount.Name === volume.name)).map(container => container.name);
    const owner = users.map(name => index.containers.get(name)).find(Boolean), ignore = skipped.get('volume:' + volume.name);
    items.push({ kind: 'volume', name: volume.name, usedBy: users, status: status(owner, verified, ignore, users.filter(name => index.containers.get(name) === owner)), ...ownerFields(owner, ignore) });
  }
  const problems = [
    ...(scan.volumes === null || scan.volumes === undefined ? ['DockNest could not list the volumes on this server, so volumes are missing from this list.'] : []),
    ...(scan.uninspected > 0 ? [`DockNest could not read ${scan.uninspected} ${scan.uninspected === 1 ? 'container' : 'containers'} on this server. Scan again.`] : []),
  ];
  return { complete: !problems.length, problems, items };
}

const ignoresOf = serverId => db.prepare('SELECT i.kind,i.name,i.note,i.created_at AS createdAt,u.name AS skippedBy FROM server_coverage_ignores i LEFT JOIN users u ON u.id=i.created_by WHERE i.server_id=?').all(serverId);
// App id -> the container names its latest verified backup holds (one backup per app; the stored manifest names them).
function verifiedContainers(serverId) {
  const rows = db.prepare(`SELECT b.site_id AS siteId,ltrim(json_extract(c.value,'$.name'),'/') AS name FROM backups b JOIN sites s ON s.id=b.site_id,json_each(b.manifest,'$.containers') c
    WHERE s.server_id=? AND b.id=(SELECT id FROM backups WHERE site_id=b.site_id AND verified=1 ORDER BY captured_at DESC,id DESC LIMIT 1)`).all(serverId);
  const result = new Map();
  for (const { siteId, name } of rows) result.set(siteId, (result.get(siteId) ?? new Set()).add(name));
  return result;
}

// Any signed-in role may read it: discover returns no environment values.
coverageRoutes.get('/servers/:id/coverage', async (req, res) => {
  const server = serverOf(req.params.id);
  res.json(classifyCoverage(await discover(server), activeApps(server.id), server.id, { verified: verifiedContainers(server.id), ignores: ignoresOf(server.id) }));
});
// Admins and operators (every signed-in role) mark an item skipped on purpose. The note is never audited.
coverageRoutes.put('/servers/:id/coverage/ignores', (req, res) => {
  const server = serverOf(req.params.id), { kind, name, note } = IGNORE.parse(req.body);
  const known = db.prepare('SELECT 1 FROM server_coverage_ignores WHERE server_id=? AND kind=? AND name=?').get(server.id, kind, name);
  if (!known && db.prepare('SELECT COUNT(*) AS count FROM server_coverage_ignores WHERE server_id=?').get(server.id).count >= MAX_IGNORES) return res.status(409).json({ error: `This server already has ${MAX_IGNORES} skipped items. Unskip some before you skip more.`, code: 'COVERAGE_SKIP_LIMIT' });
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
