import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Check,X,Plus,Trash,Pencil,CheckCircle2} from '../icons.jsx';
import {AlertPanel,IconButton,StatusLabel} from '../system.jsx';
import {Sheet,Note,useGuard} from '../map/MoveFlow.jsx';
import {createSafeEditClient,TABS,TAB_KEY,ACTIVE,STATUS_LINE,friendlyError,outcomeOf,percent,runningStep,locate,setHostPort,setImage,validPort,validKey,warningView,healthText} from './safe-edit-client.js';
import {Rows,Timeline,Diff,useNarrow} from './parts.jsx';
import '../map/map.css';
import '../job-details.css';
import '../report/report.css';
import '../restore-tests/restore-tests.css';
import './site-edit.css';

const Shell=props=><div className="map-root se-root"><Sheet className="dialog-edge" labelId="safe-edit-title" {...props}/></div>;
const Foot=({a,onA,b,onB,disabled})=><>{a&&<button type="button" onClick={onA}>{a}</button>}{b&&<button type="button" className={disabled?undefined:'primary'} disabled={disabled} onClick={onB}>{b}</button>}</>;
const FROZEN='This service has host access. Change it by hand.';
const size=n=>n>=1024**3?(n/1024**3).toFixed(1)+' GB':Math.max(1,Math.round(n/1024**2))+' MB';
const envKey=(file,key)=>file+'\n'+key;

// Safe Edit for one site: Compose, Environment, Ports and Image, then Review, Apply and the timeline.
// `initialEditId` opens an existing edit (from the history list) straight on its timeline.
export function SafeEditDialog({api,site,onClose,onChanged,initialEditId}){
 const client=useMemo(()=>createSafeEditClient(api),[api]),guard=useGuard(client),narrow=useNarrow();
 const [stage,setStage]=useState(initialEditId?'progress':'loading');
 const [view,setView]=useState(null),[texts,setTexts]=useState({}),[file,setFile]=useState('');
 const [replaced,setReplaced]=useState({}),[draft,setDraft]=useState(null),[added,setAdded]=useState([]);
 const [ports,setPorts]=useState([]),[images,setImages]=useState([]),[editing,setEditing]=useState({});
 const [tab,setTab]=useState('Compose'),[problem,setProblem]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [review,setReview]=useState(null),[editId,setEditId]=useState(initialEditId||null),[edit,setEdit]=useState(null);
 const seq=useRef(0),done=useRef(false);

 const load=useCallback(()=>{
  const mine=++seq.current;
  setStage('loading');setProblem(null);setError('');
  return guard.run(async()=>{
   const v=await client.load(site.id);
   if(mine!==seq.current)return;
   const files=(v.files||[]).filter(f=>typeof f.text==='string');
   setView(v);
   setTexts(Object.fromEntries(files.map(f=>[f.path,f.text])));setFile(files[0]?.path||'');
   setReplaced({});setDraft(null);setAdded([]);setEditing({});
   const rowsP=[],rowsI=[];
   for(const s of v.services||[]){
    // The server's file and line win; the UI's own locator is the fallback.
    const own=v.kind==='compose'?locate(files,s):{image:null,ports:s.ports.map(()=>null)};
    s.ports.forEach((p,i)=>rowsP.push({service:s.name,container:p.container,host:p.host,protocol:p.protocol,hostIp:p.hostIp,frozen:s.frozen||!!p.reason,loc:p.host==null?null:v.kind==='container'?{}:(p.at||own.ports[i]),value:p.host==null?'':String(p.host),applied:p.host==null?'':String(p.host),stale:false}));
    rowsI.push({service:s.name,image:s.image,frozen:s.frozen,reason:s.imageReason,variable:s.imageVariable,loc:s.imageReason?null:v.kind==='container'?{}:(s.imageAt||own.image),value:s.image,applied:s.image,stale:false});
   }
   setPorts(rowsP);setImages(rowsI);
   setTab(v.kind==='container'?'Environment':'Compose');setStage('edit');
  },e=>{if(mine===seq.current){setError(friendlyError(e));setStage('loadfail')}});
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[client,site.id]);
 useEffect(()=>{if(!initialEditId)load()},[]);// eslint-disable-line

 // Progress follows the existing restore-test pattern: refresh every 3 s, only while the edit is active.
 const refresh=useCallback(async()=>{try{setEdit(await client.get(editId));setError('')}catch(e){setError(friendlyError(e))}},[client,editId]);
 useEffect(()=>{if(stage==='progress'&&editId)refresh()},[stage,editId,refresh]);
 const active=stage==='progress'&&(!edit||ACTIVE.has(edit.state));
 useEffect(()=>{if(!active)return;const t=setInterval(refresh,3000);return()=>clearInterval(t)},[active,refresh]);
 useEffect(()=>{if(stage==='progress'&&edit&&!ACTIVE.has(edit.state)&&!done.current){done.current=true;onChanged?.()}},[stage,edit]);// eslint-disable-line

 const isContainer=view?.kind==='container';
 const files=(view?.files||[]).filter(f=>typeof f.text==='string');
 const changedFiles=files.filter(f=>texts[f.path]!==f.text);
 const envFile=view?.env?.[0]?.file;
 const envChanges=[...Object.entries(replaced).map(([k,value])=>{const [f,key]=k.split('\n');return {file:f,key,value}}),...added.filter(a=>envFile&&validKey(a.key)&&a.value).map(a=>({file:envFile,key:a.key,value:a.value}))];
 // A single-container site has no Compose text: its ports and image travel as containerChanges.
 const containerChanges=useMemo(()=>{
  if(!isContainer)return null;
  const img=images[0],out={};
  if(img&&img.applied!==img.image)out.image=img.applied;
  if(ports.some(p=>p.applied!==(p.host==null?'':String(p.host))))out.ports=ports.filter(p=>p.host!=null||p.applied).map(p=>({host:Number(p.applied||p.host),container:p.container,protocol:p.protocol,...(p.hostIp?{hostIp:p.hostIp}:{})}));
  return Object.keys(out).length?out:null;
 },[isContainer,images,ports]);
 const dirty=changedFiles.length>0||envChanges.length>0||!!containerChanges;
 const touch=()=>{setProblem(p=>p?.kind==='blocked'?null:p)};

 async function startReview(){
  setBusy(true);setError('');
  await guard.run(async()=>{
   const r=await client.review(site.id,{...(changedFiles.length?{files:changedFiles.map(f=>({path:f.path,sha256:f.sha256,text:texts[f.path]}))}:{}),...(envChanges.length?{env:envChanges}:{}),...(containerChanges?{containerChanges}:{})});
   setReview(r);setStage('review');
  },e=>{
   if(e.status===422||e.status===409){if(!isContainer)setTab('Compose');setProblem(e.code==='FILE_CHANGED'?{kind:'conflict',text:'This file changed on the server.'}:{kind:'blocked',text:e.message||'This change cannot be applied.'})}
   else setError(friendlyError(e));
  });
  setBusy(false);
 }
 async function apply(){
  setBusy(true);setError('');
  await guard.run(async()=>{const r=await client.apply(site.id,review.token);setEdit(null);done.current=false;setEditId(r.edit.id);setStage('progress')},e=>setError(friendlyError(e)));
  setBusy(false);
 }
 async function act(fn){setBusy(true);setError('');try{await fn();await refresh()}catch(e){setError(friendlyError(e))}setBusy(false)}

 // Guided edits write the same text a person would type in Compose.
 function changePort(i,value){
  const p=ports[i];
  setPorts(list=>list.map((x,n)=>n===i?{...x,value}:x));touch();
  if(!validPort(value)||value===p.applied)return;
  if(isContainer){setPorts(list=>list.map((x,n)=>n===i?{...x,applied:value}:x));return}
  const next=setHostPort(texts[p.loc.file],p.loc.line,p.container,p.applied,value);
  if(next==null){setPorts(list=>list.map((x,n)=>n===i?{...x,stale:true}:x));return}
  setTexts(t=>({...t,[p.loc.file]:next}));setPorts(list=>list.map((x,n)=>n===i?{...x,applied:value}:x));
 }
 function changeImage(i,value){
  const m=images[i];
  setImages(list=>list.map((x,n)=>n===i?{...x,value}:x));touch();
  if(!value.trim()||value===m.applied)return;
  if(isContainer){setImages(list=>list.map((x,n)=>n===i?{...x,applied:value.trim()}:x));return}
  const next=setImage(texts[m.loc.file],m.loc.line,m.applied,value.trim());
  if(next==null){setImages(list=>list.map((x,n)=>n===i?{...x,stale:true}:x));return}
  setTexts(t=>({...t,[m.loc.file]:next}));setImages(list=>list.map((x,n)=>n===i?{...x,applied:value.trim()}:x));
 }
 const inCompose=<button type="button" className="map-link se-link" onClick={()=>setTab('Compose')}>Edit this in Compose</button>;
 const reasonOf=name=>view?.usable?.[TAB_KEY[name]]===false?view.reasons?.[TAB_KEY[name]]||{code:'UNAVAILABLE',message:'This cannot be edited here.'}:null;
 const tabNote=name=>{
  const r=reasonOf(name);
  if(!r)return null;
  const toEnv=r.code==='IMAGE_FROM_ENV',toCompose=!isContainer&&!toEnv&&view?.usable?.compose!==false&&name!=='Compose'&&name!=='Environment';
  return <AlertPanel variant="info" action={(toEnv||toCompose)&&<div className="rp-actions">{toEnv?<button type="button" onClick={()=>setTab('Environment')}>Open Environment</button>:<button type="button" onClick={()=>setTab('Compose')}>Open Compose</button>}</div>}>{r.message}</AlertPanel>;
 };

 function composeTab(){
  const f=files.find(x=>x.path===file)||files[0];
  if(!f)return tabNote('Compose')||<p className="map-caption">There is no Compose file to edit.</p>;
  return <>
   {tabNote('Compose')}
   {files.length>1&&<label className="map-field">File<select value={f.path} onChange={e=>setFile(e.target.value)}>{files.map(x=><option key={x.path} value={x.path}>{x.path}</option>)}</select></label>}
   <textarea className="mono se-code" spellCheck="false" aria-label={files.length>1?'Compose file '+f.path:'Compose file'} rows={problem?9:15} value={texts[f.path]??''} onChange={e=>{setTexts(t=>({...t,[f.path]:e.target.value}));touch()}}/>
  </>;
 }
 function envTab(){
  const saveDraft=()=>{if(!draft||!draft.value)return;setReplaced(r=>({...r,[draft.id]:draft.value}));setDraft(null);touch()};
  const rowsE=(view?.env||[]).flatMap(item=>item.keys.map(k=>({file:item.file,key:k.key,id:envKey(item.file,k.key)})));
  const rows=[...rowsE.map(({key,id})=>{
   const on=draft?.id===id;
   const input=<input type="password" aria-label={'New value for '+key} autoComplete="new-password" className="se-input" value={draft?.value||''} onChange={e=>setDraft({id,value:e.target.value})} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();saveDraft()}if(e.key==='Escape'){e.stopPropagation();setDraft(null)}}} autoFocus/>;
   const acts=on?<><IconButton label={'Save '+key} icon={Check} disabled={!draft.value} onClick={saveDraft}/><IconButton label="Cancel" icon={X} onClick={()=>setDraft(null)}/></>:<IconButton label={'Replace '+key} icon={Pencil} onClick={()=>setDraft({id,value:''})}/>;
   const text=replaced[id]!==undefined?'Replaced':'Saved';
   return {key:id,cells:[<code>{key}</code>,on?input:text,acts],label:<code>{key}</code>,value:on?<>{input}{acts}</>:<>{text}{acts}</>,wrap:on};
  }),...added.map(a=>{
   const bad=a.key!==''&&!validKey(a.key);
   const k=<input className="se-input" aria-label="Variable name" aria-invalid={bad||undefined} autoComplete="off" spellCheck="false" value={a.key} onChange={e=>{setAdded(l=>l.map(x=>x.id===a.id?{...x,key:e.target.value}:x));touch()}}/>;
   const v=<input type="password" className="se-input" aria-label={'Value for '+(a.key||'new variable')} autoComplete="new-password" value={a.value} onChange={e=>{setAdded(l=>l.map(x=>x.id===a.id?{...x,value:e.target.value}:x));touch()}}/>;
   const rm=<IconButton label={'Remove '+(a.key||'new variable')} icon={Trash} onClick={()=>setAdded(l=>l.filter(x=>x.id!==a.id))}/>;
   return {key:'new'+a.id,cells:[k,v,rm],label:k,value:<>{v}{rm}</>,wrap:true};
  })];
  return <>
   {tabNote('Environment')}
   <p className="map-caption">Values are never shown again.</p>
   {rows.length>0&&<Rows narrow={narrow} headers={['Key','Value','']} columns={[null,null,'112px']} numeric={[2]} rows={rows}/>}
   {envFile&&<div><button type="button" onClick={()=>setAdded(l=>[...l,{id:Date.now()+l.length,key:'',value:''}])}><Plus size={18} stroke={1.75} aria-hidden="true"/>Add variable</button></div>}
  </>;
 }
 function portsTab(){
  const tabOn=view?.usable?.ports!==false;
  const rows=ports.map((p,i)=>{
   const id=p.service+':'+p.container+':'+i,can=tabOn&&!p.frozen&&p.loc&&!p.stale;
   const on=editing[id];
   const input=<input type="number" className="se-input se-port" inputMode="numeric" autoFocus aria-label={`Host port for ${p.service} ${p.container}`} aria-invalid={(p.value!==''&&!validPort(p.value))||undefined} value={p.value} onChange={e=>changePort(i,e.target.value)}/>;
   const pencil=can&&<IconButton label={`Edit host port for ${p.service} ${p.container}`} icon={Pencil} onClick={()=>setEditing(m=>({...m,[id]:true}))}/>;
   const cell=p.host==null?'Not published':on?input:<>{p.applied}{pencil}</>;
   return {key:id,cells:[<code>{p.service}</code>,String(p.container),<span className="se-cell">{cell}</span>],label:<><code>{p.service}</code> {p.container}</>,value:cell};
  });
  const stuck=ports.some(p=>p.host!=null&&!p.loc&&!isContainer||p.stale);
  return <>
   {tabNote('Ports')}
   {rows.length>0?<Rows narrow={narrow} headers={['Service','Container port','Host port']} columns={[null,'150px','170px']} numeric={[1,2]} rows={rows}/>:<p className="map-caption">This site publishes no ports.</p>}
   {stuck&&view?.usable?.ports!==false&&<p className="map-caption">Some ports are set in a way that needs the file. {inCompose}</p>}
  </>;
 }
 function imageTab(){
  const tabOn=view?.usable?.image!==false;
  return <>
   {tabNote('Image')}
   {images.map((m,i)=>{
    const can=tabOn&&!m.frozen&&m.loc&&!m.stale;
    return can?<label key={m.service} className="map-field">{m.service}<input className="se-input" spellCheck="false" autoComplete="off" value={m.value} onChange={e=>changeImage(i,e.target.value)}/></label>
     :<div key={m.service} className="map-field"><span>{m.service}</span><code className="se-ell">{m.image}</code><span className="map-caption">{m.frozen?FROZEN:m.variable?`Edit ${m.variable} in Environment.`:!tabOn?'':'This image is set in a way that needs the file.'} {!tabOn||m.frozen||isContainer?null:m.variable?<button type="button" className="map-link se-link" onClick={()=>setTab('Environment')}>Open Environment</button>:inCompose}</span></div>;
   })}
  </>;
 }
 const tabBody={Compose:composeTab,Environment:envTab,Ports:portsTab,Image:imageTab};
 const tabs=isContainer?TABS.filter(t=>t!=='Compose'):TABS;
 const tabBar=<div className="map-tabs" role="tablist" aria-label="Edit sections">{tabs.map(n=><button key={n} type="button" role="tab" aria-selected={n===tab} className={n===tab?'on':''} onClick={()=>setTab(n)}>{n}</button>)}</div>;
 const title='Edit '+site.name;

 if(stage==='loading')return <Shell onClose={onClose} title={title} actions={<Foot a="Cancel" onA={onClose} b="Review" disabled/>}>{tabBar}{guard.prompt||<div className="inc-load" role="status" aria-live="polite"><StatusLabel state="running">Reading files</StatusLabel></div>}</Shell>;
 if(stage==='loadfail')return <Shell onClose={onClose} title={title} actions={<Foot a="Cancel" onA={onClose} b="Review" disabled/>}><AlertPanel variant="error" action={<div className="rp-actions"><button type="button" onClick={load}>Try again</button></div>}>{error||'Could not read the files.'}</AlertPanel></Shell>;
 if(stage==='edit')return <Shell onClose={onClose} title={title} actions={<Foot a="Cancel" onA={onClose} b="Review" onB={startReview} disabled={!dirty||!!problem||busy}/>}>
  {tabBar}
  {problem?.kind==='blocked'&&<AlertPanel variant="error">{problem.text}</AlertPanel>}
  {problem?.kind==='conflict'&&<AlertPanel variant="error" action={<div className="rp-actions"><button type="button" onClick={load}>Reload</button></div>}>{problem.text}</AlertPanel>}
  {tabBody[tab]()}
  {error&&<Note kind="error" icon={X} role="alert">{error}</Note>}
  {guard.prompt}
 </Shell>;
 if(stage==='review'&&review){
  const s=review.summary||{};
  return <Shell onClose={onClose} title="Review changes" actions={<Foot a="Back" onA={()=>setStage('edit')} b="Apply" onB={apply} disabled={busy}/>}>
   <Diff diff={review.diff}/>
   {(review.warnings||[]).map((w,i)=>{const v=warningView(w);return <AlertPanel key={w.code+i} variant="warning" title={v.title}>{v.text}</AlertPanel>})}
   <dl className="def-list se-defs">
    <div className="def-row"><dt>Backup first</dt><dd>Yes</dd></div>
    <div className="def-row"><dt>Health check</dt><dd>{healthText(s.health)}</dd></div>
    <div className="def-row"><dt>Rollback</dt><dd>Automatic</dd></div>
    <div className="def-row"><dt>Data rollback</dt><dd>{s.dataRollback?(s.dataBytes!=null?'Yes, '+size(s.dataBytes):'Yes'):'No'}</dd></div>
   </dl>
   {error&&<Note kind="error" icon={X} role="alert">{error}</Note>}
   {guard.prompt}
  </Shell>;
 }
 // Progress and outcome.
 const outcome=outcomeOf(edit),stepNow=runningStep(edit),acts=edit?.actions||{};
 const again=()=>{done.current=false;setEdit(null);setEditId(null);setReview(null);load()};
 const fail=error&&<Note kind="error" icon={X} role="alert">{error}</Note>;
 if(!edit)return <Shell onClose={onClose} title="Applying changes" actions={<Foot a="Close" onA={onClose}/>}>{fail||<div className="inc-load" role="status"><StatusLabel state="running">Reading status</StatusLabel></div>}</Shell>;
 if(outcome==='applying')return <Shell onClose={onClose} title="Applying changes" actions={<>{acts.cancel&&<button type="button" disabled={busy} onClick={()=>act(()=>client.cancel(edit.id))}>Cancel</button>}<button type="button" onClick={onClose}>Close</button></>}>
  <div className="map-bar" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent(edit)}><span style={{width:percent(edit)+'%'}}/></div>
  <p className="map-status" role="status">{STATUS_LINE[stepNow]||STATUS_LINE.apply}</p>
  <Timeline edit={edit}/>
  <p className="map-caption">You can leave this page.</p>
  {fail}
 </Shell>;
 if(outcome==='done')return <Shell onClose={onClose} title={site.name} actions={<Foot b="Close" onB={onClose}/>}><Note kind="ok" icon={CheckCircle2} role="status">Change applied</Note><Timeline edit={edit}/></Shell>;
 if(outcome==='attention')return <Shell onClose={onClose} title="Needs your attention" actions={<Foot a="Close" onA={onClose}/>}>
  <AlertPanel variant="error" action={(acts.retry||acts.restoreBackup)&&<div className="rp-actions">{acts.retry&&<button type="button" className="primary" disabled={busy} onClick={()=>act(()=>client.retryRollback(edit.id))}>Try again</button>}{acts.restoreBackup&&<button type="button" disabled={busy} onClick={()=>act(()=>client.restoreBackup(edit.id))}>Restore backup</button>}</div>}>{edit.reason||'Rollback failed. The maintenance page is on.'}{edit.dataCopyNote&&<small className="se-note">{edit.dataCopyNote}</small>}</AlertPanel>
  {edit.restore&&<AlertPanel variant="info">{edit.restore.running?'Restoring the backup. Follow it in Jobs.':'The restore was started. Follow it in Jobs.'}</AlertPanel>}
  <Timeline edit={edit}/>{fail}
 </Shell>;
 const words={rolled:['Rolled back','The change did not work. The previous version runs again.'],failed:['Change stopped','Nothing was changed.'],cancelled:['Cancelled','Nothing was changed.']}[outcome]||['Change stopped','Nothing was changed.'];
 return <Shell onClose={onClose} title={words[0]} actions={<Foot a="Close" onA={onClose} b="Edit again" onB={again}/>}><AlertPanel variant="error">{edit.reason||words[1]}</AlertPanel><Timeline edit={edit}/></Shell>;
}
