import React,{useEffect,useRef,useState} from 'react';
import {AlertPanel,StatusLabel} from '../system.jsx';
import {ACTIVE_STATES,STEP_LABELS,runError} from './restore-tests-client.js';
import {clockOf,stepDuration} from './model.js';
import {STEP_ICON} from './parts.jsx';

const wording=(test,fallback)=>test.reason||fallback;
const resultState=test=>test.result==='passed'?'success':test.result==='failed'?'failed':test.result==='couldnt_run'?'needs-review':test.result==='cancelled'?'queued':ACTIVE_STATES.has(test.state)?'running':'queued';
const resultLabel=test=>({passed:'Passed',failed:'Failed',couldnt_run:'Couldn’t run',cancelled:'Cancelled'})[test.result]||(test.state==='needs_cleanup'?'Needs clean-up':ACTIVE_STATES.has(test.state)?'Running':'Queued');

// Job details for a restore test: the outcome, the plain reason, and the six steps as the product's timeline.
export function TestJobDetails({client,job,testId,siteName,isAdmin,onRun,onChanged}){
 const [test,setTest]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[note,setNote]=useState('');
 const refreshRef=useRef(null);
 async function refresh(){try{setTest(await client.detail(testId));setError('')}catch(e){setError(e.message||'Could not load this test.')}}
 refreshRef.current=refresh;
 useEffect(()=>{refresh()},[testId]);
 const active=!!test&&ACTIVE_STATES.has(test.state);
 useEffect(()=>{if(!active)return;const id=setInterval(()=>refreshRef.current(),3000);return()=>clearInterval(id)},[active]);

 async function act(fn,message){
  setBusy(true);setNote('');
  try{await fn();setNote(message);onChanged?.();await refresh()}
  catch(e){setError(e.code?runError(e):e.message||'Something went wrong.')}
  finally{setBusy(false)}
 }
 if(!test)return <div className="job-details dn-jd"><p role={error?'alert':'status'}>{error||'Loading test…'}</p></div>;

 const bad=test.result==='failed',stopped=test.result==='couldnt_run',steps=Array.isArray(test.steps)?test.steps:[];
 return <div className="job-details dn-jd">
  <section className={'dn-hero '+(bad?'is-bad':test.result==='passed'?'is-ok':'is-run')} aria-label="Job outcome">
   <div className="dn-hero-text"><div className="dn-hero-title"><h3>Restore test</h3><StatusLabel state={resultState(test)}>{resultLabel(test)}</StatusLabel></div><p>{siteName||test.siteId}</p></div>
   <div className="dn-actions">
    <button type="button" onClick={()=>act(async()=>{},'')} disabled={busy}>Refresh</button>
    {active?<button type="button" disabled={busy||test.cancelRequested} onClick={()=>act(()=>client.cancel(test.id),'Stopping the test.')}>{test.cancelRequested?'Stopping':'Cancel test'}</button>
     :<button type="button" disabled={busy} onClick={()=>onRun(test.siteId)}>Run again</button>}
   </div>
  </section>
  <div className="dn-jd-body">
   {error&&<p className="job-refresh-error" role="alert">{error}</p>}
   {note&&<div className="job-feedback" role="status">{note}</div>}
   {bad&&<AlertPanel variant="error" title="Restore test failed">{wording(test,'The restored copy did not come back.')}</AlertPanel>}
   {stopped&&<AlertPanel variant="warning" title="Restore test couldn’t run">{wording(test,'The test server stopped the test.')}</AlertPanel>}
   {test.state==='needs_cleanup'&&<AlertPanel variant="warning" title="Clean-up did not finish" action={isAdmin&&<div className="rp-actions"><button type="button" className="primary" disabled={busy} onClick={()=>act(()=>client.cleanup(test.id),'Clean-up started.')}>Retry clean-up</button></div>}>{'Some test files may remain on '+(test.serverName||'the test server')+'.'}</AlertPanel>}
   <section className="dn-card"><h4>Steps</h4>
    <div className="dn-tl"><ol className="dn-tl-list">{steps.map(step=>{
     const [Icon,tone]=STEP_ICON[step.state]||STEP_ICON.pending;
     const detail=step.state==='failed'?step.detail||test.reason:step.step==='clean_up'&&step.state==='done'?step.detail||'Test copy removed':step.detail;
     return <li key={step.step} className={'dn-tl-item'+(step.state==='failed'?' is-bad':'')}>
      <span className={'rt-tl-ic '+tone}><Icon size={16} stroke={2} aria-hidden="true"/></span>
      <span className="dn-tl-name">{step.label||STEP_LABELS[step.step]||step.step}{detail&&<small>{detail}</small>}</span>
      <time className="dn-tl-time">{step.startedAt?clockOf(step.startedAt):''}</time>
      <span className="dn-tl-dur">{stepDuration(step)}</span>
     </li>;})}</ol></div>
   </section>
  </div>
 </div>;
}
