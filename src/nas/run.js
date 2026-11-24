import { helperCommand, identityFor, CommandRefused } from './command.js';

// Chooses how one helper call runs on one server. A server with no NAS facts (every existing install) gets the exact
// command DockNest has always sent. A NAS server may use sudo and the helper runtime container.
// options.runtimeMounts: host folders the call needs inside the runtime container (container runtime only).
export function prepareHelper(server, request, options = {}) {
  const { identity, runtime, nasKind } = identityFor(server);
  const operation = typeof request?.operation === 'string' && /^[a-z][a-z0-9-]{0,48}$/.test(request.operation) ? request.operation : null;
  if (runtime === 'container' && !Array.isArray(options.runtimeMounts)) throw new CommandRefused('This call did not say which folders the helper runtime needs.');
  // Only src/nas/runtime-prepare.js sets runtimeImageId (an ID the server reported for the pinned layers); helperArgv then
  // accepts it only if it is one of the build's pinned IDs. allowedIds exists for tests; no caller in src passes it.
  const imageId = typeof options.runtimeImageId === 'string' ? options.runtimeImageId : undefined;
  const command = helperCommand({ identity, runtime, operation, mounts: options.runtimeMounts ?? [], nasKind, ...(imageId ? { imageId } : {}), ...(Array.isArray(options.allowedIds) ? { allowedIds: options.allowedIds } : {}) });
  return { command, identity, runtime, operation };
}

let sink = null;
// Tests and the app can replace where sudo audit entries go. Entries hold the operation name, the server id and the
// result, never arguments or output.
export const setSudoAuditSink = fn => { sink = fn; };
export async function auditSudo(server, prepared, result) {
  if (prepared.identity !== 'sudo') return;
  const entry = { operation: prepared.operation ?? 'unknown', runtime: prepared.runtime, result: result === 'ok' ? 'ok' : 'failed' };
  try {
    if (sink) return await sink(server?.id ?? null, entry);
    const { audit } = await import('../db.js');
    audit('system', 'nas.sudo-run', server?.id ?? null, entry);
  } catch { /* An audit failure never changes the helper's result. */ }
}
