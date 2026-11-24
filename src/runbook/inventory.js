// What the Recovery Guide is made from (docs/recovery-guide.md): servers, apps, their newest backups and restore tests,
// the backup storage, the schedules, the emergency kit and the owner's note, read from the database when the guide is
// asked for. Storage logins and the apps' login notes are read (unsealed) only when `logins` is true; nothing here is stored or logged.
import { db, parse } from '../db.js';
import { backupLayout } from '../backup-layout.js';
import { backupVerification, TEST_METHOD } from '../recovery-evidence.js';
import { targetOptions } from '../storage.js';
import { selfBackupConfig } from '../self-backup.js';
import { emergencyStatus } from '../emergency/keys.js';
import { activeEmergencyKey, emergencyKits } from '../emergency/kits.js';
import { appsWithLoginNotes, openLoginNotes } from './login-notes.js';
import { serverLinksView } from '../server-links.js';
import { keysView } from '../keys-safe/padlock.js';
import { loadChain, ChainError } from '../incremental.js';

const json = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };
// "sftp:<target id>:/path" or "s3:<target id>:key": the destination and the path inside it. A local or legacy path has none.
export function locationOf(stored) {
  const match = /^(sftp|s3|rclone|folder):([^:]+):(.+)$/.exec(String(stored ?? ''));
  return match && match[2] !== 'env' ? { targetId: match[2], path: match[3] } : null;
}

export const runbookState = () => db.prepare('SELECT * FROM runbook_state WHERE id=1').get() ?? { digest: null, parts: null, made_at: null, made_by: null, notes: '' };

function storageTarget(row, logins) {
  const settings = json(db.prepare('SELECT settings FROM storage_target_settings WHERE target_id=?').get(row.id)?.settings, null);
  // A cloud drive has no address or login a command could use: only its kind and folder, never its token.
  if (row.auth_type === 'rclone') return { id: row.id, name: row.name, mode: 'rclone', backend: settings?.backend ?? '', root: row.root };
  if (row.auth_type === 'local') return { id: row.id, name: row.name, mode: 'folder', root: row.root };
  const mode = row.auth_type === 's3-access-key' ? 's3' : 'sftp';
  const base = mode === 's3'
    ? { id: row.id, name: row.name, mode, endpoint: settings?.endpoint ?? '', region: settings?.region ?? '', bucket: settings?.bucket ?? '', pathStyle: Boolean(settings?.pathStyle), root: row.root }
    : { id: row.id, name: row.name, mode, host: row.host, port: row.port, username: row.username, hostKey: row.host_key, auth: row.auth_type === 'password' ? 'password' : 'key', root: row.root };
  if (!logins) return base;
  const opened = targetOptions(row.id);
  return mode === 's3' ? { ...base, accessKeyId: opened.accessKeyId, secretAccessKey: opened.secretAccessKey } : { ...base, ...(opened.password ? { password: opened.password } : { privateKey: opened.privateKey }) };
}

// The packages a restore of this backup needs, full backup first (src/incremental.js loadChain): null for a backup
// outside a chain, or `broken` when a package is missing or is not on SFTP or S3 storage.
function chainOf(backupId) {
  let members;
  try { members = loadChain(backupId); } catch (error) { if (error instanceof ChainError) return { broken: true }; throw error; }
  if (members.length < 2) return null;
  const locations = members.map(member => locationOf(member.path));
  return locations.every(Boolean) ? { locations } : { broken: true };
}

function dumpedContainers(manifest) {
  const names = new Map((manifest.containers ?? []).map(container => [container.id, String(container.name ?? '').replace(/^\//, '')]));
  return (manifest.consistency?.services ?? []).filter(item => item?.method === 'online logical dump' && names.has(item.container)).map(item => names.get(item.container));
}

function newestBackup(siteId) {
  const row = db.prepare('SELECT id,captured_at,path,manifest FROM backups WHERE site_id=? ORDER BY captured_at DESC,rowid DESC LIMIT 1').get(siteId);
  if (!row) return null;
  const manifest = json(row.manifest, {}), evidence = Object.values(backupVerification(row.id)).find(item => item.method === TEST_METHOD && item.status === 'passed');
  const location = locationOf(row.path), chain = chainOf(row.id);
  return {
    id: row.id, capturedAt: row.captured_at, location, fileName: location ? location.path.split('/').at(-1) : null,
    chain: chain?.locations ?? null, chainBroken: Boolean(chain?.broken),
    containers: (manifest.containers ?? []).map(container => ({ name: String(container.name ?? '').replace(/^\//, ''), image: container.image, mounts: (container.mounts ?? []).map(mount => ({ type: mount.type, destination: mount.destination })) })),
    // Databases saved as an online logical dump (docs/online-dumps.md): their data folders in the package are empty.
    dumps: dumpedContainers(manifest),
    // "Verified" only with a passed automatic restore test (src/recovery-evidence.js), with its date. The test records whether it read the
    // main backup or an off-site copy (sourceRole); older tests read the main backup.
    verified: evidence ? { at: evidence.checkedAt, source: evidence.sourceRole === 'copy' ? 'copy' : 'main' } : null,
  };
}

// Linked apps (docs/linked-apps.md): the links of every server from its last scan.
const appLinks = servers => servers.flatMap(server => serverLinksView(server.id).links ?? []);

// Keys safe (docs/keys-safe.md): which app keys the newest backup holds, and the known gaps. Names and reasons only,
// never a fingerprint.
function appKeys(siteId) {
  const view = keysView(siteId), name = key => (key.app ? `${key.name} (${key.app})` : key.name);
  return {
    keys: { inBackup: view.keys.filter(key => key.status === 'in-backup' || key.status === 'verified').length, verified: view.keys.filter(key => key.status === 'verified').length, total: view.keys.length },
    keyGaps: [
      ...view.keys.filter(key => key.status === 'missing').map(key => `the key ${name(key)} is not in the newest backup. ${key.reason}`),
      ...view.keys.filter(key => key.status === 'changed').map(key => `the key ${name(key)} changed after the newest backup. Make a new backup.`),
      ...(view.changed.length ? ['its Compose, env or settings files changed since they were marked known-good. Check them before you restore.'] : []),
    ],
  };
}

// `digestOnly`: only what the out-of-date digest reads (src/runbook/state.js), without backups, keys, links or notes.
export function loadInventory({ logins = false, digestOnly = false } = {}) {
  const servers = db.prepare('SELECT id,name,host,port,note FROM servers ORDER BY created_at,id').all();
  const serverById = new Map(servers.map(server => [server.id, server]));
  const noted = appsWithLoginNotes(), notes = logins ? openLoginNotes() : new Map();
  const defaultTarget = db.prepare("SELECT value FROM settings WHERE key='backup_storage_target'").get()?.value ?? null;
  const apps = db.prepare('SELECT * FROM sites WHERE id NOT IN (SELECT site_id FROM site_archives) ORDER BY created_at,id').all().map(parse).filter(site => serverById.has(site.server_id)).map(site => {
    const config = site.config ?? {}, policy = db.prepare('SELECT enabled,schedule,timezone FROM policies WHERE site_id=?').get(site.id);
    const test = db.prepare('SELECT result,finished_at FROM restore_tests WHERE site_id=? AND result IS NOT NULL ORDER BY finished_at DESC,id DESC LIMIT 1').get(site.id);
    return {
      id: site.id, name: site.name, serverId: site.server_id, kind: config.kind === 'static' ? 'static' : config.composeFiles?.length ? 'compose' : 'container',
      folder: backupLayout(serverById.get(site.server_id), site)[1],
      domains: config.domains ?? [], containers: config.containers ?? [], composeFiles: config.composeFiles ?? [], configFiles: config.configFiles ?? [], documentRoot: config.documentRoot ?? null,
      services: (config.services ?? []).map(service => ({ container: service.container, engine: service.engine, sqliteFiles: service.sqliteFiles ?? [] })),
      mainTargetId: db.prepare('SELECT main_target_id FROM site_storage WHERE site_id=?').get(site.id)?.main_target_id ?? defaultTarget,
      copyTargetIds: db.prepare('SELECT target_id FROM site_storage_copies WHERE site_id=? ORDER BY target_id').all(site.id).map(row => row.target_id),
      schedule: policy ? { enabled: Boolean(policy.enabled), schedule: policy.schedule, timezone: policy.timezone } : null,
      lastTest: test ? { result: test.result, finishedAt: test.finished_at } : null,
      ...(digestOnly ? {} : { backup: newestBackup(site.id), ...appKeys(site.id) }),
      hasLoginNote: noted.has(site.id), ...(logins && notes.has(site.id) ? { loginNote: notes.get(site.id) } : {}),
    };
  });
  const kit = db.prepare("SELECT path,finished_at FROM manager_backups WHERE status='completed' ORDER BY rowid DESC LIMIT 1").get();
  const selfBackup = selfBackupConfig(), key = activeEmergencyKey();
  // The newest emergency kit of the active split on each destination (docs/emergency-kit.md), next to its offline tool.
  const emergencyKitLocations = key ? emergencyKits().filter(item => item.keyId === key.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(item => { const location = locationOf(item.path), tool = item.tool && locationOf(item.tool.path); return location && { ...location, ...(tool && /^[a-f0-9]{64}$/.test(item.tool.sha256) ? { tool: { path: tool.path, sha256: item.tool.sha256 } } : {}) }; }).filter(Boolean) : [];
  return {
    servers, apps, links: digestOnly ? [] : appLinks(servers), defaultTarget,
    storage: db.prepare('SELECT * FROM storage_targets ORDER BY created_at,id').all().map(row => storageTarget(row, logins)),
    selfBackup: { schedule: selfBackup ? { enabled: Boolean(selfBackup.enabled), schedule: selfBackup.schedule, timezone: selfBackup.timezone } : null, kit: kit ? { location: locationOf(kit.path), finishedAt: kit.finished_at } : null, emergencyKits: emergencyKitLocations },
    emergency: emergencyStatus(), notes: runbookState().notes,
  };
}
