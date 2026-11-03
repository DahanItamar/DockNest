import React,{useEffect,useMemo,useRef,useState} from 'react';
import {IconCheck,IconLoader2,IconClock,IconCopy,IconCircleX,IconCircleCheck,IconMinus,IconPlus,IconTrash,IconX} from '@tabler/icons-react';
import {AlertPanel,IconButton,StatusLabel} from '../system.jsx';
import {DataTable} from '../data-table.jsx';
import {Sheet,Note,useGuard,InstallConfirmDialog,InstallProgressDialog,CommandDialog} from './MoveFlow.jsx';
import {installChecks,PACKAGE_NAME} from './moves-client.js';
import {createLaunchClient,LAUNCH_STEPS,STEP_LABEL,STATE_WORD,serviceNames,ENV_KEY,ENV_REFUSED,domainOk,friendlyLaunch,clock,elapsed,agoText,untilText,checkRows,blockersOf,statusLine,settled,busyLaunch,sshUrl,bodyOf,startBody} from './launch-client.js';
import './launch.css';

// Launch a new site from the Map. The Map's "New site" opens this flow on a server:
// source (Compose file or Git repository), check, trust warning with a fresh sign-in check, then a timeline.
// The check, the launch and each refresh are plain requests; the timeline refreshes only while a launch is running.
const EMPTY={tab:'compose',compose:'',env:[],service:'',domain:'',repo:'',ref:'main',composePath:'compose.yaml',keyId:'',allowPrivate:false,shutdown:false};

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

function Source({server,form,set,keys,narrow,err,privateHint,onCancel,onCheck}){
 const git=form.tab==='git',names=useMemo(()=>serviceNames(form.compose),[form.compose]);
 const [adding,setAdding]=useState(false),[nk,setNk]=useState(''),[nv,setNv]=useState('');
 const keyErr=nk&&(!ENV_KEY.test(nk)?'Use letters, numbers and underscores.':ENV_REFUSED.test(nk)?'This name is reserved.':form.env.some(r=>r.key===nk)?'This name is already added.':'');
 const ready=form.shutdown&&domainOk(form.domain)&&(git?form.repo.trim().length>0&&form.composePath.trim().length>0:form.compose.trim().length>0);
 const field=(text,key,extra={})=><label className="map-field">{text}<input type="text" autoComplete="off" spellCheck={false} value={form[key]} onChange={e=>set({[key]:e.target.value})} {...extra}/></label>;
 const selectField=(text,key,items,extra={})=><label className="map-field">{text}<select value={form[key]} onChange={e=>set({[key]:e.target.value})} {...extra}>{items.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>;
 const keyItems=[['','No key (public)'],...keys.map(k=>[k.id,k.name])];
 const keySelect=<label className="map-field">Deploy key<select value={form.keyId} disabled={!!form.repo.trim()&&!sshUrl(form.repo)} onChange={e=>set({keyId:e.target.value})}>{keyItems.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>;
 const addVar=()=>{if(!nk||keyErr||!ENV_KEY.test(nk))return;set({env:[...form.env,{key:nk,value:nv}]});setNk('');setNv('');setAdding(false)};
 return <Sheet className="ln-dialog" title="New site" labelId="ln-source-title" onClose={onCancel} actions={<><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="primary" disabled={!ready} onClick={onCheck}>Check</button></>}>
  <div className="map-tabs" role="tablist" aria-label="Source">{[['compose','Compose file'],['git','Git repository']].map(([id,l])=><button key={id} type="button" role="tab" aria-selected={form.tab===id} className={form.tab===id?'on':''} onClick={()=>set({tab:id})}>{l}</button>)}</div>
  {err&&<AlertPanel variant="error">{err}</AlertPanel>}
  {git?<>
   {field('Repository URL','repo',{inputMode:'url'})}
   {privateHint&&<label className="map-check"><input type="checkbox" checked={form.allowPrivate} onChange={e=>set({allowPrivate:e.target.checked})}/>Allow private address</label>}
   {narrow?<>
    <div className="ln-grid ln-grid-wide">{field('Branch or tag','ref')}{field('Compose file','composePath')}</div>
    {keySelect}{field('Domain','domain')}
   </>:<>
    <div className="ln-grid">{field('Branch or tag','ref')}{keySelect}</div>
    <div className="ln-grid">{field('Compose file','composePath')}{field('Domain','domain')}</div>
   </>}
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
  <div><h3>Included</h3><Facts rows={[['Backups','Daily'],['Restore tests','Weekly'],['Certificate',"Let's Encrypt"]]}/></div>
  <label className="check"><input type="checkbox" checked={form.shutdown} onChange={e=>set({shutdown:e.target.checked})}/> I verified that a normal stop cleanly closes the application and database writers.</label>
 </Sheet>;
}

function Check({server,form,result,client,loading,onCancel,onAgain,onInstall,onCommand,onLaunched}){
 const guard=useGuard(client,{verifyLabel:'Verify'}),[busy,setBusy]=useState(false),[err,setErr]=useState('');
 const services=result?.services||[],tests=result?.testServers||[];
 const chosen=form.service||(form.tab==='compose'?serviceNames(form.compose)[0]:'')||'';
 const [pick,setPick]=useState({service:services.find(x=>x.name===chosen)?.name||'',port:'',test:tests[0]?.id||''});
 const blocked=!loading&&!result?.ok,installs=installChecks(result||{}),git=form.tab==='git',trust=git||!!result?.builds;
 const rows=loading?['Docker','Compose','nginx','Certbot','DNS'].map((t,i)=>[t,<State state={i===0?'running':'queued'}>{i===0?'Checking':'Waiting'}</State>]):checkRows(result).map(c=>[c.title,<State state={c.state}>{c.value}</State>]);
 const blockers=blockersOf(result),svc=services.find(x=>x.name===pick.service)||services[0],ports=svc?.ports||[];
 const portValue=pick.port||ports[0]||'',portOk=Number.isInteger(Number(portValue))&&Number(portValue)>=1&&Number(portValue)<=65535&&String(portValue).trim()!=='';
 const go=()=>{setBusy(true);setErr('');return guard.run(async()=>{
   const body=startBody(form,{service:svc?.name,port:portValue,testServerId:tests.length?(pick.test||null):undefined,trust});
   const r=await client.start(server.id,body);if(!r?.launch?.id)throw new Error('The launch did not start. Try again.');onLaunched(r.launch.id);
  },e=>setErr(friendlyLaunch(e))).finally(()=>setBusy(false))};
 return <Sheet className="ln-dialog" title={loading?`Checking ${server.name}`:blocked?'Cannot launch yet':'Ready to launch'} labelId="ln-check-title" onClose={onCancel} actions={<><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="primary" disabled={loading||blocked||busy||guard.waiting||!form.shutdown||!portOk} onClick={go}>Launch</button></>}>
  {blocked&&<AlertPanel variant="error" action={<div className="rp-actions">{installs.filter(c=>c.install.supported!==false).map((c,i)=><button key={c.install.package} type="button" className={i===0?'primary':undefined} onClick={()=>onInstall(c)}>Install {PACKAGE_NAME[c.install.package]}</button>)}{installs.some(c=>c.install.command)?<button type="button" onClick={()=>onCommand(installs.find(c=>c.install.command))}>Show command</button>:null}{!installs.some(c=>c.install.supported!==false||c.install.command)&&<button type="button" onClick={onAgain}>Check again</button>}</div>}>{blockers.join(' ')||'Something must be fixed before this site can launch.'}</AlertPanel>}
  <Facts rows={rows}/>
  {!loading&&!blocked&&(services.length>1||ports.length!==1||tests.length>0)&&<div className="ln-grid">
   {services.length>1&&<label className="map-field">Web service<select value={svc?.name||''} onChange={e=>setPick({...pick,service:e.target.value,port:''})}>{services.map(x=><option key={x.name} value={x.name}>{x.name}</option>)}</select></label>}
   {ports.length>1&&<label className="map-field">Web port<select value={pick.port||ports[0]} onChange={e=>setPick({...pick,port:e.target.value})}>{ports.map(p=><option key={p} value={p}>{p}</option>)}</select></label>}
   {ports.length===0&&<label className="map-field">Web port<input type="text" inputMode="numeric" autoComplete="off" value={pick.port} aria-invalid={!!pick.port&&!portOk||undefined} onChange={e=>setPick({...pick,port:e.target.value.replace(/\D/g,'')})}/></label>}
   {tests.length>0&&<label className="map-field">Restore test server<select value={pick.test} onChange={e=>setPick({...pick,test:e.target.value})}>{tests.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}<option value="">No restore tests</option></select></label>}
  </div>}
  {!loading&&(result?.warnings||[]).map((w,i)=><AlertPanel key={i} variant="warning">{typeof w==='string'?w:w?.text}</AlertPanel>)}
  {!loading&&trust&&<AlertPanel variant="warning">This builds and runs code from the repository on {server.name}. Only use repositories you trust.</AlertPanel>}
  {err&&<Note kind="error" icon={IconCircleX} role="alert">{err}</Note>}
  {guard.prompt}
 </Sheet>;
}

const TL_ICON={done:[IconCircleCheck,'ok'],failed:[IconCircleX,'bad'],running:[IconLoader2,'run'],waiting:[IconLoader2,'run'],queued:[IconClock,''],pending:[IconClock,''],skipped:[IconMinus,'']};
export function Timeline({steps,now=Date.now()}){
 return <div className="dn-tl"><ol className="dn-tl-list">{steps.map(s=>{
  const [Icon,tone]=TL_ICON[s.state]||TL_ICON.pending,bad=s.state==='failed';
  const dur=s.startedAt?(s.state==='running'?elapsed(s.startedAt,now):s.finishedAt?elapsed(s.startedAt,s.finishedAt):''):'';
  return <li key={s.step} className={'dn-tl-item'+(bad?' is-bad':'')}><span className={'rt-tl-ic '+tone}><Icon size={16} stroke={2} aria-hidden="true"/></span><span className="dn-tl-name">{s.label}<span className="sr-only">, {s.state}</span>{s.detail&&<small>{s.detail}</small>}</span><time className="dn-tl-time">{s.startedAt?clock(s.startedAt):''}</time><span className="dn-tl-dur">{dur}</span></li>})}</ol></div>;
}
// The server's steps (the teardown row only once it has started), or the planned list as waiting while the first answer loads.
export function stepsOf(l){
 const got=Array.isArray(l?.steps)?l.steps:[];
 if(got.length)return got.filter(s=>s.step!=='teardown'||!['pending','skipped'].includes(s.state)).map(s=>({...s,label:STEP_LABEL[s.step]||s.label||s.step,state:s.state||'pending'}));
 return LAUNCH_STEPS.map(([step,label])=>({step,label,state:'pending'}));
}
const restoreText=l=>l?.restoreTests?.enabled?'Weekly':'Off';

export function LaunchProgress({server,client,launchId,onClose,onBack}){
 const [l,setL]=useState(null),[err,setErr]=useState(''),[busy,setBusy]=useState(false),[tick,setTick]=useState(0),[copied,setCopied]=useState(false),[fatal,setFatal]=useState('');
 useEffect(()=>{
  let stop=false,t;
  const poll=async()=>{
   if(!launchId){setFatal('This launch could not be found.');return}
   try{const m=await client.get(launchId);if(stop)return;setL(m);setErr('');if(!settled(m))t=setTimeout(poll,2000)}
   catch(e){if(stop)return;
    // A refused or missing launch will not get better by asking again.
    if([400,403,404].includes(e.status)){setFatal(e.message||'This launch could not be found.');return}
    setErr(e.message);t=setTimeout(poll,4000)}
  };
  poll();return()=>{stop=true;clearTimeout(t)};
 },[client,launchId,tick]);
 const state=l?.state,acts=l?.actions||{},domain=l?.domain||'',steps=stepsOf(l),now=Date.now();
 const finish=()=>onClose(settled(l));
 async function act(fn){setBusy(true);setErr('');try{await fn();setTick(n=>n+1)}catch(e){setErr(friendlyLaunch(e))}setBusy(false)}
 if(fatal&&!l)return <Sheet className="ln-dialog" title="Launch" labelId="ln-gone-title" onClose={()=>onClose(false)} actions={<button type="button" className="primary" onClick={()=>onClose(false)}>Close</button>}>
  <Note kind="error" icon={IconCircleX} role="alert">{fatal}</Note>
 </Sheet>;
 const records=l?.dns?(l.dns.records?.length?l.dns.records:[l.dns]):[];
 async function copy(){try{await navigator.clipboard.writeText(records.map(d=>`${d.type} ${d.name} ${d.value}`).join('\n'));setCopied(true)}catch{setCopied(false)}}
 const errNote=err&&<Note kind="error" icon={IconCircleX} role="alert">{err}</Note>;
 const open=https=>()=>window.open((https?'https://':'http://')+domain,'_blank','noopener');
 const included=[['Backups','Daily'],['Restore tests',restoreText(l)]];
 const cert=(l?.steps||[]).find(x=>x.step==='certificate'),busyNow=busyLaunch(l);
 if(l&&!busyNow&&state==='done'&&(l.certificate?.state==='failed'||cert?.state==='failed'))return <Sheet className="ln-dialog" title={`${domain} is live`} labelId="ln-done-title" onClose={finish} actions={<><button type="button" onClick={finish}>Close</button><button type="button" className="primary" onClick={open(false)}>Open site</button></>}>
  <AlertPanel variant="error" title="Certificate failed" action={acts.checkDns&&<div className="rp-actions"><button type="button" className="primary" disabled={busy} onClick={()=>act(()=>client.checkDns(launchId))}>Try again</button></div>}>{l.certificate?.reason||cert?.detail||'The certificate was refused.'} The site runs on HTTP.</AlertPanel>
  <Facts rows={[['Domain',<a href={'http://'+domain} target="_blank" rel="noreferrer">{'http://'+domain}</a>],...included]}/>
  {errNote}
 </Sheet>;
 if(l&&!busyNow&&state==='done')return <Sheet className="ln-dialog" title={`${domain} is live`} labelId="ln-done-title" onClose={finish} actions={<><button type="button" onClick={finish}>Close</button><button type="button" className="primary" onClick={open(true)}>Open site</button></>}>
  {(l.steps||[]).find(x=>x.step==='maintenance'&&x.state==='failed')&&<AlertPanel variant="warning" title="Maintenance page">{(l.steps||[]).find(x=>x.step==='maintenance').detail||'The maintenance page was not set up.'} Set it up from the site.</AlertPanel>}
  <Note kind="ok" icon={IconCircleCheck} role="status">Launched. Backups{l.restoreTests?.enabled?' and restore tests are':' are'} on.</Note>
  <Facts rows={[['Domain',<a href={'https://'+domain} target="_blank" rel="noreferrer">{'https://'+domain}</a>],...included,['Certificate',"Let's Encrypt"]]}/>
  {l.restoreTests?.enabled?null:<p className="map-caption">{l.restoreTests?.reason||'Add a test server to turn on restore tests.'}</p>}
 </Sheet>;
 if(l&&!busyNow&&state==='waiting_dns')return <Sheet className="ln-dialog" title={`${domain} is ready`} labelId="ln-done-title" onClose={finish} actions={<><button type="button" onClick={finish}>Close</button><button type="button" disabled>Open site</button></>}>
  <AlertPanel variant="warning" title="Waiting for DNS" action={acts.checkDns&&<div className="rp-actions"><button type="button" disabled={busy} onClick={()=>act(()=>client.checkDns(launchId))}>Check again</button></div>}>Point {domain} to this server. The certificate follows.</AlertPanel>
  {records.map(d=><div className="map-record" key={d.type}><div><span className="map-caption">Record</span><code>{d.type} {d.name} {'→'} {d.value}</code></div><button type="button" onClick={copy}><IconCopy size={18} stroke={1.75} aria-hidden="true"/>{copied?'Copied':'Copy'}</button></div>)}
  <Facts rows={included}/>
  {errNote}
 </Sheet>;
 if(l&&(state==='failed'||state==='cancelled'))return <Sheet className="ln-dialog" title={state==='cancelled'?'Launch cancelled':'Launch stopped'} labelId="ln-failed-title" onClose={finish} actions={<><button type="button" onClick={finish}>Close</button><button type="button" className="primary" onClick={onBack}>Back</button></>}>
  <AlertPanel variant="error">{l.reason||(state==='cancelled'?'Nothing was changed on '+server.name+'.':'Everything was removed.')}</AlertPanel>
  <Timeline steps={steps} now={now}/>{errNote}
 </Sheet>;
 if(l&&state==='needs_attention')return <Sheet className="ln-dialog" title="Needs your attention" labelId="ln-attention-title" onClose={finish} actions={<button type="button" onClick={finish}>Close</button>}>
  <AlertPanel variant="error" action={acts.retry&&<div className="rp-actions"><button type="button" className="primary" disabled={busy} onClick={()=>act(()=>client.retry(launchId))}>Try again</button></div>}>{l.reason||`Cleanup did not finish. ${server.name} stays on hold.`}</AlertPanel>
  <Timeline steps={steps} now={now}/>{errNote}
 </Sheet>;
 if(l&&state==='removed')return <Sheet className="ln-dialog" title="Launch removed" labelId="ln-removed-title" onClose={finish} actions={<button type="button" className="primary" onClick={finish}>Close</button>}>
  <Note kind="ok" icon={IconCircleCheck} role="status">{domain} is removed from {server.name}. Backups stay.</Note>
 </Sheet>;
 const pct=Math.round(Math.min(100,Math.max(0,l?.progress??100*steps.filter(s=>s.state==='done').length/Math.max(1,steps.length))));
 return <Sheet className="ln-dialog" title={l?.removing?`Removing ${domain}`:domain?`Launching ${domain}`:'Launching'} labelId="ln-run-title" onClose={finish} actions={<>{acts.cancel&&<button type="button" disabled={busy} onClick={()=>act(()=>client.cancel(launchId))}>Cancel</button>}<button type="button" className="primary" onClick={finish}>Close</button></>}>
  <div className="map-bar" role="progressbar" aria-label="Launch progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct}><span style={{width:pct+'%'}}/></div>
  <p className="map-status" role="status">{statusLine(l)}</p>
  <Timeline steps={steps} now={now}/>
  <p className="map-caption">{l?.removing?'Closing keeps it going.':'Closing keeps it running.'}</p>
  {errNote}
 </Sheet>;
}

export function LaunchFlow({server,api,narrow,onClose}){
 const client=useMemo(()=>createLaunchClient(api),[api]);
 const [stage,setStage]=useState('source'),[form,setForm]=useState(EMPTY),[result,setResult]=useState(null),[err,setErr]=useState(''),[privateHint,setPrivateHint]=useState(false),[keys,setKeys]=useState([]),[launchId,setLaunchId]=useState(null),[ins,setIns]=useState(null);
 const run=useRef(0);
 useEffect(()=>{let live=true;client.deployKeys().then(r=>{if(live)setKeys(Array.isArray(r?.keys)?r.keys:[])}).catch(()=>{});return()=>{live=false}},[client]);
 const set=p=>setForm(f=>({...f,...p}));
 async function check(){
  const mine=++run.current;setErr('');setResult(null);setStage('checking');
  try{const r=await client.check(server.id,bodyOf(form));if(mine!==run.current)return;setResult(r);setStage('check')}
  catch(e){if(mine!==run.current)return;setErr(friendlyLaunch(e));if(e.code==='PRIVATE_ADDRESS')setPrivateHint(true);setStage('source')}
 }
 const cancelCheck=()=>{run.current++;setStage('source')};
 const close=finished=>onClose(!!finished);
 const toCheck=()=>setStage('check');
 if(stage==='source')return <Source server={server} form={form} set={set} keys={keys} narrow={narrow} err={err} privateHint={privateHint} onCancel={()=>close(false)} onCheck={check}/>;
 if(stage==='checking')return <Check key="loading" server={server} form={form} loading client={client} onCancel={cancelCheck}/>;
 if(stage==='check')return <Check key="result" server={server} form={form} result={result} client={client} onCancel={()=>close(false)} onAgain={check} onInstall={c=>{setIns(c);setStage('install')}} onCommand={c=>{setIns(c);setStage('command')}} onLaunched={id=>{setLaunchId(id);setForm(f=>({...f,env:f.env.map(r=>({...r,value:''}))}));setStage('progress')}}/>;
 if(stage==='install')return <InstallConfirmDialog server={server} check={{...ins,serverId:server.id}} client={client} onCancel={toCheck} onStarted={jobId=>{setIns(i=>({...i,jobId}));setStage('install-run')}} onCheckAgain={check}/>;
 if(stage==='install-run')return <InstallProgressDialog server={server} pkg={ins.install.package} client={client} jobId={ins.jobId} onClose={toCheck} onCheckAgain={check}/>;
 if(stage==='command')return <CommandDialog server={server} check={ins} onClose={toCheck} onCheckAgain={check}/>;
 return <LaunchProgress server={server} client={client} launchId={launchId} onClose={close} onBack={()=>{setStage('source')}}/>;
}

// The Remove launch offer on a launched site's details: 24 hours after the launch.
export function LaunchOffer({launch,onRemove}){
 return <section className="hd-section">
  <span className="t-caption">Launched {agoText(launch.launchedAt)}. Removable until {untilText(launch.removeUntil)}.</span>
  <div><button type="button" onClick={onRemove}>Remove launch</button></div>
 </section>;
}
export const offerOpen=launch=>!!launch?.id&&Date.parse(launch.removeUntil)>Date.now();

// Confirm, with the fresh sign-in check the server asks for, then follow the removal like a launch.
export function RemoveLaunchDialog({launch,server,api,onClose}){
 const client=useMemo(()=>createLaunchClient(api),[api]),guard=useGuard(client,{verifyLabel:'Verify'}),[busy,setBusy]=useState(false),[err,setErr]=useState(''),[running,setRunning]=useState(false);
 const id=launch.id;
 if(running)return <LaunchProgress server={server} client={client} launchId={id} onClose={onClose} onBack={()=>onClose(true)}/>;
 const go=()=>{setBusy(true);setErr('');return guard.run(async()=>{await client.remove(id);setRunning(true)},e=>setErr(friendlyLaunch(e))).finally(()=>setBusy(false))};
 return <Sheet className="ln-dialog" title="Remove launch?" labelId="ln-remove-title" onClose={()=>onClose(false)} actions={<><button type="button" onClick={()=>onClose(false)}>Cancel</button><button type="button" className="primary" disabled={busy||guard.waiting} onClick={go}>Remove launch</button></>}>
  <p>This removes what the launch created on {server?.name||'the server'}: containers, volumes, the nginx file and the certificate. Backups stay.</p>
  {err&&<Note kind="error" icon={IconCircleX} role="alert">{err}</Note>}
  {guard.prompt}
 </Sheet>;
}

// Reopen a launch that is still going (from the server's details): the same timeline as right after Launch.
export function OpenLaunch({server,api,launchId,onClose}){
 const client=useMemo(()=>createLaunchClient(api),[api]);
 return <LaunchProgress server={server} client={client} launchId={launchId} onClose={onClose} onBack={()=>onClose(false)}/>;
}
