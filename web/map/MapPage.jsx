import React,{useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {formatBytes} from '../../shared/format-bytes.js';
import {IconServer,IconBox,IconAppWindow,IconDatabaseExport,IconPlus,IconMinus,IconArrowsMaximize,IconMap2,IconAlertTriangle,IconCircleCheck,IconClock,IconInfoCircle,IconCopy,IconCheck} from '@tabler/icons-react';
import {StatusLabel,IconButton} from '../system.jsx';
import {count} from '../plural.js';
import {layoutMap,groupForList,databasesOf,domainsOf,elbow,METRICS} from './layout.js';
import {createMovesClient,blocked,why,friendly} from './moves-client.js';
import {Sheet,ReviewDialog,ProgressDialog,TargetDialog,InstallConfirmDialog,InstallProgressDialog,CommandDialog} from './MoveFlow.jsx';
import {formatDate} from '../date-format.js';
import {SidePanel,AddToMap,AddToServer,DiscoverFooter,useDiscovery,Defs} from './Panels.jsx';
import {createAlertsClient,KIND_LABEL} from './alerts-client.js';
import {AlertPanel,CredentialsPanel,PickSheet,DeleteChannelSheet,SourceAlerts,AlertsList,KindIcon,DockNestIcon,srcKey} from './Alerts.jsx';
import './map.css';

const bytes=v=>v?formatBytes(v):'';
const MIN=0.2,MAX=2,FIT_MIN=0.45; // fit never scales above 100%; below 45% the map is too small to read, so the user pans
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const short=(v,n=40)=>typeof v==='string'&&v.length>n?v.slice(0,Math.ceil((n-1)/2))+'…'+v.slice(-Math.floor((n-1)/2)):v; // long names are shortened in sentences; the full name stays in the title and the details
const HIT=16; // forgiving drop area around a server

function serverStatus(server){
 if(server.status==='connected')return <StatusLabel state="success">Connected</StatusLabel>;
 if(!server.status||server.status==='unchecked')return <StatusLabel state="queued">Not checked yet</StatusLabel>;
 return <StatusLabel state="failed">Needs attention</StatusLabel>;
}
function serverFacts(server,sites){
 const free=bytes(server.capabilities?.freeBytes);
 return count(sites,'site')+(free?' · '+free+' free':'');
}
const siteFacts=site=>Array.isArray(site.config?.containers)?count(site.config.containers.length,'container'):'Docker site';
const SiteIcon=({site,size})=>{const I=!site.config?.containers?.length&&site.config?.documentRoot?IconAppWindow:IconBox;return <I size={size} stroke={1.5} aria-hidden="true"/>};
// What a storage destination reports: free space when it has a known size.
function storageFacts(t){
 const cap=Number(t.capacity_bytes||t.capacityBytes||0),used=Number(t.trackedBytes||0);
 if(t.kind!=='s3'&&cap>0)return {text:`${bytes(Math.max(0,cap-used))||'0 B'} free of ${bytes(cap)}`,pct:clamp(used/cap,0,1)};
 return {text:used?`${bytes(used)} stored`:'Nothing stored yet',pct:null};
}

// Only data DockNest already holds is shown; a copy button sits next to values people paste elsewhere.
function CopyText({text,label}){
 const [done,setDone]=useState(false),t=useRef(null);
 useEffect(()=>()=>clearTimeout(t.current),[]);
 return <button type="button" className={'icon-button map-copy'+(done?' done':'')} title={done?'Copied':'Copy'} aria-label={'Copy '+label} onClick={async()=>{try{await navigator.clipboard.writeText(text);setDone(true);clearTimeout(t.current);t.current=setTimeout(()=>setDone(false),1500)}catch{}}}>{done?<IconCheck size={16} stroke={1.75} aria-hidden="true"/>:<IconCopy size={16} stroke={1.75} aria-hidden="true"/>}</button>;
}
const Val=({text,label,children})=><span className="map-val"><span className="map-val-text" title={text}>{children||text}</span><CopyText text={text} label={label}/></span>;
function useNarrow(){
 const q='(max-width:767px)',[narrow,setNarrow]=useState(()=>matchMedia(q).matches);
 useEffect(()=>{const m=matchMedia(q),h=()=>setNarrow(m.matches);m.addEventListener('change',h);return()=>m.removeEventListener('change',h)},[]);
 return narrow;
}

function MapList({groups,storage,canMove,onMoveTo,onDetails,onAddSite,onAdd,alertsList}){
 return <div className="map-list">
 {canMove&&<div className="map-list-top"><button type="button" onClick={e=>onAdd(e.currentTarget)}><IconPlus size={18} stroke={1.75} aria-hidden="true"/>Add to the map</button></div>}
 {groups.map(({server,sites})=>{
  const id='map-list-'+(server?server.id:'unassigned');
  return <section key={id} className="map-list-group" aria-labelledby={id}>
   <div className="map-list-head"><IconServer size={20} stroke={1.75} aria-hidden="true"/><div><h2 id={id}>{server?server.name:'Not on a server'}</h2>{server&&<>{serverStatus(server)}<span className="map-caption">{serverFacts(server,sites.length)}</span></>}</div></div>
   {server&&<div className="map-list-actions"><button type="button" onClick={e=>onDetails({kind:'server',id:server.id},e.currentTarget)}>Details</button>{canMove&&<button type="button" onClick={e=>onAddSite(server.id,e.currentTarget)}>Add site</button>}</div>}
   {sites.length?<ul>{sites.map(s=><li key={s.id}><SiteIcon site={s} size={18}/><div className="map-list-text"><span className="map-name">{s.name}</span><span className="map-caption">{server?siteFacts(s):'Not connected'}</span></div><div className="map-list-actions"><button type="button" onClick={e=>onDetails({kind:'site',id:s.id},e.currentTarget)}>Details</button>{canMove&&server&&<button type="button" className="map-moveto" onClick={e=>onMoveTo(s.id,e.currentTarget)}>Move to{'…'}</button>}</div></li>)}</ul>:<p className="map-caption map-none">No sites on this server yet.</p>}
  </section>;
 })}
 {storage.length>0&&<section className="map-list-group" aria-labelledby="map-list-storage">
  <div className="map-list-head"><IconDatabaseExport size={20} stroke={1.75} aria-hidden="true"/><div><h2 id="map-list-storage">Backup storage</h2></div></div>
  <div className="map-list-store">{storage.map(t=>{const f=storageFacts(t);return <div key={t.id}><span className="map-name">{t.name}</span><span className="map-caption">{f.text}</span>{f.pct!==null&&<div className="map-meter" role="meter" aria-label={t.name+' used'} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(f.pct*100)}><span style={{width:Math.round(f.pct*100)+'%'}}/></div>}<div className="map-list-actions"><button type="button" onClick={e=>onDetails({kind:'storage',id:t.id},e.currentTarget)}>Details</button></div></div>})}</div>
 </section>}
 {alertsList}
 </div>;
}

export function MapPage({servers=[],sites=[],backups=[],policies=[],jobs=[],user,api,onAddServer,onAddStorage,onAddSite,onOpenSite,onOpenServer,onOpenStorage,onRefresh}){
 const narrow=useNarrow(),canMove=user?.role==='admin';
 const [targets,setTargets]=useState(null),[adrag,setAdrag]=useState(null),[hot,setHot]=useState(null),[positions,setPositions]=useState({}),[dragPos,setDragPos]=useState(null),[sel,setSel]=useState(null),[ghost,setGhost]=useState(null),[,bump]=useState(0);
 const H=useRef({past:[],future:[]}),dragItem=useRef(null);
 // Backup storage comes from the destinations list (admins). Each site backs up to the destination its backups use; the
 // state does not name one per backup, so a site with backups or an active schedule uses the active destination.
 useEffect(()=>{if(!canMove||!api)return;let live=true;api('/storage-targets').then(r=>{if(live&&Array.isArray(r?.targets))setTargets(r)}).catch(()=>{});return()=>{live=false}},[canMove,api]);
 const storage=useMemo(()=>targets?.targets||[],[targets]);
 const backupOf=useMemo(()=>{
  const out={},active=targets?.activeTargetId,known=new Set(storage.map(t=>t.id));
  for(const b of backups||[]){const t=b.targetId||b.storageTargetId||active;if(b.siteId&&known.has(t)&&!out[b.siteId])out[b.siteId]=t}
  for(const p of policies||[])if(p.enabled&&p.siteId&&!out[p.siteId]&&known.has(active))out[p.siteId]=active;
  return out;
 },[backups,policies,targets,storage]);
 // Alerts (administrators): channels and lines from /api/alerts. Nothing is drawn until a channel exists.
 const alertsClient=useMemo(()=>createAlertsClient(api||(()=>Promise.reject(new Error('Alerts are not available.')))),[api]);
 const [alerts,setAlerts]=useState({channels:[],rules:[],credentials:[]}),[aflow,setAflow]=useState(null);
 const loadAlerts=useCallback(()=>{if(!canMove||!api)return Promise.resolve();return alertsClient.load().then(r=>setAlerts({channels:Array.isArray(r?.channels)?r.channels:[],rules:Array.isArray(r?.rules)?r.rules:[],credentials:Array.isArray(r?.credentials)?r.credentials:[]})).catch(()=>{})},[alertsClient,canMove,api]);
 useEffect(()=>{loadAlerts();const t=setInterval(loadAlerts,30000);return()=>clearInterval(t)},[loadAlerts]);
 const livePos=useMemo(()=>dragPos?{...positions,[dragPos.key]:{x:dragPos.x,y:dragPos.y}}:positions,[positions,dragPos]);
 const target=useMemo(()=>layoutMap(servers,sites,{storage,backupOf,alerts,positions:livePos}),[servers,sites,storage,backupOf,alerts,livePos]);
 // When the arrangement changes (Tidy up, Save changes, a reconnect, new data) nodes glide to their new places and the lines follow every frame.
 // A fresh page, a node being dragged by hand and "reduce motion" all place nodes at once.
 const anim=useRef(null),shown=useRef(null),[tick,setTick]=useState(0);
 useLayoutEffect(()=>{
  const next=Object.fromEntries(Object.entries(target.keys).map(([k,n])=>[k,{x:n.x,y:n.y}])),from=shown.current;
  const moves=from&&Object.keys(next).some(k=>from[k]&&(Math.abs(from[k].x-next[k].x)>1||Math.abs(from[k].y-next[k].y)>1));
  if(dragPos||!moves||(typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches)){anim.current=null;shown.current=next;setTick(n=>n+1);return}
  const start=performance.now(),dur=420,begin={...from};let raf;
  anim.current=true;
  const step=now=>{
   const u=Math.min(1,(now-start)/dur),e=u<.5?2*u*u:1-Math.pow(-2*u+2,2)/2;
   shown.current=Object.fromEntries(Object.keys(next).map(k=>{const a=begin[k]||next[k];return [k,{x:a.x+(next[k].x-a.x)*e,y:a.y+(next[k].y-a.y)*e}]}));
   if(u>=1){anim.current=null;shown.current=next}else raf=requestAnimationFrame(step);
   setTick(n=>n+1);
  };
  raf=requestAnimationFrame(step);
  return()=>cancelAnimationFrame(raf);
 },[target]);
 const layout=useMemo(()=>anim.current?layoutMap(servers,sites,{storage,backupOf,alerts,positions:shown.current}):target,[target,tick]);
 const groups=useMemo(()=>groupForList(servers,sites),[servers,sites]);
 const byId=useMemo(()=>({servers:Object.fromEntries(servers.map(s=>[s.id,s])),sites:Object.fromEntries(sites.map(s=>[s.id,s])),storage:Object.fromEntries(storage.map(s=>[s.id,s]))}),[servers,sites,storage]);
 const view=useRef(null),mode=useRef('home'),pointers=useRef(new Map()),gesture=useRef(null);
 const [t,setT]=useState({x:0,y:0,k:1}),[drag,setDrag]=useState(null),[note,setNote]=useState('');
 const client=useMemo(()=>createMovesClient(api||(()=>Promise.reject(new Error('Moving is not available.')))),[api]);
 // One change at a time: edit = {siteId, targetId} (a pending move) or {siteId, targetId:null, loose:{x,y}} (line pulled off, not connected)
 const [panel,setPanel]=useState(null);
 function openPanel(p,el){opener.current=el;setFlow(null);setGhost(null);if(['server','site','storage','alert','docknest'].includes(p.kind))setSel({type:'node',key:p.kind==='docknest'?'docknest:root':p.kind+':'+p.id});setPanel(p)}
 function closePanel(back=true){setPanel(null);setGhost(null);setSel(null);if(back)setTimeout(()=>opener.current?.focus?.(),0)}
 useEffect(()=>{if(!panel||narrow)return;const h=e=>{if(e.key==='Escape'&&!e.defaultPrevented&&!document.querySelector('dialog[open]'))closePanel(true)};document.addEventListener('keydown',h);return()=>document.removeEventListener('keydown',h)},[panel,narrow]);
 const [edit,setEdit]=useState(null),[checks,setChecks]=useState({}),[flow,setFlow]=useState(null),opener=useRef(null);
 const pending=edit&&edit.targetId?edit:null,unconnected=edit&&!edit.targetId?edit:null;
 const siteChecks=checks[drag?.id]||{};
 function precheck(siteId){
  const home=byId.sites[siteId]?.serverId;
  servers.filter(s=>s.id!==home).forEach(s=>{
   if(checks[siteId]?.[s.id])return;
   client.preview(siteId,s.id).then(r=>setChecks(c=>({...c,[siteId]:{...c[siteId],[s.id]:r}}))).catch(()=>{});
  });
 }
 function openReview(siteId,targetId){
  setFlow(f=>({kind:'review',siteId,targetId,busy:true,preview:f?.preview}));
  client.preview(siteId,targetId).then(p=>setFlow(f=>f&&{...f,kind:'review',preview:p,busy:false,error:''})).catch(e=>setFlow(f=>f&&{...f,error:e.message,busy:false,preview:{ok:false,blockers:[friendly(e)]}}));
 }
 const [moves,setMoves]=useState([]);
 const loadMoves=useCallback(()=>{if(canMove)client.list().then(r=>setMoves(Array.isArray(r?.moves)?r.moves:[])).catch(()=>{})},[client,canMove]);
 useEffect(()=>{loadMoves();const t=setInterval(loadMoves,15000);return()=>clearInterval(t)},[loadMoves]);
 function closeFlow(finished){setFlow(null);if(finished){setEdit(null);setPositions({});H.current={past:[],future:[]};bump(n=>n+1)}loadMoves();setTimeout(()=>opener.current?.focus?.(),0)}
 function openMove(m,button){opener.current=button;setFlow({kind:'progress',siteId:m.siteId,targetId:m.targetServerId,moveId:m.id})}
 const strip=canMove&&moves.length>0&&<ul className="map-moves" aria-label="Moves">{moves.map(m=><li key={m.id}><span><b>{m.siteName}</b> <span className="map-caption">{m.actions?.resolve?.length?'Needs your attention':m.actions?.askRemoveOldCopy?'The old copy can be removed':m.state==='done'?'Moved. You can still switch back.':m.statusLine||'Moving'}</span></span><button type="button" onClick={e=>openMove(m,e.currentTarget)}>Open</button></li>)}</ul>;
 async function startMove(options){
  const {envRewrite,askBeforeSwitch,moveAnyway,dnsMode}=options;
  setFlow(f=>({...f,busy:true,error:''}));
  try{
   let p=flow.preview;
   // Advanced choices change the plan, so ask for a fresh preview that includes them.
   if(envRewrite.length||askBeforeSwitch||dnsMode==='cloudflare')p=await client.preview(flow.siteId,flow.targetId,{dnsMode,envRewrite,askBeforeSwitch});
   if(blocked(p)){setFlow(f=>({...f,preview:p,busy:false}));return;}
   await client.start(p.id,{preflightHash:p.preflightHash,moveAnyway});
   setFlow(f=>({kind:'progress',siteId:f.siteId,targetId:f.targetId,moveId:p.id}));
  }catch(e){
   if(e.code==='REAUTH_REQUIRED'){setFlow(f=>({...f,busy:false}));throw e;}
   if(e.code==='PREFLIGHT_CHANGED'){
    try{const p=await client.preview(flow.siteId,flow.targetId);setFlow(f=>({...f,preview:p,busy:false,error:'Something changed on the servers. Please review and press Move again.'}));return;}catch{}
   }
   setFlow(f=>({...f,busy:false,error:friendly(e)}));
  }
 }
 function moveTo(siteId,button){
  setPanel(null);
  if(edit&&edit.siteId!==siteId){setNote('Save or cancel the current change first.');return;}
  opener.current=button;precheck(siteId);setFlow({kind:'target',siteId});
 }
 // Connect a site to a server (drop on its port, or the keyboard / phone sheet). The same server again undoes the change.
 function connect(siteId,targetId,loose){
  pushHist();
  const name=short(byId.sites[siteId]?.name),target=short(byId.servers[targetId]?.name),r=checks[siteId]?.[targetId];
  if(targetId===byId.sites[siteId]?.serverId){setEdit(null);setNote(`${name} stays on ${target}. Nothing changes.`);return;}
  if(r&&blocked(r)){setEdit({siteId,targetId:null,loose:loose||edit?.loose||null});setNote(`${name} cannot move to ${target}. ${why(r)} ${name} is not connected.`);return;}
  setEdit({siteId,targetId});setNote(`${name} will move to ${target}. Choose Save changes to continue.`);
 }
 function disconnect(siteId,loose){
  const s=layout.sites.find(x=>x.id===siteId);if(!s)return;
  pushHist();
  setEdit({siteId,targetId:null,loose:loose||{x:s.x-70,y:s.y+s.h+30}});
  setNote(`${short(byId.sites[siteId]?.name)} is not connected. Connect it to a server to save.`);
 }
 function choose(siteId,targetId){connect(siteId,targetId);closeFlow(false);}
 function cancelEdit(){pushHist();setEdit(null);setNote('Change cancelled. Nothing was changed.')}

 // Alert lines. A line is a rule: source -> channel with the events it carries. One rule per source and channel.
 const sourceOf=r=>({kind:r.sourceKind,id:r.sourceId||null,name:r.sourceKind==='docknest'?'DockNest':(r.sourceKind==='server'?byId.servers[r.sourceId]:byId.sites[r.sourceId])?.name||'Something removed'});
 const sourceName=r=>sourceOf(r).name;
 const ruleFor=(source,channelId)=>alerts.rules.find(r=>r.channelId===channelId&&sameSource(r,source))||null;
 const focusBack=()=>setTimeout(()=>opener.current?.focus?.(),0);
 function openAlert(channelId,source,el){if(el)opener.current=el;setFlow(null);setAflow(null);setSel({type:'node',key:'alert:'+channelId});setPanel({kind:'alert',id:channelId,preselect:source||null,scrollTo:source?srcKey(source):null,n:Date.now()})}
 const editRule=(rule,el)=>openAlert(rule.channelId,sourceOf(rule),el);
 function pickChannel(source,el){if(el)opener.current=el;setPanel(null);setFlow(null);setAflow({kind:'pick',source})}
 function addChannel(kind,el,source){if(el)opener.current=el;setFlow(null);setAflow(null);setPanel({kind:'alert-new',channelKind:kind,preselect:source||null,scrollTo:source?srcKey(source):null,n:Date.now()})}
 function closeAflow(){setAflow(null);focusBack()}
 const alertSource=(k,id)=>k==='docknest'?{kind:'docknest',id:null,name:'DockNest',from:layout.docknest?.alertOut}:k==='server'?{kind:'server',id,name:byId.servers[id]?.name,from:layout.servers.find(n=>n.id===id)?.alertOut}:{kind:'site',id,name:byId.sites[id]?.name,from:[...layout.sites,...layout.unassigned].find(n=>n.id===id)?.alertOut};

 // Free layout is for working during an edit only: moved nodes are never saved. Save changes, or opening the Map again, re-arranges everything automatically.
 const snap=()=>({positions,edit});
 function pushHist(){H.current.past.push(snap());if(H.current.past.length>50)H.current.past.shift();H.current.future=[];bump(n=>n+1)}
 function restore(from,to,word){const h=H.current;if(!h[from].length)return;h[to].push(snap());const v=h[from].pop();setPositions(v.positions);setEdit(v.edit);bump(n=>n+1);setNote(word)}
 const undo=()=>restore('past','future','Undone.'),redo=()=>restore('future','past','Redone.');
 useEffect(()=>{
  const h=e=>{if(e.key==='Escape'){setSel(null);return}if(!(e.ctrlKey||e.metaKey)||e.altKey||!canMove)return;const k=e.key.toLowerCase();if(k!=='z'&&k!=='y')return;if(/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName||'')||document.querySelector('dialog[open]'))return;e.preventDefault();if(k==='y'||e.shiftKey)redo();else undo()};
  document.addEventListener('keydown',h);return()=>document.removeEventListener('keydown',h);
 });
 function tidy(){pushHist();setPositions({});setNote('The map is tidy again. Undo brings your layout back.')}

 // The default view is always 100%: centred when the map fits, otherwise the top-left of the content. Only the Fit button and the 0 key shrink it.
 const home=useCallback(()=>{
  const el=view.current;if(!el)return;
  const w=el.clientWidth,h=el.clientHeight;if(!w||!h)return;
  setT({k:1,x:Math.max(0,(w-layout.width)/2),y:Math.max(0,(h-layout.height)/2)});
 },[layout.width,layout.height]);
 const fit=useCallback(()=>{
  const el=view.current;if(!el)return;
  const w=el.clientWidth,h=el.clientHeight;if(!w||!h)return;
  const k=clamp(Math.min(w/layout.width,h/layout.height),FIT_MIN,1);
  setT({k,x:Math.max(0,(w-layout.width*k)/2),y:Math.max(0,(h-layout.height*k)/2)});
 },[layout.width,layout.height]);
 // The map takes the height that is left on screen, so the page never scrolls and the hint below stays in view
 const [viewH,setViewH]=useState(null);
 const size=useCallback(()=>{
  // From the map's top edge (as if the page were not scrolled) to the window bottom, minus the hint and status line below it
  const el=view.current;if(!el)return;
  const box=el.getBoundingClientRect(),last=el.closest('.map-root').querySelector('.map-live')||el;
  const below=last.getBoundingClientRect().bottom-box.bottom,top=box.top+window.scrollY;
  const next=Math.max(360,Math.floor(window.innerHeight-top-below-24));
  if(Math.abs(next-box.height)>1)setViewH(next);
 },[]);
 useLayoutEffect(()=>{if(narrow||!servers.length)return;size();window.addEventListener('resize',size);return()=>window.removeEventListener('resize',size)},[narrow,size,servers.length,note,!!strip,!!edit]);
 const apply=useCallback(()=>{if(mode.current==='fit')fit();else if(mode.current==='home')home()},[fit,home]);
 useLayoutEffect(()=>{if(narrow||!servers.length)return;apply();},[narrow,apply,servers.length,viewH]);
 useEffect(()=>{
  const el=view.current;if(!el||typeof ResizeObserver==='undefined')return;
  const ro=new ResizeObserver(()=>apply());ro.observe(el);return()=>ro.disconnect();
 },[apply,narrow,servers.length]);

 const zoomAt=useCallback((factor,cx,cy)=>{
  mode.current='user';
  setT(p=>{const k=clamp(p.k*factor,MIN,MAX),r=k/p.k;return {k,x:cx-(cx-p.x)*r,y:cy-(cy-p.y)*r}});
 },[]);
 const zoomCentre=factor=>{const el=view.current;zoomAt(factor,el.clientWidth/2,el.clientHeight/2)};
 useEffect(()=>{
  const el=view.current;if(!el)return;
  const wheel=e=>{e.preventDefault();const r=el.getBoundingClientRect();zoomAt(Math.exp(-e.deltaY*0.0015),e.clientX-r.left,e.clientY-r.top)};
  el.addEventListener('wheel',wheel,{passive:false});return()=>el.removeEventListener('wheel',wheel);
 },[zoomAt,narrow,servers.length]);

 const toCanvas=(e)=>{const r=view.current.getBoundingClientRect();return [(e.clientX-r.left-t.x)/t.k,(e.clientY-r.top-t.y)/t.k]};
 const alertAt=(px,py)=>layout.alerts.find(n=>px>=n.x-HIT&&px<=n.x+n.w+HIT&&py>=n.y-HIT&&py<=n.y+n.h+HIT);
 const serverAt=(px,py)=>layout.servers.find(s=>{const b=s.block;return px>=s.x-HIT&&px<=s.x+s.w+HIT&&py>=s.y-HIT&&py<=b.y+b.h+HIT&&px>=b.x&&px<=b.x+b.w});
 // Only the end of a site's own incoming line (its port, or the loose end) starts a reconnect. Databases and domains are locked to their site.
 function down(e){
  if(e.button>0)return;
  pointers.current.set(e.pointerId,{x:e.clientX,y:e.clientY});
  const port=canMove&&e.target.closest?.('[data-port-site]'),aport=canMove&&e.target.closest?.('[data-alert-src]');
  if(pointers.current.size===2){gesture.current={type:'pinch'};const [a,b]=[...pointers.current.values()];gesture.current.d=Math.hypot(a.x-b.x,a.y-b.y);setDrag(null);setAdrag(null);}
  else if(aport){const [k,...r]=aport.dataset.alertSrc.split(':'),src=alertSource(k,r.join(':')),[px,py]=toCanvas(e);if(src.kind==='site')precheck(src.id);gesture.current={type:'alert',src,x:e.clientX,y:e.clientY,moved:false};setAdrag({src,px,py,over:null});}
  else if(port&&edit&&edit.siteId!==port.dataset.portSite){setNote('Save or cancel the current change first.');gesture.current=null;}
  else if(port){const id=port.dataset.portSite;precheck(id);const [px,py]=toCanvas(e);gesture.current={type:'drag',id,x:e.clientX,y:e.clientY,moved:false};setDrag({id,px,py,over:null});}
  else{
   const node=e.target.closest?.('[data-node]')||null,nk=node?.dataset.node,kind=nk?nk.split(':')[0]:'',n=nk&&layout.keys?.[nk];
   if(canMove&&n&&['server','site','storage','alert','docknest'].includes(kind))gesture.current={type:'node',key:nk,node,sx:e.clientX,sy:e.clientY,ox:n.x,oy:n.y,moved:false};
   else gesture.current={type:'pan',x:e.clientX,y:e.clientY,sx:e.clientX,sy:e.clientY,moved:false,node};
  }
  e.currentTarget.setPointerCapture?.(e.pointerId);
 }
 function move(e){
  if(!pointers.current.has(e.pointerId))return;
  const prev=pointers.current.get(e.pointerId);pointers.current.set(e.pointerId,{x:e.clientX,y:e.clientY});
  const g=gesture.current;if(!g)return;
  if(g.type==='pinch'&&pointers.current.size===2){
   const [a,b]=[...pointers.current.values()],d=Math.hypot(a.x-b.x,a.y-b.y),r=view.current.getBoundingClientRect();
   if(g.d)zoomAt(d/g.d,(a.x+b.x)/2-r.left,(a.y+b.y)/2-r.top);g.d=d;
  }else if(g.type==='pan'){
   if(!g.moved&&Math.hypot(e.clientX-g.sx,e.clientY-g.sy)<=4)return; // a click is not a drag
   g.moved=true;mode.current='user';setT(p=>({...p,x:p.x+e.clientX-prev.x,y:p.y+e.clientY-prev.y}));}
  else if(g.type==='node'){
   if(!g.moved&&Math.hypot(e.clientX-g.sx,e.clientY-g.sy)<=4)return;
   g.moved=true;const sn=v=>Math.round(v/16)*16;setDragPos({key:g.key,x:Math.max(0,sn(g.ox+(e.clientX-g.sx)/t.k)),y:Math.max(0,sn(g.oy+(e.clientY-g.sy)/t.k))});
  }
  else if(g.type==='alert'){
   if(Math.hypot(e.clientX-g.x,e.clientY-g.y)>6)g.moved=true;
   const [px,py]=toCanvas(e),over=alertAt(px,py),sv=!over&&g.src.kind==='site'?serverAt(px,py):null;
   setAdrag({src:g.src,px,py,over:over?over.id:null,overServer:sv&&sv.id!==byId.sites[g.src.id]?.serverId?sv.id:null});
  }
  else if(g.type==='drag'){
   if(Math.hypot(e.clientX-g.x,e.clientY-g.y)>6)g.moved=true;
   const [px,py]=toCanvas(e),over=serverAt(px,py);
   setDrag({id:g.id,px,py,over:over?over.id:null});
  }
 }
 function up(e){
  pointers.current.delete(e.pointerId);
  const g=gesture.current;
  if(g?.type==='pan'&&!g.moved&&g.node&&e.type==='pointerup'){const [kind,...rest]=g.node.dataset.node.split(':'),rid=rest.join(':');if(kind==='rule'){setSel({type:'line',id:'r'+rid});if(rid.startsWith('bundle:'))openAlert(rid.slice(7),null,view.current);else{const r=alerts.rules.find(x=>x.id===rid);if(r)editRule(r,view.current)}}else openPanel({kind,id:rid},g.node);}
  if(g?.type==='node'&&e.type==='pointerup'){if(g.moved&&dragPos){pushHist();setPositions(p=>({...p,[dragPos.key]:{x:dragPos.x,y:dragPos.y}}));setNote('Moved. Undo with Ctrl+Z.')}else if(!g.moved){const [kind,...rest]=g.node.dataset.node.split(':');openPanel({kind,id:rest.join(':')},g.node)}}
  if(g?.type==='pan'&&!g.moved&&!g.node&&e.type==='pointerup')setSel(null);
  if(g?.type==='alert'&&g.moved&&e.type==='pointerup'){if(adrag?.over)openAlert(adrag.over,g.src,view.current);else if(adrag?.overServer)connect(g.src.id,adrag.overServer,{x:adrag.px,y:adrag.py});}
  if(g?.type==='drag'&&g.moved&&drag){
   if(drag.over)connect(g.id,drag.over,{x:drag.px,y:drag.py});
   else disconnect(g.id,{x:drag.px,y:drag.py});
  }
  if(!pointers.current.size){gesture.current=null;setDrag(null);setAdrag(null);setDragPos(null);}
 }
 function drop(e){
  const item=dragItem.current;dragItem.current=null;if(!item||!canMove)return;e.preventDefault();
  const [px,py]=toCanvas(e),sn=v=>Math.max(0,Math.round(v/16)*16),g={x:sn(px-32),y:sn(py-32),kind:item.kind,name:item.name};
  if(item.kind==='server'){setGhost(g);onAddServer?.()}
  else if(item.kind==='storage'){setGhost(g);onAddStorage?.()}
  else if(item.kind==='site'){setGhost(g);setPanel(null);onAddSite?.(item.serverId,item.name,item.choice)}
  else{addChannel(item.kind);setGhost(g)}
 }
 function key(e){
  const step=48;let handled=true;
  if(e.key==='ArrowLeft')setT(p=>({...p,x:p.x+step}));
  else if(e.key==='ArrowRight')setT(p=>({...p,x:p.x-step}));
  else if(e.key==='ArrowUp')setT(p=>({...p,y:p.y+step}));
  else if(e.key==='ArrowDown')setT(p=>({...p,y:p.y-step}));
  else if(e.key==='+'||e.key==='=')zoomCentre(1.25);
  else if(e.key==='-')zoomCentre(0.8);
  else if(e.key==='0'){mode.current='fit';fit();}
  else handled=false;
  if(handled){e.preventDefault();if(/Arrow/.test(e.key))mode.current='user';}
 }

 if(!servers.length&&!sites.length)return <section className="map-root map-empty"><IconMap2 size={28} stroke={1.5} aria-hidden="true"/><h2>Nothing to show yet</h2><p>Connect a server and add a site. They will appear here, arranged automatically.</p></section>;
 const vh=view.current?.clientHeight||0,vw=view.current?.clientWidth||0,clipped=!narrow&&vh>0&&(t.y+layout.height*t.k>vh+2||t.x+layout.width*t.k>vw+2);
 const flowSite=flow&&byId.sites[flow.siteId],flowTo=flow&&byId.servers[flow.targetId],flowFrom=flowSite&&byId.servers[flowSite.serverId];
 const checkServer=c=>byId.servers[c.serverId]||flowTo;
 const serverFlow=flow?.context==='server';
 const backToReview=()=>serverFlow?closeFlow(false):setFlow(f=>({...f,kind:'review',busy:false}));
 // Check again: after an install from a server's details, test the server again so its tools are read fresh, then show them
 async function recheckServer(){const id=flow.check.serverId;try{await api('/servers/'+encodeURIComponent(id)+'/test',{});await onRefresh?.()}catch{}closeFlow(false);setPanel({kind:'server',id})}
 const verb=unconnected&&flow?.siteId===unconnected.siteId?'Connect':'Move';
 const dialogs=<>
  {flow?.kind==='target'&&<TargetDialog verb={verb} site={flowSite} servers={servers.filter(s=>s.id!==flowSite.serverId||verb==='Connect')} results={verb==='Connect'?{...(checks[flow.siteId]||{}),[flowSite.serverId]:{ok:true}}:checks[flow.siteId]||{}} onCancel={()=>closeFlow(false)} onPick={id=>narrow?openReview(flow.siteId,id):choose(flow.siteId,id)}/>}
  {flow?.kind==='review'&&flow.preview&&<ReviewDialog key={flow.preview.id||'p'} site={flowSite} from={flowFrom} to={flowTo} preview={flow.preview} busy={flow.busy} error={flow.error} client={client} onCancel={()=>closeFlow(false)} onMove={startMove} onInstall={c=>setFlow(f=>({...f,kind:'install',check:c}))} onCommand={c=>setFlow(f=>({...f,kind:'command',check:c}))}/>}
  {flow?.kind==='install'&&<InstallConfirmDialog server={checkServer(flow.check)} check={flow.check} client={client} onCancel={backToReview} onStarted={jobId=>setFlow(f=>({...f,kind:'install-run',jobId}))} onCheckAgain={serverFlow?recheckServer:()=>openReview(flow.siteId,flow.targetId)}/>}
  {flow?.kind==='install-run'&&<InstallProgressDialog server={checkServer(flow.check)} pkg={flow.check.install.package} client={client} jobId={flow.jobId} onClose={backToReview} onCheckAgain={serverFlow?recheckServer:()=>openReview(flow.siteId,flow.targetId)}/>}
  {flow?.kind==='command'&&<CommandDialog server={checkServer(flow.check)} check={flow.check} onClose={backToReview} onCheckAgain={()=>openReview(flow.siteId,flow.targetId)}/>}
  {flow?.kind==='progress'&&<ProgressDialog site={flowSite} to={flowTo} client={client} moveId={flow.moveId} onClose={()=>closeFlow(true)}/>}
  {aflow?.kind==='pick'&&<PickSheet source={aflow.source} channels={alerts.channels} rules={alerts.rules} onClose={closeAflow} onAdd={kind=>addChannel(kind,null,aflow.source)} onPick={c=>openAlert(c.id,aflow.source)}/>}
  {aflow?.kind==='delete'&&<DeleteChannelSheet channel={aflow.channel} client={alertsClient} onClose={closeAflow} onDeleted={async()=>{await loadAlerts();setAflow(null);setPanel(null);setNote(aflow.channel.name+' is deleted.');focusBack()}}/>}
 </>;

 // Details and add panels (one at a time)
 const lastBackup=id=>(backups||[]).find(b=>b.siteId===id),lastJob=id=>(jobs||[]).find(j=>j.siteId===id&&/backup/i.test(j.type||'')&&j.status!=='running'&&j.status!=='queued');
 const siteWarn=s=>!byId.servers[s.serverId]||unconnected?.siteId===s.id||lastJob(s.id)?.status==='failed';
 // "Today 03:00, passed" / "Yesterday 23:00, failed"; older days use the app's date format
 const when=v=>{const d=new Date(v);if(isNaN(d))return '';const day=new Date(d).setHours(0,0,0,0),today=new Date().setHours(0,0,0,0),time=d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});return day===today?'Today '+time:day===today-864e5?'Yesterday '+time:formatDate(v,{shortTime:true})};
 const lastResult=id=>{const j=lastJob(id);return j?.status==='failed'?'failed':j?'passed':lastBackup(id)?'passed':''};
 const tool=(label,pkg,v,server)=>{
  if(v===undefined)return null;
  if(v)return [label,typeof v==='string'?v:'Installed'];
  return [label,<span className="map-missing"><span>Missing</span>{canMove&&<button type="button" onClick={e=>{opener.current=e.currentTarget;setPanel(null);setFlow({kind:'install',context:'server',check:{serverId:server.id,install:{package:pkg,command:'',supported:true}}})}}>Install {pkg}</button>}</span>];
 };
 function panelBody(){
  if(!panel)return null;
  const close=()=>closePanel(true);
  if(panel.kind==='add')return <SidePanel narrow={narrow} labelId="map-panel-title" title="Add to the map" onClose={close}><AddToMap onDragItem={canMove?i=>{dragItem.current=i}:undefined} onAddServer={()=>{closePanel(false);onAddServer?.()}} onAddStorage={()=>{closePanel(false);onAddStorage?.()}} onAddAlert={canMove?kind=>addChannel(kind):undefined} onCredentials={canMove?()=>setPanel({kind:'credentials'}):undefined}/></SidePanel>;
  if(panel.kind==='add-server'&&byId.servers[panel.id])return <AddServerPanel key={panel.id} onDragItem={canMove?i=>{dragItem.current={...i,serverId:panel.id}}:undefined} server={byId.servers[panel.id]} sites={sites} api={api} narrow={narrow} onClose={close} onPick={c=>{closePanel(false);onAddSite?.(panel.id,c.name)}}/>;
  if(panel.kind==='site'&&byId.sites[panel.id]){
   const s=byId.sites[panel.id],home=byId.servers[s.serverId],dbs=databasesOf(s),doms=domainsOf(s),lb=lastBackup(s.id),target=byId.storage[backupOf[s.id]],failed=lastJob(s.id)?.status==='failed',pol=(policies||[]).find(x=>x.siteId===s.id),ports=Array.isArray(s.config?.ports)?s.config.ports.map(String):[],sched=pol?.enabled?(pol.nextRun?'Next run '+when(pol.nextRun):'On a schedule'):'No schedule';
   const cs=Array.isArray(s.config?.containers)?s.config.containers:[],names=cs.length&&cs.every(x=>typeof x==='string')?cs.join(', '):cs.length?String(cs.length):'';
   return <SidePanel narrow={narrow} labelId="map-panel-title" title={s.name} onClose={close} footer={<>{canMove&&home&&<button type="button" onClick={e=>moveTo(s.id,opener.current||e.currentTarget)}>Move to{'…'}</button>}<button type="button" className="primary" onClick={()=>{closePanel(false);onOpenSite?.(s)}}>Open site</button></>}>
    {failed&&<p className="map-panel-warn"><IconAlertTriangle size={18} stroke={1.75} aria-hidden="true"/>The last backup failed.</p>}
    <Defs rows={[['Server',home?home.name:'Not connected'],['Type',s.config?.kind==='static'?'Static nginx site':'Docker site'],doms.length&&['Domains',<span className="map-vals">{doms.map(d=><Val key={d} text={d} label={d}><a href={'https://'+d} target="_blank" rel="noreferrer">{d}</a></Val>)}</span>],names&&['Containers',names],ports.length>0&&['Ports',ports.join(', ')],['Schedule',sched],['Backup storage',target?target.name:'Not backed up yet'],['Last backup',lb||lastJob(s.id)?[lb?when(lb.capturedAt):when(lastJob(s.id).finishedAt||lastJob(s.id).createdAt),lastResult(s.id)].filter(Boolean).join(', '):'No backup yet'],lb?.size>0&&['Backup size',bytes(lb.size)]]}/>
    {dbs.length>0&&<section><h3 className="map-group-title">Databases</h3><ul className="map-plain">{dbs.map(d=><li key={d.id}>{d.label}</li>)}</ul><p className="map-caption">Moves together with the site.</p></section>}
    {canMove&&<SourceAlerts source={{kind:'site',id:s.id,name:s.name}} rules={alerts.rules} channels={alerts.channels} onEdit={editRule} onAdd={pickChannel}/>}
   </SidePanel>;
  }
  if(panel.kind==='server'&&byId.servers[panel.id]){
   const sv=byId.servers[panel.id],c=sv.capabilities||{},mine=sites.filter(x=>x.serverId===sv.id).length,free=bytes(c.freeBytes);
   const nginx=c.nginx===undefined?undefined:(c.nginx?.installed??!!c.nginx),certbot=c.certbot===undefined?undefined:(c.certbot?.installed??!!c.certbot);
   return <SidePanel narrow={narrow} labelId="map-panel-title" title={sv.name} onClose={close} footer={<button type="button" className="primary" onClick={()=>{closePanel(false);onOpenServer?.(sv)}}>Open server</button>}>
    <Defs rows={[['Status',serverStatus(sv)],['Address',<Val text={sv.host} label="address"/>],['SSH','Port '+sv.port+', user '+sv.username],sv.hostKey&&['Host key',<Val text={sv.hostKey} label="host key">{String(sv.hostKey).replace(/^SHA256:/,'').slice(0,16)+'…'}</Val>],(c.os||c.osName)&&['System',c.os||c.osName],c.architecture&&['Architecture',c.architecture],['Docker',c.dockerVersion||c.docker||'Not checked yet'],tool('Compose','compose',c.composeVersion===null?false:c.composeVersion,sv),tool('nginx','nginx',nginx,sv),tool('Certbot','certbot',certbot,sv),(free||c.totalBytes)&&['Disk',free?free+' free'+(c.totalBytes?' of '+bytes(c.totalBytes):''):bytes(c.totalBytes)+' total'],['Sites',String(mine)]]}/>
    {canMove&&<button type="button" className="map-found" onClick={e=>openPanel({kind:'add-server',id:sv.id},e.currentTarget)}>Add a site found here</button>}
    {canMove&&<SourceAlerts source={{kind:'server',id:sv.id,name:sv.name}} rules={alerts.rules} channels={alerts.channels} onEdit={editRule} onAdd={pickChannel}/>}
   </SidePanel>;
  }
  if(panel.kind==='credentials'&&canMove)return <CredentialsPanel narrow={narrow} credentials={alerts.credentials} channels={alerts.channels} client={alertsClient} onClose={close} onReload={loadAlerts}/>;
  if(panel.kind==='docknest'&&canMove){
   const src={kind:'docknest',id:null,name:'DockNest'};
   return <SidePanel narrow={narrow} labelId="map-panel-title" title="DockNest" onClose={close}>
    <p>Alerts from DockNest cover everything here: backups, moves, servers, and new DockNest versions.</p>
    <SourceAlerts source={src} rules={alerts.rules} channels={alerts.channels} onEdit={editRule} onAdd={pickChannel}/>
   </SidePanel>;
  }
  if((panel.kind==='alert'||panel.kind==='alert-new')&&canMove){
   const ch=panel.kind==='alert'?alerts.channels.find(c=>c.id===panel.id):null;if(panel.kind==='alert'&&!ch)return null;
   return <AlertPanel key={(ch?.id||'new-'+panel.channelKind)+':'+panel.n} narrow={narrow} kind={ch?.kind||panel.channelKind} channel={ch} rules={alerts.rules} credentials={alerts.credentials} sourceList={sourceList} sourceName={sourceName} preselect={panel.preselect} scrollTo={panel.scrollTo} client={alertsClient} when={when} onClose={close} onReload={loadAlerts} onDelete={()=>setAflow({kind:'delete',channel:ch})} onSaved={async(saved,created)=>{if(created&&ghost)setPositions(p=>({...p,['alert:'+saved.id]:{x:ghost.x,y:ghost.y}}));await loadAlerts();setNote(created?saved.name+' is saved.':'Alert settings saved.');closePanel(true)}}/>;
  }
  if(panel.kind==='storage'&&byId.storage[panel.id]){
   const t=byId.storage[panel.id],f=storageFacts(t),here=sites.filter(x=>backupOf[x.id]===t.id),lastUp=(backups||[]).filter(b=>here.some(x=>x.id===b.siteId)&&b.capturedAt).sort((a,b)=>String(b.capturedAt).localeCompare(String(a.capturedAt)))[0];
   return <SidePanel narrow={narrow} labelId="map-panel-title" title={t.name} onClose={close} footer={<button type="button" className="primary" onClick={()=>{closePanel(false);onOpenStorage?.(t)}}>Open storage</button>}>
    <Defs rows={[['Type',t.kind==='s3'?'S3-compatible storage':'SFTP server'],['Space',f.text],['Status',t.status==='connected'?'Connected':t.status?'Needs attention':'Not checked yet'],['Sites using it',String(here.length)],lastUp&&['Last upload',when(lastUp.capturedAt)]]}/>
    <section><h3 className="map-group-title">Backed up here</h3>{here.length?<ul className="map-plain">{here.map(x=><li key={x.id}>{x.name}</li>)}</ul>:<p className="map-caption">No sites back up here yet.</p>}</section>
   </SidePanel>;
  }
  return null;
 }
 const panelKey=!panel?null:panel.kind==='alert'?'alert:'+panel.id:panel.kind==='docknest'?'docknest:root':['server','site','storage'].includes(panel.kind)?panel.kind+':'+panel.id:null;
 const ends=[...layout.paths.map(p=>['w'+p.id,'server:'+p.serverId,'site:'+p.id]),...layout.backupPaths.map(p=>['b'+p.id,'site:'+p.id,'storage:'+p.storageId]),...layout.rulePaths.map(p=>['r'+p.id,p.sourceKind&&p.sourceKind!=='docknest'?p.sourceKind+':'+p.sourceId:'docknest:root','alert:'+p.channelId])];
 const actKey=hot||(sel?.type==='node'?sel.key:null),actLine=!hot&&sel?.type==='line'?sel.id:null,lit=new Set(),litNodes=new Set();
 if(actLine){const e=ends.find(x=>x[0]===actLine);if(e){lit.add(e[0]);litNodes.add(e[1]);litNodes.add(e[2])}}
 else if(actKey){litNodes.add(actKey);for(const [id,a,b] of ends)if(a===actKey||b===actKey){lit.add(id);litNodes.add(a);litNodes.add(b)}}
 const lineCls=id=>lit.size?(lit.has(id)?' lit':' dim'):'',nodeCls=k=>litNodes.has(k)?' lit':'';
 const hov=(h)=>({onPointerEnter:()=>setHot(h),onPointerLeave:()=>setHot(null)});
 const sourceList=[{kind:'docknest',id:null,name:'DockNest'},...servers.map(x=>({kind:'server',id:x.id,name:x.name})),...sites.map(x=>({kind:'site',id:x.id,name:x.name}))];
 const alertsList=canMove&&<AlertsList channels={alerts.channels} rules={alerts.rules} sourceName={sourceName} onDetails={(c,el)=>openPanel({kind:'alert',id:c.id},el)} onEditRule={editRule} onAdd={addChannel} onDocknest={el=>pickChannel({kind:'docknest',id:null,name:'DockNest'},el)}/>;
 if(narrow)return <div className="map-root">{strip}<MapList groups={groups} storage={storage} canMove={canMove} onMoveTo={moveTo} onDetails={(p,el)=>openPanel(p,el)} onAddSite={(id,el)=>openPanel({kind:'add-server',id},el)} onAdd={el=>openPanel({kind:'add'},el)} alertsList={alertsList}/>{panelBody()}{dialogs}</div>;

 const M=METRICS,item=(r)=>({left:r.x,top:r.y,width:r.w,height:r.h});
 const at=(x,y)=>({left:x,top:y});
 const siteRect=id=>layout.sites.find(s=>s.id===id);
 const draggedSite=drag&&siteRect(drag.id),broken=unconnected&&siteRect(unconnected.siteId);
 const brokenPoint=drag?{x:drag.px,y:drag.py}:unconnected?.loose;
 const amber=(site,pt)=>site&&pt&&<path className="warn" markerEnd="url(#map-arrow-warn)" d={elbow([[pt.x,pt.y],[site.x-14,site.y+site.h/2]],8)}/>;
 const pendingLine=pending&&(()=>{const a=siteRect(pending.siteId),b=layout.servers.find(x=>x.id===pending.targetId);if(!a||!b)return null;const x1=b.x+b.w,y1=b.y+b.h/2,y2=a.y+a.h/2,cx=x1+M.serverGap/2;return <path className="pending" markerEnd="url(#map-arrow-pending)" d={elbow(y1===y2?[[x1,y1],[a.x-14,y2]]:[[x1,y1],[cx,y1],[cx,y2],[a.x-14,y2]])}/>})();
 const enter=(e,p)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();openPanel(p,e.currentTarget);return true}return false};
 const renderSite=r=>{
  const s=byId.sites[r.id],lost=unconnected?.siteId===r.id,moving=pending?.siteId===r.id;
  const home=byId.servers[s.serverId],warn=siteWarn(s);
  const label=`${s.name}. ${siteFacts(s)}. ${lost?'Not connected.':moving?`Will move to ${byId.servers[pending.targetId]?.name}.`:home?`Connected to ${home.name}.`:'Not on a server.'} Press Enter for details${canMove&&home?', or Delete to disconnect it':''}.`;
  return <article key={r.id} {...hov('site:'+r.id)} data-node={'site:'+r.id} data-site={r.id} tabIndex={0} aria-label={label} onKeyDown={e=>{if(enter(e,{kind:'site',id:r.id}))return;if(canMove&&home&&(e.key==='Delete'||e.key==='Backspace')&&!edit){e.preventDefault();e.stopPropagation();disconnect(r.id)}}} className={'map-site'+nodeCls('site:'+r.id)+(canMove&&home?' movable':'')+(lost?' lost':'')+(moving?' chosen':'')+(drag?.id===r.id?' lifted':'')} style={item(r)} title={s.name}>
   <SiteIcon site={s} size={32}/>
   {warn?<IconAlertTriangle className="map-badge warn" size={16} stroke={2} aria-hidden="true"/>:<IconCircleCheck className="map-badge ok" size={16} stroke={2} aria-hidden="true"/>}
   <span className="map-label"><b className="map-name">{s.name}</b><span className={'map-caption'+(lost?' warn':'')}>{lost||!home?'Not connected':siteFacts(s)}</span></span>
  </article>;
 };
 return <section className="map-root" aria-label="Infrastructure map">
  {canMove&&<div className="map-toolbar">
   {unconnected&&<span className="map-warn" role="status"><IconAlertTriangle size={18} stroke={1.75} aria-hidden="true"/>Connect every site to a server to save</span>}
   <button type="button" disabled={!H.current.past.length} onClick={undo}>Undo</button><button type="button" disabled={!H.current.future.length} onClick={redo}>Redo</button><button type="button" onClick={tidy}>Tidy up</button>
   {edit&&<button type="button" onClick={cancelEdit}>Cancel</button>}
   <button type="button" className="primary" disabled={!pending||!!flow} onClick={e=>{opener.current=e.currentTarget;openReview(pending.siteId,pending.targetId)}}>Save changes</button>
  </div>}
  {strip}
  <div className="map-stage">
  <div ref={view} className="map-viewport" style={viewH?{height:viewH}:undefined} tabIndex={0} role="group" aria-label="Map. Use arrow keys to move, plus and minus to zoom, 0 to fit to screen." onKeyDown={key} onDragOver={e=>{if(dragItem.current)e.preventDefault()}} onDrop={drop} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
   <div className="map-canvas" style={{width:layout.width,height:layout.height,transform:`translate(${t.x}px,${t.y}px) scale(${t.k})`}}>
    <svg className="map-lines" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}>
     <defs>
      {['','-warn','-pending','-rule'].map(k=><marker key={k} id={'map-arrow'+k} viewBox="0 0 8 8" refX="0" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0 L8 4 L0 8 Z" className={'arr'+k}/></marker>)}
     </defs>
     <g aria-hidden="true" className="decor">
     {layout.paths.map(p=>edit?.siteId===p.id||drag?.id===p.id?null:<path key={p.id} data-wire={p.id} className={'wire'+lineCls('w'+p.id)} markerEnd="url(#map-arrow)" d={p.d}/>)}
     {layout.backupPaths.map(p=><path key={'b'+p.id} className={'backup'+lineCls('b'+p.id)} markerEnd="url(#map-arrow)" d={p.d}/>)}
     {pendingLine}
     {amber(draggedSite||broken,brokenPoint)}
     </g>
     {layout.rulePaths.map(p=>{const r=alerts.rules.find(x=>x.id===p.ruleId);return <g key={'r'+p.id} className={'rule-g'+(r&&!r.enabled?' off':'')+lineCls('r'+p.id)}>
      <path className="rule" d={p.d}/>
      <path className="rule-hit" data-node={'rule:'+p.id} tabIndex={0} role="button" aria-label={p.bundle?`Alerts to ${alerts.channels.find(c=>c.id===p.channelId)?.name}. Press Enter to open.`:`Alerts from ${r?sourceName(r):''} to ${alerts.channels.find(c=>c.id===p.channelId)?.name}. Press Enter to open.`} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();if(p.bundle)openAlert(p.channelId,null,e.currentTarget);else if(r)editRule(r,e.currentTarget)}}} d={p.d}/>
     </g>})}
     {adrag?.src.from&&<path className="rule dragging hot" d={elbow([[adrag.src.from.x,adrag.src.from.y],[adrag.px,adrag.src.from.y],[adrag.px,adrag.py]],8)}/>}
    </svg>
    {ghost&&<div className="map-ghost" aria-hidden="true" style={{left:ghost.x,top:ghost.y,width:64,height:64}}>{ghost.kind==='telegram'?<KindIcon kind="telegram" size={28}/>:ghost.kind==='email'?<KindIcon kind="email" size={28}/>:ghost.kind==='server'?<IconServer size={28} stroke={1.5}/>:ghost.kind==='storage'?<IconDatabaseExport size={28} stroke={1.5}/>:<IconBox size={28} stroke={1.5}/>}<span className="map-label"><b className="map-name">New</b></span></div>}
    {layout.docknest&&<div {...hov('docknest:root')} data-node="docknest:root" tabIndex={0} aria-label="DockNest. Alerts for the whole installation. Press Enter for details." onKeyDown={e=>enter(e,{kind:'docknest',id:'root'})} className={'map-docknest'+nodeCls('docknest:root')} style={item(layout.docknest)}>
     <DockNestIcon size={32}/>
     <span className="map-label"><b className="map-name">DockNest</b><span className="map-caption">Whole installation</span></span>
    </div>}
    {layout.docknest&&<span aria-hidden="true" data-handle="out:docknest" data-alert-src={canMove?'docknest:':undefined} className={'map-port out'+(canMove?' grab':'')+(adrag?.src.kind==='docknest'?' active':'')} style={at(layout.docknest.alertOut.x,layout.docknest.alertOut.y)}/>}
    {layout.alerts.map(r=>{const ch=alerts.channels.find(c=>c.id===r.id),bad=ch.lastResult==='failed'||ch.needsCredential||!ch.credentialId;return <React.Fragment key={'n'+r.id}>
     <div {...hov('alert:'+r.id)} data-node={'alert:'+r.id} data-alert={r.id} tabIndex={0} aria-label={`${ch.name}. ${KIND_LABEL[ch.kind]} alerts${ch.needsCredential||!ch.credentialId?'. Needs a credential':bad?'. The last message could not be sent':''}. Press Enter for details.`} onKeyDown={e=>enter(e,{kind:'alert',id:r.id})} className={'map-alert'+nodeCls('alert:'+r.id)+(adrag?.over===r.id?' target':'')} style={item(r)}>
      <KindIcon kind={ch.kind} size={32}/>
      {bad&&<IconAlertTriangle className="map-badge warn" size={16} stroke={2} aria-hidden="true"/>}
      <span className="map-label"><b className="map-name" title={ch.name}>{ch.name}</b><span className="map-caption">{KIND_LABEL[ch.kind]}</span></span>
     </div>
     <span aria-hidden="true" data-handle={'in:'+r.id} className={'map-port'+(adrag?.over===r.id?' active':'')} style={at(r.in.x,r.in.y)}/>
    </React.Fragment>})}
    {layout.servers.map(r=><span key={'o'+r.id} aria-hidden="true" data-handle={'out:'+r.id} data-alert-src={canMove&&layout.docknest?'server:'+r.id:undefined} className={'map-port out'+(canMove&&layout.docknest?' grab':'')+(drag?.over===r.id||adrag?.overServer===r.id||(adrag?.src.kind==='server'&&adrag.src.id===r.id)?' active':'')} style={at(r.x+r.w,r.y+r.h/2)}/>)}
    {layout.sites.map(r=>{const lost=!!drag&&drag.id===r.id||unconnected?.siteId===r.id;const grab=canMove&&!lost;const out=r.out;return <React.Fragment key={'p'+r.id}>
     <span aria-hidden="true" data-handle={'in:'+r.id} data-port-site={grab?r.id:undefined} className={'map-port in'+(grab?' grab':'')+(lost?' lost':'')} style={at(r.x,r.y+r.h/2)}/>
     <span aria-hidden="true" data-handle={'out:'+r.id} data-alert-src={canMove&&layout.docknest?'site:'+r.id:undefined} className={'map-port out'+(canMove&&layout.docknest?' grab':'')+(adrag?.src.kind==='site'&&adrag.src.id===r.id?' active':'')} style={at(out.x,out.y)}/>
     {!r.backupId&&!alerts.rules.some(x=>x.sourceKind==='site'&&x.sourceId===r.id)&&<span aria-hidden="true" className="map-stub" style={at(out.x+8,out.y)}><IconPlus size={14} stroke={2}/></span>}
    </React.Fragment>})}
    {unconnected?.loose&&!drag&&<span aria-hidden="true" data-port-site={canMove?unconnected.siteId:undefined} className="map-port grab loose" style={at(unconnected.loose.x,unconnected.loose.y)}/>}
    {drag&&<span aria-hidden="true" className="map-port loose active" style={at(drag.px,drag.py)}/>}
    {layout.storage.map(r=><span key={'i'+r.id} aria-hidden="true" data-handle={'in:'+r.id} className="map-port" style={at(r.x,r.y+r.h/2)}/>)}
    {layout.servers.map(r=>{const s=byId.servers[r.id],mine=layout.sites.filter(x=>x.serverId===r.id),bad=drag&&r.id!==byId.sites[drag.id]?.serverId&&siteChecks[r.id]&&blocked(siteChecks[r.id]);
     return <div key={r.id} role="group" aria-labelledby={'map-server-'+r.id} className="map-group">
      <div {...hov('server:'+r.id)} data-node={'server:'+r.id} tabIndex={0} aria-label={`${s.name}. ${serverFacts(s,mine.length)}. Press Enter for details.`} onKeyDown={e=>enter(e,{kind:'server',id:r.id})} className={'map-server'+nodeCls('server:'+r.id)+(drag?.over===r.id?' target':'')+(bad?' blocked':'')+(pending?.targetId===r.id?' chosen':'')+(s.status&&s.status!=='connected'&&s.status!=='unchecked'?' attention':'')} style={item(r)}>
       <IconServer size={44} stroke={1.5} aria-hidden="true"/>
       {s.status==='connected'?<IconCircleCheck className="map-badge ok" size={16} stroke={2} aria-hidden="true"/>:!s.status||s.status==='unchecked'?<IconClock className="map-badge" size={16} stroke={2} aria-hidden="true"/>:<IconAlertTriangle className="map-badge warn" size={16} stroke={2} aria-hidden="true"/>}
       <span className="map-label"><b id={'map-server-'+r.id} className="map-name" title={s.name}>{s.name}</b>
        <span className={'map-caption'+(bad?' bad':'')}>{bad?why(siteChecks[r.id]):pending?.targetId===r.id?'New home for '+byId.sites[pending.siteId]?.name:serverFacts(s,mine.length)}</span>
        {s.status==='connected'?<span className="sr-only">Connected</span>:<span className="map-caption warn">{!s.status||s.status==='unchecked'?'Not checked yet':'Needs attention'}</span>}</span>
      </div>
      {canMove&&!mine.length&&!alerts.rules.some(x=>x.sourceKind==='server'&&x.sourceId===r.id)&&<button type="button" className="map-plus" aria-label={'Add a site to '+s.name} style={at(r.x+r.w+14,r.y+r.h/2+14)} onPointerDown={e=>e.stopPropagation()} onClick={e=>openPanel({kind:'add-server',id:r.id},e.currentTarget)}><IconPlus size={16} stroke={2} aria-hidden="true"/></button>}
      {mine.map(renderSite)}
     </div>})}
    {layout.unassigned.length>0&&<div role="group" aria-label="Not on a server" className="map-group">{layout.unassigned.map(renderSite)}</div>}
    {layout.storage.map(r=>{const tg=byId.storage[r.id],f=storageFacts(tg);return <div key={r.id} {...hov('storage:'+r.id)} data-node={'storage:'+r.id} tabIndex={0} role="group" aria-label={`Backup storage ${tg.name}. ${f.text}. Press Enter for details.`} onKeyDown={e=>enter(e,{kind:'storage',id:r.id})} className={'map-storage'+nodeCls('storage:'+r.id)} style={item(r)}>
     <IconDatabaseExport size={44} stroke={1.5} aria-hidden="true"/>
     {f.pct!==null&&<div className="map-meter" role="meter" aria-label={tg.name+' used'} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(f.pct*100)}><span style={{width:Math.round(f.pct*100)+'%'}}/></div>}
     <span className="map-label"><b className="map-name" title={tg.name}>{tg.name}</b><span className="map-caption">{f.text}</span></span></div>})}
   </div>
   {clipped&&<div className="map-fade" aria-hidden="true"/>}
   <div className="map-controls" onPointerDown={e=>e.stopPropagation()}>
    <IconButton label="Zoom in" icon={IconPlus} onClick={()=>zoomCentre(1.25)}/>
    <IconButton label="Zoom out" icon={IconMinus} onClick={()=>zoomCentre(0.8)}/>
    <IconButton label="Fit to screen" icon={IconArrowsMaximize} onClick={()=>{mode.current='fit';fit()}}/>
   </div>
  </div>
  {canMove&&<button type="button" className="map-add" aria-label="Add to the map" aria-expanded={panel?.kind==='add'} onClick={e=>panel?.kind==='add'?closePanel(true):openPanel({kind:'add'},e.currentTarget)}><IconPlus size={20} stroke={1.75} aria-hidden="true"/></button>}
  {panelBody()}
  </div>
  <p className="map-hint map-caption"><IconInfoCircle size={16} stroke={1.75} aria-hidden="true"/><span>{clipped?'Part of the map is out of view. ':''}{canMove?'Click a node to open it. Drag a site’s line to another server to move it.':'Click a node for details. Drag the background to move around.'}</span></p>
  <div className="map-live" role="status" aria-live="polite">{note}</div>
  {dialogs}
 </section>;
}

function AddServerPanel({server,sites,api,narrow,onClose,onPick,onDragItem}){
 const found=useDiscovery(api,server,sites);
 return <SidePanel narrow={narrow} labelId="map-panel-title" title={'Add to '+server.name} onClose={onClose} footer={<DiscoverFooter found={found}/>}><AddToServer found={found} onPick={onPick} onDragItem={onDragItem}/></SidePanel>;
}
