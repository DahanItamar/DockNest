import React,{useEffect,useState} from 'react';
import {Plus,X} from '../icons.jsx';
import {AlertPanel,IconButton} from '../system.jsx';
import {useGuard} from '../map/MoveFlow.jsx';
import {MAX_COPIES,storageError} from './model.js';
import './copies.css';

let seed=0;
const row=(targetId,retention)=>({key:'c'+(++seed),targetId,retention:retention==null?'':String(retention)});

// Site settings, Storage: the main destination and up to three extra copies, each with its own retention.
export function SiteStorageDialog({client,site,siteRetention,onClose,onSaved,onSessionExpired}){
 const [data,setData]=useState(null),[targets,setTargets]=useState([]),[loadError,setLoadError]=useState('');
 const [main,setMain]=useState(''),[copies,setCopies]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(null);
 const guard=useGuard(client);
 useEffect(()=>{
  let alive=true;
  Promise.all([client.siteStorage(site.id),client.destinations()]).then(([storage,list])=>{
   if(!alive)return;
   setData(storage);setTargets(list.targets||[]);setMain(storage.main.targetId||'');
   setCopies((storage.copies||[]).map(copy=>row(copy.targetId,copy.retention)));
  }).catch(failure=>{if(!alive)return;if(failure.status===401)onSessionExpired?.();else setLoadError(failure.message||'Storage settings could not be loaded.')});
  return()=>{alive=false};
 },[client,site.id]);

 if(loadError)return <div className="modal-body"><AlertPanel variant="error" title="Could not load storage">{loadError}</AlertPanel><div className="modal-foot"><button type="button" onClick={onClose}>Close</button></div></div>;
 if(!data)return <div className="modal-body"><p role="status">Loading storage…</p></div>;

 const maxCopies=data.maxCopies||MAX_COPIES;
 const defaultName=data.default?.name,nameOf=id=>targets.find(target=>target.id===id)?.name||id;
 const mainId=main||data.default?.id||'';
 const free=targets.find(target=>target.id!==mainId&&!copies.some(copy=>copy.targetId===target.id));
 const canAdd=copies.length<maxCopies&&!!free;
 const change=(key,patch)=>{setError(null);setCopies(list=>list.map(copy=>copy.key===key?{...copy,...patch}:copy))};
 async function save(event){
  event.preventDefault();if(busy||guard.waiting)return;
  setBusy(true);setError(null);
  const body={mainTargetId:main||null,copies:copies.map(copy=>({targetId:copy.targetId,retention:copy.retention.trim()===''?null:Number(copy.retention)}))};
  try{await guard.run(async()=>{await client.saveSiteStorage(site.id,body);onSaved()},failure=>{if(failure.status===401){onSessionExpired?.();return}setError(storageError(failure))})}finally{setBusy(false)}
 }
 return <form className="modal-body site-wizard cp-form" onSubmit={save} noValidate>
  <div className="cp-row">
   <div className="cp-row-text"><label className="cp-row-label" htmlFor="cp-main">Main destination</label><span className="t-caption" id="cp-main-help">New backups go here. Old ones stay put.</span></div>
   <div className="cp-row-control"><select id="cp-main" value={main} aria-describedby="cp-main-help" onChange={event=>{setError(null);setMain(event.target.value)}}>
    <option value="">{defaultName?'Default ('+defaultName+')':'Default destination'}</option>
    {targets.map(target=><option key={target.id} value={target.id}>{target.name}</option>)}
   </select></div>
  </div>
  <div className="cp-row">
   <div className="cp-row-text"><span className="cp-row-label" id="cp-extra">Extra copies</span><span className="t-caption" id="cp-extra-help">Keep more copies on other destinations.</span></div>
   <div className="cp-row-control cp-row-add"><button type="button" aria-describedby="cp-extra-help" disabled={!canAdd||busy} onClick={()=>{setError(null);setCopies(list=>[...list,row(free.id,siteRetention)])}}><Plus size={18} stroke={2} aria-hidden="true"/> Add copy</button></div>
  </div>
  {!free&&copies.length<maxCopies&&<p className="t-caption cp-note">Connect another destination to add a copy.</p>}
  {copies.length>0&&<div className="cp-copy-list" role="group" aria-labelledby="cp-extra">
   <div className="cp-copy-head t-caption" aria-hidden="true"><span>Destination</span><span>Keep</span><span/></div>
   {copies.map((copy,index)=><div className="cp-copy-edit" key={copy.key}>
    <select aria-label={'Destination for copy '+(index+1)} value={copy.targetId} onChange={event=>change(copy.key,{targetId:event.target.value})}>
     {targets.map(target=><option key={target.id} value={target.id}>{target.name}</option>)}
     {!targets.some(target=>target.id===copy.targetId)&&<option value={copy.targetId}>{nameOf(copy.targetId)}</option>}
    </select>
    <input type="number" inputMode="numeric" min="1" max="365" step="1" aria-label={'Backups to keep on copy '+(index+1)} value={copy.retention} onChange={event=>change(copy.key,{retention:event.target.value})}/>
    <IconButton label={'Remove copy '+(index+1)} icon={X} onClick={()=>{setError(null);setCopies(list=>list.filter(item=>item.key!==copy.key))}}/>
   </div>)}
   <p className="t-caption cp-note">Empty keeps the same count as the site.</p>
  </div>}
  {guard.prompt&&<div className="map-root">{guard.prompt}</div>}
  {error&&<AlertPanel variant="error" title={error.reason}>{error.action}</AlertPanel>}
  <div className="modal-foot"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={busy||guard.waiting}>{busy?'Saving…':'Save'}</button></div>
 </form>;
}
