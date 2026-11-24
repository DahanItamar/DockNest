// "This Recovery Guide is out of date" (docs/recovery-guide.md): an inventory digest, SHA-256 of a canonical JSON over
// the servers (names and addresses), the apps (names, servers, domains), the storage and copies, the schedules, the
// newest restore test result of each app, the emergency kit split and the owner's note. The digest of the guide the
// owner last downloaded is kept in runbook_state with one hash per part, so a change names its category (app added,
// server address changed and so on) without keeping the values. No timer: the digest is compared on every read and
// after the changes that affect it (an API change, a finished restore test); with an alert rule for runbook.outdated,
// each new digest is sent once.
import { formatRecoveryTime } from '../../shared/recovery-time.js';
import { createHash } from 'node:crypto';
import { db, audit, transaction } from '../db.js';
import { emit } from '../alerts/delivery.js';
import { loadInventory, runbookState } from './inventory.js';

const CHECK = 'runbook_check';
const sha = value => createHash('sha256').update(canonical(value)).digest('hex');
// JSON with object keys sorted at every level, so equal inventories always give equal text.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

const perApp = (inventory, pick) => Object.fromEntries(inventory.apps.map(app => [app.id, sha(pick(app))]));
export function inventoryParts(inventory) {
  return {
    apps: perApp(inventory, app => ({ name: app.name, serverId: app.serverId, domains: [...app.domains].sort() })),
    servers: Object.fromEntries(inventory.servers.map(server => [server.id, { name: sha(server.name), address: sha({ host: server.host, port: server.port }) }])),
    storage: { targets: sha({ targets: inventory.storage.map(target => ({ id: target.id, name: target.name, mode: target.mode, host: target.host ?? target.endpoint, port: target.port ?? null, root: target.root, bucket: target.bucket ?? null })), default: inventory.defaultTarget }), apps: perApp(inventory, app => ({ main: app.mainTargetId, copies: app.copyTargetIds })) },
    schedules: { selfBackup: sha(inventory.selfBackup.schedule), apps: perApp(inventory, app => app.schedule) },
    tests: { apps: perApp(inventory, app => app.lastTest) },
    // Only once an app has a measured time, so a guide made before any restore test stays current after an upgrade.
    ...(inventory.apps.some(app => app.recoveryTime) ? { recovery: { apps: perApp(inventory, app => (app.recoveryTime ? { time: formatRecoveryTime(app.recoveryTime.seconds), day: String(app.recoveryTime.provenAt).slice(0, 10) } : null)) } } : {}),
    kit: sha(inventory.emergency.split ? { digest: inventory.emergency.digest, k: inventory.emergency.k, n: inventory.emergency.n, labels: inventory.emergency.labels } : { split: false }),
    notes: sha(inventory.notes ?? ''),
  };
}
export const digestOf = parts => sha(parts);

export const CHANGES = Object.freeze({
  app_added: 'An app was added.', app_removed: 'An app was removed.', app_changed: "An app's name, server or domains changed.",
  server_added: 'A server was added.', server_removed: 'A server was removed.', server_renamed: 'A server was renamed.', server_address_changed: 'A server address changed.',
  storage_changed: 'The backup storage changed.', schedules_changed: 'A backup schedule changed.', tests_changed: 'A restore test result changed.', recovery_changed: "An app's expected recovery time changed.",
  kit_changed: 'The emergency kit changed.', notes_changed: 'Your notes changed.',
});
export function changesBetween(before, after) {
  const found = new Set(), compare = (map, now, added, removed, changed) => {
    for (const key of Object.keys(now)) if (!(key in map)) found.add(added); else changed(map[key], now[key]);
    for (const key of Object.keys(map)) if (!(key in now)) found.add(removed);
  };
  compare(before.apps ?? {}, after.apps, 'app_added', 'app_removed', (a, b) => { if (a !== b) found.add('app_changed'); });
  compare(before.servers ?? {}, after.servers, 'server_added', 'server_removed', (a, b) => { if (a.name !== b.name) found.add('server_renamed'); if (a.address !== b.address) found.add('server_address_changed'); });
  // An app added or removed is named once: its storage, schedule and test only count for apps in both.
  const differs = (a = {}, b = {}) => a.targets !== b.targets || a.selfBackup !== b.selfBackup || Object.keys(b.apps ?? {}).some(appId => appId in (a.apps ?? {}) && a.apps[appId] !== b.apps[appId]);
  for (const [part, code] of [['storage', 'storage_changed'], ['schedules', 'schedules_changed'], ['tests', 'tests_changed'], ['recovery', 'recovery_changed']]) if (differs(before[part], after[part])) found.add(code);
  if (!before.recovery && after.recovery) found.add('recovery_changed');
  for (const [part, code] of [['kit', 'kit_changed'], ['notes', 'notes_changed']]) if (before[part] !== after[part]) found.add(code);
  return Object.keys(CHANGES).filter(code => found.has(code)).map(code => ({ code, label: CHANGES[code] }));
}

const madeBy = userId => (userId ? db.prepare('SELECT name,email FROM users WHERE id=?').get(userId) : null);
// The page state: never made, current, or out of date with the categories of what changed.
export async function runbookStatus() {
  const state = runbookState(), parts = inventoryParts(loadInventory({ digestOnly: true })), digest = digestOf(parts);
  const user = madeBy(state.made_by), outdated = Boolean(state.digest) && state.digest !== digest;
  return {
    made: Boolean(state.digest), madeAt: state.made_at, madeBy: user ? user.name || user.email : null, outdated,
    changes: outdated ? changesBetween(JSON.parse(state.parts ?? '{}'), parts) : [], notes: state.notes,
  };
}

const saveState = fields => db.prepare('INSERT INTO runbook_state(id,digest,parts,made_at,made_by,notes) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest,parts=excluded.parts,made_at=excluded.made_at,made_by=excluded.made_by,notes=excluded.notes').run(fields.digest, fields.parts, fields.made_at, fields.made_by, fields.notes);
// Called when the owner downloads a Recovery Guide: the digest of what it was made from becomes the reference.
export function markMade(parts, actor, at) {
  const digest = digestOf(parts);
  transaction(() => {
    saveState({ ...runbookState(), digest, parts: JSON.stringify(parts), made_at: at, made_by: actor });
    const previous = JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(CHECK)?.value ?? '{}');
    db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(CHECK, JSON.stringify({ digest, outdated: false, alerted: previous.alerted ?? null }));
  });
}
export function saveNotes(notes, actor) {
  transaction(() => { saveState({ ...runbookState(), notes }); audit(actor, 'runbook.notes', null, { length: notes.length }); });
}

// After a change: is the guide the owner last downloaded out of date? Kept for the Overview, and sent once per digest.
export async function noteInventoryChange() {
  const state = runbookState();
  if (!state.digest) return;
  const digest = digestOf(inventoryParts(loadInventory({ digestOnly: true }))), outdated = digest !== state.digest;
  transaction(() => {
    const previous = JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(CHECK)?.value ?? '{}');
    const alerted = outdated && previous.alerted !== digest;
    if (alerted) emit({ type: 'runbook.outdated', key: `occ:runbook:${digest}` });
    db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(CHECK, JSON.stringify({ digest, outdated, alerted: alerted ? digest : previous.alerted ?? null }));
  });
}
// The Overview's one quiet line: from the last comparison, without reading the inventory again.
export function runbookSummary() {
  const state = runbookState(), check = JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(CHECK)?.value ?? '{}');
  return { made: Boolean(state.digest), outdated: Boolean(state.digest) && check.digest !== undefined && check.digest !== state.digest };
}
