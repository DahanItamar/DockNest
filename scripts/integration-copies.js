// Backup copies (2.11): a real site is backed up to the SFTP destination with an S3-compatible copy (MinIO-compatible
// server on the runner), the main package is deleted, and the site is restored from the copy. A tampered copy is
// refused. The copy step is driven like the worker does (claimCopy + executeCopy). Credentials are throwaway values and
// are never printed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  const deadline=Date.now()+120000;
  for(;;){
   const status=copyRow(backup.id).status;
   if(status==='verified')break;
   if(status==='failed'||status==='gave_up')assert.fail('The S3 copy ended with status '+status+' (see the stored copy error code in the test database)');
   assert.ok(Date.now()<deadline,'The S3 copy did not reach verified before the deadline (status '+status+')');
   const next=claimCopy();if(next)await executeCopy(next,verifyEncrypted);else await new Promise(resolve=>setTimeout(resolve,1000));
  }
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
  // The S3 adapter never overwrites an object, so remove it first; end()'s callback also receives write errors.
  const put=async data=>{await removeFile(copy.path);const output=await openWrite(copy.path);await new Promise((resolve,reject)=>{output.once('error',reject);output.end(data,error=>error?reject(error):resolve());});};
  await put(bytes);
  await assert.rejects(verifyEncrypted(copy.path),'The tampered copy fails authentication');
  let refused=false;
  try{
   const attempt=await restoreAndRead(backup.id,{sourceTargetId:copyTargetId});
   refused=attempt.row.status!=='completed';
  }catch(error){refused=/did not authenticate|authenticat/i.test(String(error?.message));if(!refused)throw error;}
  assert.ok(refused,'A tampered copy is never restored');
  await put(original);
  record('A tampered S3 copy fails authentication and is refused for restore');
 }finally{
  // Leave later scenarios unchanged: no copies configured for the site, no leftover fixture.
  const cleanupFailures=[];
  try{updateSiteStorage(siteId,{mainTargetId:null,copies:[]},'qa');}catch{cleanupFailures.push('site storage reset');}
  // The test backup has no main package any more; drop it so later scenarios do not see a half-removed backup.
  try{if(testBackupId){db.prepare('DELETE FROM backup_copies WHERE backup_id=?').run(testBackupId);db.prepare('DELETE FROM backups WHERE id=?').run(testBackupId);}}catch{cleanupFailures.push('test backup removal');}
  await stop();
  if(cleanupFailures.length)console.warn('Copies scenario cleanup incomplete: '+cleanupFailures.join(', '));
 }
}

// Hardened sites (issue 145): a copy keeps the original's read-only root (and the RAM folder it needs), dropped
// capabilities with Docker defaults added back, and no-new-privileges. Shared by the restore, restore test and move
// scenarios. The fixture writes /app/writable.txt on first start, so the hardened image already holds it.
export const HARDENED_FLAGS=['--read-only','--tmpfs','/tmp:size=16m,mode=1777','--cap-drop','ALL','--cap-add','CHOWN','--cap-add','FOWNER','--cap-add','DAC_OVERRIDE','--security-opt','no-new-privileges'];
export async function buildHardenedImage(run,host,base){
 await run('exec',host,'sh','-c',`printf 'FROM ${base}\\nRUN printf hardened-layer > /app/writable.txt\\n' | docker build -q -t docknest-hardened:local -`);
 return 'docknest-hardened:local';
}
// What `docker inspect` and the kernel say about a container's protections, in one comparable form.
export async function hardeningOf(run,host,id){
 const [c]=JSON.parse(await run('exec',host,'docker','inspect',id)),h=c.HostConfig;
 const caps=list=>(list||[]).map(cap=>cap.toUpperCase().replace(/^CAP_/,'')).sort();
 const option=value=>/^no-new-privileges([:=]true)?$/.test(value)?'no-new-privileges=true':value.replace(/^([a-z-]+):/,'$1=');
 const kernel=(await run('exec',host,'docker','exec',id,'sh','-c',"grep -E '^(CapEff|CapBnd|NoNewPrivs|Seccomp):' /proc/1/status")).split('\n').map(line=>line.replace(/\s+/g,' ').trim()).sort();
 return {readonly:h.ReadonlyRootfs,drop:caps(h.CapDrop),add:caps(h.CapAdd),securityOpt:(h.SecurityOpt||[]).map(option).sort(),tmpfs:Object.keys(h.Tmpfs||{}).sort(),privileged:h.Privileged,kernel};
}
export async function assertReadOnlyRoot(run,host,id){
 await assert.rejects(run('exec',host,'docker','exec',id,'sh','-c','touch /app/escape'),'the copy cannot write its root filesystem');
}

// Isolated restore of a hardened site onto the second host: the copy's docker inspect and /proc/1/status match.
export async function runHardenedRestoreScenario({run,until,hosts,servers,db,record}){
 const {enqueueBackup,claimJob,executeJob,planRestore,enqueueRestore}=await import('../src/engine.js');
 const image=await buildHardenedImage(run,hosts[0],'docknest-fixture:local');
 await run('exec',hosts[0],'docker','run','-d','--name','hard-site',...HARDENED_FLAGS,'-v','hard-site-data:/site',image);
 let copyId=null;
 try{
  await until(async()=>(await run('exec',hosts[0],'docker','inspect','--format','{{.State.Health.Status}}','hard-site'))==='healthy','Hardened fixture is not healthy');
  const original=await hardeningOf(run,hosts[0],'hard-site');
  assert.equal(original.readonly,true);assert.deepEqual(original.drop,['ALL']);assert.deepEqual(original.securityOpt,['no-new-privileges=true']);
  const siteId=randomUUID(),cfg={containers:['hard-site'],stagingRoot:'/var/lib/docknest',exclusiveSourcesConfirmed:true,externalReferencesConfirmed:true,cleanShutdownConfirmed:true,shutdownProfile:'generic',maintenanceRequired:false,maintenance:{required:false}};
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId,servers[0].id,'hard-site',JSON.stringify(cfg),new Date().toISOString());
  const queued=enqueueBackup(siteId,'qa'),job=claimJob();assert.equal(job.id,queued.id);await executeJob(job);
  const done=db.prepare('SELECT status,error FROM jobs WHERE id=?').get(job.id);assert.equal(done.status,'completed',done.error);
  const backup=db.prepare('SELECT * FROM backups WHERE job_id=?').get(job.id);
  const plan=await planRestore(backup.id,{serverId:servers[1].id});assert.equal(plan.executable,true,JSON.stringify(plan.blockers));
  const restoreQueued=await enqueueRestore(backup.id,plan,'qa'),restoreJob=claimJob();assert.equal(restoreJob.id,restoreQueued.id);await executeJob(restoreJob);
  const row=db.prepare('SELECT * FROM jobs WHERE id=?').get(restoreJob.id);assert.equal(row.status,'completed',row.error);
  copyId=JSON.parse(row.details).result.containerId;
  assert.deepEqual(await hardeningOf(run,hosts[1],copyId),original,'the restored copy has the same read-only root, capabilities, security options and RAM folder');
  await assertReadOnlyRoot(run,hosts[1],copyId);
  assert.equal(await run('exec',hosts[1],'docker','exec',copyId,'cat','/app/writable.txt'),'hardened-layer');
  record('Hardened site restore: a container with a read-only root, a RAM folder, CapDrop ALL plus default capabilities and no-new-privileges restores to a copy whose docker inspect and /proc/1/status (CapEff, CapBnd, NoNewPrivs, Seccomp) match the original');
 }finally{
  if(copyId)await run('exec',hosts[1],'docker','rm','-f',copyId).catch(()=>{});
  await run('exec',hosts[0],'docker','rm','-f','hard-site').catch(()=>{});
 }
}
