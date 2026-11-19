// Linked apps per server (docs/linked-apps.md). Read-only: DockNest shows which apps depend on each other and never
// changes them. Facts come from the remote helper during the discovery scans that already run
// (remote/helper/discovery.py container_link_facts); nothing here opens a connection or runs on a timer.
//
// Trust: facts arrive from the managed server, so every field is checked against fixed sizes, counts and character sets
// and anything unexpected is dropped. A dropped container or value marks the scan partial, so the screen can say some
// containers could not be read. Only names, bind source paths and the image reference are stored.
import { db } from './db.js';
import { computeAppLinks } from '../shared/app-links.js';
import { containerIsDatabase } from '../shared/database-image.js';

export const LINKS_FORMAT = 1;
export const LIMITS = Object.freeze({ containers: 1000, networks: 32, volumes: 64, binds: 64, links: 32, dependsOn: 32 });
const MAX_STORED = 2097152;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9_.\/:@-]{0,254}$/;
// Letters and digits of any script, but never a control character.
const BIND = /^\/[\p{L}\p{N}\p{M}_.\/@+=:,~ -]{0,1023}$/u;
const isName = value => typeof value === 'string' && NAME.test(value);

// Keeps the valid values of a list up to its limit. `dropped` is true when anything was left out.
function cleanList(values, limit, clean) {
  if (!Array.isArray(values)) return { values: [], dropped: values !== undefined };
  const kept = values.slice(0, limit).map(clean).filter(value => value !== null);
  return { values: kept, dropped: values.length > kept.length };
}
const optionalName = value => (value === null || value === undefined ? { value: null, dropped: false } : isName(value) ? { value, dropped: false } : { value: null, dropped: true });

// Clean facts for one discovered container ({name, image, links}), and whether anything was dropped. A container whose
// name or record cannot be read gives null.
export function cleanContainerLinks(container) {
  const raw = container?.links;
  if (!isName(container?.name) || !raw || typeof raw !== 'object' || raw.format !== LINKS_FORMAT) return null;
  const project = optionalName(raw.project), service = optionalName(raw.service);
  const lists = {
    networks: cleanList(raw.networks, LIMITS.networks, value => (isName(value) ? value : null)),
    volumes: cleanList(raw.volumes, LIMITS.volumes, value => (isName(value) ? value : null)),
    binds: cleanList(raw.binds, LIMITS.binds, value => (typeof value === 'string' && BIND.test(value) ? value : null)),
    links: cleanList(raw.links, LIMITS.links, value => (isName(value) ? value : null)),
    dependsOn: cleanList(raw.dependsOn, LIMITS.dependsOn, value => (isName(value) ? value : null)),
  };
  const image = typeof container.image === 'string' && IMAGE.test(container.image) ? container.image : '';
  return {
    facts: { name: container.name, image, project: project.value, service: service.value, ...Object.fromEntries(Object.entries(lists).map(([key, list]) => [key, list.values])) },
    dropped: project.dropped || service.dropped || Object.values(lists).some(list => list.dropped),
  };
}

// The cleaned facts of one scan and whether they are partial; null when the answer is not a scan at all.
export function cleanScan(discovered) {
  const containers = Array.isArray(discovered) ? discovered : discovered?.containers;
  if (!Array.isArray(containers)) return null;
  const facts = [], names = new Set();
  let partial = containers.length > LIMITS.containers;
  for (const container of containers.slice(0, LIMITS.containers)) {
    const cleaned = cleanContainerLinks(container);
    if (!cleaned || names.has(cleaned.facts.name)) { partial = true; continue; }
    names.add(cleaned.facts.name); facts.push(cleaned.facts); partial ||= cleaned.dropped;
  }
  return { facts, partial };
}

// The facts that fit in MAX_STORED characters, in scan order, as stored JSON, and whether any were left out.
function fitting(facts) {
  const kept = [];
  let size = 2;
  for (const item of facts) {
    const length = JSON.stringify(item).length + 1;
    if (size + length > MAX_STORED) break;
    kept.push(item); size += length;
  }
  return { json: JSON.stringify(kept), truncated: kept.length < facts.length };
}

// Stores the facts of a discovery scan for one server, replacing the previous scan. An answer that is not a scan leaves
// the previous scan in place; facts too large to store are cut to what fits and marked partial.
export function recordDiscoveredLinks(serverId, discovered, checkedAt = new Date().toISOString(), database = db) {
  const scan = cleanScan(discovered);
  if (!scan) return false;
  const { json, truncated } = fitting(scan.facts);
  database.prepare('INSERT INTO server_app_links(server_id,facts,format,checked_at,partial) VALUES(?,?,?,?,?) ON CONFLICT(server_id) DO UPDATE SET facts=excluded.facts,format=excluded.format,checked_at=excluded.checked_at,partial=excluded.partial')
    .run(serverId, json, LINKS_FORMAT, checkedAt, scan.partial || truncated ? 1 : 0);
  return true;
}

// Who backs up each container on a server: the active Docker apps there, the last listed app when older ones overlap.
// Adapter until shared/backup-coverage.js lands: then this becomes coverageIndex(sites, serverId).containers.
function containerOwners(sites) {
  const owners = new Map();
  for (const site of sites) for (const name of site.config?.containers || []) owners.set(name, { siteId: site.id, name: site.name });
  return name => owners.get(name) ?? null;
}
// The engine each app chose for its containers (site.config.services), for the database rule.
function chosenEngines(sites) {
  return new Map(sites.flatMap(site => (Array.isArray(site.config?.services) ? site.config.services : []).map(service => [service?.container, service?.engine])));
}
function activeSites(serverId, database) {
  return database.prepare('SELECT id,name,config FROM sites WHERE server_id=? AND id NOT IN (SELECT site_id FROM site_archives) ORDER BY created_at').all(serverId).flatMap(row => {
    try { return [{ id: row.id, name: row.name, config: JSON.parse(row.config) }]; } catch { return []; }
  });
}

const notScanned = (partial = false) => ({ checkedAt: null, partial, links: [], unowned: [], hubs: [] });
const plainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// Links from one stored row, or null when the row holds no facts this release can read.
function computeRow(serverId, row, database) {
  const stored = JSON.parse(row.facts);
  if (!Array.isArray(stored)) return null;
  const entries = stored.filter(plainObject);
  const scan = cleanScan(entries.map(({ name, image, ...links }) => ({ name, image, links: { format: LINKS_FORMAT, ...links } })));
  const sites = activeSites(serverId, database), engines = chosenEngines(sites);
  const computed = computeAppLinks(scan.facts, containerOwners(sites), container => containerIsDatabase(engines.get(container.name), container.image));
  const { links, unowned, hubs } = computed;
  return { checkedAt: row.checked_at, partial: Boolean(row.partial) || entries.length < stored.length || scan.partial || computed.partial, links, unowned, hubs };
}
// The API view for one server: {checkedAt, partial, links, unowned, hubs}. Never scanned, or facts this release cannot
// read: checkedAt null and nothing listed. Stored facts are cleaned again on read, and a damaged row never fails the
// caller (/api/state): it reads as not scanned and partial.
export function serverLinksView(serverId, database = db) {
  let row;
  try { row = database.prepare('SELECT facts,format,checked_at,partial FROM server_app_links WHERE server_id=?').get(serverId); } catch { return notScanned(); }
  if (!row || row.format !== LINKS_FORMAT) return notScanned();
  try { return computeRow(serverId, row, database) ?? notScanned(true); } catch { return notScanned(true); }
}
