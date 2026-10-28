// Real backup and restore through S3-compatible storage (a MinIO-compatible server on the runner).
// The site is captured to S3 on the source host and restored on the second host; the SFTP destination is selected
// again afterwards so later scenarios are unchanged. Credentials are throwaway values and are never printed.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

const image=process.env.S3_SERVER_IMAGE||'pgsty/minio:RELEASE.2026-06-18T00-00-00Z@sha256:dacff8306a6e0a734518533992dbdcca26bc1ca47f77cf47cb9945725f92b29b';

// Starts a throwaway MinIO-compatible server and registers it as a storage destination.
// Returns {targetId, stop}; `stop` removes the server. Shared by the S3 and backup-copies scenarios.
export async function startS3Fixture({run,until,db,label='QA S3'}){
 const name='docknest-qa-s3-'+randomBytes(4).toString('hex'),accessKeyId='qa'+randomBytes(10).toString('hex'),secretAccessKey=randomBytes(24).toString('hex');
 const {seal}=await import('../src/crypto.js');
 const {s3Request}=await import('../src/storage/s3-client.js');
 const {testStorageTarget}=await import('../src/storage.js');
 const stop=()=>run('rm','-f','-v',name).catch(()=>{});
 try{
  await run('run','-d','--name',name,'-p','127.0.0.1::9000','-e','MINIO_ROOT_USER='+accessKeyId,'-e','MINIO_ROOT_PASSWORD='+secretAccessKey,image,'server','/data');
  const port=(await run('port',name,'9000/tcp')).split('\n')[0].split(':').pop();
  const settings={endpoint:'http://127.0.0.1:'+port,region:'us-east-1',bucket:'docknest-qa',pathStyle:true,objectLock:null};
  const options={mode:'s3',id:'qa-s3',name:label,...settings,root:'/qa',accessKeyId,secretAccessKey};
  await until(async()=>{try{await s3Request(options,{method:'PUT'});return true;}catch(error){return error.s3Code==='BucketAlreadyOwnedByYou';}},'S3 fixture did not start');
  assert.equal((await testStorageTarget(options)).readVerified,true);
  const targetId=randomUUID(),now=new Date().toISOString();
  db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(targetId,label,'127.0.0.1',Number(port),settings.bucket,'','s3-access-key',seal(JSON.stringify({accessKeyId,secretAccessKey})),options.root,0,'connected',now,now);
  db.prepare("INSERT INTO storage_target_settings VALUES(?,'s3',?)").run(targetId,JSON.stringify(settings));
  return {targetId,stop};
 }catch(error){await stop();throw error;}
}

export async function runS3Scenario({run,until,hosts,servers,db,record,siteId,sftpDestinationId}){
 const {targetId,stop}=await startS3Fixture({run,until,db});
 const {enqueueBackup,claimJob,executeJob,planRestore,enqueueRestore,verifyEncrypted}=await import('../src/engine.js');
 try{
  db.prepare("UPDATE settings SET value=? WHERE key='backup_storage_target'").run(targetId);

  await run('exec',hosts[0],'docker','exec','site-a','python','-c',"from pathlib import Path;import sqlite3;Path('/site/asset.txt').write_text('s3-asset');db=sqlite3.connect('/site/database.sqlite');db.execute(\"UPDATE records SET value='s3-record'\");db.commit()");
  enqueueBackup(siteId,'qa');const job=claimJob();await executeJob(job);
  const finished=db.prepare('SELECT status,error FROM jobs WHERE id=?').get(job.id);assert.equal(finished.status,'completed',finished.error);
  const backup=db.prepare('SELECT * FROM backups WHERE job_id=?').get(job.id);
  assert.ok(backup.path.startsWith('s3:'+targetId+':'),'The backup is published to the S3 destination');
  assert.equal(await verifyEncrypted(backup.path),backup.checksum);
  assert.equal(await run('exec',hosts[0],'docker','inspect','--format','{{.State.Running}}','site-a'),'true');
  record('A real site backup is published to S3-compatible storage (MinIO-compatible server), authenticates, and the source keeps running');

  await run('exec',hosts[0],'docker','exec','site-a','python','-c',"import sqlite3;db=sqlite3.connect('/site/database.sqlite');db.execute(\"UPDATE records SET value='after-s3-backup'\");db.commit()");
  const plan=await planRestore(backup.id,{serverId:servers[1].id});assert.equal(plan.executable,true,JSON.stringify(plan.blockers));
  const queued=await enqueueRestore(backup.id,plan,'qa'),restoreJob=claimJob();assert.equal(restoreJob.id,queued.id);await executeJob(restoreJob);
  const restored=db.prepare('SELECT * FROM jobs WHERE id=?').get(restoreJob.id);assert.equal(restored.status,'completed',restored.error);
  const {containerId}=JSON.parse(restored.details).result;
  const values=JSON.parse(await run('exec',hosts[1],'docker','exec',containerId,'python','-c',"import sqlite3,json;from pathlib import Path;print(json.dumps({'record':sqlite3.connect('/site/database.sqlite').execute('SELECT value FROM records').fetchone()[0],'asset':Path('/site/asset.txt').read_text(),'layer':Path('/app/writable.txt').read_text()}))"));
  assert.deepEqual(values,{record:'s3-record',asset:'s3-asset',layer:'snapshot-layer'});
  assert.equal(await run('exec',hosts[1],'docker','inspect','--format','{{.HostConfig.NetworkMode}}',containerId),'none');
  record('Second-host restore from S3 brings back the database row, files and writable layer as captured, not later live edits; the copy has network none');
 }finally{
  db.prepare("UPDATE settings SET value=? WHERE key='backup_storage_target'").run(sftpDestinationId);
  await stop();
 }
}
