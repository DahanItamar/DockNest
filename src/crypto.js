import fs from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual, createHmac, createHash } from 'node:crypto';
import { config } from './config.js';

let cachedKey;
export function key() {
  if (!cachedKey) {
    cachedKey = Buffer.from(fs.readFileSync(config.masterKey, 'utf8').trim(), 'base64');
    if (cachedKey.length !== 32) throw new Error('Master key must contain 32 bytes encoded as base64. Run npm run setup.');
  }
  return cachedKey;
}
export function seal(text) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
export function open(encoded) {
  const blob = Buffer.from(encoded, 'base64');
  if (blob.length < 28) throw new Error('Invalid encrypted value');
  const cipher = createDecipheriv('aes-256-gcm', key(), blob.subarray(0, 12));
  cipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([cipher.update(blob.subarray(28)), cipher.final()]).toString('utf8');
}
export function passwordHash(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}
export function passwordVerify(password, encoded) {
  const [kind, salt, hash] = encoded.split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'hex'), actual = scryptSync(password, Buffer.from(salt, 'hex'), 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export const digest = text => createHash('sha256').update(text).digest('hex');
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes) {
  let bits = 0, value = 0, result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { result += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
export function unbase32(secret) {
  let bits = 0, value = 0; const bytes = [];
  for (const char of secret.toUpperCase().replace(/=+$/, '')) {
    const index = alphabet.indexOf(char); if (index < 0) throw new Error('Invalid TOTP secret');
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}
export function totp(secret, counter = Math.floor(Date.now() / 30000)) {
  const time = Buffer.alloc(8); time.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', unbase32(secret)).update(time).digest();
  const offset = mac[19] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
export function verifyTotp(secret, code, lastCounter = -1, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30000);
  for (const counter of [current, current - 1, current + 1]) {
    if (counter > lastCounter && timingSafeEqual(Buffer.from(code), Buffer.from(totp(secret, counter)))) return counter;
  }
  return null;
}
