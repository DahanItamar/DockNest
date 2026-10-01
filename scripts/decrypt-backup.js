import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
const [inputArg, keyArg, outputArg] = process.argv.slice(2);
if (!inputArg || !keyArg || !outputArg) {
  console.error('Usage: node scripts/decrypt-backup.js <payload.enc> <master.key> <new-output.tar.gz>');
  process.exit(1);
}
const input = resolve(inputArg), output = resolve(outputArg);
if (input === output) throw new Error('Output must differ from input.');
const key = Buffer.from((await readFile(resolve(keyArg), 'utf8')).trim(), 'base64');
if (key.length !== 32) throw new Error('Expected a base64-encoded 32-byte master key.');
const size = (await stat(input)).size;
if (size < 32) throw new Error('Truncated encrypted package.');
const handle = await open(input, 'r');
const header = Buffer.alloc(16), tag = Buffer.alloc(16);
try {
  await handle.read(header, 0, 16, 0);
  await handle.read(tag, 0, 16, size - 16);
} finally { await handle.close(); }
if (header.subarray(0,4).toString('ascii') !== 'DBM1') throw new Error('Unsupported payload format.');
const partial = output + '.' + randomBytes(8).toString('hex') + '.partial';
const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(4));
decipher.setAAD(header);
decipher.setAuthTag(tag);
try {
  await pipeline(createReadStream(input, { start: 16, end: size - 17 }), decipher,
    createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
  // Reserve the output first so an existing file cannot be overwritten.
  const reservation = await open(output, 'wx', 0o600);
  await reservation.close();
  try { await rename(partial, output); }
  catch (error) { await rm(output, { force: true }); throw error; }
  console.log('Authenticated package written: ' + output);
  console.log('Inspect the bundled manifest and restore guide before extracting or restoring.');
} catch (error) {
  await rm(partial, { force: true });
  throw error;
}
