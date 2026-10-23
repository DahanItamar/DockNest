import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutMap,METRICS} from '../web/map/layout.js';

const make=(ns,nm)=>{const servers=[],sites=[];for(let i=0;i<ns;i++){servers.push({id:'s'+i,name:'Server '+String(ns-i).padStart(2,'0')});for(let j=0;j<(nm+i)%(nm+1);j++)sites.push({id:`s${i}-w${j}`,serverId:'s'+i,name:'site-'+((j*7)%13)+'.example.com'});}return {servers,sites};};
const overlap=(a,b)=>a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h;

test('empty and server-only inputs',()=>{
 assert.deepEqual(layoutMap([],[]).servers,[]);
 const l=layoutMap([{id:'a',name:'A'}],[]);
 assert.equal(l.servers.length,1);assert.equal(l.paths.length,0);assert.ok(l.height>0&&l.width>0);
});
test('deterministic and independent of input order',()=>{
 const {servers,sites}=make(6,5);
 const a=layoutMap(servers,sites),b=layoutMap([...servers].reverse(),[...sites].reverse());
 assert.deepEqual(a,b);
 assert.deepEqual(layoutMap(servers,sites),a);
});
test('servers ordered by name, sites by name inside their group',()=>{
 const l=layoutMap([{id:'2',name:'beta'},{id:'1',name:'Alpha'}],[{id:'x',serverId:'1',name:'b'},{id:'y',serverId:'1',name:'A'}]);
 assert.deepEqual(l.servers.map(s=>s.id),['1','2']);
 assert.deepEqual(l.sites.map(s=>s.id),['y','x']);
});
test('no overlaps and sites sit beside their own server group',()=>{
 const {servers,sites}=make(12,9),l=layoutMap(servers,sites),all=[...l.servers,...l.sites];
 for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++)assert.ok(!overlap(all[i],all[j]),`${all[i].id} overlaps ${all[j].id}`);
 assert.ok(l.sites.every(s=>{const n=l.servers.find(x=>x.id===s.serverId);return n&&s.x>n.x+n.w}));
});
test('connectors never cross',()=>{
 const {servers,sites}=make(20,15),l=layoutMap(servers,sites);
 assert.equal(l.paths.length,sites.length);
 const sample=p=>{const mid=(p.x1+p.x2)/2,pts=[];for(let i=0;i<=24;i++){const t=i/24,u=1-t;pts.push([u*u*u*p.x1+3*u*u*t*mid+3*u*t*t*mid+t*t*t*p.x2,u*u*u*p.y1+3*u*u*t*p.y1+3*u*t*t*p.y2+t*t*t*p.y2]);}return pts};
 const o=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
 const cross=(a,b,c,d)=>o(a,b,c)*o(a,b,d)<-1e-9&&o(c,d,a)*o(c,d,b)<-1e-9;
 const lines=l.paths.map(sample);
 for(let i=0;i<lines.length;i++)for(let j=i+1;j<lines.length;j++){
  if(l.paths[i].serverId===l.paths[j].serverId)continue;
  for(let a=0;a<24;a++)for(let b=0;b<24;b++)assert.ok(!cross(lines[i][a],lines[i][a+1],lines[j][b],lines[j][b+1]),`${l.paths[i].id} crosses ${l.paths[j].id}`);
 }
});
test('connectors join the server edge to the card edge',()=>{
 const {servers,sites}=make(3,3),l=layoutMap(servers,sites);
 for(const p of l.paths){
  const n=l.servers.find(s=>s.id===p.serverId),c=l.sites.find(s=>s.id===p.id);
  assert.equal(p.x1,n.x+n.w);assert.equal(p.x2,c.x);assert.equal(p.y2,c.y+c.h/2);assert.ok(p.y1>=n.y&&p.y1<=n.y+n.h);
 }
});
test('unassigned sites go last without a connector; long names keep geometry',()=>{
 const l=layoutMap([{id:'a',name:'x'.repeat(300)}],[{id:'1',serverId:'a',name:'y'.repeat(500)},{id:'2',serverId:'gone',name:'o'}]);
 assert.equal(l.unassigned.length,1);assert.equal(l.paths.length,1);
 assert.equal(l.sites[0].w,METRICS.cardW);assert.ok(l.unassigned[0].y>l.sites[0].y);
});
test('scales to 20 servers x 15 sites with a bounded canvas',()=>{
 const servers=[],sites=[];
 for(let i=0;i<20;i++){servers.push({id:'s'+i,name:'S'+i});for(let j=0;j<15;j++)sites.push({id:`s${i}-${j}`,serverId:'s'+i,name:'w'+j});}
 const t=Date.now(),l=layoutMap(servers,sites);
 assert.ok(Date.now()-t<200);assert.equal(l.sites.length,300);
 assert.equal(l.width,METRICS.pad*2+METRICS.serverW+METRICS.columnGap+METRICS.cardW);
});
