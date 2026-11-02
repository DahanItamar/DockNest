// Hardening score per site (docs/hardening-score.md). Read-only: DockNest grades how a site's containers are
// configured and never changes them. Facts come from the remote helper during discovery scans and backups that already
// run (remote/helper/discovery.py hardening_facts); nothing here opens a connection or runs on a timer.
//
// Trust: facts arrive from the managed server, so every field is validated and anything unexpected is dropped. Only
// booleans, port bindings, the image reference and capability names are stored, never environment values.
import { db } from './db.js';

export const FACTS_FORMAT = 1;
const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };
// Capabilities that give a container near-host power: adding one is a high finding, any other extra one is medium.
const POWERFUL_CAPABILITIES = new Set(['ALL', 'SYS_ADMIN', 'SYS_MODULE', 'SYS_PTRACE', 'SYS_RAWIO', 'DAC_READ_SEARCH', 'BPF', 'PERFMON', 'SYS_BOOT']);

// One entry per check, in the order the UI lists them. `fails` returns a severity, or null when the container passes.
export const CHECKS = Object.freeze([
  { id: 'privileged', title: 'Privileged mode', fix: 'Remove privileged: true and add only the capabilities it needs.', fails: f => f.privileged ? 'high' : null },
  { id: 'docker-socket', title: 'Docker socket mounted', fix: 'Remove the docker.sock mount or use a read-only socket proxy.', fails: f => f.dockerSocket ? 'high' : null },
  { id: 'extra-capabilities', title: 'Extra capabilities', fix: 'Remove cap_add entries the service does not strictly need.', fails: f => !f.extraCapabilities.length ? null : f.extraCapabilities.some(cap => POWERFUL_CAPABILITIES.has(cap)) ? 'high' : 'medium' },
  { id: 'root-user', title: 'Runs as root', fix: 'Set user: to a non-root UID in the Compose file.', fails: f => f.rootUser && f.rootless !== true ? 'medium' : null },
  { id: 'public-ports', title: 'Ports open on all interfaces', fix: 'Bind ports to 127.0.0.1 and publish through your reverse proxy.', fails: f => f.hostNetwork || f.publicPorts.length ? 'medium' : null },
  { id: 'no-new-privileges', title: 'Privilege escalation allowed', fix: 'Add security_opt: no-new-privileges:true to the service.', fails: f => f.noNewPrivileges ? null : 'low' },
  { id: 'memory-limit', title: 'No memory limit', fix: 'Set mem_limit so one service cannot exhaust server memory.', fails: f => f.memoryLimit ? null : 'low' },
  { id: 'image-tag', title: 'Unpinned image tag', fix: 'Pin the image to a version tag or digest, not latest.', fails: f => f.imagePin === 'latest' || f.imagePin === 'untagged' ? 'low' : null },
  { id: 'healthcheck', title: 'No healthcheck', fix: 'Add a healthcheck so failures are detected and reported.', fails: f => f.healthcheck ? null : 'low' },
]);

const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : null;
// Returns clean facts for one container, or null when the record is not a fact set this release understands (an older
// or newer helper, a missing field, a wrong type). A null container makes the whole scan unusable rather than guessed.
export function cleanFacts(raw) {
  if (!raw || typeof raw !== 'object' || raw.format !== FACTS_FORMAT) return null;
  const flags = ['privileged', 'dockerSocket', 'rootUser', 'hostNetwork', 'memoryLimit', 'healthcheck', 'noNewPrivileges'];
  if (!flags.every(name => typeof raw[name] === 'boolean')) return null;
  if (!(raw.rootless === null || raw.rootless === undefined || typeof raw.rootless === 'boolean')) return null;
  if (!['digest', 'tag', 'latest', 'untagged'].includes(raw.imagePin)) return null;
  const name = text(raw.name, 128), image = raw.image === undefined ? '' : text(raw.image, 255);
  if (!name || image === null || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) return null;
  if (!Array.isArray(raw.publicPorts) || !Array.isArray(raw.extraCapabilities)) return null;
  const ports = raw.publicPorts.slice(0, 20).filter(value => typeof value === 'string' && /^[0-9a-fA-F.:[\]]{1,45}:[0-9?]{1,5}(?:-[0-9]{1,5})?->[0-9]{1,5}(?:-[0-9]{1,5})?\/(?:tcp|udp|sctp)$/.test(value));
  const caps = raw.extraCapabilities.slice(0, 40).filter(value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(value));
  return { format: FACTS_FORMAT, name, image, ...Object.fromEntries(flags.map(flag => [flag, raw[flag]])), rootless: raw.rootless ?? null, imagePin: raw.imagePin, publicPorts: ports, extraCapabilities: caps };
}

const emptyView = () => ({ grade: null, checkedAt: null, passed: 0, total: 0, findings: [] });

// Grading rule (docs/hardening-score.md "Grading"):
//   F  privileged mode or the Docker socket in any container;
//   D  any other high finding, or two or more medium findings;
//   C  one medium finding;
//   B  no medium finding and two or more low findings;
//   A  at most one low finding.
// Each check counts once per site: a multi-container site reports the worst container for each check.
export function gradeHardening(containers, checkedAt = null) {
  const facts = Array.isArray(containers) ? containers.map(cleanFacts) : [];
  if (!facts.length || facts.some(item => !item)) return emptyView();
  const findings = [];
  for (const check of CHECKS) {
    let worst = null;
    for (const item of [...facts].sort((a, b) => a.name.localeCompare(b.name))) {
      const severity = check.fails(item);
      if (severity && (!worst || SEVERITY_RANK[severity] > SEVERITY_RANK[worst.severity])) worst = { severity, container: item.name };
    }
    if (worst) findings.push({ id: check.id, severity: worst.severity, title: check.title, fix: check.fix, container: worst.container });
  }
  const count = severity => findings.filter(item => item.severity === severity).length;
  const fatal = findings.some(item => item.id === 'privileged' || item.id === 'docker-socket');
  const grade = fatal ? 'F' : count('high') || count('medium') >= 2 ? 'D' : count('medium') === 1 ? 'C' : count('low') >= 2 ? 'B' : 'A';
  return { grade, checkedAt, passed: CHECKS.length - findings.length, total: CHECKS.length, findings };
}

// Stores the latest facts for one site. Unusable facts (an older helper, a damaged record) are ignored so the previous
// scan stays visible; the stored JSON is always the cleaned form.
export function recordHardening(siteId, containers, checkedAt = new Date().toISOString(), database = db) {
  if (!Array.isArray(containers) || !containers.length || containers.length > 30) return false;
  const facts = containers.map(cleanFacts);
  if (facts.some(item => !item)) return false;
  database.prepare('INSERT INTO site_hardening(site_id,checked_at,facts) VALUES(?,?,?) ON CONFLICT(site_id) DO UPDATE SET checked_at=excluded.checked_at,facts=excluded.facts').run(siteId, checkedAt, JSON.stringify(facts));
  return true;
}

// A discovery scan covers every container on a server: each active Docker site on it gets the facts of its own
// containers, matched by name or (short) id like the site form. A site with none of its containers present is left alone.
export function recordDiscoveredHardening(serverId, discovered, checkedAt = new Date().toISOString(), database = db) {
  const containers = (Array.isArray(discovered) ? discovered : discovered?.containers || []).filter(item => item && typeof item === 'object');
  if (!containers.length) return 0;
  let recorded = 0;
  const sites = database.prepare('SELECT id,config FROM sites WHERE server_id=? AND id NOT IN (SELECT site_id FROM site_archives)').all(serverId);
  for (const site of sites) {
    let config; try { config = JSON.parse(site.config); } catch { continue; }
    if (config?.kind === 'static' || !Array.isArray(config?.containers) || !config.containers.length) continue;
    const matched = config.containers.map(wanted => containers.find(item => item.name === wanted || (typeof item.id === 'string' && wanted.length >= 12 && item.id.startsWith(wanted)))).filter(Boolean);
    if (matched.length && recordHardening(site.id, matched.map(item => item.hardening), checkedAt, database)) recorded += 1;
  }
  return recorded;
}

// The API view for one site. Never scanned, a static site, or facts this release cannot read: grade null, no findings.
export function hardeningView(siteId, database = db) {
  let row;
  try { row = database.prepare('SELECT checked_at,facts FROM site_hardening WHERE site_id=?').get(siteId); } catch { return emptyView(); }
  if (!row) return emptyView();
  let facts; try { facts = JSON.parse(row.facts); } catch { return emptyView(); }
  return gradeHardening(facts, row.checked_at);
}
