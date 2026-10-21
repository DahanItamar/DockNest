import { BlockList, isIP } from 'node:net';

// Probe URLs are fetched as root on the source server. remote/helper.py resolves names and is authoritative;
// this early check refuses IP literals it would always refuse (metadata, link-local, private, multicast, reserved).
const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) blocked.addSubnet(address, prefix, 'ipv6');
export const probeUrlMessage = 'Use an HTTP(S) URL without login details that points to the website domain, a loopback port such as http://127.0.0.1:8080/, or a public address. Private, link-local and cloud metadata addresses are refused.';
export const probeUrlAllowed = value => { try { const url = new URL(value), host = url.hostname.replace(/^\[|\]$/g, ''), family = isIP(host); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !(family && blocked.check(host, family === 6 ? 'ipv6' : 'ipv4')); } catch { return false; } };

// Sites saved before the policy may still store refused URLs. Mirrors probe_policy_preflight in remote/helper.py
// for what the server can see without DNS, so readiness and backup jobs can warn before the helper skips the probe.
export function storedProbeProblem(config = {}) {
  if (config.kind === 'static') return null;
  const maintenance = config.maintenance || {}, targets = [['health URL', config.healthUrl], ['maintenance health URL', maintenance.healthUrl]];
  if (maintenance.required !== false && !maintenance.probeOrigin) targets.push(['public maintenance URL', maintenance.publicUrl]);
  const found = targets.find(([, url]) => url && !probeUrlAllowed(url));
  return found ? { field: found[0], message: `Probe URL policy: the site's ${found[0]} points to a private, link-local or cloud metadata address, or is not a plain HTTP(S) URL. Backups continue with that probe skipped and health checked from container state only. Edit the site to use its domain or a loopback port such as http://127.0.0.1:8080/.` } : null;
}
