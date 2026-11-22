// Routing facts per server (docs/domains.md, "Data"). The helper sends them with the answers of discover, readiness,
// backup and a domain check (remote/helper/routing.py); they are checked field by field here and anything odd is
// dropped, never stored. What is kept: domains, proxy kinds, container names, upstreams (scheme, host and port),
// ports, certificate names and dates, and the server's own addresses. One settings row per server holds the newest
// facts, so the domain path can join a domain's DNS answer with any server's proxy.
import { isIP } from 'node:net';
import { db } from '../db.js';
import { NAME, LINEAGE, normalizeCertificate } from '../alerts/certificates.js';

export const ROUTING_FORMAT = 1;
const KEY = serverId => `domain_routes:${serverId}`;
const LIMIT = 200, FACTS_BYTES = 256 * 1024;
const PROXIES = ['nginx', 'npm', 'caddy', 'traefik'];
const CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const ROUTER = /^[A-Za-z0-9_-]{1,64}$/;
const UPSTREAM = /^[a-z][a-z0-9+.-]{0,15}:\/\/(?:[a-z0-9][a-z0-9_.-]{0,252}|\[[0-9a-f:.]{2,45}\])(?::\d{1,5})?$/;
const CATEGORIES = ['connection-refused', 'timeout', 'dns', 'rate-limited'];

// A concrete domain name (no wildcard): lowercase, at most 253 characters, the certificate module's NAME pattern.
export const domainName = value => {
  const name = String(value ?? '').toLowerCase().replace(/\.$/, '');
  return name.length <= 253 && NAME.test(name) && !name.startsWith('*.') ? name : null;
};
const list = (value, check, limit = LIMIT) => (Array.isArray(value) ? [...new Set(value.map(check).filter(item => item !== null && item !== undefined))].slice(0, limit) : []);
const port = value => (Number.isInteger(value) && value > 0 && value < 65536 ? value : null);
const name = value => (typeof value === 'string' && CONTAINER.test(value) ? value : null);
const upstream = value => (typeof value === 'string' && UPSTREAM.test(value) && Number(/:(\d+)$/.exec(value)?.[1] ?? 1) < 65536 ? value : null);
const address = value => (typeof value === 'string' && isIP(value) ? value : null);
// A static site's folder: an absolute path of plain characters (shown to the owner, never used to read anything).
const docRoot = value => (typeof value === 'string' && /^\/[\w@%+=:,./-]{0,198}$/.test(value) && !value.includes('..') ? value : null);
const flag = value => (typeof value === 'boolean' ? value : null);

function route(raw) {
  if (!raw || typeof raw !== 'object' || !PROXIES.includes(raw.proxy)) return null;
  const domains = list(raw.domains, domainName, 50);
  if (!domains.length) return null;
  return { proxy: raw.proxy, ...(name(raw.container) ? { container: raw.container } : {}), domains, upstreams: list(raw.upstreams, upstream, 20),
    containers: list(raw.containers, name, 30), static: raw.static === true, ...(raw.static === true && docRoot(raw.root) ? { root: docRoot(raw.root) } : {}), understood: raw.understood !== false,
    listen: list(raw.listen, port, 10), certificates: list(raw.certificates, value => (typeof value === 'string' && LINEAGE.test(value) ? value : null), 10) };
}
// Certbot certificates of this server with the renewal failure category; probe ('tls') facts by host name.
function certificate(raw, at) {
  const fact = normalizeCertificate(raw, at);
  if (!fact) return null;
  const category = fact.renewal === 'failed' && CATEGORIES.includes(raw.renewalCategory) ? raw.renewalCategory : null;
  return { source: fact.source, name: fact.name, notAfter: fact.notAfter, expired: fact.expired, domains: fact.domains, renewal: fact.renewal, ...(category ? { renewalCategory: category } : {}) };
}

// The stored form of one helper answer's `routing` and `certificates`, or null when the answer has no routing facts.
export function normalizeRouting(routing, certificates, at = Date.now()) {
  if (!routing || typeof routing !== 'object' || routing.format !== ROUTING_FORMAT) return null;
  return {
    format: ROUTING_FORMAT, at: new Date(at).toISOString(),
    routes: (Array.isArray(routing.routes) ? routing.routes : []).slice(0, LIMIT).map(route).filter(Boolean),
    notUnderstood: (Array.isArray(routing.notUnderstood) ? routing.notUnderstood : []).slice(0, 50).filter(item => item && PROXIES.includes(item.proxy) && name(item.container) && ROUTER.test(String(item.router))).map(item => ({ proxy: item.proxy, container: item.container, router: item.router })),
    proxies: (Array.isArray(routing.proxies) ? routing.proxies : []).slice(0, 20).filter(item => item && PROXIES.includes(item.proxy)).map(item => ({ proxy: item.proxy, container: name(item.container), running: item.running === true })),
    containers: (Array.isArray(routing.containers) ? routing.containers : []).slice(0, LIMIT).filter(item => item && name(item.name)).map(item => ({ name: item.name, running: item.running === true, health: ['healthy', 'unhealthy', 'starting'].includes(item.health) ? item.health : null, published: list(item.published, port, 64) })),
    addresses: list(routing.addresses, address, 20),
    port80: flag(routing.port80),
    incomplete: routing.incomplete !== false,
    certificates: (Array.isArray(certificates) ? certificates : []).slice(0, 60).map(fact => certificate(fact, at)).filter(Boolean),
  };
}

export function storeRouting(serverId, facts) {
  const text = JSON.stringify(facts);
  // Never over the limit: a fleet-sized answer keeps its first routes and says the list is incomplete.
  const value = text.length <= FACTS_BYTES ? text : JSON.stringify({ ...facts, routes: facts.routes.slice(0, 50), containers: facts.containers.slice(0, 50), incomplete: true });
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY(serverId), value);
}
export function routingOf(serverId) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(KEY(serverId));
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}
