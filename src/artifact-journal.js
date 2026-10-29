import { db,transaction,audit } from './db.js';
import { statFile,renameFile,removeFile,syncFile } from './storage.js';
import { recordVerification } from './recovery-evidence.js';
import { deploymentHeld } from './deployment-hold.js';
import { siteCopyTargets,effectiveRetention,sameLocation,copyPathFor,targetIdOfPath,targetSummary } from './site-storage.js';
import { recordChainLink,hasDependents } from './incremental.js';
const now=()=>new Date().toISOString();
const missing=error=>error.code==='ENOENT'||error.code===2;
export async function fileExists(file){try{await statFile(file);return true;}catch(error){if(missing(error))return false;throw error;}}
export function preparePublication({backupId,jobId,siteId,temporary,published,manifest,capturedAt}){
 db.prepare("INSERT INTO artifact_operations VALUES(?,?,?,?,?,'prepared',?,NULL,NULL,?,?)").run(backupId,jobId,siteId,temporary,published,JSON.stringify({manifest,capturedAt}),now(),now());
}
export function completePreparedMetadata(backupId,manifest,capturedAt){
 if(!manifest?.complete)throw new Error('Complete capture metadata required');
 const changed=db.prepare("UPDATE artifact_operations SET metadata=?,updated_at=? WHERE backup_id=? AND state='prepared'").run(JSON.stringify({manifest,capturedAt}),now(),backupId);
 if(changed.changes!==1)throw new Error('Prepared publication journal required');
}
export function authenticatePublication(backupId,checksum,size){
 if(!/^[a-f0-9]{64}$/.test(checksum)||!Number.isSafeInteger(size)||size<32)throw new Error('Invalid authenticated artifact evidence');
 const operation=db.prepare('SELECT metadata FROM artifact_operations WHERE backup_id=?').get(backupId);
 const manifest=operation&&JSON.parse(operation.metadata).manifest;
 if(manifest?.deliveryMode==='direct'&&!manifest.complete)throw new Error('Direct capture must complete and recover before publication');
 const row=db.prepare("UPDATE artifact_operations SET state='authenticated',checksum=?,size=?,updated_at=? WHERE backup_id=? AND state='prepared'").run(checksum,size,now(),backupId);
 if(!row.changes)throw new Error('Publication journal does not match capture');
}
// Completes the job only while it is still 'running' and says whether it did. ownedDetails: the live worker's final
// job details. Reconciliation never downgrades a recovery_required job: the package is published, review stays.
export function finalizePublication(backupId,{ownedDetails}={}){
 return transaction(()=>{
  const operation=db.prepare('SELECT * FROM artifact_operations WHERE backup_id=?').get(backupId);
  if(!operation||!['authenticated','completed'].includes(operation.state))throw new Error('Authenticated publication journal required');
  if(operation.state==='completed')return false;
  const metadata=JSON.parse(operation.metadata);
  if(metadata.manifest?.deliveryMode==='direct'&&!metadata.manifest.complete)throw new Error('Incomplete direct capture cannot be published');
  db.prepare('INSERT INTO backups(id,site_id,job_id,captured_at,path,size,checksum,manifest,pinned,verified,created_at) VALUES(?,?,?,?,?,?,?,?,0,1,?)').run(backupId,operation.site_id,operation.job_id,metadata.capturedAt,operation.published,operation.size,operation.checksum,JSON.stringify(metadata.manifest),now());
  // The chain a package belongs to (incremental backups, 2.12) is recorded with it, from its own manifest.
  recordChainLink(backupId,metadata.manifest);
  recordVerification(backupId,'integrity',{status:'passed',method:'full AES-256-GCM authentication and SHA256'},operation.job_id);
  recordVerification(backupId,'consistency',metadata.manifest.consistency||{status:'not-tested'},operation.job_id);
  db.prepare("UPDATE artifact_operations SET state='completed',updated_at=? WHERE backup_id=?").run(now(),backupId);
  // Copies are queued in the same transaction that publishes the main copy, so a published backup never misses them.
  scheduleCopies(backupId,operation.site_id,operation.published);
  return db.prepare("UPDATE jobs SET status='completed',stage='completed',finished_at=?,error=NULL,details=? WHERE id=? AND status='running'").run(now(),JSON.stringify(ownedDetails||{backupId,downtimeSeconds:metadata.manifest.downtimeSeconds}),operation.job_id).changes===1;
 });
}
export function deletionBlocked(backupId){
 return Boolean(db.prepare('SELECT id FROM backups WHERE id=? AND pinned=1').get(backupId)
  // An incremental chain (2.12): a package stays while any backup that builds on it is still kept (its main package or a
  // copy). Dependents go first, so a pinned or Object-Locked increment keeps its whole chain.
  ||hasDependents(backupId)
  ||db.prepare("SELECT id FROM restores WHERE backup_id=? AND status IN ('queued','running','recovery_required')").get(backupId)
  ||db.prepare('SELECT id FROM downloads WHERE backup_id=? AND expires_at>?').get(backupId,Date.now())
  ||db.prepare("SELECT id FROM jobs WHERE type='scrub' AND status IN ('queued','running','recovery_required') AND json_extract(details,'$.backupId')=?").get(backupId)
  // A copy step reads the package (its lease): nothing of this backup is deleted until the step ends.
  ||db.prepare("SELECT 1 FROM backup_copies WHERE backup_id=? AND status='copying'").get(backupId)
  // A restore test's lease on its package: an unfinished test or clean-up keeps the backup (docs/restore-tests.md).
  ||db.prepare("SELECT id FROM restore_tests WHERE backup_id=? AND (result IS NULL OR cleanup IN ('pending','failed'))").get(backupId)
  ||db.prepare("SELECT b.id FROM backups b WHERE b.verified=1 AND b.site_id=(SELECT site_id FROM backups WHERE id=?) AND EXISTS(SELECT 1 FROM backup_verification_history v WHERE v.backup_id=b.id AND v.kind='application' AND v.status='passed') ORDER BY b.captured_at DESC,b.id DESC LIMIT 1").get(backupId)?.id===backupId
  // Preserve the older currently passing point when the newest historical pass
  // has a later failed recovery attempt. Attempt history remains conservative.
  ||db.prepare("SELECT b.id FROM backups b WHERE b.verified=1 AND b.site_id=(SELECT site_id FROM backups WHERE id=?) AND EXISTS(SELECT 1 FROM backup_verifications v WHERE v.backup_id=b.id AND v.kind='application' AND v.status='passed') ORDER BY b.captured_at DESC,b.id DESC LIMIT 1").get(backupId)?.id===backupId);
}
// Something is reading the backup right now (restore, download, scrub, restore test, copy step). The owner's own
// "delete these copies" waits for these leases but not for pins or the newest-tested rule they confirmed past.
export function readLeaseHeld(backupId){
 return Boolean(db.prepare("SELECT id FROM restores WHERE backup_id=? AND status IN ('queued','running','recovery_required')").get(backupId)
  ||db.prepare('SELECT id FROM downloads WHERE backup_id=? AND expires_at>?').get(backupId,Date.now())
  ||db.prepare("SELECT id FROM jobs WHERE type='scrub' AND status IN ('queued','running','recovery_required') AND json_extract(details,'$.backupId')=?").get(backupId)
  ||db.prepare("SELECT id FROM restore_tests WHERE backup_id=? AND (result IS NULL OR cleanup IN ('pending','failed'))").get(backupId)
  ||db.prepare("SELECT 1 FROM backup_copies WHERE backup_id=? AND status='copying'").get(backupId));
}
export function claimDeletion(backupId){
 return transaction(()=>{if(deletionBlocked(backupId))return false;db.prepare("INSERT OR IGNORE INTO retention_operations VALUES(?,'pending',?)").run(backupId,now());return true;});
}
// Object Lock: drop the blocking retention row (the backup stays usable) and retry at
// retainUntil, or in 24 h when the provider gives no date. Audit only on change.
export function deferDeletion(backupId,retainUntil=null,at=Date.now()){
 const until=Date.parse(retainUntil),retryAfter=Number.isFinite(until)&&until>at?until:at+86400000;
 transaction(()=>{
  const previous=db.prepare('SELECT retain_until FROM retention_deferrals WHERE backup_id=?').get(backupId);
  db.prepare('DELETE FROM retention_operations WHERE backup_id=?').run(backupId);
  db.prepare('INSERT INTO retention_deferrals VALUES(?,?,?,?) ON CONFLICT(backup_id) DO UPDATE SET retry_after=excluded.retry_after,retain_until=excluded.retain_until').run(backupId,retryAfter,retainUntil||null,at);
  if(!previous||previous.retain_until!==(retainUntil||null))audit('worker','retention.deferred',backupId,{retainUntil:retainUntil||null});
 });
}
export const deletionDeferred=(backupId,at=Date.now())=>Boolean(db.prepare('SELECT 1 FROM retention_deferrals WHERE backup_id=? AND retry_after>?').get(backupId,at));
// The main package ages out (site retention). Copies that their own destination still keeps survive it: the main file is
// removed first (Object Lock on it defers everything, as before), then the copies no destination keeps. backups.path keeps
// naming the main package (docs/backup-copies.md); backup_main_removed marks it gone and packagePath() then reads the
// newest verified copy. An Object-Locked copy is kept, still usable, until its lock ends.
export async function finishDeletion(backupId){
 const backup=db.prepare('SELECT * FROM backups WHERE id=?').get(backupId);if(!backup)return;
 if(deletionBlocked(backupId)){db.prepare('DELETE FROM retention_operations WHERE backup_id=?').run(backupId);return;}
 const kept=new Set(keptCopies(backupId).map(copy=>copy.target_id));
 try{if(await fileExists(backup.path))await removeFile(backup.path);}
 catch(error){if(error?.code!=='EOBJECTLOCKED')throw error;deferDeletion(backupId,error.retainUntil);return {deferred:true};}
 // Recorded at once: if a copy deletion below throws, startup checks read the copy, not the gone main package.
 const verified=db.prepare("SELECT target_id FROM backup_copies WHERE backup_id=? AND status='verified' AND (delete_state IS NULL OR delete_state='deferred') ORDER BY delete_state IS NOT NULL,verified_at DESC,target_id LIMIT 1").get(backupId);
 if(verified)markMainRemoved(backup,verified.target_id);
 for(const copy of liveCopies(backupId)){
  if(kept.has(copy.target_id))continue;
  if(copy.status!=='verified'){await removeCopyFiles(copy,{partialOnly:true});markCopyDeleted(copy);continue;}
  if(!(await deleteCopyFiles(copy)).deferred)markCopyDeleted(copy);
 }
 if(db.prepare("SELECT 1 FROM backup_copies WHERE backup_id=? AND status='verified'").get(backupId))return {mainRemoved:true};
 transaction(()=>dropBackupRow(backupId));
}
function dropBackupRow(backupId){
 db.prepare('DELETE FROM downloads WHERE backup_id=? AND expires_at<=?').run(backupId,Date.now());
 db.prepare('DELETE FROM backups WHERE id=?').run(backupId);
 db.prepare('DELETE FROM backup_main_removed WHERE backup_id=?').run(backupId);
 db.prepare("UPDATE backup_copies SET status='deleted',delete_state=NULL,next_attempt_at=NULL,updated_at=? WHERE backup_id=? AND status<>'deleted'").run(now(),backupId);
}
function markMainRemoved(backup,keptOn){
 transaction(()=>{
  db.prepare('INSERT INTO backup_main_removed(backup_id,original_path,removed_at) VALUES(?,?,?) ON CONFLICT(backup_id) DO NOTHING').run(backup.id,backup.path,now());
  db.prepare('DELETE FROM retention_operations WHERE backup_id=?').run(backup.id);
  db.prepare('DELETE FROM retention_deferrals WHERE backup_id=?').run(backup.id);
  audit('worker','backup.main_removed',backup.id,{keptOn});
 });
}
export const mainRemoved=backupId=>Boolean(db.prepare('SELECT 1 FROM backup_main_removed WHERE backup_id=?').get(backupId));
// The package to read for a backup: its main copy, or once that aged out, its newest verified copy (one not being
// deleted first). Download, ZIP export, scrub, restore, restore tests and startup checks all read through this.
export function packagePath(backup){
 if(!mainRemoved(backup.id))return backup.path;
 const copy=db.prepare("SELECT path FROM backup_copies WHERE backup_id=? AND status='verified' AND (delete_state IS NULL OR delete_state='deferred') ORDER BY delete_state IS NOT NULL,verified_at DESC,target_id LIMIT 1").get(backup.id);
 return copy?.path??backup.path;
}

// ---- Backup copies (docs/backup-copies.md) ----------------------------------------------------------------------------
// A backup_copies row is the copy's publication journal, and status 'copying' is the lease that keeps the backup from
// being deleted while it is read. The bytes are copied as they are (no re-encryption), written to `<path>.partial`,
// synced, authenticated in full (AES-256-GCM tag and SHA-256 equal to the main copy's), and only then renamed and
// recorded. A file already at the copy path is adopted only when it authenticates; a different one is never overwritten.
export const COPY_RETRY_MS=Object.freeze([5*60_000,30*60_000,2*3600_000]),COPY_RETRY_EVERY_MS=6*3600_000,COPY_GIVE_UP_MS=7*86400_000;
// Fixed, owner-facing sentences: a raw storage error can carry hosts, paths or provider text, so it is never stored.
export const COPY_ERRORS=Object.freeze({
 unreachable:'Could not reach the copy destination or write to it.',
 space:'Not enough free space on the copy destination.',
 conflict:'A different file already exists where the copy goes. DockNest never overwrites it.',
 checksum:'The copied file did not match the backup and was discarded.',
 source:'The main copy could not be read.',
 destination_missing:'The copy destination was removed.',
 same_destination:'The copy destination is the same place as the main copy.',
});
// attempts: failed attempts so far, this one included. Retries after 5 min, 30 min, 2 h, then every 6 h; the last try is
// when 7 days have passed since the first failure, and a failure after that gives up.
export function copyRetryPlan(attempts,firstFailedAt,at=Date.now()){
 if(at-firstFailedAt>=COPY_GIVE_UP_MS)return {status:'gave_up',nextAttemptAt:null};
 const delay=COPY_RETRY_MS[attempts-1]??COPY_RETRY_EVERY_MS;
 return {status:'failed',nextAttemptAt:Math.min(at+delay,firstFailedAt+COPY_GIVE_UP_MS)};
}
// Inside finalizePublication's transaction. A destination that is (or overlaps) the main one is never written twice.
export function scheduleCopies(backupId,siteId,mainPath){
 const site=db.prepare('SELECT id,name,server_id FROM sites WHERE id=?').get(siteId),server=site&&db.prepare('SELECT id,name FROM servers WHERE id=?').get(site.server_id);
 if(!server)return 0;
 const mainTarget=targetIdOfPath(mainPath);let count=0;
 for(const {target_id:targetId} of siteCopyTargets(siteId)){
  let copyPath=null,reason=null;
  if(sameLocation(targetId,mainTarget))reason='same_destination';
  else try{copyPath=copyPathFor(targetId,server,site,mainPath);}catch{reason='destination_missing';}
  if(reason){audit('worker','backup.copy_skipped',backupId,{targetId,reason});continue;}
  count+=db.prepare("INSERT OR IGNORE INTO backup_copies(backup_id,target_id,path,status,attempts,created_at,updated_at) VALUES(?,?,?,'pending',0,?,?)").run(backupId,targetId,copyPath,now(),now()).changes;
  count+=scheduleAncestorCopies(backupId,targetId,server,site);
 }
 return count;
}
// An increment is only useful on a destination that also holds every package it builds on (docs/incremental-backups.md):
// its ancestors get a copy there too (a destination added after the chain began), and a copy the owner deleted or that
// gave up is tried again.
function scheduleAncestorCopies(backupId,targetId,server,site){
 let count=0;
 for(let link=db.prepare('SELECT parent_id FROM backup_chain_links WHERE backup_id=?').get(backupId),steps=0;link?.parent_id&&steps<31;steps++){
  const parent=db.prepare('SELECT id,path FROM backups WHERE id=?').get(link.parent_id);if(!parent)break;
  let copyPath;try{copyPath=copyPathFor(targetId,server,site,parent.path);}catch{break;}
  count+=db.prepare("INSERT OR IGNORE INTO backup_copies(backup_id,target_id,path,status,attempts,created_at,updated_at) VALUES(?,?,?,'pending',0,?,?)").run(parent.id,targetId,copyPath,now(),now()).changes;
  count+=db.prepare("UPDATE backup_copies SET status='pending',attempts=0,first_failed_at=NULL,next_attempt_at=NULL,delete_state=NULL,delete_after=NULL,updated_at=? WHERE backup_id=? AND target_id=? AND status IN ('deleted','gave_up')").run(now(),parent.id,targetId).changes;
  link=db.prepare('SELECT parent_id FROM backup_chain_links WHERE backup_id=?').get(parent.id);
 }
 return count;
}
// Oldest backup first, so a parent is always copied before what builds on it (incremental chains, 2.12). An increment is
// copied to a destination only once its parent's copy there is verified.
export function claimCopy(at=Date.now()){
 return transaction(()=>{
  if(deploymentHeld(db))return null;
  const copy=db.prepare(`SELECT c.*,b.checksum,b.size,b.path AS source,b.site_id FROM backup_copies c JOIN backups b ON b.id=c.backup_id
   WHERE c.status IN ('pending','failed') AND c.delete_state IS NULL AND (c.next_attempt_at IS NULL OR c.next_attempt_at<=?)
   AND NOT EXISTS(SELECT 1 FROM retention_operations r WHERE r.backup_id=c.backup_id)
   AND EXISTS(SELECT 1 FROM site_storage_copies l WHERE l.site_id=b.site_id AND l.target_id=c.target_id)
   AND NOT EXISTS(SELECT 1 FROM backup_chain_links k WHERE k.backup_id=c.backup_id AND k.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM backup_copies p WHERE p.backup_id=k.parent_id AND p.target_id=c.target_id AND p.status='verified'))
   ORDER BY b.captured_at,b.id,c.created_at,c.target_id LIMIT 1`).get(at);
  if(!copy)return null;
  if(db.prepare("UPDATE backup_copies SET status='copying',updated_at=? WHERE backup_id=? AND target_id=? AND status=?").run(now(),copy.backup_id,copy.target_id,copy.status).changes!==1)return null;
  return {...copy,source:packagePath({id:copy.backup_id,path:copy.source}),status:'copying'};
 });
}
const targetNameOf=targetId=>targetSummary(targetId)?.name??'Removed destination';
export function completeCopy(copy,{adopted=false}={}){
 return transaction(()=>{
  const row=db.prepare("SELECT c.alerted,b.site_id FROM backup_copies c JOIN backups b ON b.id=c.backup_id WHERE c.backup_id=? AND c.target_id=? AND c.status='copying'").get(copy.backup_id,copy.target_id);
  if(!row)return false;
  db.prepare("UPDATE backup_copies SET status='verified',verified_at=?,last_error=NULL,next_attempt_at=NULL,alerted=0,updated_at=? WHERE backup_id=? AND target_id=?").run(now(),now(),copy.backup_id,copy.target_id);
  const detail={siteId:row.site_id,targetId:copy.target_id,targetName:targetNameOf(copy.target_id)};
  audit('worker','backup.copy_verified',copy.backup_id,{...detail,...(adopted?{adopted:true}:{})});
  // Read by the alert detector (src/alerts/detect.js): a copy that failed before is saved now.
  if(row.alerted)audit('worker','backup.copy_recovered',copy.backup_id,detail);
  return true;
 });
}
export function failCopy(copy,code,at=Date.now()){
 const reason=Object.hasOwn(COPY_ERRORS,code)?code:'unreachable';
 return transaction(()=>{
  const row=db.prepare("SELECT c.*,b.site_id FROM backup_copies c JOIN backups b ON b.id=c.backup_id WHERE c.backup_id=? AND c.target_id=? AND c.status='copying'").get(copy.backup_id,copy.target_id);
  if(!row)return null;
  const attempts=row.attempts+1,first=row.first_failed_at??at,plan=copyRetryPlan(attempts,first,at);
  db.prepare('UPDATE backup_copies SET status=?,attempts=?,first_failed_at=?,next_attempt_at=?,last_error=?,alerted=1,updated_at=? WHERE backup_id=? AND target_id=?').run(plan.status,attempts,first,plan.nextAttemptAt,COPY_ERRORS[reason],now(),copy.backup_id,copy.target_id);
  const detail={siteId:row.site_id,targetId:copy.target_id,targetName:targetNameOf(copy.target_id),reason,attempts};
  // Only the first failure of this copy alerts (backup.copy_failed); later failures reschedule quietly.
  if(!row.alerted)audit('worker','backup.copy_failed',copy.backup_id,detail);
  if(plan.status==='gave_up')audit('worker','backup.copy_gave_up',copy.backup_id,detail);
  return plan;
 });
}
// A copy step that stepped aside for a queued site job: due again at `at` (the next worker tick), no attempt counted,
// no alert.
export function yieldCopy(copy,at=Date.now()){
 const changed=db.prepare("UPDATE backup_copies SET status=CASE WHEN attempts>0 THEN 'failed' ELSE 'pending' END,next_attempt_at=?,updated_at=? WHERE backup_id=? AND target_id=? AND status='copying'").run(at,now(),copy.backup_id,copy.target_id).changes;
 if(changed)audit('worker','backup.copy_yielded',copy.backup_id,{targetId:copy.target_id});
 return changed===1;
}
// The owner's retry: a fresh 7-day window, due at once.
export function retryCopy(backupId,targetId,at=Date.now()){
 return transaction(()=>{
  const row=db.prepare('SELECT status,delete_state FROM backup_copies WHERE backup_id=? AND target_id=?').get(backupId,targetId);
  if(!row||row.status==='deleted')return {found:false};
  if(['verified','copying'].includes(row.status)||row.delete_state)return {found:true,refused:row.delete_state?'deleting':row.status};
  db.prepare("UPDATE backup_copies SET status='pending',attempts=0,first_failed_at=NULL,next_attempt_at=?,updated_at=? WHERE backup_id=? AND target_id=?").run(at,now(),backupId,targetId);
  // An increment's copy waits for its parent's copy there: a parent copy that failed or gave up is tried again too.
  for(let link=db.prepare('SELECT parent_id FROM backup_chain_links WHERE backup_id=?').get(backupId),steps=0;link?.parent_id&&steps<31;steps++){
   db.prepare("UPDATE backup_copies SET status='pending',attempts=0,first_failed_at=NULL,next_attempt_at=?,updated_at=? WHERE backup_id=? AND target_id=? AND status IN ('failed','gave_up') AND delete_state IS NULL").run(at,now(),link.parent_id,targetId);
   link=db.prepare('SELECT parent_id FROM backup_chain_links WHERE backup_id=?').get(link.parent_id);
  }
  audit('worker','backup.copy_retry',backupId,{targetId});
  return {found:true,nextAttemptAt:at};
 });
}
export async function authenticateCopyFile(file,copy,verify){
 if((await statFile(file)).size!==copy.size)return false;
 try{return await verify(file)===copy.checksum;}catch{return false;}
}
// Worker start: a copy step the previous worker did not finish. A published file is adopted only after full
// authentication, an authenticated .partial is published, and anything else is removed and the copy tried again.
// Under the deployment hold nothing is touched; the worker's maintenance step tries again once the hold is released.
export async function recoverInterruptedCopies(verify){
 const result={adopted:0,retried:0,failed:0};
 if(deploymentHeld(db))return {...result,held:true};
 for(const copy of db.prepare("SELECT c.*,b.checksum,b.size,b.site_id FROM backup_copies c JOIN backups b ON b.id=c.backup_id WHERE c.status='copying'").all()){
  try{
   const temporary=copy.path+'.partial';
   if(await fileExists(copy.path)){
    if(!await authenticateCopyFile(copy.path,copy,verify)){failCopy(copy,'conflict');result.failed++;continue;}
    await removeCopyFiles(copy,{partialOnly:true});
    completeCopy(copy,{adopted:true});result.adopted++;continue;
   }
   if(await fileExists(temporary)){
    if(await authenticateCopyFile(temporary,copy,verify)){await renameFile(temporary,copy.path);await syncFile(copy.path);completeCopy(copy,{adopted:true});result.adopted++;continue;}
    await removeFile(temporary);
   }
   db.prepare("UPDATE backup_copies SET status='pending',next_attempt_at=?,updated_at=? WHERE backup_id=? AND target_id=? AND status='copying'").run(Date.now(),now(),copy.backup_id,copy.target_id);
   audit('worker','backup.copy_resumed',copy.backup_id,{targetId:copy.target_id});result.retried++;
  }catch{failCopy(copy,'unreachable');result.failed++;}
 }
 return result;
}
// Copies a destination still keeps once the main package goes: verified and among that destination's newest `retention`
// unpinned copies of the site. A destination the site no longer copies to keeps the site's own count. Newest verified first.
export function keptCopies(backupId){
 const backup=db.prepare('SELECT id,site_id,captured_at FROM backups WHERE id=?').get(backupId);if(!backup)return [];
 const counts=new Map(siteCopyTargets(backup.site_id).map(row=>[row.target_id,effectiveRetention(backup.site_id,row.retention)]));
 return db.prepare("SELECT * FROM backup_copies WHERE backup_id=? AND status='verified' AND delete_state IS NULL ORDER BY verified_at DESC,target_id").all(backupId).filter(copy=>{
  const count=counts.get(copy.target_id)??effectiveRetention(backup.site_id,null);
  const newer=db.prepare("SELECT COUNT(*) AS n FROM backup_copies c JOIN backups b ON b.id=c.backup_id WHERE c.target_id=? AND c.status='verified' AND c.delete_state IS NULL AND b.site_id=? AND b.pinned=0 AND (b.captured_at>? OR (b.captured_at=? AND b.id>?))").get(copy.target_id,backup.site_id,backup.captured_at,backup.captured_at,backup.id).n;
  return newer<count;
 });
}
export const liveCopies=backupId=>db.prepare("SELECT * FROM backup_copies WHERE backup_id=? AND status<>'deleted' ORDER BY target_id").all(backupId);
async function removeIfPresent(file){try{await removeFile(file);}catch(error){if(!missing(error))throw error;}}
// A leftover .partial is never a package: it is removed when present, and failing to remove it changes nothing.
export async function removeCopyFiles(copy,{partialOnly=false}={}){
 await removeIfPresent(copy.path+'.partial').catch(()=>{});
 if(!partialOnly)await removeIfPresent(copy.path);
}
// Removes one copy's package. Object Lock defers it, for this copy only, until the lock ends (24 h when no date is given).
export async function deleteCopyFiles(copy,at=Date.now()){
 try{await removeCopyFiles(copy);return {deleted:true};}
 catch(error){
  if(error?.code!=='EOBJECTLOCKED')throw error;
  const until=Date.parse(error.retainUntil),retry=Number.isFinite(until)&&until>at?until:at+86400000;
  db.prepare("UPDATE backup_copies SET delete_state='deferred',delete_after=?,retain_until=?,updated_at=? WHERE backup_id=? AND target_id=?").run(retry,error.retainUntil||null,now(),copy.backup_id,copy.target_id);
  audit('worker','backup.copy_deletion_deferred',copy.backup_id,{targetId:copy.target_id,retainUntil:error.retainUntil||null});
  return {deferred:true};
 }
}
export function markCopyDeleted(copy){
 db.prepare("UPDATE backup_copies SET status='deleted',delete_state=NULL,delete_after=NULL,next_attempt_at=NULL,updated_at=? WHERE backup_id=? AND target_id=?").run(now(),copy.backup_id,copy.target_id);
}
// After a copy's package is gone: a backup whose main package already aged out is removed once no verified copy is left.
export function settleAfterCopyRemoval(copy){
 return transaction(()=>{
  markCopyDeleted(copy);
  if(!db.prepare('SELECT 1 FROM backups WHERE id=?').get(copy.backup_id)||!mainRemoved(copy.backup_id))return 'kept';
  if(db.prepare("SELECT 1 FROM backup_copies WHERE backup_id=? AND status='verified'").get(copy.backup_id))return 'kept';
  dropBackupRow(copy.backup_id);audit('worker','backup.removed',copy.backup_id,{lastCopyOn:copy.target_id});return 'removed';
 });
}
export async function reconcileArtifacts(verify,{checkCompleted=false,onJobCompleted=async()=>{}}={}){
 const result={published:0,deleted:0,pending:0};
 if(checkCompleted){
  for(const operation of db.prepare("SELECT a.* FROM artifact_operations a JOIN backups b ON b.id=a.backup_id WHERE a.state='completed'").all()){
   // A main package that aged out under retention is checked where it now lives (its newest verified copy).
   const file=mainRemoved(operation.backup_id)?packagePath({id:operation.backup_id,path:operation.published}):operation.published;
   try{if((await statFile(file)).size!==operation.size)throw new Error('Published package size changed');}
   catch{
    transaction(()=>{db.prepare('UPDATE backups SET verified=0 WHERE id=?').run(operation.backup_id);recordVerification(operation.backup_id,'integrity',{status:'failed',method:'startup published package existence and size check unavailable or failed'},operation.job_id);});
    result.pending++;audit('worker','publication.completed_package_review_required',operation.backup_id,{});
   }
  }
 }
 for(const operation of db.prepare("SELECT * FROM artifact_operations WHERE state IN ('prepared','authenticated')").all()){
  try{
   if(operation.state==='prepared'){
    // No durable authentication record: never publish a partial package, even if it looks complete.
    if(await fileExists(operation.published))throw new Error('Unexpected published package requires review');
    if(await fileExists(operation.temporary))await removeFile(operation.temporary);
    db.prepare("UPDATE artifact_operations SET state='aborted',updated_at=? WHERE backup_id=?").run(now(),operation.backup_id);continue;
   }
   const exists=await fileExists(operation.published),file=exists?operation.published:operation.temporary;
   if(await verify(file)!==operation.checksum||(await statFile(file)).size!==operation.size)throw new Error('Journal authentication does not match package');
   if(!exists)await renameFile(operation.temporary,operation.published);
   await syncFile(operation.published);
   const completed=finalizePublication(operation.backup_id);result.published++;audit('worker','publication.reconciled',operation.backup_id,{});
   if(completed)await onJobCompleted(operation.job_id).catch(()=>{});
  }catch{result.pending++;audit('worker','publication.reconciliation_pending',operation.backup_id,{});}
 }
 for(const operation of db.prepare('SELECT * FROM retention_operations').all()){
  try{if(!(await finishDeletion(operation.backup_id))?.deferred)result.deleted++;}catch{result.pending++;audit('worker','retention.reconciliation_pending',operation.backup_id,{});}
 }
 // Deferred (Object Lock) deletions are retried once their retry date has passed.
 for(const deferral of db.prepare('SELECT backup_id FROM retention_deferrals WHERE retry_after<=?').all(Date.now())){
  try{
   if(!claimDeletion(deferral.backup_id)){db.prepare('DELETE FROM retention_deferrals WHERE backup_id=?').run(deferral.backup_id);continue;}
   if(!(await finishDeletion(deferral.backup_id))?.deferred)result.deleted++;
  }catch{result.pending++;audit('worker','retention.reconciliation_pending',deferral.backup_id,{});}
 }
 return result;
}
