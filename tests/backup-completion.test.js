import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
// A successful backup must clean the source staging root (plaintext package) and run retention.
const temporary=await mkdtemp(join(tmpdir(),'dbm-complete-'));
Object.assign(process.env,{DATA_DIR:join(temporary,'data'),BACKUP_DIR:temporary,MASTER_KEY_FILE:join(temporary,'master.key'),BACKUP_STORAGE:'local',NODE_ENV:'test'});
await writeFile(process.env.MASTER_KEY_FILE,randomBytes(32).toString('base64'));
const {db}=await import('../src/db.js');
const {transport,enqueueBackup,claimJob,executeJob,encryptStream,verifyEncrypted,finishReconciledBackup,STAGING_SAFE_AGE_SECONDS}=await import('../src/engine.js');
const {preparePublication,authenticatePublication,reconcileArtifacts}=await import('../src/artifact-journal.js');
const at=new Date().toISOString();
const server=(id,host)=>db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,id,host,22,'root','unused','a'.repeat(64),'unchecked',at);
const site=(id,serverId,config={})=>db.prepare('INSERT INTO sites(id,server_id,name,config,created_at) VALUES(?,?,?,?,?)').run(id,serverId,id,JSON.stringify(config),at);
const job=(id,siteId,status)=>db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup',?,?,?)").run(id,siteId,status,status,at);
server('done-server','127.0.0.1');site('done-site','done-server');
server('other-server','127.0.0.2');site('other-site','other-server');
server('custom-server','127.0.0.3');site('custom-site','custom-server',{stagingRoot:'/srv/docknest-staging/'});
db.prepare("INSERT INTO policies(site_id,enabled,schedule,timezone,retention) VALUES('done-site',0,'0 0 * * *','UTC',1)").run();
const uuid=n=>String(n).repeat(8)+'-2222-4333-8444-555555555555';
const old=STAGING_SAFE_AGE_SECONDS+60;
job(uuid(1),'other-site','completed');job(uuid(2),'other-site','recovery_required');job(uuid(3),'other-site','failed');job(uuid(4),'other-site','queued');
let listing=()=>({root:'/var/lib/docknest',jobs:[]});
const calls=[];let onDownload=()=>{};
transport.remote=async(_server,request)=>{
 calls.push(request.operation==='cleanup'?'cleanup '+request.root:request.operation);
 if(request.operation==='plan')return {fingerprint:'plan'};
 if(request.operation==='cleanup')return {removed:true};
 if(request.operation==='list-staging')return listing(request);
 return {remotePath:'/var/lib/docknest/job/payload.tar.gz',root:'/var/lib/docknest/'+request.job,manifest:{kind:'docker',complete:true,capturedAt:Date.now()/1000,downtimeSeconds:1,originalImages:[],architecture:'amd64',containers:[],consistency:{status:'passed'}}};
};
transport.download=async(_server,_path,output)=>{onDownload();output.end(Buffer.from('authenticated fixture payload'));};
const run=async siteId=>{calls.length=0;enqueueBackup(siteId,'test');const claimed=claimJob();await executeJob(claimed);return claimed;};
const audited=(action,target)=>Boolean(db.prepare('SELECT 1 FROM audit_events WHERE action=? AND target=?').get(action,target));

test('a completed backup cleans its staging folder, removes only safe leftovers and applies retention',async()=>{
 let current;
 listing=()=>({root:'/var/lib/docknest',jobs:[
  {job:uuid(1),finished:true,ageSeconds:60,bytes:100},            // completed in the database: removed
  {job:uuid(2),finished:true,ageSeconds:old,bytes:100},           // recovery_required: kept
  {job:uuid(3),finished:true,ageSeconds:old,bytes:100},           // failed, retained for review: kept
  {job:uuid(4),finished:true,ageSeconds:old,bytes:100},           // queued: kept
  {job:uuid(5),finished:true,ageSeconds:old,bytes:2000},          // unknown to DockNest and old: removed
  {job:uuid(6),finished:true,ageSeconds:60,bytes:100},            // unknown but recent: kept
  {job:uuid(7),finished:false,ageSeconds:old,bytes:100},          // recovery markers missing: kept
  {job:'maintenance',finished:true,ageSeconds:old,bytes:100},     // not a job folder: kept
  {job:current,finished:true,ageSeconds:old,bytes:100},
 ]});
 const first=await run('done-site');current=first.id;
 assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(first.id).status,'completed');
 assert.deepEqual(calls,['plan','capture','cleanup /var/lib/docknest/'+first.id,'list-staging','cleanup /var/lib/docknest/'+uuid(1),'cleanup /var/lib/docknest/'+uuid(5)]);
 assert.deepEqual(JSON.parse(db.prepare("SELECT detail FROM audit_events WHERE action='staging.swept' AND target='done-server'").get().detail),{removed:2,freedBytes:2100});
 assert.ok(audited('backup.completed','done-site'));assert.equal(audited('job.superseded',first.id),false);
 listing=()=>({root:'/var/lib/docknest',jobs:[{job:first.id,finished:true,ageSeconds:old,bytes:1}]});
 const second=await run('done-site');
 // The previous (completed) job's folder goes; the current one was already cleaned.
 assert.deepEqual(calls.slice(-2),['list-staging','cleanup /var/lib/docknest/'+first.id]);
 // Retention 1: only the newer point remains.
 assert.deepEqual(db.prepare("SELECT job_id FROM backups WHERE site_id='done-site'").all().map(row=>row.job_id),[second.id]);
});

test('a site with its own staging root is swept there',async()=>{
 const seen=[];listing=request=>{seen.push(request.config.stagingRoot);return {root:'/srv/docknest-staging',jobs:[{job:uuid(1),finished:true,ageSeconds:old,bytes:5}]};};
 await run('custom-site');
 assert.deepEqual(seen,['/srv/docknest-staging/']);
 assert.ok(calls.includes('cleanup /srv/docknest-staging/'+uuid(1)));
});

test('a job taken over during transfer keeps recovery_required and its package, and skips cleanup',async()=>{
 let jobId;onDownload=()=>db.prepare("UPDATE jobs SET status='recovery_required',stage='recovery_required',error='Worker interrupted.' WHERE id=?").run(jobId);
 enqueueBackup('done-site','test');const claimed=claimJob();jobId=claimed.id;calls.length=0;
 try{await executeJob(claimed);}finally{onDownload=()=>{};}
 assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(claimed.id).status,'recovery_required');
 assert.ok(db.prepare('SELECT 1 FROM backups WHERE job_id=?').get(claimed.id),'authenticated package is kept');
 assert.deepEqual(calls,['plan','capture']);
 assert.ok(audited('job.superseded',claimed.id));
 db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(claimed.id);
});

test('reconciliation never downgrades recovery_required and finishes cleanup for a job it completes',async()=>{
 const stage=async(jobId,status)=>{
  job(jobId,'custom-site',status);
  const file=join(temporary,jobId+'.partial'),published=join(temporary,jobId+'.enc');
  await encryptStream(Readable.from(['snapshot']),createWriteStream(file));
  preparePublication({backupId:'backup-'+jobId,jobId,siteId:'custom-site',temporary:file,published,manifest:{consistency:{status:'declared'}},capturedAt:at});
  authenticatePublication('backup-'+jobId,await verifyEncrypted(file),(await stat(file)).size);
 };
 await stage(uuid(8),'recovery_required');await stage(uuid(9),'running');
 const completed=[];listing=()=>({root:'/srv/docknest-staging',jobs:[]});calls.length=0;
 const result=await reconcileArtifacts(verifyEncrypted,{onJobCompleted:async jobId=>{completed.push(jobId);await finishReconciledBackup(jobId);}});
 assert.equal(result.published,2);
 assert.ok(db.prepare("SELECT 1 FROM backups WHERE id=?").get('backup-'+uuid(8)),'the package is still published');
 assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(uuid(8)).status,'recovery_required');
 assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(uuid(9)).status,'completed');
 assert.deepEqual(completed,[uuid(9)]);
 assert.deepEqual(calls,['cleanup /srv/docknest-staging/'+uuid(9),'list-staging']);
});
test('a backup that did not copy protected mounts says so in plain words on the job result',async()=>{
 const {protectedMountWarning}=await import('../src/engine.js');
 assert.equal(protectedMountWarning(undefined),null);assert.equal(protectedMountWarning([]),null);assert.equal(protectedMountWarning([{source:7}]),null);
 const text=protectedMountWarning([{container:'gitea',source:'/home/git/.ssh',destination:'/data/git/.ssh'},{source:'/etc/ssh'}]);
 assert.match(text,/^Not copied: \/home\/git\/\.ssh \(mounted into gitea\); \/etc\/ssh\. /);assert.match(text,/recover them separately/);
 assert.ok(protectedMountWarning([{source:'/x'.repeat(2000),container:'c'.repeat(500)}]).length<1000,'source-supplied names are bounded');
});
