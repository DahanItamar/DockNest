import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const python = process.platform === 'win32' ? 'python' : 'python3';

test('host updater broker: request parsing, allow-lists, path handling and state machine (Python unittest)', () => {
 const result = spawnSync(python, ['-I', 'updater/test_broker.py'], { encoding: 'utf8' });
 if (result.error?.code === 'ENOENT') throw new Error('Python3 is required for host updater verification');
 assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('compose mounts the docknest_updater volume read-only, without copy, into api only (D1)', () => {
 const compose = read('compose.yaml'), services = compose.slice(compose.indexOf('\nservices:'), compose.indexOf('\nsecrets:'));
 const block = name => { const rest = services.slice(services.indexOf(`\n  ${name}:\n`) + 1), end = rest.search(/\n  [a-z]+:\n/); return end < 0 ? rest : rest.slice(0, end + 1); };
 assert.match(block('api'), /- state:\/data\n/, 'api keeps its state volume when it overrides the shared list');
 assert.match(block('api'), /- \{type: volume, source: updater, target: \/run\/docknest-updater, read_only: true, volume: \{nocopy: true\}\}/);
 for (const name of ['worker', 'proxy']) assert.doesNotMatch(block(name), /updater/, name);
 assert.equal(compose.match(/source: updater/g).length, 1);
 assert.match(compose, /\n  updater:\n    name: docknest_updater\n/, 'explicit volume name, not a host bind mount');
 assert.doesNotMatch(compose, /docknest-updater[^\n]*:\/run|\/var\/lib\/docker/, 'no host path in compose.yaml');
});

test('systemd units carry the threat model hardening and limits', () => {
 const socketUnit = read('updater/docknest-updater.socket.in'), service = read('updater/docknest-updater.service.in'), tmpfiles = read('updater/docknest-updater.tmpfiles.in');
 for (const line of ['ListenStream=@VOLUME@/updater.sock', 'SocketUser=root', 'SocketGroup=@API_GID@', 'SocketMode=0660', 'Accept=no', 'Backlog=8',
  'TriggerLimitIntervalSec=60', 'TriggerLimitBurst=10', 'ConditionPathIsDirectory=@VOLUME@', 'RequiresMountsFor=@DOCKER_ROOT@']) assert.match(socketUnit, new RegExp(`^${line}$`, 'm'), line);
 for (const line of ['CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_KILL CAP_DAC_READ_SEARCH', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=read-only',
  'PrivateTmp=yes', 'PrivateDevices=yes', 'ProtectKernelTunables=yes', 'ProtectKernelModules=yes', 'ProtectKernelLogs=yes', 'ProtectControlGroups=yes', 'ProtectClock=yes',
  'ProtectHostname=yes', 'RestrictNamespaces=yes', 'RestrictSUIDSGID=yes', 'LockPersonality=yes', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
  'SystemCallFilter=@system-service', 'UMask=0077', 'Restart=no', 'KillMode=mixed', 'TimeoutStopSec=15min', 'StartLimitBurst=5', 'StartLimitIntervalSec=600'])
  assert.match(service, new RegExp(`^${line}$`, 'm'), line);
 assert.match(service, /^ReadWritePaths=@CHECKOUT@ \/run\/docknest-updater-work -@VOLUME@\/status \/var\/lib\/docknest-updater -@OWNER_HOME@\/\.docker$/m);
 assert.doesNotMatch(service, /^RuntimeMaxSec/m, 'the per-run limit lives in the broker (AR2-N3)');
 assert.match(tmpfiles, /^d \/run\/docknest-updater-work 0750 @OWNER@ @GROUP@ -$/m);
});

test('installer pins cosign to the release workflow version and refuses unsupported hosts', () => {
 const installer = read('scripts/install-updater.sh'), workflow = read('.github/workflows/release.yml'), broker = read('updater/broker.py');
 const pinned = installer.match(/^COSIGN_VERSION=(v\d+\.\d+\.\d+)$/m)?.[1];
 assert.equal(pinned, workflow.match(/cosign-release: '(v[\d.]+)'/)?.[1], 'installer and release.yml use one cosign (F6)');
 assert.equal(pinned, broker.match(/^COSIGN_VERSION = '(v[\d.]+)'$/m)?.[1]);
 assert.match(installer, /^COSIGN_SHA256_AMD64=[a-f0-9]{64}$/m); assert.match(installer, /^COSIGN_SHA256_ARM64=[a-f0-9]{64}$/m);
 for (const option of ['--repair', '--ack', '--status', '--uninstall']) assert.match(installer, new RegExp(`\\n  ${option}\\)| ${option}\\) MODE=`), option);
 for (const refusal of ['name=rootless', 'name=userns', 'Docker Desktop', 'already installed', 'util-linux 2.35', 'not in the docker group', 'deployment hold is still on'])
  assert.ok(installer.includes(refusal), refusal);
 assert.doesNotMatch(installer, /usermod|gpasswd|adduser [^\n]*docker|chown -R|chmod -R/, 'never adds group members or changes checkout ownership');
 assert.doesNotMatch(installer, /setpriv[^\n]*--bounding-set/);
 assert.doesNotMatch(installer, /node scripts\/deployment-preflight\.js check/, '--ack reads the hold on its own, not the queue check');
 const syntax = spawnSync('sh', ['-n', 'scripts/install-updater.sh'], { encoding: 'utf8' });
 if (syntax.error?.code !== 'ENOENT') assert.equal(syntax.status, 0, syntax.stderr);
});
