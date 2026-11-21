// The Recovery Guide itself (docs/recovery-guide.md): plain steps for someone who did not set DockNest up, made from
// the inventory when it is asked for. Sections, in order: Start here, Restore everything in this order, Fleet overview
// and one page per app. Short sentences, one action per step, each starting with a verb; expert detail is in the
// command boxes and the linked docs. Addresses and login details appear only when `include` says so.
import { installCommands, restoreCommands, checkCommands, storageCheckCommand, revealer } from './commands.js';

export const INCLUDE_DEFAULTS = Object.freeze({ addresses: false, logins: false, commands: true, tests: true, schedules: true, notes: true });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function formatDate(iso, { time = false } = {}) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'an unknown date';
  const day = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  return time ? `${day}, ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC` : day;
}
const KINDS = { compose: 'a Compose project', container: 'a single container', static: 'a static website' };
const docsLink = (version, file) => `https://github.com/DahanItamar/DockNest/blob/v${version}/docs/${file}`;
const step = (text, command, include) => (include.commands && command ? { text, command } : { text });

export function statusText(app) {
  if (app.backup?.verified) return `Verified: a restore test passed on ${formatDate(app.backup.verified.at)}, from the main backup.`;
  return app.backup ? 'Backed up, not tested yet.' : 'Not backed up yet.';
}
const testText = test => (!test ? 'No restore test yet.' : test.result === 'passed' ? `Passed on ${formatDate(test.finishedAt)}.` : test.result === 'failed' ? `Failed on ${formatDate(test.finishedAt)}.` : `Could not run on ${formatDate(test.finishedAt)}.`);
// Keys safe: how many of the app's keys the newest backup holds (docs/keys-safe.md).
const keysText = keys => (keys.total ? `App keys: ${keys.inBackup} of ${keys.total} in the newest backup${keys.verified ? `, ${keys.verified} verified in a restore test` : ''}.` : null);
const scheduleText = schedule => (schedule?.enabled ? `Backed up on a schedule: ${schedule.schedule} (${schedule.timezone}).` : 'Backed up only when someone starts a backup.');

// Linked apps that own a shared database come first, then the apps that use them, then the rest.
export function restoreOrder(apps, links) {
  const byId = new Map(apps.map(app => [app.id, app])), owners = new Map(), users = new Map();
  for (const link of links) {
    if (link.kind !== 'database' || !link.appIds?.every(appId => byId.has(appId))) continue;
    const owner = link.appIds.find(appId => byId.get(appId).containers.includes(link.via));
    if (!owner) continue;
    for (const user of link.appIds.filter(appId => appId !== owner)) {
      owners.set(owner, [...(owners.get(owner) ?? []), user]);
      users.set(user, [...(users.get(user) ?? []), owner]);
    }
  }
  const names = ids => [...new Set(ids)].map(appId => byId.get(appId).name).join(', ');
  const first = apps.filter(app => owners.has(app.id)), then = apps.filter(app => !owners.has(app.id) && users.has(app.id)), rest = apps.filter(app => !owners.has(app.id) && !users.has(app.id));
  return [
    ...first.map(app => ({ appId: app.id, name: app.name, reason: `Restore it first: ${names(owners.get(app.id))} use${owners.get(app.id).length > 1 ? '' : 's'} its database.` })),
    ...then.map(app => ({ appId: app.id, name: app.name, reason: `Restore it after ${names(users.get(app.id))}: it uses that database.` })),
    ...rest.map(app => ({ appId: app.id, name: app.name, reason: 'It does not depend on another app.' })),
  ];
}

// With the split on: the newest emergency kit on the storage that holds the recovery kit, if one was written there.
function emergencyOn(inventory, kitStorage) {
  if (!inventory.emergency.split || !kitStorage) return null;
  const kit = inventory.selfBackup.emergencyKits.find(location => location.targetId === kitStorage.id);
  return kit ? { kit } : null;
}
function kitText(emergency) {
  if (!emergency.split) return { summary: 'One kit, opened with your recovery passphrase.', details: ['The recovery passphrase is not in this guide. Keep it where the owner told you.'] };
  return {
    summary: `Split between trusted people: any ${emergency.k} of these ${emergency.n} people together can open it.`,
    holders: emergency.labels,
    details: [`Each part shows this key digest. Check that it matches: ${emergency.digest.match(/.{4}/g).join(' ')}.`, 'To open it, copy the folder docknest-recovery/emergency from the backup storage. The tool emergency-open.js is in it and needs only Node.js 24, no network. Start here says how.'],
  };
}

function storageLogin(storage) {
  if (storage.mode === 's3') return [['Endpoint', storage.endpoint], ['Bucket', storage.bucket], ['Access key', storage.accessKeyId], ['Secret key', storage.secretAccessKey]];
  return [['Address', `${storage.host}:${storage.port}`], ['User', storage.username], storage.password ? ['Password', storage.password] : ['Private key', storage.privateKey]];
}

function appPage(app, inventory, { include, version, reveal }) {
  const server = inventory.servers.find(item => item.id === app.serverId), storage = inventory.storage.find(item => item.id === app.mainTargetId) ?? null;
  const backup = app.backup, independent = backup?.location && !backup.chainBroken && storage && [backup.location, ...(backup.chain ?? [])].every(location => location.targetId === storage.id);
  const works = app.domains.length ? app.domains.map(domain => `Open https://${domain}. The website should load.`) : ['Open the app the way you normally do. DockNest has no web address for it.'];
  return {
    id: app.id, name: app.name, server: server.name, kind: app.kind,
    about: `${app.name} runs on the server ${server.name}. It is ${KINDS[app.kind]}.`,
    status: backup?.verified ? 'verified' : backup ? 'untested' : 'none', statusText: statusText(app),
    lastBackup: backup ? formatDate(backup.capturedAt, { time: true }) : null,
    ...(include.tests ? { lastTest: testText(app.lastTest) } : {}),
    ...(include.schedules ? { schedule: scheduleText(app.schedule) } : {}),
    keys: keysText(app.keys), keyGaps: app.keyGaps, hasLoginNote: app.hasLoginNote,
    ...(include.logins && app.loginNote ? { loginNote: app.loginNote } : {}),
    works: { steps: works, ...(include.commands ? { command: checkCommands({ app }) } : {}) },
    down: ['Open DockNest and sign in.', `Open Apps and choose ${app.name}.`, 'Read its newest job under Jobs. It says what went wrong.', `Check under Servers that ${server.name} answers.`, 'If the server is lost, restore the app on a new server with the steps below.'],
    restore: {
      steps: backup ? ['Open DockNest and sign in.', `Open Apps and choose ${app.name}.`, 'Open Backups and choose the newest backup.', 'Choose Restore, choose the server and confirm.', 'Wait until its job under Jobs has finished.', 'Check that the app works, as described above.'] : ['Make a backup first: there is none yet.'],
      ...(backup && !independent ? { note: backup.chainBroken ? 'This backup needs earlier backups of its chain that are missing or not on SFTP or S3 storage, so only DockNest can restore it.' : 'This backup is not on SFTP or S3 storage, so only DockNest can restore it.' } : {}),
      ...(independent && include.commands ? { independent: restoreCommands({ app, backup, storage, reveal }) } : {}),
      expertGuide: docsLink(version, 'independent-recovery.md'),
    },
  };
}

// inventory: from loadInventory(); appIds: the apps to include, in any order (all when omitted).
export function buildGuide(inventory, { appIds, include: chosen = {}, version, madeAt = new Date().toISOString() }) {
  const include = { ...INCLUDE_DEFAULTS, ...chosen }, reveal = revealer(include), selected = new Set(appIds ?? inventory.apps.map(app => app.id));
  const apps = inventory.apps.filter(app => selected.has(app.id)), mainStorage = inventory.storage.find(item => item.id === inventory.defaultTarget) ?? inventory.storage[0] ?? null;
  const kitStorage = inventory.storage.find(item => item.id === inventory.selfBackup.kit?.location?.targetId) ?? null;
  const serverName = serverId => inventory.servers.find(server => server.id === serverId)?.name ?? 'an unknown server';
  return {
    title: 'Recovery Guide', madeAt, version, secrets: include.logins, include,
    startHere: {
      server: ['Get a new Linux server with at least as much disk space as the old one.', 'Install Docker, Git and Node.js 24 on it.', 'Sign in to it as root. Run every command in this guide there.'],
      install: installCommands({ version, kit: inventory.selfBackup.kit?.location ?? null, storage: kitStorage, reveal, emergency: emergencyOn(inventory, kitStorage) }).map(item => step(item.text, item.command, include)),
      storage: [
        'Open DockNest and sign in with an administrator account.',
        'Open Storage. Each backup storage should say Connected.',
        'If one does not, choose it, enter its login details and test the connection.',
        ...(mainStorage ? [step(`Check from the server that ${mainStorage.name} answers. This lists its backup folder.`, storageCheckCommand(mainStorage, reveal), include)] : []),
      ].map(item => (typeof item === 'string' ? { text: item } : item)),
    },
    order: restoreOrder(apps, inventory.links),
    fleet: {
      about: 'DockNest backs up the apps below, keeps the backups on the storage listed here and checks that they can be restored. This guide says how to bring everything back on a new server.',
      ...(include.notes && inventory.notes ? { whoToAsk: inventory.notes } : {}),
      servers: inventory.servers.filter(server => apps.some(app => app.serverId === server.id)).map(server => ({
        name: server.name, apps: apps.filter(app => app.serverId === server.id).map(app => app.name), note: server.note || '',
        ...(include.addresses ? { address: `${server.host}:${server.port}` } : {}),
      })),
      apps: apps.map(app => ({ name: app.name, server: serverName(app.serverId), lastBackup: app.backup ? formatDate(app.backup.capturedAt) : 'None yet', status: statusText(app), ...(include.tests ? { lastTest: testText(app.lastTest) } : {}) })),
      storage: inventory.storage.map(storage => ({
        name: storage.name, kind: storage.mode === 's3' ? 'S3 bucket' : 'SFTP server',
        holds: [...(storage.id === inventory.defaultTarget ? ['the main backups'] : []), ...(apps.some(app => app.copyTargetIds.includes(storage.id)) ? ['off-site copies'] : []), ...(storage.id === kitStorage?.id ? ['the recovery kit and this guide, in the folder docknest-recovery'] : [])],
        ...(include.addresses ? { address: storage.mode === 's3' ? new URL(storage.endpoint).host : `${storage.host}:${storage.port}` } : {}),
        ...(include.logins ? { login: storageLogin(storage) } : {}),
      })),
      kit: kitText(inventory.emergency),
    },
    apps: apps.map(app => appPage(app, inventory, { include, version, reveal })),
  };
}

// The guide as blocks for the PDF writer (src/runbook/pdf.js).
export function guideBlocks(guide) {
  const list = items => ({ type: 'list', items: items.map(item => (typeof item === 'string' ? item : item.command ? item : item.text)) });
  const blocks = [
    { type: 'title', title: guide.title, subtitle: `Made on ${formatDate(guide.madeAt, { time: true })} by DockNest ${guide.version}.`, lines: ['Keep this guide with the emergency kit. It says how to bring the apps back on a new server.', guide.secrets ? 'This copy holds login details to the backup storage. Keep it like a password.' : 'This copy holds no passwords, keys or login details.'] },
    { type: 'heading', text: 'Start here' },
    { type: 'heading', level: 2, text: 'Get a new server' }, list(guide.startHere.server),
    { type: 'heading', level: 2, text: 'Install DockNest' }, list(guide.startHere.install),
    { type: 'heading', level: 2, text: 'Connect the backup storage' }, list(guide.startHere.storage),
    { type: 'heading', text: 'Restore everything in this order', newPage: true },
    guide.order.length ? list(guide.order.map(item => `${item.name}. ${item.reason}`)) : { type: 'paragraph', text: 'No apps are in this guide.' },
    { type: 'heading', text: 'Fleet overview', newPage: true },
    { type: 'paragraph', text: guide.fleet.about },
  ];
  if (guide.fleet.whoToAsk) blocks.push({ type: 'heading', level: 2, text: 'Who to ask' }, { type: 'paragraph', text: guide.fleet.whoToAsk });
  const address = guide.include.addresses;
  blocks.push({ type: 'heading', level: 2, text: 'Servers' }, { type: 'table', columns: ['Server', 'What runs there', ...(address ? ['Address'] : []), 'Note'], rows: guide.fleet.servers.map(server => [server.name, server.apps.join(', '), ...(address ? [server.address] : []), server.note]) });
  blocks.push({ type: 'heading', level: 2, text: 'Apps' }, { type: 'table', columns: ['App', 'Server', 'Last good backup', guide.include.tests ? 'Last restore test' : 'State'], rows: guide.fleet.apps.map(app => [app.name, app.server, app.lastBackup, guide.include.tests ? app.lastTest : app.status]) });
  blocks.push({ type: 'heading', level: 2, text: 'Where the backups are' }, { type: 'table', columns: ['Storage', 'Kind', ...(address ? ['Address'] : []), 'Holds'], rows: guide.fleet.storage.map(storage => [storage.name, storage.kind, ...(address ? [storage.address] : []), storage.holds.join(', ') || 'Nothing in this guide']) });
  for (const storage of guide.fleet.storage.filter(item => item.login)) {
    blocks.push({ type: 'paragraph', text: `Login details for ${storage.name}:`, tone: 'warning' });
    for (const [label, value] of storage.login) blocks.push({ type: 'command', text: label === 'Private key' ? value : `${label}: ${value}`, wrap: true });
  }
  blocks.push({ type: 'heading', level: 2, text: 'The emergency kit' }, { type: 'paragraph', text: guide.fleet.kit.summary });
  if (guide.fleet.kit.holders) blocks.push(list(guide.fleet.kit.holders));
  for (const text of guide.fleet.kit.details) blocks.push({ type: 'paragraph', text });
  for (const app of guide.apps) {
    blocks.push({ type: 'heading', text: app.name, newPage: true }, { type: 'paragraph', text: app.about }, { type: 'paragraph', text: app.statusText, tone: app.status === 'verified' ? undefined : 'warning' });
    if (app.lastBackup) blocks.push({ type: 'paragraph', text: `Last good backup: ${app.lastBackup}.` });
    if (app.schedule) blocks.push({ type: 'paragraph', text: app.schedule });
    if (app.keys) blocks.push({ type: 'paragraph', text: app.keys });
    for (const gap of app.keyGaps) blocks.push({ type: 'paragraph', text: `Known gap: ${gap}`, tone: 'warning' });
    if (app.loginNote) blocks.push({ type: 'heading', level: 2, text: 'How to sign in to it' }, { type: 'paragraph', text: app.loginNote, tone: 'warning' });
    blocks.push({ type: 'heading', level: 2, text: 'How to tell it works' }, list(app.works.steps));
    if (app.works.command) blocks.push({ type: 'paragraph', text: 'Or check it from the server:' }, { type: 'command', text: app.works.command });
    blocks.push({ type: 'heading', level: 2, text: 'If it is down' }, list(app.down));
    blocks.push({ type: 'heading', level: 2, text: 'Restore it from a backup' }, list(app.restore.steps));
    if (app.restore.note) blocks.push({ type: 'paragraph', text: app.restore.note, tone: 'warning' });
    if (app.restore.independent) blocks.push({ type: 'paragraph', text: 'Without DockNest, for someone who knows Linux: open the recovery kit first (Start here), then run these as root on the new server.' }, list(app.restore.independent));
    blocks.push({ type: 'paragraph', text: `Expert guide: ${app.restore.expertGuide}`, tone: 'muted' });
    if (app.lastTest) blocks.push({ type: 'heading', level: 2, text: 'Last restore test' }, { type: 'paragraph', text: app.lastTest });
  }
  return blocks;
}
