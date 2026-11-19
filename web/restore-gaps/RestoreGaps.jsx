import React,{useState} from 'react';
import {IconClockHour4,IconNetwork,IconDatabase,IconFolders,IconKey,IconFileText,IconCertificate,IconEyeOff,IconNotes,IconArrowBackUp} from '@tabler/icons-react';
import {AlertPanel,OverflowMenu,StatusLabel} from '../system.jsx';
import {count} from '../plural.js';
import './restore-gaps.css';

// "Restore on a new server": the read-only scan that comes with Check readiness (docs/restore-check.md).
// gaps is the readiness answer's restoreGaps: {findings, complete, limits} or {error}; absent from an older helper.
// A finding names a file, line and what matched. It never carries a command or line text, which can hold tokens.
const KINDS={
 'host-schedule':{Icon:IconClockHour4,title:f=>'Scheduled task'+(f.schedule?' ('+f.schedule+')':'')},
 'external-network':{Icon:IconNetwork,title:f=>'Docker network '+f.path},
 'external-volume':{Icon:IconDatabase,title:f=>'Docker volume '+f.path},
 'bind-outside':{Icon:IconFolders,title:()=>'Folder outside the app folder'},
 'secret-or-config':{Icon:IconKey,title:()=>'Secret or config outside the app folder'},
 'env-file':{Icon:IconFileText,title:()=>'Environment file outside the app folder'},
 certificate:{Icon:IconCertificate,title:()=>'Certificate'}
};
const NOTE_MAX=500,ADMIN_ONLY='An administrator can add this';
const kindOf=f=>KINDS[f.kind]||{Icon:IconFileText,title:()=>'Something outside the app folder'};
const named=f=>f.kind==='external-network'||f.kind==='external-volume';
const where=f=>(named(f)?'':f.path||'')+(f.line?':'+f.line:'');

function NoteEditor({initial,busy,onSave,onCancel,label}){
 const [text,setText]=useState(initial);
 return <form className="rg-note-edit" onSubmit={e=>{e.preventDefault();onSave(text.trim())}}>
  <label className="field"><span>Note for {label}</span><textarea rows={3} maxLength={NOTE_MAX} value={text} onChange={e=>setText(e.target.value)} autoFocus/><small>Kept with this app. It does not change the backup. {text.length}/{NOTE_MAX}</small></label>
  <div className="rg-links"><button type="submit" className="rg-link" disabled={busy||!text.trim()}>Save note</button><button type="button" className="rg-link rg-link-quiet" onClick={onCancel}>Cancel</button></div>
 </form>;
}

function Finding({f,isAdmin,busy,editing,onInclude,onDecide,onEdit,onCancel}){
 const {Icon,title}=kindOf(f),answered=f.included?null:f.decision,label=title(f);
 const menu=[];
 if(answered)menu.push({label:'Undo',icon:IconArrowBackUp,onSelect:()=>onDecide(f,null)});
 if(!f.included&&!answered)menu.push({label:'Ignore',icon:IconEyeOff,onSelect:()=>onDecide(f,{decision:'ignore'})});
 if(!f.included&&answered!=='ignore')menu.push({label:answered==='note'?'Edit note':'Note',icon:IconNotes,onSelect:()=>onEdit(f.key)});
 const canInclude=f.includable&&!f.included&&!answered;
 return <li className={'rg-item'+(answered?' decided':'')+(canInclude?' has-link':'')}>
  <span className="rg-icon"><Icon size={24} stroke={1.5} aria-hidden="true"/></span>
  <div className="rg-body">
   <div className="rg-head">
    <b>{label}</b>
    {f.included&&<StatusLabel state="success">Saved in backups</StatusLabel>}
    {answered==='ignore'&&<span className="status status-queued"><IconEyeOff className="status-icon" size={16} stroke={2} aria-hidden="true"/>Ignored</span>}
    {answered==='note'&&<span className="status status-queued"><IconNotes className="status-icon" size={16} stroke={2} aria-hidden="true"/>Noted</span>}
   </div>
   {f.message&&<p>{f.message}</p>}
   {where(f)&&<code className="rg-path">{where(f)}</code>}
   {answered==='note'&&f.note&&!editing&&<p className="rg-note"><IconNotes size={16} stroke={1.75} aria-hidden="true"/>{f.note}</p>}
   {editing&&<NoteEditor initial={f.note||''} busy={busy} label={label} onSave={text=>onDecide(f,{decision:'note',note:text})} onCancel={onCancel}/>}
   {canInclude&&!editing&&<p className="rg-hint t-caption" id={'rg-hint-'+f.key}>{isAdmin?'Saves a copy in the backup. The restore guide says where to put it back by hand.':ADMIN_ONLY+'. It saves a copy in the backup.'}</p>}
  </div>
  {!editing&&<div className="rg-actions">
   {canInclude&&<button type="button" className="rg-link" disabled={busy||!isAdmin} aria-describedby={'rg-hint-'+f.key} onClick={()=>onInclude(f)}>Save a copy in backups</button>}
   {menu.length>0&&<OverflowMenu label={'More actions for '+label} items={menu} disabled={busy}/>}
  </div>}
 </li>;
}

export function RestoreGaps({gaps,isAdmin,api,siteId,onSessionExpired,onIncluded}){
 const [findings,setFindings]=useState(gaps?.findings||[]),[editing,setEditing]=useState(''),[busy,setBusy]=useState(false),[problem,setProblem]=useState('');
 if(!gaps)return null;
 const patch=(match,change)=>setFindings(list=>list.map(f=>match(f)?{...f,...change}:f));
 const fail=e=>{if(e.status===401){onSessionExpired?.();return;}setProblem(e.code==='ADMIN_REQUIRED'?ADMIN_ONLY+'.':e.message)};
 const run=async work=>{setBusy(true);setProblem('');try{await work();}catch(e){fail(e);}finally{setBusy(false);}};
 const decide=(f,answer)=>run(async()=>{
  const url='/sites/'+siteId+'/restore-decisions/'+f.key;
  if(answer)await api(url,answer,'PUT');else await api(url,null,'DELETE');
  patch(x=>x.key===f.key,{decision:answer?.decision||null,note:answer?.note||null});setEditing('');
 });
 const include=f=>run(async()=>{
  // Add to the app's configuration files through the normal app update, from the saved copy so nothing is lost.
  const site=await api('/sites/'+siteId),config=typeof site.config==='string'?JSON.parse(site.config):site.config;
  const files=[...new Set([...(config.configFiles||[]),...f.includePaths])];
  await api('/sites/'+siteId,{serverId:site.serverId||site.server_id,name:site.name,config:{...config,configFiles:files}},'PATCH');
  patch(x=>x.includePaths?.length&&x.includePaths.every(p=>files.includes(p)),{included:true});onIncluded?.();
 });
 const open=findings.filter(f=>!f.included&&!f.decision),rest=findings.length-open.length;
 return <section className="rg" aria-labelledby="rg-title">
  <h3 id="rg-title">Restore on a new server</h3>
  {gaps.error?<AlertPanel variant="error" title="Could not check the rest of the server">{gaps.error} The checks above are still valid.</AlertPanel>:<>
   <p className="rg-lede">What a new server would not have unless you add it. This check only reads: nothing changes unless you choose a copy.</p>
   {gaps.complete===false&&<StatusLabel state="needs-review">{findings.length?'The scan stopped early; there may be more':'Nothing found so far, but the scan stopped early'}</StatusLabel>}
   {!findings.length?(gaps.complete===false?null:<StatusLabel state="success">Nothing outside the app folder that a new server would miss</StatusLabel>):<>
    <p className="rg-count t-caption" role="status">{open.length?count(open.length,'thing')+' to review':'All reviewed'}{rest&&open.length?', '+rest+' answered':''}</p>
    <ul className="rg-list">{[...open,...findings.filter(f=>f.included||f.decision)].map(f=><Finding key={f.key} f={f} isAdmin={isAdmin} busy={busy} editing={editing===f.key} onInclude={include} onDecide={decide} onEdit={setEditing} onCancel={()=>setEditing('')}/>)}</ul>
   </>}
   {problem&&<AlertPanel variant="error">{problem}</AlertPanel>}
  </>}
 </section>;
}
