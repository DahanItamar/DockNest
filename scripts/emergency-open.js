// Emergency kit tool (docs/emergency-kit.md): opens a DockNest emergency kit with K of the N parts, offline. Node 24,
// built-ins only, no network. The recovery kit carries a one-file copy as recovery/emergency-open.js (src/emergency/bundle.js).
//   node emergency-open.js list <emergency kit file or folder>
//   node emergency-open.js open <emergency kit file or folder> <new folder>
// `open` reads the parts from the keyboard (or one part per line from a pipe), joins them, checks the joined key against
// the kit's digest before any decryption, then writes the newest matching kit into the new folder as a recovery kit file
// and its passphrase file, ready for `node recovery-kit.js restore`. Words and keys are never printed or saved.
import { readdir, readFile, lstat, mkdir, open as openFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { createInterface } from 'node:readline';
import { combineMnemonics, decodeMnemonic, MnemonicError } from '../src/emergency/slip39.js';
import { readEnvelopeHeader, open, unpackKit, publicKeyOf, publicKeyDigest, EnvelopeError, ENVELOPE_MAX_BYTES } from '../src/emergency/envelope.js';

const usage = 'Usage: node emergency-open.js list <emergency kit file or folder>\n       node emergency-open.js open <emergency kit file or folder> <new folder>';
const KIT_FILE = 'docknest-recovery.dkit', PASSPHRASE_FILE = 'recovery-passphrase.txt';
class ToolError extends Error {}
const stop = message => { throw new ToolError(message); };
const say = line => process.stdout.write(line + '\n');

// Every regular *.dkem file of a folder (not its subfolders), or the one file given, with its header, newest first.
async function kits(path) {
  const info = await lstat(path).catch(() => stop('The kit file or folder does not exist.'));
  const files = info.isDirectory() ? (await readdir(path)).filter(name => name.endsWith('.dkem')).map(name => join(path, name)) : [path];
  const found = [];
  for (const file of files) {
    const stats = await lstat(file);
    if (!stats.isFile() || stats.size > ENVELOPE_MAX_BYTES) continue;
    try { found.push({ file, header: readEnvelopeHeader(await readFile(file)) }); } catch (error) { if (!(error instanceof EnvelopeError)) throw error; }
  }
  if (!found.length) stop('No DockNest emergency kit (.dkem file) was found there.');
  return found.sort((a, b) => b.header.createdAt.localeCompare(a.header.createdAt) || basename(a.file).localeCompare(basename(b.file)));
}
const describe = (kit, mark = '') => `${mark}${kit.header.createdAt}  DockNest ${kit.header.release}  key ${kit.header.digest.slice(0, 16)}  ${basename(kit.file)}`;

// Parts from the keyboard ask again after a typo; parts from a pipe stop at the first bad line.
async function readParts() {
  const lines = createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator](), interactive = process.stdin.isTTY;
  const parts = [];
  let needed = null;
  while (needed === null || parts.length < needed) {
    if (interactive) process.stdout.write(needed === null ? 'Type part 1 (all words on one line): ' : `Type part ${parts.length + 1} of ${needed}: `);
    const { value, done } = await lines.next();
    if (done) stop(needed === null ? 'No part was entered.' : `Only ${parts.length} of the ${needed} parts needed were entered.`);
    if (!value.trim()) continue;
    let share;
    try { share = decodeMnemonic(value); } catch (error) {
      if (!(error instanceof MnemonicError)) throw error;
      const message = `Part ${parts.length + 1} has a typo, a missing word or a word in the wrong place. ${error.message}`;
      if (!interactive) stop(message);
      say(message + ' Type it again.'); continue;
    }
    needed ??= share.memberThreshold;
    parts.push(value);
  }
  return parts;
}

async function writeRecoveryKit(directory, { kit, passphrase }) {
  await mkdir(directory, { mode: 0o700 }).catch(error => stop(error.code === 'EEXIST' ? 'The new folder already exists. Name a folder that does not exist yet.' : 'The new folder could not be made.'));
  for (const [name, bytes] of [[KIT_FILE, kit], [PASSPHRASE_FILE, Buffer.from(passphrase, 'utf8')]]) {
    const handle = await openFile(join(directory, name), 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  }
}

async function main([operation, source, target, ...rest]) {
  if (!['list', 'open'].includes(operation) || !source || rest.length || (operation === 'list') !== !target) stop(usage);
  const found = await kits(resolve(source));
  if (operation === 'list') { say('Emergency kits, newest first:'); for (const kit of found) say(describe(kit, '  ')); return; }
  const directory = resolve(target);
  await lstat(directory).then(() => stop('The new folder already exists. Name a folder that does not exist yet.'), () => {});
  let privateKey;
  try {
    try { privateKey = combineMnemonics(await readParts()); } catch (error) { if (error instanceof MnemonicError) stop(`The parts could not be joined: ${error.message}`); throw error; }
    const digest = publicKeyDigest(publicKeyOf(privateKey)), match = found.find(kit => kit.header.digest === digest);
    say('Emergency kits, newest first (* = opens with these parts):');
    for (const kit of found) say(describe(kit, kit.header.digest === digest ? '* ' : '  '));
    if (!match) stop(`These parts belong together (key ${digest.slice(0, 16)}), but none of these kits was made for them. Check the key printed on the parts.`);
    const contents = unpackKit(open(await readFile(match.file), privateKey));
    if (!contents.kit.subarray(0, 4).equals(Buffer.from('DKN1'))) stop('The emergency kit does not hold a DockNest recovery kit.');
    await writeRecoveryKit(directory, contents);
    say(`Opened the kit made on ${match.header.createdAt} by DockNest ${match.header.release}.`);
    say(`Next, from a copy of DockNest (its release image or source), restore it into another new folder:\n  node scripts/recovery-kit.js restore ${join(directory, KIT_FILE)} <another new folder> ${join(directory, PASSPHRASE_FILE)}`);
    say(`Keep ${directory} private and delete it once DockNest runs again: it holds the recovery passphrase.`);
  } catch (error) { if (error instanceof EnvelopeError) stop(error.message); throw error; }
  finally { privateKey?.fill(0); }
}

try { await main(process.argv.slice(2)); }
catch (error) { process.stderr.write((error instanceof ToolError ? error.message : 'The emergency kit could not be opened. Check the file, the folder and the free space.') + '\n'); process.exitCode = 1; }
