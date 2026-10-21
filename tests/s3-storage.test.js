import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {startS3Fixture} from './s3-fixture.js';

const root=await mkdtemp(join(tmpdir(),'docknest-s3-'));
Object.assign(process.env,{DATA_DIR:root,MASTER_KEY_FILE:join(root,'master.key'),SETUP_TOKEN_FILE:join(root,'setup.token'),NODE_ENV:'test',BACKUP_STORAGE:'unconfigured',SECURE_COOKIES:'false',APP_ORIGIN:'http://127.0.0.1:3000'});
await writeFile(process.env.MASTER_KEY_FILE,randomBytes(32).toString('base64'));
const {db,id}=await import('../src/db.js'),{seal}=await import('../src/crypto.js');
const s3=await import('../src/storage/s3.js');
const {backupDirectory,storageJoin,makeDirectory,openWrite,openRead,statFile,syncFile,storageCapacity,checkStorageReadiness}=await import('../src/storage.js');
const {encryptStream,verifyEncrypted}=await import('../src/engine.js');
const {preparePublication,authenticatePublication,reconcileArtifacts,claimDeletion,finishDeletion,deletionDeferred}=await import('../src/artifact-journal.js');
const plain=await startS3Fixture(),locking=await startS3Fixture({bucket:'docknest-locked',objectLock:true});
const at=new Date('2026-10-03T12:13:14Z');
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run('server-1','Production','localhost',22,'fixture','synthetic','0'.repeat(64),at.toISOString());
db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run('site-1','server-1','Shop','{}',at.toISOString());
after(async()=>{await plain.close();await locking.close();db.close();await rm(root,{recursive:true,force:true});});
const adapterOptions=(fixture,extra={})=>({...fixture.options,id:'adapter',mode:'s3',root:'/docknest',objectLock:null,...extra});
function seedTarget(fixture,{prefix='tenant',objectLock=null}={}){
 const targetId=id(),url=new URL(fixture.options.endpoint),now=at.toISOString();
 db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(targetId,'Fixture bucket',url.hostname,Number(url.port),fixture.options.bucket,'','s3-access-key',seal(JSON.stringify(fixture.credentials)),'/'+prefix,0,'connected',now,now);
 db.prepare("INSERT INTO storage_target_settings VALUES(?,'s3',?)").run(targetId,JSON.stringify({endpoint:fixture.options.endpoint,region:fixture.options.region,bucket:fixture.options.bucket,pathStyle:true,objectLock}));
 db.prepare("INSERT INTO settings VALUES('backup_storage_target',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(targetId);
 return targetId;
}
const readAll=async stream=>{const parts=[];for await(const chunk of stream)parts.push(chunk);return Buffer.concat(parts);};
async function publish(directory,backupId,{authenticate=true}={}){
 const published=storageJoin(directory,backupId+'.tar.gz.enc'),temporary=published+'.partial';
 db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,'site-1','backup','running','transferring',?)").run(backupId,at.toISOString());
 await encryptStream(Readable.from([randomBytes(3000)]),await openWrite(temporary));await syncFile(temporary);
 preparePublication({backupId,jobId:backupId,siteId:'site-1',temporary,published,manifest:{},capturedAt:at.toISOString()});
 if(authenticate)authenticatePublication(backupId,await verifyEncrypted(temporary),(await statFile(temporary)).size);
 return {published,temporary};
}

test('every request is SigV4 signed; the probe covers multipart, copy, ranges and delete and leaves nothing behind',async()=>{
 plain.requests.length=0;
 const result=await s3.test(adapterOptions(plain));
 assert.deepEqual(result,{connected:true,writeVerified:true,multipartVerified:true,copyVerified:true,readVerified:true,rangeVerified:true,deleteVerified:true,objectLock:'not-requested'});
 assert.ok(plain.requests.length>5);
 for(const request of plain.requests){assert.match(request.headers.authorization,/^AWS4-HMAC-SHA256 Credential=AKIAFIXTURE\w+\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]*host[a-z0-9;-]*, Signature=[a-f0-9]{64}$/);assert.match(request.headers['x-amz-date'],/^\d{8}T\d{6}Z$/);assert.match(request.headers['x-amz-content-sha256'],/^[a-f0-9]{64}$/);}
 assert.ok(plain.requests.some(request=>'uploads' in request.query)&&plain.requests.some(request=>request.headers['x-amz-copy-source']));
 assert.equal(plain.objects.size,0);assert.equal(plain.uploads.size,0);
 const secret='wrong-'+randomBytes(8).toString('hex');
 await assert.rejects(s3.test(adapterOptions(plain,{secretAccessKey:secret})),error=>/signature/i.test(error.message)&&!error.message.includes(secret)&&!error.message.includes(plain.credentials.secretAccessKey));
 await assert.rejects(s3.test(adapterOptions(plain,{endpoint:'http://storage.example.invalid'})),/HTTPS/);
});
test('multipart uploads stream in bounded parts, refuse overwrites and serve exact byte ranges',async()=>{
 const saved=s3.limits.partSize;s3.limits.partSize=1000;
 try{
  plain.requests.length=0;
  const options=adapterOptions(plain),bytes=randomBytes(4500);
  await pipeline(Readable.from(Array.from({length:45},(_,index)=>bytes.subarray(index*100,index*100+100))),s3.openWrite(options,'/docknest/stream.bin'));
  const parts=plain.requests.filter(request=>request.method==='PUT'&&request.query.partNumber);
  assert.deepEqual(parts.map(request=>request.size),[1000,1000,1000,1000,500]);
  assert.deepEqual(plain.objects.get('docknest/stream.bin').body,bytes);
  assert.equal((await s3.statFile(options,'/docknest/stream.bin')).size,4500);
  assert.deepEqual(await readAll(await s3.openRead(options,'/docknest/stream.bin',{start:1234,end:3333})),bytes.subarray(1234,3334));
  assert.deepEqual(await readAll(await s3.openRead(options,'/docknest/stream.bin',{start:4000})),bytes.subarray(4000));
  await assert.rejects(pipeline(Readable.from([Buffer.from('x')]),s3.openWrite(options,'/docknest/stream.bin')),/already exists/);
  plain.faults.ignoreRange=true;await assert.rejects(s3.openRead(options,'/docknest/stream.bin',{start:10,end:20}),/byte range/);plain.faults.ignoreRange=false;
  assert.deepEqual((await s3.list(options,'/docknest')).map(file=>file.value),['/docknest/stream.bin']);
  await assert.rejects(s3.renameFile(options,'/docknest/stream.bin','/docknest/stream.bin'),/already exists/);
  assert.throws(()=>s3.resolve(options,'/other/escape.bin'),/outside managed S3/);
  // Objects above the single-copy limit are published with ranged UploadPartCopy requests.
  const copy={...s3.limits};Object.assign(s3.limits,{copyLimit:1000,copyPartSize:2000});
  try{await s3.renameFile(options,'/docknest/stream.bin','/docknest/moved.bin');}finally{Object.assign(s3.limits,copy);}
  assert.deepEqual(plain.requests.filter(request=>request.headers['x-amz-copy-source-range']).map(request=>request.headers['x-amz-copy-source-range']),['bytes=0-1999','bytes=2000-3999','bytes=4000-4499']);
  assert.deepEqual(plain.objects.get('docknest/moved.bin').body,bytes);assert.equal(plain.objects.has('docknest/stream.bin'),false);
  await assert.rejects(s3.renameFile(options,'/docknest/missing.bin','/docknest/moved.bin'),error=>error.code==='ENOENT');
  await s3.removeFile(options,'/docknest/moved.bin');await assert.rejects(s3.statFile(options,'/docknest/moved.bin'),error=>error.code==='ENOENT');
  // An interrupted stream aborts its multipart upload instead of publishing a truncated object.
  const output=s3.openWrite(options,'/docknest/aborted.bin');output.on('error',()=>{});output.write(randomBytes(2500));await new Promise(resolve=>setTimeout(resolve,100));output.destroy(new Error('interrupted'));
  await new Promise(resolve=>output.once('close',resolve));await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(plain.objects.has('docknest/aborted.bin'),false);assert.equal(plain.uploads.size,0);
 }finally{s3.limits.partSize=saved;}
});
test('journal publication copies authenticated uploads to final keys and never publishes unauthenticated partials',async()=>{
 const target=seedTarget(plain);
 const directory=backupDirectory({id:'server-1',name:'Production'},{id:'site-1',name:'Shop'});
 assert.equal(directory,'s3:'+target+':/tenant/BACKUP/production--server-1/shop--site-1');
 await makeDirectory(directory);
 const first=await publish(directory,'first'),interrupted=await publish(directory,'interrupted',{authenticate:false});
 assert.equal((await reconcileArtifacts(verifyEncrypted)).published,1);
 const keys=[...plain.objects.keys()];
 assert.deepEqual(keys,[first.published.slice(('s3:'+target+':/').length)]);
 assert.ok(!keys.some(key=>key.endsWith('.partial')));assert.equal(db.prepare("SELECT state FROM artifact_operations WHERE backup_id='interrupted'").get().state,'aborted');
 assert.equal(await verifyEncrypted(first.published),db.prepare("SELECT checksum FROM backups WHERE id='first'").get().checksum);
 void interrupted;
 const capacity=await storageCapacity();
 assert.equal(capacity.backend,'s3');assert.equal(capacity.unbounded,true);assert.equal(capacity.total,null);assert.equal(capacity.managedBytes,(await statFile(first.published)).size);
 assert.deepEqual(await checkStorageReadiness(),{reachable:true,writeTested:false});
 assert.equal(claimDeletion('first'),true);await finishDeletion('first');assert.equal(plain.objects.size,0);
});
// One authenticated API server for the route-level tests in this file.
let adminApi;
async function api(){
 if(adminApi)return adminApi;
 const {app}=await import('../src/server.js'),{digest}=await import('../src/crypto.js');
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const token=randomBytes(32).toString('base64url'),user=id();
 db.prepare("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)").run(user,'s3@example.invalid','fixture','fixture','[]',at.toISOString(),'S3','admin');
 db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token),user,'csrf',Date.now()+3600000,Date.now(),Date.now(),Date.now());
 const request=(route,body,method)=>fetch('http://127.0.0.1:'+server.address().port+'/api'+route,{method:method||(body?'POST':'GET'),body:body&&JSON.stringify(body),headers:{Cookie:'dbm_session='+token,Origin:process.env.APP_ORIGIN,'x-csrf-token':'csrf','Content-Type':'application/json'}});
 adminApi={request,close:()=>new Promise(resolve=>server.close(resolve))};
 return adminApi;
}
after(async()=>{await adminApi?.close();});
test('administrators connect and test S3 destinations without the API returning the access key pair',async()=>{
 const {request}=await api();
 const payload={name:'Fixture R2',endpoint:plain.options.endpoint,region:'us-east-1',bucket:plain.options.bucket,prefix:'/api-prefix/',pathStyle:true,...plain.credentials};
 assert.equal((await request('/storage-targets/s3/connect',{...payload,endpoint:'http://storage.example.invalid'})).status,400);
 assert.equal((await request('/storage-targets/s3/connect',{...payload,prefix:'../escape'})).status,400);
 const created=await request('/storage-targets/s3/connect',payload),text=await created.text();
 assert.equal(created.status,201,text);
 for(const secret of [plain.credentials.secretAccessKey,plain.credentials.accessKeyId])assert.ok(!text.includes(secret));
 const body=JSON.parse(text);assert.equal(body.kind,'s3');assert.equal(body.root,'/api-prefix');assert.equal(body.bucket,plain.options.bucket);assert.equal(body.credential,undefined);
 const listed=await (await request('/storage-targets')).text();
 for(const secret of [plain.credentials.secretAccessKey,plain.credentials.accessKeyId])assert.ok(!listed.includes(secret));
 assert.equal((await request('/storage-targets/'+body.id+'/test',{})).status,200);
 assert.ok(!JSON.stringify(db.prepare("SELECT * FROM audit_events WHERE action LIKE 'storage.%'").all()).includes(plain.credentials.secretAccessKey));
 assert.equal(plain.objects.size,0);
});
test('provider HTTP statuses never become DockNest API statuses',async()=>{
 const {request}=await api();
 const payload={name:'Fixture failure',endpoint:plain.options.endpoint,region:'us-east-1',bucket:plain.options.bucket,pathStyle:true,...plain.credentials};
 const target=db.prepare("SELECT id FROM storage_targets WHERE name='Fixture R2'").get().id;
 for(const [status,code,expected] of [[401,'',502],[403,'AccessDenied',400],[403,'',400],[404,'NoSuchBucket',400],[404,'',502],[500,'InternalError',502],[503,'SlowDown',502],[301,'PermanentRedirect',400]]){
  plain.faults.status={status,code};db.prepare("DELETE FROM rate_limits").run();
  try{
   for(const route of ['/storage-targets/s3/connect','/storage-targets/'+target+'/test']){
    const response=await request(route,route.endsWith('connect')?payload:{}),body=await response.json();
    assert.equal(response.status,expected,route+' '+status+' '+code);
    assert.ok(!/synthetic|RequestId|AKIA/.test(body.error),body.error);
   }
  }finally{plain.faults.status=null;}
 }
 // SFTP regression: non-S3 route errors keep the default 422 and the session survives.
 const sftp=id(),now=at.toISOString();
 db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(sftp,'Closed SFTP','127.0.0.1',1,'fixture','a'.repeat(64),'password',seal('fixture-not-a-real-credential'),'/backups',1e12,'connected',now,now);
 assert.equal((await request('/storage-targets/'+sftp+'/test',{})).status,422);
 assert.equal((await request('/storage-targets')).status,200);
 db.prepare('DELETE FROM storage_targets WHERE id=?').run(sftp);
});
test('Object Lock retention is applied on publish; locked points chosen by retention are deferred and stay usable',async()=>{
 const options=adapterOptions(locking,{objectLock:{mode:'COMPLIANCE',days:1}});
 await assert.rejects(s3.test(adapterOptions(plain,{objectLock:{mode:'COMPLIANCE',days:1}})),/Object Lock is not enabled/);
 locking.state.defaultRetention=true;await assert.rejects(s3.test(options),/default retention/);locking.state.defaultRetention=false;
 assert.equal((await s3.test(options)).objectLock,'enabled');assert.equal(locking.objects.size,0);
 seedTarget(locking,{prefix:'immutable',objectLock:{mode:'COMPLIANCE',days:1}});
 const directory=backupDirectory({id:'server-1',name:'Production'},{id:'site-1',name:'Shop'});
 const {published}=await publish(directory,'locked');
 assert.equal((await reconcileArtifacts(verifyEncrypted)).published,1);
 const [key,object]=[...locking.objects.entries()][0];
 assert.equal(locking.objects.size,1);assert.ok(published.endsWith(key));
 assert.equal(object.lockMode,'COMPLIANCE');assert.ok(Date.parse(object.retainUntil)>Date.now()+86400000-60000);
 assert.equal(claimDeletion('locked'),true);
 assert.deepEqual(await finishDeletion('locked'),{deferred:true});
 assert.ok(locking.objects.has(key));assert.ok(db.prepare("SELECT 1 FROM backups WHERE id='locked'").get());
 // No blocking retention row: download, pin and restore guards stay open while locked.
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM retention_operations WHERE backup_id='locked'").get().n,0);
 assert.equal(db.prepare("SELECT retry_after FROM retention_deferrals WHERE backup_id='locked'").get().retry_after,Date.parse(object.retainUntil));
 assert.equal(deletionDeferred('locked'),true);
 const {request}=await api();
 const download=await request('/backups/locked/download');assert.equal(download.status,200);assert.equal((await download.arrayBuffer()).byteLength,object.body.length);
 for(let tick=0;tick<5;tick++)await reconcileArtifacts(verifyEncrypted);
 const deferredAudits=()=>db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='retention.deferred' AND target='locked'").get().n;
 assert.equal(deferredAudits(),1);
 // Pinning removes the deferral; a pinned point is never deleted when the lock ends.
 assert.equal((await request('/backups/locked/pin',{pinned:true})).status,200);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM retention_deferrals").get().n,0);
 assert.equal((await request('/backups/locked/pin',{pinned:false})).status,200);
 assert.equal(claimDeletion('locked'),true);assert.deepEqual(await finishDeletion('locked'),{deferred:true});
 assert.equal(deferredAudits(),2);
 // An extended lock updates the deferral (one more audit); expiry lets reconciliation delete it.
 object.retainUntil=new Date(Date.now()+2*86400000).toISOString();
 db.prepare('UPDATE retention_deferrals SET retry_after=0').run();
 assert.equal((await reconcileArtifacts(verifyEncrypted)).deleted,0);assert.equal(deferredAudits(),3);
 assert.equal(db.prepare("SELECT retry_after FROM retention_deferrals WHERE backup_id='locked'").get().retry_after,Date.parse(object.retainUntil));
 object.retainUntil=new Date(Date.now()-1000).toISOString();
 db.prepare('UPDATE retention_deferrals SET retry_after=0').run();
 assert.equal((await reconcileArtifacts(verifyEncrypted)).deleted,1);assert.equal(locking.objects.size,0);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM retention_deferrals").get().n,0);
 void options;
});
test('storage migration copies deferred Object-Locked backups instead of being blocked by them',async()=>{
 const {migrateStorage}=await import('../src/storage-migration.js');
 const directory=backupDirectory({id:'server-1',name:'Production'},{id:'site-1',name:'Shop'});
 const {published}=await publish(directory,'deferred');
 assert.equal((await reconcileArtifacts(verifyEncrypted)).published,1);
 assert.equal(claimDeletion('deferred'),true);assert.deepEqual(await finishDeletion('deferred'),{deferred:true});
 db.prepare("UPDATE jobs SET status='completed' WHERE status='running'").run();
 db.prepare("INSERT INTO settings VALUES('deployment_hold','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
 const result=await migrateStorage();
 assert.equal(result.lockedOriginals,1);assert.ok(result.migrated>=1);
 const moved=db.prepare("SELECT path FROM backups WHERE id='deferred'").get().path;
 assert.notEqual(moved,published);assert.match(moved,/backup_2026-10-03_12-13-14Z--deferred\.tar\.gz\.enc$/);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM retention_deferrals").get().n,0);
 assert.equal(await verifyEncrypted(moved),db.prepare("SELECT checksum FROM backups WHERE id='deferred'").get().checksum);
 // The locked original stays until its lock ends; DockNest does not remove it.
 assert.ok(locking.objects.has(published.slice(published.indexOf(':/')+2)));
});
test('a refused locked-version delete is classified by retention headers, not by provider error wording',async()=>{
 const options=adapterOptions(locking,{objectLock:{mode:'GOVERNANCE',days:1}});
 for(const [wording,minio] of [['aws',false],['minio',true]]){
  locking.faults.minioLockError=minio;
  const key='/docknest/wording-'+wording;
  await pipeline(Readable.from([Buffer.from('locked bytes')]),s3.openWrite(options,key+'.partial'));
  await s3.renameFile(options,key+'.partial',key);
  const object=locking.objects.get(key.slice(1));
  // MinIO answers 400 InvalidRequest, AWS 403 AccessDenied; both are locked because retention is in the future.
  await assert.rejects(s3.deleteVersion(options,key.slice(1),object.versionId),error=>error.code==='EOBJECTLOCKED'&&error.retainUntil===object.retainUntil);
  // An unlocked object's refusal stays a real error.
  object.retainUntil=new Date(Date.now()-1000).toISOString();
  locking.faults.status={status:400,code:'InvalidRequest'};
  try{await assert.rejects(s3.deleteVersion(options,key.slice(1),object.versionId),error=>error.code!=='EOBJECTLOCKED');}finally{locking.faults.status=null;}
  await s3.removeFile(options,key);
 }
 locking.faults.minioLockError=false;
});
