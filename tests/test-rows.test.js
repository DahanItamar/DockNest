import test from 'node:test';
import assert from 'node:assert/strict';
import {groupTestJobs,testSignature,testSummary,minutes,startedAt} from '../web/restore-tests/test-rows.js';

const step=(id,testId,status,extra={})=>({id,type:'restore-test',siteId:'s1',status,stage:extra.stage||status,createdAt:extra.at||'2026-11-13T04:00:00Z',details:{testId,step:extra.step||'check_space'}});
const jobs=[
 {id:'b1',type:'backup',status:'completed',createdAt:'2026-11-14T02:00:00Z'},
 step('t2c','T2','completed',{at:'2026-11-13T04:09:00Z',step:'clean_up'}),
 step('t2b','T2','failed',{at:'2026-11-13T04:05:00Z',step:'check_health'}),
 step('t2a','T2','completed',{at:'2026-11-13T04:00:00Z'}),
 {id:'x',type:'restore-test',status:'completed',details:{}},
 step('t1a','T1','completed',{at:'2026-11-12T04:00:00Z'}),
 {id:'b2',type:'backup',status:'completed',createdAt:'2026-11-12T02:00:00Z'}
];
const keys=['check_space','copy_backup','restore_copy','start_containers','check_health','clean_up'];

test('step jobs of one test collapse into one entry at the newest job; other jobs stay',()=>{
 const entries=groupTestJobs(jobs);
 assert.deepEqual(entries.map(e=>e.kind==='job'?e.job.id:e.testId),['b1','T2','x','T1','b2']);
 assert.deepEqual(entries[1].jobs.map(j=>j.id),['t2c','t2b','t2a']);
 assert.equal(entries[1].head.id,'t2c');
 assert.equal(startedAt(entries[1]),'2026-11-13T04:00:00Z');
 assert.match(testSignature(entries[1]),/t2c:completed/);
});

test('details may arrive as a JSON string',()=>{
 const entries=groupTestJobs([{id:'j',type:'restore-test',status:'completed',details:JSON.stringify({testId:'Z'})}]);
 assert.equal(entries[0].testId,'Z');
});

test('summaries: passed, failed at a step, could not run, cancelled, running, clean-up',()=>{
 const entry=groupTestJobs(jobs)[1],six=keys.map(step=>({step,state:'done'}));
 assert.deepEqual(testSummary(entry,{state:'finished',result:'passed',totalSeconds:250,steps:six}),{state:'success',label:'Passed',stage:'6 steps, 4 min'});
 assert.deepEqual(testSummary(entry,{state:'finished',result:'failed',failedStep:'check_health',steps:six}),{state:'failed',label:'Failed',stage:'Failed at check health'});
 assert.equal(testSummary(entry,{state:'finished',result:'couldnt_run',failedStep:'check_space',steps:six}).stage,'Stopped at check space');
 assert.equal(testSummary(entry,{state:'finished',result:'cancelled',steps:six}).label,'Cancelled');
 const running=testSummary(entry,{state:'running',steps:[{step:'restore_copy',state:'running'}]});
 assert.deepEqual([running.state,running.stage],['running','Restore copy']);
 assert.equal(testSummary(entry,{state:'needs_cleanup',result:'failed',steps:six}).label,'Needs clean-up');
});

test('before the test is loaded the step jobs speak for it',()=>{
 const failed=groupTestJobs(jobs)[1];
 assert.deepEqual(testSummary(failed,null),{state:'failed',label:'Failed',stage:'Failed at check health'});
 const live=groupTestJobs([step('a','T9','test_running',{stage:'restore_copy'})])[0];
 assert.deepEqual(testSummary(live,null),{state:'running',label:'Running',stage:'restore copy'});
 assert.equal(testSummary(groupTestJobs(jobs)[3],null).label,'Completed');
});

test('durations read in seconds or whole minutes',()=>{
 assert.equal(minutes(41),'41 s');assert.equal(minutes(60),'1 min');assert.equal(minutes(250),'4 min');assert.equal(minutes(undefined),'0 s');
});
