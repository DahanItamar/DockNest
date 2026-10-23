// Optional Cloudflare DNS switching for site moves (docs/moving-sites.md, docs/security.md "Cloudflare DNS").
// - The owner pastes an API token scoped to Zone.DNS:Edit. It is sealed with the master key (like SSH keys), stored in
//   settings, decrypted only at the moment of a call, and never returned, logged, audited or journaled.
// - Every request goes to one fixed HTTPS host, without redirects, with a 10 second limit. No token means no request.
import { db, audit } from '../db.js';
import { seal, open } from '../crypto.js';

const API = 'https://api.cloudflare.com/client/v4';
const KEY = 'cloudflare_dns';
const httpError = (status, message) => Object.assign(new Error(message), { status });
// Tests replace `cloudflareHttp.fetch` with a fixture.
export const cloudflareHttp = { fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) }) };

async function call(token, path, { method = 'GET', body } = {}) {
  let response, data = {};
  try { response = await cloudflareHttp.fetch(API + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
  catch { throw httpError(502, 'Cloudflare could not be reached. Try again in a minute.'); }
  try { data = await response.json(); } catch { /* not JSON */ }
  if (!response.ok || data.success === false) {
    // Cloudflare's own message only, never the request (it carries the token in a header).
    const reason = typeof data.errors?.[0]?.message === 'string' ? `: ${data.errors[0].message.replace(/[^\w .,:;()'-]/g, '').slice(0, 160)}` : '.';
    throw httpError([401, 403].includes(response.status) ? 400 : 502, `Cloudflare refused the request${reason}`);
  }
  return data.result;
}

const stored = () => { const row = db.prepare('SELECT value FROM settings WHERE key=?').get(KEY); return row ? JSON.parse(row.value) : null; };
const token = () => { const value = stored(); if (!value) throw httpError(400, 'Connect Cloudflare in Settings first, or choose "I\'ll change DNS myself".'); return open(value.token); };

export function connectionInfo() {
  const value = stored();
  return value ? { configured: true, zones: value.zones.map(zone => zone.name), savedAt: value.savedAt } : { configured: false, zones: [], savedAt: null };
}
// Read calls first: the token must be active, list its zones, and be able to read each zone's DNS records.
export async function connect(raw, actor) {
  const value = String(raw ?? '').trim();
  if (!/^[A-Za-z0-9_-]{30,200}$/.test(value)) throw httpError(400, 'Paste the Cloudflare API token exactly as Cloudflare shows it.');
  const status = await call(value, '/user/tokens/verify');
  if (status?.status !== 'active') throw httpError(400, 'This Cloudflare token is not active.');
  const zones = (await call(value, '/zones?per_page=50') ?? []).map(zone => ({ id: String(zone.id), name: String(zone.name).toLowerCase() })).filter(zone => /^[a-f0-9]{32}$/.test(zone.id));
  if (!zones.length) throw httpError(400, 'This token cannot see any zone. Give it Zone.DNS:Edit on the zone of your site.');
  for (const zone of zones) await call(value, `/zones/${zone.id}/dns_records?per_page=1`);
  db.prepare("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(KEY, JSON.stringify({ token: seal(value), zones, savedAt: new Date().toISOString() }));
  audit(actor, 'dns.connect', null, { provider: 'cloudflare', zones: zones.length });
  return connectionInfo();
}
export function disconnect(actor) {
  db.prepare('DELETE FROM settings WHERE key=?').run(KEY);
  audit(actor, 'dns.disconnect', null, { provider: 'cloudflare' });
  return connectionInfo();
}

export function zoneFor(domain) {
  const name = String(domain).toLowerCase();
  return (stored()?.zones ?? []).filter(zone => name === zone.name || name.endsWith('.' + zone.name)).sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}
export async function records(domain) {
  const zone = zoneFor(domain);
  if (!zone) return null;
  const list = await call(token(), `/zones/${zone.id}/dns_records?name=${encodeURIComponent(domain)}&per_page=20`);
  return (list ?? []).filter(record => ['A', 'AAAA', 'CNAME'].includes(record.type)).map(record => ({ id: String(record.id), type: record.type, name: record.name, value: record.content, proxied: !!record.proxied, ttl: record.ttl, zoneId: zone.id }));
}

export const available = () => !!stored();
// Points the A record (and an AAAA record when the new server has IPv6) at the new server. Returns the journal entry
// needed to switch back: record ids and their previous content, never the token.
export async function switchRecord(domain, { ipv4: v4, ipv6: v6 }) {
  const found = await records(domain);
  if (!found) throw httpError(400, `The Cloudflare token does not cover ${domain}.`);
  const a = found.filter(record => record.type === 'A'), aaaa = found.filter(record => record.type === 'AAAA');
  if (a.length !== 1) throw httpError(409, `${domain} needs exactly one A record for DockNest to switch it.`);
  const changes = [{ record: a[0], content: v4 }, ...(v6 && aaaa.length === 1 ? [{ record: aaaa[0], content: v6 }] : [])];
  const journal = changes.map(({ record }) => ({ zoneId: record.zoneId, recordId: record.id, type: record.type, previous: record.value }));
  for (const { record, content } of changes) if (record.value !== content) await call(token(), `/zones/${record.zoneId}/dns_records/${record.id}`, { method: 'PATCH', body: { content } });
  return journal;
}
export async function revertRecord(journal = []) {
  for (const entry of journal) await call(token(), `/zones/${entry.zoneId}/dns_records/${entry.recordId}`, { method: 'PATCH', body: { content: entry.previous } });
}
// Proxied records answer with Cloudflare addresses in public DNS, so the check reads the record itself.
export async function pointsAt(domain, address) {
  const found = await records(domain);
  const a = (found ?? []).filter(record => record.type === 'A');
  return a.length === 1 && a[0].value === address ? { ok: true } : { ok: false, reason: `Cloudflare still has ${a[0]?.value ?? 'no A record'} for ${domain}.` };
}
