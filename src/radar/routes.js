// Vulnerability radar API. Signed-in users (operators and admins) view and request scans; admins dismiss and set
// preferences. Every change is audited. Responses are never cached. Nothing here changes a site or a server.
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { describeFinding } from './describe.js';
import { bundledFeed, preferences, requestScan } from './scan.js';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
const STATES = { open: 'f.resolved_at IS NULL AND f.dismissed_at IS NULL', resolved: 'f.resolved_at IS NOT NULL', dismissed: 'f.resolved_at IS NULL AND f.dismissed_at IS NOT NULL', all: '1=1' };
const stateOf = row => row.resolved_at ? 'resolved' : row.dismissed_at ? 'dismissed' : 'open';
const advisoryOf = (db, id) => { const row = db.prepare('SELECT data FROM radar_advisories WHERE id=?').get(id); try { return row ? JSON.parse(row.data) : null; } catch { return null; } };

function findingView(db, row) {
  const advisory = advisoryOf(db, row.advisory_id);
  const finding = { advisoryId: row.advisory_id, severity: row.severity, kind: row.kind, fixedIn: row.fixed_in, evidence: row.evidence, component: { product: row.product, version: row.version, source: row.source } };
  return {
    id: row.id, state: stateOf(row), serverId: row.server_id, serverName: row.server_name, siteId: row.site_id, siteName: row.site_name, container: row.container_name,
    advisoryId: row.advisory_id, cve: advisory?.cve ?? [], refs: advisory?.refs ?? [], severity: row.severity, kind: row.kind, product: row.product, version: row.version, source: row.source, fixedIn: row.fixed_in,
    firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, resolvedAt: row.resolved_at, dismissedAt: row.dismissed_at, dismissedBy: row.dismissed_by, dismissReason: row.dismiss_reason,
    ...describeFinding(finding, { advisory, siteName: row.site_name, appName: row.container_name || 'container' }),
  };
}

const worst = rows => SEVERITY_ORDER.find(severity => rows.some(row => row.severity === severity)) ?? null;
export function radarSummary(db) {
  const feed = bundledFeed();
  const open = db.prepare(`SELECT f.server_id,f.site_id,f.severity,f.kind FROM radar_findings f WHERE ${STATES.open}`).all();
  const counts = Object.fromEntries(SEVERITY_ORDER.map(severity => [severity, open.filter(row => row.severity === severity).length]));
  const lastScan = db.prepare("SELECT server_id,MAX(finished_at) AS at FROM radar_scans WHERE status='completed' GROUP BY server_id").all();
  const scanned = new Map(lastScan.map(row => [row.server_id, row.at]));
  const servers = db.prepare('SELECT id,name FROM servers ORDER BY name,id').all().map(server => {
    const latest = db.prepare('SELECT status,reason,requested_at,finished_at,error FROM radar_scans WHERE server_id=? ORDER BY requested_at DESC,id DESC LIMIT 1').get(server.id);
    const mine = open.filter(row => row.server_id === server.id);
    return { id: server.id, name: server.name, lastCheckedAt: scanned.get(server.id) ?? null, latestScan: latest ? { status: latest.status, reason: latest.reason, requestedAt: latest.requested_at, finishedAt: latest.finished_at, error: latest.error } : null, open: mine.length, worst: worst(mine) };
  });
  const inventoried = new Set(db.prepare('SELECT DISTINCT site_id FROM radar_inventory WHERE site_id IS NOT NULL').all().map(row => row.site_id));
  // "Not checked yet" rather than a false all-clear when no scan has seen the site's containers.
  const sites = db.prepare('SELECT s.id,s.name,s.server_id FROM sites s LEFT JOIN site_archives a ON a.site_id=s.id WHERE a.site_id IS NULL ORDER BY s.name,s.id').all().map(site => {
    const mine = open.filter(row => row.site_id === site.id);
    const checked = scanned.has(site.server_id) && inventoried.has(site.id);
    return { id: site.id, name: site.name, serverId: site.server_id, checked, lastCheckedAt: checked ? scanned.get(site.server_id) : null, open: mine.length, worst: worst(mine), status: !checked ? 'not_checked' : worst(mine) ?? 'clear' };
  });
  return {
    feed: { serial: feed.serial, generatedAt: feed.generatedAt, expiresAt: feed.expiresAt, advisories: feed.advisories.length },
    preferences: preferences(db), open: counts, totalOpen: open.length,
    dismissed: db.prepare(`SELECT COUNT(*) AS n FROM radar_findings f WHERE ${STATES.dismissed}`).get().n,
    lastCheckedAt: lastScan.reduce((max, row) => (!max || row.at > max ? row.at : max), null), servers, sites,
  };
}

const findingsQuery = z.object({ server: z.uuid().optional(), site: z.uuid().optional(), state: z.enum(['open', 'resolved', 'dismissed', 'all']).default('open') });
const dismissBody = z.object({ dismissed: z.boolean().default(true), reason: z.string().trim().max(500).optional() }).strict();
const preferencesBody = z.object({ containerProbes: z.boolean().optional(), feedRefresh: z.boolean().nullable().optional(), notifyCritical: z.boolean().optional() }).strict();
const scanBody = z.object({ serverId: z.uuid().optional() }).strict();

export function radarRoutes({ db, audit }) {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/summary', (_req, res) => res.json(radarSummary(db)));
  router.get('/findings', (req, res) => {
    const query = findingsQuery.parse(req.query), where = [STATES[query.state]], args = [];
    if (query.server) { where.push('f.server_id=?'); args.push(query.server); }
    if (query.site) { where.push('f.site_id=?'); args.push(query.site); }
    const rows = db.prepare(`SELECT f.*,s.name AS server_name,t.name AS site_name FROM radar_findings f JOIN servers s ON s.id=f.server_id LEFT JOIN sites t ON t.id=f.site_id WHERE ${where.join(' AND ')}
      ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,f.last_seen_at DESC,f.id LIMIT 500`).all(...args);
    res.json({ findings: rows.map(row => findingView(db, row)) });
  });
  router.post('/scan', (req, res) => {
    const { serverId } = scanBody.parse(req.body ?? {});
    const servers = serverId ? db.prepare('SELECT id FROM servers WHERE id=?').all(serverId) : db.prepare('SELECT id FROM servers').all();
    if (serverId && !servers.length) return res.status(404).json({ error: 'Server not found.' });
    const scans = requestScan(db, { serverIds: servers.map(server => server.id), reason: 'manual', actor: req.user.id });
    audit(req.user.id, 'radar.scan_requested', serverId ?? null, { servers: servers.length });
    res.status(202).json({ scans });
  });
  router.post('/findings/:id/dismiss', requireAdmin, (req, res) => {
    const body = dismissBody.parse(req.body ?? {});
    const row = db.prepare('SELECT id,advisory_id,server_id,site_id FROM radar_findings WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Finding not found.' });
    if (body.dismissed) db.prepare('UPDATE radar_findings SET dismissed_at=?,dismissed_by=?,dismiss_reason=? WHERE id=?').run(new Date().toISOString(), req.user.id, body.reason || null, row.id);
    else db.prepare('UPDATE radar_findings SET dismissed_at=NULL,dismissed_by=NULL,dismiss_reason=NULL WHERE id=?').run(row.id);
    audit(req.user.id, body.dismissed ? 'radar.finding_dismissed' : 'radar.finding_restored', row.id, { advisoryId: row.advisory_id, serverId: row.server_id, siteId: row.site_id });
    res.json({ id: row.id, state: body.dismissed ? 'dismissed' : 'open' });
  });
  router.get('/preferences', (_req, res) => res.json(preferences(db)));
  router.put('/preferences', requireAdmin, (req, res) => {
    const body = preferencesBody.parse(req.body ?? {}), current = preferences(db), next = { ...current, ...body };
    db.prepare(`INSERT INTO radar_preferences(id,container_probes,feed_refresh,notify_critical,changed_by,changed_at) VALUES(1,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET container_probes=excluded.container_probes,feed_refresh=excluded.feed_refresh,notify_critical=excluded.notify_critical,changed_by=excluded.changed_by,changed_at=excluded.changed_at`)
      .run(next.containerProbes ? 1 : 0, next.feedRefresh === null ? null : next.feedRefresh ? 1 : 0, next.notifyCritical ? 1 : 0, req.user.id, new Date().toISOString());
    audit(req.user.id, 'radar.preferences_changed', null, body);
    res.json(preferences(db));
  });
  return router;
}
