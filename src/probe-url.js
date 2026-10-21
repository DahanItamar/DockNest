import { BlockList, isIP } from 'node:net';

// Probe URLs are fetched as root on the source server. remote/helper.py resolves names and is authoritative;
// this early check refuses IP literals it would always refuse (metadata, link-local, private, multicast, reserved).
const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) blocked.addSubnet(address, prefix, 'ipv4');
// Same IPv6 special ranges as the helper: IPv4-compatible, local-use NAT64, Teredo, documentation and discard.
for (const [address, prefix] of [['::', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['64:ff9b:1::', 48], ['2001::', 32], ['2001:db8::', 32], ['100::', 64]]) blocked.addSubnet(address, prefix, 'ipv6');
const ipv6Words = host => { const [head, tail] = host.split('::'), words = part => part ? part.split(':').map(word => parseInt(word, 16)) : []; return tail === undefined ? words(head) : [...words(head), ...Array(8 - words(head).length - words(tail).length).fill(0), ...words(tail)]; };
// 6to4 and NAT64 addresses reach the IPv4 they embed; only a public IPv4 is acceptable there.
const embeddedIpv4 = words => { const join = (high, low) => [high >> 8, high & 255, low >> 8, low & 255].join('.'); if (words[0] === 0x2002) return join(words[1], words[2]); if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every(word => word === 0)) return join(words[6], words[7]); return null; };
const ipv6Allowed = host => { if (host === '::1') return true; const embedded = embeddedIpv4(ipv6Words(host)); if (embedded) return !blocked.check(embedded, 'ipv4') && !embedded.startsWith('127.'); return !blocked.check(host, 'ipv6'); };
export const probeUrlMessage = 'Use an HTTP(S) URL without login details that points to the website domain, a loopback port such as http://127.0.0.1:8080/, or a public address. Private, link-local and cloud metadata addresses are refused.';
export const probeUrlAllowed = value => { try { const url = new URL(value), host = url.hostname.replace(/^\[|\]$/g, ''), family = isIP(host); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && (family === 6 ? ipv6Allowed(host) : !(family && blocked.check(host, 'ipv4'))); } catch { return false; } };

// Sites saved before the policy may still store refused URLs. Mirrors probe_policy_preflight in remote/helper.py
// for what the server can see without DNS, so readiness and backup jobs can warn before the helper skips the probe.
export function storedProbeProblem(config = {}) {
  if (config.kind === 'static') return null;
  const maintenance = config.maintenance || {}, targets = [['health URL', config.healthUrl], ['maintenance health URL', maintenance.healthUrl]];
  // Same rule as the helper: the public probe runs only when maintenance is explicitly required.
  if (maintenance.required === true && !maintenance.probeOrigin) targets.push(['public maintenance URL', maintenance.publicUrl]);
  const found = targets.find(([, url]) => url && !probeUrlAllowed(url));
  return found ? { field: found[0], message: `Probe URL policy: the site's ${found[0]} points to a private, link-local or cloud metadata address, or is not a plain HTTP(S) URL. Backups continue with that probe skipped and health checked from container state only. Edit the site to use its domain or a loopback port such as http://127.0.0.1:8080/.` } : null;
}
