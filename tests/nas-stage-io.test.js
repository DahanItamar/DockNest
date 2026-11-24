import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Duplex, PassThrough, Readable, Writable } from 'node:stream';
import { helperDownload, helperUpload } from '../src/nas/stage-io.js';
import { setSudoAuditSink } from '../src/nas/run.js';

// A fake SSH connection that plays the helper's side of the stage-read and stage-write protocol (remote/helper/stage_io.py).
const sudoServer = { id: 's1', username: 'admin', capabilities: JSON.stringify({ nas: { kind: 'truenas' }, helperRuntime: 'host', stagingBase: '/mnt/tank/.docknest' }) };
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const deps = client => ({ connect: async () => client, withRuntime: async (_server, _request, options) => options });
// A channel is a Duplex whose readable side is the server's stdout and whose writable side is the helper's stdin.
const channel = (onFinal, onWrite) => {
  const stream = new Duplex({ autoDestroy: false, emitClose: false, read() {}, write(chunk, _e, done) { onWrite?.(String(chunk)); done(); }, final(done) { onFinal(); done(); } });
  stream.stderr = new PassThrough(); stream.destroy = () => {};
  return stream;
};

function readClient({ content, lie = {}, code = 0, error = null }) {
  const commands = [], requests = [];
  return { commands, requests, end() {}, exec(command, _options, callback) {
    commands.push(command);
    let text = '';
    const stream = channel(() => {
      requests.push(JSON.parse(text.split('\n')[1]));
      setImmediate(() => {
        if (error) { stream.stderr.write(JSON.stringify({ error }) + '\n'); return stream.emit('close', 1); }
        stream.stderr.write(JSON.stringify({ total: lie.total ?? content.length }) + '\n');
        for (let at = 0; at < content.length; at += 7) stream.push(content.subarray(at, at + 7));
        stream.stderr.write(JSON.stringify({ result: { size: lie.size ?? content.length, sha256: lie.sha256 ?? sha(content) } }) + '\n');
        setImmediate(() => stream.emit('close', code));
      });
    }, chunk => { text += chunk; });
    callback(null, stream);
  } };
}
const sink = () => { const chunks = []; const output = new Writable({ write(chunk, _e, done) { chunks.push(Buffer.from(chunk)); done(); } }); return { output, text: () => Buffer.concat(chunks) }; };

test('download: the package streams through the helper under a fixed sudo argv and arrives with its size and SHA-256', async () => {
  const audits = []; setSudoAuditSink((id, entry) => audits.push([id, entry]));
  const content = randomBytes(1000), client = readClient({ content }), progress = [], target = sink();
  await helperDownload(sudoServer, '/var/lib/docknest/job/payload.tar.gz', target.output, update => progress.push(update), deps(client));
  setSudoAuditSink(null);
  assert.deepEqual(target.text(), content);
  assert.ok(client.commands[0].startsWith("'sudo' '-n' '--' 'python3' '-c' '") && !client.commands[0].includes('sh -c'), 'one fixed argv under sudo -n');
  assert.deepEqual(client.requests[0], { operation: 'stage-read', path: '/var/lib/docknest/job/payload.tar.gz', stagingBase: '/mnt/tank/.docknest' });
  assert.equal(progress.at(-1).done, 1000); assert.equal(progress.at(-1).total, 1000); assert.equal(progress.at(-1).final, true);
  assert.deepEqual(audits, [['s1', { operation: 'stage-read', runtime: 'host', result: 'ok' }]], 'audited by operation name only, never the path');
});

test('download fails closed on a wrong size, a wrong checksum, a helper error and a failed helper', async () => {
  const content = randomBytes(300);
  for (const [name, options, expected] of [['size', { lie: { size: 299 } }, /did not arrive intact/], ['hash', { lie: { sha256: sha(Buffer.from('other')) } }, /did not arrive intact/], ['total', { lie: { total: 5 } }, /did not arrive intact/],
    ['error', { error: 'The package is outside the DockNest staging folders' }, /outside the DockNest staging folders/], ['exit', { code: 1 }, /did not arrive intact/]]) {
    await assert.rejects(helperDownload(sudoServer, '/var/lib/docknest/x', sink().output, null, deps(readClient({ content, ...options }))), expected, name);
  }
});

function writeClient({ lie = {}, code = 0, error = null } = {}) {
  const state = { commands: [], lines: [], requests: [] };
  return { state, end() {}, exec(command, _options, callback) {
    state.commands.push(command);
    let text = '';
    const stream = channel(() => setImmediate(() => {
      const lines = text.split('\n'); state.requests.push(JSON.parse(lines[1])); state.lines = lines.slice(2).filter(Boolean);
      if (error) { stream.push(JSON.stringify({ error }) + '\n'); return stream.emit('close', 1); }
      const data = Buffer.concat(state.lines.filter(line => line.startsWith('D ')).map(line => Buffer.from(line.slice(2), 'base64')));
      const [, size, hash] = state.lines.at(-1).split(' ');
      const ok = Number(size) === data.length && hash === sha(data);
      stream.push(JSON.stringify(ok ? { result: { size: lie.size ?? data.length, sha256: lie.sha256 ?? sha(data) } } : { error: 'The package did not arrive intact' }) + '\n');
      stream.emit('close', ok ? code : 1);
    }), chunk => { text += chunk; });
    callback(null, stream);
  } };
}
test('upload: chunks go to the helper as base64 lines with an end marker, and the helper confirms size and checksum', async () => {
  const content = randomBytes(5000), client = writeClient();
  const result = await helperUpload(sudoServer, Readable.from([content.subarray(0, 2000), content.subarray(2000)]), '/var/lib/docker-backup-manager/restore/job/payload.tar.gz', deps(client));
  assert.deepEqual(result, { size: 5000, sha256: sha(content) });
  assert.ok(client.state.commands[0].startsWith("'sudo' '-n' '--'"));
  assert.deepEqual(client.state.requests[0], { operation: 'stage-write', path: '/var/lib/docker-backup-manager/restore/job/payload.tar.gz', stagingBase: '/mnt/tank/.docknest' });
  assert.ok(client.state.lines.slice(0, -1).every(line => /^D [A-Za-z0-9+/=]+$/.test(line)));
  assert.equal(client.state.lines.at(-1), `END 5000 ${sha(content)}`);
  assert.ok(!JSON.stringify(client.state.requests).includes(content.toString('base64').slice(0, 20)), 'package bytes never enter the request');
});

test('upload fails closed when the helper reports an error, a different size or a failed run', async () => {
  const bytes = () => Readable.from([randomBytes(100)]);
  await assert.rejects(helperUpload(sudoServer, bytes(), '/var/lib/docknest/x', deps(writeClient({ error: 'The package is outside the DockNest staging folders' }))), /outside the DockNest staging folders/);
  await assert.rejects(helperUpload(sudoServer, bytes(), '/var/lib/docknest/x', deps(writeClient({ code: 1 }))), /could not be stored|did not arrive/);
  const broken = new Readable({ read() { this.destroy(new Error('source failed')); } });
  await assert.rejects(helperUpload(sudoServer, broken, '/var/lib/docknest/x', deps(writeClient())), /source failed/);
});

test('a root server never uses the helper stream: the SFTP code is selected for it', async () => {
  const { identityFor } = await import('../src/nas/command.js');
  for (const server of [{ username: 'root', capabilities: null }, { username: 'root', capabilities: '{"nas":{"kind":"unraid"}}' }, { username: 'deploy', capabilities: '{"uid":1000}' }])
    assert.equal(identityFor(server).identity, 'root', JSON.stringify(server));
  assert.equal(identityFor(sudoServer).identity, 'sudo');
});
