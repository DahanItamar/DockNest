import React,{useEffect,useMemo,useRef,useState} from 'react';
import {IconCheck,IconLoader2,IconClock,IconCopy,IconCircleX,IconCircleCheck,IconMinus,IconPlus,IconTrash,IconX} from '@tabler/icons-react';
import {AlertPanel,IconButton,StatusLabel} from '../system.jsx';
import {DataTable} from '../data-table.jsx';
import {Sheet,Note,useGuard,InstallConfirmDialog,InstallProgressDialog,CommandDialog} from './MoveFlow.jsx';
import {installChecks,PACKAGE_NAME} from './moves-client.js';
import {createLaunchClient,LAUNCH_STOP,LAUNCH_STEPS,STEP_LABEL,rowState,STATE_WORD,serviceNames,ENV_KEY,ENV_REFUSED,domainOk,friendlyLaunch,clock,elapsed} from './launch-client.js';
import './launch.css';

// Launch a new site from the Map (docs/launch-site.md). The Map's "New site" opens this flow on a server:
// source (Compose file or Git repository), check, trust warning with a fresh sign-in check, then a timeline.
// The check, the launch and each refresh are plain requests; the timeline refreshes only while a launch is running.
const EMPTY={tab:'compose',compose:'',env:[],service:'',domain:'',repo:'',ref:'main',composePath:'compose.yaml',keyId:'',backups:'daily',restore:'weekly'};
const BACKUPS=[['daily','Daily'],['weekly','Weekly']],RESTORES=[['weekly','Weekly'],['monthly','Monthly'],['off','Off']];
const label=(list,v)=>(list.find(([k])=>k===v)||[])[1]||'';

const Facts=({rows})=><dl className="def-list">{rows.filter(Boolean).map(([k,v])=><div className="def-row ln-fact" key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
// Neutral value text, only the icon carries the colour.
function State({state,children}){return <span className="ln-state"><StatusLabel state={state}><span className="sr-only">{STATE_WORD[state]}</span></StatusLabel>{children}</span>}

function EnvTable({rows,narrow,onValue,onRemove}){
 if(!rows.length)return null;
 const pw=(r,i)=><input type="password" aria-label={'Value for '+r.key} autoComplete="new-password" spellCheck={false} value={r.value} onChange={e=>onValue(i,e.target.value)}/>;
 const del=(r,i)=><IconButton label={'Remove '+r.key} icon={IconTrash} onClick={()=>onRemove(i)}/>;
 if(narrow)return <div className="data-table-wrap ln-rows"><dl className="def-list">{rows.map((r,i)=><div className="def-row ln-row ln-row-wrap" key={r.key}><dt><code>{r.key}</code></dt><dd className="ln-row-wide">{pw(r,i)}{del(r,i)}</dd></div>)}</dl></div>;
 return <DataTable headers={['Key','Value','']} columns={[null,null,'72px']} numeric={[2]}>{rows.map((r,i)=><tr key={r.key}><td><code>{r.key}</code></td><td>{pw(r,i)}</td><td>{del(r,i)}</td></tr>)}</DataTable>;
}

function Source({server,form,set,keys,narrow,err,onCancel,onCheck}){
 const git=form.tab==='git',names=useMemo(()=>serviceNames(form.compose),[form.compose]);
 const [adding,setAdding]=useState(false),[nk,setNk]=useState(''),[nv,setNv]=useState('');
 const keyErr=nk&&(!ENV_KEY.test(nk)?'Use letters, numbers and underscores.':ENV_REFUSED.test(nk)?'This name is reserved.':form.env.some(r=>r.key===nk)?'This name is already added.':'');
 const ready=domainOk(form.domain)&&(git?form.repo.trim().length>0&&form.composePath.trim().length>0:form.compose.trim().length>0);
 const field=(text,key,extra={})=><label className="map-field">{text}<input type="text" autoComplete="off" spellCheck={false} value={form[key]} onChange={e=>set({[key]:e.target.value})} {...extra}/></label>;
 const selectField=(text,key,items,extra={})=><label className="map-field">{text}<select value={form[key]} onChange={e=>set({[key]:e.target.value})} {...extra}>{items.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>;
 const keyItems=[['','No key (public)'],...keys.map(k=>[k.id,k.name])];
 const addVar=()=>{if(!nk||keyErr||!ENV_KEY.test(nk))return;set({env:[...form.env,{key:nk,value:nv}]});setNk('');setNv('');setAdding(false)};
 return <Sheet className="ln-dialog" title="New site" labelId="ln-source-title" onClose={onCancel} actions={<><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="primary" disabled={!ready} onClick={onCheck}>Check</button></>}>
  <div className="map-tabs" role="tablist" aria-label="Source">{[['compose','Compose file'],['git','Git repository']].map(([id,l])=><button key={id} type="button" role="tab" aria-selected={form.tab===id} className={form.tab===id?'on':''} onClick={()=>set({tab:id})}>{l}</button>)}</div>
  {err&&<AlertPanel variant="error">{err}</AlertPanel>}
  {git?<>
   {field('Repository URL','repo',{inputMode:'url'})}
   <div className={'ln-grid'+(narrow?' ln-grid-wide':'')}>{field('Branch or tag','ref')}{narrow?field('Compose file','composePath'):selectField('Deploy key','keyId',keyItems)}</div>
   {narrow?selectField('Deploy key','keyId',keyItems):null}
   <div className="ln-grid ln-grid-one">{narrow?null:field('Compose file','composePath')}{field('Domain','domain')}</div>
   <div><h3>Included</h3><dl className="def-list">
    <div className="def-row ln-row"><dt>Backups</dt><dd><select aria-label="Backups" value={form.backups} onChange={e=>set({backups:e.target.value})}>{BACKUPS.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></dd></div>
    <div className="def-row ln-row"><dt>Restore tests</dt><dd><select aria-label="Restore tests" value={form.restore} onChange={e=>set({restore:e.target.value})}>{RESTORES.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></dd></div>
    <div className="def-row ln-row"><dt>Certificate</dt><dd>Let's Encrypt</dd></div></dl></div>
  </>:<>
   <textarea className="mono ln-editor" spellCheck={false} aria-label="Compose file" rows={6} value={form.compose} onChange={e=>set({compose:e.target.value})}/>
   <div><h3>Environment</h3><p className="map-caption">Values are never shown again.</p></div>
   <EnvTable rows={form.env} narrow={narrow} onValue={(i,v)=>set({env:form.env.map((r,k)=>k===i?{...r,value:v}:r)})} onRemove={i=>set({env:form.env.filter((_,k)=>k!==i)})}/>
   {adding?<div className="ln-add" role="group" aria-label="New variable">
    <label className="map-field">Key<input type="text" autoComplete="off" spellCheck={false} autoFocus value={nk} aria-invalid={!!keyErr||undefined} onChange={e=>setNk(e.target.value)}/></label>
    <label className="map-field">Value<input type="password" autoComplete="new-password" value={nv} onChange={e=>setNv(e.target.value)}/></label>
    <div className="ln-add-actions"><IconButton label="Add variable" icon={IconCheck} disabled={!nk||!!keyErr} onClick={addVar}/><IconButton label="Cancel" icon={IconX} onClick={()=>{setAdding(false);setNk('');setNv('')}}/></div>
    {keyErr&&<p className="map-caption ln-bad" role="alert">{keyErr}</p>}
   </div>:<div><button type="button" onClick={()=>setAdding(true)}><IconPlus size={18} stroke={1.75} aria-hidden="true"/>Add variable</button></div>}
   <div className="ln-grid">
    {names.length?selectField('Web service','service',names.map(n=>[n,n]),{value:form.service||names[0]}):field('Web service','service')}
    {field('Domain','domain')}
   </div>
  </>}
 </Sheet>;
}

function bodyOf(form){
 const base={domain:form.domain.trim().toLowerCase()};
 return form.tab==='git'?{source:'git',repo:form.repo.trim(),ref:form.ref.trim()||'main',composePath:form.composePath.trim(),...(form.keyId?{deployKeyId:form.keyId}:{}),...base}
  :{source:'compose',compose:form.compose,webService:form.service||serviceNames(form.compose)[0]||'',...base};
}

function Check({server,form,result,client,loading,onCancel,onAgain,onInstall,onCommand,onLaunched}){
 const guard=useGuard(client),[busy,setBusy]=useState(false),[err,setErr]=useState('');
 const [pick,setPick]=useState({service:result?.webService||'',port:result?.webPort||''});
 const checks=result?.checks||[],services=result?.services||[],blocked=!loading&&(!result?.ok||checks.some(c=>rowState(c.status)==='failed'));
 const installs=installChecks(result||{}),git=form.tab==='git',trust=git||result?.builds;
 const rows=loading?['Docker','Compose','nginx','Port 443','DNS'].map((t,i)=>[t,<State state={i===0?'running':'queued'}>{i===0?'Checking':'Waiting'}</State>]):checks.map(c=>[c.title,<State state={rowState(c.status)}>{c.value||''}</State>]);
 const blockers=(result?.blockers||[]).map(b=>typeof b==='string'?b:b?.text).filter(Boolean);
 const svc=services.find(s=>s.name===pick.service)||services[0],ports=svc?.ports||[];
 const go=()=>{setBusy(true);setErr('');return guard.run(async()=>{
   const body={...bodyOf(form),...(pick.service?{webService:pick.service}:{}),...(pick.port?{webPort:Number(pick.port)}:{}),env:Object.fromEntries(form.env.map(r=>[r.key,r.value])),backups:form.backups,restoreTests:form.restore};
   const r=await client.start(server.id,body);onLaunched(r?.launch?.id);
  },e=>setErr(friendlyLaunch(e))).finally(()=>setBusy(false))};
 return <Sheet className="ln-dialog" title={loading?`Checking ${server.name}`:blocked?'Cannot launch yet':'Ready to launch'} labelId="ln-check-title" onClose={onCancel} actions={<><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="primary" disabled={loading||blocked||busy||guard.waiting} onClick={go}>Launch</button></>}>
  {blocked&&<AlertPanel variant="error" action={<div className="rp-actions">{installs.map((c,i)=><button key={c.install.package} type="button" className={i===0?'primary':undefined} onClick={()=>onInstall(c)}>Install {PACKAGE_NAME[c.install.package]}</button>)}{installs.some(c=>c.install.command)?<button type="button" onClick={()=>onCommand(installs.find(c=>c.install.command))}>Show command</button>:null}{!installs.length&&<button type="button" onClick={onAgain}>Check again</button>}</div>}>{blockers.join(' ')||'Something must be fixed before this site can launch.'}</AlertPanel>}
  <Facts rows={rows}/>
  {!loading&&services.length>1&&<div className="ln-grid">
   <label className="map-field">Web service<select value={svc?.name||''} onChange={e=>setPick({service:e.target.value,port:''})}>{services.map(s=><option key={s.name} value={s.name}>{s.name}</option>)}</select></label>
   {ports.length>1&&<label className="map-field">Web port<select value={pick.port||ports[0]} onChange={e=>setPick({...pick,port:e.target.value})}>{ports.map(p=><option key={p} value={p}>{p}</option>)}</select></label>}
  </div>}
  {!loading&&(result?.warnings||[]).map((w,i)=><AlertPanel key={i} variant="warning">{typeof w==='string'?w:w?.text}</AlertPanel>)}
  {!loading&&!blocked&&trust&&<AlertPanel variant="warning">This builds and runs code from the repository on {server.name}. Only use repositories you trust.</AlertPanel>}
  {err&&<Note kind="error" icon={IconCircleX} role="alert">{err}</Note>}
  {guard.prompt}
 </Sheet>;
}

const TL_ICON={done:[IconCircleCheck,'ok'],failed:[IconCircleX,'bad'],running:[IconLoader2,'run'],pending:[IconClock,''],skipped:[IconMinus,'']};
export function Timeline({steps,now=Date.now()}){
 return <div className="dn-tl"><ol className="dn-tl-list">{steps.map(s=>{
  const [Icon,tone]=TL_ICON[s.state]||TL_ICON.pending,bad=s.state==='failed';
  const dur=s.startedAt?(s.state==='running'?elapsed(s.startedAt,now):s.finishedAt?elapsed(s.startedAt,s.finishedAt):''):'';
  return <li key={s.step} className={'dn-tl-item'+(bad?' is-bad':'')}><span className={'rt-tl-ic '+tone}><Icon size={16} stroke={2} aria-hidden="true"/></span><span className="dn-tl-name">{s.label}<span className="sr-only">, {s.state}</span>{s.detail&&<small>{s.detail}</small>}</span><time className="dn-tl-time">{s.startedAt?clock(s.startedAt):''}</time><span className="dn-tl-dur">{dur}</span></li>})}</ol></div>;
}
// The server's steps if it sends them, else the planned list as waiting.
export function stepsOf(l){
 const got=Array.isArray(l?.steps)?l.steps:[];
 if(got.length)return got.map(s=>({...s,label:s.label||STEP_LABEL[s.step]||s.step,state:s.state||'pending'}));
 return LAUNCH_STEPS.map(([step,label])=>({step,label,state:'pending'}));
}

function Progress({server,client,launchId,onClose,onBack}){
 const [l,setL]=useState(null),[err,setErr]=useState(''),[busy,setBusy]=useState(false),[tick,setTick]=useState(0),[copied,setCopied]=useState(false);
 useEffect(()=>{
  let stop=false,t;
  const poll=async()=>{
   try{const m=await client.get(launchId);if(stop)return;setL(m);setErr('');if(!LAUNCH_STOP.has(m.state))t=setTimeout(poll,2000)}
   catch(e){if(stop)return;setErr(e.message);t=setTimeout(poll,4000)}
  };
  poll();return()=>{stop=true;clearTimeout(t)};
 },[client,launchId,tick]);
 const state=l?.state,acts=l?.actions||{},domain=l?.domain||'',steps=stepsOf(l),now=Date.now();
 const finish=()=>onClose(!!state&&LAUNCH_STOP.has(state));
 async function act(fn){setBusy(true);setErr('');try{await fn();setTick(n=>n+1)}catch(e){setErr(friendlyLaunch(e))}setBusy(false)}
 async function copy(){const d=l.dns;try{await navigator.clipboard.writeText(`${d.type} ${d.name} ${d.value}`);setCopied(true)}catch{setCopied(false)}}
 const errNote=err&&<Note kind="error" icon={IconCircleX} role="alert">{err}</Note>;
 const open=(https)=>()=>window.open((https?'https://':'http://')+domain,'_blank','noopener');
 const included=[['Backups',l?.backups||'Daily'],['Restore tests',l?.restoreTests||'Off']];
 if(state==='done'&&l.certificate?.state==='failed')return <Sheet className="ln-dialog" title={`${domain} is live`} labelId="ln-done-title" onClose={finish} actions={<><button type="button" onClick={finish}>Close</button><button type="button" className="primary" onClick={open(false)}>Open site</button></>}>
  <AlertPanel variant="error" title="Certificate failed" action={<div className="rp-actions"><button type="button" className="primary" disabled={busy} onClick={()=>act(()=>client.checkDns(launchId))}>Try again</button></div>}>{l.certificate.reason||'The certificate was refused.'} The site runs on HTTP.</AlertPanel>
  <Facts rows={[['Domain',<a href={'http://'+domain} target="_blank" rel="noreferrer">{'http://'+domain}</a>],['Certificate',<State state="failed">Failed</State>],...included]}/>
  {errNote}
 </Sheet>;
 if(state==='done')return <Sheet className="ln-dialog" title={`${domain} is live`} labelId="ln-done-title" onClose={finish} actions={<><button type="button" onClick={finish}>Close</button><button type="button" className="primary" onClick={open(true)}>Open site</button></>}>
  <Note kind="ok" icon={IconCircleCheck} role="status">Launched. Backups{l.restoreTests?' and restore tests are':' are'} on.</Note>
  <Facts rows={[['Domain',<a href={'https://'+domain} target="_blank" rel="noreferrer">{'https://'+domain}</a>],...included,['Certificate',"Let's Encrypt"]]}/>
  {l.restoreTests?null:<p className="map-caption">Add a test server to turn on restore tests.</p>}
 </Sheet>;
 if(state==='waiting_dns'){
  const d=l.dns;
  return <Sheet className="ln-dialog" title={`${domain} is ready`} labelId="ln-done-title" onClose={finish} actions={<><button type="button" onClick={finish}>Close</button><button type="button" disabled>Open site</button></>}>
   <AlertPanel variant="warning" title="Waiting for DNS" action={<div className="rp-actions"><button type="button" disabled={busy} onClick={()=>act(()=>client.checkDns(launchId))}>Check again</button></div>}>Point {domain} to this server. The certificate follows.</AlertPanel>
   {d&&<div className="map-record"><div><span className="map-caption">Record</span><code>{d.type} {d.name} {'→'} {d.value}</code></div><button type="button" onClick={copy}><IconCopy size={18} stroke={1.75} aria-hidden="true"/>{copied?'Copied':'Copy'}</button></div>}
   <Facts rows={included}/>
   {errNote}
  </Sheet>;
 }
 if(state==='failed'||state==='cancelled')return <Sheet className="ln-dialog" title={state==='cancelled'?'Launch cancelled':'Launch stopped'} labelId="ln-failed-title" onClose={finish} actions={<><button type="button" onClick={finish}>Close</button><button type="button" className="primary" onClick={onBack}>Back</button></>}>
  <AlertPanel variant="error">{l.reason||l.error||(state==='cancelled'?'Nothing was changed on '+server.name+'.':'Everything was removed.')}</AlertPanel>
  <Timeline steps={steps} now={now}/>{errNote}
 </Sheet>;
 if(state==='needs_attention')return <Sheet className="ln-dialog" title="Needs your attention" labelId="ln-attention-title" onClose={finish} actions={<button type="button" onClick={finish}>Close</button>}>
  <AlertPanel variant="error" action={<div className="rp-actions"><button type="button" className="primary" disabled={busy} onClick={()=>act(()=>client.retry(launchId))}>Try again</button></div>}>{l.reason||`Cleanup did not finish. ${server.name} stays on hold.`}</AlertPanel>
  <Timeline steps={steps} now={now}/>{errNote}
 </Sheet>;
 if(state==='removed')return <Sheet className="ln-dialog" title="Launch removed" labelId="ln-removed-title" onClose={finish} actions={<button type="button" className="primary" onClick={finish}>Close</button>}>
  <Note kind="ok" icon={IconCircleCheck} role="status">{domain} is removed from {server.name}. Backups stay.</Note>
 </Sheet>;
 const pct=Math.round(Math.min(100,Math.max(0,l?.progress??(steps.length?100*steps.filter(s=>s.state==='done').length/steps.length:0))));
 return <Sheet className="ln-dialog" title={domain?`Launching ${domain}`:'Launching'} labelId="ln-run-title" onClose={finish} actions={<><button type="button" disabled={!acts.cancel||busy} onClick={()=>act(()=>client.cancel(launchId))}>Cancel</button><button type="button" className="primary" onClick={finish}>Close</button></>}>
  <div className="map-bar" role="progressbar" aria-label="Launch progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct}><span style={{width:pct+'%'}}/></div>
  <p className="map-status" role="status">{l?.statusLine||'Starting…'}</p>
  <Timeline steps={steps} now={now}/>
  <p className="map-caption">Closing keeps it running.</p>
  {errNote}
 </Sheet>;
}

export function LaunchFlow({server,api,narrow,onClose}){
 const client=useMemo(()=>createLaunchClient(api),[api]);
 const [stage,setStage]=useState('source'),[form,setForm]=useState(EMPTY),[result,setResult]=useState(null),[err,setErr]=useState(''),[keys,setKeys]=useState([]),[launchId,setLaunchId]=useState(null),[ins,setIns]=useState(null);
 const run=useRef(0);
 useEffect(()=>{let live=true;client.deployKeys().then(r=>{if(live)setKeys(Array.isArray(r?.keys)?r.keys:[])}).catch(()=>{});return()=>{live=false}},[client]);
 const set=p=>setForm(f=>({...f,...p}));
 async function check(){
  const mine=++run.current;setErr('');setResult(null);setStage('checking');
  try{const r=await client.check(server.id,bodyOf(form));if(mine!==run.current)return;setResult(r);setStage('check')}
  catch(e){if(mine!==run.current)return;setErr(friendlyLaunch(e));setStage('source')}
 }
 const cancelCheck=()=>{run.current++;setStage('source')};
 const close=finished=>onClose(!!finished);
 const toCheck=()=>setStage('check');
 if(stage==='source')return <Source server={server} form={form} set={set} keys={keys} narrow={narrow} err={err} onCancel={()=>close(false)} onCheck={check}/>;
 if(stage==='checking')return <Check key="loading" server={server} form={form} loading client={client} onCancel={cancelCheck}/>;
 if(stage==='check')return <Check key="result" server={server} form={form} result={result} client={client} onCancel={()=>close(false)} onAgain={check} onInstall={c=>{setIns(c);setStage('install')}} onCommand={c=>{setIns(c);setStage('command')}} onLaunched={id=>{setLaunchId(id);setStage('progress')}}/>;
 if(stage==='install')return <InstallConfirmDialog server={server} check={{...ins,serverId:server.id}} client={client} onCancel={toCheck} onStarted={jobId=>{setIns(i=>({...i,jobId}));setStage('install-run')}} onCheckAgain={check}/>;
 if(stage==='install-run')return <InstallProgressDialog server={server} pkg={ins.install.package} client={client} jobId={ins.jobId} onClose={toCheck} onCheckAgain={check}/>;
 if(stage==='command')return <CommandDialog server={server} check={ins} onClose={toCheck} onCheckAgain={check}/>;
 return <Progress server={server} client={client} launchId={launchId} onClose={close} onBack={()=>{setStage('source')}}/>;
}
