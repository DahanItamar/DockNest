import { db,transaction,audit } from './db.js';
import { statFile,renameFile,removeFile,syncFile } from './storage.js';
import { recordVerification } from './recovery-evidence.js';
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
export function finalizePublication(backupId){
 transaction(()=>{
  const operation=db.prepare('SELECT * FROM artifact_operations WHERE backup_id=?').get(backupId);
  if(!operation||!['authenticated','completed'].includes(operation.state))throw new Error('Authenticated publication journal required');
  if(operation.state==='completed')return;
  const metadata=JSON.parse(operation.metadata);
  if(metadata.manifest?.deliveryMode==='direct'&&!metadata.manifest.complete)throw new Error('Incomplete direct capture cannot be published');
  db.prepare('INSERT INTO backups(id,site_id,job_id,captured_at,path,size,checksum,manifest,pinned,verified,created_at) VALUES(?,?,?,?,?,?,?,?,0,1,?)').run(backupId,operation.site_id,operation.job_id,metadata.capturedAt,operation.published,operation.size,operation.checksum,JSON.stringify(metadata.manifest),now());
  recordVerification(backupId,'integrity',{status:'passed',method:'full AES-256-GCM authentication and SHA256'},operation.job_id);
  recordVerification(backupId,'consistency',metadata.manifest.consistency||{status:'not-tested'},operation.job_id);
  db.prepare("UPDATE artifact_operations SET state='completed',updated_at=? WHERE backup_id=?").run(now(),backupId);
  db.prepare("UPDATE jobs SET status='completed',stage='completed',finished_at=?,error=NULL,details=? WHERE id=?").run(now(),JSON.stringify({backupId,downtimeSeconds:metadata.manifest.downtimeSeconds}),operation.job_id);
 });
}
export function deletionBlocked(backupId){
 return Boolean(db.prepare('SELECT id FROM backups WHERE id=? AND pinned=1').get(backupId)
  ||db.prepare("SELECT id FROM restores WHERE backup_id=? AND status IN ('queued','running','recovery_required')").get(backupId)
  ||db.prepare('SELECT id FROM downloads WHERE backup_id=? AND expires_at>?').get(backupId,Date.now())
  ||db.prepare("SELECT id FROM jobs WHERE type='scrub' AND status IN ('queued','running','recovery_required') AND json_extract(details,'$.backupId')=?").get(backupId)
  ||db.prepare("SELECT b.id FROM backups b WHERE b.verified=1 AND b.site_id=(SELECT site_id FROM backups WHERE id=?) AND EXISTS(SELECT 1 FROM backup_verification_history v WHERE v.backup_id=b.id AND v.kind='application' AND v.status='passed') ORDER BY b.captured_at DESC,b.id DESC LIMIT 1").get(backupId)?.id===backupId
  // Preserve the older currently passing point when the newest historical pass
  // has a later failed recovery attempt. Attempt history remains conservative.
  ||db.prepare("SELECT b.id FROM backups b WHERE b.verified=1 AND b.site_id=(SELECT site_id FROM backups WHERE id=?) AND EXISTS(SELECT 1 FROM backup_verifications v WHERE v.backup_id=b.id AND v.kind='application' AND v.status='passed') ORDER BY b.captured_at DESC,b.id DESC LIMIT 1").get(backupId)?.id===backupId);
}
export function claimDeletion(backupId){
 return transaction(()=>{if(deletionBlocked(backupId))return false;db.prepare("INSERT OR IGNORE INTO retention_operations VALUES(?,'pending',?)").run(backupId,now());return true;});
}
export async function finishDeletion(backupId){
 const backup=db.prepare('SELECT * FROM backups WHERE id=?').get(backupId);if(!backup)return;
 if(deletionBlocked(backupId)){db.prepare('DELETE FROM retention_operations WHERE backup_id=?').run(backupId);return;}
 if(await fileExists(backup.path))await removeFile(backup.path);
 transaction(()=>{db.prepare('DELETE FROM downloads WHERE backup_id=? AND expires_at<=?').run(backupId,Date.now());db.prepare('DELETE FROM backups WHERE id=?').run(backupId);});
}
export async function reconcileArtifacts(verify,{checkCompleted=false}={}){
 const result={published:0,deleted:0,pending:0};
 if(checkCompleted){
  for(const operation of db.prepare("SELECT a.* FROM artifact_operations a JOIN backups b ON b.id=a.backup_id WHERE a.state='completed'").all()){
   try{if((await statFile(operation.published)).size!==operation.size)throw new Error('Published package size changed');}
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
   finalizePublication(operation.backup_id);result.published++;audit('worker','publication.reconciled',operation.backup_id,{});
  }catch{result.pending++;audit('worker','publication.reconciliation_pending',operation.backup_id,{});}
 }
 for(const operation of db.prepare('SELECT * FROM retention_operations').all()){
  try{await finishDeletion(operation.backup_id);result.deleted++;}catch{result.pending++;audit('worker','retention.reconciliation_pending',operation.backup_id,{});}
 }
 return result;
}
