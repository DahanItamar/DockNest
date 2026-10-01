import express from 'express';
import helmet from 'helmet';
import { z, ZodError } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { statfsSync, statSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { storageCapacity, statFile, openRead } from './storage.js';
import { storageTargets } from './storage-targets.js';
import { config, trustedOrigins } from './config.js';
import { db, parse, id, audit, transaction } from './db.js';
import { seal } from './crypto.js';
import { auth, session, requireAuth, csrf, rateLimit, requireAdmin } from './auth.js';
import { access } from './access.js';
import { prepareServerKey, serverReportCommand } from './server-onboarding.js';
import { testServer, discover, enqueueBackup, planRestore, enqueueRestore, setMaintenance, deployMaintenance, verifyRecovery } from './engine.js';

export const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"] } }, strictTransportSecurity: config.secureCookies ? undefined : false }));
app.use(express.json({ limit: '128kb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !trustedOrigins.has(req.headers.origin)) return res.status(403).json({ error: 'Request origin does not match APP_ORIGIN. Open the configured application address.' });
  next();
});
app.get('/healthz', (_req, res) => { db.prepare('SELECT 1').get(); res.json({ status: 'ok' }); });
app.use('/api', session);
app.use('/api/auth', auth);
app.use('/api', requireAuth, csrf, rateLimit('api', 600, 60 * 1000));
app.use('/api/access', access);
app.use('/api/storage-targets',storageTargets);
const now = () => new Date().toISOString();
const notFound = message => { const error = new Error(message); error.status = 404; throw error; };
const getServer = serverId => db.prepare('SELECT * FROM servers WHERE id=?').get(serverId) || notFound('Server not found.');
const getSite = siteId => parse(db.prepare('SELECT * FROM sites WHERE id=?').get(siteId)) || notFound('Site not found.');
const safeServer = row => { const { private_key, ...rest } = parse(row); return rest; };
const view = row => {
  const parsed = parse(row), converted = { ...parsed };
  for (const [name, value] of Object.entries(parsed)) converted[name.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
  if ('verified' in converted) converted.status = converted.verified ? 'Verified' : 'Unverified';
  if (converted.manifest?.downtimeSeconds != null) converted.downtimeMs = converted.manifest.downtimeSeconds * 1000;
  if (converted.detail) converted.details = converted.detail;
  if (converted.target) converted.targetId = converted.target;
  return converted;
};
const linuxPath = z.string().regex(/^\/[a-zA-Z0-9_./-]+$/).refine(value => !value.split('/').includes('..'), 'Parent path traversal is not allowed.');
const healthUrl = z.string().max(2048).refine(value => { if (!value) return true; try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }, 'Use an HTTP(S) URL without embedded credentials.');
const siteSchema = z.object({
  serverId: z.uuid(), name: z.string().trim().min(1).max(100),
  config: z.object({
    containers: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)).min(1).max(30),
    stagingRoot: linuxPath.refine(value => value !== '/', 'Use a dedicated staging directory.').default('/var/lib/docknest'),
    exclusiveSourcesConfirmed: z.boolean().default(false),
    stopTimeout: z.number().int().min(10).max(600).default(60),
    shutdownProfile: z.enum(['generic', 'postgres', 'mysql']).default('generic'),
    cleanShutdownConfirmed: z.boolean().default(false),
    configFiles: z.array(linuxPath).max(50).default([]),
    composeFiles: z.array(linuxPath).max(20).default([]),
    externalReferencesConfirmed: z.boolean().default(false),
    maintenanceRequired: z.boolean().default(true),
    domains: z.array(z.string().regex(/^[a-zA-Z0-9.-]+$/)).max(20).default([]),
    healthUrl: healthUrl.default(''),
    maintenance: z.object({ required: z.boolean(), directory: linuxPath, publicUrl: healthUrl, healthUrl }).optional(),
  }),
});
const serverSchema = z.object({
  name: z.string().trim().min(1).max(100), host: z.string().regex(/^[a-zA-Z0-9_.:-]{1,253}$/),
  port: z.number().int().min(1).max(65535).default(22), username: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
  privateKey: z.string().min(50).max(30000), hostKey: z.string().regex(/^(?:[a-fA-F0-9]{64}|SHA256:[A-Za-z0-9+/]{43}=?)$/),
});
const fingerprint = value => value.startsWith('SHA256:') ? Buffer.from(value.slice(7), 'base64').toString('hex') : value.toLowerCase();
app.get('/api/state', async (_req, res) => {
  const backups = db.prepare('SELECT * FROM backups ORDER BY captured_at DESC LIMIT 1000').all().map(parse);
  const storedBytes = db.prepare('SELECT COALESCE(SUM(size),0) AS total FROM backups').get().total;
  const storage = await storageCapacity(storedBytes);
  const settings = db.prepare("SELECT value FROM settings WHERE key='maintenance'").get();
  const heartbeat = db.prepare("SELECT value FROM settings WHERE key='worker_heartbeat'").get();
  const worker = heartbeat ? JSON.parse(heartbeat.value) : { running: false, lastSeen: null };
  worker.online = worker.running && Date.now() - Date.parse(worker.lastSeen) < 60000;
  res.json({ servers: db.prepare('SELECT * FROM servers ORDER BY created_at').all().map(safeServer).map(view), sites: db.prepare('SELECT * FROM sites ORDER BY created_at').all().map(view), policies: db.prepare('SELECT * FROM policies').all().map(view), jobs: db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 500').all().map(view), backups: backups.map(({ path: _path, ...backup }) => view(backup)), restores: db.prepare('SELECT * FROM restores ORDER BY created_at DESC LIMIT 500').all().map(view), audit: db.prepare('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 250').all().map(view), worker, storage: { used: storedBytes, ...storage }, maintenance: settings ? JSON.parse(settings.value) : { title: 'Briefly under maintenance', message: 'We are creating a safe backup. Please check back in a few minutes.', color: '#147d73' } });
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
  db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,status,capabilities,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(serverId,data.name,data.host,data.port,data.username,server.private_key,server.host_key,'connected',JSON.stringify(capabilities),now());
  audit(req.user.id,'server.connected',serverId);
  res.status(201).json(safeServer(getServer(serverId)));
});
app.post('/api/servers', requireAdmin, (req, res) => {
  const data = serverSchema.parse(req.body), serverId = id();
  db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES (?,?,?,?,?,?,?,?)').run(serverId, data.name, data.host, data.port, data.username, seal(data.privateKey), fingerprint(data.hostKey), now());
  audit(req.user.id, 'server.create', serverId); res.status(201).json(safeServer(getServer(serverId)));
});
app.patch('/api/servers/:id', requireAdmin, (req, res) => {
  const previous = getServer(req.params.id);
  const data = serverSchema.extend({ privateKey: serverSchema.shape.privateKey.optional(), hostKeyConfirmation: z.literal(true).optional() }).parse(req.body);
  if (fingerprint(data.hostKey) !== previous.host_key && !data.hostKeyConfirmation) return res.status(409).json({ error: 'SSH host key changed. Verify the new fingerprint independently and explicitly confirm the change.' });
  db.prepare("UPDATE servers SET name=?,host=?,port=?,username=?,private_key=?,host_key=?,status='unchecked',capabilities=NULL WHERE id=?").run(data.name, data.host, data.port, data.username, data.privateKey ? seal(data.privateKey) : previous.private_key, fingerprint(data.hostKey), previous.id);
  audit(req.user.id, 'server.update', previous.id); res.json(safeServer(getServer(previous.id)));
});
app.post('/api/servers/:id/test', async (req, res) => {
  const server = getServer(req.params.id);
  try {
    const result = await testServer(server);
    db.prepare("UPDATE servers SET status='connected',capabilities=? WHERE id=?").run(JSON.stringify(result), server.id);
    audit(req.user.id, 'server.test', server.id, { success: true }); res.json(result);
  } catch (error) { db.prepare("UPDATE servers SET status='failed' WHERE id=?").run(server.id); throw error; }
});
app.get('/api/servers/:id/discover', async (req, res) => {
  const result = await discover(getServer(req.params.id));
  const containers = Array.isArray(result) ? result : result.containers || [];
  res.json({ containers: containers.map(container => ({ ...container, Config: { ...container.Config, Env: (container.Config?.Env || []).map(value => value.split('=')[0] + '=[redacted]') } })) });
});
function normalizedSite(data, siteId) {
  const settings = db.prepare("SELECT value FROM settings WHERE key='maintenance'").get();
  const maintenance = data.config.maintenance || { required: data.config.maintenanceRequired, directory: `${data.config.stagingRoot}/maintenance/${siteId}`, publicUrl: data.config.domains[0] ? 'https://' + data.config.domains[0] : '', healthUrl: data.config.healthUrl };
  for (const value of [maintenance.healthUrl, maintenance.publicUrl]) {
    if (value && !['http:', 'https:'].includes(new URL(value).protocol)) throw new Error('Maintenance URLs must use HTTP or HTTPS.');
  }
  return { ...data.config, maintenance, maintenancePage: settings ? JSON.parse(settings.value) : { title: 'Briefly under maintenance', message: 'We will be back in a few minutes.', color: '#147d73' } };
}
app.post('/api/sites', (req, res) => {
  const data = siteSchema.parse(req.body); getServer(data.serverId); const siteId = id();
  const settings = normalizedSite(data, siteId);
  db.prepare('INSERT INTO sites VALUES (?,?,?,?,?)').run(siteId, data.serverId, data.name, JSON.stringify(settings), now());
  db.prepare('INSERT INTO policies VALUES (?,0,?,?,7,NULL)').run(siteId, '0 2 * * *', 'Asia/Jerusalem');
  audit(req.user.id, 'site.create', siteId); res.status(201).json(getSite(siteId));
});
app.patch('/api/sites/:id', (req, res) => {
  const site = getSite(req.params.id), data = siteSchema.parse(req.body); getServer(data.serverId);
  if (db.prepare("SELECT 1 FROM jobs WHERE site_id=? AND status IN ('queued','running','recovery_required')").get(site.id)) return res.status(409).json({ error: 'Resolve the active job before changing capture settings.' });
  db.prepare('UPDATE sites SET name=?,server_id=?,config=? WHERE id=?').run(data.name, data.serverId, JSON.stringify(normalizedSite(data, site.id)), site.id);
  audit(req.user.id, 'site.update', site.id); res.json(getSite(site.id));
});
app.post('/api/sites/:id/policy', (req, res) => {
  const site = getSite(req.params.id);
  const data = z.object({ enabled: z.boolean(), schedule: z.string().max(100), timezone: z.string().max(100), retention: z.number().int().min(1).max(1000) }).parse(req.body);
  new Intl.DateTimeFormat('en', { timeZone: data.timezone });
  const next = CronExpressionParser.parse(data.schedule, { tz: data.timezone }).next().toISOString();
  db.prepare('UPDATE policies SET enabled=?,schedule=?,timezone=?,retention=?,next_run=? WHERE site_id=?').run(Number(data.enabled), data.schedule, data.timezone, data.retention, next, site.id);
  audit(req.user.id, 'policy.update', site.id, data); res.json({ ...data, next_run: next });
});
app.post('/api/sites/:id/backup', (req, res) => res.status(202).json(enqueueBackup(req.params.id, req.user.id)));
app.get('/api/jobs/:id', (req, res) => res.json(parse(db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id)) || notFound('Job not found.')));
app.post('/api/jobs/:id/recovery', async (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id) || notFound('Job not found.');
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
app.get('/api/backups/:id/download', async (req, res, next) => {
  const leaseId=id();
  const backup=transaction(()=>{
    const row=db.prepare('SELECT * FROM backups WHERE id=? AND verified=1').get(req.params.id)||notFound('Verified backup not found.');
    db.prepare('INSERT INTO downloads VALUES (?,?,?)').run(leaseId,row.id,Date.now()+120000);
    return row;
  });
  let cleared=false;
  const interval=setInterval(()=>db.prepare('UPDATE downloads SET expires_at=? WHERE id=?').run(Date.now()+120000,leaseId),30000);
  const clear=()=>{if(cleared)return;cleared=true;clearInterval(interval);db.prepare('DELETE FROM downloads WHERE id=?').run(leaseId);};
  res.once('close',clear);res.once('finish',clear);
  try{
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
app.post('/api/backups/:id/pin', (req, res) => {
  const data = z.object({ pinned: z.boolean() }).parse(req.body);
  const result = db.prepare('UPDATE backups SET pinned=? WHERE id=?').run(Number(data.pinned), req.params.id);
  if (!result.changes) notFound('Backup not found.');
  audit(req.user.id, 'backup.pin', req.params.id, data); res.json(data);
});
app.post('/api/backups/:id/restore-plan', async (req, res) => {
  const data = z.object({ serverId: z.uuid(), mode: z.enum(['copy', 'new-copy', 'replace']).default('copy'), mappings: z.record(z.string(), z.unknown()).default({}) }).parse(req.body);
  const plan = await planRestore(req.params.id, { ...data, mode: data.mode === 'copy' ? 'new-copy' : data.mode });
  res.json({ plan });
});
app.post('/api/backups/:id/restore', async (req, res) => {
  const data = z.object({ plan: z.object({ serverId: z.uuid(), mode: z.string(), mappings: z.record(z.string(), z.unknown()).default({}) }).passthrough(), confirmation: z.string() }).parse(req.body);
  const backup = db.prepare('SELECT * FROM backups WHERE id=?').get(req.params.id) || notFound('Backup not found.');
  if (data.confirmation !== getSite(backup.site_id).name) return res.status(409).json({ error: 'Type the site name to confirm the restore.' });
  // Never trust the executable flag, capabilities or blockers submitted by a client.
  const plan = await planRestore(backup.id, { serverId: data.plan.serverId, mode: data.plan.mode, mappings: data.plan.mappings });
  res.status(202).json(await enqueueRestore(backup.id, plan, req.user.id));
});
app.patch('/api/maintenance', (req, res) => {
  const data = z.object({ title: z.string().min(1).max(150), message: z.string().min(1).max(1000), color: z.string().regex(/^#[a-fA-F0-9]{6}$/) }).parse(req.body);
  db.prepare("INSERT INTO settings VALUES ('maintenance',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(data));
  audit(req.user.id, 'maintenance.design'); res.json(data);
});
app.post('/api/sites/:id/maintenance', async (req, res) => { const data = z.object({ enabled: z.boolean() }).parse(req.body); res.json(await setMaintenance(req.params.id, data.enabled)); });
app.post('/api/sites/:id/maintenance/deploy', async (req, res) => res.json(await deployMaintenance(req.params.id)));
app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
const dist = path.resolve('dist');
if (existsSync(dist)) { app.use(express.static(dist, { index: false })); app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html'))); }
app.use((error, req, res, _next) => {
  if (res.headersSent) return res.end();
  if (error instanceof ZodError) return res.status(400).json({ error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
  // SSH and Docker errors can include remote output. Expose only errors intentionally sanitized by adapters.
  const message = error.expose === false ? 'Operation failed. Inspect the job status and source health.' : error.message;
  res.status(error.status || (error instanceof SyntaxError ? 400 : 422)).json({ error: message || 'Operation failed.' });
});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(config.port, config.host, () => console.log(`DockNest listening on port ${config.port}`));
}
