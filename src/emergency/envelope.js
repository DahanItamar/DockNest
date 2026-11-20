// The emergency kit envelope (docs/emergency-kit.md, "File format"): the recovery kit sealed to an X25519 public key whose
// private key exists only as SLIP-0039 parts. Node built-ins only, so the offline tool can carry it (bundle.js).
//   "DKE1" | header length (2 bytes, big-endian) | header JSON | nonce (12) | AES-256-GCM ciphertext | tag (16)
// The header is { format, digest, ephemeralPublicKey, createdAt, release } and is authenticated as additional data with
// the nonce. The key is HKDF-SHA256(X25519(ephemeral, recipient), salt = ephemeral public || recipient public,
// info = "docknest emergency kit v1"). digest = SHA-256("docknest emergency v1" || recipient public key).
// The sealed payload holds the recovery kit file and the recovery passphrase it opens with, so K holders get a kit that
// `node scripts/recovery-kit.js restore` accepts without knowing the owner's passphrase.
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';

export const ENVELOPE_FORMAT = 1;
export const ENVELOPE_MAX_BYTES = 128 * 1024 * 1024 + 64 * 1024;
const MAGIC = Buffer.from('DKE1'), PAYLOAD_MAGIC = Buffer.from('DKP1'), INFO = 'docknest emergency kit v1', DIGEST_LABEL = 'docknest emergency v1';
const KEY_BYTES = 32, NONCE_BYTES = 12, TAG_BYTES = 16, HEADER_MAX = 1024;
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex'), SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export class EnvelopeError extends Error {}
const fail = message => { throw new EnvelopeError(message); };
const raw = (bytes, what) => Buffer.isBuffer(bytes) && bytes.length === KEY_BYTES ? bytes : fail(`The ${what} must be 32 bytes.`);
const privateKeyObject = privateKey => createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw(privateKey, 'private key')]), format: 'der', type: 'pkcs8' });
const publicKeyObject = publicKey => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw(publicKey, 'public key')]), format: 'der', type: 'spki' });
const rawPublic = key => key.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);

export const publicKeyDigest = publicKey => createHash('sha256').update(DIGEST_LABEL).update(raw(publicKey, 'public key')).digest('hex');
export const publicKeyOf = privateKey => rawPublic(createPublicKey(privateKeyObject(privateKey)));
export function generateKeyPair() {
  const { privateKey } = generateKeyPairSync('x25519');
  const secret = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_PREFIX.length);
  return { privateKey: Buffer.from(secret), publicKey: publicKeyOf(secret) };
}
// RFC 7748 X25519 of a raw scalar and a raw u-coordinate (Node clamps the scalar and masks the top bit of u).
export const x25519 = (privateKey, publicKey) => diffieHellman({ privateKey: privateKeyObject(privateKey), publicKey: publicKeyObject(publicKey) });
function sharedKey(privateKey, publicKey, ephemeralPublic, recipientPublic) {
  const shared = x25519(privateKey, publicKey);
  if (shared.every(byte => byte === 0)) fail('The key exchange produced no shared secret.');
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeralPublic, recipientPublic]), INFO, KEY_BYTES));
}

const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
function validHeader(header) {
  const keys = ['createdAt', 'digest', 'ephemeralPublicKey', 'format', 'release'];
  if (!header || typeof header !== 'object' || Array.isArray(header) || Object.keys(header).sort().join() !== keys.join()) fail('Not a DockNest emergency kit.');
  if (header.format !== ENVELOPE_FORMAT) fail('This emergency kit needs a newer version of the tool.');
  if (typeof header.digest !== 'string' || !/^[0-9a-f]{64}$/.test(header.digest)) fail('Not a DockNest emergency kit.');
  if (typeof header.ephemeralPublicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(header.ephemeralPublicKey)) fail('Not a DockNest emergency kit.');
  if (typeof header.createdAt !== 'string' || !iso.test(header.createdAt) || Number.isNaN(Date.parse(header.createdAt))) fail('Not a DockNest emergency kit.');
  if (typeof header.release !== 'string' || !/^[\x20-\x7e]{1,64}$/.test(header.release)) fail('Not a DockNest emergency kit.');
  return header;
}
function parse(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < MAGIC.length + 2 + NONCE_BYTES + TAG_BYTES || bytes.length > ENVELOPE_MAX_BYTES || !bytes.subarray(0, 4).equals(MAGIC)) fail('Not a DockNest emergency kit.');
  const length = bytes.readUInt16BE(4), end = 6 + length;
  if (length < 2 || length > HEADER_MAX || bytes.length < end + NONCE_BYTES + TAG_BYTES) fail('Not a DockNest emergency kit.');
  let header; try { header = JSON.parse(bytes.subarray(6, end).toString('utf8')); } catch { fail('Not a DockNest emergency kit.'); }
  return { header: validHeader(header), aad: bytes.subarray(0, end + NONCE_BYTES), nonce: bytes.subarray(end, end + NONCE_BYTES), body: bytes.subarray(end + NONCE_BYTES, -TAG_BYTES), tag: bytes.subarray(-TAG_BYTES) };
}
// The header, read without any key: the tool lists kits by it (newest first) and checks the digest before a decrypt.
export const readEnvelopeHeader = bytes => parse(bytes).header;

// `ephemeralPrivateKey` and `nonce` are for the fixed test vectors only; a kit always gets fresh random values.
export function seal(payload, { publicKey, createdAt = new Date().toISOString(), release, ephemeralPrivateKey = generateKeyPair().privateKey, nonce = randomBytes(NONCE_BYTES) }) {
  const ephemeralPublic = publicKeyOf(ephemeralPrivateKey);
  const header = validHeader({ format: ENVELOPE_FORMAT, digest: publicKeyDigest(publicKey), ephemeralPublicKey: ephemeralPublic.toString('base64url'), createdAt, release });
  const json = Buffer.from(JSON.stringify(header)), length = Buffer.alloc(2); length.writeUInt16BE(json.length);
  if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) fail('The nonce must be 12 bytes.');
  const aad = Buffer.concat([MAGIC, length, json, nonce]), cipher = createCipheriv('aes-256-gcm', sharedKey(ephemeralPrivateKey, publicKey, ephemeralPublic, publicKey), nonce);
  cipher.setAAD(aad);
  const sealed = Buffer.concat([aad, cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  if (sealed.length > ENVELOPE_MAX_BYTES) fail('The emergency kit exceeds its size limit.');
  return sealed;
}
// Checks that the private key belongs to the kit (its public key digest) before any decryption is attempted.
export function open(bytes, privateKey) {
  const { header, aad, nonce, body, tag } = parse(bytes), recipientPublic = publicKeyOf(privateKey);
  if (publicKeyDigest(recipientPublic) !== header.digest) fail('These parts do not open this emergency kit.');
  const ephemeralPublic = Buffer.from(header.ephemeralPublicKey, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', sharedKey(privateKey, ephemeralPublic, ephemeralPublic, recipientPublic), nonce);
  decipher.setAAD(aad); decipher.setAuthTag(tag);
  try { return Buffer.concat([decipher.update(body), decipher.final()]); } catch { fail('The emergency kit is damaged: it failed its authentication check.'); }
}

// The sealed payload: "DKP1" | passphrase length (4 bytes) | recovery passphrase (UTF-8) | recovery kit file.
export function packKit({ kit, passphrase }) {
  const text = Buffer.from(passphrase, 'utf8'), length = Buffer.alloc(4); length.writeUInt32BE(text.length);
  return Buffer.concat([PAYLOAD_MAGIC, length, text, kit]);
}
export function unpackKit(payload) {
  if (payload.length < 8 || !payload.subarray(0, 4).equals(PAYLOAD_MAGIC)) fail('The emergency kit contents are not recognised.');
  const length = payload.readUInt32BE(4);
  if (length < 1 || length > 4096 || payload.length <= 8 + length) fail('The emergency kit contents are not recognised.');
  return { passphrase: payload.subarray(8, 8 + length).toString('utf8'), kit: payload.subarray(8 + length) };
}
