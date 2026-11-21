import React,{useState} from 'react';
import {StatusLabel,AlertPanel} from './system.jsx';
import {HardDrive as Database,ShieldCheck,InfoCircle} from './icons.jsx';
import {rowState,rowText,rowTitle,switchDisabled,covers} from './online-dumps.js';
import './online-dumps.css';

const capital=text=>text.charAt(0).toUpperCase()+text.slice(1);
// The Databases block under Advanced backup settings: one switch for the whole app (config.onlineDumps), one row per
// database the app has, and the readiness answer on request. The words per row come from the engine capability the API reports.
export function DatabasesBlock({databases,engines,on,setOn,incremental,site,api,onSessionExpired}){
 const [check,setCheck]=useState(null),[busy,setBusy]=useState(false),[failed,setFailed]=useState('');
  if(!databases.length&&!on)return null;
 const disabled=switchDisabled(databases,on),supported=databases.some(db=>db.onlineCopy);
 const saved=site?.config?.onlineDumps===true,fallbacks=on&&check?.fallbacks||[];
 async function readiness(){
  if(saved!==on){setCheck({stale:true});return;}
  setBusy(true);setFailed('');
  try{const result=await api('/sites/'+site.id+'/readiness',{});setCheck((result.checks||[]).find(item=>item.name==='Online database dumps')||{none:true});}
  catch(error){if(error.status===401)onSessionExpired();else setFailed(error.message);}finally{setBusy(false);}
 }
 const note=on&&supported?(incremental||fallbacks.length?null:'The app’s own writers still stop first, so the copy matches their files. An app with only databases has no downtime. A restore loads the copy into a fresh database before the app starts, then runs your data checks. Restores take longer than a file copy, and cannot be moved to another server.'):!on&&supported?'Each database stops cleanly and its files are copied, as before. The app is offline for that time.':null;
 return <section className="sq-section od-section" aria-label="Databases"><h4>Databases</h4>
  <div className="sq-group">
   <div className="sq-head"><b><Database size={20} stroke={1.75} aria-hidden="true"/>Database backup method</b><small>{supported||on?'Applies to the whole app':'Not available'}</small></div>
   <div className="od-switch"><span className="sb-switch-text"><span id="od-label" className="sb-switch-label">Keep the database running during backup</span><span id="od-help" className="t-caption">{supported||on?'DockNest copies the database with its own tools while it keeps running, instead of stopping it for a file copy. Off by default: your current backups do not change.':'This app has no database DockNest can copy while it runs, so it keeps the stopped file copy. This switch covers '+covers(engines)+'.'}</span></span>
    <button type="button" role="switch" className="switch" aria-checked={on} aria-labelledby="od-label" aria-describedby="od-help" disabled={disabled} onClick={()=>{setOn(!on);setCheck(null);}}></button></div>
   <ul className="od-list" aria-label="Databases found in this app">
    {databases.map(db=>{const state=rowState(db,{on,incremental,fallbacks});return <li key={db.container}><span className="od-name"><b>{rowTitle(db)}</b><small>Container {db.container}</small></span>
     {state==='online'?<StatusLabel state="success">{rowText(db,state)}</StatusLabel>:<span className="t-caption od-note">{rowText(db,state)}</span>}</li>;})}
   </ul>
   {on&&incremental&&supported&&<div className="od-alert"><AlertPanel variant="warning" title={'Incremental backups are on for '+(site?.name||'this app')}>Incremental chains store files, so every database is stopped for a file copy and each backup carries a warning. The online copy applies again if you turn incremental backups off.</AlertPanel></div>}
   {!!fallbacks.length&&!incremental&&<div className="od-alert"><AlertPanel variant="warning" title={(site?.name||'This app')+' will still stop '+(fallbacks.length>1?'some databases':'its database')}>Online copy is not safe for {fallbacks.length>1?'these databases':'this database'}, so DockNest keeps the stopped file copy and adds a warning to each backup. Nothing is lost.<ul>{fallbacks.map(item=><li key={item.container}>{item.container}: {capital(item.reason)}.</li>)}</ul></AlertPanel></div>}
   {note&&<div className="od-foot"><InfoCircle size={16} aria-hidden="true"/><p className="t-caption">{note}</p></div>}
   {site&&supported&&<div className="od-links"><button type="button" className="link-action" disabled={busy} onClick={readiness}><ShieldCheck size={16} aria-hidden="true"/>Check readiness to see which databases will use it</button>
    {check?.stale&&<p className="t-caption" role="status">Save the configuration first. The check reads the saved settings.</p>}
    {check&&!check.stale&&!fallbacks.length&&<p className="t-caption" role="status">{check.none?'No running database to copy right now.':'Online copy: '+(check.dumped?.join(', ')||'no running database')+'.'}</p>}
    {failed&&<p className="t-caption" role="alert">{failed}</p>}</div>}
  </div>
 </section>;
}
