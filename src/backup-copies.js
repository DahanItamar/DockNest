// Backup copies (docs/backup-copies.md): the copy step, per-copy retention and the destination usage the Storage page
// shows. The copy step is its own worker step, picked by the existing worker loop when no site job waits (claimCopy in
// src/artifact-journal.js), and it never fails or delays the backup it copies. It copies the encrypted package byte for
// byte from the main copy: no re-encryption, the same SHA-256, the same master key.
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { db,audit,transaction } from './db.js';
import { targetOptions,adapters,openRead,openWrite,makeDirectory,syncFile,renameFile,storageCapacity } from './storage.js';
import { fileExists,completeCopy,failCopy,yieldCopy,authenticateCopyFile,removeCopyFiles,deleteCopyFiles,settleAfterCopyRemoval,markCopyDeleted,deletionBlocked,readLeaseHeld,recoverInterruptedCopies } from './artifact-journal.js';
import { siteCopyTargets,effectiveRetention,sameLocation,targetIdOfPath,targetSummary } from './site-storage.js';

const now=()=>new Date().toISOString();
const GiB=1024**3;
class CopyFailure extends Error{constructor(code){super(code);this.code=code;}}
class CopyYield extends Error{}
// A long copy must not hold up a scheduled backup: every `yieldCheckBytes` it looks (one indexed query) for a queued
// site job and, if there is one, stops, removes its .partial and is due again at once, without counting an attempt.
const siteJobWaiting=()=>Boolean(db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued','move_queued') LIMIT 1").get());
// Capacity of the copy destination before each copy: enough room for the package and the 1 GiB every destination keeps
// free. Object storage reports no fixed size and is checked by the write itself.
export const copyHooks={capacity:options=>storageCapacity({options}),yieldCheckBytes:64*1024**2};
async function checkCopyCapacity(options,size){
 const capacity=await copyHooks.capacity(options);
 if(capacity.unbounded)return;
 if(capacity.available===null||capacity.available===undefined)throw new CopyFailure('space');
 if(capacity.available<size+GiB)throw new CopyFailure('space');
}
// One copy step. `verify(file)` is the full authentication (engine.verifyEncrypted): GCM tag and SHA-256.
export async function executeCopy(copy,verify){
 const temporary=copy.path+'.partial';
 try{
  if(!targetSummary(copy.target_id))throw new CopyFailure('destination_missing');
  if(sameLocation(copy.target_id,targetIdOfPath(copy.source)))throw new CopyFailure('same_destination');
  const options=targetOptions(copy.target_id);
  if(!adapters[options.mode])throw new CopyFailure('destination_missing');
  // A file already at the copy path: adopted only when it is this exact package, never overwritten when it is not.
  if(await fileExists(copy.path)){
   if(!await authenticateCopyFile(copy.path,copy,verify))throw new CopyFailure('conflict');
   completeCopy(copy,{adopted:true});return {status:'verified',adopted:true};
  }
  await checkCopyCapacity(options,copy.size);
  if(await fileExists(temporary))await removeCopyFiles(copy,{partialOnly:true});
  await makeDirectory(copy.path.slice(0,copy.path.lastIndexOf('/')));
  let input;
  try{input=await openRead(copy.source);}catch{throw new CopyFailure('source');}
  let output;
  let sinceCheck=0;
  const watch=new Transform({transform(chunk,_e,cb){sinceCheck+=chunk.length;if(sinceCheck>=copyHooks.yieldCheckBytes){sinceCheck=0;if(siteJobWaiting())return cb(new CopyYield());}cb(null,chunk);}});
  try{output=await openWrite(temporary);await pipeline(input,watch,output);}
  catch(error){input.destroy();output?.destroy();if(error instanceof CopyFailure||error instanceof CopyYield)throw error;throw new CopyFailure('unreachable');}
  await syncFile(temporary);
  if(!await authenticateCopyFile(temporary,copy,verify)){await removeCopyFiles(copy,{partialOnly:true});throw new CopyFailure('checksum');}
  await renameFile(temporary,copy.path);await syncFile(copy.path);
  completeCopy(copy);
  await retainCopies(copy.site_id).catch(()=>audit('worker','retention.failed',copy.site_id,{copies:true}));
  return {status:'verified'};
 }catch(error){
  await removeCopyFiles(copy,{partialOnly:true}).catch(()=>{});
  if(error instanceof CopyYield){yieldCopy(copy);return {status:'yielded'};}
  const plan=failCopy(copy,error instanceof CopyFailure?error.code:'unreachable');
  // Destination names only: the log line never holds a host, path, key or provider message.
  console.error(`Copy of backup ${copy.backup_id} to ${targetSummary(copy.target_id)?.name??'a removed destination'} failed (${error instanceof CopyFailure?error.code:'unreachable'}); ${plan?.status==='gave_up'?'gave up after 7 days':'retrying later'}.`);
  return {status:plan?.status??'failed',reason:error instanceof CopyFailure?error.code:'unreachable'};
 }
}

async function removeCopy(copy){
 const result=await deleteCopyFiles(copy);
 if(result.deferred)return 'deferred';
 return settleAfterCopyRemoval(copy);
}
// Each copy destination of a site keeps the site's newest `retention` (or the site's count) unpinned verified copies.
// Pins apply to every copy, and nothing of a backup that is being read (restore, download, test, copy step) is deleted.
// A destination the site no longer copies to keeps its copies under the site's own count.
export async function retainCopies(siteId){
 let removed=0;
 const listed=siteCopyTargets(siteId),unlisted=db.prepare("SELECT DISTINCT c.target_id FROM backup_copies c JOIN backups b ON b.id=c.backup_id WHERE b.site_id=? AND c.status='verified' AND c.target_id NOT IN (SELECT target_id FROM site_storage_copies WHERE site_id=?)").all(siteId,siteId).map(row=>({target_id:row.target_id,retention:null}));
 for(const {target_id:targetId,retention} of [...listed,...unlisted]){
  const count=effectiveRetention(siteId,retention);
  const stale=db.prepare(`SELECT c.* FROM backup_copies c JOIN backups b ON b.id=c.backup_id WHERE b.site_id=? AND c.target_id=? AND c.status='verified' AND c.delete_state IS NULL AND b.pinned=0
   ORDER BY b.captured_at DESC,b.id DESC`).all(siteId,targetId).slice(count);
  for(const copy of stale){
   if(deletionBlocked(copy.backup_id))continue;
   if(['moved','removed','kept'].includes(await removeCopy(copy)))removed++;
  }
 }
 return removed;
}
// Worker maintenance (every 5 minutes, inside the existing maintain step): Object-Lock deferrals whose date passed,
// copies the owner asked to delete, and copy rows of backups an older release removed (it never knew about copies).
// `verify`: also resumes copy steps a worker left behind (skipped under the deployment hold, retried here afterwards).
export async function maintainCopies(at=Date.now(),verify=null){
 const result={deleted:0,deferred:0,pending:0};
 if(verify)await recoverInterruptedCopies(verify).catch(()=>{});
 const due=db.prepare("SELECT * FROM backup_copies WHERE status<>'deleted' AND status<>'copying' AND (delete_state='pending' OR (delete_state='deferred' AND delete_after<=?))").all(at);
 for(const copy of due){
  try{
   // Retention deferrals respect every rule (a pin set meanwhile keeps the copy); the owner's deletion waits for readers.
   if(copy.delete_state==='pending'?readLeaseHeld(copy.backup_id):deletionBlocked(copy.backup_id)){result.pending++;continue;}
   if(copy.status!=='verified'){await removeCopyFiles(copy,{partialOnly:true});settleAfterCopyRemoval(copy);result.deleted++;continue;}
   (await removeCopy(copy))==='deferred'?result.deferred++:result.deleted++;
  }catch{result.pending++;audit('worker','retention.reconciliation_pending',copy.backup_id,{targetId:copy.target_id});}
 }
 for(const copy of db.prepare("SELECT * FROM backup_copies c WHERE c.status NOT IN ('deleted','copying') AND c.delete_state IS NULL AND NOT EXISTS(SELECT 1 FROM backups b WHERE b.id=c.backup_id)").all()){
  try{
   if((await deleteCopyFiles(copy)).deferred){result.deferred++;continue;}
   markCopyDeleted(copy);result.deleted++;audit('worker','backup.copy_orphan_removed',copy.backup_id,{targetId:copy.target_id});
  }catch{result.pending++;}
 }
 return result;
}

// ---- Destinations -----------------------------------------------------------------------------------------------------
const prefixOf=targetId=>{const summary=targetSummary(targetId);return summary&&['sftp','s3'].includes(summary.mode)?summary.mode+':'+targetId+':':null;};
// What a destination holds and who uses it: the 409 body of DELETE /api/storage-targets/:id and GET .../usage.
export function destinationUsage(targetId){
 const copies=db.prepare("SELECT COUNT(*) AS n,COUNT(DISTINCT c.backup_id) AS backups,COALESCE(SUM(b.size),0) AS bytes FROM backup_copies c LEFT JOIN backups b ON b.id=c.backup_id WHERE c.target_id=? AND c.status<>'deleted'").get(targetId);
 const site=sql=>db.prepare(sql).all(targetId).map(row=>({id:row.id,name:row.name}));
 const prefix=prefixOf(targetId);
 const main=prefix?db.prepare('SELECT COUNT(*) AS n FROM backups WHERE path LIKE ? AND id NOT IN (SELECT backup_id FROM backup_main_removed)').get(prefix+'%').n:0;
 const kits=db.prepare("SELECT COUNT(*) AS n FROM manager_backups WHERE target_id=? AND status IN ('queued','running','completed')").get(targetId).n+db.prepare('SELECT COUNT(*) AS n FROM manager_backup_copies WHERE target_id=?').get(targetId).n;
 return {copies:copies.n,copyBackups:copies.backups,bytes:copies.bytes,
  mainForSites:site('SELECT s.id,s.name FROM site_storage t JOIN sites s ON s.id=t.site_id WHERE t.main_target_id=? ORDER BY s.name,s.id'),
  copyForSites:site('SELECT s.id,s.name FROM site_storage_copies t JOIN sites s ON s.id=t.site_id WHERE t.target_id=? ORDER BY s.name,s.id'),
  // Additive to the 2.11 contract: main packages, recovery kits and the default flag also keep a destination in use.
  mainBackups:main,recoveryKits:kits,onlyPackageBackups:onlyPackageBackups(targetId),isDefault:db.prepare("SELECT value FROM settings WHERE key='backup_storage_target'").get()?.value===targetId};
}
// Backups whose main package already aged out and whose only verified copy is on this destination: deleting the copies
// here deletes those backups.
const onlyPackageSql="SELECT COUNT(DISTINCT c.backup_id) AS n FROM backup_copies c JOIN backup_main_removed m ON m.backup_id=c.backup_id WHERE c.target_id=? AND c.status='verified' AND NOT EXISTS(SELECT 1 FROM backup_copies o WHERE o.backup_id=c.backup_id AND o.target_id<>c.target_id AND o.status='verified' AND o.delete_state IS NULL)";
export const onlyPackageBackups=targetId=>db.prepare(onlyPackageSql).get(targetId).n;
export const destinationInUse=usage=>Boolean(usage.copies||usage.mainForSites.length||usage.copyForSites.length||usage.mainBackups||usage.recoveryKits||usage.isDefault);
// "Delete these copies": every copy held on the destination is queued for deletion (the worker removes the files) and
// the destination leaves every site's copy list. Pinned backups' copies need includePinned; backups that exist only
// here (their main package aged out) need includeLastPackages, because deleting these copies deletes them.
export function requestDestinationCopyDeletion(targetId,{includePinned=false,includeLastPackages=false}={},actor){
 return transaction(()=>{
  const last=onlyPackageBackups(targetId);
  if(last&&!includeLastPackages)throw Object.assign(new Error(`${last} ${last===1?'backup exists':'backups exist'} only on this destination. Deleting these copies deletes ${last===1?'it':'them'}. Confirm to continue.`),{status:409,code:'last_packages',lastPackages:last});
  const pinned=db.prepare("SELECT COUNT(*) AS n FROM backup_copies c JOIN backups b ON b.id=c.backup_id WHERE c.target_id=? AND c.status<>'deleted' AND b.pinned=1").get(targetId).n;
  if(pinned&&!includePinned)throw Object.assign(new Error(`${pinned} of these copies belong to pinned backups. Confirm to delete them too.`),{status:409,code:'pinned_copies',pinned});
  const deleting=db.prepare("UPDATE backup_copies SET delete_state='pending',next_attempt_at=NULL,updated_at=? WHERE target_id=? AND status<>'deleted' AND (delete_state IS NULL OR delete_state='deferred')").run(now(),targetId).changes;
  const sites=db.prepare('DELETE FROM site_storage_copies WHERE target_id=?').run(targetId).changes;
  audit(actor,'storage.copies_delete',targetId,{deleting,sitesUpdated:sites,includePinned:Boolean(includePinned),lastPackages:includeLastPackages?last:0});
  return {deleting};
 });
}

// ---- Views ------------------------------------------------------------------------------------------------------------
const iso=ms=>Number.isFinite(ms)&&ms!==null?new Date(ms).toISOString():null;
// The `mainTarget` and `copies` of each backup in /api/state and /api/backups ('deleted' rows omitted).
export function backupCopyViews(backups){
 const ids=backups.map(backup=>backup.id),result=new Map();
 const removed=new Map(),copies=new Map();
 if(ids.length){
  const list=JSON.stringify(ids);
  for(const row of db.prepare('SELECT backup_id,original_path FROM backup_main_removed WHERE backup_id IN (SELECT value FROM json_each(?))').all(list))removed.set(row.backup_id,row.original_path);
  for(const row of db.prepare("SELECT * FROM backup_copies WHERE status<>'deleted' AND backup_id IN (SELECT value FROM json_each(?)) ORDER BY rowid").all(list))(copies.get(row.backup_id)??copies.set(row.backup_id,[]).get(row.backup_id)).push(row);
 }
 const names=new Map(),summary=targetId=>{if(!names.has(targetId))names.set(targetId,targetSummary(targetId)??{id:targetId,name:'Removed destination',mode:null});return names.get(targetId);};
 for(const backup of backups){
  const mainPath=removed.get(backup.id)??backup.path,main=summary(targetIdOfPath(mainPath));
  result.set(backup.id,{mainTarget:{id:main.id,name:main.name,mode:main.mode},...(removed.has(backup.id)?{mainRemoved:true}:{}),copies:(copies.get(backup.id)??[]).map(copy=>{const target=summary(copy.target_id);return {targetId:copy.target_id,name:target.name,mode:target.mode,status:copy.status,verifiedAt:copy.verified_at,attempts:copy.attempts,nextAttemptAt:iso(copy.next_attempt_at),lastError:copy.last_error};})});
 }
 return result;
}
// Bytes the copies hold, per destination, for the storage report.
export function copyTotalsByTarget(){
 return new Map(db.prepare("SELECT c.target_id AS targetId,COUNT(*) AS count,COALESCE(SUM(b.size),0) AS bytes FROM backup_copies c JOIN backups b ON b.id=c.backup_id WHERE c.status='verified' AND NOT EXISTS(SELECT 1 FROM retention_operations r WHERE r.backup_id=c.backup_id) GROUP BY c.target_id").all().map(row=>[row.targetId,row]));
}
