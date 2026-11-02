import React,{useEffect,useId,useState} from 'react';
import {Sheet} from '../map/MoveFlow.jsx';
import {AlertPanel,StatusLabel} from '../system.jsx';
import {DataTable} from '../data-table.jsx';
import {RefreshCw} from '../icons.jsx';
import {notWatching,WINDOWS,DEFAULT_RESTARTS,DEFAULT_WINDOW,MIN_RESTARTS,MAX_RESTARTS,validRestarts,RESULTS,rows,timeOf,saveError,windowLabel} from './model.js';
import './self-heal.css';

const SESSION='Your session ended. Sign in again.';
function Restarts({events,narrow,more,onMore,moreBusy}){
 const list=rows(events);
 if(!list.length)return <div className="data-table-wrap"><div className="empty sh-empty"><span className="empty-icon"><RefreshCw size={28} stroke={1.75} aria-hidden="true"/></span><h3>No restarts yet</h3></div></div>;
 const result=e=>{const r=RESULTS[e.kind];return <StatusLabel state={r.state}>{r.label}</StatusLabel>};
 const why=e=>(e.kind==='skipped'||e.kind==='restart_failed')&&e.reason?<small className="sh-reason">{e.reason}</small>:null;
 const key=e=>e.id||e.at+e.container;
 const table=narrow?<div className="data-table-wrap sh-rows"><dl className="def-list">{list.map(e=><div className="def-row sh-row" key={key(e)}><dt><span>{timeOf(e.at)} <code>{e.container}</code></span>{why(e)}</dt><dd>{result(e)}</dd></div>)}</dl></div>
  :<DataTable headers={['Time','Container','Result']} columns={['96px',null,'160px']}>{list.map(e=><tr key={key(e)}><td>{timeOf(e.at)}</td><td><code>{e.container}</code>{why(e)}</td><td>{result(e)}</td></tr>)}</DataTable>;
 return <>{table}{more&&<div className="sh-more"><button type="button" disabled={moreBusy} onClick={onMore}>Show more</button></div>}</>;
}

// Site panel, Self-heal: restart unhealthy containers up to N times in a window (docs/self-heal.md). Administrators edit, operators read.
export function SelfHealSheet({client,site,narrow,onClose,onSaved,onSessionExpired}){
 const [data,setData]=useState(null),[loadError,setLoadError]=useState(''),[tries,setTries]=useState(0);
 const [enabled,setEnabled]=useState(false),[count,setCount]=useState(String(DEFAULT_RESTARTS)),[windowMinutes,setWindow]=useState(DEFAULT_WINDOW);
 const [items,setItems]=useState([]),[cursor,setCursor]=useState(null),[moreBusy,setMoreBusy]=useState(false),[noHcSeen,setNoHcSeen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(null),[touched,setTouched]=useState(false);
 const uid=useId(),on=uid+'-on',n=uid+'-n';
 useEffect(()=>{
  let alive=true;setLoadError('');
  client.load(site.id).then(d=>{
   if(!alive)return;
   setData(d);setItems(Array.isArray(d.events?.items)?d.events.items:[]);setCursor(d.events?.nextCursor||null);setEnabled(!!d.enabled);setCount(String(d.maxRestarts??DEFAULT_RESTARTS));setWindow(Number(d.windowMinutes)||DEFAULT_WINDOW);
  }).catch(e=>{if(!alive)return;if(e.status===401&&onSessionExpired)onSessionExpired();else setLoadError(e.status===401?SESSION:e.message||'Self-heal could not be loaded.')});
  return()=>{alive=false};
 },[client,site.id,tries]);
 const title='Self-heal',label='map-selfheal-title',cls='dialog-edge sh-sheet';
 if(loadError)return <Sheet title={title} labelId={label} className={cls} fixedHead onClose={onClose} actions={<><button type="button" onClick={onClose}>Close</button><button type="button" className="primary" onClick={()=>{setLoadError('');setData(null);setTries(x=>x+1)}}>Try again</button></>}><AlertPanel variant="error" title="Could not load">{loadError}</AlertPanel></Sheet>;
 if(!data)return <Sheet title={title} labelId={label} className={cls} fixedHead onClose={onClose} actions={<button type="button" onClick={onClose}>Cancel</button>}><div className="sh-load" role="status" aria-live="polite"><StatusLabel state="running">Loading…</StatusLabel></div></Sheet>;
 // A site that was never switched on has no watched list yet, so "no health check" is known from the server's answer: the stream reason, a static site, or a 422 on save.
 const canEdit=data.canEdit===true,noHc=data.available===false||data.stream?.reason==='no_healthcheck'||noHcSeen,locked=!canEdit||noHc;
 const found=(Array.isArray(data.watched)?data.watched:[]).filter(w=>w.found===true);
 const options=WINDOWS.some(([m])=>m===windowMinutes)?WINDOWS:[...WINDOWS,[windowMinutes,windowLabel(windowMinutes)]].sort((a,b)=>a[0]-b[0]);
 const fieldsOff=locked||!enabled,bad=enabled&&!validRestarts(count);
 async function showMore(){
  if(moreBusy||!cursor)return;
  setMoreBusy(true);
  try{const page=await client.events(site.id,cursor);setItems(list=>[...list,...(Array.isArray(page?.items)?page.items:[])]);setCursor(page?.nextCursor||null)}
  catch(e){if(e.status===401&&onSessionExpired)onSessionExpired();else setError({title:e.status===401?'Signed out':'Could not load',text:e.status===401?SESSION:e.message||'Try again.'})}finally{setMoreBusy(false)}
 }
 async function save(){
  if(busy)return;
  if(bad){setTouched(true);return}
  setBusy(true);setError(null);
  try{await client.save(site.id,{enabled,maxRestarts:validRestarts(count)?Number(count):DEFAULT_RESTARTS,windowMinutes});onSaved?.(enabled?'Self-heal saved.':'Self-heal is off.')}
  catch(e){if(e.status===401&&onSessionExpired){onSessionExpired();return}if(e.status===401){setError({title:'Signed out',text:SESSION});return}if(e.code==='NO_HEALTHCHECK'){setNoHcSeen(true);setEnabled(false);return}setError(saveError(e))}finally{setBusy(false)}
 }
 return <Sheet title={title} labelId={label} className={cls} fixedHead onClose={onClose} actions={canEdit?<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy} onClick={save}>{busy?'Saving…':'Save'}</button></>:<button type="button" onClick={onClose}>Close</button>}>
  <div className="sb-switch-row sh-switch">
   <span className="sb-switch-text"><span id={on} className="sb-switch-label">Restart unhealthy containers</span></span>
   <button type="button" role="switch" className="switch" aria-checked={enabled&&!noHc} aria-labelledby={on} disabled={locked} onPointerDown={e=>e.preventDefault()} onClick={()=>{setError(null);setEnabled(v=>!v)}}></button>
  </div>
  <div className="inc-row sh-limit">
   <div className="inc-row-text"><label className="inc-row-label" htmlFor={n}>Restart up to</label><span className="t-caption">Alerts go to your alert lines.</span></div>
   <div className="inc-row-control sh-limit-control">
    <input id={n} className="sh-count" type="number" inputMode="numeric" min={MIN_RESTARTS} max={MAX_RESTARTS} step="1" value={count} disabled={fieldsOff} aria-invalid={enabled&&touched&&bad?'true':undefined} onChange={e=>{setError(null);setCount(e.target.value)}} onBlur={()=>setTouched(true)}/>
    <span className="inc-unit">times in</span>
    <select className="sh-window" aria-label="Time window" value={windowMinutes} disabled={fieldsOff} onChange={e=>{setError(null);setWindow(Number(e.target.value))}}>{options.map(([m,l])=><option key={m} value={m}>{l}</option>)}</select>
   </div>
  </div>
  {noHc?<AlertPanel variant="warning">No container has a health check. Add one in Compose.</AlertPanel>:enabled&&notWatching(data.stream)?<AlertPanel variant="warning">{notWatching(data.stream)}</AlertPanel>:<AlertPanel variant="info">Only containers with a health check. {data.note}</AlertPanel>}
  {enabled&&!noHc&&!notWatching(data.stream)&&found.length>0&&<p className="t-caption sh-watched">Watching {found.map((w,i)=><React.Fragment key={w.name}>{i>0&&', '}<code>{w.name}</code></React.Fragment>)}</p>}
  {error&&<AlertPanel variant="error" title={error.title}>{error.text}</AlertPanel>}
  <div className="sh-history"><h3>Recent restarts</h3><Restarts events={{items}} narrow={narrow} more={!!cursor} onMore={showMore} moreBusy={moreBusy}/></div>
 </Sheet>;
}
