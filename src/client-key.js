import { isIP } from 'node:net';

// Rate-limit identity of a client address, shared by the SQLite limiter (src/auth.js) and the in-memory progress
// limiter (src/updates/lock.js). One subscriber normally holds a whole IPv6 /64, so IPv6 is keyed by its /64 prefix
// (otherwise rotating addresses gives a fresh budget per request). An IPv4-mapped IPv6 address, written dotted
// (::ffff:203.0.113.7) or in hex (::ffff:cb00:7107), is keyed as the plain IPv4 address. Dependency-free on purpose.
export function clientKey(address) {
  let value = String(address ?? '').split('%')[0].toLowerCase();
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return value || 'unknown';
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) value = value.slice(0, -v4[0].length) + ((v4[1] << 8) | v4[2]).toString(16) + ':' + ((v4[3] << 8) | v4[4]).toString(16);
  const [head, tail] = value.split('::'), words = part => part ? part.split(':') : [];
  const all = (tail === undefined ? words(head) : [...words(head), ...Array(8 - words(head).length - words(tail).length).fill('0'), ...words(tail)]).map(word => parseInt(word, 16));
  if (all.slice(0, 5).every(word => word === 0) && all[5] === 0xffff) return [all[6] >> 8, all[6] & 255, all[7] >> 8, all[7] & 255].join('.');
  return all.slice(0, 4).map(word => word.toString(16)).join(':') + '::/64';
}
