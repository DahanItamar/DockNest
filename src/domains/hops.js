// The domain path (docs/domains.md): domain -> DNS -> proxy -> app -> certificate. Pure: it turns facts that were
// already collected into one state per hop (ok, warn, fail or unknown), one reason code and safe parameters
// (addresses, ports and names only). The UI renders the sentence from the code, so wording can improve without a
// migration. Nothing here contacts a server, a resolver or Cloudflare.
import { BlockList, isIP } from 'node:net';
import { covers } from '../alerts/certificates.js';

export const HOPS = Object.freeze(['dns', 'proxy', 'app', 'certificate']);
const RANK = { ok: 0, unknown: 1, warn: 2, fail: 3 };
const DAY = 86400_000;
const hop = (state, reason, params) => ({ state, reason, ...(params && Object.keys(params).length ? { params } : {}) });

// Addresses that are never reachable from the internet: private, CGNAT (also Tailscale), loopback and link-local.
const internal = new BlockList();
for (const [network, prefix] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16]]) internal.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['fc00::', 7], ['fe80::', 10], ['::1', 128]]) internal.addSubnet(network, prefix, 'ipv6');
export const publicAddress = value => isIP(value) > 0 && !internal.check(value, isIP(value) === 6 ? 'ipv6' : 'ipv4');

// Address -> server id, from each server's own interfaces and its connection address.
export function addressOwners(servers) {
  const owners = new Map();
  for (const server of servers) for (const value of server.addresses ?? []) if (!owners.has(value)) owners.set(value, server.id);
  return owners;
}

// DNS hop from one lookup: { addresses (both resolvers' A and AAAA answers), resolvers (how many answered), proxied
// (any answer is a Cloudflare proxy address), cloudflare: null | { token: 'active'|'expired'|null, missing: [], origin } }.
// `fallback` is the server whose proxy holds the domain, for the CGNAT rule.
export function dnsHop(lookup, servers, fallback = null) {
  if (!lookup) return { hop: hop('unknown', 'not-checked'), serverId: null };
  if (!lookup.resolvers) return { hop: hop('unknown', 'dns-unreachable'), serverId: null };
  if (!lookup.addresses.length) return { hop: hop('fail', 'no-record'), serverId: null };
  const owners = addressOwners(servers);
  if (lookup.proxied) {
    const cloudflare = lookup.cloudflare;
    if (!cloudflare) return { hop: hop('warn', 'cloudflare-proxied'), serverId: fallback };
    if (cloudflare.token === 'expired') return { hop: hop('warn', 'cloudflare-token-expired'), serverId: fallback };
    if (cloudflare.missing?.length) return { hop: hop('warn', 'cloudflare-token-limited', { missing: cloudflare.missing }), serverId: fallback };
    if (!cloudflare.origin) return { hop: hop('warn', 'cloudflare-proxied'), serverId: fallback };
    const owner = owners.get(cloudflare.origin);
    return owner ? { hop: hop('ok', 'cloudflare-origin', { address: cloudflare.origin, serverId: owner }), serverId: owner } : { hop: hop('fail', 'wrong-record', { address: cloudflare.origin }), serverId: null };
  }
  const wrong = lookup.addresses.find(value => !owners.has(value));
  if (!wrong) {
    const serverId = owners.get(lookup.addresses.find(value => isIP(value) === 4) ?? lookup.addresses[0]);
    return { hop: hop('ok', 'points-to-server', { addresses: lookup.addresses.slice(0, 8), serverId }), serverId };
  }
  // A server with no public address of its own may sit behind CGNAT or a home router: DNS then names the router, so
  // DockNest cannot tell. Tailscale uses 100.64.0.0/10 too, so this is amber ("may"), never red.
  const behind = servers.find(server => server.id === fallback);
  if (behind?.interfaces?.length && !behind.interfaces.some(publicAddress)) return { hop: hop('warn', 'cgnat', { address: wrong }), serverId: fallback };
  return { hop: hop('fail', 'wrong-record', { address: wrong }), serverId: null };
}

const routesFor = (facts, domain) => (facts?.routes ?? []).filter(route => route.domains.includes(domain)).sort((a, b) => Number(b.understood) - Number(a.understood));
// [{ serverId, container }] the route reaches: containers matched on its own server by the helper, else a published port
// of another connected server named by one of its addresses (http://192.0.2.20:8080).
export function routeTargets(route, serverId, servers) {
  if (route.containers.length) return route.containers.map(container => ({ serverId, container }));
  const owners = addressOwners(servers), found = [];
  for (const value of route.upstreams) {
    const match = /^[a-z0-9+.-]+:\/\/\[?([^\]/]+?)\]?(?::(\d+))?$/.exec(value);
    const owner = match && owners.get(match[1]), other = owner && owner !== serverId ? servers.find(server => server.id === owner) : null;
    if (!other?.facts) continue;
    const wanted = Number(match[2] ?? (value.startsWith('https') ? 443 : 80));
    for (const container of other.facts.containers) if (container.published.includes(wanted)) found.push({ serverId: other.id, container: container.name });
  }
  return found;
}
export const siteOfTargets = (targets, sites) => sites.find(site => targets.some(target => site.serverId === target.serverId && site.containers.includes(target.container))) ?? null;

function proxyHop(domain, server, declared, sites, servers) {
  const facts = server?.facts;
  if (!facts) return { hop: hop('unknown', 'not-checked'), route: null, site: declared };
  // A container DockNest could not read may hide or change any route, so nothing found is ok then. A rule it does not
  // understand only means a missing route may exist after all.
  const partial = facts.incomplete, unknownRoutes = partial || facts.notUnderstood.length > 0;
  const [route] = routesFor(facts, domain);
  // A Cloudflare Tunnel container reaches the app without any proxy rule, so no route is not a failure.
  if (!route && facts.containers.some(item => item.running && /cloudflared/i.test(item.name))) return { hop: hop('unknown', 'tunnel', { serverId: server.id }), route: null, site: declared };
  if (!route) return { hop: unknownRoutes ? hop('warn', 'route-unknown') : hop('fail', 'no-route'), route: null, site: declared };
  const params = { proxy: route.proxy, serverId: server.id, ...(route.container ? { container: route.container } : {}) };
  const proxy = facts.proxies.find(item => item.proxy === route.proxy && (item.container ?? null) === (route.container ?? null));
  if (proxy && !proxy.running) return { hop: hop('fail', 'proxy-stopped', params), route, site: declared };
  if (route.static) {
    const site = declared?.kind === 'static' && declared.serverId === server.id ? declared : null;
    if (site) return { hop: hop(partial ? 'warn' : 'ok', partial ? 'incomplete' : 'static', params), route, site };
    // nginx serves the folder itself and no static app of this server backs it up: that works, so it is a note, not a failure.
    if (!declared) return { hop: hop('warn', 'static-no-app', { ...params, ...(route.root ? { root: route.root } : {}) }), route, site: null };
    return { hop: hop('fail', 'routes-elsewhere', params), route, site: declared };
  }
  if (!route.upstreams.length) return { hop: hop('warn', 'route-unknown', params), route, site: declared };
  const targets = routeTargets(route, server.id, servers), site = siteOfTargets(targets, sites);
  const upstream = { ...params, upstream: route.upstreams[0] };
  if (declared && site?.id !== declared.id) return { hop: hop(partial ? 'warn' : 'fail', partial ? 'route-unknown' : 'routes-elsewhere', upstream), route, site: declared };
  if (!site) return { hop: hop('warn', 'no-app', upstream), route, site: null };
  return { hop: hop(partial ? 'warn' : 'ok', partial ? 'incomplete' : 'routed', { ...upstream, ...(site.serverId !== server.id ? { appServerId: site.serverId } : {}) }), route, site };
}

function appHop(site, proxy, servers) {
  if (proxy.state === 'fail') return hop('unknown', 'skipped');
  if (!site) return hop('unknown', 'no-app');
  if (site.kind === 'static') return hop('ok', 'static');
  const facts = servers.find(server => server.id === site.serverId)?.facts;
  if (!facts) return hop('unknown', 'not-checked');
  for (const container of site.containers) {
    const state = facts.containers.find(item => item.name === container);
    if (!state) return hop('fail', 'missing', { container });
    if (!state.running) return hop('fail', 'stopped', { container });
    if (state.health === 'unhealthy') return hop('fail', 'unhealthy', { container });
    if (state.health === 'starting') return hop('warn', 'starting', { container });
  }
  return hop('ok', 'running');
}

function certificateHop(domain, route, facts, at, days) {
  if (!route) return hop('unknown', 'skipped');
  if (route.proxy !== 'nginx') return hop('unknown', 'managed-by-proxy', { proxy: route.proxy });
  const known = facts.certificates ?? [];
  const tls = known.find(fact => fact.source === 'tls' && fact.name === domain);
  const named = known.filter(fact => fact.source === 'certbot' && route.certificates.includes(fact.name));
  const candidates = [...(tls ? [tls] : []), ...(named.length ? named : known.filter(fact => fact.source === 'certbot' && fact.domains.some(pattern => covers(pattern, domain))))];
  if (!candidates.length) {
    if (route.certificates.length) return hop('unknown', 'not-readable', { name: route.certificates[0] });
    return route.listen.includes(443) ? hop('unknown', 'not-readable') : hop('fail', 'no-certificate');
  }
  const covering = candidates.filter(fact => fact.source === 'tls' || fact.domains.some(pattern => covers(pattern, domain)));
  if (!covering.length) return hop('fail', 'not-covered', { name: candidates[0].name });
  // What a probe of this domain saw wins (what visitors get), else the newest certbot certificate that covers it.
  const fact = covering.find(item => item.source === 'tls') ?? covering.sort((a, b) => String(b.notAfter ?? '').localeCompare(String(a.notAfter ?? '')))[0];
  const end = Date.parse(fact.notAfter ?? ''), params = { name: fact.name, ...(fact.notAfter ? { notAfter: fact.notAfter } : {}) };
  if (fact.expired || (Number.isFinite(end) && end <= at)) return hop('fail', 'expired', params);
  const certbot = fact.source === 'certbot' ? fact : covering.find(item => item.source === 'certbot');
  if (certbot?.renewal === 'failed') {
    const category = certbot.renewalCategory;
    if (['connection-refused', 'timeout'].includes(category) && facts.port80 === false) return hop('warn', 'renewal-port80', params);
    if (category === 'dns') return hop('warn', 'renewal-dns', params);
    if (category === 'rate-limited') return hop('warn', 'renewal-rate-limited', params);
    return hop('warn', 'renewal-failed', { ...params, ...(category ? { category } : {}) });
  }
  if (Number.isFinite(end) && end - at <= days * DAY) return hop('warn', 'expires-soon', { ...params, days: Math.max(0, Math.floor((end - at) / DAY)) });
  return hop('ok', 'valid', params);
}

// One domain's path. context: { sites: [{ id, serverId, kind, domains, containers }], servers: [{ id, addresses,
// interfaces, facts }], lookup (see dnsHop), at, certificateDays }. Returns { serverId, siteId, hops }.
export function domainPath(domain, { sites, servers, lookup, at, certificateDays }) {
  const declared = sites.find(site => site.domains.includes(domain)) ?? null;
  const routing = servers.filter(server => routesFor(server.facts, domain).length);
  // Before DNS is known, the proxy that matters is the one on the app's own server, else the first that routes it.
  const fallback = (declared && routing.find(server => server.id === declared.serverId)) ?? routing[0] ?? servers.find(server => server.id === declared?.serverId) ?? null;
  const dns = dnsHop(lookup, servers, fallback?.id ?? null);
  const proxyServer = servers.find(server => server.id === dns.serverId) ?? fallback;
  const proxy = proxyHop(domain, proxyServer, declared, sites, servers);
  const app = appHop(proxy.site, proxy.hop, servers);
  const certificate = proxy.hop.state === 'fail' && !proxy.route ? hop('unknown', 'skipped') : certificateHop(domain, proxy.route, proxyServer?.facts ?? {}, at, certificateDays);
  return { serverId: dns.serverId ?? proxyServer?.id ?? null, siteId: proxy.site?.id ?? null, hops: { dns: dns.hop, proxy: proxy.hop, app, certificate } };
}

export const worstState = hops => (hops ? HOPS.map(name => hops[name]?.state ?? 'unknown').reduce((worst, state) => (RANK[state] > RANK[worst] ? state : worst), 'ok') : 'unknown');

// The Map's columns: domains grouped by the server their DNS answers with, and "Points nowhere" for domains whose DNS
// reaches no connected server. Domains never checked, or checked without a server, are listed apart.
export function groupDomains(rows) {
  const groups = { servers: {}, pointsNowhere: [], unplaced: [] };
  for (const row of rows) {
    if (row.hops?.dns?.state === 'fail') groups.pointsNowhere.push(row.domain);
    else if (row.serverId) (groups.servers[row.serverId] ??= []).push(row.domain);
    else groups.unplaced.push(row.domain);
  }
  return groups;
}

// What a move of `site` from `sourceId` breaks (docs/domains.md, "Move"): its own domains and the ones the source's
// proxies route to it, and the domains another server's proxy routes to it (the move does not change that proxy).
export function movedDomains(site, sourceId, servers, sites) {
  const source = new Set(), viaProxy = [];
  for (const server of servers) {
    for (const route of server.facts?.routes ?? []) {
      if (siteOfTargets(routeTargets(route, server.id, servers), sites)?.id !== site.id) continue;
      for (const domain of route.domains) {
        if (server.id === sourceId) source.add(domain);
        else if (!viaProxy.some(item => item.domain === domain)) viaProxy.push({ domain, serverId: server.id });
      }
    }
  }
  // A domain only another server's proxy sends here waits for that proxy, not for DNS; it gets the separate warning only.
  const own = [...new Set([...site.domains, ...source])].filter(domain => source.has(domain) || !viaProxy.some(item => item.domain === domain));
  return { own, viaProxy };
}
