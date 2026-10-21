import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const temporary=await mkdtemp(join(tmpdir(),'dbm-lease-'));
process.env.DATA_DIR=join(temporary,'data');
process.env.NODE_ENV='test';
const {db}=await import('../src/db.js');
const {acquireLease,renewLease,releaseLease,readLease,LEASE_TTL_MS}=await import('../src/worker-lease.js');
// A second connection to the same file stands in for a second worker process.
const other=new DatabaseSync(join(process.env.DATA_DIR,'state.sqlite'));other.exec('PRAGMA busy_timeout=5000');
test('lease is acquired, renewed only by its holder and released',()=>{
 const now=1_000_000;
 const first=acquireLease(db,'worker-a',{now});assert.equal(first.acquired,true);assert.equal(first.takeover,false);assert.equal(first.lease.expires_at,now+LEASE_TTL_MS);
 assert.equal(renewLease(db,'worker-a',{now:now+15000}),true);assert.equal(readLease(db).expires_at,now+15000+LEASE_TTL_MS);
 assert.equal(renewLease(other,'worker-b',{now:now+15000}),false);
 assert.equal(releaseLease(other,'worker-b'),false);assert.equal(readLease(db).holder,'worker-a');
 assert.equal(releaseLease(db,'worker-a'),true);assert.equal(readLease(db),undefined);
});
test('a live lease refuses a concurrent worker; an expired one is taken over',()=>{
 const now=2_000_000;
 assert.equal(acquireLease(db,'worker-a',{now}).acquired,true);
 const refused=acquireLease(other,'worker-b',{now:now+LEASE_TTL_MS-1});assert.equal(refused.acquired,false);assert.equal(refused.lease.holder,'worker-a');
 const taken=acquireLease(other,'worker-b',{now:now+LEASE_TTL_MS+1});assert.equal(taken.acquired,true);assert.equal(taken.takeover,true);assert.equal(taken.previous.holder,'worker-a');
 // The stalled former holder learns it lost the lease and cannot renew, release or reacquire it.
 assert.equal(renewLease(db,'worker-a',{now:now+LEASE_TTL_MS+2}),false);assert.equal(releaseLease(db,'worker-a'),false);
 assert.equal(acquireLease(db,'worker-a',{now:now+LEASE_TTL_MS+2}).acquired,false);
 assert.equal(readLease(db).holder,'worker-b');releaseLease(other,'worker-b');
});
test('simultaneous acquisition from separate processes yields exactly one holder',async()=>{
 const file=join(process.env.DATA_DIR,'state.sqlite'),lease=new URL('../src/worker-lease.js',import.meta.url).href;
 const script=`import {DatabaseSync} from 'node:sqlite';const {acquireLease}=await import(process.argv[1]);const d=new DatabaseSync(process.argv[2]);d.exec('PRAGMA busy_timeout=5000');const start=Number(process.argv[3]);while(Date.now()<start);console.log(acquireLease(d,process.argv[4]).acquired);`;
 const start=Date.now()+1500,children=['p1','p2','p3','p4'].map(async holder=>(await promisify(execFile)(process.execPath,['--input-type=module','-e',script,lease,file,String(start),holder],{encoding:'utf8'})).stdout.trim());
 const results=await Promise.all(children);assert.equal(results.length,4);assert.equal(results.filter(r=>r==='true').length,1);releaseLease(db,readLease(db).holder);
});
test('worker:status reports lease, heartbeat and recovery_required jobs read-only',()=>{
 acquireLease(db,'worker-status-holder');
 db.prepare("INSERT INTO settings VALUES('worker_heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({running:true,lastSeen:new Date().toISOString()}));
 db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('server-s','s','localhost',22,'root','encrypted-key','a'.repeat(64),'unchecked',new Date().toISOString());
 db.prepare('INSERT INTO sites(id,server_id,name,config,created_at) VALUES(?,?,?,?,?)').run('site-s','server-s','shop','{}',new Date().toISOString());
 db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,error) VALUES('job-r','site-s','backup','recovery_required','recovery_required',?,'Worker interrupted.')").run(new Date().toISOString());
 const output=execFileSync(process.execPath,[fileURLToPath(new URL('../src/worker-status.js',import.meta.url))],{encoding:'utf8',env:{...process.env}});
 assert.match(output,/Lease: held by worker-status-holder/);assert.match(output,/Heartbeat: running/);
 assert.match(output,/Recovery required jobs: 1/);assert.match(output,/job-r backup site=shop .*error=Worker interrupted\./);
 assert.doesNotMatch(output,/encrypted-key/);
 releaseLease(db,'worker-status-holder');
});
const status=dataDir=>spawnSync(process.execPath,[fileURLToPath(new URL('../src/worker-status.js',import.meta.url))],{encoding:'utf8',env:{...process.env,DATA_DIR:dataDir}});
test('worker:status reports an uninitialised database clearly and exits 1',async()=>{
 const empty=join(temporary,'empty');await mkdir(empty);await writeFile(join(empty,'state.sqlite'),'');
 const result=status(empty);assert.equal(result.status,1);assert.match(result.stderr,/not initialised/);assert.doesNotMatch(result.stderr,/at .*worker-status/);
});
test('worker:status creates no WAL sidecar files for a closed, checkpointed database',async()=>{
 const closed=join(temporary,'closed');
 const created=spawnSync(process.execPath,['--input-type=module','-e',"const {db}=await import(process.argv[1]);db.close();",new URL('../src/db.js',import.meta.url).href],{encoding:'utf8',env:{...process.env,DATA_DIR:closed}});
 assert.equal(created.status,0,created.stderr);assert.deepEqual(await readdir(closed),['state.sqlite']);
 const result=status(closed);assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Lease: free/);
 assert.deepEqual(await readdir(closed),['state.sqlite']);
});
