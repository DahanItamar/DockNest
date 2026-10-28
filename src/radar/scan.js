// Vulnerability radar scans: worker scheduling, inventory -> components -> findings, and the shared store queries.
// Read-only towards servers: the only remote call is the helper's `inventory` operation. Nothing leaves the install.
import { randomUUID, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadBundledFeed, cleanText } from './feed.js';
import { matchComponent } from './match.js';
import { isFullVersion } from './version.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MANUAL_INTERVAL_MS = 60 * 1000;
export const DISCOVERY_MIN_GAP_MS = 60 * 60 * 1000;
const STALE_RUNNING_MS = 30 * 60 * 1000;
const PRODUCTS = ['php', 'node'];
const iso = ms => new Date(ms).toISOString();

let bundled = null;
// The feed ships inside the release (src/radar/advisories.json). 2.12.0 never fetches one over the network.
export function bundledFeed() { return bundled ??= loadBundledFeed(fileURLToPath(new URL('./advisories.json', import.meta.url))); }

// Container probes are on by default (no row); an administrator can switch them off.
export function preferences(db) {
  const row = db.prepare('SELECT container_probes,changed_by,changed_at FROM radar_preferences WHERE id=1').get();
  return { containerProbes: row ? row.container_probes === 1 : true, changedBy: row?.changed_by ?? null, changedAt: row?.changed_at ?? null };
}

// `php:8.3-apache`, `docker.io/library/php:8.3.12-fpm@sha256:...`, `node:22-alpine` -> version from the official image tag.
export function imageTagVersion(image, product) {
  const m = /^(?:(?:docker\.io|index\.docker\.io)\/)?(?:library\/)?([a-z0-9._-]+):([A-Za-z0-9._-]{1,128})(?:@sha256:[0-9a-f]{64})?$/.exec(typeof image === 'string' ? image : '');
  if (!m || m[1] !== product) return null;
  return /^(\d{1,4}(?:\.\d{1,4}){0,2})(?:$|[-_])/.exec(m[2])?.[1] ?? null;
}

// The helper already validates probe output; it is checked again here because it crossed the network from a server.
export const RUNTIME_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+~.][A-Za-z0-9.+~-]{1,32})?$/;
export function componentsOf(item) {
  const out = [], runtime = item.runtime && typeof item.runtime === 'object' ? item.runtime : {};
  const refs = [item.image, ...(Array.isArray(item.repoTags) ? item.repoTags : [])];
  for (const product of PRODUCTS) {
    if (typeof runtime[product] === 'string' && RUNTIME_VERSION.test(runtime[product])) { out.push({ product, version: runtime[product], source: 'runtime' }); continue; }
    const version = refs.map(ref => imageTagVersion(ref, product)).find(Boolean);
    if (version) out.push({ product, version, source: 'image-tag', imageCreated: typeof item.imageCreated === 'string' ? item.imageCreated : null });
  }
  return out;
}

const str = (value, max) => typeof value === 'string' && value ? value.slice(0, max) : null;
export function containerKey(serverId, item) {
  const project = str(item.labels?.composeProject, 200), service = str(item.labels?.composeService, 200);
  return `${serverId}:${project && service ? `compose:${project}/${service}` : `name:${str(item.name, 200) ?? str(item.id, 64)}`}`;
}

// A site lists container names or IDs (src/server.js siteSchema); match either, IDs by prefix of at least 12 characters.
export function siteFor(sites, item) {
  for (const site of sites) {
    const refs = Array.isArray(site.config?.containers) ? site.config.containers : [];
    if (refs.some(ref => ref === item.name || ref === item.id || (ref.length >= 12 && typeof item.id === 'string' && item.id.startsWith(ref)))) return site;
  }
  return null;
}

const ENDED_MOVE = "('draft','rolled_back','cancelled','failed','switched_back','cleaned','completed','retention_expired')";
// Never scan a server while a backup, restore, site move, restore test or install is queued or running there.
export function serverBusy(db, serverId) {
  if (db.prepare("SELECT 1 FROM jobs j JOIN sites s ON s.id=j.site_id WHERE s.server_id=? AND j.status IN ('queued','running','recovery_required') LIMIT 1").get(serverId)) return true;
  if (db.prepare("SELECT 1 FROM restores WHERE server_id=? AND status IN ('queued','running') LIMIT 1").get(serverId)) return true;
  if (db.prepare(`SELECT 1 FROM site_moves WHERE (source_server_id=? OR target_server_id=?) AND state NOT IN ${ENDED_MOVE} LIMIT 1`).get(serverId, serverId)) return true;
  if (db.prepare('SELECT 1 FROM restore_tests WHERE server_id=? AND started_at IS NOT NULL AND finished_at IS NULL LIMIT 1').get(serverId)) return true;
  if (db.prepare("SELECT 1 FROM server_installs WHERE server_id=? AND status IN ('queued','running') LIMIT 1").get(serverId)) return true;
  return false;
}

function tx(db, fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }

// Per-install daily slot so installs do not all scan at midnight; stored once, never derived from site data.
function jitterMs(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key='radar_jitter_ms'").get();
  if (row && Number.isSafeInteger(Number(row.value))) return Number(row.value);
  const value = randomInt(0, DAY_MS);
  db.prepare("INSERT INTO settings VALUES('radar_jitter_ms',?) ON CONFLICT(key) DO NOTHING").run(String(value));
  return Number(db.prepare("SELECT value FROM settings WHERE key='radar_jitter_ms'").get().value);
}
export function lastSlot(now, jitter) { const slot = Math.floor(now / DAY_MS) * DAY_MS + jitter; return slot > now ? slot - DAY_MS : slot; }

export class RadarRateLimit extends Error { constructor() { super('A scan was requested less than a minute ago. Try again shortly.'); this.status = 429; } }

// Manual requests are rate limited install-wide (one per minute); discovery requests skip recently scanned servers.
export function requestScan(db, { serverIds, reason = 'manual', actor = null, now = Date.now() }) {
  return tx(db, () => {
    if (reason === 'manual' && db.prepare("SELECT 1 FROM radar_scans WHERE reason='manual' AND requested_at>? LIMIT 1").get(iso(now - MANUAL_INTERVAL_MS))) throw new RadarRateLimit();
    const requested = [];
    for (const serverId of serverIds) {
      if (reason === 'discovery' && db.prepare("SELECT 1 FROM radar_scans WHERE server_id=? AND status='completed' AND finished_at>? LIMIT 1").get(serverId, iso(now - DISCOVERY_MIN_GAP_MS))) continue;
      const scanId = randomUUID();
      const { changes } = db.prepare("INSERT OR IGNORE INTO radar_scans(id,server_id,reason,status,requested_by,requested_at) VALUES(?,?,?,'requested',?,?)").run(scanId, serverId, reason, actor, iso(now));
      requested.push(changes ? scanId : db.prepare("SELECT id FROM radar_scans WHERE server_id=? AND status IN ('requested','running')").get(serverId).id);
    }
    return requested;
  });
}

export function claimScan(db, now = Date.now()) {
  return tx(db, () => {
    db.prepare("UPDATE radar_scans SET status='failed',finished_at=?,error='The scan was interrupted. It will run again.' WHERE status='running' AND started_at<?").run(iso(now), iso(now - STALE_RUNNING_MS));
    for (const scan of db.prepare("SELECT * FROM radar_scans WHERE status='requested' ORDER BY requested_at,id").all()) {
      if (serverBusy(db, scan.server_id)) continue;
      db.prepare("UPDATE radar_scans SET status='running',started_at=? WHERE id=?").run(iso(now), scan.id);
      return { ...scan, status: 'running', started_at: iso(now) };
    }
    const slot = iso(lastSlot(now, jitterMs(db)));
    for (const server of db.prepare('SELECT id FROM servers ORDER BY created_at,id').all()) {
      if (db.prepare("SELECT 1 FROM radar_scans WHERE server_id=? AND (requested_at>=? OR status IN ('requested','running')) LIMIT 1").get(server.id, slot) || serverBusy(db, server.id)) continue;
      const scan = { id: randomUUID(), server_id: server.id, reason: 'scheduled', status: 'running', requested_at: iso(now), started_at: iso(now) };
      db.prepare("INSERT INTO radar_scans(id,server_id,reason,status,requested_at,started_at) VALUES(?,?,?,?,?,?)").run(scan.id, scan.server_id, scan.reason, scan.status, scan.requested_at, scan.started_at);
      return scan;
    }
    return null;
  });
}

function syncAdvisories(db, feed, at) {
  const current = db.prepare('SELECT MIN(feed_serial) AS low, MAX(feed_serial) AS high, COUNT(*) AS count FROM radar_advisories').get();
  if (current.count === feed.advisories.length && current.low === feed.serial && current.high === feed.serial) return;
  db.prepare('DELETE FROM radar_advisories').run();
  const insert = db.prepare('INSERT INTO radar_advisories(id,feed_serial,data,updated_at) VALUES(?,?,?,?)');
  for (const advisory of feed.advisories) insert.run(advisory.id, feed.serial, JSON.stringify(advisory), at);
}

// Only open, confirmed (runtime or pinned-tag) critical and high findings alert. A floating tag is capped at medium.
const ALERT_SEVERITIES = "('critical','high')";
// Same row as db.js audit(); written with the handle the scan uses so it is part of the scan's transaction.
const auditRow = (db, action, target, detail) => db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?)').run(randomUUID(), 'worker', action, target, JSON.stringify(detail), new Date().toISOString());
const KEEP = ['id', 'name', 'image', 'imageId', 'repoTags', 'repoDigests', 'architecture', 'imageCreated', 'state', 'running', 'own', 'labels', 'runtime'];
// Stores the inventory, upserts findings seen in this scan and resolves the ones that vanished. Pure database work.
// How sure a component is: read from inside the container (3), a pinned image tag with the patch level (2), a floating
// tag (1), nothing (0). A scan never replaces or resolves findings it saw with less confidence than before.
export const confidence = (source, version) => source === 'runtime' ? 3 : source === 'image-tag' ? (isFullVersion(version) ? 2 : 1) : 0;
export function recordScan(db, scan, result, { feed = bundledFeed(), now = Date.now(), probes = true } = {}) {
  // A malformed answer is a failed scan (tickRadar's catch), never "no containers", which would resolve every finding.
  if (!result || typeof result !== 'object' || !Array.isArray(result.containers)) throw new Error('The inventory answer has no container list.');
  const at = iso(now), containers = result.containers;
  const sites = db.prepare('SELECT id,name,config FROM sites WHERE server_id=?').all(scan.server_id).map(site => { try { return { ...site, config: JSON.parse(site.config) }; } catch { return { ...site, config: {} }; } });
  return tx(db, () => {
    syncAdvisories(db, feed, at);
    const previousImage = new Map(db.prepare('SELECT container_key,data FROM radar_inventory WHERE server_id=?').all(scan.server_id).map(row => { try { return [row.container_key, JSON.parse(row.data).imageId ?? null]; } catch { return [row.container_key, null]; } }));
    db.prepare('DELETE FROM radar_inventory WHERE server_id=?').run(scan.server_id);
    const openFor = db.prepare('SELECT id,source,version FROM radar_findings WHERE container_key=? AND product=? AND resolved_at IS NULL');
    const touch = db.prepare('UPDATE radar_findings SET last_seen_at=?,server_id=?,site_id=?,container_name=? WHERE id=?');
    const inventory = db.prepare('INSERT OR REPLACE INTO radar_inventory(server_id,container_key,container_id,name,site_id,scan_id,data,seen_at) VALUES(?,?,?,?,?,?,?,?)');
    const upsert = db.prepare(`INSERT INTO radar_findings(id,container_key,server_id,site_id,container_name,advisory_id,kind,severity,product,version,source,fixed_in,evidence,first_seen_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(container_key,advisory_id) DO UPDATE SET server_id=excluded.server_id,site_id=excluded.site_id,container_name=excluded.container_name,
      dismissed_at=CASE WHEN radar_findings.kind=excluded.kind AND radar_findings.version IS excluded.version THEN radar_findings.dismissed_at END,
      dismissed_by=CASE WHEN radar_findings.kind=excluded.kind AND radar_findings.version IS excluded.version THEN radar_findings.dismissed_by END,
      dismiss_reason=CASE WHEN radar_findings.kind=excluded.kind AND radar_findings.version IS excluded.version THEN radar_findings.dismiss_reason END,
      kind=excluded.kind,severity=excluded.severity,product=excluded.product,version=excluded.version,source=excluded.source,fixed_in=excluded.fixed_in,evidence=excluded.evidence,last_seen_at=excluded.last_seen_at,resolved_at=NULL`);
    let findings = 0, carried = 0;
    for (const raw of containers) {
      if (!raw || typeof raw !== 'object' || raw.own) continue;
      const item = { ...raw, name: cleanText(raw.name, 200) || null, image: cleanText(raw.image, 300) || null };
      const key = containerKey(scan.server_id, item), site = siteFor(sites, item);
      let data = JSON.stringify(Object.fromEntries(KEEP.filter(name => name in item).map(name => [name, item[name]])));
      if (data.length > 16384) data = JSON.stringify({ id: item.id, name: item.name, image: item.image, truncated: true });
      inventory.run(scan.server_id, key, str(item.id, 64), str(item.name, 200), site?.id ?? null, scan.id, data, at);
      const components = componentsOf(item), before = previousImage.get(key);
      // Same image as last time (or unknown): a stopped container, a probe that timed out or probes switched off keep what
      // a better look found before. A new image is judged afresh, so a rebuilt container can resolve its old findings.
      const sameImage = !before || !item.imageId || before === item.imageId;
      for (const product of PRODUCTS) {
        const component = components.find(c => c.product === product), seen = component ? confidence(component.source, component.version) : 0;
        const open = openFor.all(key, product);
        if (sameImage && open.some(row => confidence(row.source, row.version) > seen)) {
          for (const row of open) touch.run(at, scan.server_id, site?.id ?? null, str(item.name, 200), row.id);
          carried += open.length; continue;
        }
        if (!component) continue;
        for (const finding of matchComponent(component, feed, { today: new Date(now) })) {
          const c = finding.component;
          upsert.run(randomUUID(), key, scan.server_id, site?.id ?? null, str(item.name, 200), finding.advisoryId, finding.kind, finding.severity, c.product, str(c.version, 64), c.source, finding.fixedIn, str(finding.evidence, 512), at, at);
          findings += 1;
        }
      }
    }
    // Alerts (docs/alerts.md): one audit row per transition, read by src/alerts/detect.js. alerted_at makes it fire once per
    // finding: set when radar.finding_critical is written, cleared when radar.finding_resolved is.
    // A capped inventory (more than 500 containers) did not see every container, so nothing is resolved from it.
    if (result?.truncated !== true) {
      for (const row of db.prepare("SELECT id,site_id,product,severity FROM radar_findings WHERE server_id=? AND last_seen_at<>? AND resolved_at IS NULL AND alerted_at IS NOT NULL").all(scan.server_id, at)) {
        auditRow(db, 'radar.finding_resolved', row.id, { serverId: scan.server_id, siteId: row.site_id, product: row.product, severity: row.severity });
      }
      db.prepare('UPDATE radar_findings SET resolved_at=?,alerted_at=NULL WHERE server_id=? AND resolved_at IS NULL AND last_seen_at<>?').run(at, scan.server_id, at);
    }
    for (const row of db.prepare(`SELECT id,site_id,product,severity FROM radar_findings WHERE server_id=? AND resolved_at IS NULL AND dismissed_at IS NULL AND alerted_at IS NULL AND kind='vulnerable' AND severity IN ${ALERT_SEVERITIES}`).all(scan.server_id)) {
      auditRow(db, 'radar.finding_critical', row.id, { serverId: scan.server_id, siteId: row.site_id, product: row.product, severity: row.severity });
      db.prepare('UPDATE radar_findings SET alerted_at=? WHERE id=?').run(at, row.id);
    }
    db.prepare("UPDATE radar_scans SET status='completed',finished_at=?,containers=?,findings=?,feed_serial=?,probes=?,error=NULL WHERE id=?").run(at, containers.length, findings, feed.serial, probes ? 1 : 0, scan.id);
    return { containers: containers.length, findings, carried, truncated: result?.truncated === true };
  });
}

let inFlight = null, nextClaim = 0;
export const CLAIM_INTERVAL_MS = 60 * 1000;
// One server at a time; the worker calls this on every tick. Returns the running promise, or null when idle.
// Between tries only one indexed read runs (is a scan requested?); the claim itself, which writes, runs at most once a minute.
export const resetRadarTick = () => { nextClaim = 0; };
export function tickRadar({ db, remote, feed, now = Date.now, log = message => console.warn(message) }) {
  if (inFlight) return null;
  const at = now();
  if (at < nextClaim && !db.prepare("SELECT 1 FROM radar_scans WHERE status='requested' LIMIT 1").get()) return null;
  nextClaim = at + CLAIM_INTERVAL_MS;
  let scan;
  try { scan = claimScan(db, at); } catch (error) { log(`Radar scan skipped: ${error.message}`); return null; }
  if (!scan) return null;
  inFlight = (async () => {
    const probes = preferences(db).containerProbes;
    try {
      const server = db.prepare('SELECT * FROM servers WHERE id=?').get(scan.server_id);
      if (!server) throw new Error('The server no longer exists.');
      const call = remote ?? (await import('../ssh.js')).remote;
      const result = await call(server, { operation: 'inventory', probes });
      return recordScan(db, scan, result, { feed: feed ?? bundledFeed(), now: now(), probes });
    } catch (error) {
      // Fixed text only: remote output and SSH errors can carry secrets, so neither the scan row nor the log keeps them.
      // Findings from earlier scans stay as they were; nothing is resolved by a failed scan.
      db.prepare("UPDATE radar_scans SET status='failed',finished_at=?,probes=?,error=? WHERE id=?").run(iso(now()), probes ? 1 : 0, 'Could not read the server inventory. Check that the server is reachable, then scan again.', scan.id);
      log(`Radar scan ${scan.id} failed.`);
      return null;
    }
  })().finally(() => { inFlight = null; });
  return inFlight;
}
