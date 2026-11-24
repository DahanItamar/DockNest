import { identityFor } from './command.js';
import { capabilityFacts, SUDO_FIX, withoutNasFacts } from './readiness.js';

// Connecting a server (POST /api/servers/connect). `inspect(server)` is the read-only NAS check and `test(server)` the
// helper's connection test. A root account keeps today's rules. A non-root account is accepted ONLY on a server that
// is detected as a NAS, whose readiness check is green and whose passwordless sudo worked; everything else is refused
// before the helper runs anything as root.
export class ConnectRefused extends Error { constructor(message, fix = null) { super(message); this.name = 'ConnectRefused'; this.status = 409; this.fix = fix; } }
export const NOT_ROOT_MESSAGE = 'SSH connected, but this backup engine requires a root SSH account to preserve volume ownership. Run the setup command as root and connect using root.';
const NOT_NAS_MESSAGE = 'SSH connected as a user that is not root. A non-root account is only supported on a Unraid, Synology or TrueNAS system with passwordless sudo. ' + 'Run the setup command as root and connect using root.';

const refusal = result => {
  const failed = result?.checks?.find(check => check.status === 'fail');
  return new ConnectRefused(failed ? `${failed.message} ${failed.fix ?? ''}`.trim() : 'This NAS is not ready.', failed?.fix ?? SUDO_FIX);
};

export async function connectCapabilities(server, { inspect, test }) {
  const root = String(server.username) === 'root';
  let facts = {};
  let readiness = null;
  try {
    readiness = await inspect(server);
  } catch (error) {
    if (!root) throw error; // Cannot prove a NAS with passwordless sudo: no root command runs.
  }
  if (!root) {
    if (!readiness?.nas) throw new ConnectRefused(NOT_NAS_MESSAGE);
    if (readiness.identity !== 'sudo' || !readiness.ready) throw refusal(readiness);
  }
  if (readiness?.nas && readiness.ready) facts = readiness.facts ?? capabilityFacts(readiness);
  // The helper test runs with the identity the facts select (sudo, and the runtime), exactly as later calls will.
  const probe = { ...server, capabilities: JSON.stringify(facts) };
  if (!root && identityFor(probe).identity !== 'sudo') throw new ConnectRefused(NOT_NAS_MESSAGE);
  const capabilities = await test(probe);
  // The helper reports its effective uid: under sudo it is 0, so a user whose sudo does not reach root is refused.
  if (capabilities?.uid !== 0) throw new ConnectRefused(NOT_ROOT_MESSAGE);
  return { ...withoutNasFacts(capabilities), ...facts };
}
