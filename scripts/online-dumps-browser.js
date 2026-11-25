import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {engineCapabilities} from '../shared/database-engines.js';

// Online database dumps switch (docs/online-dumps.md) in the app settings, against a mocked API with fake names only.
// The approved board states G1 to G8 at 1280 and 390, light and dark: switch off, on, PostgreSQL with Redis, only
// Redis and MongoDB (switch disabled), a database that stays stopped (readiness answer), incremental backups on, the
// review row and the saved notice. Every state: no sideways scroll; the switch works from the keyboard; the readiness
// action is a plain text link; row words follow the engine capability the API reports (a Redis capability flipped to
// true changes the row without any other change); an untouched app saves without an onlineDumps setting.
// Run against a server: TEST_BASE_URL=http://127.0.0.1:3000 (or a Vite dev server). SHOTS_DIR writes screenshots.
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5173',origin=new URL(base).origin,shots=process.env.SHOTS_DIR;
if(shots)await mkdir(shots,{recursive:true});
const iso=h=>new Date(Date.now()-h*3600e3).toISOString();
const ENGINES=engineCapabilities();
const PG=['shop-db','postgres','16.2','shop_db','postgres:16'];
const SCENARIOS={
 g1:{name:'G1-dumps-off',dbs:[PG]},
 g2:{name:'G2-dumps-on',on:true,dbs:[PG]},
 g3:{name:'G3-dumps-partial',on:true,dbs:[PG,['shop-cache','mongo','7.0.14','sessions','mongo:7']]},
 g4:{name:'G4-dumps-unavailable',dbs:[['shop-cache','mongo','6.0.16','queue','mongo:6'],['shop-mongo','mongo','7.0.14','notes','mongo:7']]},
 g5:{name:'G5-dumps-blocked',on:true,check:'blocked',dbs:[['shop-db','mariadb','11.4.2','blog_db','mariadb:11.4']]},
 g6:{name:'G6-dumps-incremental',on:true,incremental:true,dbs:[PG]},
 g7:{name:'G7-dumps-review',on:true,review:true,dbs:[PG]},
 g8:{name:'G8-dumps-saved',on:true,save:true,dbs:[PG]}
};
const fixture=(sc,engines)=>{
 const config={containers:['shop-web',...sc.dbs.map(d=>d[0])],domains:['shop.example.com'],healthUrl:'http://shop-web:8080/health',composeFiles:['/srv/shop/compose.yaml'],kind:'docker',stagingRoot:'/var/lib/docknest',deliveryMode:'staged',shutdownProfile:'generic',
  services:sc.dbs.map(([container,engine,version,database])=>({container,engine,version,database,sqliteFiles:[],checks:[]})),...(sc.on?{onlineDumps:true}:{})};
 const sites=[{id:'shop',name:'Shop',serverId:'a',config,incremental:{enabled:!!sc.incremental,interval:4}},{id:'wiki',name:'Wiki',serverId:'a',config:{kind:'docker',containers:['wiki-web'],domains:['wiki.example.com'],healthUrl:'http://wiki-web:8080/health',stagingRoot:'/var/lib/docknest',deliveryMode:'staged',shutdownProfile:'generic'}}];
 return {servers:[{id:'a',name:'Server 1',host:'192.0.2.10',port:22,username:'root',status:'connected',capabilities:{freeBytes:57*1024**3,dockerVersion:'27.3.1',composeVersion:'2.29.7'}}],sites,jobs:[],restores:[],audit:[],
  backups:sites.map(s=>({id:'bk-'+s.id,siteId:s.id,capturedAt:iso(5),size:240*1024**2,status:'verified',verified:true})),policies:sites.map(s=>({siteId:s.id,enabled:true,schedule:'0 2 * * *',timezone:'UTC',retention:7})),
  storage:{used:0,total:1e12},worker:{running:true,online:true,lastSeen:new Date().toISOString()},databaseEngines:engines};
};
const errors=[],saves=[];
let browser;
async function open({sc,width,scheme,engines=ENGINES,app='Shop'}){
 const context=await browser.newContext({viewport:{width,height:width<500?844:1100},reducedMotion:'reduce',colorScheme:scheme});
 await context.addInitScript(s=>{try{localStorage.setItem('docknest-theme',s)}catch{}},scheme);
 const page=await context.newPage(),offOrigin=[];
 page.on('pageerror',e=>errors.push(e.message));
 context.on('request',req=>{const u=new URL(req.url());if(!['data:','blob:'].includes(u.protocol)&&u.origin!==origin)offOrigin.push(u.href)});
 const fx=fixture(sc,engines);
 await page.route('**/api/**',route=>{
  const req=route.request(),ep=new URL(req.url()).pathname,method=req.method();
  const auth={authenticated:true,setupRequired:false,csrfToken:'fixture',user:{id:'u1',name:'Person 1',role:'admin'},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000};
  if(ep==='/api/auth/status')return route.fulfill({json:auth});
  if(ep==='/api/state')return route.fulfill({json:fx});
  if(ep==='/api/version')return route.fulfill({json:{version:'3.0.0'}});
  if(ep==='/api/storage-targets')return route.fulfill({json:{targets:[{id:'t1',name:'Main storage',kind:'sftp',status:'connected',capacity_bytes:2e12,trackedBytes:8e11}],activeTargetId:'t1'}});
  if(ep==='/api/updates/progress')return route.fulfill({json:{active:false,state:'idle'}});
  if(ep==='/api/moves')return route.fulfill({json:{moves:[]}});
  if(/\/restore-tests$/.test(ep))return route.fulfill({json:{settings:{enabled:false},last:null,active:false,items:[],next:null}});
  if(ep==='/api/sites/shop/readiness'&&method==='POST'){
   const checks=sc.check==='blocked'?[{name:'Online database dumps',ok:false,required:false,message:'x',dumped:[],fallbacks:[{container:'shop-db',reason:'tables that are not InnoDB (3) cannot be read in one transaction'}]}]:[{name:'Online database dumps',ok:true,required:false,message:'x',dumped:sc.dbs.filter(d=>ENGINES.find(e=>e.id===d[1])?.onlineCopy).map(d=>d[0]),fallbacks:[]}];
   return route.fulfill({json:{ready:true,checks,checkedAt:new Date().toISOString()}});
  }
  if(method!=='GET'&&/^\/api\/sites\/(shop|wiki)$/.test(ep)){const body=req.postDataJSON();saves.push(body);return route.fulfill({json:{id:ep.split('/').pop(),name:body.name,serverId:'a',config:body.config}});}
  if(/\/discover$/.test(ep))return route.fulfill({json:{containers:[{name:'shop-web',image:'shop/web:1.5',state:'running'},...sc.dbs.map(d=>({name:d[0],image:d[4],state:'running'})),{name:'wiki-web',image:'wiki/web:2',state:'running'}],staticSites:[]}});
  return route.fulfill({json:{}});
 });
 await page.goto(base+'/');
 await page.locator('.berry-sidebar').waitFor();
 if(width<900)await page.getByRole('button',{name:'Open navigation'}).click();
 await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Apps & Schedules',exact:true}).click();
 await page.locator('article.site-card',{hasText:app}).first().getByRole('button',{name:'Edit configuration'}).click();
 await page.getByRole('dialog').waitFor();
 await page.getByRole('heading',{name:/^Set up /}).waitFor();
 await page.locator('summary',{hasText:'Advanced backup settings'}).click();
 return {context,page,offOrigin};
}
const settle=page=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
async function noSideways(page,label){
 await settle(page);
 const over=await page.evaluate(()=>{const dialog=document.querySelector('dialog[open]');return {page:document.documentElement.scrollWidth-document.documentElement.clientWidth,dialog:dialog?dialog.scrollWidth-dialog.clientWidth:0}});
 assert.ok(over.page<=0&&over.dialog<=0,label+': no sideways scroll '+JSON.stringify(over));
}
const shot=async(page,sc,width,scheme)=>{if(shots){await page.mouse.move(2,2);await settle(page);await page.screenshot({path:path.join(shots,`${sc.name}-${width}-${scheme}.png`)});}};
const block=page=>page.locator('[aria-label="Databases"]');
const sw=page=>block(page).getByRole('switch');
async function reachDatabases(page){await block(page).scrollIntoViewIfNeeded();await settle(page);}
async function reachReview(page){
 for(const t of await page.getByRole('dialog').locator('textarea[required]').all())if(!await t.inputValue())await t.fill('/srv/shop/compose.yaml');
 await page.getByRole('dialog').getByRole('button',{name:'Continue'}).click();
 await page.getByRole('heading',{name:'Review your app'}).waitFor();
}
const confirmAll=async page=>{for(const c of await page.getByRole('dialog').locator('input[type=checkbox][required]').all())await c.check();};

browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
for(const [key,sc] of Object.entries(SCENARIOS))for(const width of [1280,390])for(const scheme of ['light','dark']){
 const label=`${key} ${width} ${scheme}`,{context,page,offOrigin}=await open({sc,width,scheme});
 const hasCapable=sc.dbs.some(d=>ENGINES.find(e=>e.id===d[1])?.onlineCopy);
 await reachDatabases(page);
 const caption=await block(page).innerText();
 assert.match(caption,/Applies to the whole app|Not available/,label);
 // The switch: state, disabled only when no detected database can take an online copy, keyboard operable.
 const s=sw(page);
 assert.equal(await s.isDisabled(),!hasCapable&&!sc.on,label+' switch disabled state');
 assert.equal(await s.getAttribute('aria-checked'),String(!!sc.on),label+' switch state');
 if(hasCapable){
  await s.focus();await page.keyboard.press('Space');
  assert.equal(await s.getAttribute('aria-checked'),String(!sc.on),label+' Space toggles');
  await page.keyboard.press('Space');
  assert.equal(await s.getAttribute('aria-checked'),String(!!sc.on),label+' Space toggles back');
 }
 // Row words are driven by the reported capability.
 for(const [container,engine] of sc.dbs.map(d=>[d[0],d[1]])){
  const row=block(page).locator('li',{hasText:'Container '+container}),capable=ENGINES.find(e=>e.id===engine).onlineCopy,text=await row.innerText();
  if(!capable)assert.match(text,/Always stopped for a file copy\. \w+ has no online copy yet\./,label+' '+container);
  else if(!sc.on)assert.match(text,/Stopped for a file copy/,label+' '+container);
  else if(sc.incremental)assert.match(text,/Stopped for a file copy \(see below\)/,label+' '+container);
  else if(sc.check!=='blocked')assert.match(text,/Online copy, stays running/,label+' '+container);
 }
 if(key==='g4')assert.match(caption,/This switch covers PostgreSQL, MySQL, MariaDB and Redis./,'G4 names what the switch covers');
 if(key==='g6')await block(page).getByText('Incremental backups are on for Shop').waitFor();
 // The readiness action: a text link, no border or background; it answers from the saved settings.
 const link=block(page).getByRole('button',{name:'Check readiness to see which databases will use it'});
 if(hasCapable){
  const look=await link.evaluate(el=>{const c=getComputedStyle(el);return {border:c.borderTopWidth,background:c.backgroundColor,shadow:c.boxShadow}});
  assert.equal(look.border,'0px',label+' link has no border');assert.equal(look.background,'rgba(0, 0, 0, 0)',label+' link has no background');assert.equal(look.shadow,'none');
  if(sc.check==='blocked'){
   await link.click();await block(page).getByText('Shop will still stop its database').waitFor();await block(page).getByText(/Tables that are not InnoDB/).waitFor();
   assert.match(await block(page).locator('li',{hasText:'Container shop-db'}).innerText(),/Stopped for a file copy \(see below\)/,label);
  }
 }else assert.equal(await link.count(),0,label+' no readiness link without a capable database');
 if(sc.review){await reachReview(page);await page.locator('dl.setup-review').getByText('Online copy: the database keeps running').waitFor();assert.equal(await page.locator('dl.setup-review dt',{hasText:'Database backup'}).count(),1);}
 else if(sc.save){
  await reachReview(page);await confirmAll(page);
  await page.getByRole('dialog').getByRole('button',{name:'Save configuration'}).click();
  await page.getByText('App configuration saved.').waitFor();
  assert.equal(saves.at(-1).config.onlineDumps,true,'the saved app carries onlineDumps');
 }else await reachDatabases(page);
 await noSideways(page,label);
 assert.deepEqual(offOrigin,[],label+' no off-origin requests');
 await shot(page,sc,width,scheme);
 await context.close();
}

// A capability the backend flips to true (MongoDB online copy later) changes the MongoDB row with no other change.
const flipped=ENGINES.map(e=>e.id==='mongo'?{id:e.id,label:e.label,onlineCopy:true}:e);
{
 const {context,page}=await open({sc:SCENARIOS.g3,width:1280,scheme:'light',engines:flipped});
 await reachDatabases(page);
 assert.match(await block(page).locator('li',{hasText:'Container shop-cache'}).innerText(),/Online copy, stays running/);
 assert.doesNotMatch(await block(page).innerText(),/Always stopped/);
 await context.close();
}
// Only Redis, which now takes an online copy: the switch is available.
{
 const {context,page}=await open({sc:{name:'x',dbs:[['shop-cache','redis','7.2.0','q','redis:7.2']]},width:1280,scheme:'light',engines:flipped});
 await reachDatabases(page);
 assert.equal(await sw(page).isDisabled(),false);
 await context.close();
}
// An app without a database, never touched: no Databases block, and it saves without an onlineDumps setting.
{
 saves.length=0;
 const {context,page}=await open({sc:{name:'x',dbs:[]},width:1280,scheme:'light',app:'Wiki'});
 assert.equal(await page.locator('[aria-label="Databases"]').count(),0);
 await reachReview(page);await confirmAll(page);
 await page.getByRole('dialog').getByRole('button',{name:'Save configuration'}).click();
 await page.getByText('App configuration saved.').waitFor();
 assert.equal('onlineDumps' in saves.at(-1).config,false,'an untouched app keeps its settings as they were');
 await context.close();
}
await browser.close();
assert.deepEqual(errors,[],'no page errors');
console.log('Online dumps UI checks passed');
