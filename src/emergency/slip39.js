// SLIP-0039 (https://github.com/satoshilabs/slips/blob/master/slip-0039.md): Shamir's secret sharing over GF(256) with
// mnemonic shares, implemented from the specification and checked against its official vectors
// (tests/fixtures/slip39-vectors.json). Node built-ins only, so the offline tool can carry it (src/emergency/bundle.js).
// - generateMnemonics makes ONE group (group threshold 1 of 1) with a member threshold K of N, as the specification
//   recommends for a basic K-of-N scheme. combineMnemonics accepts every valid two-level set, as the vectors require.
// - GF(256) uses exp/log tables. That is not constant time; it is acceptable here because a split or a join is one
//   short local operation on the owner's or a holder's own machine, with no attacker able to time it repeatedly.
import { randomBytes, randomInt, createHmac, pbkdf2Sync } from 'node:crypto';
import { WORDS } from './wordlist.js';

export class MnemonicError extends Error {}
const fail = message => { throw new MnemonicError(message); };

const RADIX_BITS = 10, ID_BITS = 15, CHECKSUM_WORDS = 3, METADATA_WORDS = 7, MIN_SECRET_BYTES = 16, MAX_SHARES = 16;
const SECRET_INDEX = 255, DIGEST_INDEX = 254, DIGEST_BYTES = 4, ROUNDS = 4, BASE_ITERATIONS = 10000;
const MIN_WORDS = METADATA_WORDS + Math.ceil((MIN_SECRET_BYTES * 8) / RADIX_BITS);
const WORD_INDEX = new Map(WORDS.map((word, index) => [word, index]));

// ---- GF(256), Rijndael polynomial x^8 + x^4 + x^3 + x + 1, generator 3 -----------------------------------------
const EXP = new Uint8Array(255), LOG = new Uint8Array(256);
for (let index = 0, value = 1; index < 255; index++) {
  EXP[index] = value; LOG[value] = index;
  value ^= value << 1;
  if (value & 0x100) value ^= 0x11b;
}
// Lagrange interpolation at x of the points (x_i, y_i), byte by byte. LOG[0] is 0, so the j = i term adds nothing.
export function interpolate(shares, x) {
  const xs = new Set(shares.map(share => share.x));
  if (xs.size !== shares.length) fail('Share indices must be unique.');
  const lengths = new Set(shares.map(share => share.value.length));
  if (lengths.size !== 1) fail('All share values must have the same length.');
  const found = shares.find(share => share.x === x);
  if (found) return Buffer.from(found.value);
  const logProduct = shares.reduce((sum, share) => sum + LOG[share.x ^ x], 0), result = Buffer.alloc(shares[0].value.length);
  for (const share of shares) {
    const basis = (((logProduct - LOG[share.x ^ x] - shares.reduce((sum, other) => sum + LOG[share.x ^ other.x], 0)) % 255) + 255) % 255;
    for (let index = 0; index < result.length; index++) if (share.value[index]) result[index] ^= EXP[(LOG[share.value[index]] + basis) % 255];
  }
  return result;
}
const shareDigest = (random, secret) => createHmac('sha256', random).update(secret).digest().subarray(0, DIGEST_BYTES);
function splitSecret(threshold, count, secret) {
  if (threshold === 1) return Array.from({ length: count }, (_, index) => ({ x: index, value: Buffer.from(secret) }));
  const random = randomBytes(secret.length - DIGEST_BYTES);
  const shares = Array.from({ length: threshold - 2 }, (_, index) => ({ x: index, value: randomBytes(secret.length) }));
  const base = [...shares, { x: DIGEST_INDEX, value: Buffer.concat([shareDigest(random, secret), random]) }, { x: SECRET_INDEX, value: secret }];
  for (let index = threshold - 2; index < count; index++) shares.push({ x: index, value: interpolate(base, index) });
  return shares;
}
function recoverSecret(threshold, shares) {
  if (threshold === 1) return shares[0].value;
  const secret = interpolate(shares, SECRET_INDEX), digest = interpolate(shares, DIGEST_INDEX);
  if (!digest.subarray(0, DIGEST_BYTES).equals(shareDigest(digest.subarray(DIGEST_BYTES), secret))) fail('Invalid digest of the shared secret.');
  return secret;
}

// ---- Passphrase encryption: a four-round Feistel network with PBKDF2-HMAC-SHA256 ---------------------------------------
const passphraseBytes = passphrase => {
  if (typeof passphrase !== 'string' || !/^[\x20-\x7e]*$/.test(passphrase)) fail('The passphrase must contain only printable ASCII characters.');
  return Buffer.from(passphrase, 'ascii');
};
const saltOf = (identifier, extendable) => extendable ? Buffer.alloc(0) : Buffer.concat([Buffer.from('shamir'), Buffer.from([identifier >> 8, identifier & 0xff])]);
function feistel(input, passphrase, exponent, identifier, extendable, order) {
  const half = input.length / 2, password = passphraseBytes(passphrase), salt = saltOf(identifier, extendable);
  let left = input.subarray(0, half), right = input.subarray(half);
  for (const round of order) {
    const mask = pbkdf2Sync(Buffer.concat([Buffer.from([round]), password]), Buffer.concat([salt, right]), (BASE_ITERATIONS / ROUNDS) << exponent, half, 'sha256');
    [left, right] = [right, Buffer.from(left.map((byte, index) => byte ^ mask[index]))];
  }
  return Buffer.concat([right, left]);
}
const encrypt = (secret, passphrase, exponent, identifier, extendable) => feistel(secret, passphrase, exponent, identifier, extendable, [0, 1, 2, 3]);
export const decrypt = (encrypted, passphrase, exponent, identifier, extendable) => feistel(encrypted, passphrase, exponent, identifier, extendable, [3, 2, 1, 0]);

// ---- RS1024 checksum ---------------------------------------------------------------------------------------------
const GEN = [0xe0e040, 0x1c1c080, 0x3838100, 0x7070200, 0xe0e0009, 0x1c0c2412, 0x38086c24, 0x3090fc48, 0x21b1f890, 0x3f3f120];
function polymod(values) {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 20;
    checksum = (((checksum & 0xfffff) << 10) ^ value) >>> 0;
    for (let index = 0; index < 10; index++) if ((top >>> index) & 1) checksum = (checksum ^ GEN[index]) >>> 0;
  }
  return checksum;
}
const customization = extendable => [...(extendable ? 'shamir_extendable' : 'shamir')].map(char => char.charCodeAt(0));
const createChecksum = (data, extendable) => { const value = polymod([...customization(extendable), ...data, 0, 0, 0]) ^ 1; return [2, 1, 0].map(shift => (value >>> (10 * shift)) & 1023); };
const checksumValid = (data, extendable) => polymod([...customization(extendable), ...data]) === 1;

// ---- Share <-> mnemonic -----------------------------------------------------------------------------------------
const toWords = (value, count) => Array.from({ length: count }, (_, index) => Number((value >> BigInt(RADIX_BITS * (count - 1 - index))) & 1023n));
const fromWords = words => words.reduce((value, word) => (value << BigInt(RADIX_BITS)) | BigInt(word), 0n);
function encodeShare(share) {
  const valueWords = Math.ceil((share.value.length * 8) / RADIX_BITS);
  const head = (share.identifier << 5) | (share.extendable ? 16 : 0) | share.exponent;
  const groups = (share.groupIndex << 16) | ((share.groupThreshold - 1) << 12) | ((share.groupCount - 1) << 8) | (share.memberIndex << 4) | (share.memberThreshold - 1);
  const data = [...toWords(BigInt(head), 2), ...toWords(BigInt(groups), 2), ...toWords(BigInt('0x' + share.value.toString('hex')), valueWords)];
  return [...data, ...createChecksum(data, share.extendable)].map(index => WORDS[index]).join(' ');
}
export function decodeMnemonic(mnemonic) {
  if (typeof mnemonic !== 'string') fail('A part must be a list of words.');
  const words = mnemonic.trim().toLowerCase().split(/\s+/).filter(Boolean).map(word => WORD_INDEX.get(word) ?? fail('A word is not in the SLIP-0039 word list.'));
  if (words.length < MIN_WORDS) fail('Invalid mnemonic length.');
  const valueWords = words.length - METADATA_WORDS, padding = (RADIX_BITS * valueWords) % 16;
  if (padding > 8) fail('Invalid mnemonic length.');
  const head = words[0] << 10 | words[1], extendable = Boolean((head >> 4) & 1);
  if (!checksumValid(words, extendable)) fail('Invalid mnemonic checksum.');
  const groups = words[2] << 10 | words[3], bytes = (RADIX_BITS * valueWords - padding) / 8, value = fromWords(words.slice(4, -CHECKSUM_WORDS));
  if (value >> BigInt(bytes * 8)) fail('Invalid mnemonic padding.');
  const share = {
    identifier: head >> 5, extendable, exponent: head & 15, groupIndex: groups >> 16, groupThreshold: ((groups >> 12) & 15) + 1, groupCount: ((groups >> 8) & 15) + 1,
    memberIndex: (groups >> 4) & 15, memberThreshold: (groups & 15) + 1, value: Buffer.from(value.toString(16).padStart(bytes * 2, '0'), 'hex'),
  };
  if (share.groupCount < share.groupThreshold) fail('Invalid mnemonic: the group threshold cannot be greater than the group count.');
  return share;
}

// One group, member threshold K of N: each part is 33 words for a 256-bit secret. Returns the parts in member order.
export function generateMnemonics({ secret, threshold, count, passphrase = '', exponent = 1, extendable = true, identifier = randomInt(0, 2 ** ID_BITS) }) {
  if (!Buffer.isBuffer(secret) || secret.length < MIN_SECRET_BYTES || secret.length % 2) fail('The secret must be at least 128 bits and a multiple of 16 bits.');
  if (!Number.isInteger(threshold) || !Number.isInteger(count) || threshold < 2 || threshold > count || count > MAX_SHARES) fail('Use a threshold of at least 2 and at most the number of parts, up to 16 parts.');
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 15 || !Number.isInteger(identifier) || identifier < 0 || identifier >= 2 ** ID_BITS) fail('Invalid share parameters.');
  const encrypted = encrypt(secret, passphrase, exponent, identifier, extendable);
  const members = splitSecret(threshold, count, encrypted);
  return { identifier, mnemonics: members.map(member => encodeShare({ identifier, extendable, exponent, groupIndex: 0, groupThreshold: 1, groupCount: 1, memberIndex: member.x, memberThreshold: threshold, value: member.value })) };
}

// Checks every rule of "Combining the shares" before any interpolation, then returns the master secret.
export function combineMnemonics(mnemonics, passphrase = '') {
  if (!Array.isArray(mnemonics) || !mnemonics.length) fail('The list of parts is empty.');
  const shares = mnemonics.map(decodeMnemonic), [first] = shares;
  for (const field of ['identifier', 'extendable', 'exponent', 'groupThreshold', 'groupCount']) if (shares.some(share => share[field] !== first[field])) fail('These parts do not belong to the same split.');
  if (shares.some(share => share.value.length !== first.value.length)) fail('All parts must have the same length.');
  const groups = Map.groupBy(shares, share => share.groupIndex);
  if (groups.size < first.groupThreshold) fail(`Insufficient number of groups: ${first.groupThreshold} required.`);
  if (groups.size !== first.groupThreshold) fail(`Wrong number of groups: expected ${first.groupThreshold}.`);
  const groupShares = [...groups].map(([groupIndex, members]) => {
    const threshold = members[0].memberThreshold;
    if (members.some(member => member.memberThreshold !== threshold)) fail('These parts disagree on how many are needed.');
    if (new Set(members.map(member => member.memberIndex)).size !== members.length) fail('The same part was entered twice.');
    if (members.length !== threshold) fail(`Wrong number of parts: ${threshold} are needed.`);
    return { x: groupIndex, value: recoverSecret(threshold, members.map(member => ({ x: member.memberIndex, value: member.value }))) };
  });
  return decrypt(recoverSecret(first.groupThreshold, groupShares), passphrase, first.exponent, first.identifier, first.extendable);
}
