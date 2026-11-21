// The padlock of an app in /api/state (docs/keys-safe.md, "Padlock state"), worst first:
// - red: a key is missing from the last backup (not in it, or there is no backup yet);
// - amber: a key changed after the newest backup, or a Compose, env or configuration item changed since known-good;
// - green: every detected key is in the last backup;
// - none: no keys detected and nothing changed. There is no grey padlock: no badge never suggests safety.
// Green means "found in the last backup", not "restorable"; only a restore test that matched sets `verified`.
import { db } from '../db.js';
import { keyRule } from '../../shared/key-rules.js';

export const MISSING_TEXT = Object.freeze({
  'not-included': 'The file is not one of the files this app backs up.',
  'not-copied': 'DockNest never copies this mount, because it holds passwords or keys.',
  excluded: 'The file is in a path this app leaves out of its backups.',
  differs: 'The key changed while the backup ran.',
  'not-in-package': 'The key was not found in the backup.',
  unreadable: 'DockNest could not read the key from the backup.',
  'no-backup': 'This app has no backup yet.',
  older: 'The newest backup did not prove this key.',
});
const short = fingerprint => fingerprint.slice(0, 8);
// `reasonCode` lets the page act on a reason ("Add file" for not-included) without matching the English text.
const missing = code => ({ status: 'missing', reasonCode: code, reason: MISSING_TEXT[code] });

// The newest backup's proof list says whether it saw this exact value; a value it did not see and that appeared after
// it was captured is "changed after the newest backup".
function keyStatus(row, latest, proofs) {
  if (latest && row.in_backup === latest.id) return { status: row.verified_test_id ? 'verified' : 'in-backup' };
  if (!latest) return missing('no-backup');
  const proof = proofs.get(`${row.rule_id}@${row.location}`), since = row.changed_at ?? row.first_seen_at;
  if (proof?.fingerprint === row.fingerprint) return missing(MISSING_TEXT[proof.reason] ? proof.reason : 'older');
  if (since > latest.captured_at) return { status: 'changed', changedAt: since };
  return missing('older');
}

export function keysView(siteId) {
  const rows = db.prepare('SELECT * FROM app_keys WHERE site_id=? ORDER BY rule_id,location').all(siteId);
  const items = db.prepare('SELECT item,fingerprint,known_good,known_good_source,known_good_at,first_seen_changed_at FROM config_fingerprints WHERE site_id=? ORDER BY item').all(siteId);
  const latest = db.prepare('SELECT id,captured_at,manifest FROM backups WHERE site_id=? AND verified=1 ORDER BY captured_at DESC,id DESC LIMIT 1').get(siteId) ?? null;
  let proofs = new Map();
  try { proofs = new Map((JSON.parse(latest?.manifest ?? '{}').keys ?? []).map(proof => [`${proof.rule}@${proof.location}`, proof])); } catch { /* no proof list */ }
  const tested = id => (id ? db.prepare('SELECT finished_at FROM restore_tests WHERE id=?').get(id)?.finished_at ?? null : null);
  const keys = rows.map(row => {
    const rule = keyRule(row.rule_id);
    return { ruleId: row.rule_id, app: rule?.app ?? null, name: rule ? rule.name ?? rule.path : row.rule_id, location: row.location, fingerprint: short(row.fingerprint), backupId: row.in_backup, ...keyStatus(row, latest, proofs), ...(row.verified_test_id && latest && row.in_backup === latest.id ? { verifiedTestId: row.verified_test_id, verifiedAt: tested(row.verified_test_id) } : {}) };
  });
  const changed = items.filter(item => item.fingerprint !== item.known_good).map(item => ({ item: item.item, kind: item.item.startsWith('/') ? 'file' : 'key', firstSeenAt: item.first_seen_changed_at }));
  const state = keys.some(key => key.status === 'missing') ? 'red' : keys.some(key => key.status === 'changed') || changed.length ? 'amber' : keys.length ? 'green' : 'none';
  const knownGood = items.filter(item => item.fingerprint === item.known_good).sort((a, b) => b.known_good_at.localeCompare(a.known_good_at))[0];
  return { state, keys, changed, knownGood: knownGood ? { at: knownGood.known_good_at, source: knownGood.known_good_source } : null };
}
