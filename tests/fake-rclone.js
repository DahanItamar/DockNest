// A stand-in for the rclone binary, for tests only: no network, no accounts. It keeps "remote" files in ./store next to this
// script, logs every call to ./calls.jsonl and follows ./control.json:
//   { fail: [{ cmd, stderr, code, times }], refresh: true, about: {total,free,used}, duplicates: ["name"], authLocation }
// Real rclone behaviours it imitates: exit 3/4 for a missing path, `moveto` overwrites, `lsjson --stat`, `cat --offset/--count`,
// `obscure -` from stdin, `authorize` listening on 127.0.0.1:53682 and printing the token block.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), store = path.join(here, 'store');
const control = () => { try { return JSON.parse(fs.readFileSync(path.join(here, 'control.json'), 'utf8')); } catch { return {}; } };
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--config', '--tpslimit', '--retries', '--low-level-retries', '--timeout', '--contimeout', '--log-level', '--stats', '--offset', '--count']);
const flags = {}, positional = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (VALUE_FLAGS.has(arg)) flags[arg] = argv[++i];
  else if (arg.startsWith('--')) flags[arg] = true;
  else positional.push(arg);
}
const command = positional[0] === 'config' || positional[0] === 'backend' ? positional.slice(0, 2).join(' ') : positional[0];
const conf = {};
if (flags['--config']) {
  try { for (const line of fs.readFileSync(flags['--config'], 'utf8').split('\n')) { const match = /^(\w+) = (.*)$/.exec(line); if (match) conf[match[1]] = match[2]; } } catch { /* none */ }
}
let mode = null; try { mode = fs.statSync(flags['--config']).mode & 0o777; } catch { /* none */ }
fs.appendFileSync(path.join(here, 'calls.jsonl'), JSON.stringify({ command, args: argv.filter(arg => arg !== flags['--config']), confKeys: Object.keys(conf), confType: conf.type ?? null, confRoot: conf.root_folder_id ?? null, confMode: mode, env: Object.keys(process.env).filter(key => key.startsWith('RCLONE')), envValues: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('RCLONE'))), home: process.env.HOME, cwdConf: flags['--config'] ?? null }) + '\n');

const fail = (stderr, code = 1) => { process.stderr.write(stderr + '\n'); process.exit(code); };
const remoteFile = spec => {
  const match = /^dn:(.*)$/.exec(spec ?? '');
  if (!match) fail('Failed to create file system for "' + spec + '"', 1);
  const target = path.join(store, ...match[1].split('/').filter(Boolean));
  if (!target.startsWith(store)) fail('path escapes', 1);
  return target;
};
const info = (file, base) => { const attrs = fs.statSync(file); return { Path: path.relative(base, file).split(path.sep).join('/'), Name: path.basename(file), Size: attrs.isDirectory() ? -1 : attrs.size, MimeType: 'application/octet-stream', ModTime: attrs.mtime.toISOString(), IsDir: attrs.isDirectory(), Hashes: flags['--hash'] && !attrs.isDirectory() ? { md5: createHash('md5').update(fs.readFileSync(file)).digest('hex') } : undefined }; };
const refresh = () => {
  if (!control().refresh || !flags['--config']) return;
  const text = fs.readFileSync(flags['--config'], 'utf8'), match = /^token = (\{.*\})$/m.exec(text);
  if (!match) return;
  const token = JSON.parse(match[1]);
  token.access_token = 'refreshed-access-' + randomBytes(4).toString('hex');
  fs.writeFileSync(flags['--config'], text.replace(match[0], 'token = ' + JSON.stringify(token)));
};
const readStdin = () => new Promise(resolveRead => { const chunks = []; process.stdin.on('data', chunk => chunks.push(chunk)); process.stdin.on('end', () => resolveRead(Buffer.concat(chunks))); });

if (command !== 'version' && command !== 'obscure' && command !== 'authorize') refresh();
if (control().delayMs && command !== 'version') await new Promise(resolveDelay => setTimeout(resolveDelay, control().delayMs));
const injected = control().fail?.find(item => item.cmd === command && (item.times === undefined || item.times > 0));
if (injected) {
  if (injected.times !== undefined) { const next = control(); next.fail.find(item => item.cmd === command && item.times !== undefined).times--; fs.writeFileSync(path.join(here, 'control.json'), JSON.stringify(next)); }
  fail(injected.stderr, injected.code ?? 1);
}
switch (command) {
  case 'version': process.stdout.write(`rclone ${control().version ?? 'v1.70.3'}\n- os/version: fake\n`); break;
  case 'obscure': process.stdout.write('OBS' + Buffer.from((await readStdin()).toString()).toString('base64url') + '\n'); break;
  case 'lsjson': {
    const target = remoteFile(positional[1]);
    if (flags['--stat']) { if (!fs.existsSync(target)) fail('error: object not found', 3); process.stdout.write(JSON.stringify(info(target, path.dirname(target)))); break; }
    if (!fs.existsSync(target)) fail('error listing: directory not found', 3);
    const out = [];
    const walk = dir => { for (const name of fs.readdirSync(dir).sort()) { const file = path.join(dir, name), item = info(file, target); if (item.IsDir) { if (!flags['--files-only']) out.push(item); if (flags['--recursive']) walk(file); } else { out.push(item); for (const dup of control().duplicates ?? []) if (dup === name) out.push(item); } } };
    walk(target);
    process.stdout.write(JSON.stringify(out));
    break;
  }
  case 'cat': {
    const target = remoteFile(positional[1]);
    if (!fs.existsSync(target)) fail('error: object not found', 3);
    const data = fs.readFileSync(target), start = Number(flags['--offset'] ?? 0), count = flags['--count'] === undefined ? data.length : Number(flags['--count']);
    process.stdout.write(data.subarray(start, start + count));
    break;
  }
  case 'rcat': {
    const target = remoteFile(positional[1]), data = await readStdin();
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data);
    break;
  }
  case 'moveto': { const from = remoteFile(positional[1]), to = remoteFile(positional[2]); if (!fs.existsSync(from)) fail('error: object not found', 4); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); break; }
  case 'deletefile': { const target = remoteFile(positional[1]); if (!fs.existsSync(target)) fail('error: object not found', 4); fs.unlinkSync(target); break; }
  case 'mkdir': fs.mkdirSync(remoteFile(positional[1]), { recursive: true }); break;
  case 'rmdir': { const target = remoteFile(positional[1]); if (!fs.existsSync(target)) fail('error: directory not found', 3); fs.rmdirSync(target); break; }
  case 'about': if (!control().about) fail('about not supported by this backend', 1); process.stdout.write(JSON.stringify(control().about)); break;
  case 'config userinfo': process.stdout.write(JSON.stringify(control().userinfo ?? { email: 'fake.user@example.invalid' })); break;
  case 'backend drives': process.stdout.write(JSON.stringify([{ id: 'drive-fixture-1', name: 'Fixture drive', driveType: 'personal' }])); break;
  case 'authorize': {
    const state = randomBytes(12).toString('base64url');
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1:53682');
      if (url.pathname === '/auth') { response.writeHead(302, { Location: control().authLocation ?? ('https://accounts.google.com/o/oauth2/auth?state=' + url.searchParams.get('state')) }); return response.end(); }
      fs.appendFileSync(path.join(here, 'auth-requests.jsonl'), request.url + '\n');
      if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) { response.writeHead(400); return response.end(); }
      response.writeHead(200); response.end('ok');
      process.stdout.write('Paste the following into your remote machine --->\n' + JSON.stringify({ access_token: 'issued-access-' + randomBytes(4).toString('hex'), token_type: 'Bearer', refresh_token: 'issued-refresh-' + randomBytes(4).toString('hex'), expiry: '2031-01-01T00:00:00Z' }) + '\n<---End paste\n');
      server.close(); setTimeout(() => process.exit(0), 50);
    });
    // Like the real rclone, the link is a NOTICE line: it is hidden when the log level is ERROR or CRITICAL.
    const quiet = ['ERROR', 'CRITICAL'].includes(String(flags['--log-level'] ?? 'NOTICE').toUpperCase());
    server.listen(Number(process.env.DOCKNEST_TEST_AUTH_PORT || 53682), '127.0.0.1', () => !quiet && process.stderr.write(`NOTICE: Make sure your Redirect URL is set to "http://127.0.0.1:53682/" in your custom config.\nIf your browser doesn't open automatically go to the following link: http://127.0.0.1:${process.env.DOCKNEST_TEST_AUTH_PORT || 53682}/auth?state=${state}\nLog in and authorize rclone for access\nWaiting for code...\n`));
    await new Promise(() => {});
    break;
  }
  default: fail('unknown command ' + command, 1);
}
