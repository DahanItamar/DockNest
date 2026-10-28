import {renderMaintenancePage} from '../shared/maintenance-design.js';
import { db, parse, id, audit, transaction } from './db.js';
import { config } from './config.js';
import { deploymentHeld, requireNoDeploymentHold as requireNoHold } from './deployment-hold.js';
import { recordVerification } from './recovery-evidence.js';
import { preparePublication,completePreparedMetadata,authenticatePublication,finalizePublication,claimDeletion,finishDeletion,deletionDeferred } from './artifact-journal.js';
import { key } from './crypto.js';
import { remote, remoteCaptureStream, download, uploadStream } from './ssh.js';
import { backupDirectory, storageJoin, makeDirectory, statFile, openRead, openWrite, renameFile, removeFile, storageCapacity, checkStorageReadiness, syncFile } from './storage.js';
import { backupFilename } from './backup-layout.js';
import { siteMainStorage, targetSummary, targetIdOfPath } from './site-storage.js';
import { retainCopies } from './backup-copies.js';
import { packagePath } from './artifact-journal.js';
import { storedProbeProblem } from './probe-url.js';
import { CLAIMABLE_JOB_SQL } from './job-claim.js';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, readFile, appendFile, rm, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import { CronExpressionParser } from 'cron-parser';
import { decideCapture,chainRecord,clearForceFull,setForceFull,FORCE,linkOf,loadChain,verifyChainLinks,inChain,ChainError,hasDependents } from './incremental.js';
const now=()=>new Date().toISOString();
export const testServer=server=>remote(server,{operation:'test'});
export const discover=server=>remote(server,{operation:'discover'});
export const browseProjectFiles=(server,containers,directory)=>remote(server,{operation:'list-project-files',containers,directory});
// Backup transport; tests replace these members to drive executeJob without SSH.
export const transport={remote,remoteCaptureStream,download,uploadStream};
export async function planBackup(siteId){const {site,server}=siteInfo(siteId);return transport.remote(server,{operation:'plan',config:site.config});}
// Boot recovery copies these files onto the host; other operations stream the current helper each time.
const bootBundle=await Promise.all(['../remote/helper.py','../remote/boot_recovery.py'].map(file=>readFile(new URL(file,import.meta.url))));
export const bootRecoveryBundle=Object.freeze({sha256:createHash('sha256').update(bootBundle[0]).update('\0').update(bootBundle[1]).digest('hex'),helperVersion:Number(/^VERSION=(\d+)$/m.exec(bootBundle[0].toString())?.[1]||0)});
export function bootRecoveryStatus(siteId){
 const row=db.prepare('SELECT bundle_sha256,helper_version,installed_at FROM boot_recovery_installs WHERE site_id=?').get(siteId);
 // Copies installed before fingerprints were recorded are only known from the audit trail and are treated as outdated.
 if(!row)return db.prepare("SELECT 1 FROM audit_events WHERE action='boot_recovery.installed' AND target=?").get(siteId)?{installed:true,installedAt:null,helperVersion:null,outdated:true}:{installed:false,installedAt:null,helperVersion:null,outdated:false};
 return {installed:true,installedAt:row.installed_at,helperVersion:row.helper_version,outdated:row.bundle_sha256!==bootRecoveryBundle.sha256};
}
export async function installBootRecovery(siteId){const {site,server}=siteInfo(siteId);if(busy(siteId))throw new Error('Finish active work before installing boot recovery');const [helper,bootHelper]=bootBundle;const result=await remote(server,{operation:'install-boot-recovery',config:site.config,helper:helper.toString('base64'),bootHelper:bootHelper.toString('base64')});db.prepare('INSERT INTO boot_recovery_installs VALUES(?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET bundle_sha256=excluded.bundle_sha256,helper_version=excluded.helper_version,installed_at=excluded.installed_at').run(siteId,bootRecoveryBundle.sha256,bootRecoveryBundle.helperVersion,now());audit('administrator','boot_recovery.installed',siteId,{bundleSha256:bootRecoveryBundle.sha256});return result;}
export async function checkReadiness(siteId){
 const {site,server}=siteInfo(siteId);
 if(busy(siteId))throw Object.assign(new Error('Finish active work or resolve recovery before checking readiness.'),{status:409});
 const result=await remote(server,{operation:'readiness',config:site.config});
 const probe=storedProbeProblem(site.config);if(probe)result.checks.unshift({name:'Probe URL policy',ok:false,message:probe.message});
 try{await checkStorageReadiness(siteMainStorage(siteId));result.checks.push({name:'Backup storage connection',ok:true,message:'Storage is reachable with at least 1 GB available. This check reads directory metadata; verify write access when connecting storage.'});}catch{result.checks.push({name:'Backup storage connection',ok:false,message:'Connect a backup storage destination, verify its access and ensure at least 1 GB is available.'});}
 result.ready=result.checks.every(check=>check.ok||check.required===false);
 return result;
}
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
// Restore tests never make their site busy: a test runs on its test server and its clean-up blocks only that server.
function busy(siteId){return db.prepare("SELECT id FROM jobs WHERE site_id=? AND type NOT IN ('site-move','restore-test') AND status IN ('queued','running','recovery_required')").get(siteId);}
export const busySite=siteId=>Boolean(busy(siteId));
// A site in an unfinished move (past its preview, before it is done) refuses other mutating work; the move's own
// backups pass the actor `move:<id>`.
const movesTable=()=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='site_moves'").get();
export function movingSite(siteId){if(!movesTable())return null;return db.prepare("SELECT id,state FROM site_moves WHERE site_id=? AND state NOT IN ('draft','rolled_back','cancelled','failed','switched_back','cleaned','completed','retention_expired')").get(siteId)||null;}
export function requireNotMoving(siteId,actor=''){const move=movingSite(siteId);if(move&&actor!=='move:'+move.id)throw Object.assign(new Error('This site is being moved. Wait for the move to finish or cancel it first.'),{status:409,code:'SITE_MOVING'});}
const requireNoDeploymentHold=()=>requireNoHold(db);
export function enqueueBackup(siteId,actor='scheduler',extra={}){
 requireNoDeploymentHold();requireNotMoving(siteId,actor);
 // Upgrade safety: a stored probe URL the policy refuses never blocks the backup. The helper skips that probe
 // (container health only) and the job carries a warning until the site is edited.
 const probe=storedProbeProblem(siteInfo(siteId).site.config);
 if(busy(siteId))throw new Error('Site already has an active job or unresolved recovery');
 const job=id();db.exec('BEGIN IMMEDIATE');try{requireNoDeploymentHold();if(db.prepare('SELECT 1 FROM site_archives WHERE site_id=?').get(siteId))throw Object.assign(new Error('This site was removed from active sites.'),{status:409});if(busy(siteId))throw new Error('Site already has active work');db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,'backup','queued','queued',?,?)").run(job,siteId,now(),JSON.stringify({...(probe?{warnings:[probe.message]}:{}),...(extra.moveId?{moveId:extra.moveId,keepStopped:!!extra.keepStopped}:{})}));audit(actor,'backup.enqueue',siteId,{job,...(probe?{probePolicy:probe.field}:{})});db.exec('COMMIT');return {id:job};}catch(e){db.exec('ROLLBACK');throw e;}
}
export function enqueueScrub(backupId,actor='administrator'){
 requireNoDeploymentHold();
 const backup=db.prepare('SELECT * FROM backups WHERE id=?').get(backupId);if(!backup)throw new Error('Backup not found');
 db.exec('BEGIN IMMEDIATE');
 try{requireNoDeploymentHold();if(db.prepare('SELECT 1 FROM retention_operations WHERE backup_id=?').get(backupId))throw new Error('Package retention is in progress');if(busy(backup.site_id))throw new Error('Site already has active work');const job=id();db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,'scrub','queued','queued',?,?)").run(job,backup.site_id,now(),JSON.stringify({backupId}));audit(actor,'backup.scrub.enqueue',backupId,{job});db.exec('COMMIT');return {id:job};}catch(error){db.exec('ROLLBACK');throw error;}
}
async function executeScrub(job){
 const {backupId}=JSON.parse(job.details);const backup=db.prepare('SELECT * FROM backups WHERE id=?').get(backupId);
 // An increment is only as good as its chain: its scrub authenticates every package it builds on and every link
 // (docs/incremental-backups.md). A backup outside a chain is checked alone, exactly as before.
 let members=null,damaged=null,chainError=null;
 if(backup&&linkOf(backupId)){try{members=verifyChainLinks(loadChain(backupId));}catch(error){chainError=error;}}
 try{
  stage(job.id,'verifying');
  if(chainError)throw chainError;
  for(const member of members??[backup]){if(await verifyEncrypted(packagePath(member)).catch(()=>null)!==member.checksum){damaged=member.id===backupId?null:member;throw new Error('Stored checksum differs');}}
  transaction(()=>{if(!finishJob(job.id,"status='completed',stage='completed',finished_at=?",now()))return;for(const member of members??[backup]){recordVerification(member.id,'integrity',{status:'passed',method:member.id===backupId?'full AES-256-GCM authentication and SHA256':'full AES-256-GCM authentication and SHA256, as part of the chain of '+backupId},job.id);db.prepare('UPDATE backups SET verified=1 WHERE id=?').run(member.id);}audit('worker','backup.scrub.completed',backupId,{job:job.id,...(members?{chainLength:members.length}:{})});});
 }
 catch{
  const chained=Boolean(chainError||damaged),message=chained?(chainError??new ChainError(damaged.id)).message:'Package integrity could not be verified; review storage and recovery evidence.';
  transaction(()=>{if(!finishJob(job.id,"status='failed',stage='failed',finished_at=?,error=?",now(),message))return;if(backup){recordVerification(backupId,'integrity',{status:'failed',method:chained?'a package this backup depends on is missing or failed authentication':'full package authentication unavailable or failed'},job.id);db.prepare('UPDATE backups SET verified=0 WHERE id=?').run(backupId);}if(damaged){recordVerification(damaged.id,'integrity',{status:'failed',method:'full package authentication failed during the chain check of '+backupId},job.id);db.prepare('UPDATE backups SET verified=0 WHERE id=?').run(damaged.id);}audit('worker','backup.scrub.failed',backupId,{job:job.id,...(damaged?{damaged:damaged.id}:{})});});
 }
}
// Where a backup can be restored from (docs/backup-copies.md, "Restore"): the main copy first, then its copies, verified
// ones newest-verified first. A main package that aged out (its copies keep the backup) is listed as missing.
export function restoreSources(backup){
 const removed=db.prepare('SELECT original_path FROM backup_main_removed WHERE backup_id=?').get(backup.id);
 const mainPath=backup.path,mainId=targetIdOfPath(mainPath); // backups.path always names the main package
 const sources=[{targetId:mainId,name:targetSummary(mainId)?.name??'Removed destination',role:'main',status:removed?'missing':backup.verified?'verified':'failed',verifiedAt:removed?null:backup.created_at,path:removed?null:mainPath}];
 const copies=db.prepare("SELECT target_id,path,status,verified_at FROM backup_copies WHERE backup_id=? AND status<>'deleted' ORDER BY status<>'verified',verified_at DESC,target_id").all(backup.id);
 for(const copy of copies)sources.push({targetId:copy.target_id,name:targetSummary(copy.target_id)?.name??'Removed destination',role:'copy',status:copy.status,verifiedAt:copy.verified_at,path:copy.status==='verified'?copy.path:null});
 return sources;
}
const publicSource=({path:_path,...source})=>source;
// The first source that authenticates in full against the stored checksum. Without a choice: the main copy, then each
// verified copy. With `sourceTargetId`: only that one.
async function authenticatedSource(backup,sourceTargetId=null){
 const candidates=restoreSources(backup).filter(source=>source.path&&(sourceTargetId?source.targetId===sourceTargetId:source.role==='main'||source.status==='verified'));
 for(const source of candidates){
  try{const inspected=await inspectEncrypted(source.path);if(inspected.checksum===backup.checksum)return {...inspected,source};}catch{/* Try the next source. */}
 }
 throw new Error(sourceTargetId?'The chosen copy could not be read or did not authenticate':'Encrypted backup checksum differs from stored checksum');
}
// Every package a restore of `backup` needs, full first, each authenticated in full (stored size, SHA-256 and GCM tag)
// from its first readable source after every chain link was checked. Nothing is sent before all of them pass. A backup
// outside a chain is one package, read exactly as before. With `sourceTargetId` the chosen copy is used for the backup
// itself; the packages it builds on prefer that destination and fall back to any verified source (the bytes are the same).
async function authenticatedChain(backup,sourceTargetId=null){
 const members=verifyChainLinks(loadChain(backup.id));
 if(!inChain(members))return [{member:members[0],...await authenticatedSource(backup,sourceTargetId)}];
 const chain=[];
 for(const member of members){
  const own=member.id===backup.id;let found;
  try{found=own?await authenticatedSource(member,sourceTargetId):await authenticatedSource(member,sourceTargetId).catch(()=>authenticatedSource(member));}
  catch(error){if(own)throw error;throw new ChainError(member.id);}
  if(found.size!==member.size){if(own)throw new Error('Encrypted backup checksum differs from stored checksum');throw new ChainError(member.id);}
  chain.push({member,...found});
 }
 return chain;
}
const chainDescriptor=chain=>chain.map(item=>({plaintextChecksum:item.plaintextChecksum,backupId:item.member.id,sha256:item.member.checksum}));
function chainPaths(staging,length){
 const paths=staging?.remotePaths;
 if(!Array.isArray(paths)||paths.length!==length||paths.some(path=>typeof path!=='string'||!path.startsWith('/')))throw new Error('The server did not prepare room for every backup in the chain. Update the server helper and try again.');
 return paths;
}
// Streams one authenticated package, decrypted only inside the GCM-authenticated stream, to `remotePath`.
async function sendPackage(server,item,remotePath,{signal,upload=transport.uploadStream}={}){
 const {size,header,tag,source}=item;
 const decipher=createDecipheriv('aes-256-gcm',key(),header.subarray(4));decipher.setAAD(header);decipher.setAuthTag(tag);
 const pass=new Transform({transform(chunk,_e,cb){cb(null,chunk);}});pass.on('error',()=>{});
 const stop=()=>pass.destroy(Object.assign(new Error('DockNest stopped this step.'),{aborted:true}));
 if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true});
 const decrypting=pipeline(await openRead(source.path,{start:16,end:size-17}),decipher,pass);decrypting.catch(error=>pass.destroy(error));
 try{await upload(server,pass,remotePath);await decrypting;}catch(error){pass.destroy(error);await decrypting.catch(()=>{});throw error;}
 finally{signal?.removeEventListener('abort',stop);}
}
export async function planRestore(backupId,{serverId,mode='new-copy',mappings={},sourceTargetId=null}={}){
 if(db.prepare('SELECT 1 FROM retention_operations WHERE backup_id=?').get(backupId))throw new Error('Package retention is in progress');
 const backup=parse(db.prepare('SELECT * FROM backups WHERE id=?').get(backupId));
 if(!backup)throw new Error('Verified backup not found');
 // A main copy that is missing or failed authentication can still be restored from a verified copy.
 const sources=restoreSources(backup);
 // Only copies make the stat worth a round trip; without one the restore reports a missing main copy as before.
 const mainVerified=sources[0].status==='verified';
 if(mainVerified&&!sourceTargetId&&sources.some(source=>source.role==='copy'&&source.status==='verified')){try{await statFile(sources[0].path);}catch{sources[0].status='missing';}}
 const chosen=sourceTargetId?sources.find(source=>source.targetId===sourceTargetId):sources.find(source=>source.status==='verified');
 if(sourceTargetId&&chosen?.status!=='verified')throw Object.assign(new Error('Choose a verified copy of this backup to restore from.'),{status:409,code:'source_unavailable'});
 if(!chosen)throw new Error('Verified backup not found');
 const configuredReferences=(backup.manifest.restoreReferences||[]).filter(reference=>reference.serverId===serverId).map(({capturedPath,source})=>({capturedPath,source}));
 if(!Object.keys(mappings||{}).length&&configuredReferences.length)mappings={externalReadOnly:configuredReferences};
 const target=db.prepare('SELECT * FROM servers WHERE id=?').get(serverId);if(!target)throw new Error('Target server not found');
 const capabilities=await testServer(target),blockers=[];
 // An increment restores its whole chain: every package it builds on must be readable, and space is the chain's sum.
 let restoreBytes=backup.size,chainLength=1;
 try{
  const members=verifyChainLinks(loadChain(backupId));chainLength=members.length;restoreBytes=members.reduce((sum,member)=>sum+Number(member.size||0),0);
  const unusable=members.slice(0,-1).find(member=>!restoreSources(member).some(source=>source.status==='verified'));
  if(unusable)throw new ChainError(unusable.id);
 }catch(error){blockers.push(error.message);}
 if(mode!=='new-copy')blockers.push('Replacement restore requires a safety backup and rollback adapter; unavailable');
 const staticSite=backup.manifest.kind==='static';
 if(!staticSite&&capabilities.architecture!==backup.manifest.architecture)blockers.push('Target architecture does not match backup');
 const grouped=(backup.manifest.containers?.length||0)>1;
 if(!staticSite&&(!backup.manifest.containers?.length||backup.manifest.containers.length>30))blockers.push('Restore requires 1 to 30 containers');
 if(grouped&&Number.parseInt(capabilities.docker,10)<28)blockers.push('Grouped isolated restores require Docker 28 or newer');
 if(capabilities.uid!==0)blockers.push('Root SSH required to restore ownership');
 const externalOnly=Object.keys(mappings||{}).every(name=>name==='externalReadOnly')&&(!mappings.externalReadOnly||Array.isArray(mappings.externalReadOnly));
 if(!externalOnly)blockers.push('Custom port and writable host directory maps require reviewed offline restore');
 if(capabilities.freeBytes<restoreBytes*3+1024**3)blockers.push('Insufficient estimated target capacity');
 const excludedPaths=backup.manifest.excludedPaths||backup.manifest.backupPlan?.coverage?.excludedPaths||[];
 let externalReferences;
 if(externalOnly&&(mappings.externalReadOnly?.length||excludedPaths.some(path=>path.requiredForRestore))){
  try{externalReferences=await remote(target,{operation:'plan-external-restore',manifest:backup.manifest,externalReadOnly:mappings.externalReadOnly||[]});}
  catch{blockers.push('Required external storage is unavailable or not a reviewed read-only mount on the restore target.');}
 }
 const externalWarnings=excludedPaths.length?['This backup excludes external or redundant data paths. Review the backup scope and reattach required external storage separately after validating the isolated copy. Never replace external storage with empty restored directories.']:[];
 return {backupId,serverId,mode,mappings,capabilities,...(chainLength>1?{chainLength}:{}),externalReferences,sources:sources.map(publicSource),source:{targetId:chosen.targetId,role:chosen.role},sourceTargetId:sourceTargetId||null,blockers,executable:blockers.length===0,isolated:true,networkMode:grouped?'isolated-internal':'none',warnings:staticSite?['Static files restore into a new private directory. The live website and nginx configuration stay unchanged.','File contents and ownership are verified. Review the restored website before planning a separate production cutover.']:[...externalWarnings,'No published ports or external network: grouped services communicate only on fresh isolated networks. Use docker exec for validation, then explicitly plan production routing.','Static IP assignments, shared container network namespaces, overlapping mount paths, escaping links/device files and privileged host configuration require offline review.','Application-specific data validation is required after container health succeeds. Original stopped containers stay stopped.'],plannedAt:now()};
}
export async function enqueueRestore(backupId,plan,actor='administrator'){
 requireNoDeploymentHold();{const row=db.prepare('SELECT site_id FROM backups WHERE id=?').get(backupId);if(row)requireNotMoving(row.site_id);}
 const fresh=await planRestore(backupId,{serverId:plan?.serverId,mode:plan?.mode,mappings:plan?.mappings,sourceTargetId:plan?.sourceTargetId||null});
 if(!fresh.executable)throw new Error(fresh.blockers.join('; '));
 const backup=db.prepare('SELECT * FROM backups WHERE id=?').get(backupId);
 const restoreId=id(),jobId=id();
 db.exec('BEGIN IMMEDIATE');
 try{
  if(busy(backup.site_id))throw new Error('Site already has active work or unresolved recovery');
  requireNoDeploymentHold();
  if(db.prepare('SELECT 1 FROM retention_operations WHERE backup_id=?').get(backupId))throw new Error('Package retention is in progress');
  db.prepare("INSERT INTO restores(id,backup_id,server_id,mode,plan,status,created_at) VALUES(?,?,?,?,?,'queued',?)").run(restoreId,backupId,fresh.serverId,fresh.mode,JSON.stringify(fresh),now());
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,'restore','queued','queued',?,?)").run(jobId,backup.site_id,now(),JSON.stringify({restoreId,backupId,targetServerId:fresh.serverId,...(fresh.sourceTargetId?{sourceTargetId:fresh.sourceTargetId}:{})}));
  audit(actor,'restore.enqueue',backupId,{job:jobId,restoreId,...(fresh.sourceTargetId?{sourceTargetId:fresh.sourceTargetId}:{})});db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 return {id:jobId,restoreId};
}
export async function setMaintenance(siteId,enabled){requireNotMoving(siteId);const {site,server}=siteInfo(siteId);if(site.config.kind==='static')throw Object.assign(new Error('Static backups keep the website online and do not use Docker maintenance controls.'),{status:400});const result=await remote(server,{operation:'maintenance',config:site.config,enabled});audit('administrator','maintenance.set',siteId,{enabled});return result;}
export async function maintenanceHtml(){const row=db.prepare("SELECT value FROM settings WHERE key='maintenance'").get();const settings=row?JSON.parse(row.value):{};const font=await readFile(new URL('../dist/fonts/Roboto-Latin.woff2',import.meta.url));return Buffer.from(renderMaintenancePage(settings,{font:'data:font/woff2;base64,'+font.toString('base64')})).toString('base64');}
export async function deployMaintenance(siteId){requireNotMoving(siteId);const {site,server}=siteInfo(siteId);if(site.config.kind==='static')throw Object.assign(new Error('Static backups keep the website online and do not need a maintenance proxy.'),{status:400});return remote(server,{operation:'deploy-maintenance',config:site.config,html:await maintenanceHtml()});}
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
function stage(job,value){db.prepare("UPDATE jobs SET stage=? WHERE id=? AND status='running'").run(value,job);}
// Terminal writes apply only while the job is still 'running'. If this worker lost its lease, the new holder has
// already marked the job recovery_required; overwriting that would clear the per-server block in claimJob.
function finishJob(jobId,set,...values){
 if(db.prepare(`UPDATE jobs SET ${set} WHERE id=? AND status='running'`).run(...values,jobId).changes===1)return true;
 console.error(`Job ${jobId} is no longer running (another worker marked it for recovery); its final status was not written.`);
 audit('worker','job.superseded',jobId,{});return false;
}
const transferWrites=new Map();
function recordTransferProgress(job,value){
 // Throttled: progress arrives often; persist at most every 2 seconds plus the final value.
 const done=Number(value?.done),total=value?.total==null?null:Number(value.total);if(!Number.isFinite(done))return;
 const at=Date.now(),last=transferWrites.get(job)||0;if(!value.final&&at-last<2000&&!(total&&done>=total))return;transferWrites.set(job,at);
 const row=db.prepare('SELECT details FROM jobs WHERE id=?').get(job);if(!row)return;
 let details={};try{details=JSON.parse(row.details||'{}');}catch{}
 const previous=details.transfer||{};
 details.transfer={done,total:Number.isFinite(total)?total:null,startedAt:previous.startedAt||now(),updatedAt:now()};
 db.prepare('UPDATE jobs SET details=? WHERE id=?').run(JSON.stringify(details),job);
}
// Bind mounts of passwords, sudo rules or SSH keys are never copied (2.11.1); the helper lists them in the manifest.
export function protectedMountWarning(items){
 const list=(Array.isArray(items)?items:[]).filter(item=>item&&typeof item.source==='string').slice(0,20).map(item=>`${item.source.slice(0,512)}${typeof item.container==='string'&&item.container?` (mounted into ${item.container.slice(0,128)})`:''}`);
 return list.length?`Not copied: ${list.join('; ')}. These mounts hold passwords, sudo rules or SSH keys, which DockNest never copies; recover them separately before using a restored copy.`:null;
}
// Keeps enqueue-time warnings and adds the helper's record of probes it skipped (names resolved on the host).
function probeWarnings(job,skipped=[]){
 let details={};try{details=JSON.parse(db.prepare('SELECT details FROM jobs WHERE id=?').get(job)?.details||'{}');}catch{}
 const warnings=[...(details.warnings||[])];
 if(skipped.length&&!warnings.some(warning=>warning.startsWith('Probe URL policy')))warnings.push(`Probe URL policy: the ${skipped.map(probe=>probe==='health'?'health':'public maintenance').join(' and ')} probe was skipped because its URL is refused; health was checked with container state only. Edit the site to use its domain or a loopback port such as http://127.0.0.1:8080/.`);
 return warnings;
}
function recordBackupDiagnostic(job,value){
 const row=db.prepare('SELECT details FROM jobs WHERE id=?').get(job);if(!row)return;
 let details={};try{details=JSON.parse(row.details||'{}');}catch{}
 const item={at:now()};
 for(const key of ['command','phase','outcome','elapsedMs','timeoutSeconds','exitCode','exceptionType'])if(['string','number'].includes(typeof value?.[key]))item[key]=value[key];
 details.diagnostics=[...(details.diagnostics||[]),item].slice(-200);
 db.prepare('UPDATE jobs SET details=? WHERE id=?').run(JSON.stringify(details),job);
}
export async function retain(siteId){
 const policy=db.prepare('SELECT retention FROM policies WHERE site_id=?').get(siteId);const count=policy?.retention||7;
 // Main packages only: a backup whose main package already aged out lives on its copies, under their own counts.
 const stale=db.prepare("SELECT * FROM backups WHERE site_id=? AND verified=1 AND pinned=0 AND id NOT IN (SELECT backup_id FROM backup_main_removed) ORDER BY captured_at DESC").all(siteId).slice(count);
 // Incremental chains (docs/incremental-backups.md): a package stays while a backup that builds on it is kept, so
 // dependents go first (newest first), then what they freed. Outside chains this is one pass, exactly as before.
 let pending=stale;
 for(let pass=0;pass<=31&&pending.length;pass++){
  const blocked=[];let progressed=false;
  for(const backup of pending){
   // Object-Locked points are deferred until their lock ends; they stay fully usable meanwhile.
   if(deletionDeferred(backup.id))continue;
   if(hasDependents(backup.id)){blocked.push(backup);continue;}
   if(claimDeletion(backup.id)){await finishDeletion(backup.id);progressed=true;}
  }
  if(!progressed)break;pending=blocked;
 }
 // Each copy destination keeps its own count (docs/backup-copies.md).
 await retainCopies(siteId);
}

export {siteInfo};
// Removes the source's incremental snapshot files of a site (option turned off, site moved or removed). Best effort:
// a stale or missing snapshot only ever makes the next backup full.
export async function discardIncrementalState(siteId,{server=null}={}){
 let target=server;
 try{target??=siteInfo(siteId).server;await transport.remote(target,{operation:'incremental-discard',siteKey:siteId});audit('worker','site.incremental_discarded',siteId,{serverId:target.id});return true;}
 catch{audit('worker','site.incremental_discard_failed',siteId,{serverId:target?.id??null});return false;}
}
// Streams a verified backup, decrypted only inside the authenticated stream, into `jobId`'s restore staging root on `server`.
// Restore tests pass `prepare` (their own journalled staging) and `signal` (cancel and time limit stop the transfer).
// An increment sends its whole chain (full first) after every package and link passed: `prepare` (or prepare-restore)
// gets `chainLength` and answers `remotePaths`, and the result carries `chain` for the helper's own link check.
export async function uploadBackupTo(server,backupId,jobId,{prepare,signal}={}){
 const backup=db.prepare('SELECT * FROM backups WHERE id=?').get(backupId);
 if(!backup||!(backup.verified||db.prepare("SELECT 1 FROM backup_copies WHERE backup_id=? AND status='verified'").get(backupId)))throw new Error('Verified backup not found');
 // The main copy, or a verified copy when the main one is missing or fails authentication.
 const chain=await authenticatedChain(backup),last=chain.at(-1);
 if(!inChain(chain.map(item=>item.member))){
  const staging=prepare?await prepare():await transport.remote(server,{operation:'prepare-restore',job:jobId});
  await sendPackage(server,last,staging.remotePath,{signal});
  return {plaintextChecksum:last.plaintextChecksum,source:publicSource(last.source)};
 }
 const staging=prepare?await prepare({chainLength:chain.length}):await transport.remote(server,{operation:'prepare-restore',job:jobId,chainLength:chain.length});
 const paths=chainPaths(staging,chain.length);
 for(const [index,item] of chain.entries())await sendPackage(server,item,paths[index],{signal});
 return {plaintextChecksum:last.plaintextChecksum,chain:chainDescriptor(chain),source:publicSource(last.source)};
}
async function executeRestoreJob(job){
 const details=typeof job.details==='string'?JSON.parse(job.details):job.details;
 const restore=parse(db.prepare('SELECT * FROM restores WHERE id=?').get(details.restoreId));
 const backup=parse(db.prepare('SELECT * FROM backups WHERE id=?').get(details.backupId));
 const server=db.prepare('SELECT * FROM servers WHERE id=?').get(restore.server_id);
 try{
  db.prepare("UPDATE restores SET status='running' WHERE id=?").run(restore.id);
  stage(job.id,'verifying');
  // Main copy first; if it is missing or fails authentication, the newest verified copy, unless the owner chose one.
  // An increment authenticates its whole chain here, before anything is sent.
  const chain=await authenticatedChain(backup,details.sourceTargetId||null),chained=inChain(chain.map(item=>item.member));
  const {plaintextChecksum,source}=chain.at(-1);
  if(source.role==='copy'){
   const used={targetId:source.targetId,name:source.name,role:'copy',chosen:Boolean(details.sourceTargetId)};
   db.prepare("UPDATE jobs SET details=? WHERE id=? AND status='running'").run(JSON.stringify({...details,source:used}),job.id);details.source=used;
   audit('worker',details.sourceTargetId?'restore.source_chosen':'restore.source_fallback',backup.id,{job:job.id,targetId:source.targetId,targetName:source.name});
  }
  let result;
  const restoreRequest={operation:'restore',job:job.id,plaintextChecksum,externalReadOnly:restore.plan.mappings?.externalReadOnly||[],externalFingerprint:restore.plan.externalReferences?.fingerprint};
  if(!chained){
   const staging=await remote(server,{operation:'prepare-restore',job:job.id});
   stage(job.id,'transferring');
   await sendPackage(server,chain[0],staging.remotePath,{upload:uploadStream});
   // Only invoke extraction after the complete GCM-authenticated stream finishes.
   stage(job.id,'restoring');result=await remote(server,restoreRequest);
  }else{
   const staging=await transport.remote(server,{operation:'prepare-restore',job:job.id,chainLength:chain.length});
   const paths=chainPaths(staging,chain.length);
   stage(job.id,'transferring');
   for(const [index,item] of chain.entries())await sendPackage(server,item,paths[index]);
   // The helper checks every package's checksum and link again before it extracts the full package, then each increment.
   stage(job.id,'restoring');result=await transport.remote(server,{...restoreRequest,chain:chainDescriptor(chain)});
  }
  // Evidence, job and restore outcome commit together, and only while this worker still owns the job.
  if(!transaction(()=>{if(!finishJob(job.id,"status='completed',stage='completed',finished_at=?,details=?",now(),JSON.stringify({...details,result})))return false;
   recordVerification(backup.id,'integrity',{status:'passed',method:'full AES-256-GCM authentication and stored SHA256'},job.id);
   for(const kind of ['isolatedRestore','application'])recordVerification(backup.id,kind,result.verification?.[kind]||{status:'not-tested'},job.id);
   db.prepare("UPDATE restores SET status='completed',plan=? WHERE id=?").run(JSON.stringify({...restore.plan,result}),restore.id);
   audit('worker','restore.completed',backup.id,{job:job.id,containerIds:result.containerIds,networkMode:result.networkMode});return true;}))supersedeRestore(restore.id);
 }catch(error){
  if(!transaction(()=>{if(!finishJob(job.id,"status='failed',stage='failed',finished_at=?,error=?",now(),String(error.message).slice(0,1000)))return false;
   for(const kind of ['isolatedRestore','application'])recordVerification(backup.id,kind,{status:'failed',method:'isolated recovery attempt did not complete'},job.id);
   db.prepare("UPDATE restores SET status='failed' WHERE id=?").run(restore.id);
   audit('worker','restore.failed',backup.id,{job:job.id});return true;}))supersedeRestore(restore.id);
 }
}
// The restore outcome of a superseded job is unknown to the new lease holder; leave it for recovery review.
function supersedeRestore(restoreId){db.prepare("UPDATE restores SET status='recovery_required' WHERE id=? AND status IN ('queued','running')").run(restoreId);}

// The source server's clock orders recovery points for retention. A capture time outside this job's own window
// (a skewed or reset source clock) is replaced by the DockNest host's time so retention never prunes the newest point.
// Finished job folders left in a source staging root (releases 2.1.0-2.4.1 never removed them). The helper only lists;
// DockNest decides here and removes each one with the marker-checking cleanup operation.
export const STAGING_SAFE_AGE_SECONDS=6*3600;
const jobFolder=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function stagingRemovable(item,currentJob){
 if(!item||!jobFolder.test(item.job)||item.job===currentJob||item.finished!==true)return false;
 const row=db.prepare('SELECT status FROM jobs WHERE id=?').get(item.job);
 // queued, running, recovery_required and failed (kept for review) folders stay; unknown jobs only once old.
 return row?row.status==='completed':Number(item.ageSeconds)>=STAGING_SAFE_AGE_SECONDS;
}
export async function sweepStaging(server,site,currentJob){
 const listing=await transport.remote(server,{operation:'list-staging',config:site.config});
 if(typeof listing?.root!=='string'||!listing.root.startsWith('/'))return {removed:0,freedBytes:0};
 let removed=0,freedBytes=0;
 for(const item of (Array.isArray(listing.jobs)?listing.jobs:[]).filter(item=>stagingRemovable(item,currentJob)).slice(0,50)){
  try{await transport.remote(server,{operation:'cleanup',root:listing.root.replace(/\/+$/,'')+'/'+item.job});removed++;freedBytes+=Number.isSafeInteger(item.bytes)?item.bytes:0;}catch{/* Kept; retried after the next backup. */}
 }
 // Counts only: folder names and paths stay out of the audit trail.
 if(removed)audit('worker','staging.swept',server.id,{removed,freedBytes});
 return {removed,freedBytes};
}
// Startup reconciliation published a crashed job's package and completed that job: finish its source cleanup and retention.
export async function finishReconciledBackup(jobId){
 const job=db.prepare("SELECT id,site_id FROM jobs WHERE id=? AND type='backup' AND status='completed'").get(jobId);if(!job)return;
 // Its snapshot files were never committed on the source (the worker stopped first), so the next backup is full.
 if(db.prepare('SELECT 1 FROM backup_chain_links l JOIN backups b ON b.id=l.backup_id WHERE b.job_id=?').get(jobId))setForceFull(job.site_id,FORCE.uncommitted);
 const {site,server}=siteInfo(job.site_id);
 await transport.remote(server,{operation:'cleanup',root:(site.config.stagingRoot||'/var/lib/docknest').replace(/\/+$/,'')+'/'+job.id}).catch(()=>{});
 await sweepStaging(server,site,job.id).catch(()=>{});
 await retain(site.id).catch(()=>audit('worker','retention.failed',site.id,{job:job.id}));
}
export function trustedCaptureTime(reported,startedMs,nowMs=Date.now(),skewMs=10*60*1000){
 const ms=typeof reported==='number'?reported*1000:NaN;
 return Number.isFinite(ms)&&ms>=startedMs-skewMs&&ms<=nowMs+skewMs?{ms,adjusted:false}:{ms:nowMs,adjusted:true};
}
// Site moves register their job runner here (src/moves/engine.js), keeping this module free of a circular import.
export const jobRunners={};
export async function executeJob(job){
 if(jobRunners[job.type])return jobRunners[job.type](job);
 if(job.type==='scrub')return executeScrub(job);
 if(job.type==='restore')return executeRestoreJob(job);
 const startedMs=Date.now();
 let remoteStage='preflight',contacted=false,artifactTemporary=null,publishedBackup=false;
 const {site,server}=siteInfo(job.site_id);
 try{
  stage(job.id,'preflight');
  const plan=await planBackup(site.id);
  // The site's own main destination, or the default one (docs/backup-copies.md); a removed choice fails closed.
  const mainStorage=siteMainStorage(site.id);
  const capacity=await storageCapacity({options:mainStorage});
  // Object storage reports no fixed size (unbounded); other backends must prove free space.
  if(capacity.available===null&&!capacity.unbounded)throw new Error('Backup storage available space could not be verified');
  if(capacity.available!==null&&capacity.available<1024**3)throw new Error('Backup storage has less than 1 GiB free');
  const backupId=id(),directory=backupDirectory(server,site,mainStorage);
  await makeDirectory(directory);
  const direct=site.config.deliveryMode==='direct';
  let result,published,temporary,captured;
  let jobDetails={};try{jobDetails=JSON.parse(job.details||'{}');}catch{}
  // Incremental backups (opt-in per site): full or increment is decided here, before the job contacts the source.
  // Without the option the request and the package are exactly as before.
  const decision=decideCapture({site,plan,directory,jobDetails});
  // keepStopped: a site move's final copy leaves the source stopped behind its maintenance page once captured.
  const request={operation:'capture',job:job.id,config:site.config,planFingerprint:plan.fingerprint,diagnostics:process.env.DOCKNEST_CAPTURE_DIAGNOSTICS==='1',...(jobDetails.keepStopped?{keepStopped:true}:{}),...(decision?{incremental:decision.request}:{})};
  const onStage=value=>{remoteStage=value;stage(job.id,value);};
  const onDiagnostic=value=>recordBackupDiagnostic(job.id,value);
  const onProgress=value=>recordTransferProgress(job.id,value);
  if(direct){
   published=storageJoin(directory,backupFilename(backupId,new Date()));temporary=published+'.partial';artifactTemporary=temporary;
   preparePublication({backupId,jobId:job.id,siteId:site.id,temporary,published,manifest:{complete:false,deliveryMode:'direct'},capturedAt:now()});
   const pass=new Transform({transform(c,e,cb){cb(null,c);}});pass.on('error',()=>{});
   const writing=encryptStream(pass,await openWrite(temporary));writing.catch(error=>pass.destroy(error));
   contacted=true;
   try{result=await transport.remoteCaptureStream(server,request,pass,onStage,onDiagnostic,onProgress);await writing;}
   catch(error){pass.destroy(error);await writing.catch(()=>{});throw error;}
  }else{
   contacted=true;result=await transport.remote(server,request,onStage,onDiagnostic);
   captured=trustedCaptureTime(result.manifest.capturedAt,startedMs);
   published=storageJoin(directory,backupFilename(backupId,new Date(captured.ms)));temporary=published+'.partial';artifactTemporary=temporary;
  }
  captured||=trustedCaptureTime(result.manifest.capturedAt,startedMs);
  // Secrets live only inside authenticated encrypted payload; metadata uses a redacted manifest.
  const manifest={formatVersion:1,kind:result.manifest.kind||'docker',...(result.manifest.kind==='static'?{documentRoot:result.manifest.documentRoot,staticFiles:result.manifest.staticFiles}:{}),complete:result.manifest.complete,capturedAt:captured.ms/1000,downtimeSeconds:result.manifest.downtimeSeconds,containerDowntimeSeconds:result.manifest.containerDowntimeSeconds,visitorDowntimeSeconds:result.manifest.visitorDowntimeSeconds,shutdownEvidence:result.manifest.shutdownEvidence,originalImages:result.manifest.originalImages.map(image=>({id:image.Id,digests:image.RepoDigests||[]})),architecture:result.manifest.architecture,restoreTested:false,containers:result.manifest.containers.map(c=>({id:c.Id,name:c.Name,image:c.Config.Image,mounts:c.Mounts.map(m=>({type:m.Type,destination:m.Destination}))}))};
  manifest.deliveryMode=direct?'direct':'staged';
  manifest.consistency=result.manifest.consistency;manifest.backupPlan=plan;
  if(result.manifest.backupScope)manifest.backupScope=result.manifest.backupScope;
  if(result.manifest.excludedPaths)manifest.excludedPaths=result.manifest.excludedPaths;
  if(result.manifest.restoreReferences)manifest.restoreReferences=result.manifest.restoreReferences;
  if(result.manifest.probePolicyFallback)manifest.probePolicyFallback=result.manifest.probePolicyFallback;
  if(captured.adjusted)manifest.sourceClock={reportedCapturedAt:Number.isFinite(result.manifest.capturedAt)?result.manifest.capturedAt:null,adjusted:true};
  // What the helper made (never the engine's guess): format v2 with its kind and chain link, or a standard package.
  const chain=chainRecord(decision,result.manifest,{serverId:site.server_id,mainTargetId:targetIdOfPath(directory)});
  if(chain)Object.assign(manifest,chain);
  const incrementalDetails=decision?{incremental:chain?{backupKind:chain.backupKind,chainPosition:chain.chain.position,...(chain.incremental.fullReason?{fullReason:chain.incremental.fullReason}:{})}:{backupKind:'full',standardPackage:true}}:{};
  const capturedAt=new Date(captured.ms).toISOString();
  if(direct)completePreparedMetadata(backupId,manifest,capturedAt);
  else{
   preparePublication({backupId,jobId:job.id,siteId:site.id,temporary,published,manifest,capturedAt});
   stage(job.id,'transferring');
   const pass=new Transform({transform(c,e,cb){cb(null,c);}});pass.on('error',()=>{});
   const writing=encryptStream(pass,await openWrite(temporary));writing.catch(error=>pass.destroy(error));
   try{await transport.download(server,result.remotePath,pass,onProgress);await writing;}catch(error){pass.destroy(error);await writing.catch(()=>{});throw error;}
  }
  stage(job.id,'verifying');await syncFile(temporary);const checksum=await verifyEncrypted(temporary);
  const size=(await statFile(temporary)).size;authenticatePublication(backupId,checksum,size);
  const warnings=probeWarnings(job.id,manifest.probePolicyFallback);
  const notCopied=protectedMountWarning(manifest.protectedMounts);if(notCopied)warnings.push(notCopied);
  if(captured.adjusted)warnings.push('Source server clock: the reported capture time was outside this job\'s run, so the DockNest server time was recorded. Check the source server clock (NTP).');
  if(decision&&!chain)warnings.push('Incremental backups: the server made a standard full backup. Check that the site server can run the current helper.');
  await renameFile(temporary,published);
  // The job completes in the same transaction that publishes the point, and only while this worker still owns it.
  const owned=finalizePublication(backupId,{ownedDetails:{backupId,downtimeSeconds:manifest.downtimeSeconds,...(warnings.length?{warnings}:{}),...incrementalDetails}});
  publishedBackup=true;
  // A superseded job keeps its authenticated package but skips cleanup and retention; recovery review owns the source.
  // Its snapshot files are not committed, so the next backup of the site is full.
  if(!owned){if(chain)setForceFull(site.id,FORCE.uncommitted);console.error(`Job ${job.id} is no longer running (another worker marked it for recovery); its final status was not written.`);audit('worker','job.superseded',job.id,{});return;}
  audit('worker','backup.completed',site.id,{job:job.id,backupId,size,...(chain?{backupKind:chain.backupKind}:{})});
  if(chain){
   if(chain.incremental.fallback)audit('worker','backup.incremental_fallback',site.id,{job:job.id,backupId,reason:chain.incremental.fallback});
   clearForceFull(site.id,decision.force);
   // Only now, with the package stored, authenticated and published, may the source move its snapshot files forward.
   // If that is not confirmed the next backup is full (the helper would also refuse a mismatched snapshot).
   try{await transport.remote(server,{operation:'incremental-commit',job:job.id,siteKey:site.id,config:site.config});}
   catch{setForceFull(site.id,FORCE.uncommitted);audit('worker','backup.incremental_commit_failed',site.id,{job:job.id,backupId});}
  }
  await transport.remote(server,{operation:'cleanup',root:result.root}).catch(()=>{});
  await sweepStaging(server,site,job.id).catch(()=>{});
  await retain(site.id).catch(()=>audit('worker','retention.failed',site.id,{job:job.id}));
 }catch(error){
  const journal=db.prepare('SELECT state FROM artifact_operations WHERE job_id=?').get(job.id);
  // Site folders are shared by recovery points; clean up only this job's file.
  if(artifactTemporary&&!publishedBackup&&journal?.state!=='authenticated')await removeFile(artifactTemporary).catch(()=>{});
  const recovery=site.config.kind!=='static' && contacted && !['source_ready','packing'].includes(remoteStage) && !(remoteStage==='preflight'&&error.remoteReported);
  const row=db.prepare('SELECT details FROM jobs WHERE id=?').get(job.id);let details={};try{details=JSON.parse(row?.details||'{}');}catch{}
  details.failure={at:now(),lastStage:remoteStage,errorType:error.name||'Error',remoteReported:!!error.remoteReported};
  // Record the underlying transport/storage reason; strip paths and limit length.
  const cause=error.cause;if(cause&&typeof cause==='object')details.failure.cause={type:String(cause.name||'Error').slice(0,60),...(cause.code!=null?{code:String(cause.code).slice(0,40)}:{}),...(cause.level?{level:String(cause.level).slice(0,40)}:{}),message:String(cause.message||'').replace(/\/[^\s'"]+/g,'[path]').slice(0,240)};
  if(finishJob(job.id,'status=?,stage=?,finished_at=?,error=?,details=?',recovery?'recovery_required':'failed',recovery?'recovery_required':'failed',now(),String(error.message).slice(0,1000),JSON.stringify(details)))audit('worker','backup.failed',job.site_id,{job:job.id,recoveryRequired:recovery});
 }
}
export function tickScheduler(currentDate=new Date()){
 if(deploymentHeld(db))return;
 const policies=db.prepare('SELECT * FROM policies WHERE enabled=1 AND site_id NOT IN (SELECT site_id FROM site_archives)').all();
 for(const policy of policies){
  try{
   const next=policy.next_run?new Date(policy.next_run):null;
   // Keep a missed occurrence due while the site is busy; coalesce it once free.
   if(next&&next<=currentDate){if(busy(policy.site_id)||movingSite(policy.site_id))continue;enqueueBackup(policy.site_id);}
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
  // A job occupies its target (or its site's) server and, for a site move, also its source server. A started restore
  // test holds its test server (src/restore-tests/hold.js) for every job but its own steps. Restore test steps go
  // after every other queued job, so backups go first.
  const job=db.prepare(CLAIMABLE_JOB_SQL).get();
  // Site-move and restore-test jobs use their own statuses so a release without them (for example after a rollback)
  // never claims them as backups, and its startup never turns them into recovery work.
  // Guarded by the selected status: a job withdrawn in the meantime (a cancelled test_queued step) is never started.
  if(job&&db.prepare("UPDATE jobs SET status=CASE status WHEN 'move_queued' THEN 'move_running' WHEN 'test_queued' THEN 'test_running' ELSE 'running' END,stage=CASE status WHEN 'test_queued' THEN stage ELSE 'preflight' END,started_at=? WHERE id=? AND status=?").run(now(),job.id,job.status).changes!==1){db.exec('COMMIT');return null;}
  db.exec('COMMIT');return job;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
