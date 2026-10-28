// Backup copies (2.11): a real site is backed up to the SFTP destination with an S3-compatible copy (MinIO-compatible
// server on the runner), the main package is deleted, and the site is restored from the copy. A tampered copy is
// refused. The copy step is driven like the worker does (claimCopy + executeCopy). Credentials are throwaway values and
// are never printed.
import assert from 'node:assert/strict';
import { startS3Fixture } from './integration-s3.js';

export async function runCopiesScenario({run,until,hosts,servers,db,record,siteId}){
 const {targetId:copyTargetId,stop}=await startS3Fixture({run,until,db,label:'QA copy S3'});
 const {enqueueBackup,claimJob,executeJob,planRestore,enqueueRestore,verifyEncrypted}=await import('../src/engine.js');
 const {updateSiteStorage,siteStorageView}=await import('../src/site-storage.js');
 const {claimCopy}=await import('../src/artifact-journal.js');
 const {executeCopy}=await import('../src/backup-copies.js');
 const {removeFile,openRead,openWrite}=await import('../src/storage.js');
 const copyRow=backupId=>db.prepare('SELECT * FROM backup_copies WHERE backup_id=? AND target_id=?').get(backupId,copyTargetId);
 const restoreAndRead=async(backupId,options)=>{
  const plan=await planRestore(backupId,{serverId:servers[1].id,...options});
  assert.equal(plan.executable,true,JSON.stringify(plan.blockers));
  const queued=await enqueueRestore(backupId,plan,'qa'),job=claimJob();assert.equal(job.id,queued.id);await executeJob(job);
  const row=db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
  return {plan,row};
 };
 let testBackupId=null;
 try{
  // Storage per site: default (SFTP) stays the main destination, S3 is the one copy. Same function the PUT route calls.
  const view=updateSiteStorage(siteId,{mainTargetId:null,copies:[{targetId:copyTargetId,retention:null}]},'qa');
  assert.equal(view.copies.length,1);assert.equal(view.copies[0].targetId,copyTargetId);assert.equal(view.copies[0].mode,'s3');
  await run('exec',hosts[0],'docker','exec','site-a','python','-c',"from pathlib import Path;import sqlite3;Path('/site/asset.txt').write_text('copy-asset');db=sqlite3.connect('/site/database.sqlite');db.execute(\"UPDATE records SET value='copy-record'\");db.commit()");
  enqueueBackup(siteId,'qa');const job=claimJob();await executeJob(job);
  const finished=db.prepare('SELECT status,error FROM jobs WHERE id=?').get(job.id);assert.equal(finished.status,'completed',finished.error);
  const backup=db.prepare('SELECT * FROM backups WHERE job_id=?').get(job.id);
  testBackupId=backup.id;
  assert.ok(backup.path.startsWith('sftp:'),'The main package is on the SFTP destination');
  assert.ok(copyRow(backup.id),'A copy row was queued when the main package was published');
  assert.equal(await run('exec',hosts[0],'docker','inspect','--format','{{.State.Running}}','site-a'),'true');
  // Condition-based: run copy steps like the worker loop until the copy is verified (or the deadline passes).
  await until(async()=>{
   const row=copyRow(backup.id);
   if(row.status==='verified')return true;
   const copy=claimCopy();if(copy)await executeCopy(copy,verifyEncrypted);
   return copyRow(backup.id).status==='verified';
  },'The S3 copy did not reach verified',120);
  const copy=copyRow(backup.id);
  assert.ok(copy.path.startsWith('s3:'+copyTargetId+':'));
  assert.equal(await verifyEncrypted(copy.path),backup.checksum,'The copy is the same encrypted package (same SHA-256)');
  assert.equal(siteStorageView(siteId).copyMissing,false);
  record('Backup copies: a real site backs up to SFTP and the S3 copy is made after publication, authenticates with the same SHA-256 and the source keeps running');

  // The main package is gone (lost server, deleted by mistake). Restore falls back to the verified copy.
  await removeFile(backup.path);
  await run('exec',hosts[0],'docker','exec','site-a','python','-c',"import sqlite3;db=sqlite3.connect('/site/database.sqlite');db.execute(\"UPDATE records SET value='after-copy-backup'\");db.commit()");
  const {plan,row}=await restoreAndRead(backup.id);
  assert.equal(row.status,'completed',row.error);
  assert.equal(plan.source.role,'copy','Restore falls back to the copy once the main package is gone');
  assert.equal(plan.source.targetId,copyTargetId);
  assert.ok(plan.sources.some(source=>source.role==='copy'&&source.status==='verified'),'The copy is offered as a source');
  const {containerId}=JSON.parse(row.details).result;
  const values=JSON.parse(await run('exec',hosts[1],'docker','exec',containerId,'python','-c',"import sqlite3,json;from pathlib import Path;print(json.dumps({'record':sqlite3.connect('/site/database.sqlite').execute('SELECT value FROM records').fetchone()[0],'asset':Path('/site/asset.txt').read_text(),'layer':Path('/app/writable.txt').read_text()}))"));
  assert.deepEqual(values,{record:'copy-record',asset:'copy-asset',layer:'snapshot-layer'});
  assert.equal(await run('exec',hosts[1],'docker','inspect','--format','{{.HostConfig.NetworkMode}}',containerId),'none');
  assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='restore.source_fallback'").get(),'The fallback to the copy is audited');
  record('With the main package deleted from SFTP, restore uses the S3 copy and brings back the database row, files and writable layer as captured; the copy has network none');

  // A tampered copy (one byte flipped in the stored object) is refused; with the main gone there is nothing to restore from.
  const chunks=[];for await(const chunk of await openRead(copy.path))chunks.push(chunk);
  const original=Buffer.concat(chunks),bytes=Buffer.from(original);bytes[bytes.length>>1]^=1;
  const put=async data=>{const output=await openWrite(copy.path);await new Promise((resolve,reject)=>{output.once('error',reject);output.end(data,resolve);});};
  await put(bytes);
  await assert.rejects(verifyEncrypted(copy.path),'The tampered copy fails authentication');
  let refused=false;
  try{
   const attempt=await restoreAndRead(backup.id,{sourceTargetId:copyTargetId});
   refused=attempt.row.status!=='completed';
  }catch{refused=true;}
  assert.ok(refused,'A tampered copy is never restored');
  await put(original);
  record('A tampered S3 copy fails authentication and is refused for restore');
 }finally{
  // Leave later scenarios unchanged: no copies configured for the site, no leftover fixture.
  try{updateSiteStorage(siteId,{mainTargetId:null,copies:[]},'qa');}catch{}
  // The test backup has no main package any more; drop it so later scenarios do not see a half-removed backup.
  try{if(testBackupId){db.prepare('DELETE FROM backup_copies WHERE backup_id=?').run(testBackupId);db.prepare('DELETE FROM backups WHERE id=?').run(testBackupId);}}catch{}
  await stop();
 }
}
