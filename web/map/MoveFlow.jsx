import React,{useEffect,useRef,useState} from 'react';
import {IconCheck,IconLoader2,IconClock,IconCopy,IconChevronDown,IconCircleX,IconAlertTriangle,IconCircleCheck} from '@tabler/icons-react';
import {FINISHED,LONG_DOWNTIME_SECONDS,duration} from './moves-client.js';

// Native modal dialog: the browser traps focus, closes on Escape and restores focus to the opener.
function Sheet({title,labelId,onClose,children,actions,live}){
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
  <div className="map-dialog-foot" aria-live={live}>{actions}</div>
 </dialog>;
}

function Fact({label,value}){return <div className="map-fact"><span className="map-caption">{label}</span><b>{value}</b></div>}
const Note=({kind,icon:Icon,role,children})=><div className={'map-note map-note-'+kind} role={role}><Icon size={20} stroke={2} aria-hidden="true"/><span>{children}</span></div>;

export function ReviewDialog({site,from,to,preview,onCancel,onMove,error,busy}){
 const long=preview.ok&&preview.downtimeSeconds>=LONG_DOWNTIME_SECONDS;
 const [anyway,setAnyway]=useState(false);
 const adv=preview.advanced||{};
 const [opts,setOpts]=useState({envRewrite:{},blockMail:true,dns:'manual',cloudflareToken:''});
 const [open,setOpen]=useState(false);
 const canMove=preview.ok&&(!long||anyway)&&!busy;
 const submit=()=>onMove({envRewrite:Object.keys(opts.envRewrite).filter(k=>opts.envRewrite[k]),blockOutgoingMail:opts.blockMail,oldCopy:'ask-after-7-days',dns:opts.dns==='cloudflare'&&opts.cloudflareToken?{provider:'cloudflare',token:opts.cloudflareToken}:{provider:'manual'}});
 return <Sheet title={preview.ok?'Ready to move':'Cannot move yet'} labelId="map-review-title" onClose={onCancel} actions={<><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="primary" disabled={!canMove} onClick={submit}>Move</button></>}>
  <p className="map-lead"><b>{site.name}</b> moves from {from.name} to {to.name}.</p>
  {!preview.ok&&<Note kind="error" icon={IconCircleX} role="alert">{preview.verdict}</Note>}
  {preview.ok&&<div className="map-facts">
   <Fact label="Takes about" value={duration(preview.estimateSeconds)}/>
   <Fact label="Site offline about" value={duration(preview.downtimeSeconds)}/>
   <Fact label="Can undo for" value={preview.undoDays+' days'}/>
  </div>}
  {long&&<Note kind="warn" icon={IconAlertTriangle} role="alert">Your site will be offline for a long time. {preview.warnings?.[0]||''}</Note>}
  {preview.ok&&!long&&preview.warnings?.length>0&&<Note kind="warn" icon={IconAlertTriangle}>{preview.warnings.join(' ')}</Note>}
  {long&&<label className="map-check"><input type="checkbox" checked={anyway} onChange={e=>setAnyway(e.target.checked)}/>Move anyway</label>}
  {preview.ok&&<div className="map-advanced">
   <button type="button" className="map-disclose" aria-expanded={open} aria-controls="map-adv" onClick={()=>setOpen(!open)}>Advanced settings<IconChevronDown size={18} stroke={1.75} aria-hidden="true" className={open?'open':''}/></button>
   {open&&<div id="map-adv" className="map-adv-body">
    {adv.ports&&<section><h3>Ports</h3><p>{Array.isArray(adv.ports)?adv.ports.join(', '):String(adv.ports)}</p></section>}
    {adv.nginx&&<section><h3>Nginx file</h3><p>{adv.nginx.file||'Not found'}</p>{adv.nginx.uncopiedLines?.length>0&&<><p>These custom lines will not be copied:</p><pre>{adv.nginx.uncopiedLines.join('\n')}</pre></>}</section>}
    {adv.envKeys?.length>0&&<section><h3>.env values to rewrite</h3><p className="map-caption">Off by default. Turn on only the values that point to the old server.</p>{adv.envKeys.map(k=><label key={k} className="map-check"><input type="checkbox" checked={!!opts.envRewrite[k]} onChange={e=>setOpts({...opts,envRewrite:{...opts.envRewrite,[k]:e.target.checked}})}/><code>{k}</code></label>)}</section>}
    <section><h3>Testing</h3><label className="map-check"><input type="checkbox" checked={opts.blockMail} onChange={e=>setOpts({...opts,blockMail:e.target.checked})}/>Block outgoing mail while testing</label></section>
    <section><h3>Old copy</h3><p>DockNest asks you what to do with it after 7 days.</p></section>
    <section><h3>Domain</h3>
     <label className="map-check"><input type="radio" name="map-dns" checked={opts.dns==='manual'} onChange={()=>setOpts({...opts,dns:'manual'})}/>I will change the DNS record myself</label>
     <label className="map-check"><input type="radio" name="map-dns" checked={opts.dns==='cloudflare'} onChange={()=>setOpts({...opts,dns:'cloudflare'})}/>Let DockNest change it with Cloudflare</label>
     {opts.dns==='cloudflare'&&<label className="map-field">Cloudflare token (optional)<input type="password" autoComplete="off" value={opts.cloudflareToken} onChange={e=>setOpts({...opts,cloudflareToken:e.target.value})}/></label>}
    </section>
   </div>}
  </div>}
  {error&&<Note kind="error" icon={IconCircleX} role="alert">{error}</Note>}
 </Sheet>;
}

function StepIcon({status}){
 if(status==='done')return <IconCheck size={18} stroke={2} aria-hidden="true" className="s-done"/>;
 if(status==='running')return <IconLoader2 size={18} stroke={2} aria-hidden="true" className="s-run"/>;
 if(status==='failed')return <IconCircleX size={18} stroke={2} aria-hidden="true" className="s-fail"/>;
 return <IconClock size={18} stroke={1.75} aria-hidden="true" className="s-wait"/>;
}
const STATUS_WORD={done:'done',running:'in progress',failed:'failed',waiting:'waiting'};

export function ProgressDialog({site,to,client,moveId,onClose}){
 const [move,setMove]=useState(null),[err,setErr]=useState(''),[copied,setCopied]=useState(false),[cancelling,setCancelling]=useState(false);
 useEffect(()=>{
  let stop=false,t;
  const tick=async()=>{
   try{const m=await client.get(moveId);if(stop)return;setMove(m);setErr('');if(m.state!=='done'&&m.state!=='failed'&&m.state!=='cancelled')t=setTimeout(tick,2000)}
   catch(e){if(stop)return;setErr(e.message);t=setTimeout(tick,4000)}
  };
  tick();return()=>{stop=true;clearTimeout(t)};
 },[client,moveId]);
 const state=move?.state,finished=FINISHED.has(state),awaiting=state==='waiting_dns'||state==='done';
 const cancelable=move&&!finished&&!awaiting&&move.cancelable!==false;
 const pct=Math.round(Math.min(1,Math.max(0,move?.progress||0))*100);
 async function cancel(){setCancelling(true);try{await client.cancel(moveId)}catch(e){setErr(e.message)}setCancelling(false)}
 async function copy(){const d=move.dns,text=`${d.type} ${d.name} ${d.value}`;try{await navigator.clipboard.writeText(text);setCopied(true)}catch{setCopied(false)}}

 if(awaiting){
  const d=move.dns,done=state==='done';
  return <Sheet title={done?`${site.name} is live on ${to.name}`:`${site.name} is ready on ${to.name}`} labelId="map-done-title" onClose={onClose} actions={<button type="button" className="primary" onClick={onClose}>Close</button>}>
   {done?<Note kind="ok" icon={IconCircleCheck} role="status">The domain points to the new server. All done.</Note>
   :<><p>One last step: point your domain to the new server.</p>
   {d&&<div className="map-record"><div><span className="map-caption">Record</span><code>{d.type} {d.name} {'→'} {d.value}</code></div><button type="button" onClick={copy}><IconCopy size={18} stroke={1.75} aria-hidden="true"/>{copied?'Copied':'Copy'}</button></div>}
   <p className="map-waiting" role="status"><IconLoader2 size={18} stroke={2} aria-hidden="true" className="s-run"/>Waiting for the domain to point here{'…'}</p>
   <p className="map-caption">The old copy keeps your site online until then. When the domain points here, DockNest gets the certificate and you are done.</p></>}
  </Sheet>;
 }
 const title=state==='failed'?`Moving ${site.name} stopped`:state==='cancelled'?'Move cancelled':`Moving ${site.name}`;
 return <Sheet title={title} labelId="map-moving-title" onClose={finished?onClose:undefined} actions={finished?<button type="button" className="primary" onClick={onClose}>Close</button>:<button type="button" disabled={!cancelable||cancelling} onClick={cancel}>Cancel</button>}>
  {!finished&&<div className="map-bar" role="progressbar" aria-label="Move progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct}><span style={{width:pct+'%'}}/></div>}
  <p className="map-status" role="status">{state==='failed'?(move.statusLine||'Something went wrong. Your site is still running on the old server.'):state==='cancelled'?'Nothing changed for your visitors.':(move?.statusLine||'Starting…')}</p>
  {err&&<Note kind="error" icon={IconCircleX} role="alert">{err}</Note>}
  <ol className="map-steps">{(move?.steps||[]).map(s=><li key={s.id} className={'step-'+s.status}><StepIcon status={s.status}/><span>{s.title}<span className="sr-only">, {STATUS_WORD[s.status]||s.status}</span></span></li>)}</ol>
  {!finished&&<p className="map-caption">{cancelable?'You can cancel any time before the switch. Nothing changes for visitors.':'The switch has started and cannot be cancelled.'} You can leave this page.</p>}
 </Sheet>;
}

// Phone: choose where to move a site. Same dialog look as the others.
export function TargetDialog({site,servers,results,onPick,onCancel}){
 return <Sheet title={`Move ${site.name} to`} labelId="map-target-title" onClose={onCancel} actions={<button type="button" onClick={onCancel}>Cancel</button>}>
  <ul className="map-targets">{servers.map(s=>{const r=results[s.id],bad=r&&!r.ok,wait=!r;
   return <li key={s.id}><button type="button" disabled={bad||wait} onClick={()=>onPick(s.id)}><b>{s.name}</b><span className="map-caption">{bad?r.verdict:wait?'Checking…':'Ready'}</span></button></li>})}
   {!servers.length&&<li className="map-caption">There is no other server to move to.</li>}</ul>
 </Sheet>;
}
