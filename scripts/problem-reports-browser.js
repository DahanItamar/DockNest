import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

// Problem reports against a mocked API (docs/update-center.md sections 7.1 and 13): the review dialog content, the
// environment section, the update excerpt, role gating, the app error boundary, the 402 px bottom sheet and light and
// dark themes. Opening GitHub is intercepted: the browser must make no request to DockNest's server for it, send no
// referrer and leave no opener. Run against a dev server: TEST_BASE_URL=http://127.0.0.1:5197.
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5173';
const directory='data/screenshots/problem-reports';
await mkdir(directory,{recursive:true});
const CANARIES=['canary-host.example.com','203.0.113.77','/home/canaryuser','canary.user@example.org','Canary Storefront','canary-server','CANARY error text','ghp_CANARYtoken0123456789abcdef'];
const CANARY=CANARIES.join(' ');
const iso=(s=0)=>new Date(Date.UTC(2026,9,1,10,0,s)).toISOString().replace('.000','');
const env={docker:'27.3.1',compose:'2.29.7',os:'ubuntu',osVersion:'26.04',kernel:'7.0.2',arch:'x86_64',git:'2.51.0',cosign:'v2.4.1',disk:'>50GiB'};
const diagnostics=[{phase:'start',command:'docker inspect',at:iso(0)},{phase:'finish',command:'docker inspect',at:iso(1),elapsedMs:900,outcome:'ok'},{phase:'start',command:'cat',at:iso(2)},{phase:'finish',command:'cat',at:iso(40),elapsedMs:38000,outcome:'timeout',timeoutSeconds:30}];
const failedJob={id:'job-canary-1',siteId:'site-1',type:'backup',status:'failed',stage:'failed',createdAt:iso(0),startedAt:iso(0),finishedAt:iso(40),error:CANARY,details:{diagnostics,failure:{at:iso(40),lastStage:'sending',errorType:'Error',remoteReported:false,cause:{message:CANARY}}}};
const state=(over={})=>({servers:[{id:'srv-1',name:'canary-server',note:CANARY,username:'canaryuser',host:'203.0.113.77',port:22,hostKey:'ab'.repeat(32),status:'connected'}],sites:[{id:'site-1',name:'Canary Storefront',serverId:'srv-1',config:{kind:'docker',containers:['web','db','cache'],domains:['canary-host.example.com']}}],policies:[],backups:[],jobs:[failedJob],restores:[],audit:[],storage:{used:0,total:1e12,backend:'sftp',name:'Canary Storage'},worker:{online:true},maintenance:{},...over});
const updateStatus={requestId:'req-canary',requestedBy:{id:'user-canary',name:'canaryuser'},from:'v2.3.0',to:'v2.4.0',phase:'rollback',state:'rolled_back',exitCode:4,stale:false,startedAt:iso(0),updatedAt:iso(482),acceptedAt:iso(0),reason:'health-timeout-api',fromSchema:5,toSchema:5,installMode:'source',updaterVersion:'2.2.0',env,events:[{phase:'verify',at:iso(0)},{phase:'build',at:iso(4)},{phase:'health',at:iso(134)},{phase:'rollback',at:iso(434)}],
 error:'Health check failed on 203.0.113.77 for canary-host.example.com\n/home/canaryuser/docknest/.env missing',rollbackHint:'Run on canary.user@example.org: ghp_CANARYtoken0123456789abcdef',warning:null};
const progress={running:{active:true,phase:'health',to:'v2.4.0',state:'running',stale:false,updatedAt:iso(134),events:[]},done:{active:false,phase:'rollback',to:'v2.4.0',state:'rolled_back',stale:false,updatedAt:iso(482),events:[]},idle:{active:false,phase:null,to:null,state:null,stale:false,updatedAt:null,events:[]}};

let browser;const errors=[];
async function open({role='admin',width=1440,height=1000,scheme='light',appState=state(),lock=false,serverTest=null}={}){
 const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',colorScheme:scheme});
 const page=await context.newPage();
 page.on('pageerror',error=>errors.push(error.message));
 const local=[],github=[],offOrigin=[];let polls=0;
 context.on('request',req=>{const u=new URL(req.url());if(!['data:','blob:'].includes(u.protocol)&&u.origin!==new URL(base).origin)offOrigin.push(u.origin);});
 local.offOrigin=offOrigin;
 page.on('request',req=>{const u=new URL(req.url());if(u.origin===new URL(base).origin&&u.pathname.startsWith('/api/'))local.push({method:req.method(),path:u.pathname,body:req.postData()||''});});
 await context.route('https://github.com/**',route=>{github.push({url:route.request().url(),referer:route.request().headers().referer});return route.fulfill({status:200,contentType:'text/html',body:'<title>GitHub</title>'})});
 await context.route('**/api/**',route=>{
  const req=route.request(),p=new URL(req.url()).pathname,json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(p==='/api/auth/status')return json({authenticated:true,csrfToken:'fixture',user:{id:role,name:'Fixture '+role,role},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000});
  if(p==='/api/version')return json({version:lock?'2.3.0':'2.4.0',schemaVersion:5});
  if(p==='/api/updates/progress')return json(lock?(polls++<2?progress.running:progress.done):progress.idle);
  if(p==='/api/updates/status')return json(updateStatus);
  if(p==='/api/updates')return json({state:'up-to-date',consent:{checkEnabled:false},check:{},updater:{present:true,version:'2.2.0',supported:true,status:'connected',installMode:'image',env},offer:{update:null}});
  if(p==='/api/updates/whats-new')return json({show:false});
  if(p==='/api/state')return json(appState);
  if(p==='/api/jobs/'+failedJob.id)return json(failedJob);
  if(p==='/api/servers/srv-1/test'&&serverTest)return json(serverTest.body,serverTest.status);
  return json({});
 });
 await page.addInitScript(theme=>{try{localStorage.setItem('docknest-theme',theme)}catch{}},scheme);
 await page.goto(base+'/');
 return {context,page,local,github};
}
const paramsOf=href=>new URL(href).searchParams;
function noCanary(text,where){for(const c of CANARIES)assert.ok(!text.includes(c),where+' leaks '+c);}
async function reviewDialog(page){const dialog=page.getByRole('dialog',{name:'Review what will be shared'});await dialog.waitFor();return dialog;}
// Opens GitHub from the dialog and proves: new tab, no opener, no referrer, nothing sent to DockNest's server.
async function openGitHub(context,page,dialog,local,github){
 const link=dialog.getByRole('link',{name:/Open GitHub/});
 assert.equal(await link.getAttribute('target'),'_blank');assert.equal(await link.getAttribute('rel'),'noopener noreferrer');assert.equal(await link.getAttribute('referrerpolicy'),'no-referrer');
 const href=await link.getAttribute('href'),before=local.length,popup=context.waitForEvent('page');
 await link.click();
 const tab=await popup;await tab.waitForLoadState();
 assert.equal(github.at(-1).url,href);assert.equal(github.at(-1).referer,undefined,'No referrer is sent');
 assert.equal(await tab.evaluate(()=>window.opener),null,'No opener');
 const after=local.slice(before);
 for(const r of after){assert.ok(!/github|issues|template|report/i.test(r.path+' '+r.body),'Nothing about the report reaches DockNest: '+r.method+' '+r.path);assert.ok(['/api/state','/api/auth/activity','/api/version','/api/updates/progress'].includes(r.path),'Unexpected request to DockNest while opening GitHub: '+r.method+' '+r.path);}
 await tab.close();
 assert.deepEqual([...new Set(local.offOrigin)],['https://github.com'],'The only request off DockNest is GitHub, made by the browser');
 return href;
}
async function openJob(page){
 if(page.viewportSize().width<=767)await page.getByRole('button',{name:'Open navigation'}).click();
 await page.getByRole('navigation').getByRole('button',{name:'Jobs',exact:true}).click();
 await page.getByRole('button',{name:'View job'}).first().click();
 return page.getByRole('dialog',{name:'Job details'});
}
try{
 browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true}).catch(()=>chromium.launch({headless:true}));

 // 1. Job details, admin: the exact title and values, environment on by default and untickable, GitHub opens safely.
 {
  const {context,page,local,github}=await open();
  const job=await openJob(page);
  const panel=job.getByRole('alert').filter({hasText:'What happened'});
  await panel.getByRole('button',{name:'Open GitHub',exact:true}).click();
  const dialog=await reviewDialog(page);
  assert.deepEqual(await dialog.locator('.rp-steps li').evaluateAll(els=>els.map(el=>el.innerText.trim())),['1  Review here','2  Open GitHub','3  Describe and submit there']);
  const rows=await dialog.locator('.rp-list .def-row').evaluateAll(els=>els.map(el=>[el.querySelector('dt').textContent,el.querySelector('dd').textContent]));
  assert.deepEqual(rows,[['Title','Backup failed: send step'],['DockNest','v2.4.0 · image'],['Job','backup'],['Outcome','failed'],['Failed at','send'],['Site kind','docker'],['Storage','sftp'],['Containers','2-5'],['Helper outcome','timeout']]);
  await dialog.getByText('Never shared',{exact:true}).waitFor();
  await dialog.getByText('Error text from your servers, logs and keys').waitFor();assert.ok(/Error text is shared only as DockNest.s own fixed message/.test(await dialog.textContent()));assert.ok(!(await dialog.textContent()).includes('error text, logs'),'No claim that contradicts the What happened row');
  await dialog.getByText('Issues on the DockNest repository are public and linked to your GitHub account. Anyone can read what you share.').waitFor();
  const envBox=dialog.getByRole('checkbox',{name:/Include environment/});
  assert.equal(await envBox.isChecked(),true,'Environment included by default');
  noCanary(await dialog.innerText(),'review dialog');
  let href=await dialog.getByRole('link',{name:/Open GitHub/}).getAttribute('href');
  const p=paramsOf(href);
  assert.equal(p.get('template'),'job-failure.yml');assert.equal(p.get('title'),'Backup failed: send step');assert.equal(p.get('docker'),'27.3');assert.equal(p.get('os'),'ubuntu-26');
  noCanary(decodeURIComponent(href),'job report URL');
  // Identical, non-wrapping footer buttons.
  const sizes=await dialog.locator('.rp-foot>*').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height),el.scrollWidth<=el.clientWidth+1,Math.round(r.y)]}));
  assert.equal(sizes[0][1],40);assert.deepEqual(sizes[0],sizes[1],'Cancel and Open GitHub are identical');
  await page.screenshot({path:directory+'/review-light.png'});
  await envBox.uncheck();
  href=await dialog.getByRole('link',{name:/Open GitHub/}).getAttribute('href');
  for(const key of ['docker','compose','git','cosign','os','kernel','arch','free_disk'])assert.equal(paramsOf(href).get(key),null,'unticked: '+key);
  assert.equal(await openGitHub(context,page,dialog,local,github),href);
  await context.close();
 }

 // 2. Operators: no report buttons (admin-only), but Report a bug in About.
 {
  const {context,page,local,github}=await open({role:'operator'});
  const job=await openJob(page);
  await job.getByText('What happened').waitFor();
  assert.equal(await page.getByRole('button',{name:'Open GitHub',exact:true}).count(),0,'Job reports are admin-only');
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Open account preferences'}).click();
  await page.getByRole('dialog',{name:'Settings'}).getByRole('button',{name:'Report a bug',exact:true}).click();
  const dialog=await reviewDialog(page);
  assert.equal(await dialog.getByRole('checkbox').count(),0,'Report a bug has no environment section');
  const href=await openGitHub(context,page,dialog,local,github);
  assert.deepEqual([...paramsOf(href).keys()].sort(),['template','title','version']);
  await context.close();
 }

 // 3. Server connection test failure: check and class only, never the address or message.
 {
  const {context,page,local,github}=await open({serverTest:{status:422,body:{error:'All configured authentication methods failed for canaryuser@203.0.113.77',check:'ssh',errorClass:'auth-failed'}}});
  await page.getByRole('navigation').getByRole('button',{name:'Servers',exact:true}).click();
  const card=page.getByRole('article',{name:'canary-server'});
  await card.getByRole('button',{name:'Test connection',exact:true}).click();
  const panel=card.getByRole('alert').filter({hasText:'The connection test failed'});
  await panel.waitFor();
  const actions=await panel.locator('.rp-actions>*').evaluateAll(els=>els.map(el=>Math.round(el.getBoundingClientRect().height)));
  assert.deepEqual(actions,[40,40],'Test again and Open GitHub share one height');
  await panel.getByRole('button',{name:'Open GitHub',exact:true}).click();
  const dialog=await reviewDialog(page);
  const href=await openGitHub(context,page,dialog,local,github),p=paramsOf(href);
  assert.equal(p.get('template'),'server-connection.yml');assert.equal(p.get('check'),'ssh');assert.equal(p.get('error_class'),'auth-failed');
  noCanary(decodeURIComponent(href),'server report URL');
  await context.close();
 }

 // 4. App error boundary: route, area and error name only. The message and stack never appear in the report.
 {
  const {context,page,local,github}=await open({appState:state({servers:[null]})});
  // The error screen covers the whole page, so the failing area here is the overview.
  const screen=page.getByRole('alert').filter({hasText:'This page stopped working'});
  await screen.waitFor();
  await screen.getByText('Your backups and settings are safe. Reload the page, or tell us what happened.').waitFor();
  await screen.getByRole('button',{name:'Reload page'}).waitFor();
  await screen.getByRole('button',{name:'Open GitHub',exact:true}).click();
  const dialog=await reviewDialog(page);
  const href=await openGitHub(context,page,dialog,local,github),p=paramsOf(href),decoded=decodeURIComponent(href);
  assert.equal(p.get('template'),'app-error.yml');assert.equal(p.get('route'),'overview');assert.equal(p.get('area'),'page');assert.equal(p.get('error_name'),'TypeError');
  assert.equal(p.get('title'),'App error: TypeError on overview');
  for(const key of p.keys())assert.ok(['template','title','version','install_mode','route','area','error_name','docker','compose','git','cosign','os','kernel','arch','free_disk'].includes(key),'unexpected field '+key);
  assert.ok(!/Cannot read|null|reading|\.jsx|at /.test(decoded.replace('App error','')),'no message or stack: '+decoded);
  errors.length=0; // The deliberate render error is reported by React as a page error.
  // Operators see the same screen without the report button.
  await context.close();
  const op=await open({role:'operator',appState:state({servers:[null]})});
  await op.page.getByRole('heading',{name:'This page stopped working'}).waitFor();
  assert.equal(await op.page.getByRole('button',{name:'Open GitHub',exact:true}).count(),0);
  await op.context.close();errors.length=0;
 }

 // 5. Update failure on the lock view result: section 7.1 fields, timeline, excerpt off by default and redacted.
 {
  const {context,page,local,github}=await open({lock:true});
  await page.getByRole('heading',{name:'The update did not complete',level:1}).waitFor({timeout:10000});
  await page.locator('.progress-actions').getByRole('button',{name:'Open GitHub',exact:true}).click();
  const dialog=await reviewDialog(page);
  await dialog.getByText('Update failed: v2.3.0 to v2.4.0 (rolled back)').first().waitFor();
  await dialog.getByText('verify 0 4 · build 4 130 · health 134 300 · rollback 434 48').waitFor();
  const excerpt=dialog.getByRole('checkbox',{name:/Include the last error lines/});
  assert.equal(await excerpt.isChecked(),false,'Excerpt is off by default');
  let href=await dialog.getByRole('link',{name:/Open GitHub/}).getAttribute('href');
  let p=paramsOf(href);
  assert.equal(p.get('excerpt'),null);assert.equal(p.get('outcome'),'rolled_back');assert.equal(p.get('result'),'exit-4');assert.equal(p.get('stage'),'confirm');assert.equal(p.get('phase'),'health');assert.equal(p.get('reason'),'health-timeout-api');assert.equal(p.get('install_mode'),'source');
  assert.equal(p.get('timeline'),'verify 0 4\nbuild 4 130\nhealth 134 300\nrollback 434 48');
  noCanary(decodeURIComponent(href),'update report URL');
  await excerpt.check();
  const text=dialog.getByRole('textbox',{name:/Error lines/});
  const value=await text.inputValue();
  assert.match(value,/\[redacted\]/);noCanary(value,'redacted excerpt');
  await dialog.getByText('This may still contain private text. Read it before sharing.').waitFor();
  await text.fill(value+'\nadded by hand: 198.51.100.9');
  href=await dialog.getByRole('link',{name:/Open GitHub/}).getAttribute('href');
  p=paramsOf(href);
  assert.ok(p.get('excerpt').includes('added by hand: [redacted]'),'Edited text is redacted again');noCanary(decodeURIComponent(href),'excerpt URL');
  await openGitHub(context,page,dialog,local,github);
  await context.close();
 }

 // 6. Phone 402 px: bottom sheet, 44 px full-width buttons with Open GitHub first, no horizontal scroll; light and dark.
 for(const scheme of ['light','dark']){
  const {context,page}=await open({width:402,height:874,scheme});
  const job=await openJob(page);
  await job.getByRole('button',{name:'Open GitHub',exact:true}).click();
  const dialog=await reviewDialog(page);
  await page.waitForTimeout(50);
  const box=await dialog.boundingBox();
  assert.ok(Math.abs(box.width-402)<=1,'Full-width sheet');assert.ok(Math.abs(box.y+box.height-874)<=1,'Docked to the bottom');
  const buttons=await dialog.locator('.rp-foot>*').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {text:el.textContent.trim(),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}}));
  assert.ok(buttons.every(b=>b.h===44),'44 px buttons');assert.equal(buttons[0].w,buttons[1].w,'Identical widths');
  const openFirst=buttons.find(b=>b.text.startsWith('Open GitHub')),cancel=buttons.find(b=>b.text==='Cancel');
  assert.ok(openFirst.y<cancel.y,'Open GitHub comes first');assert.ok(cancel.y+cancel.h<=874,'The actions stay in view');
  assert.equal(await dialog.locator('.rp-never-line').isVisible(),true);assert.equal(await dialog.locator('.rp-never-list').isVisible(),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No horizontal scroll');
  const bg=await dialog.evaluate(el=>getComputedStyle(el).backgroundColor);
  if(scheme==='light')assert.equal(bg,'rgb(255, 255, 255)');else assert.notEqual(bg,'rgb(255, 255, 255)','Dark surface');
  await page.screenshot({path:directory+'/sheet-402-'+scheme+'.png'});
  await page.keyboard.press('Escape');
  await page.getByRole('dialog',{name:'Review what will be shared'}).waitFor({state:'detached'});
  await context.close();
 }

 assert.deepEqual(errors,[]);
 console.log('Problem reports passed against a mocked API: review dialog content, environment untick, excerpt redaction, no request to DockNest when opening GitHub, no opener or referrer, admin-only gating with Report a bug for operators, error boundary report, 402 px bottom sheet, light and dark.');
}finally{await browser?.close();}
