import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const temporary=await mkdtemp(join(tmpdir(),'dbm-loop-'));
process.env.DATA_DIR=join(temporary,'data');
process.env.NODE_ENV='test';
const {db}=await import('../src/db.js');
const {acquireLease,renewLease,releaseLease,readLease,LEASE_TTL_MS}=await import('../src/worker-lease.js');
const {runWorkerLoop}=await import('../src/worker-loop.js');
const other=new DatabaseSync(join(process.env.DATA_DIR,'state.sqlite'));other.exec('PRAGMA busy_timeout=5000');
const loopSteps=(active,maintain)=>{const calls=[];return {calls,steps:{active,maintain:async()=>{calls.push('maintain');await maintain();},tick:()=>calls.push('tick'),claimSelfBackup:()=>{calls.push('claimSelf');return null;},executeSelfBackup:async()=>calls.push('runSelf'),claimJob:()=>{calls.push('claim');return null;},executeJob:async()=>calls.push('run'),idle:async()=>calls.push('idle')}};};
test('a drain signal during slow maintenance claims no further work',async()=>{
 let stopping=false;const {calls,steps}=loopSteps(()=>!stopping,async()=>{await new Promise(r=>setTimeout(r,20));stopping=true;});
 await runWorkerLoop(steps);assert.deepEqual(calls,['maintain']);
});
test('losing the lease during slow maintenance claims no further work',async()=>{
 acquireLease(db,'worker-loop');
 const {calls,steps}=loopSteps(()=>renewLease(db,'worker-loop'),async()=>{await new Promise(r=>setTimeout(r,20));other.prepare("UPDATE worker_lease SET holder='worker-new',expires_at=? WHERE name='worker'").run(Date.now()+LEASE_TTL_MS);});
 await runWorkerLoop(steps);assert.deepEqual(calls,['maintain']);assert.equal(readLease(db).holder,'worker-new');releaseLease(db,'worker-new');
});
test('a drain signal during a self-backup claims no site job',async()=>{
 let stopping=false;const {calls,steps}=loopSteps(()=>!stopping,async()=>{});steps.claimSelfBackup=()=>{calls.push('claimSelf');return {id:'kit'};};steps.executeSelfBackup=async()=>{calls.push('runSelf');stopping=true;};
 await runWorkerLoop(steps);assert.deepEqual(calls,['maintain','tick','claimSelf','runSelf']);
});
test('an active loop maintains, ticks and claims before idling',async()=>{
 let rounds=0;const {calls,steps}=loopSteps(()=>rounds<2,async()=>{});steps.idle=async()=>{rounds++;calls.push('idle');};
 await runWorkerLoop(steps);assert.deepEqual(calls,['maintain','tick','claimSelf','claim','idle','maintain','tick','claimSelf','claim','idle']);
});
test('backup copies run only when no site job waits, and never after a drain signal',async()=>{
 let rounds=0,stopping=false;const {calls,steps}=loopSteps(()=>!stopping&&rounds<3,async()=>{});
 const jobs=[{id:'backup'}],due=[{id:'copy-1'},{id:'copy-2'}];
 steps.claimJob=()=>{calls.push('claim');return jobs.shift()??null;};steps.executeJob=async()=>calls.push('run');
 steps.claimCopy=()=>{calls.push('claimCopy');return due.shift()??null;};steps.executeCopy=async copy=>{calls.push('copy:'+copy.id);if(copy.id==='copy-2')stopping=true;};
 steps.idle=async()=>{rounds++;calls.push('idle');};
 await runWorkerLoop(steps);
 assert.deepEqual(calls,['maintain','tick','claimSelf','claim','run','maintain','tick','claimSelf','claim','claimCopy','copy:copy-1','maintain','tick','claimSelf','claim','claimCopy','copy:copy-2']);
 assert.equal(due.length,0);
});
