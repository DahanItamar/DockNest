import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { connect as sshConnect, withRuntime as sshWithRuntime } from '../ssh.js';
import { helperSource } from '../helper-bundle.js';
import { parseCapabilities } from './command.js';
import { prepareHelper, auditSudo } from './run.js';

// Moving one staged package for a server whose SSH user is not root (a NAS with passwordless sudo). The staging folders are
// root-only (0700) and stay that way: DockNest does not chown them or add ACLs, and SFTP runs as the SSH user. The helper, run
// under `sudo -n` with its fixed argv, streams the package instead (remote/helper/stage_io.py): stage-read writes it to stdout,
// stage-write reads it from stdin. Both ends count the bytes and compare a SHA-256, and the helper confines every path to
// DockNest's own staging folders. Servers with a root SSH user never come here.
// `deps` lets tests stand in for the SSH connection; the app never passes it.
const real = { connect: sshConnect, withRuntime: sshWithRuntime };
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const stagingBaseOf = server => { const base = parseCapabilities(server)?.stagingBase; return typeof base === 'string' && base.startsWith('/') ? base : undefined; };
const requestFor = (server, operation, path) => ({ operation, path, ...(stagingBaseOf(server) ? { stagingBase: stagingBaseOf(server) } : {}) });
const hasher = () => { const hash = createHash('sha256'); let size = 0; return { update(chunk) { hash.update(chunk); size += chunk.length; }, get size() { return size; }, hex: () => hash.digest('hex') }; };

function parseEvents(onEvent) {
  let buffer = '';
  return chunk => {
    buffer += chunk.toString();
    if (buffer.length > MAX_EVENT_BYTES) throw new Error('Remote control output exceeds limit');
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); try { onEvent(JSON.parse(line)); } catch { /* not an event */ } }
  };
}
const refusal = (message, extra = {}) => Object.assign(new Error(message), extra);

// Package at `remotePath` on the server -> `output`. onProgress({ done, total }) as the bytes arrive.
export async function helperDownload(server, remotePath, output, onProgress = null, deps = real) {
  const request = requestFor(server, 'stage-read', remotePath), options = await deps.withRuntime(server, request, {}), prepared = prepareHelper(server, request, options);
  const client = await deps.connect(server).catch(error => { void auditSudo(server, prepared, 'failed'); throw error; });
  try {
    return await new Promise((resolve, reject) => client.exec(prepared.command, { pty: false }, (error, stream) => {
      if (error) { void auditSudo(server, prepared, 'failed'); return reject(error); }
      let total = null, result, remoteError, failure; const counted = hasher();
      const fail = cause => { failure ??= cause; stream.destroy(); reject(cause); };
      const feed = parseEvents(event => { if (Number.isSafeInteger(event.total)) { total = event.total; onProgress?.({ done: counted.size, total }); } if (event.result) result = event.result; if (event.error) remoteError = event.error; });
      stream.stderr.on('data', chunk => { try { feed(chunk); } catch (cause) { fail(cause); } });
      stream.on('data', chunk => {
        counted.update(chunk);
        if (!output.write(chunk)) { stream.pause(); output.once('drain', () => stream.resume()); }
        onProgress?.({ done: counted.size, total });
      });
      output.once('error', cause => fail(refusal('The backup could not be stored.', { cause })));
      stream.once('error', cause => fail(cause));
      stream.once('close', code => {
        void auditSudo(server, prepared, !failure && code === 0 && result ? 'ok' : 'failed');
        if (failure) return;
        const good = code === 0 && result && result.size === counted.size && result.sha256 === counted.hex() && (total === null || total === counted.size);
        if (!good) return reject(refusal(remoteError || 'The package did not arrive intact; inspect recovery status before retrying', { remoteReported: Boolean(remoteError), exitCode: Number.isInteger(code) ? code : null }));
        onProgress?.({ done: counted.size, total, final: true });
        output.end(); resolve();
      });
      stream.end(helperSource().toString('base64') + '\n' + JSON.stringify(request) + '\n');
    }));
  } finally { client.end(); }
}

// `input` (a readable of Buffers) -> the package at `remotePath` on the server.
export async function helperUpload(server, input, remotePath, deps = real) {
  const request = requestFor(server, 'stage-write', remotePath), options = await deps.withRuntime(server, request, {}), prepared = prepareHelper(server, request, options);
  const client = await deps.connect(server).catch(error => { void auditSudo(server, prepared, 'failed'); throw error; });
  try {
    return await new Promise((resolve, reject) => client.exec(prepared.command, { pty: false }, (error, stream) => {
      if (error) { void auditSudo(server, prepared, 'failed'); return reject(error); }
      let result, remoteError, failure;
      const fail = cause => { failure ??= cause; stream.destroy(); reject(cause); };
      const feed = parseEvents(event => { if (event.result) result = event.result; if (event.error) remoteError = event.error; });
      stream.on('data', chunk => { try { feed(chunk); } catch (cause) { fail(cause); } });
      stream.stderr.on('data', () => {}); // never kept: it can hold secrets
      stream.once('error', fail);
      stream.once('close', code => {
        void auditSudo(server, prepared, !failure && code === 0 && result ? 'ok' : 'failed');
        if (failure) return;
        if (code === 0 && result) return resolve(result);
        reject(refusal(remoteError || 'The package could not be stored on the server; inspect recovery status before retrying', { remoteReported: Boolean(remoteError), exitCode: Number.isInteger(code) ? code : null }));
      });
      (async () => {
        const counted = hasher();
        stream.write(helperSource().toString('base64') + '\n' + JSON.stringify(request) + '\n');
        for await (const chunk of input) {
          counted.update(chunk);
          if (!stream.write('D ' + Buffer.from(chunk).toString('base64') + '\n')) await new Promise(done => stream.once('drain', done));
        }
        stream.end(`END ${counted.size} ${counted.hex()}\n`);
      })().catch(fail);
    }));
  } finally { client.end(); }
}
export const helperUploadFile = (server, localPath, remotePath) => helperUpload(server, createReadStream(localPath), remotePath);
