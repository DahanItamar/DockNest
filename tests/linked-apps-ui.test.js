import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutMap,METRICS} from '../web/map/layout.js';
import {linkPairs,linksOf,scanState,reasonOf,hubLine,unownedLine,linkSummary,warningsFor} from '../web/linked/linked.js';

const sites=['a','b','c','d'].map(id=>({id,serverId:'s1',name:'App '+id.toUpperCase()}));
const nameOf=id=>sites.find(site=>site.id===id)?.name||'';
const appLinks={checkedAt:'2026-11-19T08:00:00.000Z',partial:false,
 links:[{appIds:['a','b'],kind:'database',via:'db-1',warns:true,details:[]},{appIds:['a','c'],kind:'network',via:'web',warns:false,details:[]},{appIds:['b','d'],kind:'volume',via:'/srv/data',warns:true,details:[]}],
 unowned:[{container:'cache-1',appIds:['a'],kind:'link',via:'cache-1',details:[]}],hubs:[{network:'proxy',appIds:['a','b','c','d']}]};
const servers=[{id:'s1',name:'Server',appLinks}];

test('link pairs come from every server and skip hubs',()=>{
 assert.deepEqual(linkPairs(servers).map(p=>p.id),['a~b','a~c','b~d']);
 assert.deepEqual(linkPairs([{id:'x'}]),[]);
});

test('layout draws link lines in a gutter right of the app column, none without links',()=>{
 const servers0=[{id:'s1',name:'Server'}],plain=layoutMap(servers0,sites);
 const linked=layoutMap(servers0,sites,{links:linkPairs(servers)});
 assert.equal(plain.linkPaths.length,0);
 assert.equal(linked.linkPaths.length,3);
 const right=Math.max(...linked.sites.map(site=>site.x+site.w));
 for(const path of linked.linkPaths){
  assert.ok(path.points.every(([x])=>x>=right&&x<=right+METRICS.linkBase+6*METRICS.linkLane));
  assert.equal(path.points[0][0],right);
 }
 assert.ok(new Set(linked.linkPaths.map(path=>path.points[1][0])).size>1,'overlapping lines take different lanes');
 assert.deepEqual(layoutMap(servers0,sites,{links:linkPairs(servers)}).linkPaths,linked.linkPaths);
});

test('links to apps that are not on the map are not drawn',()=>{
 const layout=layoutMap([{id:'s1',name:'Server'}],sites,{links:[{id:'a~zz',a:'a',b:'zz',kind:'volume'}]});
 assert.equal(layout.linkPaths.length,0);
});

test('scan states',()=>{
 assert.equal(scanState(null),'never');
 assert.equal(scanState({checkedAt:null,partial:false}),'never');
 assert.equal(scanState({checkedAt:null,partial:true}),'damaged');
 assert.equal(scanState({checkedAt:'t',partial:true}),'partial');
 assert.equal(scanState({checkedAt:'t',partial:false}),'ok');
});

test('plain reasons, hub and unbacked lines',()=>{
 assert.equal(reasonOf({kind:'volume',via:'/srv/data'},'App D'),'Shares the folder /srv/data with App D');
 assert.equal(reasonOf({kind:'volume',via:'media'},'App D'),'Shares the volume media with App D');
 assert.equal(reasonOf({kind:'database',via:'db-1'},'App B'),'Shares the database db-1 with App B');
 assert.equal(reasonOf({kind:'network',via:'web'},'App C'),'On the network web with App C');
 assert.equal(hubLine(appLinks.hubs[0]),'On the shared network proxy with 3 other apps');
 assert.equal(hubLine({network:'p',appIds:['a','b']}),'On the shared network p with 1 other app');
 assert.equal(unownedLine(appLinks.unowned[0]),'Uses cache-1, which no app backs up');
});

test('phone caption lists the linked apps',()=>{
 const names=id=>nameOf(id);
 assert.equal(linkSummary(linksOf(servers,sites[0]).links,names),'Linked to App B and App C');
 assert.equal(linkSummary(linksOf(servers,sites[3]).links,names),'Linked to App B');
 assert.equal(linkSummary(linksOf([{id:'s1'}],sites[0]).links,names),'');
 assert.equal(linkSummary([{otherAppId:'a'},{otherAppId:'b'},{otherAppId:'c'}],names),'Linked to App A, App B and App C');
});

test('warnings: only warning links and unbacked containers, one sentence each',()=>{
 const items=warningsFor(appLinks,sites[0],nameOf,'backup');
 assert.deepEqual(items.map(item=>item.id),['a~b','unowned:cache-1']);
 assert.equal(items[0].before+items[0].app.name+items[0].after,'App A shares the database db-1 with App B, so back up both to keep the copies matching.');
 assert.deepEqual(items[0].app,{id:'b',name:'App B'});
 assert.equal(items[1].app,null);
 assert.equal(items[1].before+items[1].after,'App A uses cache-1, which no app backs up, so its data is not in this copy.');
 assert.match(warningsFor(appLinks,sites[0],nameOf,'move')[0].after,/moving only one/);
 assert.match(warningsFor(appLinks,sites[0],nameOf,'restore')[0].after,/test copy/);
});

test('no warning for network-only links, hubs or apps without links',()=>{
 const only={...appLinks,unowned:[],hubs:[]};
 assert.deepEqual(warningsFor(only,sites[2],nameOf,'backup'),[]);
 assert.deepEqual(warningsFor(null,sites[0],nameOf,'backup'),[]);
 assert.deepEqual(warningsFor(appLinks,sites[1],nameOf,'backup').map(item=>item.app.name),['App D','App A']);
});
