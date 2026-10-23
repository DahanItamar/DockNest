import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

// Read-only Map page against a mocked API: servers, sites and connectors, stable automatic layout on reload, no overlaps,
// zoom and fit, the phone list at 402 px, light and dark, names and roles. Run against a dev server:
// TEST_BASE_URL=http://127.0.0.1:5205. Set SHOTS_DIR to also write screenshots (1440x900 and 402x874, both themes).
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5173',origin=new URL(base).origin,shots=process.env.SHOTS_DIR;
if(shots)await mkdir(shots,{recursive:true});
const long='very-long-site-name-'.repeat(8)+'.example.com';
const state={
 servers:[
  {id:'b',name:'mobiX-Srv',host:'b.example.invalid',port:22,username:'root',status:'connected',capabilities:{freeBytes:13*1024**3}},
  {id:'a',name:'itamar-Srv',host:'a.example.invalid',port:22,username:'root',status:'connected',capabilities:{freeBytes:57*1024**3}},
  {id:'c',name:'Quiet server with a rather long name that must not break',host:'c.example.invalid',port:22,username:'root',status:'failed'},
  {id:'d',name:'zeta-Srv',host:'d.example.invalid',port:22,username:'root',status:'connected'}
 ],
 sites:[
  {id:'1',name:'shop.example.com',serverId:'b',config:{containers:[1,2,3]}},
  {id:'2',name:'blog.example.com',serverId:'a',config:{containers:[1]}},
  {id:'3',name:long,serverId:'b',config:{containers:[1,2]}},
  {id:'4',name:'api.example.com',serverId:'a'},
  {id:'5',name:'wiki.example.com',serverId:'b'}
 ],
 jobs:[],backups:[],policies:[],audit:[],storage:{used:0,total:1e12},worker:{online:true}
};
let browser;const errors=[];

async function open({role='admin',width=1440,height=900,scheme='light',appState=state}={}){
 const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',colorScheme:scheme});
 await context.addInitScript(s=>{try{localStorage.setItem('docknest-theme',s)}catch{}},scheme);
 const page=await context.newPage(),offOrigin=[];
 page.on('pageerror',e=>errors.push(e.message));
 context.on('request',req=>{const u=new URL(req.url());if(!['data:','blob:'].includes(u.protocol)&&u.origin!==origin)offOrigin.push(u.href)});
 await page.route('**/api/**',route=>{
  const endpoint=new URL(route.request().url()).pathname;
  const auth={authenticated:true,setupRequired:false,csrfToken:'fixture',user:{id:'u1',name:'Fixture user',role},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000};
  if(endpoint==='/api/updates/progress')return route.fulfill({json:{active:false,state:'idle'}});
  return route.fulfill({json:endpoint==='/api/auth/status'?auth:endpoint==='/api/state'?appState:endpoint==='/api/version'?{version:'0.0.0'}:{}});
 });
 await page.goto(base+'/');
 await page.locator('.berry-sidebar').waitFor();
 if(width<900)await page.getByRole('button',{name:'Open navigation'}).click();
 await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Map',exact:true}).click();
 return {context,page,offOrigin};
}
const boxes=(page,sel)=>page.locator(sel).evaluateAll(els=>els.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,id:e.dataset.site||e.id}}));
const overlap=(a,b)=>a.x<b.x+b.w-0.5&&b.x<a.x+a.w-0.5&&a.y<b.y+b.h-0.5&&b.y<a.y+a.h-0.5;
async function fits(page,label){const o=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}));assert.ok(o.sw<=o.cw,label+': horizontal overflow');}
async function shot(page,scheme,size){if(shots)await page.screenshot({path:path.join(shots,`map-${size}-${scheme}.png`)});}
const scaleOf=page=>page.locator('.map-canvas').evaluate(el=>new DOMMatrix(getComputedStyle(el).transform).a);

browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
try{
 for(const scheme of ['light','dark']){
  // Desktop canvas
  {
   const {context,page,offOrigin}=await open({scheme});
   await page.getByRole('heading',{level:1,name:'Map'}).waitFor();
   assert.equal(await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Map',exact:true}).getAttribute('aria-current'),'page');
   assert.equal(await page.locator('.map-server').count(),4,'servers');
   assert.equal(await page.locator('.map-site').count(),5,'sites');
   assert.equal(await page.locator('.map-lines path:not(.drag)').count(),5,'connectors');
   // Order: servers by name
   const names=await page.locator('.map-server .map-name').allTextContents();
   assert.deepEqual(names,[...names].sort((x,y)=>x.toLowerCase()<y.toLowerCase()?-1:1),'server order');
   // Groups and status labels
   const g=page.getByRole('group',{name:'itamar-Srv'});
   assert.equal(await g.locator('.map-site').count(),2);
   await g.getByText('Connected').waitFor();await g.getByText('2 sites · 57.0 GB free').waitFor();
   await page.getByText('Needs attention').waitFor();
   assert.ok(await page.locator('.map-lines').getAttribute('aria-hidden')==='true');
   // No overlaps (screen space)
   const all=[...await boxes(page,'.map-server'),...await boxes(page,'.map-site')];
   for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++)assert.ok(!overlap(all[i],all[j]),'overlap '+i+' '+j);
   // Long names truncate inside the card
   const card=page.locator('.map-site',{hasText:'very-long-site-name'});
   assert.ok(await card.locator('.map-name').evaluate(e=>e.scrollWidth>e.clientWidth),'truncated');
   assert.equal(await card.getAttribute('title'),long);
   // Fit shows everything inside the viewport
   const vp=await page.locator('.map-viewport').boundingBox();
   for(const b of all)assert.ok(b.x>=vp.x-1&&b.y>=vp.y-1&&b.x+b.w<=vp.x+vp.width+1&&b.y+b.h<=vp.y+vp.height+1,'inside after fit');
   // Auto layout is stable across a reload
   const before=JSON.stringify(await boxes(page,'.map-site'));
   await page.reload();
   await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Map',exact:true}).click();
   await page.locator('.map-site').first().waitFor();
   assert.equal(JSON.stringify(await boxes(page,'.map-site')),before,'stable layout');
   assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>/map|layout|position/i.test(k)).length),0,'nothing persisted');
   // Zoom buttons, keyboard, fit
   const k0=await scaleOf(page);
   await page.getByRole('button',{name:'Zoom in'}).click();assert.ok(await scaleOf(page)>k0,'zoom in');
   await page.getByRole('button',{name:'Zoom out'}).click();await page.getByRole('button',{name:'Zoom out'}).click();assert.ok(await scaleOf(page)<k0,'zoom out');
   await page.getByRole('button',{name:'Fit to screen'}).click();assert.ok(Math.abs(await scaleOf(page)-k0)<0.001,'fit restores');
   const viewport=page.locator('.map-viewport');await viewport.focus();
   const x0=(await boxes(page,'.map-server'))[0].x;await page.keyboard.press('ArrowRight');
   assert.ok((await boxes(page,'.map-server'))[0].x<x0,'keyboard pan');
   await page.keyboard.press('+');assert.ok(await scaleOf(page)>k0,'keyboard zoom');
   await page.keyboard.press('0');assert.ok(Math.abs(await scaleOf(page)-k0)<0.001,'keyboard fit');
   const m=await viewport.boundingBox();
   await page.mouse.move(m.x+m.width/2,m.y+m.height/2);await page.mouse.wheel(0,-300);
   await page.waitForFunction(k=>new DOMMatrix(getComputedStyle(document.querySelector('.map-canvas')).transform).a>k,k0);
   await page.getByRole('button',{name:'Fit to screen'}).click();
   // Moving is scaffolded only
   const save=page.getByRole('button',{name:/Save changes/});
   assert.equal(await save.isDisabled(),true);assert.equal(await save.getAttribute('title'),'Moving sites is coming soon');
   const src=(await boxes(page,'.map-site'))[0];
     await page.mouse.move(src.x+src.w/2,src.y+src.h/2);await page.mouse.down();
   const target=await page.locator('.map-server').evaluateAll(els=>els.map(e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}));
   await page.mouse.move(target[3].x,target[3].y,{steps:4});
   await page.locator('.map-lines path.drag').waitFor();await page.locator('.map-server.target').waitFor();
   await shot(page,scheme,'1440-drag');
   await page.mouse.up();
   assert.equal(await page.locator('.map-lines path.drag').count(),0);
   await page.getByText(/was not moved\. Moving sites is coming soon/).waitFor();
   await page.getByRole('button',{name:'Fit to screen'}).click();
   await fits(page,'desktop '+scheme);
   await shot(page,scheme,'1440');
   assert.deepEqual(offOrigin,[],'off-origin requests');
   await context.close();
  }
  // Operator: read only, no save button
  {
   const {context,page}=await open({role:'operator',scheme});
   await page.locator('.map-site').first().waitFor();
   assert.equal(await page.getByRole('button',{name:/Save changes/}).count(),0);
   assert.equal(await page.locator('.map-site.movable').count(),0);
   await context.close();
  }
  // Phone list
  {
   const {context,page}=await open({width:402,height:874,scheme});
   await page.locator('.map-list').waitFor();
   assert.equal(await page.locator('.map-canvas').count(),0,'no canvas on phone');
     const heads=await page.locator('.map-list h2').allTextContents();
   assert.deepEqual(heads,['itamar-Srv','mobiX-Srv','Quiet server with a rather long name that must not break','zeta-Srv']);
   assert.equal(await page.locator('.map-list li').count(),5);
   await page.getByText('No sites on this server yet.').first().waitFor();
   assert.equal(await page.getByRole('list').filter({hasText:'blog.example.com'}).count()>=1,true);
   await fits(page,'phone '+scheme);
   await page.evaluate(()=>window.scrollTo(0,0));
   await shot(page,scheme,'402');
   await context.close();
  }
 }
 // Empty state and tablet width list
 {
  const {context,page}=await open({appState:{...state,servers:[],sites:[]}});
  await page.getByText('Nothing to show yet').waitFor();await context.close();
 }
 {
  const {context,page}=await open({width:760,height:900});
  await page.locator('.map-list').waitFor();await fits(page,'tablet');await context.close();
 }
 assert.deepEqual(errors,[],'page errors');
 console.log('Map browser checks passed.');
}finally{await browser.close();}
