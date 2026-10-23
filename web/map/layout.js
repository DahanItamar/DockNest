// Pure, deterministic map layout (n8n style). Columns, left to right: servers, sites, backup storage. Groups are contiguous and in the same order on both sides, and every
// line runs in a free gutter or through free space of its own row, so no line ever crosses a card. Nothing is persisted.
export const METRICS={pad:40,serverS:96,siteS:64,storageS:96,label:44,serverGap:140,rowGap:24,groupGap:32,storageGap:60,storagePitch:168,
 labelW:{server:160,site:144,storage:160}};
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
 const out={servers:[],sites:[],storage:[],paths:[],backupPaths:[],unassigned:[]};
 const rightEdge=siteX+m.siteS,channelB=rightEdge+m.storageGap+16,storageX=channelB+m.storageGap;
 const rowH=m.siteS+m.label;
 let y=m.pad;
 for(const g of groups){
  const stack=g.sites.length?g.sites.length*rowH+(g.sites.length-1)*m.rowGap:0,block=m.serverS+m.label;
  const height=Math.max(g.server?block:0,stack);
  let node=null;
  if(g.server){
   node={id:g.server.id,x:serverX,y:y+(height-block)/2,w:m.serverS,h:m.serverS};
   node.block={x:node.x+node.w/2-m.labelW.server/2,y:node.y,w:m.labelW.server,h:block};
   out.servers.push(node);
  }
  let top=y+(height-stack)/2;
  for(const site of g.sites){
   const cy=top+m.siteS/2,rect={id:site.id,serverId:g.server?g.server.id:null,x:siteX,y:top,w:m.siteS,h:m.siteS,cy};
   rect.block={x:siteX+m.siteS/2-m.labelW.site/2,y:top,w:m.labelW.site,h:rowH};
   rect.in={x:siteX,y:cy};rect.out={x:rightEdge,y:cy};rect.backupId=backupOf[site.id]||null;
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
  const yy=Math.max(Number.isFinite(it.want)?it.want:m.pad,prev+m.storagePitch,m.pad);prev=yy;
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
 out.height=bottom;
 return out;
}
