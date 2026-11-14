import {STEP_LABELS,ACTIVE_STATES,isTestJob,testIdOf} from './restore-tests-client.js';

const ACTIVE_JOB=new Set(['test_queued','test_running','test_waiting']);
const lower=text=>String(text||'').toLowerCase();

// The Jobs list shows one row per restore test. A test runs as several step jobs that share details.testId; they
// collapse into one entry placed where the newest of them sits. Other jobs, and test jobs without an id, stay as they are.
export function groupTestJobs(jobs){
 const entries=[],seen=new Map();
 for(const job of jobs||[]){
  const testId=isTestJob(job)?testIdOf(job):null;
  if(!testId){entries.push({kind:'job',job});continue;}
  if(seen.has(testId)){seen.get(testId).jobs.push(job);continue;}
  const entry={kind:'test',testId,jobs:[job],head:job};
  seen.set(testId,entry);entries.push(entry);
 }
 return entries;
}
// Changes whenever a step job changes state, so the test is read again only then.
export const testSignature=entry=>entry.jobs.map(job=>job.id+':'+job.status+':'+(job.stage||'')).join('|');
export const startedAt=entry=>entry.jobs.map(job=>job.createdAt||job.created_at||job.startedAt).filter(Boolean).sort()[0];

export function minutes(seconds){
 const s=Math.max(0,Math.round(Number(seconds)||0));
 return s<60?s+' s':Math.max(1,Math.round(s/60))+' min';
}

// {state, label, stage}: the test's own status and one short stage line. `info` is the restore-test detail (null until loaded).
export function testSummary(entry,info){
 if(info){
  const steps=Array.isArray(info.steps)?info.steps:[];
  const failedKey=info.failedStep||steps.find(step=>step.state==='failed')?.step;
  const failedName=lower(STEP_LABELS[failedKey]||failedKey);
  if(info.state==='needs_cleanup')return {state:'needs-review',label:'Needs clean-up',stage:'Clean-up did not finish'};
  if(ACTIVE_STATES.has(info.state)){
   const now=steps.find(step=>step.state==='running');
   return {state:info.state==='queued'?'queued':'running',label:info.state==='queued'?'Queued':'Running',stage:now?(STEP_LABELS[now.step]||now.step):info.state==='cleaning'?'Cleaning up':'Starting'};
  }
  if(info.result==='passed')return {state:'success',label:'Passed',stage:steps.length+' steps, '+minutes(info.totalSeconds)};
  if(info.result==='failed')return {state:'failed',label:'Failed',stage:failedName?'Failed at '+failedName:'Failed'};
  if(info.result==='couldnt_run')return {state:'needs-review',label:'Couldn’t run',stage:failedName?'Stopped at '+failedName:'Couldn’t run'};
  if(info.result==='cancelled')return {state:'queued',label:'Cancelled',stage:'Cancelled'};
 }
 // Not loaded yet: say what the step jobs say.
 const active=entry.jobs.find(job=>ACTIVE_JOB.has(job.status));
 if(active)return {state:active.status==='test_queued'?'queued':'running',label:active.status==='test_queued'?'Queued':'Running',stage:String(active.stage||'—').replace(/_/g,' ')};
 const bad=entry.jobs.find(job=>job.status==='failed');
 if(bad){const key=(typeof bad.details==='object'&&bad.details?.step)||bad.stage;return {state:'failed',label:'Failed',stage:STEP_LABELS[key]?'Failed at '+lower(STEP_LABELS[key]):'Failed'};}
 return {state:'success',label:'Completed',stage:'—'};
}
