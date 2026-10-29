// Incremental backups (docs/incremental-backups.md, option A: hybrid GNU tar chains). One full package, then up to N
// increments that hold only what changed. This module holds the database side: the per-site setting, which kind the
// next backup is (and why), the chain a backup belongs to, link checks, and the views the API and storage report read.
// Every package stays the existing AES-256-GCM format; the helper (remote/helper.py) makes and restores them.
//
// Trust rules:
// - The engine only asks for an increment. What the package is comes from the helper's returned manifest, which is the
//   same document sealed inside the encrypted package. A returned chain that does not match the request is refused.
// - A chain is valid only when every link matches: each increment names its parent's backup id and the SHA-256 of the
//   parent's encrypted package, positions run 0..n-1 in one chain id, and the first package is full.
import { randomUUID } from 'node:crypto';
import { db, audit, transaction } from './db.js';
import { targetIdOfPath } from './site-storage.js';

export const DEFAULT_INTERVAL = 6, MIN_INTERVAL = 1, MAX_INTERVAL = 30, CHAIN_FORMAT = 2;
// site_incremental.force_full values.
export const FORCE = Object.freeze({ none: 0, owner: 1, uncommitted: 2, enabled: 3 });
const forceReasons = { 1: 'full-now', 2: 'snapshot-not-committed', 3: 'feature-enabled' };
// Why a backup in an incremental site is full. Stable codes in job details and the audit trail; plain sentences for the UI.
export const FULL_REASONS = Object.freeze({
  'feature-enabled': 'This is the first backup since incremental backups were turned on.',
  'full-now': 'A full backup was requested.',
  interval: 'The chain reached its length, so a new chain starts.',
  'parent-missing': 'The previous backup of the chain is missing.',
  'parent-unverified': 'The previous backup of the chain is not verified.',
  'parent-removing': 'The previous backup of the chain is being removed.',
  'plan-changed': 'The containers, mounts or images changed since the last backup.',
  'storage-changed': 'The main storage destination changed.',
  'site-moved': 'The site moved to another server.',
  'standard-package': 'The previous backup was a standard full package, not part of a chain.',
  'format-changed': 'The backup format changed.',
  'snapshot-not-committed': 'The server could not confirm the change record of the previous backup.',
  'snapshot-missing': 'The change record on the server is missing.',
  'snapshot-mismatch': 'The change record on the server does not match the previous backup.',
  'mount-set-changed': 'The set of mounts changed.',
  'folders-renamed': 'Folders were renamed since the last full backup, so this backup is full.',
});
const HELPER_FALLBACKS = new Set(['snapshot-missing', 'snapshot-mismatch', 'mount-set-changed']);
const hex64 = /^[a-f0-9]{64}$/, chainIdPattern = /^[A-Za-z0-9-]{1,64}$/;
const validFingerprint = value => typeof value === 'string' && value.length >= 1 && value.length <= 128;
const json = value => { if (value && typeof value === 'object') return value; try { return JSON.parse(value || '{}'); } catch { return {}; } };

// ---- Settings ---------------------------------------------------------------------------------------------------------
export function incrementalSettings(siteId) {
  const row = db.prepare('SELECT enabled,interval,force_full FROM site_incremental WHERE site_id=?').get(siteId);
  return { enabled: row?.enabled === 1, interval: row?.interval ?? DEFAULT_INTERVAL, fullNext: Boolean(row?.enabled === 1 && row?.force_full), fullNextReason: row?.enabled === 1 ? forceReasons[row?.force_full] ?? null : null, forceFull: row?.force_full ?? 0 };
}
const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });
// { enabled?, interval?, fullNow? }. Turning the option on makes the next backup full; so does fullNow. Returns the new
// settings and whether the source's snapshot files should be discarded (the option was turned off).
export function updateIncrementalSettings(siteId, body, actor, { staticSite = false } = {}) {
  const input = body && typeof body === 'object' ? body : {};
  validateSettings(input);
  return transaction(() => applyIncrementalSettings(siteId, input, actor, { staticSite }));
}
function validateSettings(input) {
  for (const key of Object.keys(input)) if (!['enabled', 'interval', 'fullNow'].includes(key)) throw httpError(400, 'invalid_field', 'Unknown field: ' + key.slice(0, 40));
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw httpError(400, 'invalid_enabled', 'enabled must be true or false.');
  if (input.fullNow !== undefined && typeof input.fullNow !== 'boolean') throw httpError(400, 'invalid_full_now', 'fullNow must be true or false.');
  if (input.interval !== undefined && !(Number.isInteger(input.interval) && input.interval >= MIN_INTERVAL && input.interval <= MAX_INTERVAL)) throw httpError(400, 'invalid_interval', `Choose between ${MIN_INTERVAL} and ${MAX_INTERVAL} increments per full backup.`);
}
// The same change without its own transaction, for a caller that holds one (Full backup now commits it with its job).
export function applyIncrementalSettings(siteId, body, actor, { staticSite = false } = {}) {
  const input = body && typeof body === 'object' ? body : {};
  validateSettings(input);
  const before = incrementalSettings(siteId);
  const enabled = input.enabled ?? before.enabled, interval = input.interval ?? before.interval;
  if (enabled && staticSite) throw httpError(400, 'static_site', 'Static sites always make full backups.');
  if (input.fullNow && !enabled) throw httpError(409, 'incremental_off', 'Incremental backups are off for this site, so every backup is already full.');
  let force = before.forceFull;
  if (enabled && !before.enabled) force = FORCE.enabled;
  if (!enabled) force = FORCE.none;
  if (input.fullNow) force = FORCE.owner;
  db.prepare('INSERT INTO site_incremental(site_id,enabled,interval,force_full,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET enabled=excluded.enabled,interval=excluded.interval,force_full=excluded.force_full,updated_at=excluded.updated_at')
    .run(siteId, Number(enabled), interval, force, new Date().toISOString());
  audit(actor, 'site.incremental_update', siteId, { enabled, interval, ...(input.fullNow ? { fullNow: true } : {}) });
  return { settings: incrementalSettings(siteId), discard: before.enabled && !enabled };
}
export function setForceFull(siteId, value) {
  db.prepare('UPDATE site_incremental SET force_full=?,updated_at=? WHERE site_id=? AND enabled=1').run(value, new Date().toISOString(), siteId);
}
// Clears the flag the backup decided on, unless the owner changed it while the backup ran.
export function clearForceFull(siteId, decided) {
  if (decided) db.prepare('UPDATE site_incremental SET force_full=0,updated_at=? WHERE site_id=? AND force_full=?').run(new Date().toISOString(), siteId, decided);
}

// ---- Chains -----------------------------------------------------------------------------------------------------------
export const linkOf = backupId => db.prepare('SELECT * FROM backup_chain_links WHERE backup_id=?').get(backupId) ?? null;
export const chainBrokenMessage = backupId => `This backup depends on backup ${backupId}, which is missing or damaged. Restore ${backupId}'s chain from an earlier point, or pick a full backup.`;
export class ChainError extends Error {
  constructor(backupId) { super(chainBrokenMessage(backupId)); this.status = 409; this.code = 'chain_broken'; this.publicCode = 'chain_broken'; this.backupId = backupId; }
}
// The backup and its ancestors back to the full package, full first. A backup outside any chain is a chain of one.
// Each member carries its link row (null outside a chain).
export function loadChain(backupId) {
  const target = db.prepare('SELECT * FROM backups WHERE id=?').get(backupId);
  if (!target) throw new ChainError(backupId);
  const members = [], seen = new Set();
  for (let current = target; ;) {
    if (seen.has(current.id) || members.length > MAX_INTERVAL) throw new ChainError(current.id);
    seen.add(current.id);
    const link = linkOf(current.id);
    members.unshift({ ...current, link });
    if (!link || link.backup_kind === 'full') break;
    const parent = db.prepare('SELECT * FROM backups WHERE id=?').get(link.parent_id);
    if (!parent) throw new ChainError(link.parent_id);
    current = parent;
  }
  return members;
}
// Every link, from the database and the public manifest (a mirror of the sealed one): one chain id, positions 0..n-1,
// a full first, and each increment naming its parent's backup id and encrypted SHA-256. Throws ChainError naming the
// package the broken link depends on.
export function verifyChainLinks(members) {
  if (!members.length) throw new ChainError('unknown');
  if (!members[0].link) { if (members.length !== 1) throw new ChainError(members[0].id); return members; }
  const chainId = members[0].link.chain_id;
  members.forEach((member, index) => {
    const link = member.link, chain = json(member.manifest).chain, previous = members[index - 1];
    const broken = () => new ChainError(previous ? previous.id : member.id);
    if (!link || link.chain_id !== chainId || link.chain_position !== index || chain?.id !== chainId || chain?.position !== index) throw broken();
    if (index === 0) { if (link.backup_kind !== 'full' || link.parent_id !== null || chain.parentBackupId != null || chain.parentSha256 != null) throw broken(); return; }
    if (link.backup_kind !== 'incremental' || link.parent_id !== previous.id || chain.parentBackupId !== previous.id || chain.parentSha256 !== previous.checksum || !hex64.test(previous.checksum)) throw broken();
  });
  return members;
}
export const inChain = members => Boolean(members[0]?.link);
// Bytes a restore of this backup reads and unpacks: every package of its chain.
export function chainSize(backupId) {
  try { return loadChain(backupId).reduce((sum, member) => sum + Number(member.size || 0), 0); }
  catch { return Number(db.prepare('SELECT size FROM backups WHERE id=?').get(backupId)?.size || 0); }
}
// Backups that build on this one (children, their children, ...), newest position first.
export function dependentsOf(backupId) {
  return db.prepare(`WITH RECURSIVE d(id,position) AS (SELECT backup_id,chain_position FROM backup_chain_links WHERE parent_id=?
    UNION SELECT l.backup_id,l.chain_position FROM backup_chain_links l JOIN d ON l.parent_id=d.id) SELECT id FROM d ORDER BY position DESC,id`).all(backupId).map(row => row.id);
}
export const hasDependents = backupId => Boolean(db.prepare('SELECT 1 FROM backup_chain_links WHERE parent_id=? LIMIT 1').get(backupId));
// Deleting a package that later increments depend on is refused unless every one of them goes with it.
export function deletionRefusal(backupIds) {
  const together = new Set(backupIds);
  for (const backupId of together) {
    const left = dependentsOf(backupId).filter(dependent => !together.has(dependent));
    if (left.length) return { backupId, dependents: left.length, message: `Backup ${backupId} has ${left.length} ${left.length === 1 ? 'backup' : 'backups'} that depend on it. Delete this backup and the ${left.length} ${left.length === 1 ? 'backup' : 'backups'} that depend on it together.` };
  }
  return null;
}
// Order for deleting a set together: dependents before what they depend on.
export function deletionOrder(backupIds) {
  const positions = new Map(backupIds.map(backupId => [backupId, linkOf(backupId)?.chain_position ?? 0]));
  return [...backupIds].sort((a, b) => positions.get(b) - positions.get(a));
}

// ---- Choosing full or increment ----------------------------------------------------------------------------------------
const newId = () => randomUUID();
function fullRequest(siteId) { return { mode: 'full', siteKey: siteId, chainId: newId(), fallbackChainId: newId(), position: 0, parentBackupId: null, parentSha256: null, parentSnapshots: {}, parentImageIds: [] }; }
// What the next backup of the site asks the helper for: null for today's self-contained package (option off, static
// site, a site move's own backup), otherwise { mode, reason, force, request }. `directory` is the main storage folder of
// this backup, `plan` the fresh backup plan (its fingerprint covers the containers, mounts and images).
export function decideCapture({ site, plan, directory, jobDetails = {} }) {
  const settings = incrementalSettings(site.id);
  if (!settings.enabled || site.config?.kind === 'static' || jobDetails.moveId) return null;
  const full = reason => ({ mode: 'full', reason, force: settings.forceFull, request: fullRequest(site.id) });
  if (settings.forceFull) return full(forceReasons[settings.forceFull] ?? 'full-now');
  const latest = db.prepare('SELECT * FROM backups WHERE site_id=? ORDER BY captured_at DESC,id DESC LIMIT 1').get(site.id);
  if (!latest) return full('feature-enabled');
  const link = linkOf(latest.id), manifest = json(latest.manifest);
  if (!link) {
    // The newest backup is a self-contained package: a site move's own backup, a standard package the helper made
    // although an increment was asked for, or one from before the option was turned on.
    const made = json(db.prepare('SELECT details FROM jobs WHERE id=?').get(latest.job_id)?.details);
    return full(made.moveId ? 'site-moved' : made.incremental?.standardPackage ? 'standard-package' : 'feature-enabled');
  }
  if (manifest.formatVersion !== CHAIN_FORMAT || manifest.incremental?.format !== CHAIN_FORMAT) return full('format-changed');
  if (link.chain_position + 1 > settings.interval) return full('interval');
  let members;
  try { members = verifyChainLinks(loadChain(latest.id)); } catch { return full('parent-missing'); }
  for (const member of members) {
    if (db.prepare('SELECT 1 FROM retention_operations WHERE backup_id=?').get(member.id) || db.prepare('SELECT 1 FROM retention_deferrals WHERE backup_id=?').get(member.id)) return full('parent-removing');
    if (db.prepare('SELECT 1 FROM backup_main_removed WHERE backup_id=?').get(member.id)) return full('parent-missing');
    if (member.verified !== 1) return full('parent-unverified');
  }
  if (manifest.incremental.serverId !== site.server_id) return full('site-moved');
  if (manifest.incremental.mainTargetId !== targetIdOfPath(directory) || targetIdOfPath(latest.path) !== targetIdOfPath(directory)) return full('storage-changed');
  // The plan's own `fingerprint` (plan approval, unchanged) includes per-start network fields such as EndpointID and
  // MacAddress, so it differs after every restart. Chains compare the helper's stable `chainFingerprint` instead (the
  // container, mount and image set); a parent without one starts a new chain.
  if (!validFingerprint(plan?.chainFingerprint) || manifest.chainFingerprint !== plan.chainFingerprint) return full('plan-changed');
  // GNU tar keeps writing a folder rename's records into later increments, where a restore would replay them. The
  // increment that first holds a rename stays valid; the chain ends there.
  if (manifest.renamesSeen === true) return full('folders-renamed');
  const snapshots = manifest.incremental.snapshots;
  if (!snapshots || typeof snapshots !== 'object' || Object.entries(snapshots).some(([key, value]) => !hex64.test(key) || !hex64.test(value))) return full('parent-missing');
  const images = [...new Set(members.flatMap(member => (json(member.manifest).originalImages ?? []).map(image => image?.id)).filter(value => typeof value === 'string' && value))];
  return { mode: 'incremental', reason: null, force: 0, request: { mode: 'incremental', siteKey: site.id, chainId: link.chain_id, fallbackChainId: newId(), position: link.chain_position + 1, parentBackupId: latest.id, parentSha256: latest.checksum, parentSnapshots: { ...snapshots }, parentImageIds: images } };
}

// The chain fields the public manifest records, from what the helper says it made. Returns null when the helper made
// today's self-contained package (format v1). Throws when the returned chain does not match the request: such a package
// could never be restored as part of this chain, so it is not published.
export function chainRecord(decision, helperManifest, { serverId, mainTargetId, plan = null }) {
  if (!decision) return null;
  const manifest = helperManifest || {}, kind = manifest.backupKind, chain = manifest.chain, request = decision.request;
  if (manifest.formatVersion !== CHAIN_FORMAT || !['full', 'incremental'].includes(kind) || !chain || typeof chain !== 'object') return null;
  const mismatch = () => new Error('The server returned a backup chain that does not match what DockNest asked for, so the backup was not saved. The next backup will be full.');
  if (!chainIdPattern.test(String(chain.id))) throw mismatch();
  if (kind === 'incremental') {
    if (request.mode !== 'incremental' || chain.id !== request.chainId || chain.position !== request.position || chain.parentBackupId !== request.parentBackupId || chain.parentSha256 !== request.parentSha256) throw mismatch();
  } else if (chain.position !== 0 || chain.parentBackupId != null || chain.parentSha256 != null || chain.id !== (request.mode === 'full' ? request.chainId : request.fallbackChainId)) throw mismatch();
  const snapshots = {};
  for (const container of Array.isArray(manifest.containers) ? manifest.containers : []) {
    for (const mount of Array.isArray(container?.Mounts) ? container.Mounts : []) {
      const item = mount?.incremental;
      if (!item) continue;
      if (!hex64.test(String(item.snapshotKey)) || !hex64.test(String(item.snapshotSha256))) throw mismatch();
      snapshots[item.snapshotKey] = item.snapshotSha256;
    }
  }
  const fallback = kind === 'full' && request.mode === 'incremental' ? (HELPER_FALLBACKS.has(manifest.fallback?.reason) ? manifest.fallback.reason : 'snapshot-mismatch') : null;
  const chainImages = Array.isArray(manifest.chainImages) ? manifest.chainImages.filter(value => typeof value === 'string' && value.length <= 128).slice(0, 500) : [];
  return {
    formatVersion: CHAIN_FORMAT, backupKind: kind,
    // What the next backup compares against (see decideCapture): the capture's own value, else the plan's.
    ...((value => validFingerprint(value) ? { chainFingerprint: value } : {})(validFingerprint(manifest.chainFingerprint) ? manifest.chainFingerprint : plan?.chainFingerprint)),
    chain: { id: chain.id, position: chain.position, parentBackupId: chain.parentBackupId ?? null, parentSha256: chain.parentSha256 ?? null },
    ...(chainImages.length ? { chainImages } : {}),
    // The helper scanned the increment's archives: directory renames end the chain (see decideCapture).
    ...(kind === 'incremental' && manifest.renamesSeen === true ? { renamesSeen: true } : {}),
    incremental: { format: CHAIN_FORMAT, serverId, mainTargetId, snapshots, fullReason: kind === 'full' ? fallback ?? decision.reason : null, ...(fallback ? { fallback } : {}) },
  };
}
// Inside finalizePublication's transaction: the chain row of a published package, from its public manifest.
export function recordChainLink(backupId, manifest) {
  if (manifest?.formatVersion !== CHAIN_FORMAT || !['full', 'incremental'].includes(manifest.backupKind) || !manifest.chain) return false;
  const chain = manifest.chain;
  db.prepare('INSERT INTO backup_chain_links(backup_id,backup_kind,chain_id,parent_id,chain_position) VALUES(?,?,?,?,?) ON CONFLICT(backup_id) DO NOTHING')
    .run(backupId, manifest.backupKind, chain.id, manifest.backupKind === 'full' ? null : chain.parentBackupId, chain.position);
  return true;
}

// ---- Views ------------------------------------------------------------------------------------------------------------
const outsideChain = Object.freeze({ backupKind: 'full', chainId: null, parentId: null, chainPosition: null, chainLength: 1, dependents: 0, pinnedByChain: false });
// The chain fields of each backup in /api/state and /api/backups. chainLength: packages a restore of this backup reads;
// dependents: backups that build on it; pinnedByChain: a pinned increment keeps this backup.
export function chainViews(backups) {
  const result = new Map(), ids = backups.map(backup => backup.id);
  if (!ids.length) return result;
  const links = db.prepare('SELECT l.*,b.pinned FROM backup_chain_links l JOIN backups b ON b.id=l.backup_id WHERE l.chain_id IN (SELECT chain_id FROM backup_chain_links WHERE backup_id IN (SELECT value FROM json_each(?)))').all(JSON.stringify(ids));
  const byId = new Map(links.map(link => [link.backup_id, link])), children = new Map();
  for (const link of links) if (link.parent_id) (children.get(link.parent_id) ?? children.set(link.parent_id, []).get(link.parent_id)).push(link.backup_id);
  const below = id => { const out = []; for (const child of children.get(id) ?? []) out.push(child, ...below(child)); return out; };
  for (const backup of backups) {
    const link = byId.get(backup.id);
    if (!link) { result.set(backup.id, { ...outsideChain }); continue; }
    const dependents = below(backup.id);
    result.set(backup.id, { backupKind: link.backup_kind, chainId: link.chain_id, parentId: link.parent_id, chainPosition: link.chain_position, chainLength: link.chain_position + 1, dependents: dependents.length, pinnedByChain: dependents.some(id => byId.get(id)?.pinned === 1) });
  }
  return result;
}
export const incrementalBackupCount = (database = db) => { try { return database.prepare("SELECT COUNT(*) AS n FROM backup_chain_links WHERE backup_kind='incremental'").get().n; } catch { return 0; } };
