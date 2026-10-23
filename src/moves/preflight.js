// Move preflight evaluator (docs/moving-sites.md). Pure: it turns facts that were already collected into checks,
// one plain verdict sentence and the details shown under Advanced settings. Collecting the facts over SSH is a
// later step; this file defines their shape. It never sees secret values: env findings arrive masked and are
// masked again here in case a collector forgets.
import { createHash } from 'node:crypto';

/**
 * @typedef {{ hostIp?: string, hostPort: number, containerPort: number, protocol?: 'tcp'|'udp' }} PortBinding
 * @typedef {{ key: string, where: string, kind: 'host'|'ip'|'port', masked: string }} EnvFinding
 * @typedef {{
 *   site: { id: string, name: string, kind: 'compose'|'container'|'static', domains: string[], containerCount?: number,
 *     architecture?: string, packageBytes: number, ports?: PortBinding[], bindPaths?: string[],
 *     names?: { containers?: string[], volumes?: string[], networks?: string[] }, nginxDirectives?: string[],
 *     maintenanceReady?: boolean, env?: EnvFinding[], timings?: { backupSeconds?: number, restoreSeconds?: number } },
 *   source: { id: string, name: string, addresses?: string[] },
 *   target: { id: string, name: string, reachable: boolean, hostKeyOk?: boolean, uid?: number, architecture?: string,
 *     dockerVersion?: string|null, composeVersion?: string|null, freeBytes: number, totalBytes?: number,
 *     usedPorts?: number[], reservedPorts?: number[], existingPaths?: { path: string, empty: boolean }[],
 *     conflicts?: { containers?: string[], volumes?: string[], networks?: string[] },
 *     nginx?: { installed: boolean, configOk?: boolean, serverNames?: string[] }, webPortOwner?: 'nginx'|'other'|null,
 *     certbot?: { installed: boolean, account?: boolean }, stagingWritable?: boolean, addresses?: string[],
 *     transferBytesPerSecond?: number },
 *   state: { sameServer?: boolean, busy?: boolean, archived?: boolean, deploymentHold?: boolean, activeMove?: boolean },
 *   backupStorage?: { freeBytes: number },
 *   dns: { mode: 'manual'|'cloudflare', records?: { type: 'A'|'AAAA'|'CNAME', name: string, value: string, proxied?: boolean }[] },
 * }} MoveFacts
 */

const GiB = 1024 ** 3;
export const PORT_SEARCH_RANGE = 100;
export const FINAL_SYNC_LIMIT_SECONDS = 1800;
const MIN_DOCKER_MAJOR = 28;
const MIN_COMPOSE = [2, 0];
const OVERRIDE_COMPOSE = [2, 24];

const version = text => { const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text ?? '')); return match ? match.slice(1).map(part => Number(part ?? 0)) : null; };
const below = (have, need) => { for (let index = 0; index < need.length; index++) { if ((have[index] ?? 0) !== need[index]) return (have[index] ?? 0) < need[index]; } return false; };
const gb = bytes => (Math.ceil(bytes / GiB * 10) / 10).toString();

// Masked form of an env value: scheme, host and port only. Strips userinfo, paths, query strings and fragments.
export function maskValue(value) {
  const text = String(value ?? '').trim();
  const url = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/?#]*@)?([^/?#@]*)/i.exec(text);
  if (url) return url[1] + url[2];
  const hostPort = /^(?:[^\s/?#]*@)?([A-Za-z0-9.-]+|\[[0-9a-f:]+\])(:\d+)?/i.exec(text);
  return hostPort ? hostPort[1] + (hostPort[2] ?? '') : '';
}

// Picks the host port each published port uses on the target. The container side and the app's own settings never
// change; a port taken on the target moves to the next free one above it (within PORT_SEARCH_RANGE). The host IP
// of each binding is kept, so a loopback-only port stays loopback-only. Any IP counts as taken, to stay safe.
export function planPorts(bindings = [], used = []) {
  const taken = new Set(used), map = [], exhausted = [];
  for (const binding of [...bindings].sort((a, b) => a.hostPort - b.hostPort || a.containerPort - b.containerPort)) {
    let port = binding.hostPort;
    while (taken.has(port) && port <= Math.min(65535, binding.hostPort + PORT_SEARCH_RANGE)) port++;
    if (taken.has(port) || port > Math.min(65535, binding.hostPort + PORT_SEARCH_RANGE)) { exhausted.push(binding); continue; }
    taken.add(port);
    map.push({ hostIp: binding.hostIp ?? '0.0.0.0', protocol: binding.protocol ?? 'tcp', containerPort: binding.containerPort, from: binding.hostPort, to: port });
  }
  return { map, exhausted };
}

// Honest downtime estimate for the final sync: a second backup, the transfer and the restore, all while the
// maintenance page shows. Returns null when there is no timed backup yet.
export function estimateDowntime(facts) {
  const backup = facts.site.timings?.backupSeconds;
  if (!Number.isFinite(backup) || backup < 0) return null;
  const restore = facts.site.timings?.restoreSeconds ?? backup;
  const speed = facts.target.transferBytesPerSecond;
  const transfer = Number.isFinite(speed) && speed > 0 ? facts.site.packageBytes / speed : 0;
  return Math.max(10, Math.ceil(backup + transfer + restore));
}
export function describeDuration(seconds) {
  if (seconds < 90) return `about ${Math.max(10, Math.round(seconds / 10) * 10)} seconds`;
  if (seconds < 5400) return `about ${Math.round(seconds / 60)} minutes`;
  const hours = Math.round(seconds / 360) / 10;
  return `about ${hours} hours`;
}

const check = (id, status, title, text, extra) => ({ id, status, title, text, ...extra });

/** @param {MoveFacts} facts @param {{ envRewrite?: string[] }} [options] */
export function evaluateMove(facts, options = {}) {
  const { site, source, target, state = {}, dns = { mode: 'manual' } } = facts;
  const checks = [], docker = site.kind !== 'static';
  let portMap = [];
  const add = (...args) => checks.push(check(...args));

  // Eligibility comes first; if the target cannot be reached nothing else can be trusted.
  if (state.sameServer || source.id === target.id) add('eligibility', 'block', 'Same server', `This site is already on ${target.name}.`);
  if (!target.reachable || target.hostKeyOk === false) add('eligibility', 'block', 'Server not reachable', `${target.name} could not be reached. Open Servers and test the connection.`);
  if (state.busy || state.archived || state.deploymentHold || state.activeMove) add('eligibility', 'block', 'Site is busy', `Finish or resolve the current work on ${site.name} first.`);
  const reachable = !checks.some(item => item.title === 'Server not reachable');

  if (reachable) {
    if (target.uid !== 0) add('root', 'block', 'Root access', `DockNest needs root SSH on ${target.name} to restore file ownership.`);
    if (target.stagingWritable === false) add('staging', 'block', 'Working folder', `DockNest cannot write to /var/lib/docknest on ${target.name}. Check that the disk is not full or read-only.`);

    const need = site.packageBytes * 3 + GiB;
    if (target.freeBytes < need) add('disk', 'block', 'Disk space', `Needs about ${gb(need)} GB. ${target.name} has ${gb(target.freeBytes)} GB free.`);
    else if (target.totalBytes > 0 && (target.totalBytes - target.freeBytes + need) / target.totalBytes > 0.85) add('disk', 'warn', 'Disk space', `${target.name} will be more than 85% full after the move.`);
    else add('disk', 'ok', 'Disk space', `${target.name} has enough free space.`);
    if (facts.backupStorage && facts.backupStorage.freeBytes < GiB) add('backup', 'block', 'Backup storage', 'Backup storage has less than 1 GB free. Free some space before moving.');

    if (docker) {
      const dockerVersion = version(target.dockerVersion);
      if (!dockerVersion) add('docker', 'block', 'Docker', `Docker is not installed on ${target.name}. DockNest does not install software; install it, then check again.`);
      else if ((site.containerCount ?? 1) > 1 && dockerVersion[0] < MIN_DOCKER_MAJOR) add('docker', 'block', 'Docker', `Docker ${target.dockerVersion} on ${target.name} is too old for this site (needs ${MIN_DOCKER_MAJOR} or newer).`);
      if (site.architecture && target.architecture && site.architecture !== target.architecture) add('docker', 'block', 'Processor type', `${target.name} is ${target.architecture}; ${site.name} was built for ${site.architecture}.`);
      if (dockerVersion && !checks.some(item => item.id === 'docker')) add('docker', 'ok', 'Docker', `Docker ${target.dockerVersion} is ready on ${target.name}.`);
    }
    if (site.kind === 'compose') {
      const compose = version(target.composeVersion);
      if (!compose || below(compose, MIN_COMPOSE)) add('compose', 'block', 'Docker Compose', `Docker Compose 2 is not installed on ${target.name}.`);
      else if (below(compose, OVERRIDE_COMPOSE)) add('compose', 'warn', 'Docker Compose', `Docker Compose ${target.composeVersion} on ${target.name} is older than 2.24, so DockNest recreates the containers itself instead of using a Compose override.`);
    }

    const plan = planPorts(site.ports ?? [], [...(target.usedPorts ?? []), ...(target.reservedPorts ?? [])]);
    for (const binding of plan.exhausted) add('port', 'block', 'Ports', `Port ${binding.hostPort} and the next ${PORT_SEARCH_RANGE} ports are all used on ${target.name}.`);
    for (const entry of plan.map.filter(item => item.from !== item.to)) add('port', 'warn', 'Ports', `Port ${entry.from} is already used on ${target.name}. The site will listen on ${entry.to} instead. Its own settings stay the same.`, { automatic: true });
    if (!plan.exhausted.length && plan.map.every(item => item.from === item.to)) add('port', 'ok', 'Ports', 'The site keeps its ports.');
    portMap = plan.map;

    const existing = new Map((target.existingPaths ?? []).map(item => [item.path, item]));
    for (const folder of site.bindPaths ?? []) if (existing.has(folder) && !existing.get(folder).empty) add('paths', 'block', 'Folders', `${folder} already exists on ${target.name}. DockNest never overwrites existing folders.`);
    const labels = { containers: 'container', volumes: 'volume', networks: 'network' };
    for (const [kind, label] of Object.entries(labels)) for (const name of target.conflicts?.[kind] ?? []) add('names', 'block', 'Names', `A ${label} named ${name} already exists on ${target.name}. DockNest never replaces it.`);

    const nginx = target.nginx ?? { installed: false };
    if (!nginx.installed) add('nginx', 'block', 'nginx', `nginx is not installed on ${target.name}. DockNest does not install software; install it, then check again.`);
    else if (nginx.configOk === false) add('nginx', 'block', 'nginx', `nginx on ${target.name} has a configuration error that DockNest did not cause. Fix it first.`);
    else {
      const served = new Set((nginx.serverNames ?? []).map(name => name.toLowerCase()));
      for (const domain of site.domains) if (served.has(domain.toLowerCase())) add('nginx', 'block', 'nginx', `${domain} is already served by nginx on ${target.name}.`);
      if (target.webPortOwner === 'other') add('nginx', 'block', 'nginx', `Another program uses port 80 on ${target.name}, so nginx cannot serve ${site.domains[0] ?? site.name}.`);
    }
    if (site.nginxDirectives?.length) add('nginx', 'warn', 'nginx settings', `These nginx settings will not be copied: ${[...new Set(site.nginxDirectives)].sort().join(', ')}.`, { advanced: true });
    if (nginx.installed && !checks.some(item => item.id === 'nginx')) add('nginx', 'ok', 'nginx', `nginx is ready on ${target.name}.`);

    const proxied = (dns.records ?? []).some(record => record.proxied);
    if (!proxied && !(target.certbot?.installed && target.certbot?.account)) add('tls', 'warn', 'Certificate', `No certificate tool is set up on ${target.name}. The site will use HTTP until you issue a certificate for ${site.domains[0] ?? site.name}.`);
    if (site.maintenanceReady === false) add('maintenance', 'warn', 'Maintenance page', `No maintenance page is set up for ${site.name}; visitors will see an error during the final sync.`);
  }

  // Env values pointing at the old server. Only masked values are ever kept.
  const rewrite = new Set(options.envRewrite ?? []);
  const env = (site.env ?? []).map(item => ({ key: String(item.key), where: String(item.where), kind: item.kind, masked: maskValue(item.masked), rewrite: rewrite.has(item.key) }));
  for (const item of env) add('env', 'warn', 'Settings that name the old server', `${item.key} in ${item.where} points to the old server (${item.masked}). ${item.rewrite ? `It will point to ${target.name} on the new copy only.` : 'Turn on rewrite under Advanced settings if it should point to the new server.'}`, { advanced: true, key: item.key });

  // DNS record type and current target.
  const records = dns.records ?? [], primary = site.domains[0] ?? site.name;
  const a = records.filter(record => record.type === 'A'), aaaa = records.filter(record => record.type === 'AAAA'), cname = records.filter(record => record.type === 'CNAME');
  if (dns.mode === 'cloudflare' && cname.length) add('dns', 'block', 'DNS', `${primary} is a CNAME record, so DockNest cannot switch it for you. Choose "I'll change DNS myself".`);
  else if (dns.mode === 'cloudflare' && a.length > 1) add('dns', 'block', 'DNS', `${primary} has ${a.length} A records, so DockNest cannot switch it for you. Choose "I'll change DNS myself".`);
  if (!records.length) add('dns', 'warn', 'DNS', `${primary} does not resolve yet; check DNS before you switch.`);
  else if (source.addresses?.length && !a.some(record => source.addresses.includes(record.value)) && !cname.length) add('dns', 'warn', 'DNS', `${primary} does not currently point to ${source.name}; check DNS before you switch.`);
  if (aaaa.length) add('dns', 'warn', 'DNS', dns.mode === 'cloudflare' ? `${primary} also has an IPv6 (AAAA) record. DockNest changes only the IPv4 record; update the IPv6 record yourself.` : `${primary} also has an IPv6 (AAAA) record. Change it too when you switch.`, { advanced: true });

  // Honest downtime: the site is offline during the final sync.
  const seconds = estimateDowntime(facts);
  if (seconds !== null && seconds > FINAL_SYNC_LIMIT_SECONDS) add('downtime', 'block', 'Downtime', `${site.name} is too large to move safely: the final copy would keep it offline for ${describeDuration(seconds)}, longer than the ${FINAL_SYNC_LIMIT_SECONDS / 60} minute limit.`);
  else if (seconds === null) add('downtime', 'warn', 'Downtime', `DockNest cannot estimate the downtime yet because ${site.name} has no timed backup. The move takes a fresh backup first.`);
  const downtime = seconds === null ? null : { seconds, text: dns.mode === 'manual' ? `${describeDuration(seconds)}, then until your DNS change is live` : describeDuration(seconds) };
  if (downtime && !checks.some(item => item.id === 'downtime')) add('downtime', 'info', 'Downtime', `Expected downtime: ${downtime.text}.`);

  const blocks = checks.filter(item => item.status === 'block'), warnings = checks.filter(item => item.status === 'warn');
  const verdict = blocks.length ? 'blocked' : warnings.length ? 'ready-with-notes' : 'ready';
  const sentence = blocks.length ? blocks[0].text
    : `${site.name} is ready to move to ${target.name}. It stays online while the copy is tested${downtime ? `; expected downtime is ${downtime.text}` : ''}.`;
  return { verdict, canStart: !blocks.length, sentence, details: { checks, portMap, env, downtime, blockers: blocks.length, warnings: warnings.length } };
}

// Binds "Start move" to what the owner reviewed. Only the parts that decide what the move will do are hashed.
export function preflightHash(result, options = {}) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const material = { checks: result.details.checks.map(({ id, status, text }) => ({ id, status, text })), portMap: result.details.portMap, options };
  return createHash('sha256').update(JSON.stringify(canonical(material))).digest('hex');
}
