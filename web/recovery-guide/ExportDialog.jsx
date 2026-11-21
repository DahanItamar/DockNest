import React,{useEffect,useRef,useState} from 'react';
import {IconX} from '@tabler/icons-react';
import {StatusLabel,AlertPanel} from '../system.jsx';
import {createPdf,saveBlob,reauth,PDF_FAILED} from './client.js';

// "Download Recovery Guide": choose the apps and what goes in, then the server makes the PDF. Login details need the
// administrator's fresh sign-in check, which is asked for here; they are never part of the copy next to the kit.
const OPTIONS=[
 ['addresses','Server addresses','Where your servers and storage are. Off, the commands show placeholders.'],
 ['logins','Login details','Administrators only. You will be asked to sign in again.'],
 ['commands','Include commands','The exact commands for each step, for someone who knows Linux.'],
 ['tests','Restore test history',null],
 ['schedules','Schedules',null],
 ['notes','Your notes',null]
];
export function ExportDialog({api,apps,only,onClose,onMade}){
 const ref=useRef(null),ids=apps.map(a=>a.id);
 const [sel,setSel]=useState(only&&ids.includes(only)?[only]:ids),[inc,setInc]=useState({addresses:false,logins:false,commands:true,tests:true,schedules:true,notes:true});
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[need,setNeed]=useState(false),[password,setPassword]=useState(''),[code,setCode]=useState(''),[checking,setChecking]=useState(false),[checkError,setCheckError]=useState('');
 useEffect(()=>{const d=ref.current;try{d.showModal()}catch{d.setAttribute('open','')}d.querySelector('h2')?.focus();return()=>{try{d.close()}catch{}}},[]);
 // The warning, the sign-in check and errors sit low in a scrolling body: bring the newest one into view.
 useEffect(()=>{const all=ref.current?.querySelectorAll('[data-reveal]');all?.[all.length-1]?.scrollIntoView?.({block:'nearest'})},[inc.logins,need,error]);
 const toggle=key=>{setInc(v=>({...v,[key]:!v[key]}));if(key==='logins')setNeed(false)};
 async function make(){
  setBusy(true);setError('');
  try{
   const blob=await createPdf({apps:sel,include:inc});
   saveBlob(blob);onMade?.();onClose();
  }catch(e){
   if(e.code==='REAUTH_REQUIRED'){setNeed(true);setBusy(false);return}
   setError(e.status===400||e.status===413||e.status===403?e.message:PDF_FAILED);setBusy(false);
  }
 }
 async function verify(){
  setChecking(true);setCheckError('');
  try{await reauth(api,password,code.trim());setNeed(false);setPassword('');setCode('');setChecking(false);await make()}
  catch(e){setCheckError(e.status===401?'That password or code was not right. Try again.':e.message||'The check did not work. Try again.');setChecking(false)}
 }
 const locked=busy||checking;
 return <dialog ref={ref} className="rp-dialog rg-dialog" aria-labelledby="rg-export-title" onCancel={e=>{e.preventDefault();if(!locked)onClose()}}>
  <div className="rp-grabber" aria-hidden="true"/>
  <header className="rp-head"><div className="rp-head-row"><div className="rp-head-text"><h2 id="rg-export-title" tabIndex={-1}>Download Recovery Guide</h2><p>Choose what goes into the PDF.</p></div><button type="button" className="icon-button rp-close" aria-label="Close" title="Close" disabled={locked} onClick={onClose}><IconX size={20} stroke={1.75} aria-hidden="true"/></button></div></header>
  <form className="rg-form-wrap" onSubmit={e=>{e.preventDefault();if(!locked&&!need&&sel.length)make()}}>
   <div className="rg-body">
    <fieldset disabled={locked} className="rg-form">
     <section className="rg-stack"><div className="rg-group-head"><h3>Apps</h3><span className="rg-links"><button type="button" className="link-action" onClick={()=>setSel(ids)}>Select all</button><button type="button" className="link-action" onClick={()=>setSel([])}>Select none</button></span></div>
      <div className="rg-checks">{apps.map(a=><label className="check" key={a.id}><input type="checkbox" checked={sel.includes(a.id)} onChange={()=>setSel(v=>v.includes(a.id)?v.filter(x=>x!==a.id):[...v,a.id])}/> {a.name}</label>)}</div>
      {!sel.length&&<p className="t-caption" role="status">Choose at least one app.</p>}</section>
     <section className="rg-stack"><h3>Include</h3>
      {OPTIONS.map(([key,label,caption])=><label className="rp-check" key={key}><input type="checkbox" checked={inc[key]} onChange={()=>toggle(key)}/><span><span className="rp-check-title">{label}</span>{caption&&<span className="t-caption">{caption}</span>}</span></label>)}</section>
     {inc.logins&&<div data-reveal><AlertPanel variant="warning">This PDF will hold logins to your backup storage. Anyone with the file can reach your backups. Keep it like a password. Creating it is recorded in the audit log.</AlertPanel></div>}
    </fieldset>
    {need&&<div data-reveal className="rg-reauth" role="group" aria-labelledby="rg-reauth-title"><b id="rg-reauth-title">Please confirm it is you</b><p>Login details need a fresh check. Enter the shared password and a fresh code from your authenticator.</p>
     <label className="rg-field">Password<input type="password" name="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} aria-invalid={!!checkError||undefined} disabled={checking}/></label>
     <label className="rg-field">Authenticator code<input name="code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e=>setCode(e.target.value)} aria-invalid={!!checkError||undefined} disabled={checking}/></label>
     {checkError&&<AlertPanel variant="error">{checkError}</AlertPanel>}
     <div className="rg-reauth-actions"><button type="button" disabled={checking} onClick={()=>setNeed(false)}>Not now</button><button type="button" className="primary" disabled={checking||!password||code.trim().length<6} onClick={verify}>Verify and create PDF</button></div></div>}
    {error&&<div data-reveal><AlertPanel variant="error">{error}</AlertPanel></div>}
   </div>
   <div className="rg-foot">{busy&&<span className="rg-spacer"><StatusLabel state="running">Creating the PDF…</StatusLabel></span>}<button type="button" onClick={onClose} disabled={locked}>Cancel</button><button type="submit" className="primary" aria-disabled={busy||!sel.length||need||undefined} disabled={checking}>{busy?'Creating PDF…':'Create PDF'}</button></div>
  </form>
 </dialog>;
}
