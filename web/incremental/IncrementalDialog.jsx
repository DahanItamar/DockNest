import React,{useEffect,useState} from 'react';
import {AlertPanel,StatusLabel} from '../system.jsx';
import {DEFAULT_BACKUPS,MIN_BACKUPS,MAX_BACKUPS,toBackups,toIncrements,validBackups,intervalLine,saveError} from './model.js';
import './incremental.css';

// Site settings, Incremental backups (beta): on/off, how often a full backup is made, and a full backup on demand.
export function IncrementalDialog({client,site,onClose,onSaved,onSessionExpired}){
 const [data,setData]=useState(null),[loadError,setLoadError]=useState('');
 const [enabled,setEnabled]=useState(false),[every,setEvery]=useState(String(DEFAULT_BACKUPS));
 const [tries,setTries]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState(null),[touched,setTouched]=useState(false);
 useEffect(()=>{
  let alive=true;setLoadError('');
  client.get(site.id).then(settings=>{
   if(!alive)return;
   setData(settings);setEnabled(!!settings.enabled);setEvery(String(toBackups(settings.interval??DEFAULT_BACKUPS-1)));
  }).catch(failure=>{if(!alive)return;if(failure.status===401)onSessionExpired?.();else setLoadError(failure.message||'Incremental settings could not be loaded.')});
  return()=>{alive=false};
 },[client,site.id,tries]);

 if(loadError)return <div className="modal-body"><AlertPanel variant="error" title="Could not load settings">{loadError}</AlertPanel><div className="modal-foot"><button type="button" onClick={onClose}>Close</button><button type="button" className="primary" onClick={()=>{setData(null);setTries(n=>n+1)}}>Try again</button></div></div>;
 if(!data)return <div className="modal-body"><div className="inc-load" role="status" aria-live="polite"><StatusLabel state="running">Loading settings…</StatusLabel></div></div>;

 const bad=enabled&&!validBackups(every),failed=failure=>{if(failure.status===401){onSessionExpired?.();return}setError(saveError(failure))};
 async function save(event){
  event.preventDefault();if(busy)return;
  if(bad){setTouched(true);return}
  setBusy(true);setError(null);
  try{await client.save(site.id,{enabled,interval:toIncrements(validBackups(every)?every:DEFAULT_BACKUPS)});onSaved(enabled?'Incremental backups saved.':'Incremental backups are off. The next backup will be full.')}catch(failure){failed(failure)}finally{setBusy(false)}
 }
 async function fullNow(){
  if(busy)return;
  setBusy(true);setError(null);
  try{await client.save(site.id,{fullNow:true});onSaved('Full backup queued. Follow progress in Jobs.')}catch(failure){failed(failure)}finally{setBusy(false)}
 }
 const nextFull=enabled&&data.fullNext;
 return <form className="modal-body site-wizard inc-form" onSubmit={save} noValidate>
  <div className="sb-switch-row">
   <span className="sb-switch-text"><span id="inc-on" className="sb-switch-label">Incremental backups</span><span id="inc-on-help" className="t-caption">Beta. {enabled?'Between full backups, only changed files are saved.':'Every backup is a complete package.'}</span></span>
   <button type="button" role="switch" className="switch" aria-checked={enabled} aria-labelledby="inc-on" aria-describedby="inc-on-help" onPointerDown={event=>event.preventDefault()} onClick={()=>{setError(null);setEnabled(value=>!value)}}></button>
  </div>
  <div className="inc-row">
   <div className="inc-row-text"><label className="inc-row-label" htmlFor="inc-every">Full backup every</label><span className="t-caption" id="inc-every-help">{validBackups(every)?intervalLine(Number(every)):'Enter 2 to 31.'}</span></div>
   <div className="inc-row-control"><input id="inc-every" type="number" inputMode="numeric" min={MIN_BACKUPS} max={MAX_BACKUPS} step="1" value={every} disabled={!enabled} aria-invalid={enabled&&touched&&bad?'true':undefined} aria-describedby="inc-every-help" onChange={event=>{setError(null);setEvery(event.target.value)}} onBlur={()=>setTouched(true)}/><span className="inc-unit">backups</span></div>
  </div>
  <div className="inc-row">
   <div className="inc-row-text"><span className="inc-row-label" id="inc-full">New chain</span><span className="t-caption" id="inc-full-help">A full backup, then increments. Old backups stay.</span>{(!data.enabled||!enabled)&&<span className="t-caption inc-hint">Save first.</span>}</div>
   <div className="inc-row-add"><button type="button" aria-describedby="inc-full-help" disabled={busy||!data.enabled||!enabled} onClick={fullNow}>Full backup now</button></div>
  </div>
  {data.available===false&&<AlertPanel variant="info" title="Not available">Incremental backups need a Docker site on a server with the latest helper.</AlertPanel>}
  {enabled&&<p className="inc-next t-caption"><StatusLabel state="queued">{nextFull?'Next backup: full':'Next backup: increment'}</StatusLabel></p>}
  {enabled&&nextFull&&data.fullNextMessage&&<AlertPanel variant="warning" title="Full backup planned">{data.fullNextMessage}</AlertPanel>}
  {!enabled&&data.enabled&&<AlertPanel variant="info" title="Existing chains stay">Turning this off makes the next backup full. Older backups can still be restored.</AlertPanel>}
  {error&&<AlertPanel variant="error" title={error.reason}>{error.action}</AlertPanel>}
  <div className="modal-foot"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy?'Saving…':'Save'}</button></div>
 </form>;
}
