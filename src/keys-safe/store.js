// What DockNest keeps about app keys and configuration files (docs/keys-safe.md): rule ids, locations and keyed
// fingerprints in app_keys and config_fingerprints, never a value. Scans arrive with job events that already reach the
// server (readiness, discover, backup; a restore test only confirms keys); nothing here runs on a timer.
// - The first observation of an item is its known-good baseline, silently, so an upgrade or a new app raises no alert.
// - A fingerprint that differs from known-good marks the item changed (with the time first seen) and raises
//   config.changed once per new fingerprint set, routed by the existing alert rules.
// - Known-good is set by a Safe Edit apply ('safe-edit'), a restore onto the app ('restore') or an administrator
//   ('admin'), with an audit entry that names files and keys only.
// - When the fingerprint key changes (master key rotation), each app's next scan re-baselines it silently.
import { createHash } from 'node:crypto';
import { db, audit, transaction } from '../db.js';
import { emit } from '../alerts/delivery.js';
import { keyRule } from '../../shared/key-rules.js';
import { FINGERPRINT, fingerprintKeyCheck } from './fingerprint.js';

const ACTOR = 'docknest', CHECK_SETTING = 'keys_fingerprint_check', LIMIT = 500;
export const MISSING_REASONS = Object.freeze(['not-included', 'not-copied', 'excluded', 'differs', 'not-in-package', 'unreadable']);
const LOCATION = /^(?:env:[^\0\r\n/]{1,256}|file:\/[^\0\r\n]{1,4095})$/;
const now = () => new Date().toISOString();
const atomic = fn => (db.isTransaction ? fn() : transaction(fn));
export const keyItem = (ruleId, location) => `${ruleId}@${location}`;
const isFile = item => item.startsWith('/');

// The helper's answer, checked: known rule ids, well-formed locations and fingerprints, at most LIMIT of each, no repeats.
// Anything else is dropped (an invalid answer records nothing rather than something wrong).
export function cleanScan(scan) {
  if (!scan || typeof scan !== 'object' || !Array.isArray(scan.keys) || !Array.isArray(scan.files)) return null;
  const keys = new Map(), files = new Map();
  for (const item of scan.keys.slice(0, LIMIT)) {
    if (!item || !keyRule(item.rule) || typeof item.location !== 'string' || !LOCATION.test(item.location) || !FINGERPRINT.test(String(item.fingerprint))) continue;
    const proof = typeof item.inBackup === 'boolean' ? { inBackup: item.inBackup, ...(!item.inBackup && MISSING_REASONS.includes(item.reason) ? { reason: item.reason } : {}) } : {};
    keys.set(keyItem(item.rule, item.location), { rule: item.rule, location: item.location, fingerprint: item.fingerprint, ...proof });
  }
  for (const item of scan.files.slice(0, LIMIT)) {
    if (!item || typeof item.path !== 'string' || !LOCATION.test('file:' + item.path) || !FINGERPRINT.test(String(item.fingerprint))) continue;
    files.set(item.path, { path: item.path, fingerprint: item.fingerprint });
  }
  return { keys: [...keys.values()], files: [...files.values()] };
}

// True once for each app whose rows were made with an earlier fingerprint key. A changed key check marks every app with
// rows as pending, with one audit entry; each app's next scan then re-baselines it and leaves the list.
function takeRebaseline(siteId) {
  const check = fingerprintKeyCheck(), row = db.prepare('SELECT value FROM settings WHERE key=?').get(CHECK_SETTING);
  let stored = null; try { stored = JSON.parse(row?.value ?? 'null'); } catch { /* rewritten below */ }
  const save = value => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(CHECK_SETTING, JSON.stringify(value));
  // Without a stored check (first run) there are no rows yet; rows without one are treated like after a rotation.
  if (stored?.check !== check || !Array.isArray(stored.pending)) {
    const rotated = typeof stored?.check === 'string';
    stored = { check, pending: db.prepare('SELECT site_id FROM app_keys UNION SELECT site_id FROM config_fingerprints').all().map(item => item.site_id) };
    save(stored);
    if (rotated) audit(ACTOR, 'keys.rebaselined', null, { apps: stored.pending.length });
  }
  if (!stored.pending.includes(siteId)) return false;
  save({ check, pending: stored.pending.filter(item => item !== siteId) });
  return true;
}

const chainOf = backupId => { try { return JSON.parse(db.prepare('SELECT manifest FROM backups WHERE id=?').get(backupId)?.manifest ?? 'null')?.chain?.id ?? null; } catch { return null; } };
// An increment holds only what changed since its parent, so a key file that did not change is not in its archive. It is
// still restored from the chain when the same value was proven in a backup of the same chain.
const carried = (row, item, backup) => backup.backupKind === 'incremental' && item.reason === 'not-in-package' && Boolean(row?.in_backup) && row.fingerprint === item.fingerprint && Boolean(backup.chainId) && chainOf(row.in_backup) === backup.chainId;

function recordKeys(siteId, keys, { backup, at, rebaseline }) {
  const rows = new Map(db.prepare('SELECT * FROM app_keys WHERE site_id=?').all(siteId).map(row => [keyItem(row.rule_id, row.location), row]));
  for (const item of keys) {
    const name = keyItem(item.rule, item.location), row = rows.get(name); rows.delete(name);
    const changed = Boolean(row) && !rebaseline && row.fingerprint !== item.fingerprint;
    let inBackup = row && !changed ? row.in_backup : null;
    if (backup) inBackup = item.inBackup === true || carried(row, item, backup) ? backup.id : null;
    if (!row) db.prepare('INSERT INTO app_keys(site_id,rule_id,location,fingerprint,in_backup,verified_test_id,first_seen_at,changed_at) VALUES(?,?,?,?,?,NULL,?,NULL)').run(siteId, item.rule, item.location, item.fingerprint, inBackup, at);
    else db.prepare('UPDATE app_keys SET fingerprint=?,in_backup=?,verified_test_id=?,changed_at=? WHERE site_id=? AND rule_id=? AND location=?')
      .run(item.fingerprint, inBackup, changed ? null : row.verified_test_id, changed ? at : row.changed_at, siteId, row.rule_id, row.location);
  }
  for (const row of rows.values()) db.prepare('DELETE FROM app_keys WHERE site_id=? AND rule_id=? AND location=?').run(siteId, row.rule_id, row.location);
}

// Returns the changed items that were not alerted for their current fingerprint yet.
function recordItems(siteId, items, { at, rebaseline }) {
  const rows = new Map(db.prepare('SELECT * FROM config_fingerprints WHERE site_id=?').all(siteId).map(row => [row.item, row]));
  for (const [item, fingerprint] of items) {
    const row = rows.get(item); rows.delete(item);
    if (!row) { db.prepare("INSERT INTO config_fingerprints(site_id,item,fingerprint,known_good,known_good_source,known_good_at,first_seen_changed_at,alerted_fingerprint) VALUES(?,?,?,?,'baseline',?,NULL,NULL)").run(siteId, item, fingerprint, fingerprint, at); continue; }
    if (rebaseline) {
      // Same files, new key: an item that matched known-good still does; a changed one stays changed, already alerted.
      const good = row.fingerprint === row.known_good;
      db.prepare('UPDATE config_fingerprints SET fingerprint=?,known_good=?,alerted_fingerprint=? WHERE site_id=? AND item=?').run(fingerprint, good ? fingerprint : row.known_good, good ? null : fingerprint, siteId, item);
      continue;
    }
    const good = fingerprint === row.known_good;
    db.prepare('UPDATE config_fingerprints SET fingerprint=?,first_seen_changed_at=?,alerted_fingerprint=? WHERE site_id=? AND item=?')
      .run(fingerprint, good ? null : row.first_seen_changed_at ?? at, good ? null : row.alerted_fingerprint, siteId, item);
  }
  for (const row of rows.values()) db.prepare('DELETE FROM config_fingerprints WHERE site_id=? AND item=?').run(siteId, row.item);
  const changed = db.prepare('SELECT item,fingerprint,alerted_fingerprint FROM config_fingerprints WHERE site_id=? AND fingerprint<>known_good ORDER BY item').all(siteId);
  if (!changed.some(row => row.alerted_fingerprint !== row.fingerprint)) return null;
  db.prepare('UPDATE config_fingerprints SET alerted_fingerprint=fingerprint WHERE site_id=? AND fingerprint<>known_good').run(siteId);
  return changed;
}

// Names only: file paths and the key names of rule items, never a fingerprint or a value.
function itemNames(items) {
  const files = [], keys = new Set();
  for (const item of items) {
    if (isFile(item)) files.push(item);
    else { const rule = keyRule(item.slice(0, item.indexOf('@'))); if (rule) keys.add(rule.name ?? rule.path); }
  }
  return { files: files.slice(0, 50), keys: [...keys].slice(0, 50) };
}
function alertChanged(siteId, changed) {
  const names = itemNames(changed.map(row => row.item));
  audit(ACTOR, 'config.changed', siteId, names);
  const site = db.prepare('SELECT s.name AS site,s.server_id,v.name AS server FROM sites s JOIN servers v ON v.id=s.server_id WHERE s.id=?').get(siteId);
  if (!site) return;
  const set = createHash('sha256').update(changed.map(row => `${row.item}\0${row.fingerprint}`).join('\n')).digest('hex').slice(0, 32);
  try { emit({ type: 'config.changed', key: `occ:config-changed:${siteId}:${set}`, siteId, serverId: site.server_id, siteName: site.site, serverName: site.server }); }
  catch (error) { console.error(`Configuration change alert could not be queued: ${error.code ?? error.name}`); }
}

// Records one scan of an app. `backup` ({ id, backupKind, chainId }) is given for the scan a backup made: then each
// key's in_backup names this backup only when the helper proved the packaged bytes match the live ones.
export function recordScan(siteId, raw, { backup = null, at = now() } = {}) {
  const scan = cleanScan(raw);
  if (!scan) return false;
  return atomic(() => {
    const rebaseline = takeRebaseline(siteId);
    recordKeys(siteId, scan.keys, { backup, at, rebaseline });
    const changed = recordItems(siteId, [...scan.files.map(file => [file.path, file.fingerprint]), ...scan.keys.map(key => [keyItem(key.rule, key.location), key.fingerprint])], { at, rebaseline });
    if (changed) alertChanged(siteId, changed);
    return true;
  });
}

// Known-good for the app's items (`only` narrows them). The caller has just recorded a fresh scan.
export function markKnownGood(siteId, { source, actor, only = null, at = now() }) {
  return atomic(() => {
    const items = db.prepare('SELECT item FROM config_fingerprints WHERE site_id=? ORDER BY item').all(siteId).map(row => row.item).filter(item => !only || only(item));
    for (const item of items) db.prepare('UPDATE config_fingerprints SET known_good=fingerprint,known_good_source=?,known_good_at=?,first_seen_changed_at=NULL,alerted_fingerprint=NULL WHERE site_id=? AND item=?').run(source, at, siteId, item);
    audit(actor, 'config.known_good', siteId, { source, ...itemNames(items) });
    return items.length;
  });
}

// A restore test found these keys in its restored copy with the same fingerprints: they are verified while they keep them.
export function markVerified(siteId, testId, keys) {
  for (const key of keys) db.prepare('UPDATE app_keys SET verified_test_id=? WHERE site_id=? AND rule_id=? AND location=? AND fingerprint=?').run(testId, siteId, key.rule, key.location, key.fingerprint);
}
