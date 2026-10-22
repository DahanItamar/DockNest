import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

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
// TRUST_PROXY (opt-in): comma-separated exact IPs or CIDRs of the reverse proxy in front of the API, for example the
// bundled Caddy's address on the Compose network. Presets, hostnames, "true" and hop counts are refused, so no peer is
// trusted by accident. Unset means no proxy is trusted and X-Forwarded-For is ignored.
export function parseTrustProxy(value) {
  if (value === undefined || String(value).trim() === '') return false;
  const entries = String(value).split(',').map(entry => entry.trim());
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split('/'), version = net.isIP(address);
    if (!version || extra !== undefined || (prefix !== undefined && !(/^\d{1,3}$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128)))) throw new Error('TRUST_PROXY must be a comma-separated list of exact IP addresses or CIDR ranges');
  }
  return entries;
}
export const config = {
  dataDir,
  backupDir: path.resolve(process.env.BACKUP_DIR || path.join(dataDir, 'backups')),
  masterKey: process.env.MASTER_KEY_FILE || path.join(dataDir, 'master.key'),
  setupTokenFile: process.env.SETUP_TOKEN_FILE || path.join(dataDir, 'setup.token'),
  origin,
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
  storage: {
    mode:process.env.BACKUP_STORAGE || 'unconfigured',
    host:process.env.STORAGE_HOST || '',port:Number(process.env.STORAGE_PORT || 23),username:process.env.STORAGE_USERNAME || '',
    hostKey:process.env.STORAGE_HOST_KEY_SHA256 || '',keyFile:process.env.STORAGE_PRIVATE_KEY_FILE || '',passwordFile:process.env.STORAGE_PASSWORD_FILE || '',
    root:process.env.STORAGE_ROOT || '/home/docknest',capacity:Number(process.env.STORAGE_CAPACITY_BYTES || 1000000000000),
  },
  secureCookies: process.env.SECURE_COOKIES !== 'false',
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
};
if (process.env.NODE_ENV === 'production' && (!config.secureCookies || url.protocol !== 'https:')) throw new Error('Production requires HTTPS APP_ORIGIN and Secure cookies');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
if(!['unconfigured','local','sftp'].includes(config.storage.mode))throw new Error('BACKUP_STORAGE must be unconfigured or sftp');
if(config.storage.mode==='local'&&process.env.NODE_ENV!=='test'&&process.env.ALLOW_LOCAL_BACKUP_STORAGE!=='true')throw new Error('Local backup storage is disabled. Connect a remote destination in Storage.');
if(config.storage.mode==='sftp'){
 if(!/^\/[a-zA-Z0-9_./-]+$/.test(config.storage.root)||config.storage.root==='/'||config.storage.root.split('/').includes('..'))throw new Error('STORAGE_ROOT must be a dedicated absolute directory without traversal');
 if(!/^[a-f0-9]{64}$/i.test(config.storage.hostKey))throw new Error('STORAGE_HOST_KEY_SHA256 must be an independently verified SHA256 hex fingerprint');
 if(!config.storage.host||!config.storage.username||(!config.storage.keyFile&&!config.storage.passwordFile))throw new Error('SFTP storage requires a host, username and mounted credential file');
 if(!Number.isSafeInteger(config.storage.capacity)||config.storage.capacity<=0||!Number.isInteger(config.storage.port)||config.storage.port<1||config.storage.port>65535)throw new Error('Invalid Storage Box port or capacity');
}
if(config.storage.mode==='local')fs.mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
