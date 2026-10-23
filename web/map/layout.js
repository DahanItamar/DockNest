// Pure, deterministic map layout (n8n style). Columns, left to right: servers, sites, backup storage. Groups are contiguous and in the same order on both sides, and every
// line runs in a free gutter or through free space of its own row, so no line ever crosses a card. Nothing is persisted.
export const METRICS={pad:40,serverS:96,siteS:64,storageS:96,label:44,serverGap:140,rowGap:24,groupGap:32,storageGap:60,storagePitch:168,
 labelW:{server:160,site:144,storage:160,alert:160},alertS:64,alertGap:150,alertPitch:128,laneGap:28};
const byName=(a,b)=>{const x=String(a.name||'').toLowerCase(),y=String(b.name||'').toLowerCase();return x<y?-1:x>y?1:String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0};

// Same grouping and order for the canvas, the phone list and screen readers.
export function groupForList(servers=[],sites=[]){
 const ordered=[...servers].sort(byName),ids=new Set(ordered.map(s=>s.id));
 const groups=ordered.map(server=>({server,sites:sites.filter(s=>s.serverId===server.id).sort(byName)}));
 const orphans=sites.filter(s=>!ids.has(s.serverId)).sort(byName);
 if(orphans.length)groups.push({server:null,sites:orphans});
 return groups;
}

const ENGINES={postgres:'PostgreSQL',mysql:'MySQL',mariadb:'MariaDB',redis:'Redis'};
// Databases DockNest already detects for capture: site.config.services entries with a supported engine. Nothing is invented.
// They are shown in the site's details panel, never as nodes: they always move together with the site.
export function databasesOf(site){
 const list=Array.isArray(site?.config?.services)?site.config.services:[];
 return list.filter(s=>ENGINES[s?.engine]).map(s=>({id:site.id+':'+s.container,siteId:site.id,container:s.container,engine:s.engine,
  label:ENGINES[s.engine]+(s.version?' '+s.version:'')+(s.database?' · '+s.database:'')}));
}
// The domains of a site. No DNS data is available here, so there is no DNS verdict.
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
const route=(x1,y1,x2,y2,cx)=>y1===y2?[[x1,y1],[x2,y2]]:[[x1,y1],[cx,y1],[cx,y2],[x2,y2]];

// opts.storage: [{id,...}] backup storage nodes; opts.backupOf: {siteId: storageId} (which storage a site backs up to).
export function layoutMap(servers=[],sites=[],opts={},m=METRICS){
 const groups=groupForList(servers,sites),storage=[...(opts.storage||[])].sort(byName),backupOf=opts.backupOf||{};
 const serverX=m.pad,siteX=serverX+m.serverS+m.serverGap,channelS=serverX+m.serverS+m.serverGap/2;
 const out={servers:[],sites:[],storage:[],paths:[],backupPaths:[],unassigned:[],alerts:[],docknest:null,rulePaths:[]};
 // Alerts: a band above the map holds the DockNest source and one lane per line; nothing is drawn until a channel exists.
 const chs=opts.alerts?.channels||[],on=chs.length>0,serverIds=new Set(servers.map(s=>s.id)),siteIds=new Set(sites.map(s=>s.id));
 const rules=on?(opts.alerts.rules||[]).filter(r=>chs.some(c=>c.id===r.channelId)&&(r.sourceKind==='docknest'||(r.sourceKind==='server'?serverIds.has(r.sourceId):siteIds.has(r.sourceId)))):[];
 const lanes=rules.length>6?new Set(rules.map(r=>r.channelId)).size:rules.length,bandH=on?Math.max(112,48+m.laneGap*lanes):0,base=on?m.pad+bandH+8:m.pad;
 const rightEdge=siteX+m.siteS,channelB=rightEdge+m.storageGap+16,storageX=channelB+m.storageGap;
 const rowH=m.siteS+m.label;
 let y=base;
 for(const g of groups){
  const stack=g.sites.length?g.sites.length*rowH+(g.sites.length-1)*m.rowGap:0,block=m.serverS+m.label;
  const height=Math.max(g.server?block:0,stack);
  let node=null;
  if(g.server){
   node={id:g.server.id,x:serverX,y:y+(height-block)/2,w:m.serverS,h:m.serverS};
   node.block={x:node.x+node.w/2-m.labelW.server/2,y:node.y,w:m.labelW.server,h:block};node.alertOut={x:node.x+node.w,y:node.y+m.serverS/2};
   out.servers.push(node);
  }
  let top=y+(height-stack)/2;
  for(const site of g.sites){
   const cy=top+m.siteS/2,rect={id:site.id,serverId:g.server?g.server.id:null,x:siteX,y:top,w:m.siteS,h:m.siteS,cy};
   rect.block={x:siteX+m.siteS/2-m.labelW.site/2,y:top,w:m.labelW.site,h:rowH};
   rect.in={x:siteX,y:cy};rect.out={x:rightEdge,y:cy};rect.alertOut=rect.out;rect.backupId=backupOf[site.id]||null;
   (g.server?out.sites:out.unassigned).push(rect);
   if(node){
    const x1=node.x+node.w,y1=node.y+m.serverS/2,x2=siteX,pts=route(x1,y1,x2-14,cy,channelS);
    out.paths.push({id:site.id,serverId:node.id,x1,y1,x2,y2:cy,points:pts,d:elbow(pts)});
   }
   top+=rowH+m.rowGap;
  }
  y+=height+m.groupGap;
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
  const pts=route(s.out.x,s.out.y,t.in.x-14,t.in.y,channelB);
  out.backupPaths.push({id:s.id,storageId:t.id,points:pts,d:elbow(pts)});
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
  const rt=(s0,gx,L,ax,node)=>[[s0.x,s0.y],[gx,s0.y],[gx,L],[ax,L],[ax,node.in.y],[node.in.x-14,node.in.y]];
  out.bundled=bundled;
  if(bundled){
   const used=out.alerts.filter(n=>mine(n).length),step=Math.min(6,Math.floor(56/Math.max(1,used.length)));
   used.forEach((node,k)=>{const pts=rt(dn.alertOut,dn.x+dn.w+48+k*3,sy+k*m.laneGap,ax0+(used.length-1-k)*step,node);node.count=new Set(mine(node).map(p=>p.r.sourceKind+':'+p.r.sourceId)).size;
    out.rulePaths.push({id:'bundle:'+node.id,bundle:true,channelId:node.id,count:node.count,points:pts,d:elbow(pts,12)})});
  }else{
   const step=Math.min(6,Math.floor(56/Math.max(1,placed.length)));
   placed.forEach(({r,src,gx},k)=>{
    const node=out.alerts.find(n=>n.id===r.channelId),pts=rt(src.alertOut,gx,sy+k*m.laneGap,ax0+(placed.length-1-k)*step,node);node.count=(node.count||0)+1;
    out.rulePaths.push({id:r.id,ruleId:r.id,channelId:r.channelId,sourceKind:r.sourceKind,sourceId:r.sourceId,points:pts,d:elbow(pts,12)});
   });
  }
  out.width=alertX+m.alertS+m.pad;
 }
 out.height=bottom;
 // Free layout: the owner's saved positions replace the automatic ones node by node (unknown nodes keep their automatic place).
 // Lines are then drawn between the final ports with plain elbows; they can cross a card, which is the owner's choice.
 const pos=opts.positions||{};
 const nodes=[...out.servers.map(n=>['server:'+n.id,n]),...[...out.sites,...out.unassigned].map(n=>['site:'+n.id,n]),...out.storage.map(n=>['storage:'+n.id,n]),...out.alerts.map(n=>['alert:'+n.id,n]),...(out.docknest?[['docknest:root',out.docknest]]:[])];
 out.keys=Object.fromEntries(nodes);
 if(nodes.some(([k])=>pos[k])){
  out.custom=true;
  for(const [k,n] of nodes){
   const p=pos[k];if(!p)continue;
   const dx=p.x-n.x,dy=p.y-n.y,ports=new Set([n.in,n.out,n.alertOut].filter(Boolean));
   n.x+=dx;n.y+=dy;n.block={...n.block,x:n.block.x+dx,y:n.block.y+dy};for(const q of ports){q.x+=dx;q.y+=dy}
   if(n.block2)n.block2={...n.block2,x:n.block2.x+dx,y:n.block2.y+dy};
  }
  const gen=(a,b)=>{const x1=a.x,y1=a.y,x2=b.x-14,y2=b.y;if(y1===y2&&x2>x1)return [[x1,y1],[x2,y2]];if(x2>x1+24){const mx=Math.round((x1+x2)/2);return [[x1,y1],[mx,y1],[mx,y2],[x2,y2]]}const lo=Math.max(x1,x2)+24,my=Math.round((y1+y2)/2);return [[x1,y1],[x1+20,y1],[x1+20,my],[x2-20,my],[x2-20,y2],[x2,y2]]};
  const sv=Object.fromEntries(out.servers.map(n=>[n.id,n])),st=Object.fromEntries(out.storage.map(n=>[n.id,n])),al=Object.fromEntries(out.alerts.map(n=>[n.id,n]));
  out.paths=out.sites.filter(s=>sv[s.serverId]).map(s=>{const a=sv[s.serverId],pts=gen({x:a.x+a.w,y:a.y+a.h/2},{x:s.x,y:s.y+s.h/2});return {id:s.id,serverId:a.id,points:pts,d:elbow(pts)}});
  out.backupPaths=[...out.sites,...out.unassigned].filter(s=>s.backupId&&st[s.backupId]).map(s=>{const t=st[s.backupId],pts=gen(s.out,t.in);return {id:s.id,storageId:t.id,points:pts,d:elbow(pts)}});
  out.rulePaths=out.rulePaths.map(p=>{const src=p.bundle?out.docknest:p.sourceKind==='docknest'?out.docknest:p.sourceKind==='server'?sv[p.sourceId]:[...out.sites,...out.unassigned].find(n=>n.id===p.sourceId),node=al[p.channelId],pts=gen(src.alertOut,node.in);return {...p,points:pts,d:elbow(pts,12)}});
  let w=0,h=0;for(const [,n] of nodes){w=Math.max(w,n.block.x+n.block.w+m.pad,n.x+n.w+m.pad);h=Math.max(h,n.block.y+n.block.h+m.pad)}
  out.width=Math.max(w,m.pad*2);out.height=Math.max(h,m.pad*2);
 }
 return out;
}
