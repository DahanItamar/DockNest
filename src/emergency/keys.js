// The optional K-of-N split (docs/emergency-kit.md). Off by default: one recovery passphrase stays the default and no key
// pair or emergency kit exists until an administrator opts in. A split makes a fresh X25519 key pair and splits its
// private key into N SLIP-0039 parts, K of which rebuild it. Only the public key, its digest, the SLIP-0039 identifier,
// K, N and the holder labels are stored. The private key and the parts exist only in this request's memory and are
// returned once; they are never written to the database, a log, the audit trail or job details. Every split and re-split
// is audited (with the public digest) and raises emergency.key_changed on every alert channel, in the same transaction.
import { z } from 'zod';
import { db, id, audit, transaction } from '../db.js';
import { emit } from '../alerts/delivery.js';
import { generateKeyPair, publicKeyDigest } from './envelope.js';
import { generateMnemonics } from './slip39.js';
import { activeEmergencyKey, emergencyKits } from './kits.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });
const label = z.string().trim().min(1, 'Name each person.').max(60).regex(/^[^\u0000-\u001f\u007f<>]+$/, 'Use plain text for the names.');
const splitSchema = z.object({ k: z.number().int().min(2).max(16), n: z.number().int().min(2).max(16), labels: z.array(label).min(2).max(16) }).strict()
  .refine(value => value.k <= value.n, 'The number of parts needed cannot be more than the number of people.')
  .refine(value => value.labels.length === value.n, 'Name each person who gets a part.');

export function emergencyStatus() {
  const key = activeEmergencyKey(), kits = emergencyKits(), own = kits.filter(item => item.keyId === key?.id);
  return {
    split: Boolean(key),
    ...(key ? { digest: key.digest, identifier: key.identifier, k: key.k, n: key.n, labels: JSON.parse(key.labels), createdAt: key.created_at, latestKitAt: own.map(item => item.createdAt).sort().at(-1) ?? null } : {}),
    oldKits: kits.length - own.length,
  };
}

export function splitEmergencyKit(input, actor) {
  const parsed = splitSchema.safeParse(input);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0]?.message ?? 'Choose how many parts are needed and name each person.');
  const { k, n, labels } = parsed.data, { privateKey, publicKey } = generateKeyPair();
  try {
    const { identifier, mnemonics } = generateMnemonics({ secret: privateKey, threshold: k, count: n });
    const digest = publicKeyDigest(publicKey), keyId = id(), createdAt = new Date().toISOString();
    transaction(() => {
      const previous = activeEmergencyKey();
      if (previous) db.prepare('UPDATE emergency_keys SET retired_at=? WHERE id=?').run(createdAt, previous.id);
      db.prepare('INSERT INTO emergency_keys(id,public_key,digest,identifier,k,n,labels,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(keyId, publicKey.toString('base64url'), digest, identifier, k, n, JSON.stringify(labels), actor, createdAt);
      audit(actor, previous ? 'emergency.resplit' : 'emergency.split', keyId, { k, n, digest });
      emit({ type: 'emergency.key_changed', key: `occ:emergency-key:${keyId}`, at: createdAt, code: previous ? 'resplit' : 'split' });
    });
    return { digest, identifier, k, n, createdAt, parts: mnemonics.map((words, index) => ({ number: index + 1, label: labels[index], words })) };
  } finally { privateKey.fill(0); }
}

// "Go back to one passphrase": the key pair is retired, so Self Backups stop making emergency kits. Kits already in
// storage stay until the owner deletes them (deleteOldEmergencyKits).
export function retireEmergencyKit(actor) {
  return transaction(() => {
    const key = activeEmergencyKey();
    if (!key) throw httpError(409, 'The kit is not split. It opens with your recovery passphrase.');
    db.prepare('UPDATE emergency_keys SET retired_at=? WHERE id=?').run(new Date().toISOString(), key.id);
    audit(actor, 'emergency.retired', key.id, { digest: key.digest });
    return { split: false };
  });
}
