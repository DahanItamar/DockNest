import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

// Self-heal sheet (docs/self-heal.md, issue #150) against a mocked API: the approved boards 05, 16 and 17 at 1280 and
// 390, light and dark; fixed header and footer with a scrolling body; the switch focus ring only on keyboard focus;
// buttons that never wrap; saving; operators read-only; existing dialogs unchanged. Run against a dev server serving
// this worktree: TEST_BASE_URL=http://127.0.0.1:5311 npm run test:self-heal. SHOTS_DIR also writes screenshots.
// REAL_API=1 runs the main states against the real routes (src/self-heal/routes.js) on a throwaway database, serving the built app
// (run npm run build first); only the helper call that finds health-checked containers is faked. REAL_PORT picks the port (default 5398).
const REAL=process.env.REAL_API==='1',realPort=Number(process.env.REAL_PORT||5398);
const base=REAL?'http://127.0.0.1:'+realPort:process.env.TEST_BASE_URL||'http://127.0.0.1:5173',shots=process.env.SHOTS_DIR;
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
const fresh=(over={})=>{mock={card:{available:true,enabled:true,maxRestarts:3,windowMinutes:60,watched:[{name:'demo-0-web',project:'demo',service:'web',health:'healthy',found:true}],stream:{state:'connected',reason:null,notWatching:null},note:'Works while DockNest is running.',events:{items:EVENTS,nextCursor:null},...over},puts:[],loadStatus:200,putError:null}};
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
    if(mock.putError)return json(route,{error:'raw',code:mock.putError},mock.putError==='UNREACHABLE'?502:422);
    const body=req.postDataJSON();mock.puts.push(body);Object.assign(mock.card,body);return json(route,{...mock.card,canEdit:true});
   }
   return mock.loadStatus===200?json(route,{...mock.card,canEdit:role==='admin'}):json(route,{error:'Self-heal could not be loaded.'},mock.loadStatus);
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
 // 422 NO_HEALTHCHECK (never switched on, nothing known yet) turns the sheet into the no-health-check state
 fresh({enabled:false,watched:[],stream:{state:'off',reason:null,notWatching:null},events:{items:[],nextCursor:null}});mock.putError='NO_HEALTHCHECK';
 let {context,page}=await open({});
 let dlg=await openSheet(page,1280);
 const sw=dlg.getByRole('switch');
 assert.equal(await sw.isDisabled(),false,'unknown state can be switched on');
 await sw.click();await dlg.getByRole('button',{name:'Save'}).click();
 await dlg.getByText('No container has a health check. Add one in Compose.').waitFor();
 assert.equal(await sw.isDisabled(),true);assert.equal(await sw.getAttribute('aria-checked'),'false');
 assert.equal(await dlg.count(),1,'sheet stays open');
 await context.close();
 // Not watching: a short amber sentence, and the watched names under it
 fresh({stream:{state:'connecting',reason:'unreachable',notWatching:'Not watching: the server cannot be reached; DockNest keeps trying'}});
 ({context,page}=await open({}));
 dlg=await openSheet(page,1280);
 assert.equal((await dlg.locator('.alert-warning').innerText()).trim(),'Not watching: server unreachable. Retrying.');
 assert.equal((await dlg.locator('.sh-watched').innerText()).trim(),'Watching demo-0-web');
 await context.close();
 // Too many containers: the server's own sentence in the red panel
 fresh();mock.putError='TOO_MANY_CONTAINERS';
 ({context,page}=await open({}));
 dlg=await openSheet(page,1280);
 await dlg.getByRole('button',{name:'Save'}).click();
 await dlg.locator('.alert-error').waitFor();
 assert.match(await dlg.locator('.alert-error').innerText(),/Too many containers/);
 await context.close();
 fresh({stream:{state:'off',reason:'too_many',notWatching:'x'}});
 ({context,page}=await open({}));
 dlg=await openSheet(page,1280);
 assert.equal((await dlg.locator('.alert-warning').innerText()).trim(),'Not watching: this server already watches 50 containers.');
 await context.close();
 // Another save error keeps the sheet open with a red panel
 fresh();mock.putError='UNREACHABLE';
 ({context,page}=await open({}));
 dlg=await openSheet(page,1280);
 await dlg.getByRole('button',{name:'Save'}).click();
 await dlg.locator('.alert-error').waitFor();
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

// ---------- REAL_API=1: the real routes, a throwaway database, a fake helper ----------
async function realApi(){
 const {existsSync}=await import('node:fs');
 const {mkdtemp,writeFile:write}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {randomBytes,randomUUID}=await import('node:crypto');
 if(!existsSync('dist/index.html'))throw new Error('REAL_API=1 serves the built app: run npm run build first.');
 const dir=await mkdtemp(path.join(tmpdir(),'docknest-sh-real-'));
 Object.assign(process.env,{DATA_DIR:dir,BACKUP_DIR:path.join(dir,'backups'),BACKUP_STORAGE:'local',MASTER_KEY_FILE:path.join(dir,'master.key'),SETUP_TOKEN_FILE:path.join(dir,'setup.token'),SECURE_COOKIES:'false',NODE_ENV:'test',APP_ORIGIN:base});
 await mkdir(process.env.BACKUP_DIR,{recursive:true});await write(process.env.MASTER_KEY_FILE,randomBytes(32).toString('base64'));
 const root=new URL('../src/',import.meta.url);
 const {app}=await import(new URL('server.js',root));
 const {db}=await import(new URL('db.js',root));
 const {digest}=await import(new URL('crypto.js',root));
 const {healApi}=await import(new URL('self-heal/routes.js',root));
 // The server answers: only demo-web has a health check; the second site has none.
 healApi.resolve=async(_server,names)=>({containers:names.map(name=>({name,healthcheck:name==='demo-web',project:'demo',service:name.replace('demo-','')}))});
 const listener=app.listen(realPort,'127.0.0.1');await new Promise((resolve,reject)=>{listener.once('listening',resolve);listener.once('error',reject)});
 const now=()=>new Date().toISOString();
 const session=role=>{const userId=randomUUID(),token=randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId,userId+'@example.invalid','fixture','fixture','[]',now(),'Fixture '+role,role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token),userId,randomBytes(16).toString('hex'),Date.now()+3600000,Date.now(),Date.now(),Date.now());
  return token;};
 const serverId=randomUUID();
 db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,status,capabilities,created_at) VALUES(?,?,?,?,?,?,?,'connected',?,?)").run(serverId,'Commerce host','192.0.2.10',22,'root','fixture','0'.repeat(64),JSON.stringify({freeBytes:84*1024**3}),now());
 const site=(name,containers)=>{const id=randomUUID();db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(id,serverId,name,JSON.stringify({kind:'docker',containers,domains:[name+'.example.com']}),now());return id};
 const healthy=site('Demo Shop',['demo-web','demo-db']),plain=site('Plain Site',['demo-db']);
 const signedIn=async(token,width=1280)=>{const context=await browser.newContext({viewport:{width,height:width<600?844:800},reducedMotion:'reduce'});await context.addCookies([{name:'dbm_session',value:token,url:base}]);const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/');await page.locator('.berry-sidebar').waitFor();
  if(width<900)await page.getByRole('button',{name:'Open navigation'}).click();
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Map',exact:true}).click();return {context,page}};
 const openFor=async(page,name)=>{const panel=page.locator('.map-panel');if(await panel.count()){await panel.getByRole('button',{name:'Close'}).first().click();await panel.waitFor({state:'detached'})}await page.locator('.map-site',{hasText:name}).first().click();await page.getByRole('button',{name:'Self-heal',exact:true}).click();const d=page.locator('dialog.sh-sheet');await d.getByRole('switch').waitFor();return d};
 try{
  // Administrator: off on a fresh site, then on through the real PUT (the fake helper finds demo-web)
  const adminToken=session('admin');
 db.prepare("INSERT INTO update_preferences(id,check_enabled,decided_by,decided_at) VALUES(1,0,(SELECT id FROM users LIMIT 1),?)").run(now());
  let {context,page}=await signedIn(adminToken);
  let d=await openFor(page,'Demo Shop');
  assert.equal(await d.getByRole('switch').getAttribute('aria-checked'),'false','off on a fresh site');
  assert.equal(await d.getByText('No restarts yet').count(),1);
  await d.getByRole('switch').click();await d.locator('.sh-count').fill('4');await d.locator('select.sh-window').selectOption('360');
  await d.getByRole('button',{name:'Save'}).click();
  await page.getByText('Self-heal saved.').waitFor();
  const row=db.prepare('SELECT * FROM self_heal_settings WHERE site_id=?').get(healthy);
  assert.deepEqual([row.enabled,row.max_restarts,row.window_minutes],[1,4,360]);assert.deepEqual(JSON.parse(row.watched).map(x=>x.name),['demo-web']);
  // History: real rows come back newest first through the real GET
  for(const [i,kind] of ['restarted','limit_reached','restart_failed'].entries())db.prepare('INSERT INTO self_heal_events(id,site_id,server_id,container,kind,reason,at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),healthy,serverId,'demo-web',kind,null,new Date(Date.now()-(i+1)*3600000).toISOString());
  d=await openFor(page,'Demo Shop');
  assert.equal(await d.getByRole('switch').getAttribute('aria-checked'),'true');assert.equal(await d.locator('.sh-count').inputValue(),'4');assert.equal(await d.locator('select.sh-window').inputValue(),'360');
  assert.deepEqual(await d.locator('tbody tr td:last-child').allInnerTexts(),['Restarted','Limit reached','Restart failed']);
  await noOverflow(page,'real');await shot(page,'real-on-desktop');
  await d.getByRole('button',{name:'Cancel'}).click();
  // A site without a health check: the real 422 turns the sheet into the no-health-check state
  d=await openFor(page,'Plain Site');
  await d.getByRole('switch').click();await d.getByRole('button',{name:'Save'}).click();
  await d.getByText('No container has a health check. Add one in Compose.').waitFor();
  assert.equal(await d.getByRole('switch').isDisabled(),true);assert.equal(db.prepare('SELECT enabled FROM self_heal_settings WHERE site_id=?').get(plain)?.enabled??0,0);
  await shot(page,'real-no-healthcheck-desktop');
  await context.close();
  // Operator: the real canEdit=false makes it read-only
  ({context,page}=await signedIn(session('operator')));
  d=await openFor(page,'Demo Shop');
  assert.equal(await d.getByRole('switch').isDisabled(),true);assert.equal(await d.getByRole('button',{name:'Save'}).count(),0);
  await context.close();
  // Phone
  ({context,page}=await signedIn(session('admin'),390));
  await page.locator('.map-list li',{hasText:'Demo Shop'}).getByRole('button',{name:'Details'}).click();await page.getByRole('button',{name:'Self-heal',exact:true}).click();
  d=page.locator('dialog.sh-sheet');await d.getByRole('switch').waitFor();await noOverflow(page,'real phone');await shot(page,'real-on-phone');
  await context.close();
 }finally{listener.close()}
}

browser=await chromium.launch();
if(REAL){try{await realApi();assert.deepEqual(errors,[],'no page errors');console.log('Self-heal browser suite passed against the real API.')}finally{await browser.close()}process.exit(0)}
try{
 for(const scheme of ['light','dark'])for(const width of [1280,390]){
  await board('05-self-heal-settings',{},{scheme,width});
  await board('16-self-heal-off',{enabled:false,events:{items:[],nextCursor:null}},{scheme,width});
  await board('17-self-heal-no-healthcheck',{enabled:false,watched:[],stream:{state:'off',reason:'no_healthcheck',notWatching:'Not watching: no container in this site has a health check'},events:{items:[],nextCursor:null}},{scheme,width});
 }
 await behaviour('light');await behaviour('dark');
 await failures();
 await existingDialogsUnchanged('light');await existingDialogsUnchanged('dark');
 assert.deepEqual(errors,[],'no page errors');
 console.log('self-heal browser: ok');
}finally{await browser.close()}
