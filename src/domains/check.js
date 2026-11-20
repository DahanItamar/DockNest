// Runs the domain path (docs/domains.md) and stores one row per domain in domain_checks. It runs only on demand
// (POST /api/domains/check, through the job queue in src/domains/jobs.js) and after operations that already contacted a
// server (discover, readiness, backup) or before a Move preview, never on a timer. DNS goes only to the fixed public
// resolvers Move uses (src/moves/dns.js), at most once per domain per hour unless a person asks for a check; Cloudflare
// is read only with the saved token. Results keep their time and are never refreshed in the background.
import { lookup as osLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { db } from '../db.js';
import { dnsResolver, cloudflareProxied, cloudflare } from '../moves/dns.js';
import { certificateDays } from '../alerts/certificates.js';
import { normalizeRouting, storeRouting, routingOf, domainName } from './facts.js';
import { domainPath, groupDomains, worstState, movedDomains } from './hops.js';

export const TRIGGERS = Object.freeze(['manual', 'discover', 'readiness', 'backup', 'move']);
export const DNS_INTERVAL_MS = 3600_000;
const HOPS_BYTES = 8192, DOMAIN_LIMIT = 100, LOOKUPS_AT_ONCE = 4;
// Tests replace these members.
export const domainClock = { now: () => Date.now() };
export const hostResolver = { lookup: async host => (isIP(host) ? [host] : (await osLookup(host, { all: true })).map(entry => entry.address)) };

const configOf = row => { try { return JSON.parse(row.config || '{}') ?? {}; } catch { return {}; } };
const names = values => [...new Set((Array.isArray(values) ? values : []).map(domainName).filter(Boolean))];
function sites() {
  return db.prepare('SELECT id,server_id,config FROM sites WHERE id NOT IN (SELECT site_id FROM site_archives) ORDER BY created_at').all().map(row => {
    const config = configOf(row);
    return { id: row.id, serverId: row.server_id, kind: config.kind === 'static' ? 'static' : 'docker', domains: names(config.domains), containers: (Array.isArray(config.containers) ? config.containers : []).filter(value => typeof value === 'string') };
  });
}
// Each connection host is looked up once per check, however many servers share it.
async function servers() {
  const lookups = new Map(), resolve = host => { if (!lookups.has(host)) lookups.set(host, hostResolver.lookup(host).catch(() => [])); return lookups.get(host); };
  return Promise.all(db.prepare('SELECT id,host FROM servers ORDER BY created_at').all().map(async row => {
    const facts = routingOf(row.id), resolved = await resolve(row.host);
    return { id: row.id, facts, interfaces: facts?.addresses ?? [], addresses: [...new Set([...resolved, ...(facts?.addresses ?? [])])] };
  }));
}
const contextOf = async () => ({ sites: sites(), servers: await servers() });

// One lookup: both resolvers' answers, and for a Cloudflare-proxied answer the token state and the record's origin.
async function lookupDomain(domain, tokens, at) {
  const answers = await dnsResolver.resolve(domain);
  const addresses = [...new Set(answers.flatMap(answer => [...answer.A, ...answer.AAAA]))].slice(0, 16);
  const proxied = addresses.some(cloudflareProxied);
  let origin = null, status = null;
  if (proxied && cloudflare.available() && cloudflare.zoneFor(domain)) {
    const zone = cloudflare.zoneFor(domain).id;
    if (!tokens.has(zone)) tokens.set(zone, await cloudflare.tokenStatus(domain));
    status = tokens.get(zone);
    if (status?.state === 'active' && !status.missing.length) {
      try { origin = (await cloudflare.records(domain))?.find(record => record.type === 'A')?.value ?? null; } catch { status = null; }
    }
  }
  return { at: new Date(at).toISOString(), resolvers: answers.length, addresses, proxied, cloudflare: status ? { token: status.state, missing: status.missing, origin } : null };
}
// The stored hops: states, reason codes and safe parameters, never over 8 KB.
function fit(hops) {
  const text = JSON.stringify(hops);
  if (text.length <= HOPS_BYTES) return text;
  return JSON.stringify(Object.fromEntries(Object.entries(hops).filter(([name]) => name !== 'lookup').map(([name, value]) => [name, { state: value.state, reason: value.reason }])));
}
const storedRow = domain => { const row = db.prepare('SELECT * FROM domain_checks WHERE domain=?').get(domain); try { return row ? { ...row, hops: JSON.parse(row.hops) } : null; } catch { return null; } };
async function pool(items, size, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) { const index = next++; results[index] = await work(items[index]); } }));
  return results;
}

// Checks each domain with the newest stored routing facts and stores the result. `force` (a person pressed Check)
// looks DNS up again even inside the hour. Returns the stored rows.
export async function checkDomains(domains, { trigger, force = false } = {}) {
  if (!TRIGGERS.includes(trigger)) throw new Error('Unknown domain check trigger');
  const list = names(domains).slice(0, DOMAIN_LIMIT);
  if (!list.length) return [];
  const context = await contextOf(), at = domainClock.now(), days = certificateDays(), tokens = new Map();
  const lookups = await pool(list, LOOKUPS_AT_ONCE, async domain => {
    const previous = storedRow(domain)?.hops?.lookup ?? null;
    if (!force && previous && at - Date.parse(previous.at) < DNS_INTERVAL_MS) return previous;
    return lookupDomain(domain, tokens, at).catch(() => previous);
  });
  return list.map((domain, index) => {
    const path = domainPath(domain, { ...context, lookup: lookups[index], at, certificateDays: days });
    const checkedAt = new Date(at).toISOString(), hops = fit({ ...path.hops, ...(lookups[index] ? { lookup: lookups[index] } : {}) });
    db.prepare(`INSERT INTO domain_checks(domain,server_id,site_id,hops,checked_at,trigger) VALUES(?,?,?,?,?,?)
      ON CONFLICT(domain) DO UPDATE SET server_id=excluded.server_id,site_id=excluded.site_id,hops=excluded.hops,checked_at=excluded.checked_at,trigger=excluded.trigger`)
      .run(domain, path.serverId, path.siteId, hops, checkedAt, trigger);
    return view(storedRow(domain));
  });
}

// Every domain one server's facts or apps name, and the ones whose last check placed them there.
async function serverDomains(serverId) {
  const facts = routingOf(serverId);
  return [...new Set([...(facts?.routes ?? []).flatMap(route => route.domains), ...sites().filter(site => site.serverId === serverId).flatMap(site => site.domains),
    ...db.prepare('SELECT domain FROM domain_checks WHERE server_id=?').all(serverId).map(row => row.domain)])];
}
// Stores the routing facts of one helper answer (with the certificate facts it carries). True when they were stored.
export function recordRouting(serverId, answer, at = domainClock.now()) {
  const facts = normalizeRouting(answer?.routing, answer?.certificates, at);
  if (facts) storeRouting(serverId, facts);
  return Boolean(facts);
}
// Takes the routing facts out of a helper answer (they are never returned by the API with it), stores them, and checks
// that server's domains in the background with the hourly DNS limit. Never throws and never delays the operation.
// The answer without its routing facts, which are dropped unstored (a scan that records nothing).
export function withoutRouting(answer) {
  if (!answer || typeof answer !== 'object' || !('routing' in answer)) return answer;
  const { routing: _routing, ...rest } = answer;
  return rest;
}
export function takeRouting({ serverId }, answer, trigger) {
  if (!answer || typeof answer !== 'object' || !('routing' in answer)) return answer;
  const { routing, ...rest } = answer;
  try {
    if (recordRouting(serverId, answer)) serverDomains(serverId).then(domains => checkDomains(domains, { trigger })).catch(error => console.error(`Domains: check skipped (${error.code ?? error.name})`));
  } catch (error) { console.error(`Domains: routing facts skipped (${error.code ?? error.name})`); }
  return rest;
}

function view(row) {
  if (!row) return null;
  const { lookup: _lookup, ...hops } = row.hops ?? {};
  return { domain: row.domain, serverId: row.server_id, siteId: row.site_id, hops, worst: worstState(hops), checkedAt: row.checked_at, trigger: row.trigger };
}
// GET /api/domains: every stored check, plus the apps' domains never checked (hops null, "Check now").
export function domainsView() {
  const rows = db.prepare('SELECT * FROM domain_checks ORDER BY domain').all().map(row => { try { return view({ ...row, hops: JSON.parse(row.hops) }); } catch { return null; } }).filter(Boolean);
  const known = new Set(rows.map(row => row.domain));
  for (const site of sites()) for (const domain of site.domains) if (!known.has(domain)) { known.add(domain); rows.push({ domain, serverId: site.serverId, siteId: site.id, hops: null, worst: 'unknown', checkedAt: null, trigger: null }); }
  return { domains: rows, groups: groupDomains(rows) };
}
// What DockNest knows of a domain: the app it belongs to (the app that lists it, else the app a stored route sends it
// to), and whether any app, stored route or earlier check names it at all.
export async function resolveDomain(domain) {
  const context = await contextOf(), previous = storedRow(domain);
  const path = domainPath(domain, { ...context, lookup: previous?.hops?.lookup ?? null, at: domainClock.now(), certificateDays: certificateDays() });
  const site = context.sites.find(item => item.id === path.siteId) ?? null;
  const routed = context.servers.some(server => (server.facts?.routes ?? []).some(route => route.domains.includes(domain)));
  return { site, known: Boolean(site || previous || routed) };
}
// The domains of one app: its own, and every domain a stored route sends to it.
export async function siteDomains(siteId) {
  const context = await contextOf(), site = context.sites.find(item => item.id === siteId);
  if (!site) return [];
  const moved = movedDomains(site, site.serverId, context.servers, context.sites);
  return [...new Set([...moved.own, ...moved.viaProxy.map(item => item.domain)])];
}
// For a Move preview: what stops working, from the stored facts of every server.
export async function moveDomains(siteId, sourceId) {
  const context = await contextOf(), site = context.sites.find(item => item.id === siteId);
  return site ? movedDomains(site, sourceId, context.servers, context.sites) : { own: [], viaProxy: [] };
}
