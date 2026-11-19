// Every command the Recovery Guide prints (docs/recovery-guide.md "Commands"), built from one set of templates so each
// value is quoted the same way: install DockNest on a new server, open the recovery kit, fetch a file from the backup
// storage, restore an app (Compose project, single container or static site) the independent way of
// docs/independent-recovery.md, and check that it works. Values come from DockNest's own records; addresses and login
// details become placeholders such as '<server-address>' and '<storage-password>' unless the reader chose to include
// them. Each command is a list of words: plain strings are always shell-quoted; only the fixed fragments written here
// with raw() are not.
import path from 'node:path';
import { backupRoot } from '../backup-layout.js';

export const REPOSITORY = 'https://github.com/DahanItamar/DockNest.git';
export const KIT = '/root/docknest-kit';
export const RESTORE_ROOT = '/root/docknest-restore';
export const PLACEHOLDERS = Object.freeze({
  storageAddress: '<storage-address>', storageUser: '<storage-user>', storagePassword: '<storage-password>',
  storageBucket: '<storage-bucket>', storageAccessKey: '<storage-access-key>', storageSecretKey: '<storage-secret-key>',
});

// POSIX shell quoting: words made only of safe characters stay bare, anything else is single-quoted.
export function quote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}
// Commands are folded to fit the PDF's copy box: a word that does not fit goes on the next line after " \", and a
// longer word is cut into quoted pieces joined by "\" at the end of the line (the shell joins them back into one word).
export const COLUMNS = 88;
const pieces = value => {
  if (quote(value).length <= COLUMNS - 4) return [quote(value)];
  const size = COLUMNS - 8, cut = [];
  for (let at = 0; at < value.length; at += size) cut.push(`'${value.slice(at, at + size).replaceAll("'", `'\\''`)}'`);
  return cut;
};
const raw = text => ({ raw: text });
function command(...words) {
  const lines = [];
  let line = '';
  for (const word of words.flat()) {
    const [first, ...rest] = typeof word === 'object' ? [word.raw] : pieces(String(word));
    if (line && line.length + 1 + first.length + 2 > COLUMNS) { lines.push(line + ' \\'); line = '  ' + first; } else line = line ? `${line} ${first}` : first;
    for (const piece of rest) { lines.push(line + '\\'); line = piece; }
  }
  return [...lines, line].join('\n');
}
// A double-quoted word with command substitutions, as in "type=bind,src=$(field ...)": the fixed parts are escaped for
// double quotes, so the word stays one argument.
const join = (...parts) => raw('"' + parts.map(part => (typeof part === 'object' ? part.raw : String(part).replace(/["\\$`]/g, '\\$&'))).join('') + '"');
const field = (...keys) => raw(`$(field ${keys.join(' ')})`);
const assign = (name, word) => raw(`${name}=${word.raw}`);
const TAR = ['tar', '--xattrs', '--acls', '--numeric-owner', '--skip-old-files', '-xpf'];
// Reads one value from the package's manifest.json, for example: field containers 0 Mounts 1 Source
const FIELD = [
  "field() { python3 - \"$@\" <<'PY'",
  'import json, sys',
  'from functools import reduce',
  "manifest = json.load(open('package/manifest.json'))",
  'print(reduce(lambda v, k: v[int(k)] if isinstance(v, list) else v[k], sys.argv[1:], manifest))',
  'PY',
  '}',
].join('\n');

// Whether addresses and login details appear, or their placeholders.
export function revealer({ addresses = false, logins = false } = {}) {
  return {
    address: (value, placeholder = PLACEHOLDERS.storageAddress) => (addresses ? value : placeholder),
    login: (value, placeholder) => (logins ? value : placeholder),
  };
}

const hostPort = (host, port) => (host.includes(':') ? `[${host}]` : host) + (port ? `:${port}` : '');
const encodePath = value => value.split('/').map(encodeURIComponent).join('/');
// Base64 of the SHA-256 of the storage server's host key, as curl --hostpubsha256 wants it: the same pinned key DockNest checks.
const hostKeyHash = hex => Buffer.from(hex, 'hex').toString('base64');

// One curl request for an object in `storage`: S3 signed with the access keys (`query` for a bucket listing), or SFTP
// over the pinned host key. `output` writes the file there; without it curl prints it (for a folder, its listing).
function storageRequest(storage, { path: objectPath = '', query = '' }, output, reveal) {
  const common = ['curl', '--fail', '--silent', '--show-error'], target = output ? ['--output', output] : [];
  if (storage.mode === 's3') {
    const endpoint = new URL(storage.endpoint), host = reveal.address(endpoint.host), bucket = reveal.login(storage.bucket, PLACEHOLDERS.storageBucket), key = encodePath(objectPath) + query;
    const url = storage.pathStyle ? `${endpoint.protocol}//${host}/${bucket}${key ? '/' + key : ''}` : `${endpoint.protocol}//${bucket}.${host}/${key}`;
    return command(common, '--aws-sigv4', `aws:amz:${storage.region || 'us-east-1'}:s3`, '--user', `${reveal.login(storage.accessKeyId, PLACEHOLDERS.storageAccessKey)}:${reveal.login(storage.secretAccessKey, PLACEHOLDERS.storageSecretKey)}`, target, url);
  }
  const user = reveal.login(storage.username, PLACEHOLDERS.storageUser), url = `sftp://${hostPort(reveal.address(storage.host), reveal.address(storage.port, ''))}${encodePath(objectPath)}`;
  const login = storage.auth === 'key' ? ['--user', user, '--key', 'storage-key'] : ['--user', `${user}:${reveal.login(storage.password, PLACEHOLDERS.storagePassword)}`];
  return command(common, '--hostpubsha256', hostKeyHash(storage.hostKey), login, target, url);
}
export const fetchCommand = (storage, location, output, reveal) => storageRequest(storage, location, output, reveal);
// Lists the backup folder on the storage: proof that the address and the login work.
export const storageCheckCommand = (storage, reveal) => storageRequest(storage, storage.mode === 's3' ? { query: '?list-type=2&max-keys=20' } : { path: backupRoot(storage.root) + '/' }, null, reveal);

// Start here: a new server with Docker, Git and Node.js 24, DockNest from its release tag, the recovery kit opened and
// its database and master key put in place, then DockNest started. `kit` is the newest Self Backup kit, or null.
export function installCommands({ version, kit, storage, reveal }) {
  const steps = [
    { text: 'Download DockNest, the same version that made this guide.', command: [command('git', 'clone', '--branch', `v${version}`, REPOSITORY), command('cd', 'DockNest'), command('npm', 'ci'), command('npm', 'run', 'setup')].join('\n') },
    { text: 'Set the address of the dashboard. Open the file .env and set APP_DOMAIN and APP_ORIGIN.', command: command('nano', '.env') },
  ];
  if (kit && storage) {
    steps.push(
      { text: 'Download the newest recovery kit from the backup storage.', command: [command('mkdir', '-p', '-m', '0700', `${KIT}-files`), fetchCommand(storage, kit, `${KIT}-files/docknest-recovery.dkit`, reveal)].join('\n') },
      { text: 'Type the recovery passphrase into a private file. It is not in this guide.', command: [command('install', '-m', '600', '/dev/null', `${KIT}-files/recovery.passphrase`), command('nano', `${KIT}-files/recovery.passphrase`)].join('\n') },
      { text: 'Open the recovery kit. It holds DockNest\'s database, its master key and the recovery tools.', command: command('node', 'scripts/recovery-kit.js', 'restore', `${KIT}-files/docknest-recovery.dkit`, KIT, `${KIT}-files/recovery.passphrase`) },
      { text: 'Put the master key and the database in place.', command: [command('cp', `${KIT}/master.key`, 'data/master.key'), command('docker', 'volume', 'create', 'docknest_state'), command('docker', 'run', '--rm', '-v', 'docknest_state:/data', '-v', `${KIT}:/kit:ro`, 'node:24-bookworm-slim', 'sh', '-c', 'cp /kit/state.sqlite /data/state.sqlite && chown 1000:1000 /data/state.sqlite')].join('\n') },
    );
  }
  steps.push({ text: 'Start DockNest. It gets its HTTPS certificate by itself.', command: command('docker', 'compose', '--profile', 'https', 'up', '-d', '--build') });
  return steps;
}

const appFolder = app => `${RESTORE_ROOT}/${app.folder}`;
const composeArgs = files => files.flatMap(file => ['-f', file]);
const restorable = mount => mount.type === 'bind' || mount.type === 'volume';

// The independent restore of one app from its newest backup (docs/independent-recovery.md). `app`: { folder, name, kind,
// composeFiles, configFiles, documentRoot }; `backup`: { location, fileName, containers: [{ name, image, mounts }],
// chain: [locations, full backup first] or null }.
export function restoreCommands({ app, backup, storage, reveal }) {
  const folder = appFolder(app), steps = [];
  const fetchAll = (backup.chain ?? [backup.location]).map(location => fetchCommand(storage, location, path.posix.basename(location.path), reveal));
  steps.push({ text: 'Make a private folder for this app and download its backup into it.', command: [command('mkdir', '-p', '-m', '0700', folder), command('cd', folder), ...fetchAll].join('\n') });
  if (backup.chain) {
    steps.push({ text: 'Check and decrypt the whole backup chain with the recovery kit.', command: command('node', `${KIT}/recovery/decrypt-backup.js`, '--chain', backup.fileName, `${KIT}/master.key`, 'chain') });
    steps.push({ text: 'Rebuild the files. It prints where each folder belongs and the images to load, in order. Put each folder there and load each image before you start the app.', command: command('python3', `${KIT}/recovery/helper.py`, 'restore-chain', 'chain', 'files') });
    steps.push(startStep(app, backup));
    return steps;
  }
  steps.push({ text: 'Decrypt the backup with the recovery kit and unpack it.', command: [command('node', `${KIT}/recovery/decrypt-backup.js`, backup.fileName, `${KIT}/master.key`, 'payload.tar.gz'), command('mkdir', '-m', '0700', 'package'), command('tar', '-xzf', 'payload.tar.gz', '-C', 'package')].join('\n') });
  const configs = [...(app.composeFiles ?? []), ...(app.configFiles ?? [])].map((file, index) => command('mkdir', '-p', path.posix.dirname(file), raw('&&'), TAR, `package/config-${index}.tar`, '-C', path.posix.dirname(file)));
  if (app.kind === 'static') {
    const parent = path.posix.dirname(app.documentRoot);
    steps.push({ text: 'Put the website files back in their folder. Files already there are kept.', command: command('mkdir', '-p', parent, raw('&&'), TAR, 'package/static-files.tar', '-C', parent) });
    if (configs.length) steps.push({ text: 'Put the nginx settings back.', command: configs.join('\n') });
    steps.push(startStep(app, backup));
    return steps;
  }
  steps.push({ text: 'Load the saved container images.', command: command('docker', 'load', '-i', 'package/images.tar') });
  const mounts = backup.containers.flatMap((container, index) => container.mounts.map((mount, position) => ({ index, position, mount }))).filter(item => restorable(item.mount));
  if (mounts.length) {
    steps.push({ text: 'Put each data folder back where it was. Files already there are kept.', command: [FIELD, ...mounts.map(({ index, position }) => [
      command(assign('src', join(field('containers', index, 'Mounts', position, 'Source')))),
      command('mkdir', '-p', raw('"$(dirname "$src")"'), raw('&&'), TAR, `package/mount-${index}-${position}.tar`, '-C', raw('"$(dirname "$src")"')),
    ].join('\n'))].join('\n') });
  }
  if (configs.length) steps.push({ text: app.composeFiles?.length ? 'Put the Compose files back.' : 'Put the settings files back.', command: configs.join('\n') });
  steps.push(startStep(app, backup));
  return steps;
}

function startStep(app, backup) {
  if (app.kind === 'static') return { text: 'Check the nginx settings and reload nginx.', command: [command('nginx', '-t'), command('systemctl', 'reload', 'nginx')].join('\n') };
  const tags = backup.containers.map(container => container.image), unique = image => tags.filter(tag => tag === image).length === 1;
  if (app.composeFiles?.length) {
    // The saved snapshot (with the container's own changes) takes the image name the Compose file asks for; when two
    // containers share an image name, the original image does instead.
    const image = (container, index) => (unique(container.image) ? field('snapshotImages', index) : field('containers', index, 'Image'));
    const tagging = backup.chain ? [] : [FIELD, ...backup.containers.map((container, index) => command('docker', 'tag', join(image(container, index)), container.image))];
    return { text: 'Start the app with its Compose file.', command: [...tagging, command('cd', path.posix.dirname(app.composeFiles[0]), raw('&&'), 'docker', 'compose', composeArgs(app.composeFiles), 'up', '-d')].join('\n') };
  }
  const lines = backup.chain ? [] : [FIELD, ...backup.containers.map((container, index) => command('docker', 'create', '--name', container.name, '--restart', 'unless-stopped',
    container.mounts.flatMap((mount, position) => (restorable(mount) ? ['--mount', join(`type=${mount.type},src=`, field('containers', index, 'Mounts', position, mount.type === 'volume' ? 'Name' : 'Source'), `,dst=${mount.destination}`)] : [])),
    join(field('snapshotImages', index))))];
  return { text: 'Create the container from its saved snapshot and start it. Ports and networks are set as the expert guide in the package says.', command: [...lines, ...backup.containers.map(container => command('docker', 'start', container.name))].join('\n') };
}

const ENGINE_CHECKS = {
  postgres: container => command('docker', 'exec', container, 'pg_isready'),
  mysql: container => command('docker', 'exec', container, 'mysqladmin', 'ping'),
  mariadb: container => command('docker', 'exec', container, 'mariadb-admin', 'ping'),
  redis: container => command('docker', 'exec', container, 'redis-cli', 'ping'),
};
export const CHECKED_ENGINES = Object.freeze([...Object.keys(ENGINE_CHECKS), 'sqlite']);

// How to tell the app works: its containers are up, each database answers, each SQLite file passes integrity_check and
// each domain answers over HTTPS.
export function checkCommands({ app }) {
  const lines = [];
  if (app.kind === 'static') lines.push(command('nginx', '-t'));
  else if (app.composeFiles?.length) lines.push(command('cd', path.posix.dirname(app.composeFiles[0]), raw('&&'), 'docker', 'compose', composeArgs(app.composeFiles), 'ps'));
  else for (const container of app.containers ?? []) lines.push(command('docker', 'ps', '--filter', `name=^${container}$`));
  for (const service of app.services ?? []) {
    if (ENGINE_CHECKS[service.engine]) lines.push(ENGINE_CHECKS[service.engine](service.container));
    for (const file of service.sqliteFiles ?? []) {
      const copy = `${appFolder(app)}/check-${path.posix.basename(file)}`;
      lines.push(command('docker', 'cp', `${service.container}:${file}`, copy, raw('&&'), 'python3', '-c', "import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute('PRAGMA integrity_check').fetchone()[0])", copy));
    }
  }
  for (const domain of app.domains ?? []) lines.push(command('curl', '--fail', '--silent', '--show-error', '--output', '/dev/null', '--write-out', '%{http_code}\\n', `https://${domain}/`));
  return lines.join('\n');
}
