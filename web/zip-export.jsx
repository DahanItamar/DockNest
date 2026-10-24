import React,{useEffect,useRef,useState} from 'react';
import {X} from './icons.jsx';
import './zip-export.css';

// "Download ZIP": DockNest first checks the whole backup (nothing is stored on the server), then streams the ZIP.
async function call(path,{method='GET',csrf}={}){
 const response=await fetch('/api'+path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json',...(csrf?{'x-csrf-token':csrf}:{})}});
 const data=await response.json().catch(()=>({error:'The server returned an unreadable response.'}));
 if(!response.ok)throw Object.assign(new Error(data.error||'Request failed'),{status:response.status});
 return data;
}
export function etaText(seconds){
 if(!Number.isFinite(seconds)||seconds===null)return 'Estimating the time left';
 if(seconds<60)return 'Less than a minute left';
 return 'About '+Math.ceil(seconds/60)+' min left';
}
export function readyText(expiresAt,now=Date.now()){
 const minutes=Math.max(1,Math.min(60,Math.ceil((new Date(expiresAt).getTime()-now)/60000)));
 return 'Ready for '+minutes+(minutes===1?' minute':' minutes');
}
export function ZipDialog({backupId,onClose}){
 const ref=useRef(),csrf=useRef(''),[state,setState]=useState(null),[error,setError]=useState(''),[starting,setStarting]=useState(true);
 const base='/backups/'+backupId+'/zip-exports';
 async function begin(){
  setError('');setStarting(true);
  try{
   if(!csrf.current)csrf.current=(await call('/auth/status')).csrfToken||'';
   const existing=(await call(base)).export;
   setState(existing||await call(base,{method:'POST',csrf:csrf.current}));
  }catch(e){setError(e.message);}
  setStarting(false);
 }
 useEffect(()=>{ref.current.showModal();begin();return()=>ref.current?.close();},[]);
 const live=state&&(state.status==='preparing'||state.status==='ready');
 useEffect(()=>{
  if(!live)return;
  const timer=setInterval(async()=>{try{setState(await call(base+'/'+state.id));}catch(e){if(e.status===404)setState({status:'expired'});}},2000);
  return()=>clearInterval(timer);
 },[live,state?.id]);
 async function cancel(){
  try{if(state?.id&&live)await call(base+'/'+state.id,{method:'DELETE',csrf:csrf.current});}catch{}
  onClose();
 }
 async function download(){
  setError('');
  try{
   const current=await call(base+'/'+state.id);setState(current);
   if(current.status!=='ready')return;
   window.location.assign('/api'+base+'/'+state.id+'/download');
  }catch(e){setError(e.message);}
 }
 const status=state?.status;
 const percent=state&&state.bytesTotal?Math.min(100,Math.floor(state.bytesDone/state.bytesTotal*100)):0;
 const title=status==='ready'?'Your ZIP is ready':status==='failed'?'The ZIP could not be prepared':status==='expired'?'This ZIP is no longer available':'Preparing your ZIP';
 return <dialog ref={ref} className="zip-dialog" aria-labelledby="zip-title" onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===ref.current)onClose();}}>
  <div className="modal-head"><h2 id="zip-title">{title}</h2><button type="button" className="icon" onClick={onClose} aria-label="Close dialog"><X size={20}/></button></div>
  <div className="modal-body zip-body">
   {error&&<div className="alert" role="alert">{error}</div>}
   {(starting||status==='preparing')&&!error&&<>
    <div className="zip-step"><b>Checking the backup</b><span>{starting&&!state?'Starting':percent+'%'}</span></div>
    <progress max="100" value={percent} aria-label="Checking the backup"/>
    <p className="zip-meta" aria-live="polite">{state?etaText(state.etaSeconds):'Starting'}</p>
    <p className="zip-note">You can close this window, the ZIP keeps preparing. Nothing is stored on the server: the ZIP is created while it downloads.</p>
   </>}
   {status==='ready'&&<>
    <p>The whole backup was checked. The ZIP is created while it downloads, so you can start straight away.</p>
    <p className="zip-meta">{readyText(state.expiresAt)}</p>
   </>}
   {status==='failed'&&<p role="alert">{state.error}</p>}
   {status==='expired'&&<p>Prepare it again to download.</p>}
  </div>
  <div className="modal-foot zip-foot">
   {status==='ready'?<><button type="button" onClick={cancel}>Discard</button><button type="button" className="primary" onClick={download}>Download ZIP</button></>
   :status==='failed'||status==='expired'||(error&&!state)?<><button type="button" onClick={onClose}>Close</button><button type="button" className="primary" onClick={()=>{setState(null);begin();}}>Try again</button></>
   :<button type="button" onClick={cancel}>Cancel</button>}
  </div>
 </dialog>;
}
export function ZipButton({backupId,className,label,title,children}){
 const [open,setOpen]=useState(false);
 return <>
  <button type="button" className={className} aria-label={label} title={title} onClick={()=>setOpen(true)}>{children}</button>
  {open&&<ZipDialog backupId={backupId} onClose={()=>setOpen(false)}/>}
 </>;
}
