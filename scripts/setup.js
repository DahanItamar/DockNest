import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
const directory = resolve('data');
const backups = resolve('backups');
await mkdir(directory, { recursive: true, mode: 0o700 });
await mkdir(backups, { recursive: true, mode: 0o700 });
async function createOnce(path, contents) {
  try { await writeFile(path, contents, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
const key = resolve(directory, 'master.key');
const token = resolve(directory, 'setup.token');
await createOnce(key, randomBytes(32).toString('base64') + '\n');
await createOnce(token, randomBytes(32).toString('base64url') + '\n');
if (Buffer.from((await readFile(key, 'utf8')).trim(), 'base64').length !== 32) {
  throw new Error('Existing master.key must contain a base64-encoded 32-byte key. It was not changed.');
}
const quoted = value => JSON.stringify(value.replaceAll('\\', '/'));
await createOnce(resolve('.env'), [
  'NODE_ENV=development', 'PORT=3000',
  'APP_ORIGIN=http://127.0.0.1:3000', 'SECURE_COOKIES=false',
  'DATA_DIR=' + quoted(directory), 'BACKUP_DIR=' + quoted(backups),
  'MASTER_KEY_FILE=' + quoted(key), 'SETUP_TOKEN_FILE=' + quoted(token), '',
].join('\n'));
console.log('Local configuration ready. Existing files were preserved.');
console.log('Read the one-time setup token from: ' + token);
console.log('Open http://127.0.0.1:3000 after building and starting the API.');
console.log('Keep master.key separately backed up; losing it makes encrypted data unrecoverable.');
