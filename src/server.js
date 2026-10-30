import {maintenanceDefaults,normalizeMaintenance} from '../shared/maintenance-design.js';
import express from 'express';
import helmet from 'helmet';
import { z, ZodError } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { statfsSync, statSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { probeUrlAllowed, probeUrlMessage } from './probe-url.js';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { storageCapacity, statFile, openRead } from './storage.js';
import { storageTargets } from './storage-targets.js';
import { selfBackupRoutes } from './self-backup-routes.js';
import { moveRoutes, cloudflareRoutes } from './moves/routes.js';
import { requestInstall, findInstall } from './installs.js';
import { alertRoutes, connectionRoutes } from './alerts/routes.js';
import { canManageAlerts } from './alerts/connections.js';
import { restoreTestRoutes, acknowledgeTestJob } from './restore-tests/routes.js';
import { storageReportRoutes } from './storage-report.js';
import { backupTestStates, notTested } from './restore-tests/views.js';
import { config, trustedOrigins } from './config.js';
import { db, parse, id, audit, transaction } from './db.js';
import { schemaVersion } from './migrations.js';
import { recordRelease } from './updates/release-history.js';
import { updateRoutes, cachedOffer } from './updates/routes.js';
import { createUpdateService } from './updates/requests.js';
import { progressHandler, lockMiddleware } from './updates/lock.js';
import { seal } from './crypto.js';
import { auth, session, requireAuth, csrf, rateLimit, requireAdmin, requireRecentAuth } from './auth.js';
import { access } from './access.js';
import { prepareServerKey, serverReportCommand } from './server-onboarding.js';
import { testServer, discover, browseProjectFiles, checkReadiness, planBackup, enqueueBackup, enqueueScrub, planRestore, enqueueRestore, setMaintenance, deployMaintenance, verifyRecovery } from './engine.js';
import { backupVerification, backupVerifications } from './recovery-evidence.js';
import { installBootRecovery, bootRecoveryStatus, requireNotMoving, discardIncrementalState } from './engine.js';
import { normalizeDomain } from '../shared/domains.js';
import { exportFullZip,clearInterruptedExports,startZipExport,findZipExport,zipExportState,activeZipExportFor,cancelZipExport,streamZipExport } from './backup-export.js';
import { reportErrorFields, serverTestFailure } from './storage-errors.js';
import { siteStorageView, siteStorageSummary, updateSiteStorage } from './site-storage.js';
import { backupCopyViews } from './backup-copies.js';
import { retryCopy, packagePath } from './artifact-journal.js';
import { incrementalRoutes } from './incremental-routes.js';
import { chainViews, linkOf, incrementalSettings } from './incremental.js';
await clearInterruptedExports();

export const app = express();
app.disable('x-powered-by');
// Default: trust no proxy (req.ip is the socket peer). TRUST_PROXY lists the exact proxy addresses (see src/config.js).
app.set('trust proxy', config.trustProxy);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"] } }, strictTransportSecurity: config.secureCookies ? undefined : false }));
app.use(express.json({ limit: '128kb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !trustedOrigins.has(req.headers.origin)) return res.status(403).json({ error: 'Request origin does not match APP_ORIGIN. Open the configured application address.' });
  next();
});
app.get('/healthz', (_req, res) => { db.prepare('SELECT 1').get(); res.json({ status: 'ok' }); });
// Public release identity for upgrade checks; deliberately nothing about hosts, users or configuration.
const release = Object.freeze({ version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, schemaVersion });
recordRelease(db, release);
app.get('/api/version', (_req, res) => res.json(release));
// Public progress and the 423 lock read one in-memory snapshot of the update service (refreshed every 2 s), before any session work.
export const updates = createUpdateService({ release });
if (process.env.NODE_ENV !== 'test') updates.start(); else updates.rebuild();
app.get('/api/updates/progress', progressHandler(updates));
app.use('/api', lockMiddleware(updates));
app.use('/api', session);
app.use('/api/auth', auth);
app.use('/api', requireAuth, csrf, rateLimit('api', 600, 60 * 1000));
app.use('/api/access', access);
app.use('/api/storage-targets',storageTargets);
app.use('/api/self-backup',selfBackupRoutes);
app.use('/api/moves', moveRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/connections', connectionRoutes);
app.use('/api', restoreTestRoutes);
app.use('/api', storageReportRoutes);
app.use('/api', incrementalRoutes);
app.use('/api/settings/cloudflare-dns', cloudflareRoutes);
app.use('/api/updates', updateRoutes({ release, service: updates }));
const now = () => new Date().toISOString();
const notFound = message => { const error = new Error(message); error.status = 404; throw error; };
const getServer = serverId => db.prepare('SELECT * FROM servers WHERE id=?').get(serverId) || notFound('Server not found.');
const getSite = siteId => parse(db.prepare('SELECT * FROM sites WHERE id=?').get(siteId)) || notFound('Site not found.');
const safeServer = row => { const { private_key, ...rest } = parse(row); return rest; };
// List endpoints pass a preloaded Map so each backup row does not issue its own verification query.
const view = (row, verifications) => {
  const parsed = parse(row), converted = { ...parsed };
  for (const [name, value] of Object.entries(parsed)) converted[name.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
  if ('verified' in converted) {converted.status=converted.verified?'Verified':'Unverified';converted.verification=verifications instanceof Map&&verifications.has(converted.id)?verifications.get(converted.id):backupVerification(converted.id);}
  if (converted.manifest?.downtimeSeconds != null) converted.downtimeMs = converted.manifest.downtimeSeconds * 1000;
  if (converted.detail) converted.details = converted.detail;
  if (converted.target) converted.targetId = converted.target;
  return converted;
};
const linuxPath = z.string().regex(/^\/[a-zA-Z0-9_./-]+$/).refine(value => !value.split('/').includes('..'), 'Parent path traversal is not allowed.').refine(value => !value.startsWith('//'), 'Start the path with a single slash.');
// Same system folders the helper refuses for maintenance pages (remote/helper.py SYSTEM_TREES), so the default
// maintenance folder under the staging root is always deployable.
const systemTrees = ['/etc', '/root', '/boot', '/proc', '/sys', '/dev', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/local/bin', '/usr/local/sbin', '/var/spool', '/var/log', '/run'];
const outsideSystemFolders = value => !systemTrees.some(root => value === root || value.startsWith(root + '/')) && !value.split('/').includes('.ssh');
const healthUrl = z.string().max(2048).refine(value => !value || probeUrlAllowed(value), probeUrlMessage);
const siteSchema = z.object({
  serverId: z.uuid(), name: z.string().trim().min(1).max(100),
  config: z.object({
    kind:z.enum(['docker','static']).default('docker'),
    documentRoot:linuxPath.optional(),
    containers: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)).max(30),
    stagingRoot: linuxPath.refine(value => value !== '/', 'Use a dedicated staging directory.').refine(value => outsideSystemFolders(value.replace(/\/+$/, '')), 'Use a staging directory outside system folders such as /etc, /root or /usr/bin, for example /var/lib/docknest.').default('/var/lib/docknest'),
    deliveryMode: z.enum(['staged','direct']).default('staged'),
    sqliteIntegrityCheck: z.enum(['full','off']).optional(),
    exclusiveSourcesConfirmed: z.boolean().default(false),
    stopTimeout: z.number().int().min(10).max(600).default(60),
    shutdownProfile: z.enum(['generic', 'postgres', 'mysql']).default('generic'),
    cleanShutdownConfirmed: z.boolean().default(false),
    unresolvedDependencies: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
    services: z.array(z.object({container:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),engine:z.enum(['auto','generic','postgres','mysql','mariadb','redis']).default('auto'),version:z.string().regex(/^\d+\.\d+(?:\.\d+)?$/).optional(),dependsOn:z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)).max(30).default([]),database:z.string().regex(/^[a-zA-Z0-9_]{1,63}$/).optional(),user:z.string().regex(/^[a-zA-Z0-9_]{1,63}$/).optional(),sqliteFiles:z.array(linuxPath).max(30).default([]),sqliteVersion:z.string().regex(/^3\.\d+\.\d+$/).optional(),sqliteSigtermConfirmed:z.boolean().default(false),checks:z.array(z.object({name:z.string().regex(/^[a-zA-Z0-9 _-]{1,80}$/),table:z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/).optional(),key:z.string().min(1).max(512).refine(value=>!/[\x00-\x1f\x7f]/.test(value)).optional()}).refine(check=>Boolean(check.table)!==Boolean(check.key),'Specify exactly one table or Redis key')).max(20).default([])}).superRefine((service,context)=>{for(const check of service.checks){if(service.engine==='redis'&&(!check.key||(service.database!==undefined&&!/^\d+$/.test(service.database))))context.addIssue({code:'custom',message:'Redis checks need a key and numeric database index'});if(['postgres','mysql','mariadb'].includes(service.engine)&&!check.table)context.addIssue({code:'custom',message:'SQL database checks need a table'});}})).max(30).default([]),
    configFiles: z.array(linuxPath).max(50).default([]),
    mountExclusions:z.array(z.object({source:linuxPath,path:linuxPath,reason:z.string().trim().min(1).max(300),requiredForRestore:z.boolean().optional()})).max(50).default([]),
    mountExclusionsConfirmed:z.boolean().default(false),
    restoreReferences:z.array(z.object({serverId:z.uuid(),capturedPath:linuxPath,source:linuxPath})).max(50).default([]),
    temporaryMemoryFolders:z.array(z.object({container:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),destination:z.string().max(4096).regex(/^\/[A-Za-z0-9_.@+-][A-Za-z0-9_./@+-]*$/)})).max(90).default([]),
    composeFiles: z.array(linuxPath).max(20).default([]),
    externalReferencesConfirmed: z.boolean().default(false),
    maintenanceRequired: z.boolean().default(true),
    maintenanceProbeOrigin:z.boolean().optional(),
    maintenancePublicUrl:healthUrl.optional(),
    domains: z.array(z.string().max(2048).transform(normalizeDomain).pipe(z.string().max(253).regex(/^[a-zA-Z0-9.-]+$/, 'Enter a domain such as www.blog.example.invalid, or paste an HTTP(S) website URL without login details.'))).max(20).default([]),
    healthUrl: healthUrl.default(''),
    maintenance: z.object({ required: z.boolean(), directory: linuxPath, publicUrl: healthUrl, healthUrl, probeOrigin:z.boolean().default(false),readableFlag:z.boolean().default(false) }).optional(),
  }).superRefine((value,context)=>{
    if(value.kind==='docker'&&!value.containers.length)context.addIssue({code:'custom',path:['containers'],message:'Select at least one Docker container.'});
    if(value.kind==='static'&&(!value.documentRoot||value.containers.length||value.composeFiles.length))context.addIssue({code:'custom',message:'Choose a static website directory without Docker containers or Compose files.'});
  }),
});
const serverSchema = z.object({
  note: z.string().trim().max(200).default(''),
  name: z.string().trim().min(1).max(100), host: z.string().regex(/^[a-zA-Z0-9_.:-]{1,253}$/),
  port: z.number().int().min(1).max(65535).default(22), username: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
  privateKey: z.string().min(50).max(30000), hostKey: z.string().regex(/^(?:[a-fA-F0-9]{64}|SHA256:[A-Za-z0-9+/]{43}=?)$/),
});
const fingerprint = value => value.startsWith('SHA256:') ? Buffer.from(value.slice(7), 'base64').toString('hex') : value.toLowerCase();
// Display names only for the accounts that appear in the audit rows being returned, never the whole account list.
const actorNames = rows => {
  const ids = [...new Set(rows.map(row => row.actor).filter(actor => typeof actor === 'string' && actor))];
  if (!ids.length) return {};
  return Object.fromEntries(db.prepare(`SELECT id,name FROM users WHERE name IS NOT NULL AND id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(user => [user.id, user.name]));
};
app.get('/api/state', async (req, res) => {
  const backups = db.prepare('SELECT * FROM backups ORDER BY captured_at DESC,id DESC LIMIT 1000').all().map(parse), verifications = backupVerifications(backups.map(backup => backup.id));
  const storage = await storageCapacity({maxAgeMs:30000});
  const auditRows = db.prepare('SELECT * FROM audit_events ORDER BY created_at DESC,id DESC LIMIT 250').all().map(view);
  const settings = db.prepare("SELECT value FROM settings WHERE key='maintenance'").get();
  const heartbeat = db.prepare("SELECT value FROM settings WHERE key='worker_heartbeat'").get();
  const worker = heartbeat ? JSON.parse(heartbeat.value) : { running: false, lastSeen: null };
  worker.online = worker.running && Date.now() - Date.parse(worker.lastSeen) < 60000;
  res.json({ servers: db.prepare('SELECT * FROM servers ORDER BY created_at').all().map(safeServer).map(view), archivedSites: db.prepare('SELECT id,name,server_id FROM sites WHERE id IN (SELECT site_id FROM site_archives) ORDER BY created_at').all().map(view), sites: db.prepare('SELECT * FROM sites WHERE id NOT IN (SELECT site_id FROM site_archives) ORDER BY created_at').all().map(view).map(site => { const bootRecovery = bootRecoveryStatus(site.id); return { ...site, bootRecovery, bootRecoveryOutdated: bootRecovery.outdated, storage: siteStorageSummary(site.id), ...(site.config?.kind !== 'static' ? { incremental: (({ enabled, interval }) => ({ enabled, interval }))(incrementalSettings(site.id)) } : {}) }; }), policies: db.prepare('SELECT * FROM policies').all().map(view), jobs: db.prepare('SELECT * FROM jobs ORDER BY created_at DESC,id DESC LIMIT 500').all().map(view), backups: ((tested, copies, chains) => backups.map(({ path: _path, ...backup }) => ({ ...view(backup, verifications), restoreTest: tested.get(backup.id) ?? notTested, ...copies.get(backup.id), ...chains.get(backup.id) })))(backupTestStates(backups.map(backup => backup.id)), backupCopyViews(backups), chainViews(backups)), restores: db.prepare('SELECT * FROM restores ORDER BY created_at DESC,id DESC LIMIT 500').all().map(view), audit: auditRows, actors: actorNames(auditRows), worker, storage, maintenance: settings ? normalizeMaintenance(JSON.parse(settings.value)) : maintenanceDefaults, alertsAccess: canManageAlerts(req.user), ...(req.user.role === 'admin' ? { update: { available: cachedOffer(db, release) } } : {}) });
});
// Keyset-paginated history: the cursor is the last row's (timestamp,id), so pages stay stable while new rows arrive.
const historyCursor = z.string().max(512).transform((value, context) => { try { const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); return z.tuple([z.string().min(1).max(64), z.string().min(1).max(128)]).parse(decoded); } catch { context.addIssue({ code: 'custom', message: 'Invalid pagination cursor.' }); return z.NEVER; } });
const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: historyCursor.optional() });
const histories = { backups: { table: 'backups', time: 'captured_at' }, jobs: { table: 'jobs', time: 'created_at' }, restores: { table: 'restores', time: 'created_at' }, audit: { table: 'audit_events', time: 'created_at' } };
for (const [name, { table, time }] of Object.entries(histories)) app.get('/api/' + name, (req, res) => {
  const { limit, cursor } = historyQuery.parse(req.query);
  const rows = db.prepare(`SELECT * FROM ${table} ${cursor ? `WHERE (${time},id)<(?,?)` : ''} ORDER BY ${time} DESC,id DESC LIMIT ?`).all(...(cursor || []), limit + 1), page = rows.slice(0, limit), last = page.at(-1);
  // Backup listings never expose storage paths, matching /api/state.
  const backups = name === 'backups', verifications = backups ? backupVerifications(page.map(row => row.id)) : null;
  const tested = backups ? backupTestStates(page.map(row => row.id)) : null, copies = backups ? backupCopyViews(page) : null, chains = backups ? chainViews(page) : null;
  res.json({ items: page.map(row => { if (backups) { const { path: _path, ...rest } = row; return { ...view(rest, verifications), restoreTest: tested.get(rest.id) ?? notTested, ...copies.get(rest.id), ...chains.get(rest.id) }; } return view(row, verifications); }), nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([last[time], last.id])).toString('base64url') : null });
});
app.get('/api/servers/onboarding', requireAdmin, (_req,res) => res.json({reportCommand:serverReportCommand}));
app.post('/api/servers/prepare-key', requireAdmin, rateLimit('server-key',5), async (req,res) => {
  const result=await prepareServerKey();
  audit(req.user.id,'server.key_prepared');
  res.json(result);
});
app.post('/api/servers/connect', requireAdmin, rateLimit('server-connect',5), async (req,res) => {
  const data=serverSchema.parse(req.body), serverId=id();
  const server={id:serverId,host:data.host,port:data.port,username:data.username,private_key:seal(data.privateKey),host_key:fingerprint(data.hostKey)};
  const capabilities=await testServer(server);
  if(capabilities.uid!==0)return res.status(409).json({error:'SSH connected, but this backup engine requires a root SSH account to preserve volume ownership. Run the setup command as root and connect using root.'});
  db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,status,capabilities,created_at,note) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(serverId,data.name,data.host,data.port,data.username,server.private_key,server.host_key,'connected',JSON.stringify(capabilities),now(),data.note);
  audit(req.user.id,'server.connected',serverId);
  res.status(201).json(safeServer(getServer(serverId)));
});
app.post('/api/servers', requireAdmin, (req, res) => {
  const data = serverSchema.parse(req.body), serverId = id();
  db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at,note) VALUES (?,?,?,?,?,?,?,?,?)').run(serverId, data.name, data.host, data.port, data.username, seal(data.privateKey), fingerprint(data.hostKey), now(),data.note);
  audit(req.user.id, 'server.create', serverId); res.status(201).json(safeServer(getServer(serverId)));
});
app.patch('/api/servers/:id/details', requireAdmin, (req, res) => {
  const previous = getServer(req.params.id);
  const data = z.object({name:z.string().trim().max(100),note:z.string().trim().max(200).default('')}).strict().parse(req.body);
  db.prepare('UPDATE servers SET name=?,note=? WHERE id=?').run(data.name||previous.host,data.note,previous.id);
  audit(req.user.id,'server.details_updated',previous.id);
  res.json(safeServer(getServer(previous.id)));
});
app.patch('/api/servers/:id', requireAdmin, (req, res) => {
  const previous = getServer(req.params.id);
  const data = serverSchema.extend({ note:z.string().trim().max(200).optional(), privateKey: serverSchema.shape.privateKey.optional(), hostKeyConfirmation: z.literal(true).optional() }).parse(req.body);
  if (fingerprint(data.hostKey) !== previous.host_key && !data.hostKeyConfirmation) return res.status(409).json({ error: 'SSH host key changed. Verify the new fingerprint independently and explicitly confirm the change.' });
  db.prepare("UPDATE servers SET name=?,note=?,host=?,port=?,username=?,private_key=?,host_key=?,status='unchecked',capabilities=NULL WHERE id=?").run(data.name, data.note??previous.note, data.host, data.port, data.username, data.privateKey ? seal(data.privateKey) : previous.private_key, fingerprint(data.hostKey), previous.id);
  audit(req.user.id, 'server.update', previous.id); res.json(safeServer(getServer(previous.id)));
});
app.post('/api/servers/:id/install', requireAdmin, requireRecentAuth, rateLimit('server-install', 10, 10 * 60_000), async (req, res) => {
  try { res.status(202).json(await requestInstall(z.uuid().parse(req.params.id), req.body, req.user.id)); }
  catch (error) { if (error.status) return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) }); throw error; }
});
app.post('/api/servers/:id/test', async (req, res) => {
  const server = getServer(req.params.id);
  try {
    const result = await testServer(server);
    // Merged, so facts recorded elsewhere (the CPU count from a restore test's Check space) survive a connection test.
    let previous = {}; try { previous = JSON.parse(server.capabilities || '{}') || {}; } catch { previous = {}; }
    db.prepare("UPDATE servers SET status='connected',capabilities=? WHERE id=?").run(JSON.stringify({ ...previous, ...result }), server.id);
    audit(req.user.id, 'server.test', server.id, { success: true }); res.json(result);
  } catch (error) { db.prepare("UPDATE servers SET status='failed' WHERE id=?").run(server.id); throw Object.assign(error, serverTestFailure(error)); }
});
app.get('/api/servers/:id/discover', async (req, res) => {
  const result = await discover(getServer(req.params.id));
  const containers = Array.isArray(result) ? result : result.containers || [];
  res.json({ staticSites:result.staticSites||[],containers: containers.map(container => ({ ...container, Config: { ...container.Config, Env: (container.Config?.Env || []).map(value => value.split('=')[0] + '=[redacted]') } })) });
});
app.get('/api/servers/:id/project-files', requireAdmin, async (req,res)=>{
  const containers=siteSchema.shape.config.shape.containers.min(1).parse(typeof req.query.containers==='string'?req.query.containers.split(','):[]);
  const directory=linuxPath.optional().parse(req.query.path);
  res.json(await browseProjectFiles(getServer(req.params.id),containers,directory));
});
function normalizedSite(data, siteId) {
  const settings = db.prepare("SELECT value FROM settings WHERE key='maintenance'").get();
  const maintenance = data.config.maintenance || { required: data.config.maintenanceRequired, directory: `${data.config.stagingRoot}/maintenance/${siteId}`, publicUrl: data.config.domains[0] ? 'https://' + data.config.domains[0] : '', healthUrl: data.config.healthUrl };
  if(data.config.maintenanceProbeOrigin!==undefined)maintenance.probeOrigin=data.config.maintenanceProbeOrigin;
  if(data.config.maintenancePublicUrl!==undefined)maintenance.publicUrl=data.config.maintenancePublicUrl;
  if(data.config.kind==='static')maintenance.required=false;
  for (const value of [maintenance.healthUrl, maintenance.publicUrl]) {
    if (value && !probeUrlAllowed(value)) throw Object.assign(new Error(probeUrlMessage), { status: 400 });
  }
  return { ...data.config, ...(data.config.kind==='static'?{maintenanceRequired:false}:{}),maintenance, maintenancePage: settings ? normalizeMaintenance(JSON.parse(settings.value)) : maintenanceDefaults };
}
// Host paths the helper reads or writes as root. An operator may keep saved values, and may add configuration, Compose and
// static website paths only when discovery reports them for that server; anything else needs an administrator.
const defaultStagingRoot = '/var/lib/docknest';
export function sitePathChanges(saved, next, siteId) {
  const same = saved && saved.serverId === next.serverId ? saved.config || {} : {};
  const added = (field) => (next.config[field] || []).filter(value => !(same[field] || []).includes(value));
  return {
    configFiles: added('configFiles'), composeFiles: added('composeFiles'),
    documentRoot: next.config.kind === 'static' && next.config.documentRoot && next.config.documentRoot !== same.documentRoot ? [next.config.documentRoot] : [],
    stagingRoot: next.config.stagingRoot !== (same.stagingRoot ?? defaultStagingRoot) ? [next.config.stagingRoot] : [],
    maintenanceDirectory: next.config.maintenance?.directory && next.config.maintenance.directory !== (same.maintenance?.directory ?? `${next.config.stagingRoot}/maintenance/${siteId}`) ? [next.config.maintenance.directory] : [],
  };
}
export function discoveredSitePaths(result) {
  const containers = Array.isArray(result) ? result : result?.containers || [], statics = result?.staticSites || [];
  const list = values => Array.isArray(values) ? values.filter(value => typeof value === 'string') : [];
  return {
    configFiles: new Set([...containers.flatMap(container => list(container?.backupConfiguration?.configFiles)), ...statics.flatMap(site => list(site?.configFiles))]),
    composeFiles: new Set(containers.flatMap(container => list(container?.backupConfiguration?.composeFiles))),
    documentRoot: new Set(statics.map(site => site?.documentRoot).filter(value => typeof value === 'string')),
  };
}
const pathLabels = { configFiles: 'configuration files', composeFiles: 'Compose files', documentRoot: 'website files folder', stagingRoot: 'staging directory', maintenanceDirectory: 'maintenance directory' };
async function sitePathRefusal(req, saved, next, siteId) {
  if (req.user.role === 'admin') return null;
  const changes = sitePathChanges(saved, next, siteId), fields = Object.keys(changes).filter(field => changes[field].length);
  if (!fields.length) return null;
  let found = { configFiles: new Set(), composeFiles: new Set(), documentRoot: new Set() };
  if (fields.every(field => field in found)) { try { found = discoveredSitePaths(await discover(getServer(next.serverId))); } catch { /* Unconfirmed paths need an administrator. */ } }
  const refused = fields.filter(field => !found[field] || changes[field].some(value => !found[field].has(value)));
  return refused.length ? { error: `Only an administrator can change the ${refused.map(field => pathLabels[field]).join(', ')} of a site, unless discovery found the path on this server. Ask an administrator to make this change.`, code: 'ADMIN_REQUIRED' } : null;
}
app.post('/api/sites', async (req, res) => {
  const data = siteSchema.parse(req.body); getServer(data.serverId); const siteId = id();
  const settings = normalizedSite(data, siteId);
  const refusal = await sitePathRefusal(req, null, { serverId: data.serverId, config: settings }, siteId);
  if (refusal) return res.status(403).json(refusal);
  db.prepare('INSERT INTO sites VALUES (?,?,?,?,?)').run(siteId, data.serverId, data.name, JSON.stringify(settings), now());
  db.prepare('INSERT INTO policies VALUES (?,0,?,?,7,NULL)').run(siteId, '0 2 * * *', 'Asia/Jerusalem');
  audit(req.user.id, 'site.create', siteId); res.status(201).json(getSite(siteId));
});
app.patch('/api/sites/:id', async (req, res) => {
  const site = getSite(req.params.id), data = siteSchema.parse(req.body); getServer(data.serverId);
  requireNotMoving(site.id);
  // The site form does not edit the SQLite check mode; keep the saved choice.
  const savedCheckMode = (typeof site.config === 'string' ? JSON.parse(site.config) : site.config)?.sqliteIntegrityCheck;
  if (data.config.sqliteIntegrityCheck === undefined && savedCheckMode) data.config.sqliteIntegrityCheck = savedCheckMode;
  if(db.prepare('SELECT 1 FROM site_archives WHERE site_id=?').get(site.id))return res.status(409).json({error:'This site was removed from active sites.'});
  if (db.prepare("SELECT 1 FROM jobs WHERE site_id=? AND status IN ('queued','running','recovery_required')").get(site.id)) return res.status(409).json({ error: 'Resolve the active job before changing capture settings.' });
  const saved = typeof site.config === 'string' ? JSON.parse(site.config) : site.config, next = normalizedSite(data, site.id);
  const refusal = await sitePathRefusal(req, { serverId: site.server_id, config: saved }, { serverId: data.serverId, config: next }, site.id);
  if (refusal) return res.status(403).json(refusal);
  // Probe targets stay operator-editable (operators already run backups and maintenance on these hosts); the helper enforces the address policy and the audit trail names who moved a probe.
  const probeFields = { healthUrl: [saved?.healthUrl, next.healthUrl], maintenanceHealthUrl: [saved?.maintenance?.healthUrl, next.maintenance.healthUrl], maintenancePublicUrl: [saved?.maintenance?.publicUrl, next.maintenance.publicUrl], probeOrigin: [Boolean(saved?.maintenance?.probeOrigin), Boolean(next.maintenance.probeOrigin)], domains: [JSON.stringify(saved?.domains || []), JSON.stringify(next.domains)] };
  const probeTargetsChanged = Object.keys(probeFields).filter(name => (probeFields[name][0] ?? '') !== (probeFields[name][1] ?? ''));
  db.prepare('UPDATE sites SET name=?,server_id=?,config=? WHERE id=?').run(data.name, data.serverId, JSON.stringify(next), site.id);
  audit(req.user.id, 'site.update', site.id, probeTargetsChanged.length ? { probeTargetsChanged } : {}); res.json(getSite(site.id));
});
app.post('/api/sites/:id/policy', (req, res) => {
  const site = getSite(req.params.id);
  if(db.prepare('SELECT 1 FROM site_archives WHERE site_id=?').get(site.id))return res.status(409).json({error:'This site was removed from active sites.'});
  const data = z.object({ enabled: z.boolean(), schedule: z.string().max(100), timezone: z.string().max(100), retention: z.number().int().min(1).max(1000) }).parse(req.body);
  new Intl.DateTimeFormat('en', { timeZone: data.timezone });
  const next = CronExpressionParser.parse(data.schedule, { tz: data.timezone }).next().toISOString();
  db.prepare('UPDATE policies SET enabled=?,schedule=?,timezone=?,retention=?,next_run=? WHERE site_id=?').run(Number(data.enabled), data.schedule, data.timezone, data.retention, next, site.id);
  audit(req.user.id, 'policy.update', site.id, data); res.json({ ...data, next_run: next });
});
// Storage per site and backup copies (docs/backup-copies.md). Names only: never a credential or connection detail.
app.get('/api/sites/:id/storage', (req, res) => res.json(siteStorageView(getSite(req.params.id).id)));
app.put('/api/sites/:id/storage', requireAdmin, requireRecentAuth, (req, res) => {
  const site = getSite(req.params.id);
  if (db.prepare('SELECT 1 FROM site_archives WHERE site_id=?').get(site.id)) return res.status(409).json({ error: 'This site was removed from active sites.', code: 'site_removed' });
  try { res.json(updateSiteStorage(site.id, req.body, req.user.id)); }
  catch (error) { if (error.code && error.status) return res.status(error.status).json({ error: error.message, code: error.code }); throw error; }
});
app.delete('/api/sites/:id', requireAdmin, (req,res)=>{
  const site=getSite(req.params.id);
  requireNotMoving(site.id);
  transaction(()=>{
    if(db.prepare("SELECT 1 FROM jobs WHERE site_id=? AND status IN ('queued','running','recovery_required')").get(site.id))throw Object.assign(new Error('Finish the active job or resolve recovery before removing this site.'),{status:409});
    db.prepare('INSERT OR IGNORE INTO site_archives(site_id,archived_at) VALUES (?,?)').run(site.id,now());
    db.prepare('UPDATE policies SET enabled=0,next_run=NULL WHERE site_id=?').run(site.id);
    audit(req.user.id,'site.removed',site.id,{backupsPreserved:true});
  });
  // Incremental backups: the source's snapshot files of a removed site go too (best effort; backups stay restorable).
  if(incrementalSettings(site.id).enabled)discardIncrementalState(site.id).catch(()=>{});
  res.json({id:site.id,removed:true,backupsPreserved:true});
});
app.post('/api/sites/:id/backup', (req, res) => res.status(202).json(enqueueBackup(req.params.id, req.user.id)));
app.post('/api/sites/:id/readiness', async (req,res)=>res.json(await checkReadiness(req.params.id)));
app.post('/api/sites/:id/plan', async (req,res)=>res.json(await planBackup(req.params.id)));
app.get('/api/sites/:id/boot-recovery', (req,res)=>{ const bootRecovery = bootRecoveryStatus(getSite(req.params.id).id); res.json({ ...bootRecovery, bootRecoveryOutdated: bootRecovery.outdated }); });
app.post('/api/sites/:id/boot-recovery', requireAdmin, async (req,res)=>res.json(await installBootRecovery(req.params.id)));
app.get('/api/jobs/:id', (req, res) => res.json(parse(db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id)) || findInstall(req.params.id) || notFound('Job not found.')));
app.post('/api/jobs/:id/recovery', async (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id) || notFound('Job not found.');
  if (job.type === 'restore-test') return acknowledgeTestJob(req, res, job);
  const site = getSite(job.site_id);
  const data = z.object({ confirmation: z.string(), reviewedRemoteRecovery: z.literal(true) }).parse(req.body);
  if (data.confirmation !== site.name || job.status !== 'recovery_required') return res.status(409).json({ error: 'Confirm the site name and review its remote recovery before acknowledging.' });
  const result = await verifyRecovery(job);
  if(job.type==='restore'){
    const details=JSON.parse(job.details);
    db.prepare("UPDATE restores SET status='failed' WHERE id=?").run(details.restoreId);
  }
  db.prepare("UPDATE jobs SET status='failed',stage='failed',error='Remote recovery reviewed and verified' WHERE id=?").run(job.id);
  audit(req.user.id, 'job.recovery_acknowledged', job.id); res.json({ status: 'failed', ...result });
});
const verifiedBackup=backupId=>{
  if(db.prepare('SELECT 1 FROM retention_operations WHERE backup_id=?').get(backupId))throw Object.assign(new Error('Package retention is in progress.'),{status:409});
  const row=db.prepare('SELECT * FROM backups WHERE id=? AND verified=1').get(backupId)||notFound('Verified backup not found.');
  // Reads the main package, or its newest verified copy once the main one aged out (docs/backup-copies.md).
  return {...row,path:packagePath(row)};
};
// ZIP export is for full backups (docs/incremental-backups.md, phase 1); an increment offers Download chain.
const refuseIncrementalZip=backupId=>{if(linkOf(backupId)?.backup_kind==='incremental')throw Object.assign(new Error('This backup is incremental. Use Download chain.'),{status:409,publicCode:'incremental_zip'});};
const zipExportOf=req=>{const backup=verifiedBackup(req.params.id),item=findZipExport(backup.id,req.params.exportId)||notFound('ZIP preparation not found.');return {backup,item};};
app.post('/api/backups/:id/zip-exports', (req, res) => {
  // The retention check and the lease that protects the backup while it is read happen in one transaction.
  const {backup,result}=transaction(()=>{const row=verifiedBackup(req.params.id);refuseIncrementalZip(row.id);return {backup:row,result:startZipExport(row)};});
  if(result.created)audit(req.user.id,'backup.zip_prepare',backup.id);
  res.status(202).json(result.item);
});
app.get('/api/backups/:id/zip-exports', (req, res) => { const backup=verifiedBackup(req.params.id); res.json({ export: activeZipExportFor(backup.id) }); });
app.get('/api/backups/:id/zip-exports/:exportId', (req, res) => res.json(zipExportState(zipExportOf(req).item)));
app.delete('/api/backups/:id/zip-exports/:exportId', (req, res) => { const {backup,item}=zipExportOf(req); cancelZipExport(item); audit(req.user.id,'backup.zip_cancel',backup.id); res.json({ id: item.id, status: 'expired' }); });
app.get('/api/backups/:id/zip-exports/:exportId/download', async (req, res, next) => {
  try{
    if(req.headers.range)return res.status(416).json({error:'Full ZIP downloads do not support byte ranges. Start a new download.'});
    // streamZipExport takes its download lease before its first await, so the retention check and the lease share this transaction.
    let streaming,target;
    transaction(()=>{const found=zipExportOf(req);target=found.backup;streaming=streamZipExport(found.item,found.backup,res);streaming.catch(()=>{});});
    audit(req.user.id,'backup.download_zip',target.id,{decrypted:true,streamed:true});
    const backup=target;
    try{await streaming;}
    catch(error){audit(req.user.id,'backup.zip_download_failed',backup.id,{reason:error.status?error.message:'verification or export failure'});throw error;}
  }catch(error){if(!res.headersSent)next(error);else res.destroy();}
});
app.get('/api/backups/:id/download', async (req, res, next) => {
  const leaseId=id();
  const backup=transaction(()=>{
    if(db.prepare('SELECT 1 FROM retention_operations WHERE backup_id=?').get(req.params.id))throw Object.assign(new Error('Package retention is in progress.'),{status:409});
    const row=db.prepare('SELECT * FROM backups WHERE id=? AND verified=1').get(req.params.id)||notFound('Verified backup not found.');
    db.prepare('INSERT INTO downloads VALUES (?,?,?)').run(leaseId,row.id,Date.now()+120000);
    return {...row,path:packagePath(row)};
  });
  let cleared=false;
  const interval=setInterval(()=>db.prepare('UPDATE downloads SET expires_at=? WHERE id=?').run(Date.now()+120000,leaseId),30000);
  const clear=()=>{if(cleared)return;cleared=true;clearInterval(interval);db.prepare('DELETE FROM downloads WHERE id=?').run(leaseId);};
  res.once('close',clear);res.once('finish',clear);
  try{
    if(req.query.format==='zip'){
      refuseIncrementalZip(backup.id);
      if(req.headers.range)return res.status(416).json({error:'Full ZIP downloads do not support byte ranges. Start a new download.'});
      if(req.method==='HEAD'){res.attachment(backup.site_id+'_'+backup.id+'_full-site.zip');return res.type('application/zip').end();}
      audit(req.user.id,'backup.download_zip',backup.id,{decrypted:true});
      await exportFullZip(backup,res);return;
    }
    const attrs=await statFile(backup.path),size=attrs.size,etag='"'+backup.checksum+'"';
    let start=0,end=size-1;
    const range=req.method!=='HEAD'&&req.headers.range&&(!req.headers['if-range']||req.headers['if-range']===etag)?req.range(size):null;
    if(range===-1||range===-2||(Array.isArray(range)&&range.length!==1)){res.set('Content-Range','bytes */'+size);return res.status(416).end();}
    if(Array.isArray(range)&&range.type==='bytes'){start=range[0].start;end=range[0].end;res.status(206);res.set('Content-Range','bytes '+start+'-'+end+'/'+size);}
    res.attachment(backup.site_id+'_'+backup.id+'.enc');
    res.set({'Content-Type':'application/octet-stream','Content-Length':String(end-start+1),'Accept-Ranges':'bytes','ETag':etag,'X-Backup-SHA256':backup.checksum});
    audit(req.user.id,'backup.download',backup.id,{range:res.statusCode===206});
    if(req.method==='HEAD')return res.end();
    await pipeline(await openRead(backup.path,{start,end}),res);
  }catch(error){if(!res.headersSent)next(error);else res.destroy();}
  finally{clear();}
});
const chainAncestors = backupId => { const ids = []; for (let link = linkOf(backupId); link?.parent_id && ids.length < 31; link = linkOf(link.parent_id)) ids.push(link.parent_id); return ids; };
app.post('/api/backups/:id/pin', (req, res) => {
  if(db.prepare('SELECT 1 FROM retention_operations WHERE backup_id=?').get(req.params.id))throw Object.assign(new Error('Package retention is in progress.'),{status:409});
  const data = z.object({ pinned: z.boolean() }).parse(req.body);
  const result = db.prepare('UPDATE backups SET pinned=? WHERE id=?').run(Number(data.pinned), req.params.id);
  if (!result.changes) notFound('Backup not found.');
  // A pinned backup must never be removed when its Object Lock ends.
  // Pinning an increment pins its whole chain: the packages it builds on are kept while it is (deletionBlocked), and none
  // of them is removed when an Object Lock ends.
  if (data.pinned) for (const backupId of [req.params.id, ...chainAncestors(req.params.id)]) { db.prepare('DELETE FROM retention_deferrals WHERE backup_id=?').run(backupId); db.prepare("UPDATE backup_copies SET delete_state=NULL,delete_after=NULL WHERE backup_id=? AND delete_state='deferred'").run(backupId); }
  audit(req.user.id, 'backup.pin', req.params.id, data); res.json(data);
});
app.post('/api/backups/:id/copies/:targetId/retry', requireAdmin, (req, res) => {
  const result = retryCopy(req.params.id, req.params.targetId);
  if (!result.found) notFound('Backup copy not found.');
  if (result.refused) return res.status(409).json({ error: result.refused === 'verified' ? 'This copy is already saved.' : result.refused === 'copying' ? 'This copy is being made now.' : 'This copy is being deleted.', code: 'copy_' + result.refused });
  audit(req.user.id, 'backup.copy_retry_requested', req.params.id, { targetId: req.params.targetId });
  res.status(202).json({ status: 'pending', nextAttemptAt: new Date(result.nextAttemptAt).toISOString() });
});
app.post('/api/backups/:id/scrub', (req,res)=>res.status(202).json(enqueueScrub(req.params.id,req.user.id)));
// A chosen restore source that is not a verified copy: 409 with its code, so the dialog can say which copy is unusable.
const sourceRefusal = error => { if (error.code === 'source_unavailable') throw Object.assign(new Error(error.message), { status: 409, expose: true, publicCode: error.code }); throw error; };
app.post('/api/backups/:id/restore-plan', async (req, res) => {
  const data = z.object({ serverId: z.uuid(), mode: z.enum(['copy', 'new-copy', 'replace']).default('copy'), mappings: z.record(z.string(), z.unknown()).default({}), sourceTargetId: z.string().min(1).max(64).nullable().optional() }).parse(req.body);
  const plan = await planRestore(req.params.id, { ...data, sourceTargetId: data.sourceTargetId || null, mode: data.mode === 'copy' ? 'new-copy' : data.mode }).catch(sourceRefusal);
  // Where it restores from (docs/backup-copies.md): the main copy first, then copies newest-verified first.
  res.json({ plan, sources: plan.sources, source: plan.source });
});
app.post('/api/backups/:id/restore', async (req, res) => {
  const data = z.object({ plan: z.object({ serverId: z.uuid(), mode: z.string(), mappings: z.record(z.string(), z.unknown()).default({}) }).passthrough(), confirmation: z.string(), sourceTargetId: z.string().min(1).max(64).nullable().optional() }).parse(req.body);
  const backup = db.prepare('SELECT * FROM backups WHERE id=?').get(req.params.id) || notFound('Backup not found.');
  if (data.confirmation !== getSite(backup.site_id).name) return res.status(409).json({ error: 'Type the site name to confirm the restore.' });
  // Never trust the executable flag, capabilities or blockers submitted by a client.
  const sourceTargetId = data.sourceTargetId || (typeof data.plan.sourceTargetId === 'string' ? data.plan.sourceTargetId : null);
  const plan = await planRestore(backup.id, { serverId: data.plan.serverId, mode: data.plan.mode, mappings: data.plan.mappings, sourceTargetId }).catch(sourceRefusal);
  res.status(202).json(await enqueueRestore(backup.id, plan, req.user.id));
});
app.patch('/api/maintenance', (req, res) => {
  const data = z.object({ title: z.string().min(1).max(150), message: z.string().min(1).max(1000), color: z.string().regex(/^#[a-fA-F0-9]{6}$/), layout:z.enum(['studio','editorial','compact']).default('studio'), theme:z.literal('light').default('light'), typeScale:z.enum(['balanced','bold']).default('balanced') }).parse(req.body);
  db.prepare("INSERT INTO settings VALUES ('maintenance',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(data));
  audit(req.user.id, 'maintenance.design'); res.json(data);
});
app.post('/api/sites/:id/maintenance', async (req, res) => { const data = z.object({ enabled: z.boolean() }).parse(req.body); res.json(await setMaintenance(req.params.id, data.enabled)); });
app.post('/api/sites/:id/maintenance/deploy', async (req, res) => res.json(await deployMaintenance(req.params.id)));
app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
const dist = path.resolve('dist');
// Unknown non-API paths get the app with a 404 status; the app renders its own 404 page.
if (existsSync(dist)) { app.use(express.static(dist, { index: false })); app.get('/{*path}', (req, res) => { if (req.path !== '/' && req.path !== '/index.html') res.status(404); res.sendFile(path.join(dist, 'index.html')); }); }
app.use((error, req, res, _next) => {
  if (res.headersSent) return res.end();
  if (error instanceof ZodError) return res.status(400).json({ error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
  // SSH and Docker errors can include remote output. Expose only errors intentionally sanitized by adapters.
  const message = error.expose === false ? 'Operation failed. Inspect the job status and source health.' : error.message;
  // Object-storage failures map only to 400/502/504 so a provider 401 never ends the admin session.
  const status = error.s3Code !== undefined || error.s3Status !== undefined ? ([400, 502, 504].includes(error.status) ? error.status : 502) : error.status || (error instanceof SyntaxError ? 400 : 422);
  res.status(status).json({ error: message || 'Operation failed.', ...reportErrorFields(error), ...(error.publicCode ? { code: error.publicCode } : {}) });
});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(config.port, config.host, () => console.log(`DockNest listening on port ${config.port}`));
}
