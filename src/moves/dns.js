// DNS for site moves (docs/moving-sites.md). Manual by default: DockNest shows the record and waits until public
// resolvers answer with the new server. Outbound traffic is DNS queries only, to fixed public resolvers.
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

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

export async function checkDns(domain, targetAddresses) {
  return pointsAt(await dnsResolver.resolve(domain), targetAddresses);
}

export async function currentRecords(domain) {
  try {
    const [answer] = await dnsResolver.resolve(domain);
    return answer ? [...answer.A.map(value => ({ type: 'A', name: domain, value })), ...answer.AAAA.map(value => ({ type: 'AAAA', name: domain, value }))] : [];
  } catch { return []; }
}

export const ipv4 = value => isIP(value) === 4;

// Cloudflare automation is a later release. This stub fixes the interface the move engine will call; no token is
// stored and no request leaves the server until it is implemented and reviewed (docs/security.md).
export const cloudflare = Object.freeze({
  available: false,
  async switchRecord() { throw Object.assign(new Error('Automatic Cloudflare switching is not available yet. Choose "I\'ll change DNS myself".'), { status: 400 }); },
  async revertRecord() { throw new Error('Automatic Cloudflare switching is not available yet.'); },
});
