import React,{useEffect,useMemo,useRef,useState} from 'react';
import {IconCircleCheck,IconX,IconBrandGithub} from '@tabler/icons-react';
import {AlertPanel} from '../system.jsx';
import {UCDialog,ExtLink,Notes,DOCS_SECURITY} from './parts.jsx';
import {createUpdatesClient} from './client.js';
import {buildBugReport} from './report.js';
import {tagUrl,vv} from './model.js';

export const UPDATED_KEY='docknest-updated-to';
// Asked once. Closing it (Escape, X, backdrop) records nothing and asks again at the next sign-in.
export function ConsentDialog({client,onClose,onAnswered}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[decided,setDecided]=useState(null);
 async function answer(value){
  setBusy(true);setError('');
  try{const next=await client.consent(value);onAnswered?.(next);onClose()}
  catch(e){
   if(e.code==='ALREADY_DECIDED'){let on=null;try{on=(await client.state()).consent?.checkEnabled}catch{}setDecided(on===false?'off':'on')}
   else setError(e.message||'The answer could not be saved.');
  }finally{setBusy(false)}
 }
 if(decided)return <UCDialog title="Update checks are already set" onClose={()=>{onAnswered?.();onClose()}} size="sm" label="dialog"><p>Another administrator already chose: daily checks {decided}. You can change this in the Update Center.</p><div className="modal-foot"><button type="button" className="primary" onClick={()=>{onAnswered?.();onClose()}}>Close</button></div></UCDialog>;
 return <UCDialog title="Check GitHub daily for new versions?" onClose={onClose} size="sm" label="dialog">
  <p>DockNest can look for new versions and tell administrators when one is available. You decide whether it does.</p>
  <h3>What is sent</h3><p>DockNest asks GitHub for the list of releases. Nothing about your servers, sites or users is sent.</p><p><ExtLink href={DOCS_SECURITY}>What is sent</ExtLink></p><p>A check runs right after you choose Yes, then once a day.</p>
  <h3>What stays the same</h3><ul className="plain-list"><li>Until you choose Yes, DockNest makes no requests to GitHub.</li><li>DockNest never installs an update by itself. An administrator must start it.</li><li>You can change this later in the Update Center.</li></ul>
  {error&&<AlertPanel variant="error">{error}</AlertPanel>}
  <div className="modal-foot"><button type="button" disabled={busy} onClick={()=>answer(false)}>No, keep checks off</button><button type="button" className="primary" disabled={busy} onClick={()=>answer(true)}>Yes, check daily</button></div>
 </UCDialog>;
}
export function WhatsNewDialog({data,onClose}){
 const version=vv(data.version),link=tagUrl(version);
 return <UCDialog title={'What’s new in DockNest '+version} onClose={onClose} label="dialog"><Notes markdown={data.markdown} tag={version}/><p className="notes-foot">These notes are included with this version of DockNest.</p>{link&&<p><ExtLink href={link}>Full release notes on GitHub</ExtLink></p>}<div className="modal-foot"><button type="button" className="primary" onClick={onClose}>Got it</button></div></UCDialog>;
}
export function UpdateToast({version,onNotes,onDismiss}){
 return <div className="toast-wrap"><div className="dn-toast" role="status"><IconCircleCheck size={20} aria-hidden="true"/><span className="dn-toast-text">DockNest updated to {version}</span>{onNotes&&<button type="button" onClick={onNotes}>What{'’'}s new</button>}<button type="button" className="icon" onClick={onDismiss} aria-label="Dismiss message"><IconX size={18}/></button></div></div>;
}
// "Review what will be shared": the exact allow-listed values, then GitHub in a new tab (no opener, no referrer).
export function ReportBugDialog({version,installMode,onClose}){
 const report=useMemo(()=>buildBugReport({version,installMode}),[version,installMode]);
 return <UCDialog title="Review what will be shared" onClose={onClose} label="dialog">
  <p>DockNest prepares a GitHub issue with only the version and the install mode. This issue will be public on GitHub and linked to your GitHub account. Nothing is sent until you submit it there.</p>
  <h3>Issue title</h3><p className="report-text">{report.title}</p>
  <h3>Issue text</h3><dl className="report-fields">{report.fields.map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}<div><dt>What happened</dt><dd>(Describe it here after GitHub opens.)</dd></div></dl>
  <p className="notes-foot">DockNest never adds host names, addresses, paths, user names, request IDs, site names or logs.</p>
  <div className="modal-foot"><button type="button" onClick={onClose}>Cancel</button><a className="button primary" href={report.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={()=>setTimeout(onClose,0)}><IconBrandGithub size={18} aria-hidden="true"/>Open GitHub<span className="sr-only"> (opens a new tab)</span></a></div>
 </UCDialog>;
}
// First admin sign-in: consent first, then What's new (dialog, or the toast after an in-app update).
export function UpdateGate({api}){
 const client=useMemo(()=>createUpdatesClient(api),[api]);
 const [dialog,setDialog]=useState(null),[notes,setNotes]=useState(null),[toast,setToast]=useState(null),updatedRef=useRef(null);
 async function proceed(updated){
  let data=null;try{data=await client.whatsNew()}catch{}
  const show=data?.show&&data.markdown&&data.version;
  if(updated){setToast({version:vv(updated),notes:show?data:null});return}
  if(show){setNotes(data);setDialog('notes')}
 }
 useEffect(()=>{
  let off=false,updated=null;
  try{updated=sessionStorage.getItem(UPDATED_KEY);sessionStorage.removeItem(UPDATED_KEY)}catch{}
  (async()=>{
   try{const s=await client.state();if(off)return;if(s.state==='consent-pending'||s.consent?.checkEnabled===null){setDialog('consent');return}}catch{}
   if(!off)proceed(updated);
  })();
  updatedRef.current=updated;
  return()=>{off=true};
 },[client]);
 function closeNotes(data){setDialog(null);setNotes(null);client.whatsNewSeen(data.version).catch(()=>{})}
 return <>
  {dialog==='consent'&&<ConsentDialog client={client} onClose={()=>{setDialog(null);proceed(updatedRef.current)}}/>}
  {dialog==='notes'&&notes&&<WhatsNewDialog data={notes} onClose={()=>closeNotes(notes)}/>}
  {toast&&<UpdateToast version={toast.version} onDismiss={()=>setToast(null)} onNotes={toast.notes?()=>{const data=toast.notes;setToast(null);setNotes(data);setDialog('notes')}:undefined}/>}
 </>;
}
