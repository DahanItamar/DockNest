// Certificate alerts (docs/alerts.md, "Certificates"). DockNest never contacts a server or a site for this: the helper
// adds certificate facts to the answers of operations that already run (connection test, discover, readiness, backup),
// and this module stores the latest facts per site and turns them into "certificate.expiring" and
// "certificate.renewal_failed" events. The worker's existing alert tick re-judges the stored facts as days pass, the same
// way the disk alert reads stored server facts; nothing here opens a connection or starts a timer.
//
// Facts from the helper (remote/helper/net.py): { source: 'tls' | 'certbot', name, notAfter (epoch s), domains[], serial?,
// expired?, renewal?: 'ok' | 'failed' }. A 'tls' fact is what a probe of THIS site saw; a 'certbot' fact is a certificate
// on the server, matched to every site on it whose domains it covers (wildcards cover one label).
import { db, audit } from '../db.js';
import { emit } from './delivery.js';
import { ruleMatches } from './events.js';
import { enabledRules } from './store.js';

export const CERT_DAYS_KEY = 'alerts_certificate_days';
export const CERT_DAYS = Object.freeze({ default: 14, min: 1, max: 90 });
export function certificateDays() {
  const value = Number(db.prepare('SELECT value FROM settings WHERE key=?').get(CERT_DAYS_KEY)?.value);
  return Number.isInteger(value) && value >= CERT_DAYS.min && value <= CERT_DAYS.max ? value : CERT_DAYS.default;
}
export function setCertificateDays(days, actor, role) {
  if (role !== 'admin') throw Object.assign(new Error('Only an administrator can change this setting.'), { status: 403, code: 'ALERTS_ADMIN_REQUIRED' });
  if (!Number.isInteger(days) || days < CERT_DAYS.min || days > CERT_DAYS.max) throw Object.assign(new Error(`Choose ${CERT_DAYS.min} to ${CERT_DAYS.max} days.`), { status: 400 });
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(CERT_DAYS_KEY, String(days));
  audit(actor, 'alerts.certificate_days', null, { days, role });
  // A longer warning can bring a certificate inside it now; judged from the stored facts, no server is contacted.
  detectCertificates();
  return { certificateDays: certificateDays() };
}

const NAME = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const LINEAGE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const host = value => String(value ?? '').toLowerCase().replace(/\.$/, '');
// One fact as the helper sent it, checked field by field; anything odd is dropped, never stored.
// A certbot certificate that nothing renews (no renewal settings) and that has already expired is an orphan left on
// disk, not what a site serves: it is dropped, so it can never raise a false "expired" alert.
function normalize(fact, at = Date.now()) {
  if (!fact || typeof fact !== 'object' || !['tls', 'certbot'].includes(fact.source)) return null;
  const name = fact.source === 'tls' ? host(fact.name) : String(fact.name ?? '');
  if (!(fact.source === 'tls' ? NAME.test(name) || /^[0-9a-f.:]{2,45}$/.test(name) : LINEAGE.test(name))) return null;
  const seconds = Number(fact.notAfter), notAfter = Number.isFinite(seconds) && seconds > 0 && seconds < 1e11 ? new Date(seconds * 1000).toISOString() : null;
  const expired = fact.source === 'tls' && fact.expired === true;
  if (!notAfter && !expired) return null;
  const domains = Array.isArray(fact.domains) ? fact.domains.map(host).filter(value => NAME.test(value)).slice(0, 50) : [];
  const serial = typeof fact.serial === 'string' && /^[0-9A-F]{1,64}$/i.test(fact.serial) ? fact.serial.toUpperCase() : null;
  if (fact.source === 'certbot' && fact.renews === false && notAfter && Date.parse(notAfter) <= at) return null;
  const renewal = fact.source === 'certbot' && ['ok', 'failed'].includes(fact.renewal) ? fact.renewal : null;
  // When the failed renewal run happened (its log time): a later failure is a new one, even for the same certificate.
  const runAt = Number(fact.renewalAt), renewalAt = renewal === 'failed' && Number.isFinite(runAt) && runAt > 0 && runAt < 1e11 ? new Date(runAt * 1000).toISOString() : null;
  return { source: fact.source, name, notAfter, expired, domains, serial, renewal, renewalAt };
}
// A certificate name covers a site domain exactly, or as a wildcard for exactly one more label (*.example.com covers
// shop.example.com, not example.com and not a.shop.example.com).
export function covers(pattern, domain) {
  if (pattern === domain) return true;
  if (!pattern.startsWith('*.')) return false;
  const suffix = pattern.slice(1), label = domain.slice(0, -suffix.length);
  return domain.endsWith(suffix) && label.length > 0 && !label.includes('.');
}
const domainsOf = site => { try { const list = JSON.parse(site.config || '{}')?.domains; return Array.isArray(list) ? list.map(host).filter(Boolean) : []; } catch { return []; } };
const STALE_MS = 7 * 86400_000;

// Stores what an operation's answer said. scope.siteId: the operation ran for that site (its probes' 'tls' facts are its
// own). scope.serverId: the server it ran on ('certbot' facts update every site there they cover). `facts` missing
// (an answer without the field) changes nothing. Returns the number of alerts queued. Never throws.
export function recordCertificates({ serverId, siteId = null }, facts, { at = Date.now() } = {}) {
  if (!Array.isArray(facts)) return 0;
  try {
    const list = facts.slice(0, 60).map(fact => normalize(fact, at)).filter(Boolean), checked = new Date(at).toISOString(), touched = [];
    const sites = db.prepare('SELECT id,config FROM sites WHERE server_id=? AND id NOT IN (SELECT site_id FROM site_archives)').all(serverId);
    for (const site of sites) {
      const own = site.id === siteId, domains = domainsOf(site);
      // What visitors see: this site's own probe, preferably of one of its domains.
      const probes = own ? list.filter(fact => fact.source === 'tls') : [];
      const tls = probes.find(fact => domains.includes(fact.name)) ?? probes[0] ?? null;
      // The certbot certificate for this site: the newest one covering any of its domains.
      const certbot = list.filter(fact => fact.source === 'certbot' && fact.domains.some(pattern => domains.some(domain => covers(pattern, domain)))).sort((a, b) => String(b.notAfter).localeCompare(String(a.notAfter)))[0] ?? null;
      const row = db.prepare('SELECT * FROM site_certificates WHERE site_id=?').get(site.id);
      if (!tls && !certbot) {
        // A backup or readiness check of this site that saw no certificate at all, and none for a week: the site has no
        // TLS any more. A probe that failed for a day or two (site down) keeps the facts and what they already alerted.
        if (own && row && !(Date.parse(row.checked_at) > at - STALE_MS)) db.prepare('DELETE FROM site_certificates WHERE site_id=?').run(site.id);
        continue;
      }
      let next;
      if (tls) next = { source: 'tls', name: tls.name, serial: tls.serial ?? (tls.expired ? certbot?.serial ?? null : null), notAfter: tls.notAfter ?? (tls.expired ? certbot?.notAfter ?? row?.not_after ?? null : null), expired: tls.expired ? 1 : 0 };
      // A certbot file replaces a probe's facts only when it is newer: a renewed certificate on disk is served after the
      // web server reloads, while an older file than the one served never wins over what visitors see.
      else if (!row || row.source === 'certbot' || !row.not_after || certbot.notAfter > row.not_after) next = { source: 'certbot', name: certbot.name, serial: certbot.serial, notAfter: certbot.notAfter, expired: 0 };
      else next = { source: row.source, name: row.name, serial: row.serial, notAfter: row.not_after, expired: row.expired };
      // Renewal: certbot's newest outcome (the helper already ignores a failure logged before the current certificate was
      // issued). A later expiry than the stored one also means the certificate was renewed.
      let renewal = certbot ? certbot.renewal ?? row?.renewal ?? null : row?.renewal ?? null;
      if (renewal === 'failed' && row?.not_after && next.notAfter && next.notAfter > row.not_after && !certbot?.renewal) renewal = 'ok';
      // A failure from another run than the one already told is a new failure.
      const failedAt = renewal === 'failed' ? certbot?.renewalAt ?? row?.renewal_failed_at ?? null : null;
      const renewalAlerted = renewal === 'failed' && failedAt === (row?.renewal_failed_at ?? null) ? row?.renewal_alerted ?? 0 : 0;
      db.prepare(`INSERT INTO site_certificates(site_id,source,name,serial,not_after,expired,renewal,renewal_failed_at,checked_at,alerted_not_after,alerted_stage,renewal_alerted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(site_id) DO UPDATE SET source=excluded.source,name=excluded.name,serial=excluded.serial,not_after=excluded.not_after,expired=excluded.expired,renewal=excluded.renewal,renewal_failed_at=excluded.renewal_failed_at,checked_at=excluded.checked_at,renewal_alerted=excluded.renewal_alerted`)
        .run(site.id, next.source, next.name.slice(0, 255), next.serial, next.notAfter, next.expired, renewal, failedAt, checked, row?.alerted_not_after ?? null, row?.alerted_stage ?? null, renewalAlerted);
      touched.push(site.id);
    }
    return touched.length ? detectCertificates(at, touched) : 0;
  } catch (error) { console.error(`Alerts: certificate facts skipped (${error.code ?? error.name})`); return 0; }
}
// Takes the certificate facts out of a helper answer (so they are never stored with server capabilities or returned by
// the API) and records them. Returns the answer without the field.
export function takeCertificates(scope, answer, options) {
  if (!answer || typeof answer !== 'object' || !('certificates' in answer)) return answer;
  const { certificates, ...rest } = answer;
  recordCertificates(scope, certificates, options);
  return rest;
}

// 'expired', 'expiring' (inside the warning days) or null.
const RANK = { expiring: 1, expired: 2 };
export function stageOf(row, at = Date.now(), days = certificateDays()) {
  if (row.expired) return 'expired';
  const end = Date.parse(row.not_after ?? '');
  if (!Number.isFinite(end)) return null;
  if (end <= at) return 'expired';
  return end - at <= days * 86400_000 ? 'expiring' : null;
}
// The same certificate seen through several sites (a wildcard, or a probe and the certbot file) has one identity, so
// each channel hears about it once: its serial, else where it came from.
const identityOf = (row, serverId) => (row.serial ? `serial:${row.serial}` : `${row.source}:${serverId}:${row.name}`);
// Judges the stored facts: one alert per certificate per stage (expiring, then expired) for each expiry date, so a
// renewal (a new date) can alert again and a repeat never does; a renewal failure alerts once per failed run. While no
// line wants an event it is skipped before anything is queued and later ticks try again, so turning the event on still
// tells you. Once a line wants it, it counts as told (queued now, or already queued for this certificate through another
// site). Returns the number queued.
const wanted = event => enabledRules().some(rule => ruleMatches(rule, event));
export function detectCertificates(at = Date.now(), siteIds = null) {
  const days = certificateDays(); let count = 0;
  const rows = db.prepare(`SELECT c.*,s.name AS site,v.id AS server_id,v.name AS server FROM site_certificates c JOIN sites s ON s.id=c.site_id JOIN servers v ON v.id=s.server_id
    WHERE c.site_id NOT IN (SELECT site_id FROM site_archives) ORDER BY c.site_id`).all().filter(row => !siteIds || siteIds.includes(row.site_id));
  for (const row of rows) {
    const identity = identityOf(row, row.server_id), base = { siteId: row.site_id, serverId: row.server_id, siteName: row.site, serverName: row.server };
    const stage = stageOf(row, at, days);
    if (stage && (row.alerted_not_after !== row.not_after || (RANK[stage] ?? 0) > (RANK[row.alerted_stage] ?? 0))) {
      const left = Math.max(0, Math.floor((Date.parse(row.not_after) - at) / 86400_000));
      const event = { ...base, type: 'certificate.expiring', code: stage === 'expired' ? 'expired' : undefined, daysLeft: Number.isFinite(left) ? left : undefined, key: `occ:cert:${identity}:${row.not_after ?? 'unknown'}:${stage}` };
      if (wanted(event)) {
        count += emit(event, { at });
        db.prepare('UPDATE site_certificates SET alerted_not_after=?,alerted_stage=? WHERE site_id=?').run(row.not_after, stage, row.site_id);
      }
    }
    if (row.renewal === 'failed' && !row.renewal_alerted) {
      const event = { ...base, type: 'certificate.renewal_failed', key: `occ:cert-renewal:${identity}:${row.not_after ?? 'unknown'}:${row.renewal_failed_at ?? 'unknown'}` };
      if (wanted(event)) {
        count += emit(event, { at });
        db.prepare('UPDATE site_certificates SET renewal_alerted=1 WHERE site_id=?').run(row.site_id);
      }
    }
  }
  return count;
}
