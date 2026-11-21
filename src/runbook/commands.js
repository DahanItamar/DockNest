// Every command the Recovery Guide prints (docs/recovery-guide.md "Commands"), built from one set of templates so each
// value is quoted the same way: install DockNest on a new server, open the recovery kit, fetch a file from the backup
// storage, restore an app (Compose project, single container or static site) the independent way of
// docs/independent-recovery.md, and check that it works. Values come from DockNest's own records; addresses and login
// details become placeholders such as '<server-address>' and '<storage-password>' unless the reader chose to include
// them. Each command is a list of words: plain strings are always shell-quoted; only the fixed fragments written here
// with raw() are not.
import path from 'node:path';
import { backupRoot } from '../backup-layout.js';
import { commandFits } from './pdf.js';

export const REPOSITORY = 'https://github.com/DahanItamar/DockNest.git';
export const KIT = '/root/docknest-kit';
export const RESTORE_ROOT = '/root/docknest-restore';
export const PLACEHOLDERS = Object.freeze({
  storageAddress: '<storage-address>', storagePort: '<storage-port>', storageUser: '<storage-user>', storagePassword: '<storage-password>',
  storageBucket: '<storage-bucket>', storageAccessKey: '<storage-access-key>', storageSecretKey: '<storage-secret-key>',
});

// POSIX shell quoting: words made only of safe characters stay bare, anything else is single-quoted.
export function quote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}
// Commands are folded to fit the PDF's copy box, measured with its font (src/runbook/pdf.js commandFits): a word that
// does not fit goes on the next line after " \", and a longer word is cut into quoted pieces joined by "\" at the end of
// the line (the shell joins adjacent quoted pieces back into one word).
const cut = (units, wrap) => {
  const pieces = [];
  let piece = '';
  for (const unit of units) {
    if (piece && !commandFits('  ' + wrap(piece + unit) + ' \\')) { pieces.push(wrap(piece)); piece = ''; }
    piece += unit;
  }
  return [...pieces, wrap(piece)];
};
const single = text => `'${text}'`, double = text => `"${text}"`;
// Every piece is measured as if it started a continuation line ("  ") and ended one (" \").
const pieces = value => (commandFits('  ' + quote(value) + ' \\') ? [quote(value)] : cut([...String(value)].map(character => (character === "'" ? `'\\''` : character)), single));
const raw = text => ({ raw: text });
function command(...words) {
  const lines = [];
  let line = '';
  for (const word of words.flat()) {
    const [first, ...rest] = typeof word !== 'object' ? pieces(String(word)) : word.units && !commandFits('  ' + word.raw + ' \\') ? cut(word.units, double) : [word.raw];
    if (line && !commandFits(`${line} ${first} \\`)) { lines.push(line + ' \\'); line = '  ' + first; } else line = line ? `${line} ${first}` : first;
    for (const piece of rest) { lines.push(line + '\\'); line = piece; }
  }
  return [...lines, line].join('\n');
}
// A double-quoted word with command substitutions, as in "type=bind,src=$(field ...)": the fixed parts are escaped for
// double quotes, so the word stays one argument. A long one is cut between characters of its fixed parts.
function join(...parts) {
  const units = parts.flatMap(part => (typeof part === 'object' ? [part.raw] : [...String(part)].map(character => character.replace(/["\\$`]/, '\\$&'))));
  return { raw: double(units.join('')), units };
}
const field = (...keys) => raw(`$(field ${keys.join(' ')})`);
const assign = (name, word) => raw(`${name}=${word.raw}`);
const TAR = ['tar', '--xattrs', '--acls', '--numeric-owner', '--skip-old-files', '-xpf'];
// Small shell functions with a Python program in single quotes (no heredoc, so a copied box has no "<<" marker and
// nothing in it reads like a placeholder to fill in).
const pythonFunction = (name, lines) => [`${name}() { python3 -c '`, ...lines, `' "$@"; }`].join('\n');
// Reads one value from the package's manifest.json, for example: field containers 0 Mounts 1 Source
const FIELD = pythonFunction('field', [
  'import json, sys',
  'value = json.load(open("package/manifest.json"))',
  'for key in sys.argv[1:]:',
  '    value = value[int(key)] if isinstance(value, list) else value[key]',
  'print(value)',
]);
// Gives a folder the owner, group and mode of the first entry of a mount archive: a Docker volume's own folder, which
// tar --strip-components leaves as Docker made it.
const OWNER = pythonFunction('owner', [
  'import os, sys, tarfile',
  'with tarfile.open(sys.argv[1]) as archive:',
  '    top = archive.next()',
  'os.chown(sys.argv[2], top.uid, top.gid)',
  'os.chmod(sys.argv[2], top.mode)',
]);

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

// curl from a pinned image, run with Docker: many servers' own curl has no SFTP (Alpine's has none, and only a curl
// built with libssh2 checks a pinned host key), and every server in this guide has Docker.
export const CURL_IMAGE = 'curlimages/curl:8.11.1@sha256:c1fe1679c34d9784c1b0d1e5f62ac0a79fca01fb6377cdd33e90473c6f9f9a69';
// Start here pulls it by digest once and names it CURL; every download then uses that name.
export const CURL = 'docknest-curl:8.11.1';
export const STORAGE_KEY = '/root/storage-key';
// One request for an object in `storage`: S3 signed with the access keys (`query` for a bucket listing), or SFTP over
// the pinned host key. `output` (an absolute path) writes the file there; without it curl prints it (for a folder, its
// listing).
export function fetchCommand(storage, { path: objectPath = '', query = '' }, output, reveal) {
  const folder = output ? path.posix.dirname(output) : null, key = storage.mode === 'sftp' && storage.auth === 'key';
  const curl = ['docker', 'run', '--rm', '--user', '0:0', ...(folder ? ['-v', `${folder}:${folder}`, '-w', folder] : []), ...(storage.mode === 'sftp' ? ['-v', '/root/.ssh:/root/.ssh:ro'] : []), ...(key ? ['-v', `${STORAGE_KEY}:${STORAGE_KEY}:ro`] : []), CURL, '--fail', '--silent', '--show-error'];
  const target = output ? ['--output', path.posix.basename(output)] : [];
  if (storage.mode === 's3') {
    const endpoint = new URL(storage.endpoint), host = reveal.address(endpoint.host), bucket = reveal.login(storage.bucket, PLACEHOLDERS.storageBucket), objectKey = encodePath(objectPath) + query;
    const url = storage.pathStyle ? `${endpoint.protocol}//${host}/${bucket}${objectKey ? '/' + objectKey : ''}` : `${endpoint.protocol}//${bucket}.${host}/${objectKey}`;
    return command(curl, '--aws-sigv4', `aws:amz:${storage.region || 'us-east-1'}:s3`, '--user', `${reveal.login(storage.accessKeyId, PLACEHOLDERS.storageAccessKey)}:${reveal.login(storage.secretAccessKey, PLACEHOLDERS.storageSecretKey)}`, target, url);
  }
  const user = reveal.login(storage.username, PLACEHOLDERS.storageUser), url = `sftp://${hostPort(reveal.address(storage.host), reveal.address(storage.port, PLACEHOLDERS.storagePort))}${encodePath(objectPath)}`;
  const login = key ? ['--user', user, '--key', STORAGE_KEY] : ['--user', `${user}:${reveal.login(storage.password, PLACEHOLDERS.storagePassword)}`];
  return command(curl, '--hostpubsha256', hostKeyHash(storage.hostKey), login, target, url);
}
// ssh-keyscan from a pinned image, to trust the SFTP storage server before any login is sent: of the keys the server
// offers, only the one whose SHA-256 is the key DockNest pinned goes into /root/.ssh/known_hosts, and the command fails
// when none matches. curl (libssh2) then asks for that key type, and --hostpubsha256 checks it again.
export const KEYSCAN_IMAGE = 'alpine/git:2.47.2@sha256:062a01ad7a0eb17cff382bc5e26086b4d710e56dfdfdf001109a49b6d9bd378c';
const KEYSCAN = [
  'ssh-keyscan -p "$2" -t ed25519,ecdsa,rsa "$1" 2>/dev/null |',
  'while read -r host type key; do',
  '  sum=$(printf %s "$key" | base64 -d 2>/dev/null | sha256sum)',
  '  [ "${sum%% *}" = "$3" ] && echo "$host $type $key"',
  'done > /root/.ssh/known_hosts.docknest',
  'test -s /root/.ssh/known_hosts.docknest || exit 1',
  'cat /root/.ssh/known_hosts.docknest >> /root/.ssh/known_hosts',
].join('\n');
export function trustCommand(storage, reveal) {
  if (storage.mode !== 'sftp') return null;
  return [command('mkdir', '-p', '-m', '0700', '/root/.ssh'), command('docker', 'run', '--rm', '-v', '/root/.ssh:/root/.ssh', '--entrypoint', 'sh', KEYSCAN_IMAGE, '-c', raw(`'${KEYSCAN}'`), 'sh', reveal.address(storage.host), String(reveal.address(storage.port, PLACEHOLDERS.storagePort)), storage.hostKey)].join('\n');
}
// The step that trusts an SFTP storage server, for the lists of steps; none for S3.
export const trusted = (storage, reveal) => (storage.mode === 'sftp' ? [{ text: "Check the storage server's key against the one DockNest pinned. Nothing is sent before it matches.", command: trustCommand(storage, reveal) }] : []);
// Lists the backup folder on the storage: proof that the address and the login work.
export const storageCheckCommand = (storage, reveal) => fetchCommand(storage, storage.mode === 's3' ? { query: '?list-type=2&max-keys=20' } : { path: backupRoot(storage.root) + '/' }, null, reveal);

// Start here: a new server with Docker, Git and Node.js 24, DockNest from its release tag, the recovery kit opened and
// its database and master key put in place, then DockNest started. `kit` is the newest Self Backup kit, or null. With
// the optional split on, `emergency` is { kit } (the newest emergency kit on the same storage): holders copy the
// docknest-recovery/emergency folder, which holds the offline tool emergency-open.js, and K of them type their parts
// into it; it gives the recovery kit and its passphrase file.
export function installCommands({ version, kit, storage, reveal, emergency = null }) {
  const files = `${KIT}-files`, steps = [
    { text: 'Download DockNest, the same version that made this guide.', command: [command('git', 'clone', '--branch', `v${version}`, REPOSITORY), command('cd', 'DockNest'), command('npm', 'ci'), command('npm', 'run', 'setup')].join('\n') },
    { text: 'Set the address of the dashboard. Open the file .env and set APP_DOMAIN and APP_ORIGIN.', command: command('nano', '.env') },
    { text: 'Get the download tool. Every download in this guide uses it.', command: [command('docker', 'pull', CURL_IMAGE), command('docker', 'tag', CURL_IMAGE, CURL)].join('\n') },
  ];
  let opened;
  if (kit && storage && emergency) {
    const folder = path.posix.dirname(emergency.kit.path);
    steps.push(
      ...trusted(storage, reveal),
      // The exact tool published with this kit (an append-only destination may hold it under a versioned name), checked against
      // the SHA-256 recorded when it was published before node runs it. Kits recorded before 3.0.0 name no tool: the folder's one.
      { text: emergency.kit.tool ? 'Copy the emergency kit and the tool that opens it from the backup storage, then check the tool is the one DockNest published.' : 'Copy the emergency folder from the backup storage. The tool that opens the kit is in it.', command: [command('mkdir', '-p', '-m', '0700', `${files}/emergency`), fetchCommand(storage, { path: emergency.kit.tool?.path ?? `${folder}/emergency-open.js` }, `${files}/emergency/emergency-open.js`, reveal), fetchCommand(storage, emergency.kit, `${files}/emergency/${path.posix.basename(emergency.kit.path)}`, reveal), ...(emergency.kit.tool ? [command('echo', `${emergency.kit.tool.sha256}  ${files}/emergency/emergency-open.js`, raw('|'), 'sha256sum', '-c', '-')] : [])].join('\n') },
      // Fail-closed: with a recorded hash the run itself checks the tool first, so node never starts a swapped tool.
      { text: emergency.kit.tool ? 'Ask the people who hold the parts to type them in, one at a time, when the tool asks. The tool is checked first. If the check does not print OK, stop: the tool is not the one DockNest published.' : 'Ask the people who hold the parts to type them in, one at a time, when the tool asks.', command: [command('cd', `${files}/emergency`), emergency.kit.tool ? command('echo', `${emergency.kit.tool.sha256}  emergency-open.js`, raw('|'), 'sha256sum', '-c', '-', raw('&&'), 'node', 'emergency-open.js', 'open', '.', `${files}/opened`) : command('node', 'emergency-open.js', 'open', '.', `${files}/opened`), command('cd', raw('-'))].join('\n') },
    );
    opened = { kit: `${files}/opened/docknest-recovery.dkit`, passphrase: `${files}/opened/recovery-passphrase.txt` };
  } else if (kit && storage) {
    steps.push(
      ...trusted(storage, reveal),
      { text: 'Download the newest recovery kit from the backup storage.', command: [command('mkdir', '-p', '-m', '0700', files), fetchCommand(storage, kit, `${files}/docknest-recovery.dkit`, reveal)].join('\n') },
      { text: 'Type the recovery passphrase into a private file. It is not in this guide.', command: [command('install', '-m', '600', '/dev/null', `${files}/recovery.passphrase`), command('nano', `${files}/recovery.passphrase`)].join('\n') },
    );
    opened = { kit: `${files}/docknest-recovery.dkit`, passphrase: `${files}/recovery.passphrase` };
  }
  if (opened) {
    steps.push(
      { text: 'Open the recovery kit. It holds DockNest\'s database, its master key and the recovery tools.', command: command('node', 'scripts/recovery-kit.js', 'restore', opened.kit, KIT, opened.passphrase) },
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
  const fetchAll = (backup.chain ?? [backup.location]).map(location => fetchCommand(storage, location, `${folder}/${path.posix.basename(location.path)}`, reveal));
  steps.push(...trusted(storage, reveal));
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
    // A bind folder goes back where it was. A named volume is created on this server and filled through the folder Docker
    // gives it (docker volume inspect), wherever this server keeps its volumes; its own folder takes the archive's owner.
    const archive = ({ index, position }) => `package/mount-${index}-${position}.tar`;
    const restoreMount = item => (item.mount.type === 'volume' ? [
      command(assign('volume', join(field('containers', item.index, 'Mounts', item.position, 'Name')))),
      command('docker', 'volume', 'create', raw('"$volume"')),
      command(assign('dst', raw(`"$(docker volume inspect -f '{{.Mountpoint}}' "$volume")"`))),
      command(TAR, archive(item), '--strip-components=1', '-C', raw('"$dst"'), raw('&&'), 'owner', archive(item), raw('"$dst"')),
    ] : [
      command(assign('src', join(field('containers', item.index, 'Mounts', item.position, 'Source')))),
      command('mkdir', '-p', raw('"$(dirname "$src")"'), raw('&&'), TAR, archive(item), '-C', raw('"$(dirname "$src")"')),
    ]).join('\n');
    const helpers = mounts.some(item => item.mount.type === 'volume') ? [FIELD, OWNER] : [FIELD];
    steps.push({ text: 'Put each data folder and Docker volume back. Files already there are kept.', command: [...helpers, ...mounts.map(restoreMount)].join('\n') });
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
  mongo: container => command('docker', 'exec', container, 'mongosh', '--quiet', '--eval', 'db.runCommand({ ping: 1 }).ok'),
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
