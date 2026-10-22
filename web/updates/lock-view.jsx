import React,{useEffect,useMemo,useRef,useState} from 'react';
import {IconCheck,IconX,IconRotate,IconShieldCheck,IconClipboardCheck,IconShieldLock,IconPackageImport,IconCircleCheck,IconRefresh,IconMinus,IconChevronDown} from '@tabler/icons-react';
import {Brand,ThemeToggle} from '../brand.jsx';
import {AlertPanel} from '../system.jsx';
import {createUpdatesClient} from './client.js';
import {CodeBlock,ExtLink,DOCS_ROLLBACK,REPO} from './parts.jsx';
import {UPDATED_KEY} from './dialogs.jsx';
import {UpdateReportButton,REPORT_VIEWS} from '../report/UpdateReport.jsx';
import {vv,STAGES,PHASES,PHASE_LABEL,FINAL_STATES,isLocking,retryDelay,formatElapsed,trackFor,phaseStatuses,liveFor,stageOf,safeVersion,STATUS_LABEL} from './model.js';

const ICONS=[IconShieldCheck,IconClipboardCheck,IconShieldLock,IconPackageImport,IconCircleCheck];
const clock=ms=>new Date(ms).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
const HEADINGS={succeeded:v=>`DockNest is running ${v}`,rolled_back:()=>'The update did not complete',not_changed:()=>'The update did not start',needs_action:()=>'The update needs manual action',lost:()=>'This update record is closed'};
const PHASE_STATE={complete:'Complete',current:'In progress',failed:'Failed',skipped:'Skipped',pending:'Not started'};
const HOST_COMMANDS=['systemctl status docknest-updater','journalctl -u docknest-updater','docker compose ps'];

function Track({track}){
 return <ol className="dn-stages" aria-label="Update stages">{track.map((s,i)=>{
  const Icon=s.status==='complete'?IconCheck:s.status==='failed'?IconX:s.status==='rolled-back'?IconRotate:ICONS[i];
  return <li key={s.id} className={'dn-stage is-'+(s.status==='waiting'?'waiting':s.status)} aria-current={s.status==='current'?'step':undefined}>
   <span className="dn-stage-link" aria-hidden="true"/>
   <span className="dn-node" aria-hidden="true">{s.status==='current'&&<svg className="dn-node-ring" viewBox="0 0 44 44"><rect className="dn-node-track" x="1" y="1" width="42" height="42" rx="8"/><rect className="dn-node-arc" x="1" y="1" width="42" height="42" rx="8" pathLength="100"/></svg>}<Icon size={22} stroke={1.5}/></span>
   <span className="dn-stage-name">{s.name}</span><span className="dn-stage-status">{STATUS_LABEL[s.status]}<span className="sr-only">, stage {i+1} of 5</span></span></li>})}</ol>;
}
function Details({statuses,to,from}){
 return <details className="more"><summary><IconChevronDown size={16} aria-hidden="true"/>Show details</summary>{STAGES.map(stage=>{const phases=stage.phases.filter(p=>PHASES.includes(p));return <div key={stage.id}><h3 className="stage-h">{stage.name}</h3><ul className="phases">{phases.map(ph=>{const st=statuses[ph]||'pending';return <li key={ph} className={st}><span className="pi" aria-hidden="true">{st==='complete'?<IconCheck size={16}/>:st==='failed'?<IconX size={16}/>:st==='current'?<IconRefresh size={16} className="dn-spin"/>:<IconMinus size={16}/>}</span><span className="label">{PHASE_LABEL[ph](to,from)}</span><span className="state">{PHASE_STATE[st]}</span></li>})}</ul></div>})}</details>;
}

// The lock view: replaces every route while an update runs (docs/update-center.md section 7). It reads only the public
// progress endpoint, plus the session status to learn whether this browser belongs to an administrator.
export function LockView({api,reason,onExit,onRetry}){
 const client=useMemo(()=>createUpdatesClient(api),[api]);
 const [p,setP]=useState(null),[final,setFinal]=useState(null),[offline,setOffline]=useState(false),[answered,setAnswered]=useState(null),[admin,setAdmin]=useState(false);
 const [reqId,setReqId]=useState(null),[ack,setAck]=useState({busy:false,error:''}),[now,setNow]=useState(Date.now()),[from,setFrom]=useState(null),[schema,setSchema]=useState({from:null,to:null}),[retry,setRetry]=useState(null);
 const startedAt=useRef(Date.now()),lastPhase=useRef(null),sawRunning=useRef(false),finishedAt=useRef(null),h1=useRef(null);
 useEffect(()=>{
  let off=false,timer,fails=0,idle=0;
  async function tick(){
   let next;
   try{next=await client.progress()}catch{if(!off){setOffline(true);timer=setTimeout(tick,retryDelay(fails++))}return}
   if(off)return;
   if(fails>0)setAnswered(next.phase||'');
   fails=0;setOffline(false);
   if(next.state==='running'&&PHASES.includes(next.phase)&&next.phase!=='rollback')lastPhase.current=next.phase;
   if(isLocking(next)){sawRunning.current=true;setP(next);timer=setTimeout(tick,2000);return}
   if(FINAL_STATES.includes(next.state)&&(sawRunning.current||reason==='locked')){finishedAt.current=Date.now();setP(next);setFinal(next);return}
   // A 423 says the lock is on: trust it for one more poll before giving up on an idle answer.
   if(reason==='locked'&&idle++<1){timer=setTimeout(tick,2000);return}
   onExit();
  }
  tick();
  return()=>{off=true;clearTimeout(timer)};
 },[client]);
 useEffect(()=>{
  let off=false;
  client.version().then(v=>{if(!off){setFrom(f=>f||vv(v.version));setSchema(s=>({...s,from:s.from??v.schemaVersion}))}},()=>{});
  client.authStatus().then(r=>{if(!off)setAdmin(!!(r.authenticated&&r.user?.role==='admin'))},()=>{});
  return()=>{off=true};
 },[client]);
 useEffect(()=>{if(final?.state!=='succeeded')return;client.version().then(v=>setSchema(s=>({...s,to:v.schemaVersion})),()=>{})},[final?.state,client]);
 useEffect(()=>{if(final)return;const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t)},[final]);
 const view=final?final.state:p?(p.state==='needs_action'?'needs_action':p.stale?'stale':'running'):'running';
 // An administrator can close a stale record, and retry a rolled back update, once the request id is known.
 useEffect(()=>{if(!admin||!(view==='stale'||view==='rolled_back'))return;let off=false;client.status().then(r=>{if(!off)setReqId(r?.requestId||null)},()=>{});if(view==='rolled_back')client.state().then(r=>{if(!off)setRetry({can:!!r.offer?.update&&r.state!=='updater-blocked'})},()=>{if(!off)setRetry({can:false})});return()=>{off=true}},[admin,view,client]);
 const to=safeVersion(vv(p?.to))||null,toText=to||'the new version',fromText=from&&from!==to?from:'the previous version';
 const t0=Date.parse(p?.events?.[0]?.at)||startedAt.current,elapsed=(finishedAt.current??now)-t0,running=view==='running'||view==='stale';
 const phase=p?.phase,trackState=view==='stale'?'running':view;
 const track=view==='lost'?null:trackFor({phase,state:trackState,lastPhase:lastPhase.current});
 const statuses=phaseStatuses({phase,state:trackState,lastPhase:lastPhase.current});
 const stageIdx=Math.max(stageOf(phase),0),[liveTitle,liveBody]=liveFor({phase,to:toText,from:fromText});
 const heading=(HEADINGS[view]||(()=>`Updating DockNest to ${toText}`))(toText);
 const failedStage=track?.find(s=>s.status==='failed')?.name;
 const announce=offline?'Reconnecting to DockNest':running?`Stage ${stageIdx+1} of 5, ${STAGES[stageIdx].name}. ${PHASE_LABEL[PHASES.includes(phase)?phase:'verify'](toText,fromText)}`:'';
 useEffect(()=>{const previous=document.title;document.title=heading+' - DockNest';return()=>{document.title=previous}},[heading]);
 useEffect(()=>{h1.current?.focus()},[view]);
 async function acknowledge(){setAck({busy:true,error:''});try{await client.acknowledge(reqId);setAck({busy:false,error:''})}catch(e){setAck({busy:false,error:e.message||'The record could not be closed.'})}}
 function reload(){try{if(to)sessionStorage.setItem(UPDATED_KEY,to)}catch{}location.reload()}
 const schemaText=Number.isInteger(schema.from)&&Number.isInteger(schema.to)&&schema.from!==schema.to?` (schema v${schema.from} to v${schema.to})`:'';
 const retryReason=retry&&!retry.can?`Updates to ${toText} are blocked until a server operator confirms on the DockNest host.`:null;
 return <div className="progress-view" data-view={view}>
  <header className="progress-top"><div className="brand"><Brand/></div><ThemeToggle/></header>
  <main className="progress-main"><section className="progress-card" aria-labelledby="lock-title">
   {to&&<p className="t-caption eyebrow">{from&&from!==to?from+' to '+to:to}</p>}
   <h1 id="lock-title" ref={h1} tabIndex={-1}>{heading}</h1>
   <p className="sr-only" role="status" aria-live="polite">{announce}</p>
   {running&&view!=='stale'&&<p className="lead">Backups and restores pause at the Protect stage and resume when the update finishes.{p?.events?.[0]?.at?` Started ${clock(t0)}.`:''} The update continues if you leave this page. Reopen DockNest to check status.</p>}
   {view==='rolled_back'&&<p className="lead">The update failed and DockNest returned to {fromText} automatically. No data was lost.</p>}
   {view==='not_changed'&&<p className="lead">Nothing was changed.</p>}
   {view==='needs_action'&&<p className="lead alert-line" role="alert">The update needs manual action on the DockNest host. {toText==='the new version'?'The new version':toText} did not become healthy after it updated DockNest{'’'}s data, so DockNest did not switch back by itself. Backups stay paused.</p>}
   {view==='lost'&&<p className="lead">The update record was closed without a result. The DockNest host may still be working on the update. An administrator should check the host before trying again.</p>}
   {view==='stale'&&<p className="lead alert-line" role="alert">The updater has not reported progress since {clock(Date.parse(p.updatedAt)||t0)}. DockNest will not resubmit the update or release the hold on its own. Backups and restores stay paused while this is unresolved.</p>}
   {track&&<Track track={track}/>}
   {running&&view!=='stale'&&<div className="live"><b>{liveTitle}</b><span>Stage {stageIdx+1} of 5, {STAGES[stageIdx].name}. {liveBody}</span></div>}
   {running&&offline&&<p className="dn-reconnect"><IconRefresh size={18} className="dn-spin" aria-hidden="true"/>Reconnecting to DockNest{'…'}</p>}
   {running&&!offline&&answered!==null&&answered===(phase||'')&&<p className="dn-reconnect is-answered"><IconCircleCheck size={18} aria-hidden="true"/>DockNest is back. Continuing the update.</p>}
   {running&&<p className="elapsed">Elapsed <span className="dn-elapsed">{formatElapsed(elapsed)}</span>.</p>}
   {view==='succeeded'&&<><p className="live"><b>Update complete</b><span>Completed in <span className="dn-elapsed">{formatElapsed(elapsed)}</span>. Backups and restores have resumed.</span></p>
    <ul className="dn-summary">{['Restore point created',`${toText} installed`,'Services started','Health checks passed','Settings and data kept'+schemaText].map(t=><li key={t}><IconCircleCheck size={20} aria-hidden="true"/>{t}</li>)}</ul></>}
   {(view==='rolled_back'||view==='not_changed'||view==='needs_action')&&<><h2>What happened</h2>
    <p>{view==='rolled_back'?`${failedStage?`The update stopped during the ${failedStage} stage. `:''}DockNest stopped the update and started ${fromText} again. Try the update again, or ask your server administrator to look at the details in the Update Center.`:view==='not_changed'?<>DockNest stopped the update before changing anything. Try again later. If this keeps happening, report it on the <ExtLink href={REPO+'/issues'}>DockNest issue tracker</ExtLink>.</>:`${failedStage?`The update stopped during the ${failedStage} stage. `:''}DockNest could not finish the update on its own.`}</p></>}
   {view==='needs_action'&&<><h2>Next steps</h2><p>A server administrator must finish this on the DockNest host. They can check the state with this command.</p><CodeBlock command="sudo scripts/install-updater.sh --status"/><p><ExtLink href={DOCS_ROLLBACK}>Rolling back</ExtLink></p><p className="next-step">DockNest unlocks automatically when the host confirms.</p></>}
   {(view==='stale'||view==='lost')&&<><h2>{view==='stale'?'Check the host':'What to do'}</h2><p>{view==='stale'?'Run these on the DockNest host. They show whether the updater is still working.':'Check on the DockNest host whether the new version runs, with these commands. Closing the record does not unblock updates or release the hold.'}</p>{HOST_COMMANDS.map(c=><CodeBlock key={c} command={c}/>)}</>}
   {view==='stale'&&admin&&reqId&&<div className="progress-actions"><button type="button" aria-disabled={ack.busy||undefined} onClick={()=>{if(!ack.busy)acknowledge()}}>Close this record</button><p className="why">Only after you checked the host. Closing the record does not unblock updates.</p></div>}
   {ack.error&&<AlertPanel variant="error">{ack.error}</AlertPanel>}
   {track&&<Details statuses={statuses} to={toText} from={fromText}/>}
   <div className="progress-actions">
    {view==='succeeded'&&<button type="button" className="primary" onClick={reload}>Reload DockNest</button>}
    {(view==='rolled_back'||view==='not_changed'||view==='lost')&&<button type="button" className={view==='rolled_back'&&admin?'':'primary'} onClick={onExit}>Back to DockNest</button>}
    {view==='rolled_back'&&admin&&<button type="button" className="primary" aria-disabled={!retry?.can||undefined} aria-describedby={retryReason?'lock-retry-reason':undefined} onClick={()=>{if(retry?.can)onRetry({requestId:reqId})}}>Retry update</button>}
    {admin&&REPORT_VIEWS.includes(view)&&<UpdateReportButton client={client} role={admin?'admin':null} view={view} version={from} progress={p} lastPhase={lastPhase.current}/>}
    {retryReason&&view==='rolled_back'&&admin&&<p className="why" id="lock-retry-reason">{retryReason}</p>}
   </div>
  </section></main></div>;
}
