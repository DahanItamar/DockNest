import React,{useEffect,useMemo,useState} from 'react';
import {StatusLabel,AlertPanel} from '../system.jsx';
import {Sheet} from '../map/MoveFlow.jsx';
import {createSafeEditClient,friendlyError} from './safe-edit-client.js';
import {Rows,useNarrow} from './parts.jsx';
import {age} from '../restore-tests/model.js';
import '../map/map.css';
import './site-edit.css';

const RESULT={applied:['Applied','success'],rolled_back:['Rolled back','failed'],failed:['Stopped','needs-review'],cancelled:['Cancelled','queued']};
const stateOf=e=>e.state==='needs_attention'?['Needs attention','failed']:RESULT[e.result]||['Running','running'];
const changed=e=>{const f=e.changes?.fields;return Array.isArray(f)&&f.length?f.slice(0,3).join(', ')+(f.length>3?' and more':''):'Changed the site'};

// Read-only list of a site's Safe Edits, for administrators and operators. Open shows one edit's timeline.
export function EditHistoryDialog({api,site,onClose,onOpen}){
 const client=useMemo(()=>createSafeEditClient(api),[api]),narrow=useNarrow();
 const [items,setItems]=useState(null),[next,setNext]=useState(null),[error,setError]=useState('');
 async function load(cursor){
  try{const r=await client.history(site.id,cursor);setItems(list=>[...(cursor&&list?list:[]),...(r.items||[])]);setNext(r.next||null);setError('')}
  catch(e){setError(friendlyError(e));setItems(list=>list||[])}
 }
 useEffect(()=>{load()},[]);// eslint-disable-line
 const rows=(items||[]).map(e=>{
  const [label,state]=stateOf(e),when=age(e.createdAt),what=changed(e);
  const open=<button type="button" aria-label={'Open edit from '+when} onClick={()=>onOpen(e.id)}>Open</button>;
  const status=<StatusLabel state={state}>{label}</StatusLabel>;
  return {key:e.id,cells:[when,status,what,open],label:when,value:<>{status}{open}</>};
 });
 return <div className="map-root se-root"><Sheet className="dialog-edge" title={'Edits of '+site.name} labelId="safe-edit-history-title" onClose={onClose} actions={<button type="button" className="primary" onClick={onClose}>Close</button>}>
  {error&&<AlertPanel variant="error" action={<div className="rp-actions"><button type="button" onClick={()=>load()}>Try again</button></div>}>{error}</AlertPanel>}
  {items==null&&!error&&<div className="inc-load" role="status"><span className="status status-running">Reading history</span></div>}
  {items&&!items.length&&!error&&<p className="map-caption">No changes yet.</p>}
  {rows.length>0&&<Rows narrow={narrow} headers={['When','Result','Changed','']} columns={['110px','150px',null,'96px']} numeric={[]} rows={rows}/>}
  {next&&<div><button type="button" onClick={()=>load(next)}>Show more</button></div>}
 </Sheet></div>;
}
