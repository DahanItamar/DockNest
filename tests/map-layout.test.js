import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutMap,databasesOf,domainsOf,METRICS} from '../web/map/layout.js';

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
test('metrics stay on the 8 px rhythm',()=>{for(const k of ['pad','serverS','siteS','storageS','rowGap','groupGap'])assert.equal(METRICS[k]%8,0,k)});
