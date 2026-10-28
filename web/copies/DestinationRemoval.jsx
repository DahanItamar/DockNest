import React,{useRef,useState} from 'react';
import {AlertPanel} from '../system.jsx';
import {useGuard} from '../map/MoveFlow.jsx';
import {formatBytes} from '../../shared/format-bytes.js';
import {count} from '../plural.js';
import {usageLines,removalAdvice} from './model.js';
import './copies.css';

// Removing a destination: always asks first. A 409 destination_in_use says how many copies and sites hold it
// and offers "Delete copies"; nothing is deleted without that explicit step.
export function useDestinationRemoval(client,{onDone,onSessionExpired}){
 const [removal,setRemoval]=useState(null),[busy,setBusy]=useState(false),guard=useGuard(client),pending=useRef(false);
 const fail=failure=>{
  if(failure.status===401){onSessionExpired?.();return}
  if(failure.status===409&&failure.code==='destination_in_use'){setRemoval(r=>({...r,phase:'in_use',usage:failure.data||{},error:''}));return}
  if(failure.status===409&&failure.code==='pinned_copies'){setRemoval(r=>({...r,phase:'pinned',error:''}));return}
  if(failure.status===409&&failure.code==='last_packages'){setRemoval(r=>({...r,phase:'last_packages',only:failure.data?.onlyPackageBackups??r.usage?.onlyPackageBackups??0,error:''}));return}
  setRemoval(r=>({...r,error:failure.message||'The destination could not be changed.'}));
 };
 async function run(task){
  if(pending.current)return;pending.current=true;setBusy(true);
  try{await guard.run(task,fail)}finally{pending.current=false;setBusy(false)}
 }
 return {
  removal,busy,prompt:guard.prompt,waiting:guard.waiting,
  ask:target=>setRemoval({target,phase:'confirm',usage:null,error:''}),
  cancel:()=>setRemoval(null),
  remove:()=>run(async()=>{const target=removal.target;await client.removeDestination(target.id);setRemoval(null);await onDone('Destination removed. Files already stored there were not touched.')}),
  deleteCopies:(includePinned,includeLastPackages)=>run(async()=>{const target=removal.target,keep=includePinned||removal.includePinned;setRemoval(r=>({...r,includePinned:keep}));const result=await client.deleteCopies(target.id,{includePinned:keep,includeLastPackages});setRemoval(null);await onDone('Deleting '+count(result?.deleting??0,'copy','copies')+' on '+target.name+'. Remove the destination again when it finishes.')})
 };
}

// The panel under a destination card. Error and warning panels announce themselves.
export function RemovalPanel({state,target}){
 const {removal,busy,waiting}=state;
 if(!removal||removal.target.id!==target.id)return null;
 const off=busy||waiting;
 const advice=removal.usage?removalAdvice(removal.usage):null;
 const actions=(...buttons)=><div className="cp-actions">{buttons}</div>;
 const cancel=<button key="cancel" type="button" disabled={off} onClick={state.cancel}>Cancel</button>;
 return <div className="cp-removal" data-phase={removal.phase}>
  {removal.phase==='confirm'&&<AlertPanel variant="warning" title={'Remove '+target.name+'?'} action={actions(cancel,<button key="go" type="button" className="danger" disabled={off} onClick={state.remove}>Remove</button>)}>DockNest forgets this destination. Files already stored there stay.</AlertPanel>}
  {removal.phase==='in_use'&&<AlertPanel variant="error" title="This destination is still in use" action={actions(cancel,advice?.canDeleteCopies&&<button key="go" type="button" className="danger" disabled={off} onClick={()=>state.deleteCopies(false)}>Delete copies</button>)}>
   <span className="cp-usage">{usageLines(removal.usage,formatBytes).map(line=><span key={line}>{line}</span>)}</span>
   {advice?.steps}
  </AlertPanel>}
  {removal.phase==='pinned'&&<AlertPanel variant="warning" title="Some backups are pinned" action={actions(cancel,<button key="go" type="button" className="danger" disabled={off} onClick={()=>state.deleteCopies(true)}>Delete pinned too</button>)}>Pinned backups keep their copies unless you include them.</AlertPanel>}
  {removal.phase==='last_packages'&&<AlertPanel variant="error" title="Backups would be lost" action={actions(cancel,<button key="go" type="button" className="danger" disabled={off} onClick={()=>state.deleteCopies(false,true)}>Delete anyway</button>)}>{count(removal.only,'backup')} exist only here and will be lost. This cannot be undone.</AlertPanel>}
  {removal.error&&<AlertPanel variant="error">{removal.error}</AlertPanel>}
 </div>;
}
