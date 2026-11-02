import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Check,X,Plus,Trash,Pencil,CheckCircle2} from '../icons.jsx';
import {AlertPanel,IconButton} from '../system.jsx';
import {Sheet,Note,useGuard} from '../map/MoveFlow.jsx';
import {createSafeEditClient,TABS,ACTIVE,STATUS_LINE,friendlyError,outcomeOf,percent,runningStep,setHostPort,setImage,validPort,validKey} from './safe-edit-client.js';
import {Rows,Timeline,Diff,useNarrow} from './parts.jsx';
import '../map/map.css';
import '../job-details.css';
import '../report/report.css';
import '../restore-tests/restore-tests.css';
import './site-edit.css';

const TAB_KEY={Compose:'compose',Environment:'environment',Ports:'ports',Image:'image'};
const Shell=props=><div className="map-root se-root"><Sheet className="dialog-edge" labelId="safe-edit-title" {...props}/></div>;
const Foot=({a,onA,b,onB,disabled})=><>{a&&<button type="button" onClick={onA}>{a}</button>}{b&&<button type="button" className={disabled?undefined:'primary'} disabled={disabled} onClick={onB}>{b}</button>}</>;

// Safe Edit for one site: Compose, Environment, Ports and Image, then Review, Apply and the timeline.
// `initialEditId` opens an existing edit (from the history list) straight on its timeline.
export function SafeEditDialog({api,site,onClose,onChanged,onRestoreBackup,initialEditId}){
 const client=useMemo(()=>createSafeEditClient(api),[api]),guard=useGuard(client),narrow=useNarrow();
 const [stage,setStage]=useState(initialEditId?'progress':'loading');
 const [view,setView]=useState(null),[texts,setTexts]=useState({}),[file,setFile]=useState('');
 const [replaced,setReplaced]=useState({}),[draft,setDraft]=useState(null),[added,setAdded]=useState([]);
 const [ports,setPorts]=useState([]),[images,setImages]=useState([]);
 const [tab,setTab]=useState('Compose'),[problem,setProblem]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [review,setReview]=useState(null),[editId,setEditId]=useState(initialEditId||null),[edit,setEdit]=useState(null);
 const seq=useRef(0),done=useRef(false);

 const load=useCallback(()=>{
  const mine=++seq.current;
  setStage('loading');setProblem(null);setError('');
  return guard.run(async()=>{
   const v=await client.load(site.id);
   if(mine!==seq.current)return;
   setView(v);
   setTexts(Object.fromEntries((v.files||[]).map(f=>[f.path,f.text])));setFile(v.files?.[0]?.path||'');
   setReplaced({});setDraft(null);setAdded([]);
   setPorts((v.ports||[]).map(p=>({value:p.host==null?'':String(p.host),applied:p.host==null?'':String(p.host),stale:false})));
   setImages((v.images||[]).map(i=>({value:i.image,applied:i.image,stale:false})));
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

 const files=view?.files||[];
 const changedFiles=files.filter(f=>texts[f.path]!==f.text);
 const envFile=view?.envFile||files[0]?.path;
 const envChanges=[...Object.entries(replaced).map(([key,value])=>({file:envFile,key,value})),...added.filter(a=>validKey(a.key)&&a.value).map(a=>({file:envFile,key:a.key,value:a.value}))];
 const dirty=changedFiles.length>0||envChanges.length>0;
 const touch=()=>{setProblem(p=>p?.kind==='blocked'?null:p)};

 async function startReview(){
  setBusy(true);setError('');
  await guard.run(async()=>{
   const r=await client.review(site.id,{...(changedFiles.length?{files:changedFiles.map(f=>({path:f.path,sha256:f.sha256,text:texts[f.path]}))}:{}),...(envChanges.length?{env:envChanges}:{})});
   setReview(r);setStage('review');
  },e=>{
   if(e.status===422||e.status===409){setTab(t=>t==='Environment'&&e.code!=='FILE_CHANGED'?t:'Compose');setProblem(e.code==='FILE_CHANGED'?{kind:'conflict',text:'This file changed on the server.'}:{kind:'blocked',text:e.message||'This change cannot be applied.'})}
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
  const p=view.ports[i],cur=ports[i];
  setPorts(list=>list.map((x,n)=>n===i?{...x,value}:x));touch();
  if(!validPort(value)||value===cur.applied)return;
  const next=setHostPort(texts[p.file],p.line,p.container,cur.applied,value);
  if(next==null){setPorts(list=>list.map((x,n)=>n===i?{...x,stale:true}:x));return}
  setTexts(t=>({...t,[p.file]:next}));setPorts(list=>list.map((x,n)=>n===i?{...x,applied:value}:x));
 }
 function changeImage(i,value){
  const m=view.images[i],cur=images[i];
  setImages(list=>list.map((x,n)=>n===i?{...x,value}:x));touch();
  if(!value.trim()||value===cur.applied)return;
  const next=setImage(texts[m.file],m.line,cur.applied,value.trim());
  if(next==null){setImages(list=>list.map((x,n)=>n===i?{...x,stale:true}:x));return}
  setTexts(t=>({...t,[m.file]:next}));setImages(list=>list.map((x,n)=>n===i?{...x,applied:value.trim()}:x));
 }
 const inCompose=<button type="button" className="map-link se-link" onClick={()=>setTab('Compose')}>Edit this in Compose</button>;
 const tabNote=name=>{const t=view?.tabs?.[TAB_KEY[name]];return t&&t.usable===false?<AlertPanel variant="info">{t.reason||'This cannot be edited here.'}</AlertPanel>:null};

 function composeTab(){
  const f=files.find(x=>x.path===file)||files[0];
  if(!f)return tabNote('Compose');
  return <>
   {files.length>1&&<label className="map-field">File<select value={f.path} onChange={e=>setFile(e.target.value)}>{files.map(x=><option key={x.path} value={x.path}>{x.path}</option>)}</select></label>}
   <textarea className="mono se-code" spellCheck="false" aria-label={files.length>1?'Compose file '+f.path:'Compose file'} rows={problem?9:15} value={texts[f.path]??''} onChange={e=>{setTexts(t=>({...t,[f.path]:e.target.value}));touch()}}/>
  </>;
 }
 function envTab(){
  const keys=(view?.env||[]).map(e=>e.key);
  const saveDraft=()=>{if(!draft||!draft.value)return;setReplaced(r=>({...r,[draft.key]:draft.value}));setDraft(null);touch()};
  const rows=[...keys.map(key=>{
   const editing=draft?.key===key;
   const input=<input type="password" aria-label={'New value for '+key} autoComplete="new-password" className="se-input" value={draft?.value||''} onChange={e=>setDraft({key,value:e.target.value})} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();saveDraft()}if(e.key==='Escape'){e.stopPropagation();setDraft(null)}}} autoFocus/>;
   const acts=editing?<><IconButton label={'Save '+key} icon={Check} disabled={!draft.value} onClick={saveDraft}/><IconButton label="Cancel" icon={X} onClick={()=>setDraft(null)}/></>:<IconButton label={'Replace '+key} icon={Pencil} onClick={()=>setDraft({key,value:''})}/>;
   const text=replaced[key]!==undefined?'Replaced':'Saved';
   return {key,cells:[<code>{key}</code>,editing?input:text,acts],label:<code>{key}</code>,value:editing?<>{input}{acts}</>:<>{text}{acts}</>,wrap:editing};
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
   <div><button type="button" onClick={()=>setAdded(l=>[...l,{id:Date.now()+l.length,key:'',value:''}])}><Plus size={18} stroke={1.75} aria-hidden="true"/>Add variable</button></div>
  </>;
 }
 function portsTab(){
  const list=view?.ports||[];
  const rows=list.map((p,i)=>{
   const st=ports[i]||{},can=p.editable!==false&&p.host!=null&&!st.stale;
   const cell=p.host==null?'Not published':can?<input type="number" className="se-input se-port" inputMode="numeric" aria-label={`Host port for ${p.service} ${p.container}`} aria-invalid={(st.value!==''&&!validPort(st.value))||undefined} value={st.value} onChange={e=>changePort(i,e.target.value)}/>:String(p.host);
   return {key:p.service+':'+p.container+':'+i,cells:[<code>{p.service}</code>,String(p.container),cell],label:<><code>{p.service}</code> {p.container}</>,value:cell};
  });
  const stuck=list.some((p,i)=>p.host!=null&&(p.editable===false||ports[i]?.stale));
  return <>
   {tabNote('Ports')}
   {rows.length>0?<Rows narrow={narrow} headers={['Service','Container port','Host port']} columns={[null,'150px','150px']} numeric={[1,2]} rows={rows}/>:<p className="map-caption">This site publishes no ports.</p>}
   {stuck&&<p className="map-caption">Some ports are set in a way that needs the file. {inCompose}</p>}
  </>;
 }
 function imageTab(){
  const list=view?.images||[];
  return <>
   {tabNote('Image')}
   {list.map((m,i)=>{
    const st=images[i]||{},can=m.editable!==false&&!st.stale;
    return can?<label key={m.service+i} className="map-field">{m.service}<input className="se-input" spellCheck="false" autoComplete="off" value={st.value} onChange={e=>changeImage(i,e.target.value)}/></label>
     :<div key={m.service+i} className="map-field"><span>{m.service}</span><code className="se-ell">{m.image}</code><span className="map-caption">{m.reason||'This image is set in a way that needs the file.'} {inCompose}</span></div>;
   })}
  </>;
 }
 const tabBody={Compose:composeTab,Environment:envTab,Ports:portsTab,Image:imageTab};
 const tabs=view?.kind==='container'?TABS.filter(t=>t!=='Compose'):TABS;
 const tabBar=<div className="map-tabs" role="tablist" aria-label="Edit sections">{tabs.map(n=><button key={n} type="button" role="tab" aria-selected={n===tab} className={n===tab?'on':''} onClick={()=>setTab(n)}>{n}</button>)}</div>;
 const title='Edit '+site.name;

 if(stage==='loading')return <Shell onClose={onClose} title={title} actions={<Foot a="Cancel" onA={onClose} b="Review" disabled/>}>{tabBar}{guard.prompt||<div className="inc-load" role="status" aria-live="polite"><span className="status status-running">Reading files</span></div>}</Shell>;
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
   {(review.warnings||[]).map((w,i)=><AlertPanel key={w.code||i} variant="warning" title={w.title}>{w.text}</AlertPanel>)}
   <dl className="def-list se-defs">
    <div className="def-row"><dt>Backup first</dt><dd>{s.backupFirst===false?'No':'Yes'}</dd></div>
    <div className="def-row"><dt>Health check</dt><dd className="se-grow">{s.healthUrl?<span className="se-ell"><code>{s.healthUrl}</code></span>:'Running and stable'}</dd></div>
    <div className="def-row"><dt>Rollback</dt><dd>{s.rollback||'Automatic'}</dd></div>
    <div className="def-row"><dt>Data rollback</dt><dd>{s.dataRollback?'Yes':'No'}</dd></div>
   </dl>
   {error&&<Note kind="error" icon={X} role="alert">{error}</Note>}
   {guard.prompt}
  </Shell>;
 }
 // Progress and outcome.
 const outcome=outcomeOf(edit),stepNow=runningStep(edit);
 const again=()=>{done.current=false;setEdit(null);setEditId(null);setReview(null);load()};
 const applyStep=edit?.steps?.find(s=>s.step==='apply'),cancellable=outcome==='applying'&&edit?.state!=='rolling_back'&&(!applyStep||applyStep.state==='pending');
 const fail=error&&<Note kind="error" icon={X} role="alert">{error}</Note>;
 if(!edit)return <Shell onClose={onClose} title="Applying changes" actions={<Foot a="Close" onA={onClose}/>}>{fail||<div className="inc-load" role="status"><span className="status status-running">Reading status</span></div>}</Shell>;
 if(outcome==='applying')return <Shell onClose={onClose} title="Applying changes" actions={<>{cancellable&&<button type="button" disabled={busy} onClick={()=>act(()=>client.cancel(edit.id))}>Cancel</button>}<button type="button" onClick={onClose}>Close</button></>}>
  <div className="map-bar" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent(edit)}><span style={{width:percent(edit)+'%'}}/></div>
  <p className="map-status" role="status">{STATUS_LINE[stepNow]||STATUS_LINE.apply}</p>
  <Timeline edit={edit}/>
  <p className="map-caption">You can leave this page.</p>
  {fail}
 </Shell>;
 if(outcome==='done')return <Shell onClose={onClose} title={site.name} actions={<Foot b="Close" onB={onClose}/>}><Note kind="ok" icon={CheckCircle2} role="status">Change applied</Note><Timeline edit={edit}/></Shell>;
 if(outcome==='attention')return <Shell onClose={onClose} title="Needs your attention" actions={<Foot a="Close" onA={onClose}/>}>
  <AlertPanel variant="error" action={<div className="rp-actions"><button type="button" className="primary" disabled={busy} onClick={()=>act(()=>client.retryRollback(edit.id))}>Try again</button>{onRestoreBackup&&edit.backupId&&<button type="button" onClick={()=>onRestoreBackup(edit.backupId)}>Restore backup</button>}</div>}>{edit.reason||'Rollback failed. The maintenance page is on.'}</AlertPanel>
  <Timeline edit={edit}/>{fail}
 </Shell>;
 const words={rolled:['Rolled back','The change did not work. The previous version runs again.'],failed:['Change stopped','Nothing was changed.'],cancelled:['Cancelled','Nothing was changed.']}[outcome]||['Change stopped','Nothing was changed.'];
 return <Shell onClose={onClose} title={words[0]} actions={<Foot a="Close" onA={onClose} b="Edit again" onB={again}/>}><AlertPanel variant="error">{edit.reason||words[1]}</AlertPanel><Timeline edit={edit}/></Shell>;
}
