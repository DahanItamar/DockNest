// DNS for site moves (docs/moving-sites.md). Manual by default: DockNest shows the record and waits until public
// resolvers answer with the new server. Outbound traffic is DNS queries only, to fixed public resolvers.
import { Resolver } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';

export const PUBLIC_RESOLVERS = Object.freeze(['1.1.1.1', '8.8.8.8']);

async function lookup(server, name, type) {
  const resolver = new Resolver({ timeout: 4000, tries: 1 });
  resolver.setServers([server]);
  try { return await (type === 'A' ? resolver.resolve4(name) : resolver.resolve6(name)); }
  catch (error) { if (['ENODATA', 'ENOTFOUND'].includes(error.code)) return []; throw error; }
}

// Tests replace `dnsResolver.resolve` with a fixture; it returns { A: [], AAAA: [] } as one resolver sees them.
export const dnsResolver = {
  async resolve(name) {
    const answers = [];
    for (const server of PUBLIC_RESOLVERS) {
      try { answers.push({ A: await lookup(server, name, 'A'), AAAA: await lookup(server, name, 'AAAA') }); } catch { /* one resolver may be unreachable */ }
    }
    return answers;
  },
};

// The domain points at the target when every resolver that answered returns only target addresses, and at least
// one IPv4 answer exists. An AAAA record that still names the old server keeps the check failing (IPv6 visitors).
export function pointsAt(answers, targetAddresses) {
  const allowed = new Set(targetAddresses);
  if (!answers.length) return { ok: false, reason: 'No public DNS resolver answered yet.' };
  for (const answer of answers) {
    if (!answer.A.length) return { ok: false, reason: 'The domain has no IPv4 (A) record yet.' };
    const wrong = [...answer.A, ...answer.AAAA].filter(value => !allowed.has(value));
    if (wrong.length) return { ok: false, reason: `Public DNS still answers ${wrong[0]}.` };
  }
  return { ok: true };
}

// Cloudflare's published proxy ranges (https://www.cloudflare.com/ips/). A domain answering with these is behind the
// orange-cloud proxy, so public DNS never shows the server address and waiting for it would never end. These public
// network addresses are allowlisted by name in scripts/audit-repository.js.
const CLOUDFLARE_RANGES = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22', '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'];
let proxyRanges;
// Tests pass documentation ranges instead of Cloudflare's real ones.
export function setProxyRanges(ranges = CLOUDFLARE_RANGES) {
  proxyRanges = new BlockList();
  for (const range of ranges) { const [address, prefix] = range.split('/'); proxyRanges.addSubnet(address, Number(prefix), address.includes(':') ? 'ipv6' : 'ipv4'); }
}
setProxyRanges();
export const cloudflareProxied = value => isIP(value) > 0 && proxyRanges.check(value, isIP(value) === 6 ? 'ipv6' : 'ipv4');

export async function checkDns(domain, targetAddresses) {
  const answers = await dnsResolver.resolve(domain);
  const result = pointsAt(answers, targetAddresses);
  if (!result.ok && answers.some(answer => [...answer.A, ...answer.AAAA].some(cloudflareProxied))) {
    return { ok: false, proxied: true, reason: `${domain} is behind Cloudflare's proxy (orange cloud), so public DNS shows Cloudflare's addresses instead of your server. Change the record in Cloudflare, then press "I changed it".` };
  }
  return result;
}

export async function currentRecords(domain) {
  try {
    const [answer] = await dnsResolver.resolve(domain);
    return answer ? [...answer.A.map(value => ({ type: 'A', name: domain, value })), ...answer.AAAA.map(value => ({ type: 'AAAA', name: domain, value }))] : [];
  } catch { return []; }
}

export const ipv4 = value => isIP(value) === 4;

// Optional automatic switching with an owner-supplied Cloudflare token (src/moves/cloudflare.js).
export * as cloudflare from './cloudflare.js';
