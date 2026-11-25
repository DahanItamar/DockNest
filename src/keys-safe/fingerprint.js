// The fingerprint key (docs/keys-safe.md, "Fingerprints, never values").
// fpKey = HKDF-SHA256(master key, salt = install id, info = "docknest key fingerprint v1" || 0x00 || server id): one key
// per server of one install, so fingerprints from different servers (or installs) cannot be linked. It is derived here,
// in the API or the worker, for one helper request at a time, and is never logged, stored or returned. The helper
// fingerprints a key as HMAC-SHA256(fpKey, rule id || 0x00 || value), truncated to 128 bits, so a value never reaches
// DockNest.
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
// Without a server id: the install's own key, used only for the check value below.
export const fingerprintKey = (serverId = null) => Buffer.from(hkdfSync('sha256', key(), installId(), serverId === null ? INFO : `${INFO}\0${serverId}`, 32));
// A value derived from fpKey that changes when the master key (or the install id) changes, so stored fingerprints and a
// backup's proof made with another key are recognised. It reveals nothing about fpKey.
export const fingerprintKeyCheck = (serverId = null) => createHmac('sha256', fingerprintKey(serverId)).update(CHECK).digest('hex').slice(0, 32);
// What a helper request to `serverId` carries: that server's key for this one operation and the rule list (DockNest is
// the single source).
export const keysRequest = (serverId, extra = {}) => ({ fingerprintKey: fingerprintKey(serverId).toString('base64'), rules: KEY_RULES, ...extra });
