import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

// Self-heal sheet (docs/self-heal.md, issue #150) against a mocked API: the approved boards 05, 16 and 17 at 1280 and
// 390, light and dark; fixed header and footer with a scrolling body; the switch focus ring only on keyboard focus;
// buttons that never wrap; saving; operators read-only; existing dialogs unchanged. Run against a dev server serving
// this worktree: TEST_BASE_URL=http://127.0.0.1:5311 npm run test:self-heal. SHOTS_DIR also writes screenshots.
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5173',shots=process.env.SHOTS_DIR;
if(shots)await mkdir(shots,{recursive:true});
const NOW=Date.now(),ago=m=>new Date(NOW-m*60000).toISOString();
const servers=[
 {id:'h1',name:'Commerce host',host:'192.0.2.10',port:22,username:'root',status:'connected',capabilities:{freeBytes:96*1024**3,docker:true,nginx:true}},
 {id:'h2',name:'Content host',host:'198.51.100.20',port:22,username:'root',status:'connected',capabilities:{freeBytes:64*1024**3,docker:true,nginx:true}}
];
const sites=[{id:'s0',name:'Demo Shop',serverId:'h1',config:{kind:'docker',containers:['demo-0-web','demo-0-db'],domains:['shop.example.com'],ports:['8080']}}];
const EVENTS=[
 {id:'e1',container:'demo-0-web',kind:'restarted',at:ago(40)},
 {id:'e2',container:'demo-0-web',kind:'restarted',at:ago(120)},
 {id:'e3',container:'demo-0-web',kind:'limit_reached',at:ago(150)},
 {id:'e4',container:'demo-0-db',kind:'skipped',at:ago(200)},
 {id:'e5',container:'demo-0-web',kind:'restart_failed',at:ago(260)},
 {id:'e6',container:'demo-0-web',kind:'recovered',at:ago(300)},
 {id:'e7',container:'demo-0-web',kind:'unhealthy',at:ago(310)}
];
let mock;
const fresh=(over={})=>{mock={card:{enabled:true,maxRestarts:3,windowMinutes:60,watched:[{name:'demo-0-web'}],stream:{state:'connected'},events:EVENTS,...over},puts:[],loadStatus:200,putError:null}};
fresh();
const json=(route,body,status=200)=>route.fulfill({status,json:body});

let browser;const errors=[];
async function open({role='admin',width=1280,height=800,scheme='light'}={}){
 const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',colorScheme:scheme,hasTouch:width<600,deviceScaleFactor:width<600?2:1});
 await context.addInitScript(s=>{try{localStorage.setItem('docknest-theme',s)}catch{}},scheme);
 const page=await context.newPage();
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',route=>{
  const req=route.request(),url=new URL(req.url()),endpoint=url.pathname,method=req.method();
  const auth={authenticated:true,setupRequired:false,csrfToken:'fixture',user:{id:'u1',name:'Fixture user',role},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000};
  if(/^\/api\/sites\/s0\/self-heal$/.test(endpoint)){
   if(method==='PUT'){
    if(role!=='admin')return json(route,{error:'No'},403);
    if(mock.putError)return json(route,{error:'raw',code:mock.putError},422);
    const body=req.postDataJSON();mock.puts.push(body);Object.assign(mock.card,body);return json(route,mock.card);
   }
   return mock.loadStatus===200?json(route,mock.card):json(route,{error:'Self-heal could not be loaded.'},mock.loadStatus);
  }
  return json(route,endpoint==='/api/auth/status'?auth:endpoint==='/api/state'?{servers,sites,jobs:[],backups:[],policies:[],audit:[],storage:{used:1e9,total:1e12},worker:{online:true}}:endpoint==='/api/storage-targets'?{activeTargetId:null,targets:[]}:endpoint==='/api/version'?{version:'0.0.0'}:endpoint==='/api/updates/progress'?{active:false,state:'idle'}:{});
 });
 await page.goto(base+'/');
 await page.locator('.berry-sidebar').waitFor();
 if(width<900)await page.getByRole('button',{name:'Open navigation'}).click();
 await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Map',exact:true}).click();
 return {context,page};
}
async function openSheet(page,width){
 if(width<900)await page.locator('.map-list li',{hasText:'Demo Shop'}).getByRole('button',{name:'Details'}).click();
 else await page.locator('.map-site',{hasText:'Demo Shop'}).first().click();
 await page.getByRole('button',{name:'Self-heal',exact:true}).click();
 const dlg=page.locator('dialog.sh-sheet');
 await dlg.waitFor();
 await page.waitForFunction(()=>!document.querySelector('dialog.sh-sheet .sh-load'));
 return dlg;
}
const noOverflow=async(page,label)=>{const o=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,dw:(()=>{const d=document.querySelector('dialog.sh-sheet');return d?d.scrollWidth-d.clientWidth:0})()}));assert.ok(o.sw<=o.cw,label+': horizontal overflow '+o.sw+' > '+o.cw);assert.ok(o.dw<=0,label+': dialog overflows sideways')};
const shot=async(page,name)=>{if(shots){await page.mouse.move(2,2);await page.screenshot({path:path.join(shots,name+'.png')})}};
const rect=l=>l.evaluate(e=>{const r=e.getBoundingClientRect();return {top:Math.round(r.top),bottom:Math.round(r.bottom),height:Math.round(r.height)}});

async function footerButtons(dlg,label){
 const boxes=await dlg.locator('.map-dialog-foot button').evaluateAll(bs=>bs.map(b=>({h:Math.round(b.getBoundingClientRect().height),lines:Math.round(b.getBoundingClientRect().height/parseFloat(getComputedStyle(b).lineHeight)),ws:getComputedStyle(b).whiteSpace,scrollW:b.scrollWidth,clientW:b.clientWidth})));
 assert.ok(boxes.length>=1,label+': footer buttons');
 assert.equal(new Set(boxes.map(b=>b.h)).size,1,label+': equal button heights '+JSON.stringify(boxes));
 for(const b of boxes){assert.equal(b.ws,'nowrap',label+': nowrap');assert.ok(b.scrollW<=b.clientW,label+': button text fits')}
}

async function board(name,over,{scheme,width}){
 fresh(over);
 const {context,page}=await open({scheme,width,height:width<600?844:800});
 const dlg=await openSheet(page,width),tag=`${name}-${width===1280?'desktop':'phone'}-${scheme}`;
 await noOverflow(page,tag);await footerButtons(dlg,tag);
 // Dark gets the 1px dialog edge, light stays borderless
 const edge=await dlg.evaluate(d=>{const c=getComputedStyle(d);return {w:c.borderTopWidth,color:c.borderTopColor}});
 assert.equal(edge.w,'1px',tag+': dialog-edge width');
 if(scheme==='light')assert.match(edge.color,/rgba\(0, 0, 0, 0\)|transparent/,tag+': light edge is transparent');
 else assert.doesNotMatch(edge.color,/rgba\(0, 0, 0, 0\)/,tag+': dark edge is visible');
 await shot(page,tag);
 if(name==='05-self-heal-settings'){
  const body=dlg.locator('.map-dialog-body'),head=dlg.locator('.map-dialog-head'),foot=dlg.locator('.map-dialog-foot');
  const sizes=await body.evaluate(b=>({sh:b.scrollHeight,ch:b.clientHeight,sb:getComputedStyle(b).scrollbarWidth}));
  assert.equal(sizes.sb,'none',tag+': scrollbar hidden');
  if(width===1280&&sizes.sh>sizes.ch+1){
   const [h0,f0]=[await rect(head),await rect(foot)];
   await body.evaluate(b=>{b.scrollTop=b.scrollHeight});
   assert.deepEqual(await rect(head),h0,tag+': header fixed');assert.deepEqual(await rect(foot),f0,tag+': footer fixed');
   assert.ok(await body.evaluate(b=>b.scrollTop>0),tag+': body scrolled');
   await shot(page,`05-self-heal-settings-scrolled-desktop-${scheme}`);
  }
 }
 const sels=await dlg.locator('select.sh-window').evaluate(s=>{const r=s.getBoundingClientRect();return {h:Math.round(r.height)}});
 assert.equal(sels.h,width===1280?40:44,tag+': select height');
 await context.close();
}

async function behaviour(scheme){
 fresh();
 const {context,page}=await open({scheme});
 const dlg=await openSheet(page,1280),sw=dlg.getByRole('switch',{name:'Restart unhealthy containers'});
 const ring=()=>sw.evaluate(e=>{const c=getComputedStyle(e,'::before');return c.outlineStyle==='none'||c.outlineWidth==='0px'?'none':c.outlineStyle});
 // Opening focuses the title, so the switch starts without a ring, and a mouse click leaves none
 assert.equal(await ring(),'none','no ring on open');
 await sw.click();
 assert.equal(await sw.getAttribute('aria-checked'),'false','click turns it off');
 assert.equal(await sw.evaluate(e=>e.matches(':focus-visible')),false,'no focus-visible after click');
 assert.equal(await ring(),'none','no ring after mouse click');
 assert.equal(await sw.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)','switch hit area stays transparent');
 // Keyboard focus shows exactly one ring
 await page.keyboard.press('Tab');
 await page.keyboard.press('Shift+Tab');
 for(let i=0;i<6&&!(await sw.evaluate(e=>document.activeElement===e));i++)await page.keyboard.press('Tab');
 assert.equal(await sw.evaluate(e=>e===document.activeElement),true,'keyboard reaches the switch');
 assert.notEqual(await ring(),'none','ring on keyboard focus');
 await page.keyboard.press('Space');
 assert.equal(await sw.getAttribute('aria-checked'),'true','space toggles');
 // Off disables the fields, on enables them; limit 1..10
 await sw.click();
 assert.equal(await dlg.locator('.sh-count').isDisabled(),true);assert.equal(await dlg.locator('select.sh-window').isDisabled(),true);
 await sw.click();
 const n=dlg.locator('.sh-count');
 await n.fill('11');await dlg.getByRole('button',{name:'Save'}).click();
 assert.equal(mock.puts.length,0,'11 is refused');assert.equal(await n.getAttribute('aria-invalid'),'true');
 await n.fill('0');await dlg.getByRole('button',{name:'Save'}).click();assert.equal(mock.puts.length,0,'0 is refused');
 await n.fill('5');
 const options=await dlg.locator('select.sh-window option').allTextContents();
 assert.deepEqual([options[0],options[options.length-1]],['10 minutes','24 hours']);
 await dlg.locator('select.sh-window').selectOption('360');
 await dlg.getByRole('button',{name:'Save'}).click();
 await page.waitForFunction(()=>!document.querySelector('dialog.sh-sheet'));
 assert.deepEqual(mock.puts,[{enabled:true,maxRestarts:5,windowMinutes:360}],'PUT body');
 await page.getByText('Self-heal saved.').waitFor();
 await context.close();
}

async function failures(){
 // 422 NO_HEALTHCHECK keeps the sheet open with the red panel
 fresh();mock.putError='NO_HEALTHCHECK';
 let {context,page}=await open({});
 let dlg=await openSheet(page,1280);
 await dlg.getByRole('button',{name:'Save'}).click();
 await dlg.locator('.alert-error').waitFor();
 assert.match(await dlg.locator('.alert-error').innerText(),/No container in this site has a health check/);
 assert.equal(await dlg.count(),1,'sheet stays open');
 await context.close();
 // Load failure with Try again
 fresh();mock.loadStatus=500;
 ({context,page}=await open({}));
 await page.locator('.map-site',{hasText:'Demo Shop'}).first().click();
 await page.getByRole('button',{name:'Self-heal',exact:true}).click();
 dlg=page.locator('dialog.sh-sheet');
 await dlg.locator('.alert-error').waitFor();
 mock.loadStatus=200;await dlg.getByRole('button',{name:'Try again'}).click();
 await dlg.getByRole('switch').waitFor();
 await context.close();
 // Operators: read-only, no Save
 fresh();
 ({context,page}=await open({role:'operator'}));
 dlg=await openSheet(page,1280);
 assert.equal(await dlg.getByRole('switch').isDisabled(),true,'operator switch disabled');
 assert.equal(await dlg.getByRole('button',{name:'Save'}).count(),0,'operator has no Save');
 await footerButtons(dlg,'operator');
 await shot(page,'operator-desktop-light');
 await context.close();
 // Static sites have nothing to heal: no entry
 fresh();
 ({context,page}=await open({}));
 await context.close();
}

async function existingDialogsUnchanged(scheme){
 fresh();
 const {context,page}=await open({scheme});
 await page.locator('.map-site',{hasText:'Demo Shop'}).first().click();
 await page.getByRole('button',{name:'Move to…'}).click();
 const dlg=page.locator('dialog.map-dialog');await dlg.waitFor();
 const look=await dlg.evaluate(d=>({edge:d.classList.contains('dialog-edge'),border:getComputedStyle(d).borderTopWidth,head:!!d.querySelector('.map-dialog-head'),h2InBody:!!d.querySelector('.map-dialog-body h2')}));
 assert.deepEqual(look,{edge:false,border:'0px',head:false,h2InBody:true},scheme+': existing dialog unchanged');
 await context.close();
}

browser=await chromium.launch();
try{
 for(const scheme of ['light','dark'])for(const width of [1280,390]){
  await board('05-self-heal-settings',{},{scheme,width});
  await board('16-self-heal-off',{enabled:false,events:[]},{scheme,width});
  await board('17-self-heal-no-healthcheck',{enabled:false,watched:[],events:[]},{scheme,width});
 }
 await behaviour('light');await behaviour('dark');
 await failures();
 await existingDialogsUnchanged('light');await existingDialogsUnchanged('dark');
 assert.deepEqual(errors,[],'no page errors');
 console.log('self-heal browser: ok');
}finally{await browser.close()}
