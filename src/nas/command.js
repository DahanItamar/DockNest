import { HELPER_RUNTIME_IMAGE_ID, HELPER_RUNTIME_LABEL, HOST_NETWORK_OPERATIONS, isPinnedImageId, pinnedRuntimeIds } from '../../shared/helper-runtime.js';
import { computeMounts, mountArguments } from './mounts.js';

// The helper loader reads the trusted helper source from the first stdin line, then the JSON request. Request values
// never enter a command line.
export const LOADER = "import base64,sys;exec(compile(base64.b64decode(sys.stdin.readline()),'<docknest-helper>','exec'))";
// Byte-for-byte the command DockNest has always sent, for servers that keep the host runtime and root identity.
export const LEGACY_HOST_COMMAND = 'python3 -c "import base64,sys;exec(compile(base64.b64decode(sys.stdin.readline()),\'<docknest-helper>\',\'exec\'))"';
export class CommandRefused extends Error { constructor(message) { super(message); this.name = 'CommandRefused'; } }

export function quote(argument) {
  if (typeof argument !== 'string' || /[\0\r\n]/.test(argument)) throw new CommandRefused('A command argument is not valid.');
  return "'" + argument.replaceAll("'", "'\\''") + "'";
}
// ssh2 takes one string, so each argv element is single-quoted. The argv is a fixed shape plus validated paths.
export const argvToCommand = argv => argv.map(quote).join(' ');

// The one fixed sudo form: no -S, no -i, no -s, no -E, no -u. "--" ends sudo's own options.
export const sudoPrefix = () => ['sudo', '-n', '--'];

// identity: 'root' | 'sudo'. runtime: 'host' | 'container'.
export function helperArgv({ identity = 'root', runtime = 'host', operation = null, mounts = [], nasKind = null, imageId = HELPER_RUNTIME_IMAGE_ID, allowedIds = pinnedRuntimeIds() } = {}) {
  if (identity !== 'root' && identity !== 'sudo') throw new CommandRefused('Unknown SSH identity.');
  if (runtime !== 'host' && runtime !== 'container') throw new CommandRefused('Unknown helper runtime.');
  const lead = identity === 'sudo' ? sudoPrefix() : [];
  if (runtime === 'host') return [...lead, 'python3', '-c', LOADER];
  if (!isPinnedImageId(imageId) || !allowedIds.includes(imageId)) throw new CommandRefused('The helper runtime image is not pinned in this DockNest build.');
  const network = HOST_NETWORK_OPERATIONS.includes(operation) ? 'host' : 'none';
  const folders = computeMounts(mounts, { nasKind });
  return [...lead, 'docker', 'run', '--rm', '-i', '--pull', 'never', '--network', network, '--pid', 'host', '--security-opt', 'label=disable',
    '--label', HELPER_RUNTIME_LABEL, '-v', '/var/run/docker.sock:/var/run/docker.sock', ...mountArguments(folders), imageId, 'python3', '-c', LOADER];
}
export function helperCommand(options) {
  const { identity = 'root', runtime = 'host' } = options || {};
  if (identity === 'root' && runtime === 'host') return LEGACY_HOST_COMMAND;
  return argvToCommand(helperArgv(options));
}

export function parseCapabilities(server) {
  const value = server?.capabilities;
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || 'null'); } catch { return null; }
}
// What a stored server needs. Sudo and the container runtime are only ever used on a server detected as a NAS; a
// non-root user on any other server keeps today's behaviour (the helper itself refuses without root).
// A saved Synology or Unraid server stops counting as a NAS while its support is off (src/nas/gate.js), so it goes
// back to the normal root identity. The process binds the gate once; it reads the setting live on every call and the
// default is off. `enabled` overrides it, for example { synology: true }.
let gateOn = () => false;
export const bindNasGate = read => { gateOn = read; };
export function identityFor(server, enabled = null) {
  const facts = parseCapabilities(server);
  const kind = facts?.nas?.kind ?? null;
  const on = kind === 'synology' || kind === 'unraid' ? (enabled ? Boolean(enabled[kind]) : gateOn(kind)) : true;
  const nasKind = on ? kind : null;
  const root = String(server?.username ?? '') === 'root';
  if (!nasKind) return { identity: 'root', runtime: 'host', nasKind: null };
  return { identity: root ? 'root' : 'sudo', runtime: facts.helperRuntime === 'container' ? 'container' : 'host', nasKind };
}
