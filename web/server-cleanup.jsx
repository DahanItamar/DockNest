import React,{useEffect,useRef,useState} from 'react';
import {AlertPanel} from './system.jsx';
import {DataTable} from './data-table.jsx';
import {Paginated} from './pagination.jsx';
import {X} from './icons.jsx';
import {count} from './plural.js';
import {formatBytes} from '../shared/format-bytes.js';
import './server-cleanup.css';

// Server cleanup (docs/server-cleanup.md): Scan, review what can go and what stays, confirm, see what happened.
// The server decides; this page only shows its preview and sends back the items that were shown.
export const KINDS=[['containers','Stopped containers'],['images','Dangling images'],['volumes','Unused volumes'],['buildCache','Build cache']];
export const REASONS={site:'Used by a site',oldCopy:'Kept old copy',move:'Site move',restoreTest:'Restore test',restoreCopy:'Restore copy',backup:'Backup running',docknest:'DockNest',inUse:'In use',runningStack:'Running stack',named:'Named volume',tooNew:'Under an hour old',gone:'Already gone',changed:'Changed since scan',docker:'Docker refused',buildCache:'Prune failed'};
const size=bytes=>Number.isFinite(bytes)?formatBytes(bytes):'Unknown';
const kindLabel=kind=>(KINDS.find(([key])=>key===kind)||[kind,kind])[1];
const sum=items=>items.reduce((total,item)=>total+(item.bytes||0),0);
export function resultLine(result){
 const parts=[`Removed ${count(result.removed,'item')}, ${formatBytes(result.bytes)} freed.`];
 if(result.skipped)parts.push(`${count(result.skipped,'item')} skipped.`);
 if(result.failed)parts.push(`${count(result.failed,'item')} failed.`);
 return parts.join(' ');
}

function ConfirmDialog({server,items,busy,onCancel,onConfirm}){
 const ref=useRef();
 useEffect(()=>{ref.current?.showModal?.();return()=>ref.current?.close?.();},[]);
 return <dialog ref={ref} className="sc-dialog" aria-labelledby="sc-dialog-title" onCancel={event=>{event.preventDefault();if(!busy)onCancel();}}>
  <div className="modal-head"><h2 id="sc-dialog-title">Clean up {server.name}?</h2><button type="button" className="icon" onClick={onCancel} disabled={busy} aria-label="Close dialog"><X size={20}/></button></div>
  <div className="modal-body">
   <p>DockNest removes {count(items.length,'item')}, about {formatBytes(sum(items))}. This cannot be undone.</p>
   <p className="t-caption">Each item is checked again first. Anything now in use stays.</p>
   <div className="modal-foot"><button type="button" disabled={busy} onClick={onCancel}>Cancel</button><button type="button" className="danger" disabled={busy} onClick={onConfirm}>{busy?'Cleaning…':'Clean up'}</button></div>
  </div>
 </dialog>;
}

function ItemTable({kind,items}){
 return <Paginated rows={items} label={kindLabel(kind)} pageSize={5}>{visible=><DataTable headers={['Name','ID','Size']} columns={[null,'30%','18%']} numeric={[2]}>{visible.map(item=><tr key={item.id}><td title={item.name}>{item.name}</td><td title={item.id}><code>{item.id.replace(/^sha256:/,'').slice(0,12)}</code></td><td>{size(item.bytes)}</td></tr>)}</DataTable>}</Paginated>;
}

export function ServerCleanup({api,servers,onSessionExpired}){
 const [serverId,setServerId]=useState(servers[0]?.id||''),[scan,setScan]=useState(null),[phase,setPhase]=useState('idle'),[error,setError]=useState(''),[confirm,setConfirm]=useState(false),[result,setResult]=useState(null),[excluded,setExcluded]=useState([]);
 const server=servers.find(item=>item.id===serverId)||servers[0];
 useEffect(()=>{if(!servers.some(item=>item.id===serverId))setServerId(servers[0]?.id||'');},[servers]);
 const fail=failure=>{if(failure.status===401){onSessionExpired?.();return true;}setError(failure.message||'The request did not go through.');return false;};
 async function runScan(){
  if(!server||phase==='scanning')return;
  setPhase('scanning');setError('');setResult(null);setScan(null);setExcluded([]);
  try{setScan(await api('/servers/'+server.id+'/cleanup/scan',{}));setPhase('preview');}
  catch(failure){fail(failure);setPhase('idle');}
 }
 const chosen=scan?scan.items.filter(item=>!excluded.includes(item.kind)):[];
 async function runClean(){
  setPhase('cleaning');setError('');
  try{const outcome=await api('/servers/'+server.id+'/cleanup',{token:scan.token,items:chosen.map(({kind,id})=>({kind,id}))});setResult(outcome);setScan(null);setConfirm(false);setPhase('done');}
  catch(failure){setConfirm(false);if(!fail(failure))setPhase(failure.code==='PREVIEW_EXPIRED'?'idle':'preview');if(failure.code==='PREVIEW_EXPIRED')setScan(null);}
 }
 const groups=scan?KINDS.map(([kind,label])=>({kind,label,items:scan.items.filter(item=>item.kind===kind)})).filter(group=>group.items.length):[];
 const toggle=kind=>setExcluded(list=>list.includes(kind)?list.filter(item=>item!==kind):[...list,kind]);
 const notes=(result?.results||[]).filter(row=>row.status!=='removed');
 return <section className="card sc-root" aria-labelledby="sc-title">
  <div className="card-body">
   <h2 className="card-title" id="sc-title">Server cleanup</h2>
   <p className="t-caption sc-lead">Free Docker space that nothing needs.</p>
   {!servers.length?<p className="t-caption">Connect a server to clean it up.</p>:<div className="sc-controls">
    <label className="field sc-server"><span>Server</span><select aria-label="Server to clean" value={server?.id||''} disabled={phase==='scanning'||phase==='cleaning'} onChange={event=>{setServerId(event.target.value);setScan(null);setResult(null);setError('');setPhase('idle');}}>{servers.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <button type="button" className="primary" disabled={phase==='scanning'||phase==='cleaning'} onClick={runScan}>{phase==='scanning'?'Scanning…':'Scan'}</button>
   </div>}
   {phase==='scanning'&&<p className="t-caption" role="status">Reading Docker on {server?.name}…</p>}
   {error&&<AlertPanel variant="error" title="Cleanup did not run" action={<div className="sc-actions"><button type="button" onClick={runScan}>Scan again</button></div>}>{error}</AlertPanel>}
   {result&&<div className="sc-result"><AlertPanel variant={result.failed?'warning':'info'} title="Cleanup finished">{resultLine(result)}</AlertPanel>
    {notes.length>0&&<DataTable caption="Items not removed" headers={['Name','Type','Reason']} columns={[null,'28%','28%']}>{notes.map(row=><tr key={row.kind+row.id}><td title={row.name}>{row.name}</td><td>{kindLabel(row.kind)}</td><td>{REASONS[row.reason]||'Kept'}</td></tr>)}</DataTable>}
   </div>}
   {scan&&<div className="sc-preview">
    {scan.busy&&<AlertPanel variant="error" title="Cleanup must wait" action={<div className="sc-actions"><button type="button" onClick={runScan}>Scan again</button></div>}>{scan.busy}</AlertPanel>}
    {!groups.length?<p className="t-caption sc-empty" role="status">Nothing to clean on {server.name}.</p>:<>
     <p className="sc-total"><strong>{formatBytes(scan.totalBytes)}</strong> <span className="t-caption">can be freed</span></p>
     {groups.map(group=><section className="sc-group" key={group.kind} aria-label={group.label}>
      <header className="sc-group-head"><label className="check sc-include"><input type="checkbox" checked={!excluded.includes(group.kind)} onChange={()=>toggle(group.kind)} disabled={phase==='cleaning'}/><span className="t-section">{group.label}</span></label><span className="t-caption sc-group-size">{group.items.some(item=>Number.isFinite(item.bytes))?size(sum(group.items)):'Unknown'}</span></header>
      {group.kind==='buildCache'?<p className="t-caption sc-note">Unused cache older than a day. Builds may run slower once.</p>:<ItemTable kind={group.kind} items={group.items}/>}
     </section>)}
     <div className="sc-foot"><button type="button" className="danger" disabled={!chosen.length||Boolean(scan.busy)||phase==='cleaning'} onClick={()=>setConfirm(true)}>Clean up</button></div>
    </>}
    {scan.protected.length>0&&<details className="sc-kept"><summary>Kept items</summary>
     <p className="t-caption">DockNest never removes these.</p>
     <Paginated rows={scan.protected} label="Kept items" pageSize={5}>{visible=><DataTable headers={['Name','Type','Reason']} columns={[null,'28%','28%']}>{visible.map(item=><tr key={item.kind+item.id}><td title={item.name}>{item.name}</td><td>{kindLabel(item.kind)}</td><td>{REASONS[item.reason]||'Kept'}</td></tr>)}</DataTable>}</Paginated>
    </details>}
   </div>}
  </div>
  {confirm&&scan&&<ConfirmDialog server={server} items={chosen} busy={phase==='cleaning'} onCancel={()=>setConfirm(false)} onConfirm={runClean}/>}
 </section>;
}
