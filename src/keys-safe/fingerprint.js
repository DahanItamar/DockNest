// The install fingerprint key (docs/keys-safe.md, "Fingerprints, never values").
// fpKey = HKDF-SHA256(master key, salt = install id, info = "docknest key fingerprint v1"). It is derived here, in the API
// or the worker, for one helper request at a time, and is never logged, stored or returned. The helper fingerprints a
// key as HMAC-SHA256(fpKey, rule id || 0x00 || value), truncated to 128 bits, so a value never reaches DockNest.
import { hkdfSync, createHmac, randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { key } from '../crypto.js';
import { KEY_RULES } from '../../shared/key-rules.js';

const INFO = 'docknest key fingerprint v1', CHECK = 'docknest key fingerprint check v1';
export const FINGERPRINT = /^[0-9a-f]{32}$/;
// One random id per install, made on first use. It travels in a self-backup with the master key, so a recovered install
// keeps its fingerprints.
export function installId() {
  db.prepare("INSERT INTO settings(key,value) VALUES('install_id',?) ON CONFLICT(key) DO NOTHING").run(randomUUID());
  return db.prepare("SELECT value FROM settings WHERE key='install_id'").get().value;
}
export const fingerprintKey = () => Buffer.from(hkdfSync('sha256', key(), installId(), INFO, 32));
// A value derived from fpKey that changes when the master key (or the install id) changes, so the next scan knows that
// every stored fingerprint was made with another key. It reveals nothing about fpKey.
export const fingerprintKeyCheck = () => createHmac('sha256', fingerprintKey()).update(CHECK).digest('hex').slice(0, 32);
// What a helper request carries: the key for this one operation and the rule list (DockNest is the single source).
export const keysRequest = (extra = {}) => ({ fingerprintKey: fingerprintKey().toString('base64'), rules: KEY_RULES, ...extra });
