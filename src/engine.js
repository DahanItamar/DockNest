import { db, parse, id, audit } from './db.js';
import { config } from './config.js';
import { key } from './crypto.js';
import { remote, download, uploadStream } from './ssh.js';
import { backupDirectory, storageJoin, makeDirectory, statFile, openRead, openWrite, renameFile, removeFile, removeDirectory, storageCapacity } from './storage.js';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, readFile, appendFile, rm, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import { CronExpressionParser } from 'cron-parser';
const now=()=>new Date().toISOString();
export const testServer=server=>remote(server,{operation:'test'});
export const discover=server=>remote(server,{operation:'discover'});
export const browseProjectFiles=(server,containers,directory)=>remote(server,{operation:'list-project-files',containers,directory});
export async function verifyRecovery(job){
 if(job.type==='restore'){
  const details=typeof job.details==='string'?JSON.parse(job.details):job.details;
  const server=db.prepare('SELECT * FROM servers WHERE id=?').get(details.targetServerId);
  if(!server)throw new Error('Restore target not found');
  return remote(server,{operation:'verify-restore-recovery',job:job.id});
 }
 const {site,server}=siteInfo(job.site_id);
 return remote(server,{operation:'verify-recovery',job:job.id,config:site.config});
}
function siteInfo(siteId){const site=parse(db.prepare('SELECT * FROM sites WHERE id=?').get(siteId));if(!site)throw new Error('Site not found');const server=db.prepare('SELECT * FROM servers WHERE id=?').get(site.server_id);if(!server)throw new Error('Server not found');site.config.maintenance={required:site.config.maintenanceRequired!==false,directory:'/var/lib/docker-backup-manager/maintenance/'+site.id,publicUrl:site.config.domains?.[0]?'https://'+site.config.domains[0]:'',healthUrl:site.config.healthUrl||'',...site.config.maintenance};return {site,server};}
function busy(siteId){return db.prepare("SELECT id FROM jobs WHERE site_id=? AND status IN ('queued','running','recovery_required')").get(siteId);}
export function enqueueBackup(siteId,actor='scheduler'){
 siteInfo(siteId);if(busy(siteId))throw new Error('Site already has an active job or unresolved recovery');
 const job=id();db.exec('BEGIN IMMEDIATE');try{if(busy(siteId))throw new Error('Site already has active work');db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,'backup','queued','queued',?,?)").run(job,siteId,now(),'{}');audit(actor,'backup.enqueue',siteId,{job});db.exec('COMMIT');return {id:job};}catch(e){db.exec('ROLLBACK');throw e;}
}
export async function planRestore(backupId,{serverId,mode='new-copy',mappings={}}={}){
 const backup=parse(db.prepare('SELECT * FROM backups WHERE id=?').get(backupId));if(!backup?.verified)throw new Error('Verified backup not found');
 const target=db.prepare('SELECT * FROM servers WHERE id=?').get(serverId);if(!target)throw new Error('Target server not found');
 const capabilities=await testServer(target),blockers=[];
 if(mode!=='new-copy')blockers.push('Replacement restore requires a safety backup and rollback adapter; unavailable');
 if(capabilities.architecture!==backup.manifest.architecture)blockers.push('Target architecture does not match backup');
 if(backup.manifest.containers?.length!==1)blockers.push('Multi-container restore requires an isolated networking adapter');
 if(capabilities.uid!==0)blockers.push('Root SSH required to restore ownership');
 if(Object.keys(mappings||{}).length)blockers.push('This version restores to fresh owned paths with network none; custom port and host directory maps require reviewed offline restore');
 if(capabilities.freeBytes<backup.size*3+1024**3)blockers.push('Insufficient estimated target capacity');
 return {backupId,serverId,mode,mappings,capabilities,blockers,executable:blockers.length===0,isolated:true,networkMode:'none',warnings:['No inbound or outbound network: use docker exec for validation, then explicitly plan production routing.','Escaping links/device files in data archives and privileged host configuration are rejected during extraction.','Application-specific data validation is required after container health succeeds.'],plannedAt:now()};
}
export async function enqueueRestore(backupId,plan,actor='administrator'){
 const fresh=await planRestore(backupId,{serverId:plan?.serverId,mode:plan?.mode,mappings:plan?.mappings});
 if(!fresh.executable)throw new Error(fresh.blockers.join('; '));
 const backup=db.prepare('SELECT * FROM backups WHERE id=?').get(backupId);
 const restoreId=id(),jobId=id();
 db.exec('BEGIN IMMEDIATE');
 try{
  if(busy(backup.site_id))throw new Error('Site already has active work or unresolved recovery');
  db.prepare("INSERT INTO restores(id,backup_id,server_id,mode,plan,status,created_at) VALUES(?,?,?,?,?,'queued',?)").run(restoreId,backupId,fresh.serverId,fresh.mode,JSON.stringify(fresh),now());
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,'restore','queued','queued',?,?)").run(jobId,backup.site_id,now(),JSON.stringify({restoreId,backupId,targetServerId:fresh.serverId}));
  audit(actor,'restore.enqueue',backupId,{job:jobId,restoreId});db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 return {id:jobId,restoreId};
}
export async function setMaintenance(siteId,enabled){const {site,server}=siteInfo(siteId);const result=await remote(server,{operation:'maintenance',config:site.config,enabled});audit('administrator','maintenance.set',siteId,{enabled});return result;}
export async function deployMaintenance(siteId){const {site,server}=siteInfo(siteId);const row=db.prepare("SELECT value FROM settings WHERE key='maintenance'").get();const settings=row?JSON.parse(row.value):{};const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));let html=await readFile(new URL('../remote/maintenance.html',import.meta.url),'utf8');const color=/^#[0-9a-f]{6}$/i.test(settings.color||'')?settings.color:'#147d73';html=html.replace('<title>Brief maintenance</title>','<title>'+escape(settings.title||'Brief maintenance')+'</title>').replace('We will be back shortly',escape(settings.title||'We will be back shortly')).replace('This site is undergoing brief maintenance.',escape(settings.message||'This site is undergoing brief maintenance.')).replace('color:#172033','color:#172033;border-top:4px solid '+color);return remote(server,{operation:'deploy-maintenance',config:site.config,html:Buffer.from(html).toString('base64')});}
export async function encryptStream(input,output,secret=key()){
 const header=Buffer.concat([Buffer.from('DBM1'),randomBytes(12)]);
 const cipher=createCipheriv('aes-256-gcm',secret,header.subarray(4));cipher.setAAD(header);
 output.write(header);
 await pipeline(input,cipher,output,{end:false});
 await new Promise((resolve,reject)=>{output.once('finish',resolve);output.once('error',reject);output.end(cipher.getAuthTag());});
}
export async function verifyEncrypted(file,secret=key()){
 return (await inspectEncrypted(file,secret)).checksum;
}
async function inspectEncrypted(file,secret=key()){
 const size=(await statFile(file)).size;if(size<32)throw new Error('Truncated backup');
 const readRange=async(start,end)=>{const parts=[];for await(const chunk of await openRead(file,{start,end}))parts.push(chunk);return Buffer.concat(parts);};
 const header=await readRange(0,15),tag=await readRange(size-16,size-1);
 if(header.subarray(0,4).toString()!=='DBM1')throw new Error('Unsupported backup format');
 const decipher=createDecipheriv('aes-256-gcm',secret,header.subarray(4));decipher.setAAD(header);decipher.setAuthTag(tag);
 const hash=createHash('sha256'),plaintext=createHash('sha256');hash.update(header);
 await pipeline(await openRead(file,{start:16,end:size-17}),new Transform({transform(chunk,_e,cb){hash.update(chunk);cb(null,chunk);}}),decipher,new Writable({write(chunk,_e,cb){plaintext.update(chunk);cb();}}));
 hash.update(tag);return {checksum:hash.digest('hex'),plaintextChecksum:plaintext.digest('hex'),size,header,tag};
}
function stage(job,value){db.prepare("UPDATE jobs SET stage=? WHERE id=?").run(value,job);}
export async function retain(siteId){
 const policy=db.prepare('SELECT retention FROM policies WHERE site_id=?').get(siteId);const count=policy?.retention||7;
 const stale=db.prepare("SELECT * FROM backups WHERE site_id=? AND verified=1 AND pinned=0 ORDER BY captured_at DESC").all(siteId).slice(count);
 for(const backup of stale){
  if(db.prepare("SELECT id FROM restores WHERE backup_id=? AND status IN ('queued','running','recovery_required')").get(backup.id))continue;
  if(db.prepare('SELECT id FROM downloads WHERE backup_id=? AND expires_at>?').get(backup.id,Date.now()))continue;
  // Both backends verify canonical ownership before metadata or files are removed.
  await statFile(backup.path);
  db.exec('BEGIN IMMEDIATE');
  try{
   if(db.prepare('SELECT id FROM backups WHERE id=? AND pinned=1').get(backup.id)||db.prepare("SELECT id FROM restores WHERE backup_id=? AND status IN ('queued','running','recovery_required')").get(backup.id)){db.exec('COMMIT');continue;}
   if(db.prepare('SELECT id FROM downloads WHERE backup_id=? AND expires_at>?').get(backup.id,Date.now())){db.exec('COMMIT');continue;}
   db.prepare('DELETE FROM downloads WHERE backup_id=? AND expires_at<=?').run(backup.id,Date.now());
   const removed=db.prepare('DELETE FROM backups WHERE id=? AND pinned=0').run(backup.id);
   if(!removed.changes){db.exec('COMMIT');continue;}
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  await removeFile(backup.path);
 }
}

async function executeRestoreJob(job){
 const details=typeof job.details==='string'?JSON.parse(job.details):job.details;
 const restore=parse(db.prepare('SELECT * FROM restores WHERE id=?').get(details.restoreId));
 const backup=parse(db.prepare('SELECT * FROM backups WHERE id=?').get(details.backupId));
 const server=db.prepare('SELECT * FROM servers WHERE id=?').get(restore.server_id);
 try{
  db.prepare("UPDATE restores SET status='running' WHERE id=?").run(restore.id);
  stage(job.id,'verifying');
  const {checksum,size,header,tag,plaintextChecksum}=await inspectEncrypted(backup.path);if(checksum!==backup.checksum)throw new Error('Encrypted backup checksum differs from stored checksum');
  const decipher=createDecipheriv('aes-256-gcm',key(),header.subarray(4));decipher.setAAD(header);decipher.setAuthTag(tag);
  const staging=await remote(server,{operation:'prepare-restore',job:job.id});
  stage(job.id,'transferring');
  const pass=new Transform({transform(chunk,_e,cb){cb(null,chunk);}});pass.on('error',()=>{});
  const decrypting=pipeline(await openRead(backup.path,{start:16,end:size-17}),decipher,pass);
  decrypting.catch(error=>pass.destroy(error));
  try{await uploadStream(server,pass,staging.remotePath);await decrypting;}catch(error){pass.destroy(error);await decrypting.catch(()=>{});throw error;}
  // Only invoke extraction after the complete GCM-authenticated stream finishes.
  stage(job.id,'restoring');const result=await remote(server,{operation:'restore',job:job.id,plaintextChecksum});
  db.prepare("UPDATE restores SET status='completed',plan=? WHERE id=?").run(JSON.stringify({...restore.plan,result}),restore.id);
  db.prepare("UPDATE jobs SET status='completed',stage='completed',finished_at=?,details=? WHERE id=?").run(now(),JSON.stringify({...details,result}),job.id);
  audit('worker','restore.completed',backup.id,{job:job.id,containerId:result.containerId,networkMode:'none'});
 }catch(error){
  db.prepare("UPDATE restores SET status='failed' WHERE id=?").run(restore.id);
  db.prepare("UPDATE jobs SET status='failed',stage='failed',finished_at=?,error=? WHERE id=?").run(now(),String(error.message).slice(0,1000),job.id);
  audit('worker','restore.failed',backup.id,{job:job.id});
 }
}

export async function executeJob(job){
 if(job.type==='restore')return executeRestoreJob(job);
 let remoteStage='preflight',contacted=false,artifactDirectory=null,publishedBackup=false;
 const {site,server}=siteInfo(job.site_id);
 try{
  stage(job.id,'preflight');
  const used=db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM backups').get().bytes;
  const capacity=await storageCapacity(used);if(capacity.available<1024**3)throw new Error('Backup storage has less than 1 GiB estimated free');
  const backupId=id(),directory=backupDirectory(server,site,backupId);
  await makeDirectory(directory);artifactDirectory=directory;
  contacted=true;
  const result=await remote(server,{operation:'capture',job:job.id,config:site.config},value=>{remoteStage=value;stage(job.id,value);});
  // Secrets live only inside authenticated encrypted payload; metadata uses a redacted manifest.
  const manifest={formatVersion:1,complete:result.manifest.complete,capturedAt:result.manifest.capturedAt,downtimeSeconds:result.manifest.downtimeSeconds,containerDowntimeSeconds:result.manifest.containerDowntimeSeconds,visitorDowntimeSeconds:result.manifest.visitorDowntimeSeconds,shutdownEvidence:result.manifest.shutdownEvidence,originalImages:result.manifest.originalImages.map(image=>({id:image.Id,digests:image.RepoDigests||[]})),architecture:result.manifest.architecture,restoreTested:false,containers:result.manifest.containers.map(c=>({id:c.Id,name:c.Name,image:c.Config.Image,mounts:c.Mounts.map(m=>({type:m.Type,destination:m.Destination}))}))};
  const temporary=storageJoin(directory,'payload.enc.partial'),published=storageJoin(directory,'payload.enc');
  stage(job.id,'transferring');
  const pass=new Transform({transform(c,e,cb){cb(null,c);}});
  pass.on('error',()=>{});
  const writing=encryptStream(pass,await openWrite(temporary));
  writing.catch(error=>pass.destroy(error));
  try{await download(server,result.remotePath,pass);await writing;}catch(error){pass.destroy(error);await writing.catch(()=>{});throw error;}
  stage(job.id,'verifying');const checksum=await verifyEncrypted(temporary);
  await renameFile(temporary,published);const size=(await statFile(published)).size;
  db.prepare('INSERT INTO backups(id,site_id,job_id,captured_at,path,size,checksum,manifest,pinned,verified,created_at) VALUES(?,?,?,?,?,?,?,?,0,1,?)').run(backupId,site.id,job.id,new Date(result.manifest.capturedAt*1000).toISOString(),published,size,checksum,JSON.stringify(manifest),now());
  publishedBackup=true;
  db.prepare("UPDATE jobs SET status='completed',stage='completed',finished_at=?,details=? WHERE id=?").run(now(),JSON.stringify({backupId,downtimeSeconds:manifest.downtimeSeconds}),job.id);
  audit('worker','backup.completed',site.id,{job:job.id,backupId,size});
  await remote(server,{operation:'cleanup',root:result.root}).catch(()=>{});
  await retain(site.id).catch(()=>audit('worker','retention.failed',site.id,{job:job.id}));
 }catch(error){
  if(artifactDirectory&&!publishedBackup)await removeDirectory(artifactDirectory).catch(()=>{});
  const recovery=contacted && !['source_ready','packing'].includes(remoteStage) && !(remoteStage==='preflight'&&error.remoteReported);
  db.prepare('UPDATE jobs SET status=?,stage=?,finished_at=?,error=? WHERE id=?').run(recovery?'recovery_required':'failed',recovery?'recovery_required':'failed',now(),String(error.message).slice(0,1000),job.id);
  audit('worker','backup.failed',job.site_id,{job:job.id,recoveryRequired:recovery});
 }
}
export function tickScheduler(currentDate=new Date()){
 const policies=db.prepare('SELECT * FROM policies WHERE enabled=1').all();
 for(const policy of policies){
  try{
   const next=policy.next_run?new Date(policy.next_run):null;
   // Keep a missed occurrence due while the site is busy; coalesce it once free.
   if(next&&next<=currentDate){if(busy(policy.site_id))continue;enqueueBackup(policy.site_id);}
   if(!next||next<=currentDate){
    const upcoming=CronExpressionParser.parse(policy.schedule,{tz:policy.timezone||'UTC',currentDate}).next().toISOString();
    db.prepare('UPDATE policies SET next_run=? WHERE site_id=?').run(upcoming,policy.site_id);
   }
  }catch{audit('scheduler','schedule.invalid',policy.site_id,{});}
 }
}
export function claimJob(){
 db.exec('BEGIN IMMEDIATE');
 try{
  const job=db.prepare("SELECT j.* FROM jobs j WHERE j.status='queued' AND NOT EXISTS(SELECT 1 FROM jobs a JOIN sites s ON a.site_id=s.id WHERE a.status IN ('running','recovery_required') AND COALESCE(json_extract(a.details,'$.targetServerId'),s.server_id)=COALESCE(json_extract(j.details,'$.targetServerId'),(SELECT server_id FROM sites WHERE id=j.site_id))) ORDER BY j.created_at LIMIT 1").get();
  if(job)db.prepare("UPDATE jobs SET status='running',stage='preflight',started_at=? WHERE id=?").run(now(),job.id);
  db.exec('COMMIT');return job;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
