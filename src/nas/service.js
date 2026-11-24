import { connect } from '../ssh.js';
import { argvToCommand } from './command.js';
import { capabilityFacts, checkNas } from './readiness.js';
import { db } from '../db.js';
import { synologyEnabled } from './synology-gate.js';
import { bindSynologyGate } from './command.js';
bindSynologyGate(() => synologyEnabled(db));

// Runs one fixed argv on an open SSH connection. The command is every element single-quoted; the output is capped and
// a stuck command is abandoned. stderr is dropped (it can hold secrets) and no stdin is sent.
export function sshRunner(client, { timeoutMs = 15000, maxBytes = 1024 * 1024 } = {}) {
  return argv => new Promise((resolve, reject) => {
    client.exec(argvToCommand(argv), { pty: false }, (error, stream) => {
      if (error) return reject(error);
      let stdout = '', done = false;
      const finish = result => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
      const timer = setTimeout(() => { try { stream.close(); } catch { /* already closed */ } finish({ code: 124, stdout: '' }); }, timeoutMs);
      stream.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > maxBytes) { stdout = ''; try { stream.close(); } catch { /* already closed */ } finish({ code: 125, stdout: '' }); } });
      stream.stderr.on('data', () => {});
      stream.once('error', reject);
      stream.once('close', code => finish({ code: Number.isInteger(code) ? code : 1, stdout }));
      stream.end();
    });
  });
}

// Read-only NAS check for a stored server: NAS facts, identity, helper runtime, staging and key persistence.
export async function inspectNas(server, { synology = synologyEnabled(db) } = {}) {
  const client = await connect(server);
  try {
    const result = await checkNas({ run: sshRunner(client), username: String(server.username), synology });
    return { ...result, facts: capabilityFacts(result) };
  } finally { client.end(); }
}
