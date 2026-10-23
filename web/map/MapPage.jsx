import React,{useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {IconServer,IconBox,IconZoomIn,IconZoomOut,IconArrowsMaximize,IconMap2} from '@tabler/icons-react';
import {StatusLabel,IconButton} from '../system.jsx';
import {count} from '../plural.js';
import {layoutMap,groupForList} from './layout.js';
import {createMovesClient,blocked,why,friendly} from './moves-client.js';
import {ReviewDialog,ProgressDialog,TargetDialog} from './MoveFlow.jsx';
import './map.css';

const bytes=v=>{if(!v)return '';const i=Math.min(4,Math.floor(Math.log(v)/Math.log(1024)));return (v/1024**i).toFixed(i?1:0)+' '+['B','KB','MB','GB','TB'][i]};
const MIN=0.2,MAX=2,FIT_MIN=0.85; // fit never scales above 100% or below 85%; beyond that the user pans
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));

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

function useNarrow(){
 const q='(max-width:767px)',[narrow,setNarrow]=useState(()=>matchMedia(q).matches);
 useEffect(()=>{const m=matchMedia(q),h=()=>setNarrow(m.matches);m.addEventListener('change',h);return()=>m.removeEventListener('change',h)},[]);
 return narrow;
}

function MapList({groups,canMove,onMoveTo}){
 return <div className="map-list">{groups.map(({server,sites},i)=>{
  const id='map-list-'+(server?server.id:'unassigned');
  return <section key={id} className="map-list-group" aria-labelledby={id}>
   <div className="map-list-head"><IconServer size={20} stroke={1.75} aria-hidden="true"/><div><h2 id={id}>{server?server.name:'Not on a server'}</h2>{server&&<>{serverStatus(server)}<span className="map-caption">{serverFacts(server,sites.length)}</span></>}</div></div>
   {sites.length?<ul>{sites.map(s=><li key={s.id}><IconBox size={18} stroke={1.75} aria-hidden="true"/><span className="map-name">{s.name}</span><span className="map-caption">{siteFacts(s)}</span>{canMove&&<button type="button" className="map-moveto" onClick={e=>onMoveTo(s.id,e.currentTarget)}>Move to{'…'}</button>}</li>)}</ul>:<p className="map-caption map-none">No sites on this server yet.</p>}
  </section>;
 })}</div>;
}

export function MapPage({servers=[],sites=[],user,api}){
 const narrow=useNarrow(),canMove=user?.role==='admin';
 const layout=useMemo(()=>layoutMap(servers,sites),[servers,sites]);
 const groups=useMemo(()=>groupForList(servers,sites),[servers,sites]);
 const byId=useMemo(()=>({servers:Object.fromEntries(servers.map(s=>[s.id,s])),sites:Object.fromEntries(sites.map(s=>[s.id,s]))}),[servers,sites]);
 const view=useRef(null),touched=useRef(false),pointers=useRef(new Map()),gesture=useRef(null);
 const [t,setT]=useState({x:0,y:0,k:1}),[drag,setDrag]=useState(null),[note,setNote]=useState('');
 const client=useMemo(()=>createMovesClient(api||(()=>Promise.reject(new Error('Moving is not available.')))),[api]);
 const [pending,setPending]=useState(null),[checks,setChecks]=useState({}),[flow,setFlow]=useState(null),opener=useRef(null);
 const siteChecks=checks[drag?.id]||{};
 function precheck(siteId){
  const home=byId.sites[siteId]?.serverId;
  servers.filter(s=>s.id!==home).forEach(s=>{
   if(checks[siteId]?.[s.id])return;
   client.preview(siteId,s.id).then(r=>setChecks(c=>({...c,[siteId]:{...c[siteId],[s.id]:r}}))).catch(()=>{});
  });
 }
 function openReview(siteId,targetId){
  setFlow({kind:'review',siteId,targetId,busy:true});
  client.preview(siteId,targetId).then(p=>setFlow(f=>f&&{...f,preview:p,busy:false})).catch(e=>setFlow(f=>f&&{...f,error:e.message,busy:false,preview:{ok:false,blockers:[friendly(e)]}}));
 }
 const [moves,setMoves]=useState([]);
 const loadMoves=useCallback(()=>{if(canMove)client.list().then(r=>setMoves(Array.isArray(r?.moves)?r.moves:[])).catch(()=>{})},[client,canMove]);
 useEffect(()=>{loadMoves();const t=setInterval(loadMoves,15000);return()=>clearInterval(t)},[loadMoves]);
 function closeFlow(finished){setFlow(null);if(finished)setPending(null);loadMoves();setTimeout(()=>opener.current?.focus?.(),0)}
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
 function moveTo(siteId,button){opener.current=button;precheck(siteId);setFlow({kind:'target',siteId})}
 function choose(siteId,targetId){const r=checks[siteId]?.[targetId];if(r&&blocked(r)){setNote(`${byId.sites[siteId]?.name} cannot move to ${byId.servers[targetId]?.name}. ${why(r)}`);return;}setPending({siteId,targetId});setNote(`${byId.sites[siteId]?.name} will move to ${byId.servers[targetId]?.name}. Choose Save changes to continue.`);closeFlow(false);}

 const fit=useCallback(()=>{
  const el=view.current;if(!el)return;
  const w=el.clientWidth,h=el.clientHeight;if(!w||!h)return;
  const k=clamp(Math.min(w/layout.width,h/layout.height),FIT_MIN,1);
  setT({k,x:Math.max(0,(w-layout.width*k)/2),y:Math.max(0,(h-layout.height*k)/2)});
 },[layout.width,layout.height]);
 useLayoutEffect(()=>{if(narrow||!servers.length)return;touched.current=false;fit();},[narrow,fit,servers.length]);
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
 function down(e){
  if(e.button>0)return;
  pointers.current.set(e.pointerId,{x:e.clientX,y:e.clientY});
  const card=canMove&&e.target.closest?.('[data-site]');
  if(pointers.current.size===2){gesture.current={type:'pinch'};const [a,b]=[...pointers.current.values()];gesture.current.d=Math.hypot(a.x-b.x,a.y-b.y);setDrag(null);}
  else if(card){precheck(card.dataset.site);const rect=layout.sites.find(s=>s.id===card.dataset.site);const [px,py]=toCanvas(e);gesture.current={type:'drag',id:rect.id};setDrag({id:rect.id,px,py,over:null});}
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
   const [px,py]=toCanvas(e),home=layout.sites.find(s=>s.id===g.id).serverId;
   const over=layout.servers.find(s=>s.id!==home&&px>=s.x&&px<=s.x+s.w&&py>=s.y&&py<=s.y+s.h);
   setDrag({id:g.id,px,py,over:over?over.id:null});
  }
 }
 function up(e){
  pointers.current.delete(e.pointerId);
  const g=gesture.current;
  if(g?.type==='drag'&&drag?.over){
   const r=checks[g.id]?.[drag.over],name=byId.sites[g.id]?.name,target=byId.servers[drag.over]?.name;
   if(r&&blocked(r))setNote(`${name} cannot move to ${target}. ${why(r)}`);
   else{setPending({siteId:g.id,targetId:drag.over});setNote(`${name} will move to ${target}. Choose Save changes to continue.`);}
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
 const dialogs=<>
  {flow?.kind==='target'&&<TargetDialog site={flowSite} servers={servers.filter(s=>s.id!==flowSite.serverId)} results={checks[flow.siteId]||{}} onCancel={()=>closeFlow(false)} onPick={id=>narrow?openReview(flow.siteId,id):choose(flow.siteId,id)}/>}
  {flow?.kind==='review'&&flow.preview&&<ReviewDialog key={flow.preview.id||'p'} site={flowSite} from={flowFrom} to={flowTo} preview={flow.preview} busy={flow.busy} error={flow.error} client={client} onCancel={()=>closeFlow(false)} onMove={startMove}/>}
  {flow?.kind==='progress'&&<ProgressDialog site={flowSite} to={flowTo} client={client} moveId={flow.moveId} onClose={()=>closeFlow(true)}/>}
 </>;
 if(narrow)return <div className="map-root">{strip}<MapList groups={groups} canMove={canMove} onMoveTo={moveTo}/>{dialogs}</div>;

 const home=drag&&layout.sites.find(s=>s.id===drag.id);
 const item=(r)=>({left:r.x,top:r.y,width:r.w,height:r.h});
 const renderSite=r=>{const s=byId.sites[r.id];return <article key={r.id} data-site={r.id} tabIndex={canMove?0:undefined} aria-label={canMove?`${s.name}. ${siteFacts(s)}. Press Enter to choose a new server.`:undefined} onKeyDown={canMove?(e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();moveTo(r.id,e.currentTarget)}}):undefined} className={'map-site'+(canMove?' movable':'')+(drag?.id===r.id?' lifted':'')} style={item(r)} title={s.name}>
  <IconBox size={20} stroke={1.75} aria-hidden="true"/><div><b className="map-name">{s.name}</b><span className="map-caption">{siteFacts(s)}</span></div></article>};
 const groupIds=[...layout.servers.map(s=>s.id)];
 return <section className="map-root" aria-label="Infrastructure map">
  <div className="map-toolbar">
   <div className="map-zoom">
    <IconButton label="Zoom out" icon={IconZoomOut} onClick={()=>zoomCentre(0.8)}/>
    <IconButton label="Zoom in" icon={IconZoomIn} onClick={()=>zoomCentre(1.25)}/>
   </div>
   <button type="button" onClick={()=>{touched.current=false;fit()}}><IconArrowsMaximize size={18} stroke={1.75} aria-hidden="true"/>Fit to screen</button>
   {canMove&&<>
    <button type="button" className="primary" disabled={!pending||!!flow} onClick={e=>{opener.current=e.currentTarget;openReview(pending.siteId,pending.targetId)}}>Save changes</button>
    {pending&&<button type="button" onClick={()=>{setPending(null);setNote('')}}>Undo change</button>}
   </>}
  </div>
  {strip}
  <div ref={view} className="map-viewport" tabIndex={0} role="group" aria-label="Map. Use arrow keys to move, plus and minus to zoom, 0 to fit to screen." onKeyDown={key} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
   <div className="map-canvas" style={{width:layout.width,height:layout.height,transform:`translate(${t.x}px,${t.y}px) scale(${t.k})`}}>
    <svg className="map-lines" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
     {layout.paths.map(p=><path key={p.id} d={p.d} className={drag?.id===p.id?'dim':undefined}/>)}
     {pending&&!drag&&(()=>{const a=layout.sites.find(x=>x.id===pending.siteId),b=layout.servers.find(x=>x.id===pending.targetId);return a&&b&&<path className="drag" d={`M${a.x} ${a.y+a.h/2} L${b.x+b.w} ${b.y+b.h/2}`}/>})()}
     {home&&<path className="drag" d={`M${home.x} ${home.y+home.h/2} L${drag.px} ${drag.py}`}/>}
    </svg>
    {layout.servers.map(r=><span key={"h"+r.id} aria-hidden="true" className={"map-handle"+(drag?.over===r.id?" active":"")} style={{left:r.x+r.w-6,top:r.y+r.h/2-6}}/>)}
    {layout.sites.map(r=><span key={"h"+r.id} aria-hidden="true" className={"map-handle"+(drag?.id===r.id?" active":"")} style={{left:r.x-6,top:r.y+r.h/2-6}}/>)}
    {groupIds.map(id=>{const r=layout.servers.find(s=>s.id===id),s=byId.servers[id],mine=layout.sites.filter(x=>x.serverId===id);
     return <div key={id} role="group" aria-labelledby={'map-server-'+id} className="map-group">
      <div className={'map-server'+(drag?.over===id?' target':'')+(drag&&id!==home?.serverId&&siteChecks[id]&&blocked(siteChecks[id])?' blocked':'')+(pending?.targetId===id?' chosen':'')} style={item(r)}><div className="map-server-title"><IconServer size={20} stroke={1.75} aria-hidden="true"/><b id={'map-server-'+id} className="map-name" title={s.name}>{s.name}</b></div>{serverStatus(s)}<span className="map-caption">{drag&&siteChecks[id]&&blocked(siteChecks[id])?why(siteChecks[id]):pending?.targetId===id?'New home for '+byId.sites[pending.siteId]?.name:serverFacts(s,mine.length)}</span></div>
      {mine.map(renderSite)}
     </div>})}
    {layout.unassigned.length>0&&<div role="group" aria-label="Not on a server" className="map-group">{layout.unassigned.map(renderSite)}</div>}
   </div>
   {clipped&&<div className="map-fade" aria-hidden="true"/>}
  </div>
  <p className="map-hint map-caption">{clipped?'Part of the map is out of view. Drag the background or use the arrow keys to see more. ':''}Drag the background to move around. Use the buttons, mouse wheel or pinch to zoom.{canMove&&' To move a site with the keyboard, focus it and press Enter.'}</p>
  <div className="map-live" role="status" aria-live="polite">{note}</div>
  {dialogs}
 </section>;
}
