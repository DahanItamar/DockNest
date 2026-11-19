// Keys in a restore test (docs/keys-safe.md, "Proof that the key is inside the backup"). The backup's proof list says
// which keys its package holds; the helper fingerprints the same keys in the restored copy (container env as created,
// restored configuration and mount files) and DockNest compares. Only a test that passes with every key matching sets
// "Verified in a restore test".
import { FINGERPRINT, keysRequest } from './fingerprint.js';
import { keyRule } from '../../shared/key-rules.js';

// The keys a backup proved, from its stored manifest.
export function provenKeys(manifestText) {
  let keys = [];
  try { keys = JSON.parse(manifestText || '{}').keys ?? []; } catch { return []; }
  return (Array.isArray(keys) ? keys : []).filter(key => key?.inBackup === true && keyRule(key.rule) && typeof key.location === 'string' && FINGERPRINT.test(String(key.fingerprint))).map(({ rule, location, fingerprint }) => ({ rule, location, fingerprint }));
}
export const restoredKeysRequest = proven => keysRequest({ expect: proven.map(({ rule, location }) => ({ rule, location })) });
// The check a test shows, and the keys it verifies. `answered` is the helper's list (missing when it could not read them).
export function compareRestoredKeys(proven, answered) {
  if (!Array.isArray(answered)) return { check: { name: 'App keys', kind: 'keys', target: null, status: 'skipped', detail: 'The keys of the restored copy could not be read.' }, verified: [], failed: false };
  const found = new Map(answered.filter(item => item && typeof item.rule === 'string' && typeof item.location === 'string').map(item => [`${item.rule}@${item.location}`, item.fingerprint]));
  const matched = proven.filter(key => found.get(`${key.rule}@${key.location}`) === key.fingerprint);
  if (matched.length !== proven.length) return { check: { name: 'App keys', kind: 'keys', target: null, status: 'failed', detail: 'An app key in the restored copy is missing or differs from the backup.' }, verified: [], failed: true };
  return { check: { name: 'App keys', kind: 'keys', target: null, status: 'passed', detail: `${matched.length} key${matched.length === 1 ? '' : 's'} match the backup` }, verified: matched, failed: false };
}
