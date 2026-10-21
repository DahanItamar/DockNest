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
const {preparePublication,authenticatePublication,reconcileArtifacts,claimDeletion,finishDeletion}=await import('../src/artifact-journal.js');
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
test('administrators connect and test S3 destinations without the API returning the access key pair',async()=>{
 const {app}=await import('../src/server.js'),{digest}=await import('../src/crypto.js');
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try{
  const token=randomBytes(32).toString('base64url'),user=id();
  db.prepare("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)").run(user,'s3@example.invalid','fixture','fixture','[]',at.toISOString(),'S3','admin');
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token),user,'csrf',Date.now()+3600000,Date.now(),Date.now(),Date.now());
  const request=(route,body)=>fetch('http://127.0.0.1:'+server.address().port+'/api/storage-targets'+route,{method:body?'POST':'GET',body:body&&JSON.stringify(body),headers:{Cookie:'dbm_session='+token,Origin:process.env.APP_ORIGIN,'x-csrf-token':'csrf','Content-Type':'application/json'}});
  const payload={name:'Fixture R2',endpoint:plain.options.endpoint,region:'us-east-1',bucket:plain.options.bucket,prefix:'/api-prefix/',pathStyle:true,...plain.credentials};
  assert.equal((await request('/s3/connect',{...payload,endpoint:'http://storage.example.invalid'})).status,400);
  assert.equal((await request('/s3/connect',{...payload,prefix:'../escape'})).status,400);
  const created=await request('/s3/connect',payload),text=await created.text();
  assert.equal(created.status,201,text);
  for(const secret of [plain.credentials.secretAccessKey,plain.credentials.accessKeyId])assert.ok(!text.includes(secret));
  const body=JSON.parse(text);assert.equal(body.kind,'s3');assert.equal(body.root,'/api-prefix');assert.equal(body.bucket,plain.options.bucket);assert.equal(body.credential,undefined);
  const listed=await (await request('/')).text();
  for(const secret of [plain.credentials.secretAccessKey,plain.credentials.accessKeyId])assert.ok(!listed.includes(secret));
  assert.equal((await request('/'+body.id+'/test',{})).status,200);
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM audit_events WHERE action LIKE 'storage.%'").all()).includes(plain.credentials.secretAccessKey));
  assert.equal(plain.objects.size,0);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('Object Lock retention is applied on publish, verified, and blocks deletion until it expires',async()=>{
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
 await assert.rejects(finishDeletion('locked'),error=>error.code==='EOBJECTLOCKED'&&error.retainUntil===object.retainUntil);
 assert.ok(locking.objects.has(key));assert.ok(db.prepare("SELECT 1 FROM backups WHERE id='locked'").get());
 const result=await reconcileArtifacts(verifyEncrypted);assert.equal(result.pending,1);
 assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='retention.object_locked' AND target='locked'").get());
 // Once retention expires the recorded deletion intent completes.
 object.retainUntil=new Date(Date.now()-1000).toISOString();
 assert.equal((await reconcileArtifacts(verifyEncrypted)).deleted,1);assert.equal(locking.objects.size,0);
 void options;
});
