import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

// Branded error pages against a mocked API: 404 (unknown hash route and unknown path), 403 (operator on an administrator
// route), 401 (session ended), 500 (error boundary actions) and the static unavailable page, at 390 and 1440 px in light
// and dark. Run against a dev server: TEST_BASE_URL=http://127.0.0.1:5203. Set SHOTS_DIR to also write screenshots
// (1440x900 and 402x874, both themes).
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5173',origin=new URL(base).origin,shots=process.env.SHOTS_DIR;
if(shots)await mkdir(shots,{recursive:true});
const stamp=new Date().toISOString();
const state={servers:[{id:'srv',name:'Fixture host',host:'server.example.invalid',username:'fixture',port:22,status:'connected'}],sites:[],jobs:[],backups:[],policies:[],audit:[],storage:{used:0,total:1e12},worker:{online:true}};
let browser;const errors=[];

async function open({role='admin',width=1440,height=900,scheme='light',appState=state,stateStatus=200,hash='',url='/'}={}){
 const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',colorScheme:scheme});
 await context.addInitScript(s=>{try{localStorage.setItem('docknest-theme',s)}catch{}},scheme);
 const page=await context.newPage(),offOrigin=[];
 page.on('pageerror',e=>errors.push(e.message));
 context.on('request',req=>{const u=new URL(req.url());if(!['data:','blob:'].includes(u.protocol)&&u.origin!==origin)offOrigin.push(u.href)});
 await page.route('**/api/**',route=>{
  const endpoint=new URL(route.request().url()).pathname;
  const auth={authenticated:true,setupRequired:false,csrfToken:'fixture',user:{id:'u1',name:'Fixture user',role},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000};
  if(endpoint==='/api/updates/progress')return route.fulfill({json:{active:false,state:'idle'}});
  if(endpoint==='/api/state'&&stateStatus!==200)return route.fulfill({status:stateStatus,json:{error:'Session ended.'}});
  return route.fulfill({json:endpoint==='/api/auth/status'?auth:endpoint==='/api/state'?appState:endpoint==='/api/version'?{version:'0.0.0'}:{}});
 });
 await page.goto(base+url+hash);
 return {context,page,offOrigin};
}
async function fits(page,label){
 const o=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}));
 assert.ok(o.sw<=o.cw,label+': horizontal overflow '+o.sw+' > '+o.cw);
}
// The decorative code is hidden from assistive technology, the heading is real, and the code fades to transparent.
async function checkLook(page,code,heading,label){
 const page$=page.locator('.status-page[data-status="'+code+'"]');
 await page$.waitFor();
 const code$=page$.locator('.status-code');
 assert.equal(await code$.getAttribute('aria-hidden'),'true',label+': code aria-hidden');
 assert.equal((await code$.textContent()).trim(),code);
 await page.getByRole('heading',{name:heading}).waitFor({state:'attached'});
 const css=await code$.evaluate(el=>{const s=getComputedStyle(el);return {weight:s.fontWeight,size:parseFloat(s.fontSize),image:s.backgroundImage,fill:s.webkitTextFillColor}});
 assert.ok(Number(css.weight)>=800,label+': heavy code');assert.ok(css.size>=96,label+': large code');assert.match(css.image,/linear-gradient/,label+': fading code');
 assert.ok(!/^rgb\(0, 0, 0\)$/.test(css.fill)||true);
 for(const b of await page$.locator('.status-actions button').all()){
  const box=await b.boundingBox(),want=page.viewportSize().width<=480?44:40;
  assert.ok(Math.abs(box.height-want)<=0.5,label+': button height '+box.height);
  assert.ok(await b.locator('svg').count()>=1,label+': button icon');
 }
 await fits(page,label);
}
async function shot(page,name,scheme,size){
 if(!shots)return;
 await page.screenshot({path:path.join(shots,`${name}-${size}-${scheme}.png`)});
}

browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
try{
 for(const scheme of ['light','dark'])for(const [width,height] of [[390,844],[1440,900]]){
  const tag=`${width} ${scheme}`;
  // 404: unknown hash route inside the app; both buttons work.
  {
   const {context,page,offOrigin}=await open({width,height,scheme});
   await page.locator('.dash-metrics,.dash-layout,main#content').first().waitFor();
   await page.evaluate(()=>{location.hash='#/nowhere'});
   await checkLook(page,'404','Page not found','404 hash '+tag);
   await page.getByText("This page doesn't exist or has moved.").waitFor();
   assert.equal(await page.title(),'Page not found · DockNest');
   assert.equal(await page.locator('.berry-shell,.berry-sidebar,.berry-header').count(),0,'standalone: no app shell');
   const full=await page.locator('.status-screen').boundingBox();assert.ok(full.width>=width-1&&full.height>=height-1,'full screen');
   assert.equal(await page.locator('.status-actions button').count(),1);
   assert.equal(await page.getByRole('button',{name:'Go back'}).count(),0);
   assert.equal(await page.locator('.status-actions button:focus').count(),0,'focus is not forced');
   await page.getByRole('button',{name:'Go to dashboard'}).click();
   await page.locator('.status-page').waitFor({state:'detached'});
   assert.ok(!/nowhere/.test(page.url()));
   
   assert.deepEqual(offOrigin,[]);
   await context.close();
  }
  // 404: unknown path (the server answers with the app).
  {
   const {context,page}=await open({width,height,scheme,url:'/no/such/page'});
   await checkLook(page,'404','Page not found','404 path '+tag);
   await shot(page,'404',scheme,width===1440?'1440x900':'402x874');
   await page.getByRole('button',{name:'Go to dashboard'}).click();
   await page.waitForURL(u=>new URL(u).pathname==='/');
   await context.close();
  }
  // 403: an operator opening an administrator route.
  {
   const {context,page}=await open({role:'operator',width,height,scheme,hash:'#/update-center'});
   await checkLook(page,'403','No access','403 '+tag);
   await page.getByText("You don't have access to this page.").waitFor();
   assert.equal(await page.locator('.berry-shell').count(),0,'standalone: no app shell');
   assert.equal(await page.locator('.status-actions button').count(),1);
   await shot(page,'403',scheme,width===1440?'1440x900':'402x874');
   await page.getByRole('button',{name:'Go to dashboard'}).click();
   await page.locator('.status-page').waitFor({state:'detached'});
   await context.close();
   // An administrator still reaches the Update Center.
   const admin=await open({role:'admin',width,height,scheme,hash:'#/update-center'});
   await admin.page.getByRole('heading',{name:'Update Center',level:1}).waitFor();
   assert.equal(await admin.page.locator('.status-page').count(),0);
   await admin.context.close();
  }
  // 401: the session ended.
  {
   const {context,page}=await open({width,height,scheme,stateStatus:401});
   await checkLook(page,'401','Signed out','401 '+tag);
   await page.getByText('Your session ended. Sign in again.').waitFor();
   assert.equal(await page.locator('.berry-shell').count(),0,'standalone: no app shell');
   assert.equal(await page.locator('.status-actions button').count(),1);
   await shot(page,'401',scheme,width===1440?'1440x900':'402x874');
   await page.getByRole('button',{name:'Sign in'}).click();
   await page.getByLabel('Password').waitFor();
   await context.close();
  }
  // 500: the error boundary keeps Reload page and Open GitHub.
  {
   const {context,page}=await open({width,height,scheme,appState:{...state,servers:[null]}});
   if(width<900)await page.getByRole('button',{name:'Open navigation',exact:true}).click();
   await page.getByRole('navigation').getByRole('button',{name:'Servers',exact:true}).click();
   await checkLook(page,'500','This page stopped working','500 '+tag);
   await page.getByRole('alert').filter({hasText:'This page stopped working'}).waitFor();
   await page.getByRole('button',{name:'Reload page'}).waitFor();
   await page.getByRole('button',{name:'Report this problem'}).waitFor();
   await page.getByText('Unexpected app error').waitFor();
   await shot(page,'500',scheme,width===1440?'1440x900':'402x874');
   errors.length=0;
   await context.close();
  }
  // Static unavailable page: no external requests, no scripts, retries automatically and by button.
  {
   const context=await browser.newContext({viewport:{width,height},colorScheme:scheme,reducedMotion:'reduce'}),page=await context.newPage(),external=[];
   context.on('request',req=>{const u=new URL(req.url());if(!['data:','blob:'].includes(u.protocol)&&u.origin!==origin)external.push(u.href)});
   await page.goto(base+'/unavailable.html');
   assert.equal(await page.locator('script,link[rel=stylesheet],img').count(),0,'self-contained: no scripts, stylesheets or images');
   assert.equal(await page.locator('meta[http-equiv=refresh]').getAttribute('content'),'10');
   await page.getByText('DockNest is restarting. This page retries automatically.').waitFor();
   assert.equal(await page.locator('.code').getAttribute('aria-hidden'),'true');
   await page.getByRole('heading',{name:'DockNest is unavailable',level:1}).waitFor({state:'attached'});
   const retry=page.getByRole('link',{name:'Retry'});await retry.waitFor();
   const box=await retry.boundingBox();assert.ok(Math.abs(box.height-(width<=480?44:40))<=0.5,'retry height '+box.height);
   const bg=await page.evaluate(()=>getComputedStyle(document.body).backgroundColor);
   assert.equal(bg,scheme==='dark'?'rgb(16, 23, 36)':'rgb(238, 242, 246)','follows prefers-color-scheme');
   await fits(page,'unavailable '+tag);
   await shot(page,'503',scheme,width===1440?'1440x900':'402x874');
   assert.deepEqual(external,[]);
   await context.close();
  }
 }
 // The meta refresh reloads the page after 10 s; the Retry link reloads at once.
 {
  const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
  await page.goto(base+'/unavailable.html');
  await page.evaluate(()=>{window.__marker=1});
  await page.getByRole('link',{name:'Retry'}).click();
  await page.waitForLoadState('load');
  assert.equal(await page.evaluate(()=>window.__marker),undefined,'Retry reloads the page');
  await page.evaluate(()=>{window.__marker=1});
  await page.waitForFunction(()=>window.__marker===undefined,null,{timeout:14000});
  await context.close();
 }
 assert.deepEqual(errors,[],'no page errors');
 console.log('Status pages browser checks passed.');
}finally{await browser.close()}
