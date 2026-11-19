import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutMap,databasesOf,domainsOf,METRICS,snapToGrid,homeOffset,clippedIn} from '../web/map/layout.js';
import {cleanPositions} from '../web/map/saved-layout.js';

const make=(ns,nm)=>{const servers=[],sites=[];for(let i=0;i<ns;i++){servers.push({id:'s'+i,name:'Server '+String(ns-i).padStart(2,'0')});for(let j=0;j<(nm+i)%(nm+1);j++)sites.push({id:`s${i}-w${j}`,serverId:'s'+i,name:'site-'+((j*7)%13)+'.example.com'});}return {servers,sites};};
const storageFor=(sites,n=3)=>{const storage=Array.from({length:n},(_,i)=>({id:'t'+i,name:'Storage '+i})),backupOf={};sites.forEach((s,i)=>{if(i%4!==3)backupOf[s.id]=storage[i%n].id});return {storage,backupOf};};
const overlap=(a,b)=>a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h;

test('empty and server-only inputs',()=>{
 assert.deepEqual(layoutMap([],[]).servers,[]);
 const l=layoutMap([{id:'a',name:'A'}],[]);
 assert.equal(l.servers.length,1);assert.equal(l.paths.length,0);assert.ok(l.height>0&&l.width>0);
});
test('deterministic and independent of input order',()=>{
 const {servers,sites}=make(6,5),o=storageFor(sites),r={storage:[...o.storage].reverse(),backupOf:o.backupOf};
 const a=layoutMap(servers,sites,o),b=layoutMap([...servers].reverse(),[...sites].reverse(),r);
 assert.deepEqual(a,b);
 assert.deepEqual(layoutMap(servers,sites,o),a);
});
test('servers ordered by name, sites by name inside their group',()=>{
 const l=layoutMap([{id:'2',name:'beta'},{id:'1',name:'Alpha'}],[{id:'x',serverId:'1',name:'b'},{id:'y',serverId:'1',name:'A'}]);
 assert.deepEqual(l.servers.map(s=>s.id),['1','2']);
 assert.deepEqual(l.sites.map(s=>s.id),['y','x']);
});
test('no overlaps (labels included) and sites sit beside their own server group',()=>{
 const {servers,sites}=make(12,9),l=layoutMap(servers,sites,storageFor(sites)),all=[...l.servers,...l.sites,...l.storage];
 for(const n of all)assert.ok(n.block&&n.block.w>=n.w);
 for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++)assert.ok(!overlap(all[i].block,all[j].block),`${all[i].id} overlaps ${all[j].id}`);
 assert.ok(l.sites.every(s=>{const n=l.servers.find(x=>x.id===s.serverId);return n&&s.x>n.x+n.w}));
 assert.ok(l.storage.every(t=>l.sites.every(s=>t.x>s.x+s.w)));
});

// Every line is a list of horizontal and vertical segments.
const segments=p=>p.points.slice(1).map((q,i)=>[p.points[i],q]);
const inside=(pt,r)=>pt[0]>r.x+0.5&&pt[0]<r.x+r.w-0.5&&pt[1]>r.y+0.5&&pt[1]<r.y+r.h-0.5;
const hitsRect=(seg,r)=>{const [[x1,y1],[x2,y2]]=seg,minx=Math.min(x1,x2),maxx=Math.max(x1,x2),miny=Math.min(y1,y2),maxy=Math.max(y1,y2);return minx<r.x+r.w-0.5&&maxx>r.x+0.5&&miny<r.y+r.h-0.5&&maxy>r.y+0.5};
test('lines never cross cards or labels',()=>{
 const {servers,sites}=make(10,7),l=layoutMap(servers,sites,storageFor(sites)),blocks=[...l.servers,...l.sites,...l.storage].map(n=>({id:n.id,...n.block}));
 const lines=[...l.paths.map(p=>({p,from:p.serverId,to:p.id})),...l.backupPaths.map(p=>({p,from:p.id,to:p.storageId}))];
 assert.ok(lines.length>0);
 for(const {p,from,to} of lines)for(const seg of segments(p))for(const b of blocks){
  if(b.id===from||b.id===to)continue;
  assert.ok(!hitsRect(seg,b),`line ${from}->${to} crosses ${b.id}`);
 }
});
test('server lines of different servers never cross',()=>{
 const {servers,sites}=make(20,15),l=layoutMap(servers,sites);
 assert.equal(l.paths.length,sites.length);
 const o=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
 const cross=(a,b,c,d)=>o(a,b,c)*o(a,b,d)<0&&o(c,d,a)*o(c,d,b)<0;
 for(let i=0;i<l.paths.length;i++)for(let j=i+1;j<l.paths.length;j++){
  if(l.paths[i].serverId===l.paths[j].serverId)continue;
  for(const [a,b] of segments(l.paths[i]))for(const [c,d] of segments(l.paths[j]))assert.ok(!cross(a,b,c,d),`${l.paths[i].id} crosses ${l.paths[j].id}`);
 }
});
test('only sites with a backup get a backup line, ending at their storage',()=>{
 const {servers,sites}=make(4,4),o=storageFor(sites),l=layoutMap(servers,sites,o);
 assert.equal(l.backupPaths.length,Object.keys(o.backupOf).length);
 for(const p of l.backupPaths){const t=l.storage.find(x=>x.id===p.storageId),end=p.points.at(-1);assert.ok(end[0]<t.x&&end[1]===t.in.y)}
 assert.equal(layoutMap(servers,sites).storage.length,0);
});
test('databases and domains come from existing site data and are never invented',()=>{
 const site={id:'1',config:{services:[{container:'db',engine:'postgres',version:'16.2',database:'shop_db'},{container:'c',engine:'redis',version:'7.4.1'},{container:'app',engine:'generic'},{container:'x',engine:'auto'}],domains:['a.example.com','',5]}};
 assert.deepEqual(databasesOf(site).map(d=>d.label),['PostgreSQL 16.2 · shop_db','Redis 7.4.1']);
 assert.deepEqual(domainsOf(site),['a.example.com']);
 assert.deepEqual(databasesOf({id:'2'}),[]);assert.deepEqual(domainsOf({id:'2'}),[]);
});
// Alert nodes and lines (2.8.0): purely additive; nothing changes until a channel exists.
test('without channels the layout has no alert nodes and is unchanged',()=>{
 const {servers,sites}=make(4,4),a=layoutMap(servers,sites,storageFor(sites)),b=layoutMap(servers,sites,{...storageFor(sites),alerts:{channels:[],rules:[{id:'r',channelId:'x',sourceKind:'docknest',sourceId:null,events:['backup.failed']}]}});
 assert.deepEqual(a,b);assert.equal(a.docknest,null);assert.deepEqual(a.alerts,[]);assert.deepEqual(a.rulePaths,[]);
});
test('alert lines never cross cards or labels and reach their alert node',()=>{
 const {servers,sites}=make(8,6),o=storageFor(sites),channels=[{id:'c1',name:'Ops chat',kind:'telegram'},{id:'c2',name:'Mail',kind:'email'},{id:'c3',name:'Pager',kind:'telegram'}];
 const rules=[{id:'d1',channelId:'c1',sourceKind:'docknest',sourceId:null}];
 servers.slice(0,3).forEach((s,i)=>rules.push({id:'sv'+i,channelId:channels[i%3].id,sourceKind:'server',sourceId:s.id}));
 sites.slice(0,5).forEach((s,i)=>{if(i%3===1)rules.push({id:'st'+i,channelId:channels[(i+1)%3].id,sourceKind:'site',sourceId:s.id})});
 rules.push({id:'gone',channelId:'c1',sourceKind:'site',sourceId:'missing'},{id:'nochan',channelId:'zzz',sourceKind:'docknest',sourceId:null});
 const l=layoutMap(servers,sites,{...o,alerts:{channels,rules}});
 assert.equal(l.rulePaths.length,rules.length-2,'rules for something gone are skipped');
 assert.equal(l.alerts.length,3);assert.ok(l.docknest);
 const blocks=[l.docknest,...l.servers,...l.sites,...l.storage,...l.alerts].map(n=>({id:n.id||'docknest',...n.block}));
 for(const n of blocks)for(const q of blocks)if(n!==q)assert.ok(!overlap(n,q),`${n.id} overlaps ${q.id}`);
 for(const p of l.rulePaths){
  const from=p.sourceKind==='docknest'?'docknest':p.sourceId,to=p.channelId,end=p.points.at(-1),node=l.alerts.find(a=>a.id===to);
  assert.ok(end[0]<node.x&&end[1]===node.in.y,'ends at the alert input');
  for(const seg of segments(p))for(const b of blocks){if(b.id===from||b.id===to)continue;assert.ok(!hitsRect(seg,b),`line ${p.id} crosses ${b.id}`);}
 }
 const top=Math.min(...[...l.servers,...l.sites,...l.storage].map(n=>n.y));
 assert.ok(top>l.docknest.block.y+l.docknest.block.h,'the map starts below the alert band');
});
test('more than 6 lines collapse to one line per alert node with a count of its sources',()=>{
 const {servers,sites}=make(8,6),channels=[{id:'c1',name:'A',kind:'telegram'},{id:'c2',name:'B',kind:'email'}];
 const rules=servers.map((s,i)=>({id:'sv'+i,channelId:channels[i%2].id,sourceKind:'server',sourceId:s.id}));
 const l=layoutMap(servers,sites,{alerts:{channels,rules}});
 assert.equal(l.bundled,true);assert.equal(l.rulePaths.length,2);assert.deepEqual(l.rulePaths.map(p=>p.count),[4,4]);
 assert.deepEqual(l.alerts.map(n=>n.count),[4,4]);
});
test('saved positions move only their node, lines follow and unknown nodes keep their automatic place',()=>{
 const {servers,sites}=make(3,3),o=storageFor(sites),auto=layoutMap(servers,sites,o),s0=auto.sites[0],t0=auto.storage[0];
 const l=layoutMap(servers,sites,{...o,positions:{['site:'+s0.id]:{x:s0.x+48,y:s0.y+96},['storage:'+t0.id]:{x:t0.x,y:t0.y+200},'site:gone':{x:1,y:1}}});
 const moved=l.sites.find(s=>s.id===s0.id);
 assert.deepEqual([moved.x,moved.y],[s0.x+48,s0.y+96]);assert.deepEqual([moved.in.x,moved.in.y],[s0.in.x+48,s0.in.y+96]);
 assert.deepEqual(l.sites.slice(1).map(s=>[s.x,s.y]),auto.sites.slice(1).map(s=>[s.x,s.y]),'other sites stay');
 assert.equal(l.paths.length,auto.paths.length);assert.equal(l.backupPaths.length,auto.backupPaths.length);
 assert.deepEqual(l.paths.find(p=>p.id===s0.id).points.at(-1),[moved.x-14,moved.in.y],'a line ends at the moved input');
 assert.equal(l.custom,true);assert.equal(auto.custom,undefined);
 assert.deepEqual(layoutMap(servers,sites,{...o,positions:{}}),auto,'no positions is the automatic layout');
});
test('metrics stay on the 8 px rhythm',()=>{for(const k of ['pad','serverS','siteS','storageS','rowGap','groupGap'])assert.equal(METRICS[k]%8,0,k)});
test('a node moved left of and above the layout grows the canvas there, with no wall at 0',()=>{
 const {servers,sites}=make(2,2),o=storageFor(sites),auto=layoutMap(servers,sites,o),key='site:'+auto.sites[0].id;
 assert.deepEqual([auto.x0,auto.y0],[0,0],'the automatic layout starts at 0');
 const l=layoutMap(servers,sites,{...o,positions:{[key]:{x:-400,y:-320}}}),n=l.keys[key];
 assert.deepEqual([n.x,n.y],[-400,-320],'the position is used as given');
 assert.ok(l.x0<=n.block.x&&l.x0<=n.x-METRICS.pad&&l.y0<=n.y-METRICS.pad,'the canvas reaches past the moved node');
 assert.ok(l.x0+l.width>=auto.width&&l.y0+l.height>=auto.height-1,'and still covers the rest of the map');
 assert.deepEqual(l.paths.find(p=>p.id===auto.sites[0].id).points.at(-1),[n.x-14,n.y+n.h/2],'its line follows it');
 const same=layoutMap(servers,sites,{...o,positions:{[key]:{x:auto.sites[0].x,y:auto.sites[0].y}}});
 assert.deepEqual([same.x0,same.y0],[0,0],'a node left in place keeps the canvas origin');
});
test('snapping, the home view and the out-of-view check use the same coordinates',()=>{
 assert.deepEqual([-500,-9,-7,0,7,8,23].map(snapToGrid),[-496,-16,0,0,0,16,16]);
 const l={x0:-200,y0:-100,width:600,height:400};
 assert.deepEqual(homeOffset(l,1,1000,800),{x:400,y:300},'centred when it fits: x0 lands at the left edge of the centred box');
 assert.deepEqual(homeOffset(l,0.5,200,100),{x:100,y:50},'otherwise its top left corner is at the view corner');
 assert.equal(clippedIn(l,{x:400,y:300,k:1},1000,800),false);
 assert.equal(clippedIn(l,{x:100,y:300,k:1},1000,800),true,'a node left of the view counts as out of view');
});
test('saved positions are read back only when they are sound',()=>{
 assert.deepEqual(cleanPositions({'site:a':{x:-480,y:-96},'server:b':{x:32,y:48,extra:1}}),{'site:a':{x:-480,y:-96},'server:b':{x:32,y:48}});
 for(const bad of [null,'x',[],42])assert.deepEqual(cleanPositions(bad),{});
 assert.deepEqual(cleanPositions({'site:a':{x:'1',y:2},'site:b':{x:NaN,y:0},'site:c':{x:1e9,y:0},'nope:d':{x:1,y:1},'site:':{x:1,y:1},'site:e':null}),{});
});
