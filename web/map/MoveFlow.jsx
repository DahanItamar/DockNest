import React,{useEffect,useRef,useState} from 'react';
import {IconCheck,IconLoader2,IconClock,IconCopy,IconChevronDown,IconCircleX,IconAlertTriangle,IconCircleCheck,IconInfoCircle,IconMinus} from '@tabler/icons-react';
import {FINISHED,STOP_POLLING,BUSY_WORD,duration,why,warningText,friendly} from './moves-client.js';

// Native modal dialog with an explicit Tab trap; Escape closes, focus returns to the opener (handled by the page).
function Sheet({title,labelId,onClose,children,actions}){
 const ref=useRef(null);
 // Focus the title on open, so no button shows a focus ring until the user moves focus
 useEffect(()=>{const d=ref.current;if(d&&!d.open){d.showModal();d.querySelector('h2')?.focus()}return()=>{if(d?.open)d.close()}},[]);
 function trap(e){
  if(e.key!=='Tab')return;
  const items=[...ref.current.querySelectorAll('button,input,a[href],select,textarea,[tabindex]')].filter(el=>!el.disabled&&el.tabIndex>=0&&el.offsetParent!==null);
  if(!items.length){e.preventDefault();return;}
  const first=items[0],last=items[items.length-1],a=document.activeElement;
  if(e.shiftKey&&(a===first||!ref.current.contains(a))){e.preventDefault();last.focus();}
  else if(!e.shiftKey&&(a===last||!ref.current.contains(a))){e.preventDefault();first.focus();}
 }
 return <dialog ref={ref} className="map-dialog" aria-labelledby={labelId} onKeyDown={trap} onCancel={e=>{e.preventDefault();onClose?.()}}>
  <div className="map-dialog-body"><h2 id={labelId} tabIndex={-1}>{title}</h2>{children}</div>
  <div className="map-dialog-foot">{actions}</div>
 </dialog>;
}

// Same check as the Update Center: the shared password and a fresh authenticator code (POST /api/auth/reauth).
function ReauthBox({client,onVerified,onCancel}){
 const [password,setPassword]=useState(''),[code,setCode]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function verify(){
  setBusy(true);setError('');
  try{await client.reauth(password,code.trim());await onVerified()}
  catch(e){setError(e.status===401?'That password or code was not right. Try again.':friendly(e));setBusy(false)}
 }
 return <div className="map-reauth" role="group" aria-labelledby="map-reauth-title">
  <b id="map-reauth-title">Please confirm it is you</b>
  <p>Enter the shared password and a fresh code from your authenticator.</p>
  <label className="map-field">Password<input type="password" name="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} aria-invalid={!!error||undefined}/></label>
  <label className="map-field">Authenticator code<input name="code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e=>setCode(e.target.value)} aria-invalid={!!error||undefined}/></label>
  {error&&<Note kind="error" icon={IconCircleX} role="alert">{error}</Note>}
  <div className="map-reauth-actions"><button type="button" onClick={onCancel}>Not now</button><button type="button" className="primary" disabled={busy||!password||code.trim().length<6} onClick={verify}>Verify and continue</button></div>
 </div>;
}
// run(fn, onError): runs fn; if the server asks for a fresh sign-in check, shows the check inside the dialog and retries fn once verified.
function useGuard(client){
 const [need,setNeed]=useState(null);
 const run=async(fn,onError)=>{
  try{return await fn()}
  catch(e){if(e.code==='REAUTH_REQUIRED'){setNeed({fn,onError});return}if(onError)onError(e);else throw e}
 };
 const prompt=need&&<ReauthBox client={client} onCancel={()=>setNeed(null)} onVerified={async()=>{const n=need;setNeed(null);await run(n.fn,n.onError)}}/>;
 return {run,prompt,waiting:!!need};
}

function Fact({label,value}){return <div className="map-fact"><span className="map-caption">{label}</span><b>{value}</b></div>}
const Note=({kind,icon:Icon,role,children})=><div className={'map-note map-note-'+kind} role={role}><Icon size={20} stroke={2} aria-hidden="true"/><span>{children}</span></div>;
const CHECK_ICON={ok:IconCheck,info:IconInfoCircle,warn:IconAlertTriangle,block:IconCircleX};
const CHECK_WORD={ok:'Fine',info:'Note',warn:'Warning',block:'Needs fixing'};

export function ReviewDialog({site,from,to,preview,onCancel,onMove,error,busy,client}){
 const guard=useGuard(client),[cfConfigured,setCfConfigured]=useState(false);
 const [cf,setCf]=useState(false),[token,setToken]=useState(''),[tokenSaved,setTokenSaved]=useState(false),[tokenErr,setTokenErr]=useState(''),[tokenBusy,setTokenBusy]=useState(false);
 const blocked=!preview.ok||preview.verdict==='blocked',long=!blocked&&preview.needsMoveAnyway;
 const [anyway,setAnyway]=useState(false);
 const adv=preview.advanced||{};
 const [env,setEnv]=useState({}),[ask,setAsk]=useState(false),[open,setOpen]=useState(false);
 const canMove=!blocked&&(!long||anyway)&&!busy;
 const warns=(preview.warnings||[]).filter(w=>!w.advanced),advWarns=(preview.warnings||[]).filter(w=>w.advanced);
 const cfReady=tokenSaved||cfConfigured;
 useEffect(()=>{if(open)client.cloudflareStatus().then(s=>setCfConfigured(!!s?.configured)).catch(()=>{})},[open,client]);
 const submit=()=>guard.run(()=>onMove({envRewrite:Object.keys(env).filter(k=>env[k]),askBeforeSwitch:ask,dnsMode:cf&&cfReady?'cloudflare':'manual',moveAnyway:long&&anyway}));
 async function saveToken(){
  setTokenBusy(true);setTokenErr('');
  await guard.run(async()=>{await client.saveCloudflareToken(token);setToken('');setTokenSaved(true);setCf(true)},e=>setTokenErr(friendly(e)));
  setTokenBusy(false);
 }
 const portsText=p=>`${p.from} to ${p.to}${p.changed?' (changed, the old number is taken)':''}`;
 const unknown='Not known yet';
 return <Sheet title={blocked?'Cannot move yet':'Ready to move'} labelId="map-review-title" onClose={onCancel} actions={<><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="primary" disabled={!canMove} onClick={submit}>Move</button></>}>
  <p className="map-lead"><b>{site.name}</b> moves from {from.name} to {to.name}.</p>
  {blocked&&<Note kind="error" icon={IconCircleX} role="alert">{why(preview)}</Note>}
  {!blocked&&<div className="map-facts">
   <Fact label="Takes about" value={duration(preview.estimateSeconds)||unknown}/>
   <Fact label="Site offline about" value={duration(preview.downtimeSeconds)||unknown}/>
   <Fact label="Can undo for" value={preview.undoDays+' days'}/>
  </div>}
  {long&&<Note kind="warn" icon={IconAlertTriangle} role="alert">Your site will be offline for a long time.{warns[0]?' '+warningText(warns[0]):''}</Note>}
  {!blocked&&!long&&warns.length>0&&<Note kind="warn" icon={IconAlertTriangle}>{warns.map(warningText).join(' ')}</Note>}
  {long&&<label className="map-check"><input type="checkbox" checked={anyway} onChange={e=>setAnyway(e.target.checked)}/>I accept about {duration(preview.downtimeSeconds)||"a long time"} offline</label>}
  {!blocked&&<div className="map-advanced">
   <button type="button" className="map-disclose" aria-expanded={open} aria-controls="map-adv" onClick={()=>setOpen(!open)}>Advanced settings<IconChevronDown size={18} stroke={1.75} aria-hidden="true" className={open?'open':''}/></button>
   {open&&<div id="map-adv" className="map-adv-body">
    {advWarns.length>0&&<section><h3>Notes</h3>{advWarns.map(w=><p key={w.id}>{warningText(w)}</p>)}</section>}
    {adv.ports?.length>0&&<section><h3>Ports</h3>{adv.ports.map((p,i)=><p key={i}>{portsText(p)}</p>)}</section>}
    {adv.nginx&&<section><h3>Nginx file</h3><p>{adv.nginx.file||'Not found'}</p>{adv.nginx.notCopied?.length>0&&<><p>These custom lines will not be copied:</p><pre>{adv.nginx.notCopied.join('\n')}</pre></>}</section>}
    {adv.envKeys?.length>0&&<section><h3>.env values to rewrite</h3><p className="map-caption">Off by default. Turn on only the values that point to the old server.</p>{adv.envKeys.map(k=><label key={k.key} className="map-check"><input type="checkbox" checked={!!env[k.key]} onChange={e=>setEnv({...env,[k.key]:e.target.checked})}/><span><code>{k.key}</code> <span className="map-caption">{k.masked}</span></span></label>)}</section>}
    <section><h3>Block outgoing email during the test</h3><p>{preview.mailBlocked?'Yes. The test copy cannot send email.':'Not possible on this server. The test copy could send real email, so check that your site does not send mail while it is being tested.'}</p></section>
    <section><h3>Switching</h3><label className="map-check"><input type="checkbox" checked={ask} onChange={e=>setAsk(e.target.checked)}/>Ask me before switching</label></section>
    <section><h3>Old copy</h3><p>DockNest asks you what to do with it after 7 days.</p></section>
    <section><h3>Domain</h3>
     <p>{cf&&cfReady?'DockNest will change the DNS record for you.':'You change the DNS record yourself. DockNest shows you the record at the end.'}</p>
     <label className="map-check"><input type="checkbox" checked={cf&&cfReady} disabled={!cfReady} onChange={e=>setCf(e.target.checked)}/>Switch DNS for me (Cloudflare)</label>
     {cfReady?<p className="map-caption">Cloudflare token: Saved</p>:<div className="map-token">
      <label className="map-field">Cloudflare token<input type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)}/></label>
      <p className="map-caption">Needs permission to edit DNS for your domain only.</p>
      <button type="button" disabled={!token||tokenBusy} onClick={saveToken}>Save token</button>
      {tokenErr&&<Note kind="error" icon={IconCircleX} role="alert">{tokenErr}</Note>}
     </div>}
    </section>
    {adv.checks?.length>0&&<section><h3>Checks</h3><ul className="map-checks">{adv.checks.map(c=>{const I=CHECK_ICON[c.status]||IconInfoCircle;return <li key={c.id} className={'chk-'+c.status}><I size={18} stroke={2} aria-hidden="true"/><span><b>{c.title}</b> <span className="sr-only">{CHECK_WORD[c.status]}. </span>{c.text}</span></li>})}</ul></section>}
   </div>}
  </div>}
  {error&&<Note kind="error" icon={IconCircleX} role="alert">{error}</Note>}
  {guard.prompt}
 </Sheet>;
}

function StepIcon({status}){
 if(status==='done')return <IconCheck size={18} stroke={2} aria-hidden="true" className="s-done"/>;
 if(status==='running')return <IconLoader2 size={18} stroke={2} aria-hidden="true" className="s-run"/>;
 if(status==='failed'||status==='undo_failed')return <IconCircleX size={18} stroke={2} aria-hidden="true" className="s-fail"/>;
 if(status==='skipped'||status==='undone')return <IconMinus size={18} stroke={2} aria-hidden="true" className="s-wait"/>;
 return <IconClock size={18} stroke={1.75} aria-hidden="true" className="s-wait"/>;
}
const STATUS_WORD={done:'done',running:'in progress',failed:'failed',pending:'waiting',skipped:'skipped',undone:'undone',undo_failed:'could not be undone'};

function RemoveDialog({site,onCancel,onRemove,error,busy,prompt}){
 const [name,setName]=useState(''),[data,setData]=useState(false);
 return <Sheet title="Remove old copy?" labelId="map-remove-title" onClose={onCancel} actions={<><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="primary" disabled={busy||name!==site.name} onClick={()=>onRemove({confirmation:name,deleteData:data})}>Remove old copy</button></>}>
  <p>The old copy of <b>{site.name}</b> is stopped and no longer needed. Removing it deletes the old containers. You will not be able to switch back.</p>
  <label className="map-check"><input type="checkbox" checked={data} onChange={e=>setData(e.target.checked)}/>Also delete the old data</label>
  {data&&<Note kind="error" icon={IconAlertTriangle}>The old data will be deleted and cannot be brought back.</Note>}
  <label className="map-field">Type the site name to confirm<input type="text" autoComplete="off" value={name} onChange={e=>setName(e.target.value)} aria-describedby="map-remove-name"/></label>
  <p id="map-remove-name" className="map-caption">{site.name}</p>
  {error&&<Note kind="error" icon={IconCircleX} role="alert">{error}</Note>}
  {prompt}
 </Sheet>;
}

function SwitchBackDialog({site,to,move,onCancel,onConfirm,error,busy,prompt}){
 const src=move?.sourceName||'the old server',when=move?.downtimeText||'a few minutes';
 return <Sheet title={`Switch back to ${src}?`} labelId="map-back-title" onClose={onCancel} actions={<><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="primary" disabled={busy} onClick={onConfirm}>Switch back</button></>}>
  <p>The site goes offline for {when}. Changes made since the switch stay on {move?.targetName||to.name} (not copied back).</p>
  {error&&<Note kind="error" icon={IconCircleX} role="alert">{error}</Note>}
  {prompt}
 </Sheet>;
}

export function ProgressDialog({site,to,client,moveId,onClose}){
 const [move,setMove]=useState(null),[err,setErr]=useState(''),[copied,setCopied]=useState(false),[busy,setBusy]=useState(false),[removing,setRemoving]=useState(false);
 const [tick,setTick]=useState(0);
 useEffect(()=>{
  let stop=false,t;
  const poll=async()=>{
   try{const m=await client.get(moveId);if(stop)return;setMove(m);if(!STOP_POLLING.has(m.state))t=setTimeout(poll,2000)}
   catch(e){if(stop)return;setErr(e.message);t=setTimeout(poll,4000)}
  };
  poll();return()=>{stop=true;clearTimeout(t)};
 },[client,moveId,tick]);
 const state=move?.state,finished=FINISHED.has(state),acts=move?.actions||{};
 const pct=Math.round(Math.min(100,Math.max(0,move?.progress||0)));
  const guard=useGuard(client),[confirmBack,setConfirmBack]=useState(false);
 async function act(fn){setBusy(true);setErr('');await guard.run(async()=>{await fn();setTick(n=>n+1)},e=>setErr(friendly(e)));setBusy(false)}
 async function copy(){const d=move.dns;try{await navigator.clipboard.writeText(`${d.type} ${d.name} ${d.value}`);setCopied(true)}catch{setCopied(false)}}
 const errNote=err&&<Note kind="error" icon={IconCircleX} role="alert">{err}</Note>;
 const record=d=>d&&<div className="map-record"><div><span className="map-caption">Record</span><code>{d.type} {d.name} {'→'} {d.value}</code></div><button type="button" onClick={copy}><IconCopy size={18} stroke={1.75} aria-hidden="true"/>{copied?'Copied':'Copy'}</button></div>;

 if(removing)return <RemoveDialog site={site} busy={busy} error={err} onCancel={()=>{setRemoving(false);setErr('')}} prompt={guard.prompt} onRemove={async b=>{setBusy(true);setErr('');await guard.run(async()=>{await client.removeOldCopy(moveId,b);setRemoving(false);setTick(n=>n+1)},e=>setErr(friendly(e)));setBusy(false)}}/>;
 if(confirmBack)return <SwitchBackDialog site={site} to={to} move={move} busy={busy} error={err} prompt={guard.prompt} onCancel={()=>{setConfirmBack(false);setErr('')}} onConfirm={async()=>{setBusy(true);setErr('');await guard.run(async()=>{await client.switchBack(moveId);setConfirmBack(false);setTick(n=>n+1)},e=>setErr(friendly(e)));setBusy(false)}}/>;

 if(state==='waiting_dns'||state==='done'){
  const d=move.dns,done=state==='done';
  return <Sheet title={done?`${site.name} is live on ${to.name}`:`${site.name} is ready on ${to.name}`} labelId="map-done-title" onClose={onClose} actions={<>
   {!done&&<button type="button" disabled={busy} onClick={()=>act(()=>client.proceed(moveId,'dns'))}>Check DNS now</button>}
   {acts.switchBack&&<button type="button" disabled={busy} onClick={()=>setConfirmBack(true)}>Switch back</button>}
   {acts.askRemoveOldCopy&&<button type="button" disabled={busy} onClick={()=>setRemoving(true)}>Remove old copy</button>}
   <button type="button" className="primary" onClick={onClose}>Close</button></>}>
   {done?<><Note kind="ok" icon={IconCircleCheck} role="status">The domain points to the new server. All done.</Note>
    {acts.askRemoveOldCopy?<p>It has been 7 days. <b>Remove old copy?</b> The old copy is stopped and still on {move.sourceName||'the old server'}.</p>:acts.switchBack&&<p className="map-caption">The old copy is kept and stopped. You can switch back within 7 days.</p>}</>
   :<><p>{d?'One last step: point your domain to the new server.':'The new copy is running.'}</p>
   {record(d)}
   <p className="map-waiting" role="status"><IconLoader2 size={18} stroke={2} aria-hidden="true" className="s-run"/>Waiting for the domain to point here{'…'}</p>
   <p className="map-caption">The old copy keeps your site online until then. When the domain points here, DockNest gets the certificate and you are done.</p></>}
   {errNote}{guard.prompt}
  </Sheet>;
 }
 const titles={failed:`Moving ${site.name} stopped`,cancelled:'Move cancelled',rolled_back:'Move undone',needs_attention:`${site.name} needs your attention`,cancelling:'Cancelling the move',rolling_back:'Undoing the move',waiting_switch:`${site.name} is ready to switch`,switching_back:'Switching back',switched_back:`${site.name} is back on ${move?.sourceName||'the old server'}`,cleaned:'Old copy removed'};
 const bad=state==='failed'||state==='needs_attention';
 const line=state==='cancelled'?(move.statusLine||'Nothing changed for your visitors.'):state==='rolled_back'?(move.statusLine||'Your site is back on the old server.'):(move?.statusLine||'Starting…');
 const cancelable=move&&acts.cancel&&!BUSY_WORD.has(state);
 const resolve=acts.resolve||[];
 const close=<button type="button" className={resolve.length?'':'primary'} onClick={onClose}>Close</button>;
 let actions;
 if(state==='needs_attention')actions=<>{close}{resolve.includes('undo')&&<button type="button" disabled={busy} onClick={()=>act(()=>client.resolve(moveId,'undo'))}>Undo</button>}{resolve.includes('retry')&&<button type="button" className="primary" disabled={busy} onClick={()=>act(()=>client.resolve(moveId,'retry'))}>Try again</button>}</>;
 else if(finished)actions=<>{acts.switchBack&&<button type="button" disabled={busy} onClick={()=>setConfirmBack(true)}>Switch back</button>}{close}</>;
 else actions=<><button type="button" disabled={!cancelable||busy} onClick={()=>act(()=>client.cancel(moveId))}>{move?.cancelLabel||'Cancel'}</button>{state==='waiting_switch'&&<button type="button" className="primary" disabled={busy} onClick={()=>act(()=>client.proceed(moveId,'owner-switch'))}>Switch now</button>}</>;
 return <Sheet title={titles[state]||`Moving ${site.name}`} labelId="map-moving-title" onClose={finished?onClose:undefined} actions={actions}>
  {!finished&&<div className="map-bar" role="progressbar" aria-label="Move progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct}><span style={{width:pct+'%'}}/></div>}
  {bad?<Note kind="error" icon={IconCircleX} role="alert">{move.error||line}</Note>:<p className="map-status" role="status">{line}</p>}
  {state==='switched_back'&&record(move.dns)}
  {errNote}{guard.prompt}
  <ol className="map-steps">{(move?.steps||[]).map(s=><li key={s.step} className={'step-'+s.state}><StepIcon status={s.state}/><span>{s.label}<span className="sr-only">, {STATUS_WORD[s.state]||s.state}</span></span></li>)}</ol>
  {!finished&&<p className="map-caption">{cancelable?'You can cancel any time before the switch. Nothing changes for visitors.':state==='waiting_switch'?'Nothing has changed for visitors yet.':'The switch has started and cannot be cancelled.'} You can leave this page.</p>}
 </Sheet>;
}

// Phone: choose where to move a site. Same dialog look as the others.
export function TargetDialog({site,servers,results,onPick,onCancel}){
 return <Sheet title={`Move ${site.name} to`} labelId="map-target-title" onClose={onCancel} actions={<button type="button" onClick={onCancel}>Cancel</button>}>
  <ul className="map-targets">{servers.map(s=>{const r=results[s.id],bad=r&&(!r.ok||r.verdict==='blocked'),wait=!r;
   return <li key={s.id}><button type="button" disabled={bad||wait} onClick={()=>onPick(s.id)}><b>{s.name}</b><span className="map-caption">{bad?why(r):wait?'Checking…':'Ready'}</span></button></li>})}
   {!servers.length&&<li className="map-caption">There is no other server to move to.</li>}</ul>
 </Sheet>;
}
