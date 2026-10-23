import React,{useEffect,useRef,useState} from 'react';
import {IconCheck,IconLoader2,IconClock,IconCopy,IconChevronDown,IconCircleX,IconAlertTriangle,IconCircleCheck,IconInfoCircle,IconMinus} from '@tabler/icons-react';
import {FINISHED,STOP_POLLING,BUSY_WORD,duration,why,warningText} from './moves-client.js';

// Native modal dialog with an explicit Tab trap; Escape closes, focus returns to the opener (handled by the page).
function Sheet({title,labelId,onClose,children,actions}){
 const ref=useRef(null);
 useEffect(()=>{const d=ref.current;if(d&&!d.open)d.showModal();return()=>{if(d?.open)d.close()}},[]);
 function trap(e){
  if(e.key!=='Tab')return;
  const items=[...ref.current.querySelectorAll('button,input,a[href],select,textarea,[tabindex]')].filter(el=>!el.disabled&&el.tabIndex>=0&&el.offsetParent!==null);
  if(!items.length){e.preventDefault();return;}
  const first=items[0],last=items[items.length-1],a=document.activeElement;
  if(e.shiftKey&&(a===first||!ref.current.contains(a))){e.preventDefault();last.focus();}
  else if(!e.shiftKey&&(a===last||!ref.current.contains(a))){e.preventDefault();first.focus();}
 }
 return <dialog ref={ref} className="map-dialog" aria-labelledby={labelId} onKeyDown={trap} onCancel={e=>{e.preventDefault();onClose?.()}}>
  <div className="map-dialog-body"><h2 id={labelId}>{title}</h2>{children}</div>
  <div className="map-dialog-foot">{actions}</div>
 </dialog>;
}

function Fact({label,value}){return <div className="map-fact"><span className="map-caption">{label}</span><b>{value}</b></div>}
const Note=({kind,icon:Icon,role,children})=><div className={'map-note map-note-'+kind} role={role}><Icon size={20} stroke={2} aria-hidden="true"/><span>{children}</span></div>;
const CHECK_ICON={ok:IconCheck,info:IconInfoCircle,warn:IconAlertTriangle,block:IconCircleX};
const CHECK_WORD={ok:'Fine',info:'Note',warn:'Warning',block:'Needs fixing'};

export function ReviewDialog({site,from,to,preview,onCancel,onMove,error,busy}){
 const blocked=!preview.ok||preview.verdict==='blocked',long=!blocked&&preview.needsMoveAnyway;
 const [anyway,setAnyway]=useState(false);
 const adv=preview.advanced||{};
 const [env,setEnv]=useState({}),[ask,setAsk]=useState(false),[open,setOpen]=useState(false);
 const canMove=!blocked&&(!long||anyway)&&!busy;
 const warns=(preview.warnings||[]).filter(w=>!w.advanced),advWarns=(preview.warnings||[]).filter(w=>w.advanced);
 const submit=()=>onMove({envRewrite:Object.keys(env).filter(k=>env[k]),askBeforeSwitch:ask,moveAnyway:long&&anyway});
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
  {long&&<label className="map-check"><input type="checkbox" checked={anyway} onChange={e=>setAnyway(e.target.checked)}/>Move anyway</label>}
  {!blocked&&<div className="map-advanced">
   <button type="button" className="map-disclose" aria-expanded={open} aria-controls="map-adv" onClick={()=>setOpen(!open)}>Advanced settings<IconChevronDown size={18} stroke={1.75} aria-hidden="true" className={open?'open':''}/></button>
   {open&&<div id="map-adv" className="map-adv-body">
    {advWarns.length>0&&<section><h3>Notes</h3>{advWarns.map(w=><p key={w.id}>{warningText(w)}</p>)}</section>}
    {adv.ports?.length>0&&<section><h3>Ports</h3>{adv.ports.map((p,i)=><p key={i}>{portsText(p)}</p>)}</section>}
    {adv.nginx&&<section><h3>Nginx file</h3><p>{adv.nginx.file||'Not found'}</p>{adv.nginx.notCopied?.length>0&&<><p>These custom lines will not be copied:</p><pre>{adv.nginx.notCopied.join('\n')}</pre></>}</section>}
    {adv.envKeys?.length>0&&<section><h3>.env values to rewrite</h3><p className="map-caption">Off by default. Turn on only the values that point to the old server.</p>{adv.envKeys.map(k=><label key={k.key} className="map-check"><input type="checkbox" checked={!!env[k.key]} onChange={e=>setEnv({...env,[k.key]:e.target.checked})}/><span><code>{k.key}</code> <span className="map-caption">{k.masked}</span></span></label>)}</section>}
    <section><h3>Testing</h3><p>{adv.tests?.mailBlocking?`Outgoing mail is blocked ${adv.tests.mailBlocking}.`:'DockNest tests the new copy before the switch.'}</p></section>
    <section><h3>Switching</h3><label className="map-check"><input type="checkbox" checked={ask} onChange={e=>setAsk(e.target.checked)}/>Ask me before switching</label></section>
    <section><h3>Old copy</h3><p>DockNest asks you what to do with it after 7 days.</p></section>
    <section><h3>Domain</h3><p>You change the DNS record yourself. DockNest shows you the record at the end.</p></section>
    {adv.checks?.length>0&&<section><h3>Checks</h3><ul className="map-checks">{adv.checks.map(c=>{const I=CHECK_ICON[c.status]||IconInfoCircle;return <li key={c.id} className={'chk-'+c.status}><I size={18} stroke={2} aria-hidden="true"/><span><b>{c.title}</b> <span className="sr-only">{CHECK_WORD[c.status]}. </span>{c.text}</span></li>})}</ul></section>}
   </div>}
  </div>}
  {error&&<Note kind="error" icon={IconCircleX} role="alert">{error}</Note>}
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

export function ProgressDialog({site,to,client,moveId,onClose}){
 const [move,setMove]=useState(null),[err,setErr]=useState(''),[copied,setCopied]=useState(false),[busy,setBusy]=useState(false);
 const [tick,setTick]=useState(0);
 useEffect(()=>{
  let stop=false,t;
  const poll=async()=>{
   try{const m=await client.get(moveId);if(stop)return;setMove(m);if(!STOP_POLLING.has(m.state))t=setTimeout(poll,2000)}
   catch(e){if(stop)return;setErr(e.message);t=setTimeout(poll,4000)}
  };
  poll();return()=>{stop=true;clearTimeout(t)};
 },[client,moveId,tick]);
 const state=move?.state,finished=FINISHED.has(state);
 const pct=Math.round(Math.min(100,Math.max(0,move?.progress||0)));
 async function act(fn){setBusy(true);setErr('');try{await fn();setTick(n=>n+1)}catch(e){setErr(e.message)}setBusy(false)}
 async function copy(){const d=move.dns;try{await navigator.clipboard.writeText(`${d.type} ${d.name} ${d.value}`);setCopied(true)}catch{setCopied(false)}}
 const errNote=err&&<Note kind="error" icon={IconCircleX} role="alert">{err}</Note>;

 if(state==='waiting_dns'||state==='done'){
  const d=move.dns,done=state==='done';
  return <Sheet title={done?`${site.name} is live on ${to.name}`:`${site.name} is ready on ${to.name}`} labelId="map-done-title" onClose={onClose} actions={<>{!done&&<button type="button" disabled={busy} onClick={()=>act(()=>client.proceed(moveId,'dns'))}>Check DNS now</button>}<button type="button" className="primary" onClick={onClose}>Close</button></>}>
   {done?<Note kind="ok" icon={IconCircleCheck} role="status">The domain points to the new server. All done.</Note>
   :<><p>{d?'One last step: point your domain to the new server.':'The new copy is running.'}</p>
   {d&&<div className="map-record"><div><span className="map-caption">Record</span><code>{d.type} {d.name} {'→'} {d.value}</code></div><button type="button" onClick={copy}><IconCopy size={18} stroke={1.75} aria-hidden="true"/>{copied?'Copied':'Copy'}</button></div>}
   <p className="map-waiting" role="status"><IconLoader2 size={18} stroke={2} aria-hidden="true" className="s-run"/>Waiting for the domain to point here{'…'}</p>
   <p className="map-caption">The old copy keeps your site online until then. When the domain points here, DockNest gets the certificate and you are done.</p></>}
   {errNote}
  </Sheet>;
 }
 const titles={failed:`Moving ${site.name} stopped`,cancelled:'Move cancelled',rolled_back:'Move undone',needs_attention:`${site.name} needs your attention`,cancelling:'Cancelling the move',rolling_back:'Undoing the move',waiting_switch:`${site.name} is ready to switch`};
 const bad=state==='failed'||state==='needs_attention';
 const line=state==='cancelled'?(move.statusLine||'Nothing changed for your visitors.'):state==='rolled_back'?(move.statusLine||'Your site is back on the old server.'):(move?.statusLine||'Starting…');
 const cancelable=move&&move.cancelable&&!BUSY_WORD.has(state);
 let actions;
 if(finished)actions=<button type="button" className="primary" onClick={onClose}>Close</button>;
 else actions=<><button type="button" disabled={!cancelable||busy} onClick={()=>act(()=>client.cancel(moveId))}>{move?.cancelLabel||'Cancel'}</button>{state==='waiting_switch'&&<button type="button" className="primary" disabled={busy} onClick={()=>act(()=>client.proceed(moveId,'owner-switch'))}>Switch now</button>}</>;
 return <Sheet title={titles[state]||`Moving ${site.name}`} labelId="map-moving-title" onClose={finished?onClose:undefined} actions={actions}>
  {!finished&&<div className="map-bar" role="progressbar" aria-label="Move progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct}><span style={{width:pct+'%'}}/></div>}
  {bad?<Note kind="error" icon={IconCircleX} role="alert">{move.error||line}</Note>:<p className="map-status" role="status">{line}</p>}
  {errNote}
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
