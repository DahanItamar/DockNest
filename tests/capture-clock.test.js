import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
const temporary=await mkdtemp(join(tmpdir(),'dbm-clock-'));
Object.assign(process.env,{DATA_DIR:join(temporary,'data'),BACKUP_DIR:temporary,MASTER_KEY_FILE:join(temporary,'master.key'),BACKUP_STORAGE:'local',NODE_ENV:'test'});
await writeFile(process.env.MASTER_KEY_FILE,randomBytes(32).toString('base64'));
const {db}=await import('../src/db.js');
const {trustedCaptureTime,transport,enqueueBackup,claimJob,executeJob}=await import('../src/engine.js');

test('a capture time inside the job window is kept as reported by the source server',()=>{
 const started=Date.UTC(2026,9,23,2,0,0),now=started+30*60*1000,reported=(started+5*60*1000)/1000;
 assert.deepEqual(trustedCaptureTime(reported,started,now),{ms:reported*1000,adjusted:false});
 // Small clock differences between the hosts are tolerated.
 assert.equal(trustedCaptureTime((started-2*60*1000)/1000,started,now).adjusted,false);
 assert.equal(trustedCaptureTime((now+2*60*1000)/1000,started,now).adjusted,false);
});

test('a reset or future source clock cannot reorder recovery points for retention',()=>{
 const started=Date.UTC(2026,9,23,2,0,0),now=started+30*60*1000;
 // RTC reset to 1970 would sort the newest backup as the oldest and prune it at once.
 assert.deepEqual(trustedCaptureTime(1,started,now),{ms:now,adjusted:true});
 // A clock years ahead would keep that point above every later one.
 assert.deepEqual(trustedCaptureTime(Date.UTC(2035,0,1)/1000,started,now),{ms:now,adjusted:true});
 for(const value of [undefined,null,'1761184800',Number.NaN,Number.POSITIVE_INFINITY,{}])assert.deepEqual(trustedCaptureTime(value,started,now),{ms:now,adjusted:true});
});

test('a staged backup from a source with a reset clock is published under the DockNest time with a warning',async t=>{
 const at=new Date().toISOString();
 db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('clock-server','clock','127.0.0.1',22,'root','unused','a'.repeat(64),'unchecked',at);
 db.prepare('INSERT INTO sites(id,server_id,name,config,created_at) VALUES(?,?,?,?,?)').run('clock-site','clock-server','clock','{}',at);
 const original={...transport};t.after(()=>Object.assign(transport,original));
 let reported;
 transport.remote=async(_server,request)=>{
  if(request.operation==='plan')return {fingerprint:'plan'};
  if(request.operation==='cleanup')return {removed:true};
  if(request.operation==='list-staging')return {root:'/var/lib/docknest',jobs:[]};
  return {remotePath:'/var/lib/docknest/job/payload.tar.gz',root:'/var/lib/docknest/job',manifest:{kind:'docker',complete:true,capturedAt:reported,downtimeSeconds:1,originalImages:[],architecture:'amd64',containers:[],consistency:{status:'passed'}}};
 };
 transport.download=async(_server,_path,output)=>{output.end(Buffer.from('authenticated fixture payload'));};
 const run=async value=>{
  reported=value;const queued=enqueueBackup('clock-site','test'),job=claimJob();assert.equal(job.id,queued.id);
  const before=Date.now();await executeJob(job);const after=Date.now();
  const row=db.prepare('SELECT status,details FROM jobs WHERE id=?').get(job.id);assert.equal(row.status,'completed',row.details);
  const details=JSON.parse(row.details),backup=db.prepare('SELECT * FROM backups WHERE id=?').get(details.backupId);
  return {before,after,details,backup,manifest:JSON.parse(backup.manifest)};
 };
 // Source clock reset to 1970.
 const skewed=await run(1);
 const recorded=Date.parse(skewed.backup.captured_at);
 assert.ok(recorded>=skewed.before&&recorded<=skewed.after,'captured_at uses the DockNest time');
 assert.ok(skewed.manifest.capturedAt*1000>=skewed.before&&skewed.manifest.capturedAt*1000<=skewed.after);
 assert.deepEqual(skewed.manifest.sourceClock,{reportedCapturedAt:1,adjusted:true});
 assert.ok(basename(skewed.backup.path).startsWith('backup_'+skewed.backup.captured_at.slice(0,10)+'_'),skewed.backup.path);
 assert.ok(!skewed.backup.path.includes('1970'));
 assert.ok(skewed.details.warnings?.some(warning=>warning.startsWith('Source server clock')),JSON.stringify(skewed.details));
 // A correct source clock is kept unchanged and gives no warning.
 const exact=Math.floor(Date.now()/1000);
 const normal=await run(exact);
 assert.equal(normal.manifest.capturedAt,exact);assert.equal(normal.backup.captured_at,new Date(exact*1000).toISOString());
 assert.equal(normal.manifest.sourceClock,undefined);assert.equal(normal.details.warnings,undefined);
});
