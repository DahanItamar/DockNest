import { identityFor, CommandRefused } from './command.js';
import { gateInfo } from './gate.js';
import { capabilityFacts, SUDO_FIX, withoutNasFacts } from './readiness.js';

// Connecting a server (POST /api/servers/connect). `inspect(server)` is the read-only NAS check and `test(server)` the
// helper's connection test. A root account keeps today's rules. A non-root account is accepted ONLY on a server that
// is detected as a NAS, whose readiness check is green and whose passwordless sudo worked; everything else is refused
// before the helper runs anything as root.
export class ConnectRefused extends Error { constructor(message, fix = null) { super(message); this.name = 'ConnectRefused'; this.status = 409; this.fix = fix; } }
export const NOT_ROOT_MESSAGE = 'SSH connected, but this backup engine requires a root SSH account to preserve volume ownership. Run the setup command as root and connect using root.';
const NOT_NAS_MESSAGE = 'SSH connected as a user that is not root. A non-root account is only supported on a TrueNAS system with passwordless sudo. ' + 'Run the setup command as root and connect using root.';

const refusal = result => {
  const failed = result?.checks?.find(check => check.status === 'fail');
  // The message already ends with the fix for some checks (TrueNAS before 24.10): say it once.
  const text = failed ? (failed.fix && !String(failed.message).includes(failed.fix) ? `${failed.message} ${failed.fix}` : failed.message) : 'This NAS is not ready.';
  return new ConnectRefused(text, failed?.fix ?? SUDO_FIX);
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
    if (!readiness?.nas) throw new ConnectRefused(readiness?.gatedOff ? `${NOT_NAS_MESSAGE} ${gateInfo(readiness.gatedOff)}` : NOT_NAS_MESSAGE);
    if (readiness.identity !== 'sudo' || !readiness.ready) throw refusal(readiness);
  }
  if (readiness?.nas && readiness.ready) facts = readiness.facts ?? capabilityFacts(readiness);
  // The helper test runs with the identity the facts select (sudo, and the runtime), exactly as later calls will.
  const probe = { ...server, capabilities: JSON.stringify(facts) };
  if (!root && identityFor(probe).identity !== 'sudo') throw new ConnectRefused(NOT_NAS_MESSAGE);
  let capabilities;
  try { capabilities = await test(probe); } catch (error) {
    if (error instanceof CommandRefused) throw new ConnectRefused('This NAS needs the DockNest helper runtime image, which this DockNest build does not include.', 'Update DockNest to a release that includes the helper runtime, or install Python 3.9 or newer on the NAS.');
    throw error;
  }
  // The helper reports its effective uid: under sudo it is 0, so a user whose sudo does not reach root is refused.
  if (capabilities?.uid !== 0) throw new ConnectRefused(NOT_ROOT_MESSAGE);
  return { ...withoutNasFacts(capabilities), ...facts };
}
