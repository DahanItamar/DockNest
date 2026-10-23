// Pure, deterministic map layout. Servers on the left in name order, each with its sites stacked on the right.
// Groups are contiguous and in the same order on both sides, so connectors can never cross. Nothing is persisted.
export const METRICS={pad:40,serverW:240,serverH:120,cardW:240,cardH:72,cardGap:16,groupGap:32,columnGap:180};
const byName=(a,b)=>{const x=String(a.name||'').toLowerCase(),y=String(b.name||'').toLowerCase();return x<y?-1:x>y?1:String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0};

// Same grouping and order for the canvas, the phone list and screen readers.
export function groupForList(servers=[],sites=[]){
 const ordered=[...servers].sort(byName),ids=new Set(ordered.map(s=>s.id));
 const groups=ordered.map(server=>({server,sites:sites.filter(s=>s.serverId===server.id).sort(byName)}));
 const orphans=sites.filter(s=>!ids.has(s.serverId)).sort(byName);
 if(orphans.length)groups.push({server:null,sites:orphans});
 return groups;
}

export function layoutMap(servers=[],sites=[],m=METRICS){
 const groups=groupForList(servers,sites),cardX=m.pad+m.serverW+m.columnGap;
 const out={servers:[],sites:[],paths:[],unassigned:[]};
 let y=m.pad;
 for(const g of groups){
  const stack=g.sites.length?g.sites.length*m.cardH+(g.sites.length-1)*m.cardGap:0;
  const height=Math.max(g.server?m.serverH:0,stack);
  let node=null;
  if(g.server){node={id:g.server.id,x:m.pad,y:y+(height-m.serverH)/2,w:m.serverW,h:m.serverH};out.servers.push(node);}
  let cy=y+(height-stack)/2;
  for(const site of g.sites){
   const rect={id:site.id,serverId:g.server?g.server.id:null,x:cardX,y:cy,w:m.cardW,h:m.cardH};
   (g.server?out.sites:out.unassigned).push(rect);
   if(node){
    const x1=node.x+node.w,y1=node.y+node.h/2,x2=rect.x,y2=rect.y+rect.h/2,mid=(x1+x2)/2;
    out.paths.push({id:site.id,serverId:node.id,x1,y1,x2,y2,d:`M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`});
   }
   cy+=m.cardH+m.cardGap;
  }
  y+=height+m.groupGap;
 }
 out.width=cardX+m.cardW+m.pad;
 out.height=Math.max(y-m.groupGap+m.pad,m.pad*2+m.serverH);
 return out;
}
