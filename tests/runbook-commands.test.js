// The Recovery Guide commands (src/runbook/commands.js): shell quoting and folding (run through a real POSIX shell),
// placeholders for addresses and login details, and the commands for each kind of app (Compose project, single
// container, static website, an incremental chain) and each database engine DockNest knows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { quote, COLUMNS, CHECKED_ENGINES, fetchCommand, storageCheckCommand, installCommands, restoreCommands, checkCommands, revealer } from '../src/runbook/commands.js';
import { font } from '../src/runbook/fonts.js';

const shell = spawnSync('sh', ['-c', 'exit 0']).status === 0;
const needsShell = { skip: !shell && 'needs a POSIX shell' };
// Runs `script` with each listed command replaced by one that prints its arguments, one per line.
const args = (script, names) => {
  const result = spawnSync('sh', ['-c', names.map(name => `${name}() { printf '%s\\n' "$@"; }`).join('\n') + '\n' + script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\n').slice(0, -1);
};
const syntax = script => assert.equal(spawnSync('sh', ['-n', '-c', script], { encoding: 'utf8' }).status, 0, script);
const hidden = revealer({}), shown = revealer({ addresses: true, logins: true });
const sftp = { mode: 'sftp', name: 'Home storage', host: '192.0.2.10', port: 2222, username: 'backup', hostKey: 'ab'.repeat(32), auth: 'password', password: "pa ss'w$rd`x\"", root: '/srv/backups' };
const s3 = { mode: 's3', name: 'Bucket', endpoint: 'https://s3.example.net', region: 'eu-west-1', bucket: 'family-backups', pathStyle: true, accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret/key+value', root: 'docknest' };
const longPath = `/srv/backups/BACKUP/web-1--${'1'.repeat(36)}/shop--${'2'.repeat(36)}/backup_2026-11-19_03-00-00Z--${'3'.repeat(36)}.tar.gz.enc`;
const backup = (containers, extra = {}) => ({ location: { targetId: 't', path: longPath }, fileName: longPath.split('/').at(-1), containers, chain: null, ...extra });
const compose = { folder: 'shop--abc', name: 'Shop', kind: 'compose', composeFiles: ['/srv/shop/compose.yaml', '/srv/shop/compose.prod.yaml'], configFiles: ['/srv/shop/.env'], containers: ['shop-web', 'shop-db'], domains: ['shop.example.com'], services: [{ container: 'shop-db', engine: 'postgres', sqliteFiles: [] }] };
const composeBackup = backup([{ name: 'shop-web', image: 'nginx:1.27', mounts: [{ type: 'bind', destination: '/usr/share/nginx/html' }, { type: 'tmpfs', destination: '/tmp' }] }, { name: 'shop-db', image: 'postgres:16', mounts: [{ type: 'volume', destination: '/var/lib/postgresql/data' }] }]);
// The commands as one logical line each: folds joined back, as the shell reads them.
const unfold = text => text.replace(/'\\\n'/g, '').replace(/ \\\n {2}/g, ' ');
const all = steps => unfold(steps.map(item => item.command).join('\n'));

test('quote: safe words stay bare, everything else is single-quoted and reads back the same in a shell', needsShell, () => {
  assert.equal(quote('docker'), 'docker');
  assert.equal(quote('/srv/shop/compose.yaml'), '/srv/shop/compose.yaml');
  assert.equal(quote('two words'), "'two words'");
  assert.equal(quote("it's"), "'it'\\''s'");
  assert.equal(quote(''), "''");
  const values = ['plain', 'two words', "it's", '$(rm -rf /)', '`id`', '"double"', 'back\\slash', 'semi;colon && more', 'new\nline', 'חנות של דנה', '*', '~root', '<storage-password>', "'''", '-n'];
  assert.deepEqual(args(`printf '%s\\n' ${values.map(quote).join(' ')}`, []), values.flatMap(value => value.split('\n')));
});

test('a long word is folded into pieces the shell joins back, and no line is wider than the copy box', needsShell, () => {
  const command = fetchCommand(sftp, { path: longPath }, 'backup.enc', shown);
  for (const line of command.split('\n')) assert.ok(line.length <= COLUMNS, line);
  assert.deepEqual(args(command, ['curl']), ['--fail', '--silent', '--show-error', '--hostpubsha256', Buffer.from(sftp.hostKey, 'hex').toString('base64'), '--user', `backup:${sftp.password}`, '--output', 'backup.enc', `sftp://192.0.2.10:2222${longPath}`]);
  const mono = font('mono'), boxWidth = 595.28 - 2 * 56 - 12;
  assert.ok(mono.widths[mono.cmap.get(0x4d)] / mono.unitsPerEm * 8.5 * COLUMNS <= boxWidth, 'a full line fits the PDF copy box');
});

test('placeholders replace addresses and login details unless they are included', () => {
  const hiddenCommand = fetchCommand(sftp, { path: '/srv/backups/x.enc' }, 'x.enc', hidden);
  assert.ok(hiddenCommand.includes("'<storage-user>:<storage-password>'") && hiddenCommand.includes("'sftp://<storage-address>/srv/backups/x.enc'"));
  for (const secret of ['192.0.2.10', '2222', 'backup:', 'pa ss']) assert.ok(!hiddenCommand.includes(secret), secret);
  const addressOnly = fetchCommand(sftp, { path: '/srv/backups/x.enc' }, 'x.enc', revealer({ addresses: true }));
  assert.ok(addressOnly.includes('sftp://192.0.2.10:2222/') && addressOnly.includes('<storage-password>'));
  const bucket = fetchCommand(s3, { path: 'docknest/BACKUP/a b.enc' }, 'a.enc', hidden);
  assert.ok(bucket.includes("'<storage-access-key>:<storage-secret-key>'") && bucket.includes("'https://<storage-address>/<storage-bucket>/docknest/BACKUP/a%20b.enc'"));
  assert.ok(!bucket.includes('s3.example.net') && !bucket.includes('family-backups'));
  assert.match(unfold(fetchCommand(s3, { path: 'k' }, 'k', shown)), /--aws-sigv4 aws:amz:eu-west-1:s3 --user AKIAEXAMPLE:secret\/key\+value --output k https:\/\/s3\.example\.net\/family-backups\/k$/);
  assert.match(unfold(fetchCommand({ ...s3, pathStyle: false }, { path: 'k' }, 'k', shown)), /https:\/\/family-backups\.s3\.example\.net\/k$/);
  assert.match(unfold(fetchCommand({ ...sftp, auth: 'key', password: undefined }, { path: '/k' }, 'k', shown)), /--user backup --key storage-key --output k sftp:\/\/192\.0\.2\.10:2222\/k$/);
  assert.match(unfold(fetchCommand({ ...sftp, host: '2001:db8::5' }, { path: '/k' }, 'k', shown)), /'sftp:\/\/\[2001:db8::5\]:2222\/k'$/);
  assert.match(storageCheckCommand(sftp, hidden), /'sftp:\/\/<storage-address>\/srv\/backups\/BACKUP\/'$/);
  assert.match(storageCheckCommand(s3, shown), /'https:\/\/s3\.example\.net\/family-backups\/\?list-type=2&max-keys=20'$/);
});

test('install: the release tag of this version, the kit opened and put in place, then DockNest started', needsShell, () => {
  const steps = installCommands({ version: '3.0.0', kit: { targetId: 't', path: '/srv/backups/BACKUP/docknest-recovery/docknest_0123456789abcdef_2026-11-19_03-00-00Z--x.dkit' }, storage: sftp, reveal: hidden });
  const text = all(steps);
  assert.match(text, /^git clone --branch v3\.0\.0 https:\/\/github\.com\/DahanItamar\/DockNest\.git$/m);
  assert.match(text, /^node scripts\/recovery-kit\.js restore \/root\/docknest-kit-files\/docknest-recovery\.dkit \/root\/docknest-kit \/root\/docknest-kit-files\/recovery\.passphrase$/m);
  assert.match(text, /^docker compose --profile https up -d --build$/m);
  assert.ok(steps.every(item => /^[A-Z]/.test(item.text) && item.text.endsWith('.')), 'each step is a sentence');
  assert.ok(!text.includes('passphrase=') && !/recovery\.passphrase [^\n]*[A-Za-z0-9]{24}/.test(text), 'the recovery passphrase is never in a command');
  syntax(text);
  assert.deepEqual(installCommands({ version: '3.0.0', kit: null, storage: null, reveal: hidden }).map(item => item.text).slice(-1), ['Start DockNest. It gets its HTTPS certificate by itself.']);
});

test('restore a Compose project: download, decrypt, images, data folders, Compose files, then up', needsShell, () => {
  const steps = restoreCommands({ app: compose, backup: composeBackup, storage: sftp, reveal: hidden }), text = all(steps);
  syntax(text);
  assert.deepEqual(steps.map(item => item.text), [
    'Make a private folder for this app and download its backup into it.',
    'Decrypt the backup with the recovery kit and unpack it.',
    'Load the saved container images.',
    'Put each data folder back where it was. Files already there are kept.',
    'Put the Compose files back.',
    'Start the app with its Compose file.',
  ]);
  assert.match(text, /^node \/root\/docknest-kit\/recovery\/decrypt-backup\.js backup_[^ ]+\.tar\.gz\.enc \/root\/docknest-kit\/master\.key payload\.tar\.gz$/m);
  assert.match(text, /^docker load -i package\/images\.tar$/m);
  assert.match(text, /^src="\$\(field containers 0 Mounts 0 Source\)"$/m);
  assert.match(text, /^src="\$\(field containers 1 Mounts 0 Source\)"$/m);
  assert.ok(!text.includes('mount-0-1.tar'), 'a temporary memory folder has no archive');
  assert.match(text, /package\/config-0\.tar -C \/srv\/shop$/m);
  assert.match(text, /package\/config-2\.tar -C \/srv\/shop$/m);
  assert.match(text, /^docker tag "\$\(field snapshotImages 1\)" postgres:16$/m);
  assert.match(text, /^cd \/srv\/shop && docker compose -f \/srv\/shop\/compose\.yaml -f \/srv\/shop\/compose\.prod\.yaml up -d$/m);
  const shared = restoreCommands({ app: compose, backup: backup([{ name: 'a', image: 'app:1', mounts: [] }, { name: 'b', image: 'app:1', mounts: [] }]), storage: sftp, reveal: hidden });
  assert.match(all(shared), /^docker tag "\$\(field containers 1 Image\)" app:1$/m, 'two containers of one image keep the original image');
});

test('restore a single container from its snapshot, with its bind and volume mounts', needsShell, () => {
  const app = { ...compose, kind: 'container', composeFiles: [], configFiles: [], name: "Dana's app" };
  const text = all(restoreCommands({ app, backup: backup([{ name: 'dana-app', image: 'ghost:5', mounts: [{ type: 'bind', destination: '/var/lib/ghost/content' }, { type: 'volume', destination: '/data' }] }]), storage: s3, reveal: hidden }));
  syntax(text);
  assert.match(text, /^docker create --name dana-app --restart unless-stopped --mount "type=bind/m);
  assert.ok(text.includes('"type=bind,src=$(field containers 0 Mounts 0 Source),dst=/var/lib/ghost/content"'));
  assert.ok(text.includes('"type=volume,src=$(field containers 0 Mounts 1 Name),dst=/data"'));
  assert.match(text, /"\$\(field snapshotImages 0\)"$/m);
  assert.match(text, /^docker start dana-app$/m);
  assert.ok(text.includes('<storage-secret-key>'));
});

test('restore a static website: files and nginx settings back, then nginx reloaded', needsShell, () => {
  const app = { folder: 'docs--x', name: 'Docs', kind: 'static', documentRoot: '/var/www/docs site', configFiles: ['/etc/nginx/sites-enabled/docs'], composeFiles: [], domains: ['docs.example.com'] };
  const text = all(restoreCommands({ app, backup: backup([]), storage: sftp, reveal: hidden }));
  syntax(text);
  assert.ok(!text.includes('docker'));
  assert.match(text, /^mkdir -p \/var\/www && tar --xattrs --acls --numeric-owner --skip-old-files -xpf package\/static-files\.tar -C \/var\/www$/m);
  assert.match(text, /package\/config-0\.tar -C \/etc\/nginx\/sites-enabled$/m);
  assert.match(text, /^nginx -t\nsystemctl reload nginx$/m);
  assert.match(unfold(checkCommands({ app })), /^nginx -t\ncurl .*https:\/\/docs\.example\.com\/$/m);
});

test('restore an incremental chain: every package downloaded, then decrypt-backup --chain and restore-chain', needsShell, () => {
  const chain = [{ targetId: 't', path: '/srv/backups/BACKUP/s/backup_1--full.tar.gz.enc' }, { targetId: 't', path: '/srv/backups/BACKUP/s/backup_2--inc.tar.gz.enc' }];
  const text = all(restoreCommands({ app: compose, backup: { ...composeBackup, location: chain[1], fileName: 'backup_2--inc.tar.gz.enc', chain }, storage: sftp, reveal: hidden }));
  syntax(text);
  assert.equal(text.match(/^curl /gm).length, 2);
  assert.match(text, /decrypt-backup\.js --chain backup_2--inc\.tar\.gz\.enc/);
  assert.match(text, /^python3 \/root\/docknest-kit\/recovery\/helper\.py restore-chain chain files$/m);
});

test('checks for each database engine, SQLite files, containers and domains', needsShell, () => {
  assert.deepEqual([...CHECKED_ENGINES].sort(), ['mariadb', 'mysql', 'postgres', 'redis', 'sqlite']);
  const services = [{ container: 'pg', engine: 'postgres' }, { container: 'my', engine: 'mysql' }, { container: 'maria', engine: 'mariadb' }, { container: 'cache', engine: 'redis' }, { container: 'web', engine: 'generic', sqliteFiles: ['/data/app.sqlite'] }, { container: 'other', engine: 'auto' }];
  const lines = unfold(checkCommands({ app: { ...compose, services } })).split('\n');
  syntax(lines.join('\n'));
  for (const expected of ['docker exec pg pg_isready', 'docker exec my mysqladmin ping', 'docker exec maria mariadb-admin ping', 'docker exec cache redis-cli ping']) assert.ok(lines.includes(expected), expected);
  assert.ok(lines.some(line => line.startsWith('docker cp web:/data/app.sqlite /root/docknest-restore/shop--abc/check-app.sqlite && python3 -c')));
  assert.ok(lines.includes("curl --fail --silent --show-error --output /dev/null --write-out '%{http_code}\\n' https://shop.example.com/"));
  assert.ok(!lines.some(line => line.includes('other')), 'no check is guessed for an engine DockNest did not choose');
  assert.deepEqual(checkCommands({ app: { kind: 'container', containers: ['solo'], services: [], domains: [] } }), "docker ps --filter 'name=^solo$'");
  const sqlite = args(unfold(checkCommands({ app: { kind: 'container', folder: 'f', containers: [], services: [{ container: 'w', engine: 'generic', sqliteFiles: ['/d/x.db'] }], domains: [] } })).replace(' && ', '\n'), ['docker', 'python3']);
  assert.deepEqual(sqlite.slice(0, 3), ['cp', 'w:/d/x.db', '/root/docknest-restore/f/check-x.db']);
});
