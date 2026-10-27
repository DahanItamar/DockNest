// Address policy for alert traffic (docs/alert-channels.md, "Outbound safety"). One place decides what an address is:
// - 'refused': never reached, even with "Allow private network" on: unspecified, loopback, link-local and cloud metadata,
//   IETF special-use, documentation and benchmark ranges, multicast, reserved and broadcast, and every IPv6 form that
//   embeds or tunnels to one of those (IPv4-mapped, IPv4-translated, IPv4-compatible, NAT64, 6to4, Teredo).
// - 'private': RFC 1918, CGNAT and IPv6 unique local. Reached only by an admin-saved Connection while the setting is on.
// - 'public': everything else that is global unicast.
// Literals come in canonical form from the WHATWG URL parser (decimal, octal, hex and short IPv4 forms are already
// rewritten to dotted quads there); `classify` still refuses anything `isIP` does not accept, and IPv6 zone ids.
import { BlockList, isIP } from 'node:net';

const refused4 = new BlockList(), private4 = new BlockList(), refused6 = new BlockList(), private6 = new BlockList(), global6 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], // unspecified, loopback, link-local (169.254.169.254 metadata)
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24], ['198.18.0.0', 15], ['192.88.99.0', 24], // special-use, documentation, benchmark, 6to4 relay
  ['100.100.100.200', 32], ['100.100.100.100', 32], ['168.63.129.16', 32], // Alibaba metadata, Tailscale resolver, Azure host endpoint
  ['224.0.0.0', 4], ['240.0.0.0', 4], // multicast; reserved, with 255.255.255.255 broadcast
]) refused4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10]]) private4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['fd00:ec2::254', 128], // AWS IPv6 metadata, inside the unique local range
  ['2001::', 32], ['2001:2::', 48], ['2001:10::', 28], ['2001:20::', 28], ['2001:db8::', 32], ['3fff::', 20], // Teredo, benchmark, ORCHID, documentation
]) refused6.addSubnet(address, prefix, 'ipv6');
private6.addSubnet('fc00::', 7, 'ipv6');
global6.addSubnet('2000::', 3, 'ipv6'); // global unicast; anything else that is not unique local is refused (fe80::, ff00::, 100::, fec0::)

export const REFUSED_NAMES = Object.freeze(['localhost', 'metadata', 'metadata.google.internal', 'instance-data', 'instance-data.ec2.internal']);
// Host names refused before any lookup. A trailing dot is the same name.
export const nameRefused = host => { const name = String(host).toLowerCase().replace(/\.$/, ''); return REFUSED_NAMES.includes(name) || name.endsWith('.localhost'); };

// Eight 16-bit words of a valid IPv6 address (with or without a trailing dotted quad).
function ipv6Words(address) {
  let text = address.toLowerCase();
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (quad) { const [a, b, c, d] = quad.slice(1).map(Number); text = `${text.slice(0, quad.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`; }
  const [head, tail] = text.split('::'), words = part => (part ? part.split(':').map(word => parseInt(word, 16)) : []);
  return tail === undefined ? words(head) : [...words(head), ...Array(8 - words(head).length - words(tail).length).fill(0), ...words(tail)];
}
const quadOf = (high, low) => [high >> 8, high & 255, low >> 8, low & 255].join('.');
const zeros = (words, from, to) => words.slice(from, to).every(word => word === 0);

function classify4(address) {
  if (refused4.check(address, 'ipv4')) return 'refused';
  return private4.check(address, 'ipv4') ? 'private' : 'public';
}
function classify6(address) {
  const words = ipv6Words(address);
  if (words.length !== 8) return 'refused';
  // Forms that carry an IPv4 address are judged by that address.
  if (zeros(words, 0, 5) && words[5] === 0xffff) return classify4(quadOf(words[6], words[7])); // ::ffff:a.b.c.d, IPv4-mapped
  if (zeros(words, 0, 4) && words[4] === 0xffff && words[5] === 0) return classify4(quadOf(words[6], words[7])); // ::ffff:0:a.b.c.d, IPv4-translated
  if (zeros(words, 0, 6)) return 'refused'; // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d
  if (words[0] === 0x64 && words[1] === 0xff9b && zeros(words, 2, 6)) return classify4(quadOf(words[6], words[7])); // NAT64 64:ff9b::/96
  if (words[0] === 0x64 && words[1] === 0xff9b) return 'refused'; // local-use NAT64 64:ff9b:1::/48 and the rest of 64:ff9b::/32
  if (words[0] === 0x2002) return classify4(quadOf(words[1], words[2])); // 6to4
  if (refused6.check(address, 'ipv6')) return 'refused';
  if (private6.check(address, 'ipv6')) return 'private';
  return global6.check(address, 'ipv6') ? 'public' : 'refused';
}
// 'public' | 'private' | 'refused' for one address. Anything that is not a plain IP literal is refused.
export function classify(address) {
  if (typeof address !== 'string' || address.includes('%')) return 'refused'; // IPv6 zone ids
  const family = isIP(address);
  return family === 4 ? classify4(address) : family === 6 ? classify6(address) : 'refused';
}
