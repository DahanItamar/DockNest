import fs from 'node:fs';
import path from 'node:path';

// Node 24 loads .env without adding a runtime dependency.
try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const dataDir = path.resolve(process.env.DATA_DIR || 'data');
const origin = process.env.APP_ORIGIN || 'http://127.0.0.1:3000';
const url = new URL(origin);
if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('APP_ORIGIN must be an HTTP(S) origin without a trailing slash');
export function allowedOrigins(appOrigin, production = process.env.NODE_ENV === 'production') {
  const configured = new URL(appOrigin);
  const origins = new Set([configured.origin]);
  if (!production && ['localhost', '127.0.0.1'].includes(configured.hostname)) {
    for (const hostname of ['localhost', '127.0.0.1']) {
      const alias = new URL(configured.origin);
      alias.hostname = hostname;
      origins.add(alias.origin);
    }
  }
  return origins;
}
export const trustedOrigins = allowedOrigins(origin);
export const config = {
  dataDir,
  backupDir: path.resolve(process.env.BACKUP_DIR || path.join(dataDir, 'backups')),
  masterKey: process.env.MASTER_KEY_FILE || path.join(dataDir, 'master.key'),
  setupTokenFile: process.env.SETUP_TOKEN_FILE || path.join(dataDir, 'setup.token'),
  origin,
  port: Number(process.env.PORT || 3000),
  secureCookies: process.env.SECURE_COOKIES !== 'false',
};
if (process.env.NODE_ENV === 'production' && (!config.secureCookies || url.protocol !== 'https:')) throw new Error('Production requires HTTPS APP_ORIGIN and Secure cookies');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
