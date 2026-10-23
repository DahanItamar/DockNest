import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
// A successful backup must clean the source staging root (plaintext package) and run retention.
const temporary=await mkdtemp(join(tmpdir(),'dbm-complete-'));
Object.assign(process.env,{DATA_DIR:join(temporary,'data'),BACKUP_DIR:temporary,MASTER_KEY_FILE:join(temporary,'master.key'),BACKUP_STORAGE:'local',NODE_ENV:'test'});
await writeFile(process.env.MASTER_KEY_FILE,randomBytes(32).toString('base64'));
const {db}=await import('../src/db.js');
const {transport,enqueueBackup,claimJob,executeJob}=await import('../src/engine.js');
const at=new Date().toISOString();
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('done-server','done','127.0.0.1',22,'root','unused','a'.repeat(64),'unchecked',at);
db.prepare('INSERT INTO sites(id,server_id,name,config,created_at) VALUES(?,?,?,?,?)').run('done-site','done-server','done','{}',at);
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('other-server','other','127.0.0.2',22,'root','unused','b'.repeat(64),'unchecked',at);
db.prepare('INSERT INTO sites(id,server_id,name,config,created_at) VALUES(?,?,?,?,?)').run('other-site','other-server','other','{}',at);
db.prepare("INSERT INTO policies(site_id,enabled,schedule,timezone,retention) VALUES('done-site',0,'0 0 * * *','UTC',1)").run();
const calls=[];let onDownload=()=>{},sweep;
transport.remote=async(_server,request)=>{
 calls.push(request.operation);
 if(request.operation==='plan')return {fingerprint:'plan'};
 if(request.operation==='cleanup')return {removed:true};
 if(request.operation==='sweep-staging'){sweep=request;return {removed:2,freedBytes:4096,kept:1};}
 return {remotePath:'/var/lib/docknest/job/payload.tar.gz',root:'/var/lib/docknest/'+request.job,manifest:{kind:'docker',complete:true,capturedAt:Date.now()/1000,downtimeSeconds:1,originalImages:[],architecture:'amd64',containers:[],consistency:{status:'passed'}}};
};
transport.download=async(_server,_path,output)=>{onDownload();output.end(Buffer.from('authenticated fixture payload'));};
const run=async()=>{calls.length=0;enqueueBackup('done-site','test');const job=claimJob();await executeJob(job);return job;};
const audited=(action,target)=>Boolean(db.prepare('SELECT 1 FROM audit_events WHERE action=? AND target=?').get(action,target));

test('a completed backup cleans the source staging root and applies retention',async()=>{
 // Another site's interrupted job must survive the leftover sweep.
 db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES('99999999-2222-4333-8444-555555555555','other-site','backup','recovery_required','recovery_required',?)").run(at);
 db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES('aaaaaaaa-2222-4333-8444-555555555555','done-site','backup','failed','failed',?)").run(at);
 let first;
 try{first=await run();}finally{db.prepare("UPDATE jobs SET status='failed' WHERE id='99999999-2222-4333-8444-555555555555'").run();}
 assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(first.id).status,'completed');
 assert.deepEqual(calls,['plan','capture','cleanup','sweep-staging']);
 assert.deepEqual(new Set(sweep.keep),new Set([first.id,'99999999-2222-4333-8444-555555555555']));
 assert.equal(sweep.config.stagingRoot,undefined);assert.ok(sweep.config.maintenance,'the site configuration is passed');
 const swept=db.prepare("SELECT detail FROM audit_events WHERE action='staging.swept' AND target='done-server'").get();
 assert.deepEqual(JSON.parse(swept.detail),{removed:2,freedBytes:4096});
 assert.ok(audited('backup.completed','done-site'));assert.equal(audited('job.superseded',first.id),false);
 const second=await run();
 assert.deepEqual(calls,['plan','capture','cleanup','sweep-staging']);
 // Retention 1: only the newer point remains.
 assert.deepEqual(db.prepare("SELECT job_id FROM backups WHERE site_id='done-site'").all().map(row=>row.job_id),[second.id]);
});

test('a job taken over during transfer keeps recovery_required and its package, and skips cleanup',async()=>{
 let jobId;onDownload=()=>db.prepare("UPDATE jobs SET status='recovery_required',stage='recovery_required',error='Worker interrupted.' WHERE id=?").run(jobId);
 enqueueBackup('done-site','test');const job=claimJob();jobId=job.id;calls.length=0;
 try{await executeJob(job);}finally{onDownload=()=>{};}
 assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status,'recovery_required');
 assert.ok(db.prepare('SELECT 1 FROM backups WHERE job_id=?').get(job.id),'authenticated package is kept');
 assert.deepEqual(calls,['plan','capture']);
 assert.ok(audited('job.superseded',job.id));
});
