import {engineLabel,engineOnlineCopy} from '../../shared/database-engines.js';
// Pure, deterministic map layout (n8n style). Columns, left to right: servers, sites, backup storage. Groups are contiguous and in the same order on both sides, and every
// line runs in a free gutter or through free space of its own row, so no line ever crosses a card. Moved nodes come in as opts.positions.
export const METRICS={pad:40,serverS:96,siteS:64,storageS:96,label:44,serverGap:140,rowGap:24,groupGap:32,storageGap:60,storagePitch:168,
 linkBase:56,linkLane:14,labelW:{server:160,site:144,storage:160,alert:160},alertS:64,alertGap:150,alertPitch:128,laneGap:28};
const byName=(a,b)=>{const x=String(a.name||'').toLowerCase(),y=String(b.name||'').toLowerCase();return x<y?-1:x>y?1:String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0};

// Same grouping and order for the canvas, the phone list and screen readers.
export function groupForList(servers=[],sites=[]){
 const ordered=[...servers].sort(byName),ids=new Set(ordered.map(s=>s.id));
 const groups=ordered.map(server=>({server,sites:sites.filter(s=>s.serverId===server.id).sort(byName)}));
 const orphans=sites.filter(s=>!ids.has(s.serverId)).sort(byName);
 if(orphans.length)groups.push({server:null,sites:orphans});
 return groups;
}

// Databases DockNest already detects for capture: site.config.services entries with a supported engine. Nothing is invented.
// They are shown in the site's details panel, never as nodes: they always move together with the site.
// How the database is backed up: an online copy only when the app's switch is on, the engine can take one (the shared
// capability table) and incremental backups are off; otherwise the stopped file copy (docs/online-dumps.md).
const dbMode=(site,s)=>site?.config?.onlineDumps===true&&engineOnlineCopy(s.engine)&&s.persistence!=='cache'&&s.persistence!=='cache'&&site?.incremental?.enabled!==true?'Online copy, stays running':'Stopped file copy';
export function databasesOf(site){
 const list=Array.isArray(site?.config?.services)?site.config.services:[];
 return list.filter(s=>engineLabel(s?.engine)).map(s=>({id:site.id+':'+s.container,siteId:site.id,container:s.container,engine:s.engine,mode:dbMode(site,s),
  label:(s.flavor==='valkey'?'Valkey':engineLabel(s.engine))+(s.version?' '+s.version:'')+(s.database?' · '+s.database:'')+(s.engine==='redis'&&s.persistence==='cache'?' · cache only':s.engine==='redis'&&s.persistence==='disk'?' · saved to disk':'')}));
}
// The domains an app lists. Their DNS verdicts come from /api/domains (web/map/domains-model.js).
export const domainsOf=site=>Array.isArray(site?.config?.domains)?site.config.domains.filter(d=>typeof d==='string'&&d):[];

// Elbow with softly rounded corners. points: [[x,y],...]
export function elbow(points,r=8){
 const p=points.filter((q,i)=>i===0||q[0]!==points[i-1][0]||q[1]!==points[i-1][1]);
 let d='M'+p[0][0]+' '+p[0][1];
 for(let i=1;i<p.length-1;i++){
  const a=p[i-1],b=p[i],c=p[i+1],l1=Math.hypot(b[0]-a[0],b[1]-a[1]),l2=Math.hypot(c[0]-b[0],c[1]-b[1]),k=Math.min(r,l1/2,l2/2);
  const s=[b[0]+(a[0]-b[0])*k/l1,b[1]+(a[1]-b[1])*k/l1],e=[b[0]+(c[0]-b[0])*k/l2,b[1]+(c[1]-b[1])*k/l2];
  d+=` L${s[0]} ${s[1]} Q${b[0]} ${b[1]} ${e[0]} ${e[1]}`;
 }
 const last=p[p.length-1];return d+` L${last[0]} ${last[1]}`;
}
// Connection lines, like a workflow canvas (n8n): a forward link is one smooth cubic bezier with Vue Flow's shape (horizontal control points,
// curvature 0.25), a backward link (target left of or behind the source) leaves right, drops 130 below the source and comes back into the
// target's left side with rounded corners (radius 16, side offset 40), and a link at the same height stays a straight line.
export const EDGE={handle:20,drop:130,side:40,radius:16,curvature:0.25};
const control=(d,c)=>d>=0?0.5*d:c*25*Math.sqrt(-d);
const num=n=>Math.round(n*100)/100;
export function edgePath(a,b,{forward=false,curvature=EDGE.curvature}={}){
 const [sx,sy]=a,[tx,ty]=b;
 if(!forward&&sx>=tx-EDGE.handle){
  const by=Math.max(sy+EDGE.drop,ty+EDGE.side),points=[[sx,sy],[sx+EDGE.side,sy],[sx+EDGE.side,by],[tx-EDGE.side,by],[tx-EDGE.side,ty],[tx,ty]];
  return {d:elbow(points,EDGE.radius),points,kind:'back',labelX:num((sx+tx)/2),labelY:by};
 }
 if(sy===ty)return {d:'M'+sx+' '+sy+' L'+tx+' '+ty,points:[a,b],kind:'straight',labelX:num((sx+tx)/2),labelY:sy};
 const c1=sx+control(tx-sx,curvature),c2=tx-control(tx-sx,curvature);
 // points follow the curve (32 pieces), so hit and crossing checks see the real line
 const points=Array.from({length:33},(_,i)=>{const t=i/32,u=1-t;return [num(u*u*u*sx+3*u*u*t*c1+3*u*t*t*c2+t*t*t*tx),num(u*u*u*sy+3*u*u*t*sy+3*u*t*t*ty+t*t*t*ty)]});
 return {d:'M'+sx+' '+sy+' C'+num(c1)+' '+sy+' '+num(c2)+' '+ty+' '+tx+' '+ty,points,kind:'bezier',labelX:num((sx+3*c1+3*c2+tx)/8),labelY:num((sy+ty)/2)};
}
// Domain tree (docs/domains.md): par = valid parent of each id (never a cycle), kids = children by parent id (sorted), maxDepth = deepest column.
export function domainTree(doms){
 const byId=new Map(doms.map(d=>[d.id,d])),par={},kids=new Map();
 const own=d=>{const q=d.parentId&&d.parentId!==d.id&&byId.get(d.parentId);return q?q.id:null};
 for(const d of doms){let p=own(d);const seen=new Set([d.id]);let ok=true;while(p){if(seen.has(p)){ok=false;break}seen.add(p);p=own(byId.get(p))}par[d.id]=ok?own(d):null}
 for(const d of doms)if(par[d.id]){if(!kids.has(par[d.id]))kids.set(par[d.id],[]);kids.get(par[d.id]).push(d)}
 for(const l of kids.values())l.sort((a,b)=>a.id<b.id?-1:1);
 const depth=d=>{let n=0,p=par[d.id];while(p&&n<64){n++;p=par[p]}return n};
 return {par,kids,maxDepth:Math.max(0,...doms.map(depth))};
}
// Domains column (docs/domains.md): small nodes left of the servers. DOM_BLOCK is a node with its label.
export const DOMAIN_METRICS={size:48,block:76,gap:16,x:52,toServer:130,toParent:120,stub:44,label:150};


// opts.storage: [{id,...}] backup storage nodes; opts.links: [{id,a,b}] linked app pairs (drawn in a gutter right of the app column); opts.backupOf: {siteId: storageId} (which storage a site backs up to).
export function layoutMap(servers=[],sites=[],opts={},m=METRICS){
 const groups=groupForList(servers,sites),storage=[...(opts.storage||[])].sort(byName),backupOf=opts.backupOf||{};
 const doms=opts.domains||[],D=DOMAIN_METRICS;
 const {par,kids,maxDepth}=domainTree(doms);
 const STEP=D.size+D.toParent,SUBX=m.pad+D.x,DOMX=SUBX+maxDepth*STEP,DOMR=DOMX+D.size,serverX=doms.length?DOMR+D.toServer:m.pad,siteX=serverX+m.serverS+m.serverGap,channelS=serverX+m.serverS+m.serverGap/2;
 const out={domains:[],domainPaths:[],nowhere:[],servers:[],sites:[],storage:[],paths:[],backupPaths:[],linkPaths:[],unassigned:[],alerts:[],docknest:null,rulePaths:[]};
 // Alerts: a band above the map holds the DockNest source and one lane per line; nothing is drawn until a channel exists.
 const chs=opts.alerts?.channels||[],on=chs.length>0,serverIds=new Set(servers.map(s=>s.id)),siteIds=new Set(sites.map(s=>s.id));
 const rules=on?(opts.alerts.rules||[]).filter(r=>chs.some(c=>c.id===r.channelId)&&(r.sourceKind==='docknest'||(r.sourceKind==='server'?serverIds.has(r.sourceId):siteIds.has(r.sourceId)))):[];
 const lanes=rules.length>6?new Set(rules.map(r=>r.channelId)).size:rules.length,bandH=on?Math.max(112,48+m.laneGap*lanes):0,base=on?m.pad+bandH+8:m.pad;
 const links=opts.links||[],linkLanes=Math.min(links.length,6),linkW=linkLanes?m.linkBase+linkLanes*m.linkLane:0;
 const rightEdge=siteX+m.siteS,channelB=rightEdge+linkW+m.storageGap+16,storageX=channelB+m.storageGap;
 const rowH=m.siteS+m.label;
 let y=base;
 // Domains form a tree (docs/domains.md): subdomains sit in a column left of their root domain, and only root domains reach the
 // server. Every line runs from an output dot to an input dot (the server has one input dot on its left edge, a root with subdomains
 // has one on its left edge), so lines converge on one point and carry no arrowheads.
 const domainNode=(d,top,x=DOMX)=>{const cy=top+D.size/2,n={id:d.id,serverId:d.serverId||null,parentId:par[d.id]||null,aliases:d.aliases||[],partOf:d.partOf||null,pending:!!d.pending,ownerSiteId:d.ownerSiteId||null,x,y:top,w:D.size,h:D.size,cy};n.block={x:x+D.size/2-D.label/2,y:top,w:D.label,h:D.block};n.out={x:x+D.size,y:cy};out.domains.push(n);return n};
 const treeHeight=n=>{const ks=kids.get(n.id)||[];return Math.max(D.block,ks.length?ks.reduce((t,k)=>t+treeHeight(k),0)+(ks.length-1)*D.gap:0)};
 const stackHeight=roots=>roots.length?roots.reduce((t,r)=>t+treeHeight(r),0)+(roots.length-1)*D.gap:0;
 // A node is centred on its subdomains; each subdomain column sits one step left of its parent.
 function placeTree(d,top,depth){
  const h=treeHeight(d),n=domainNode(d,top+(h-D.block)/2+(D.block-D.size)/2,DOMX-depth*STEP),ks=kids.get(d.id)||[];
  if(ks.length){
   n.in={x:n.x,y:n.cy};
   let sy=top+(h-(ks.reduce((t,k)=>t+treeHeight(k),0)+(ks.length-1)*D.gap))/2;
   for(const k of ks){const c=placeTree(k,sy,depth+1),ep=edgePath([c.out.x,c.cy],[n.in.x,n.in.y]);out.domainPaths.push({id:k.id,parentId:d.id,serverId:null,points:ep.points,d:ep.d});sy+=treeHeight(k)+D.gap}
  }
  return n;
 }
 // Places root trees from top0; calls each(rootNode) and returns the bottom.
 function placeRoots(roots,top0,each){
  let top=top0;
  for(const r of roots){const h=treeHeight(r);each(placeTree(r,top,0));top+=h+D.gap}
  return top-D.gap;
 }
 const isRoot=d=>!par[d.id];
 for(const g of groups){
  const stack=g.sites.length?g.sites.length*rowH+(g.sites.length-1)*m.rowGap:0,block=m.serverS+m.label;
  const mineD=g.server?doms.filter(d=>isRoot(d)&&d.serverId===g.server.id):[],domStack=stackHeight(mineD);
  const height=Math.max(g.server?block:0,stack,domStack);
  let node=null;
  if(g.server){
   node={id:g.server.id,x:serverX,y:y+(height-block)/2,w:m.serverS,h:m.serverS};
   node.block={x:node.x+node.w/2-m.labelW.server/2,y:node.y,w:m.labelW.server,h:block};node.alertOut={x:node.x+node.w,y:node.y+m.serverS/2};
   if(mineD.length)node.in={x:node.x,y:node.y+m.serverS/2};
   out.servers.push(node);
   placeRoots(mineD,y+(height-domStack)/2,n=>{const ep=edgePath([n.out.x,n.cy],[node.in.x,node.in.y]);out.domainPaths.push({id:n.id,serverId:node.id,...(n.pending?{pending:true}:{}),points:ep.points,d:ep.d})});
  }
  let top=y+(height-stack)/2;
  for(const site of g.sites){
   const cy=top+m.siteS/2,rect={id:site.id,serverId:g.server?g.server.id:null,x:siteX,y:top,w:m.siteS,h:m.siteS,cy};
   rect.block={x:siteX+m.siteS/2-m.labelW.site/2,y:top,w:m.labelW.site,h:rowH};
   rect.in={x:siteX,y:cy};rect.out={x:rightEdge,y:cy};rect.alertOut=rect.out;rect.backupId=backupOf[site.id]||null;
   (g.server?out.sites:out.unassigned).push(rect);
   if(node){
    const x1=node.x+node.w,y1=node.y+m.serverS/2,x2=siteX,ep=edgePath([x1,y1],[x2-14,cy]);
    out.paths.push({id:site.id,serverId:node.id,x1,y1,x2,y2:cy,points:ep.points,d:ep.d});
   }
   top+=rowH+m.rowGap;
  }
  y+=height+m.groupGap;
 }
 // Domains that reach none of the servers: "Points nowhere" (red stub) and "Not placed yet" (grey stub, never looked up).
 for(const [kind,title] of [['nowhere','Points nowhere'],['unplaced','Not placed yet']]){
  const list=doms.filter(d=>isRoot(d)&&(!d.serverId||!serverIds.has(d.serverId))).filter(d=>(d.loose||'unplaced')===kind);
  if(!list.length)continue;
  const head={kind,title,x:DOMX+D.size/2-D.label/2,y,w:D.label,ids:list.map(d=>d.id)};out.nowhere.push(head);
  const end=placeRoots(list,y+36,n=>{n.loose=kind;out.domainPaths.push({id:n.id,serverId:null,stub:kind,points:[[DOMR,n.cy],[DOMR+D.stub,n.cy]],d:'M'+DOMR+' '+n.cy+' L'+(DOMR+D.stub)+' '+n.cy,end:{x:DOMR+D.stub,y:n.cy}})});
  y=end+m.groupGap;
 }
 let bottom=Math.max(y-m.groupGap+m.pad,m.pad*2+m.serverS+m.label);
 // Storage nodes sit at the average height of the sites that back up to them; a sweep keeps them apart.
 const all=[...out.sites,...out.unassigned];
 const items=storage.map(t=>{const mine=all.filter(s=>s.backupId===t.id);return {t,want:mine.length?mine.reduce((a,s)=>a+s.out.y,0)/mine.length-m.storageS/2:Infinity}}).sort((a,b)=>a.want-b.want);
 let prev=-Infinity;
 for(const it of items){
  const yy=Math.max(Number.isFinite(it.want)?it.want:base,prev+m.storagePitch,base);prev=yy;
  const node={id:it.t.id,x:storageX,y:yy,w:m.storageS,h:m.storageS};
  node.block={x:node.x+node.w/2-m.labelW.storage/2,y:yy,w:m.labelW.storage,h:m.storageS+m.label};
  node.in={x:storageX,y:yy+m.storageS/2};out.storage.push(node);bottom=Math.max(bottom,yy+m.storageS+m.label+m.pad);
 }
 for(const s of all){
  const t=s.backupId&&out.storage.find(n=>n.id===s.backupId);if(!t)continue;
  const ep=edgePath([s.out.x,s.out.y],[t.in.x-14,t.in.y]);
  out.backupPaths.push({id:s.id,storageId:t.id,points:ep.points,d:ep.d});
 }
 // Linked apps: dashed elbows in the gutter right of the app cards. A line leaves a card below its centre (backup uses the centre).
 // Short lines take the inner lane, so lines nest and never run through a card or its label.
 if(links.length){
  const by=Object.fromEntries(all.map(r=>[r.id,r])),ok=links.filter(l=>by[l.a]&&by[l.b]),yAt={};
  for(const r of all){ // offsets on one card: lines going up (nearest first), then lines going down (farthest first)
   const mine=ok.filter(l=>l.a===r.id||l.b===r.id).map(l=>{const o=by[l.a===r.id?l.b:l.a];return {l,d:o.out.y-r.out.y}});
   const up=mine.filter(x=>x.d<0).sort((p,q)=>q.d-p.d),down=mine.filter(x=>x.d>0).sort((p,q)=>q.d-p.d);
   [...up,...down].forEach((x,i)=>{(yAt[x.l.id]=yAt[x.l.id]||{})[r.id]=r.out.y+8+i*8});
  }
  const items=ok.map(l=>{const ya=yAt[l.id][l.a],yb=yAt[l.id][l.b];return {l,ya,yb,lo:Math.min(ya,yb),hi:Math.max(ya,yb)}}).sort((p,q)=>(p.hi-p.lo)-(q.hi-q.lo)),laneOf=[];
  for(const it of items){
   let k=0;for(const o of laneOf)if(o.lo>=it.lo&&o.hi<=it.hi&&o.k>=k)k=o.k+1;
   while(laneOf.some(o=>o.k===k&&o.lo<it.hi+24&&it.lo<o.hi+24))k++;
   laneOf.push({...it,k});
   const x=rightEdge+m.linkBase+Math.min(k,linkLanes-1)*m.linkLane,cx=num(rightEdge+(x-rightEdge)*4/3),pts=[[rightEdge,it.ya],[x,it.ya],[x,it.yb],[rightEdge,it.yb]];
   out.linkPaths.push({id:it.l.id,a:it.l.a,b:it.l.b,kind:it.l.kind,points:pts,d:'M'+rightEdge+' '+it.ya+' C'+cx+' '+it.ya+' '+cx+' '+it.yb+' '+rightEdge+' '+it.yb});
  }
 }
 out.width=Math.max(out.storage.length?storageX+m.storageS+m.pad:rightEdge+m.pad+48,rightEdge+m.pad);
 if(on){
  const alertX=storageX+m.storageS+m.alertGap,sy=m.pad+m.alertS/2;
  chs.forEach((c,i)=>{const yy=m.pad+i*m.alertPitch,n={id:c.id,x:alertX,y:yy,w:m.alertS,h:m.alertS};
   n.block={x:alertX+m.alertS/2-m.labelW.alert/2,y:yy,w:m.labelW.alert,h:m.alertS+m.label};n.in={x:alertX,y:yy+m.alertS/2};out.alerts.push(n);bottom=Math.max(bottom,yy+m.alertS+m.label+m.pad)});
  const dn={x:serverX,y:m.pad,w:m.alertS,h:m.alertS};dn.block={x:dn.x+dn.w/2-m.labelW.site/2,y:dn.y,w:m.labelW.site,h:m.alertS+m.label};dn.alertOut={x:dn.x+dn.w,y:dn.y+dn.h/2};out.docknest=dn;
  const lane=[46,52,58,64,70,84,90,96],srcOf=r=>r.sourceKind==='docknest'?dn:r.sourceKind==='server'?out.servers.find(n=>n.id===r.sourceId):[...out.sites,...out.unassigned].find(n=>n.id===r.sourceId);
  const ax0=storageX+m.storageS+40,gxOf=(r,src,i)=>r.sourceKind==='docknest'?dn.x+dn.w+48:r.sourceKind==='server'?src.x+src.w+40+(i%6)*4:src.alertOut.x+lane[i%8];
  // Lanes: the line that rises furthest left takes the highest lane and leaves furthest right, so lines nest and do not cross in the band.
  const placed=rules.map(r=>({r,src:srcOf(r)})).filter(x=>x.src).map((x,i)=>({...x,gx:gxOf(x.r,x.src,i)})).sort((a,b)=>a.gx-b.gx||a.src.alertOut.y-b.src.alertOut.y||(String(a.r.id)<String(b.r.id)?-1:1));
  const bundled=rules.length>6,mine=n=>placed.filter(p=>p.r.channelId===n.id);
  const rt=(s0,node)=>edgePath([s0.x,s0.y],[node.in.x-14,node.in.y]);
  out.bundled=bundled;
  if(bundled){
   const used=out.alerts.filter(n=>mine(n).length),step=Math.min(6,Math.floor(56/Math.max(1,used.length)));
   used.forEach((node,k)=>{const ep=rt(dn.alertOut,node);node.count=new Set(mine(node).map(p=>p.r.sourceKind+':'+p.r.sourceId)).size;
    out.rulePaths.push({id:'bundle:'+node.id,bundle:true,channelId:node.id,count:node.count,points:ep.points,d:ep.d})});
  }else{
   const step=Math.min(6,Math.floor(56/Math.max(1,placed.length)));
   placed.forEach(({r,src,gx},k)=>{
    const node=out.alerts.find(n=>n.id===r.channelId),ep=rt(src.alertOut,node);node.count=(node.count||0)+1;
    out.rulePaths.push({id:r.id,ruleId:r.id,channelId:r.channelId,sourceKind:r.sourceKind,sourceId:r.sourceId,points:ep.points,d:ep.d});
   });
  }
  out.width=alertX+m.alertS+m.pad;
 }
 out.height=bottom;out.x0=0;out.y0=0;
 // Free layout: the owner's saved positions replace the automatic ones node by node (unknown nodes keep their automatic place).
 // Lines are then drawn between the final ports with the same curves; they can cross a card, which is the owner's choice.
 const pos=opts.positions||{};
 const nodes=[...out.servers.map(n=>['server:'+n.id,n]),...[...out.sites,...out.unassigned].map(n=>['site:'+n.id,n]),...out.storage.map(n=>['storage:'+n.id,n]),...out.alerts.map(n=>['alert:'+n.id,n]),...out.domains.map(n=>['domain:'+n.id,n]),...(out.docknest?[['docknest:root',out.docknest]]:[])];
 out.keys=Object.fromEntries(nodes);
 if(nodes.some(([k])=>pos[k])){
  out.custom=true;
  for(const [k,n] of nodes){
   const p=pos[k];if(!p)continue;
   const dx=p.x-n.x,dy=p.y-n.y,ports=new Set([n.in,n.out,n.alertOut].filter(Boolean));
   n.x+=dx;n.y+=dy;n.block={...n.block,x:n.block.x+dx,y:n.block.y+dy};for(const q of ports){q.x+=dx;q.y+=dy}
  }
  const gen=(a,b)=>edgePath([a.x,a.y],[b.x-14,b.y]);
  const sv=Object.fromEntries(out.servers.map(n=>[n.id,n])),st=Object.fromEntries(out.storage.map(n=>[n.id,n])),al=Object.fromEntries(out.alerts.map(n=>[n.id,n]));
  out.paths=out.sites.filter(s=>sv[s.serverId]).map(s=>{const a=sv[s.serverId],ep=gen({x:a.x+a.w,y:a.y+a.h/2},{x:s.x,y:s.y+s.h/2});return {id:s.id,serverId:a.id,points:ep.points,d:ep.d}});
  out.backupPaths=[...out.sites,...out.unassigned].filter(s=>s.backupId&&st[s.backupId]).map(s=>{const t=st[s.backupId],ep=gen(s.out,t.in);return {id:s.id,storageId:t.id,points:ep.points,d:ep.d}});
  const dom=Object.fromEntries(out.domains.map(n=>[n.id,n]));
  out.domainPaths=out.domainPaths.map(p=>{const n=dom[p.id],a=n&&n.out;if(!a)return p;if(p.stub){const pts=[[a.x,a.y],[a.x+D.stub,a.y]];return {...p,points:pts,d:'M'+a.x+' '+a.y+' L'+(a.x+D.stub)+' '+a.y,end:{x:a.x+D.stub,y:a.y}}}if(p.parentId){const par=dom[p.parentId];if(!par||!par.in)return p;const ep=edgePath([a.x,a.y],[par.in.x,par.in.y]);return {...p,points:ep.points,d:ep.d}}const s=sv[p.serverId];if(!s||!s.in)return p;const ep=edgePath([a.x,a.y],[s.in.x,s.in.y]);return {...p,points:ep.points,d:ep.d}});
  out.nowhere=out.nowhere.filter(h=>!h.ids.some(id=>pos['domain:'+id]));
  out.rulePaths=out.rulePaths.map(p=>{const src=p.bundle?out.docknest:p.sourceKind==='docknest'?out.docknest:p.sourceKind==='server'?sv[p.sourceId]:[...out.sites,...out.unassigned].find(n=>n.id===p.sourceId),node=al[p.channelId],ep=gen(src.alertOut,node.in);return {...p,points:ep.points,d:ep.d}});
  // The canvas grows in every direction: a node left of or above the automatic layout widens it there, with the same margin.
  let x0=0,y0=0,x1=0,y1=0;
  for(const [,n] of nodes){x0=Math.min(x0,n.x-m.pad,n.block.x);y0=Math.min(y0,n.y-m.pad,n.block.y);x1=Math.max(x1,n.block.x+n.block.w+m.pad,n.x+n.w+m.pad);y1=Math.max(y1,n.block.y+n.block.h+m.pad)}
  out.x0=x0;out.y0=y0;out.width=Math.max(x1-x0,m.pad*2);out.height=Math.max(y1-y0,m.pad*2);
 }
 return out;
}

// Map coordinates: the canvas spans x0..x0+width and y0..y0+height. x0 and y0 are 0 for the automatic layout and negative once a node
// sits left of or above it. Everything else (nodes, ports, lines, the view offset) uses the same coordinates, with no wall at 0.
export const GRID=16;
export const snapToGrid=v=>Math.round(v/GRID)*GRID||0; // never -0
// The view offset at zoom k that puts the middle of the canvas in the middle of a w x h view. When it does not fit, the automatic layout keeps
// that centre (both ends cut equally); a layout with places the owner chose starts at its top left corner, so a node they moved far out stays in view.
export const homeOffset=(l,k,w,h)=>{const mid=(view,size)=>{const free=(view-size*k)/2;return free>=0||!l.custom?free:0};return {x:mid(w,l.width)-l.x0*k,y:mid(h,l.height)-l.y0*k}};
// Whether part of the canvas lies outside a w x h view at offset t ({x,y,k}).
export const clippedIn=(l,t,w,h)=>t.x+l.x0*t.k<-2||t.y+l.y0*t.k<-2||t.x+(l.x0+l.width)*t.k>w+2||t.y+(l.y0+l.height)*t.k>h+2;
