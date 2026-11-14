import React,{useEffect,useRef,useState} from 'react';
import {AlertPanel} from './system.jsx';
import {Trash,Settings,X} from './icons.jsx';
import {describeSchedule} from './schedule.js';
import {sqliteFailure} from './sqlite-files.js';

// Plain confirm before a path leaves the site's SQLite list.
function ConfirmRemove({path,services,busy,error,onCancel,onConfirm}){
 const ref=useRef(null);
 useEffect(()=>{const dialog=ref.current;if(dialog&&!dialog.open)dialog.showModal();return()=>{if(dialog?.open)dialog.close()}},[]);
 return <dialog ref={ref} className="sq-confirm" aria-labelledby="sq-confirm-title" onCancel={event=>{event.preventDefault();if(!busy)onCancel()}}>
  <div className="modal-head"><h2 id="sq-confirm-title">Remove path</h2><button type="button" className="icon" aria-label="Close dialog" disabled={busy} onClick={onCancel}><X size={20}/></button></div>
  <div className="modal-body">
   <p>Remove <b>{path}</b> from {services.length===1?'service':'services'} <b>{services.join(', ')}</b>?</p>
   <p>DockNest will stop checking and capturing this file, so it is no longer health-checked. Other files and databases stay protected.</p>
   <p>The change applies from the next backup.</p>
   {error&&<AlertPanel variant="error" title="The path was not removed">{error}</AlertPanel>}
   <div className="modal-foot"><button type="button" onClick={onCancel} disabled={busy}>Cancel</button><button type="button" className="primary" onClick={onConfirm} disabled={busy}>{busy?'Removing…':'Remove path'}</button></div>
  </div>
 </dialog>;
}

const CAUSE={
 missing:['A declared database file is missing.','Missing','Remove the path if the file is gone for good.'],
 link:['A declared database file is now a link.','Symbolic link','DockNest does not follow links. Declare the real file instead.'],
 legacy:['A declared database file is missing, unreadable or a link.',null,null]
};

// The failed-backup view for the SQLite file helper messages. Returns null when the error is some other failure.
export function SqliteFix({job,site,policy,downtimeSeconds,onRemovePath,onOpenSettings,onBackup}){
 const failure=sqliteFailure(job.error);
 const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[removed,setRemoved]=useState(false);
 if(!failure||job.status!=='failed'||!site)return null;
 const [line,label,advice]=CAUSE[failure.kind];
 const services=failure.path?(site.config?.services||[]).filter(service=>Array.isArray(service.sqliteFiles)&&service.sqliteFiles.includes(failure.path)).map(service=>service.container):[];
 const canRemove=!!failure.path&&services.length>0&&!removed&&!!onRemovePath;
 const when=policy?.enabled&&policy.schedule?' ('+describeSchedule(policy.schedule).replace(/^Every /,'every ')+')':'';
 const minutes=Number.isFinite(downtimeSeconds)&&downtimeSeconds>0?Math.max(1,Math.round(downtimeSeconds/60)):null;
 async function remove(){setBusy(true);setError('');try{await onRemovePath(failure.path);setRemoved(true);setConfirm(false)}catch(caught){setError(caught?.message||'Could not save the site. Try again.')}finally{setBusy(false)}}
 return <>
  <AlertPanel variant="error" title="What happened" action={<>
   {removed?<span className="dn-next"><b>Done</b> {failure.path} was removed from the site. It is checked at the next scheduled backup.</span>
    :<span className="dn-next"><b>Next step</b> {failure.path?(services.length?'Fix it in the site settings or remove the path.':'No service declares this path any more. Run a backup to confirm.'):'Check the SQLite files in the site settings.'} It is checked again at the next scheduled backup{when}.</span>}
   {!removed&&<div className="btn-row">{canRemove&&<button type="button" onClick={()=>{setError('');setConfirm(true)}}><Trash size={16} stroke={1.75} aria-hidden="true"/>Remove path</button>}{onOpenSettings&&<button type="button" onClick={onOpenSettings}><Settings size={16} stroke={1.75} aria-hidden="true"/>Open settings</button>}</div>}
   {onBackup&&<div className="later"><span><button type="button" className="sq-quiet" onClick={onBackup}>Back up now</button></span><small>Runs the full backup.{minutes?' The site is offline for about '+minutes+' min.':''}</small></div>}
  </>}>
   <span className="dn-err-line">{line}</span><span className="dn-err-msg">{job.error}</span>
   {failure.path&&<span className="path-box"><code>{failure.path}</code>{services.length>0&&<small>{label} in {services.length===1?'service':'services'} <b>{services.join(', ')}</b>. {advice}</small>}</span>}
  </AlertPanel>
  {confirm&&<ConfirmRemove path={failure.path} services={services} busy={busy} error={error} onCancel={()=>setConfirm(false)} onConfirm={remove}/>}
 </>;
}
