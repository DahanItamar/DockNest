import React,{useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {IconServer,IconBox,IconAppWindow,IconDatabase,IconDatabaseExport,IconWorldWww,IconPlus,IconMinus,IconArrowsMaximize,IconMap2,IconAlertTriangle,IconCircleCheck,IconClock,IconInfoCircle,IconPlugConnectedX} from '@tabler/icons-react';
import {StatusLabel,IconButton} from '../system.jsx';
import {count} from '../plural.js';
import {layoutMap,groupForList,databasesOf,domainOf,elbow,METRICS} from './layout.js';
import {createMovesClient,blocked,why,friendly} from './moves-client.js';
import {ReviewDialog,ProgressDialog,TargetDialog,InstallConfirmDialog,InstallProgressDialog,CommandDialog} from './MoveFlow.jsx';
import './map.css';

const bytes=v=>{if(!v)return '';const i=Math.min(4,Math.floor(Math.log(v)/Math.log(1024)));return (v/1024**i).toFixed(i?1:0)+' '+['B','KB','MB','GB','TB'][i]};
const MIN=0.2,MAX=2,FIT_MIN=0.45; // fit never scales above 100%; below 45% the map is too small to read, so the user pans
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
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

function useNarrow(){
 const q='(max-width:767px)',[narrow,setNarrow]=useState(()=>matchMedia(q).matches);
 useEffect(()=>{const m=matchMedia(q),h=()=>setNarrow(m.matches);m.addEventListener('change',h);return()=>m.removeEventListener('change',h)},[]);
 return narrow;
}

function MapList({groups,storage,canMove,onMoveTo}){
 return <div className="map-list">{groups.map(({server,sites})=>{
  const id='map-list-'+(server?server.id:'unassigned');
  return <section key={id} className="map-list-group" aria-labelledby={id}>
   <div className="map-list-head"><IconServer size={20} stroke={1.75} aria-hidden="true"/><div><h2 id={id}>{server?server.name:'Not on a server'}</h2>{server&&<>{serverStatus(server)}<span className="map-caption">{serverFacts(server,sites.length)}</span></>}</div></div>
   {sites.length?<ul>{sites.map(s=>{const dbs=databasesOf(s),dom=domainOf(s);return <li key={s.id}><SiteIcon site={s} size={18}/><div className="map-list-text"><span className="map-name">{s.name}</span><span className="map-caption">{server?siteFacts(s):'Not connected'}{dom?' · '+dom.text:''}</span>{dbs.map(d=><span key={d.id} className="map-caption">{d.label}, part of {s.name}</span>)}</div>{canMove&&server&&<button type="button" className="map-moveto" onClick={e=>onMoveTo(s.id,e.currentTarget)}>Move to{'…'}</button>}</li>})}</ul>:<p className="map-caption map-none">No sites on this server yet.</p>}
  </section>;
 })}
 {storage.length>0&&<section className="map-list-group" aria-labelledby="map-list-storage">
  <div className="map-list-head"><IconDatabaseExport size={20} stroke={1.75} aria-hidden="true"/><div><h2 id="map-list-storage">Backup storage</h2></div></div>
  <div className="map-list-store">{storage.map(t=>{const f=storageFacts(t);return <div key={t.id}><span className="map-name">{t.name}</span><span className="map-caption">{f.text}</span>{f.pct!==null&&<div className="map-meter" role="meter" aria-label={t.name+' used'} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(f.pct*100)}><span style={{width:Math.round(f.pct*100)+'%'}}/></div>}</div>})}</div>
 </section>}
 </div>;
}

export function MapPage({servers=[],sites=[],backups=[],policies=[],user,api}){
 const narrow=useNarrow(),canMove=user?.role==='admin';
 const [targets,setTargets]=useState(null);
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
 const layout=useMemo(()=>layoutMap(servers,sites,{storage,backupOf}),[servers,sites,storage,backupOf]);
 const groups=useMemo(()=>groupForList(servers,sites),[servers,sites]);
 const byId=useMemo(()=>({servers:Object.fromEntries(servers.map(s=>[s.id,s])),sites:Object.fromEntries(sites.map(s=>[s.id,s])),storage:Object.fromEntries(storage.map(s=>[s.id,s]))}),[servers,sites,storage]);
 const view=useRef(null),touched=useRef(false),pointers=useRef(new Map()),gesture=useRef(null);
 const [t,setT]=useState({x:0,y:0,k:1}),[drag,setDrag]=useState(null),[note,setNote]=useState('');
 const client=useMemo(()=>createMovesClient(api||(()=>Promise.reject(new Error('Moving is not available.')))),[api]);
 // One change at a time: edit = {siteId, targetId} (a pending move) or {siteId, targetId:null, loose:{x,y}} (line pulled off, not connected)
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
 function closeFlow(finished){setFlow(null);if(finished)setEdit(null);loadMoves();setTimeout(()=>opener.current?.focus?.(),0)}
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
  if(edit&&edit.siteId!==siteId){setNote('Save or cancel the current change first.');return;}
  opener.current=button;precheck(siteId);setFlow({kind:'target',siteId});
 }
 // Connect a site to a server (drop on its port, or the keyboard / phone sheet). The same server again undoes the change.
 function connect(siteId,targetId,loose){
  const name=byId.sites[siteId]?.name,target=byId.servers[targetId]?.name,r=checks[siteId]?.[targetId];
  if(targetId===byId.sites[siteId]?.serverId){setEdit(null);setNote(`${name} stays on ${target}. Nothing changes.`);return;}
  if(r&&blocked(r)){setEdit({siteId,targetId:null,loose:loose||edit?.loose||null});setNote(`${name} cannot move to ${target}. ${why(r)} ${name} is not connected.`);return;}
  setEdit({siteId,targetId});setNote(`${name} will move to ${target}. Choose Save changes to continue.`);
 }
 function disconnect(siteId,loose){
  const s=layout.sites.find(x=>x.id===siteId);if(!s)return;
  setEdit({siteId,targetId:null,loose:loose||{x:s.x-70,y:s.y+s.h+30}});
  setNote(`${byId.sites[siteId]?.name} is not connected. Connect it to a server to save.`);
 }
 function choose(siteId,targetId){connect(siteId,targetId);closeFlow(false);}
 function cancelEdit(){setEdit(null);setNote('Change cancelled. Nothing was changed.')}

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
  const box=el.getBoundingClientRect(),last=el.parentElement.querySelector('.map-live')||el;
  const below=last.getBoundingClientRect().bottom-box.bottom,top=box.top+window.scrollY;
  const next=Math.max(360,Math.floor(window.innerHeight-top-below-24));
  if(Math.abs(next-box.height)>1)setViewH(next);
 },[]);
 useLayoutEffect(()=>{if(narrow||!servers.length)return;size();window.addEventListener('resize',size);return()=>window.removeEventListener('resize',size)},[narrow,size,servers.length,note,!!strip,!!edit]);
 useLayoutEffect(()=>{if(narrow||!servers.length)return;touched.current=false;fit();},[narrow,fit,servers.length,viewH]);
 useEffect(()=>{
  const el=view.current;if(!el||typeof ResizeObserver==='undefined')return;
  const ro=new ResizeObserver(()=>{if(!touched.current)fit()});ro.observe(el);return()=>ro.disconnect();
 },[fit,narrow,servers.length]);

 const zoomAt=useCallback((factor,cx,cy)=>{
  touched.current=true;
  setT(p=>{const k=clamp(p.k*factor,MIN,MAX),r=k/p.k;return {k,x:cx-(cx-p.x)*r,y:cy-(cy-p.y)*r}});
 },[]);
 const zoomCentre=factor=>{const el=view.current;zoomAt(factor,el.clientWidth/2,el.clientHeight/2)};
 useEffect(()=>{
  const el=view.current;if(!el)return;
  const wheel=e=>{e.preventDefault();const r=el.getBoundingClientRect();zoomAt(Math.exp(-e.deltaY*0.0015),e.clientX-r.left,e.clientY-r.top)};
  el.addEventListener('wheel',wheel,{passive:false});return()=>el.removeEventListener('wheel',wheel);
 },[zoomAt,narrow,servers.length]);

 const toCanvas=(e)=>{const r=view.current.getBoundingClientRect();return [(e.clientX-r.left-t.x)/t.k,(e.clientY-r.top-t.y)/t.k]};
 const serverAt=(px,py)=>layout.servers.find(s=>{const b=s.block;return px>=s.x-HIT&&px<=s.x+s.w+HIT&&py>=s.y-HIT&&py<=b.y+b.h+HIT&&px>=b.x&&px<=b.x+b.w});
 // Only the end of a site's own incoming line (its port, or the loose end) starts a reconnect. Databases and domains are locked to their site.
 function down(e){
  if(e.button>0)return;
  pointers.current.set(e.pointerId,{x:e.clientX,y:e.clientY});
  const port=canMove&&e.target.closest?.('[data-port-site]');
  if(pointers.current.size===2){gesture.current={type:'pinch'};const [a,b]=[...pointers.current.values()];gesture.current.d=Math.hypot(a.x-b.x,a.y-b.y);setDrag(null);}
  else if(port&&edit&&edit.siteId!==port.dataset.portSite){setNote('Save or cancel the current change first.');gesture.current=null;}
  else if(port){const id=port.dataset.portSite;precheck(id);const [px,py]=toCanvas(e);gesture.current={type:'drag',id,x:e.clientX,y:e.clientY,moved:false};setDrag({id,px,py,over:null});}
  else gesture.current={type:'pan',x:e.clientX,y:e.clientY};
  e.currentTarget.setPointerCapture?.(e.pointerId);
 }
 function move(e){
  if(!pointers.current.has(e.pointerId))return;
  const prev=pointers.current.get(e.pointerId);pointers.current.set(e.pointerId,{x:e.clientX,y:e.clientY});
  const g=gesture.current;if(!g)return;
  if(g.type==='pinch'&&pointers.current.size===2){
   const [a,b]=[...pointers.current.values()],d=Math.hypot(a.x-b.x,a.y-b.y),r=view.current.getBoundingClientRect();
   if(g.d)zoomAt(d/g.d,(a.x+b.x)/2-r.left,(a.y+b.y)/2-r.top);g.d=d;
  }else if(g.type==='pan'){touched.current=true;setT(p=>({...p,x:p.x+e.clientX-prev.x,y:p.y+e.clientY-prev.y}));}
  else if(g.type==='drag'){
   if(Math.hypot(e.clientX-g.x,e.clientY-g.y)>6)g.moved=true;
   const [px,py]=toCanvas(e),over=serverAt(px,py);
   setDrag({id:g.id,px,py,over:over?over.id:null});
  }
 }
 function up(e){
  pointers.current.delete(e.pointerId);
  const g=gesture.current;
  if(g?.type==='drag'&&g.moved&&drag){
   if(drag.over)connect(g.id,drag.over,{x:drag.px,y:drag.py});
   else disconnect(g.id,{x:drag.px,y:drag.py});
  }
  if(!pointers.current.size){gesture.current=null;setDrag(null);}
 }
 function key(e){
  const step=48;let handled=true;
  if(e.key==='ArrowLeft')setT(p=>({...p,x:p.x+step}));
  else if(e.key==='ArrowRight')setT(p=>({...p,x:p.x-step}));
  else if(e.key==='ArrowUp')setT(p=>({...p,y:p.y+step}));
  else if(e.key==='ArrowDown')setT(p=>({...p,y:p.y-step}));
  else if(e.key==='+'||e.key==='=')zoomCentre(1.25);
  else if(e.key==='-')zoomCentre(0.8);
  else if(e.key==='0'){touched.current=false;fit();}
  else handled=false;
  if(handled){e.preventDefault();if(/Arrow/.test(e.key))touched.current=true;}
 }

 if(!servers.length&&!sites.length)return <section className="map-root map-empty"><IconMap2 size={28} stroke={1.5} aria-hidden="true"/><h2>Nothing to show yet</h2><p>Connect a server and add a site. They will appear here, arranged automatically.</p></section>;
 const vh=view.current?.clientHeight||0,vw=view.current?.clientWidth||0,clipped=!narrow&&vh>0&&(t.y+layout.height*t.k>vh+2||t.x+layout.width*t.k>vw+2);
 const flowSite=flow&&byId.sites[flow.siteId],flowTo=flow&&byId.servers[flow.targetId],flowFrom=flowSite&&byId.servers[flowSite.serverId];
 const checkServer=c=>byId.servers[c.serverId]||flowTo;
 const backToReview=()=>setFlow(f=>({...f,kind:'review',busy:false}));
 const verb=unconnected&&flow?.siteId===unconnected.siteId?'Connect':'Move';
 const dialogs=<>
  {flow?.kind==='target'&&<TargetDialog verb={verb} site={flowSite} servers={servers.filter(s=>s.id!==flowSite.serverId||verb==='Connect')} results={verb==='Connect'?{...(checks[flow.siteId]||{}),[flowSite.serverId]:{ok:true}}:checks[flow.siteId]||{}} onCancel={()=>closeFlow(false)} onPick={id=>narrow?openReview(flow.siteId,id):choose(flow.siteId,id)}/>}
  {flow?.kind==='review'&&flow.preview&&<ReviewDialog key={flow.preview.id||'p'} site={flowSite} from={flowFrom} to={flowTo} preview={flow.preview} busy={flow.busy} error={flow.error} client={client} onCancel={()=>closeFlow(false)} onMove={startMove} onInstall={c=>setFlow(f=>({...f,kind:'install',check:c}))} onCommand={c=>setFlow(f=>({...f,kind:'command',check:c}))}/>}
  {flow?.kind==='install'&&<InstallConfirmDialog server={checkServer(flow.check)} check={flow.check} client={client} onCancel={backToReview} onStarted={jobId=>setFlow(f=>({...f,kind:'install-run',jobId}))}/>}
  {flow?.kind==='install-run'&&<InstallProgressDialog server={checkServer(flow.check)} pkg={flow.check.install.package} client={client} jobId={flow.jobId} onClose={backToReview} onCheckAgain={()=>openReview(flow.siteId,flow.targetId)}/>}
  {flow?.kind==='command'&&<CommandDialog server={checkServer(flow.check)} check={flow.check} onClose={backToReview} onCheckAgain={()=>openReview(flow.siteId,flow.targetId)}/>}
  {flow?.kind==='progress'&&<ProgressDialog site={flowSite} to={flowTo} client={client} moveId={flow.moveId} onClose={()=>closeFlow(true)}/>}
 </>;
 if(narrow)return <div className="map-root">{strip}<MapList groups={groups} storage={storage} canMove={canMove} onMoveTo={moveTo}/>{dialogs}</div>;

 const M=METRICS,item=(r)=>({left:r.x,top:r.y,width:r.w,height:r.h});
 const at=(x,y)=>({left:x,top:y});
 const siteRect=id=>layout.sites.find(s=>s.id===id);
 const draggedSite=drag&&siteRect(drag.id),broken=unconnected&&siteRect(unconnected.siteId);
 const brokenPoint=drag?{x:drag.px,y:drag.py}:unconnected?.loose;
 const amber=(site,pt)=>site&&pt&&<path className="warn" markerEnd="url(#map-arrow-warn)" d={elbow([[pt.x,pt.y],[site.x-14,site.y+site.h/2]],8)}/>;
 const pendingLine=pending&&(()=>{const a=siteRect(pending.siteId),b=layout.servers.find(x=>x.id===pending.targetId);if(!a||!b)return null;const x1=b.x+b.w,y1=b.y+b.h/2,y2=a.y+a.h/2,cx=x1+M.serverGap/2;return <path className="pending" markerEnd="url(#map-arrow-pending)" d={elbow(y1===y2?[[x1,y1],[a.x-14,y2]]:[[x1,y1],[cx,y1],[cx,y2],[a.x-14,y2]])}/>})();
 const renderSite=r=>{
  const s=byId.sites[r.id],lost=unconnected?.siteId===r.id,moving=pending?.siteId===r.id,dbs=layout.dbs.filter(d=>d.siteId===r.id),dom=layout.domains.find(d=>d.siteId===r.id);
  const home=byId.servers[s.serverId];
  const label=canMove?`${s.name}. ${siteFacts(s)}. ${lost?'Not connected.':moving?`Will move to ${byId.servers[pending.targetId]?.name}.`:home?`Connected to ${home.name}.`:'Not on a server.'} ${home?'Press Enter to choose a server, or Delete to disconnect it.':''}`.trim():undefined;
  return <React.Fragment key={r.id}>
   <article data-site={r.id} tabIndex={canMove&&home?0:undefined} aria-label={label} onKeyDown={canMove&&home?(e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();moveTo(r.id,e.currentTarget)}else if((e.key==='Delete'||e.key==='Backspace')&&!edit){e.preventDefault();e.stopPropagation();disconnect(r.id)}}):undefined} className={'map-site'+(canMove&&home?' movable':'')+(lost?' lost':'')+(moving?' chosen':'')+(drag?.id===r.id?' lifted':'')} style={item(r)} title={s.name}>
    <SiteIcon site={s} size={32}/>
    {lost?<IconAlertTriangle className="map-badge warn" size={16} stroke={2} aria-hidden="true"/>:null}
    <span className="map-label"><b className="map-name">{s.name}</b><span className={'map-caption'+(lost?' warn':'')}>{lost?'Not connected':!home?'Not connected':siteFacts(s)}</span></span>
   </article>
   {dbs.map(d=><div key={d.id} role="img" aria-label={`${d.label}, part of ${s.name}`} className="map-db" style={item(d)}>
    <IconDatabase size={24} stroke={1.5} aria-hidden="true"/><span className="map-label"><b className="map-name" title={d.label}>{d.label}</b></span></div>)}
   {dom&&<div role="img" aria-label={`${dom.text}${dom.more?` and ${count(dom.more,'more domain')}`:''}, domain of ${s.name}`} className="map-domain" style={item(dom)} title={dom.text}>
    <IconWorldWww size={18} stroke={1.75} aria-hidden="true"/><span className="map-name">{dom.text}</span>{dom.more>0&&<span className="map-caption">+{dom.more}</span>}</div>}
  </React.Fragment>;
 };
 return <section className="map-root" aria-label="Infrastructure map">
  {canMove&&<div className="map-toolbar">
   {unconnected&&<span className="map-warn" role="status"><IconAlertTriangle size={18} stroke={1.75} aria-hidden="true"/>Connect every site to a server to save</span>}
   {edit&&<button type="button" onClick={cancelEdit}>Cancel</button>}
   <button type="button" className="primary" disabled={!pending||!!flow} onClick={e=>{opener.current=e.currentTarget;openReview(pending.siteId,pending.targetId)}}>Save changes</button>
  </div>}
  {strip}
  <div ref={view} className="map-viewport" style={viewH?{height:viewH}:undefined} tabIndex={0} role="group" aria-label="Map. Use arrow keys to move, plus and minus to zoom, 0 to fit to screen." onKeyDown={key} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
   <div className="map-canvas" style={{width:layout.width,height:layout.height,transform:`translate(${t.x}px,${t.y}px) scale(${t.k})`}}>
    <svg className="map-lines" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
     <defs>
      {['','-warn','-pending'].map(k=><marker key={k} id={'map-arrow'+k} viewBox="0 0 8 8" refX="0" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0 L8 4 L0 8 Z" className={'arr'+k}/></marker>)}
     </defs>
     {layout.dbPaths.map(p=><path key={p.id} className="lock" d={elbow(p.points)}/>)}
     {layout.paths.map(p=>edit?.siteId===p.id||drag?.id===p.id?null:<path key={p.id} className="wire" markerEnd="url(#map-arrow)" d={p.d}/>)}
     {layout.backupPaths.map(p=><path key={'b'+p.id} className="backup" markerEnd="url(#map-arrow)" d={p.d}/>)}
     {pendingLine}
     {amber(draggedSite||broken,brokenPoint)}
    </svg>
    {layout.servers.map(r=><span key={'o'+r.id} aria-hidden="true" className={'map-port'+(drag?.over===r.id?' active':'')} style={at(r.x+r.w,r.y+r.h/2)}/>)}
    {layout.sites.map(r=>{const lost=!!drag&&drag.id===r.id||unconnected?.siteId===r.id;const grab=canMove&&!lost;const out=r.out;return <React.Fragment key={'p'+r.id}>
     <span aria-hidden="true" data-port-site={grab?r.id:undefined} className={'map-port in'+(grab?' grab':'')+(lost?' lost':'')} style={at(r.x,r.y+r.h/2)}/>
     {r.backupId?<span aria-hidden="true" className="map-port" style={at(out.x,out.y)}/>:<span aria-hidden="true" className="map-stub" style={at(out.x+8,out.y)}><IconPlus size={14} stroke={2}/></span>}
    </React.Fragment>})}
    {unconnected?.loose&&!drag&&<span aria-hidden="true" data-port-site={canMove?unconnected.siteId:undefined} className="map-port grab loose" style={at(unconnected.loose.x,unconnected.loose.y)}/>}
    {drag&&<span aria-hidden="true" className="map-port loose active" style={at(drag.px,drag.py)}/>}
    {layout.storage.map(r=><span key={'i'+r.id} aria-hidden="true" className="map-port" style={at(r.x,r.y+r.h/2)}/>)}
    {layout.servers.map(r=>{const s=byId.servers[r.id],mine=layout.sites.filter(x=>x.serverId===r.id),bad=drag&&r.id!==byId.sites[drag.id]?.serverId&&siteChecks[r.id]&&blocked(siteChecks[r.id]);
     return <div key={r.id} role="group" aria-labelledby={'map-server-'+r.id} className="map-group">
      <div className={'map-server'+(drag?.over===r.id?' target':'')+(bad?' blocked':'')+(pending?.targetId===r.id?' chosen':'')+(s.status&&s.status!=='connected'&&s.status!=='unchecked'?' attention':'')} style={item(r)}>
       <IconServer size={44} stroke={1.5} aria-hidden="true"/>
       {s.status==='connected'?<IconCircleCheck className="map-badge ok" size={16} stroke={2} aria-hidden="true"/>:!s.status||s.status==='unchecked'?<IconClock className="map-badge" size={16} stroke={2} aria-hidden="true"/>:<IconAlertTriangle className="map-badge warn" size={16} stroke={2} aria-hidden="true"/>}
       <span className="map-label"><b id={'map-server-'+r.id} className="map-name" title={s.name}>{s.name}</b>
        <span className={'map-caption'+(bad?' bad':'')}>{bad?why(siteChecks[r.id]):pending?.targetId===r.id?'New home for '+byId.sites[pending.siteId]?.name:serverFacts(s,mine.length)}</span>
        {s.status==='connected'?<span className="sr-only">Connected</span>:<span className="map-caption warn">{!s.status||s.status==='unchecked'?'Not checked yet':'Needs attention'}</span>}</span>
      </div>
      {mine.map(renderSite)}
     </div>})}
    {layout.unassigned.length>0&&<div role="group" aria-label="Not on a server" className="map-group">{layout.unassigned.map(renderSite)}</div>}
    {layout.storage.map(r=>{const tg=byId.storage[r.id],f=storageFacts(tg);return <div key={r.id} role="group" aria-label={'Backup storage '+tg.name} className="map-storage" style={item(r)}>
     <IconDatabaseExport size={44} stroke={1.5} aria-hidden="true"/>
     {f.pct!==null&&<div className="map-meter" role="meter" aria-label={tg.name+' used'} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(f.pct*100)}><span style={{width:Math.round(f.pct*100)+'%'}}/></div>}
     <span className="map-label"><b className="map-name" title={tg.name}>{tg.name}</b><span className="map-caption">{f.text}</span></span></div>})}
   </div>
   {clipped&&<div className="map-fade" aria-hidden="true"/>}
   <div className="map-controls" onPointerDown={e=>e.stopPropagation()}>
    <IconButton label="Zoom in" icon={IconPlus} onClick={()=>zoomCentre(1.25)}/>
    <IconButton label="Zoom out" icon={IconMinus} onClick={()=>zoomCentre(0.8)}/>
    <IconButton label="Fit to screen" icon={IconArrowsMaximize} onClick={()=>{touched.current=false;fit()}}/>
   </div>
  </div>
  <p className="map-hint map-caption"><IconInfoCircle size={16} stroke={1.75} aria-hidden="true"/><span>{clipped?'Part of the map is out of view. Drag the background or use the arrow keys to see more. ':''}{canMove?'Drag the end of a site’s line off its server, then drop it on another server to move the site. Nothing changes until you press Save changes. Keyboard: focus a site, press Enter to choose a server.':'Drag the background to move around. Use the buttons, mouse wheel or pinch to zoom.'}</span></p>
  <div className="map-live" role="status" aria-live="polite">{note}</div>
  {dialogs}
 </section>;
}
