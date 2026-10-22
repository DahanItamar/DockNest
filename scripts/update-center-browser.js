import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

// Update Center UI against a mocked API (docs/update-center.md sections 4, 7 and 13). Only built assets are served, on
// loopback; every /api response is a browser fixture. This proves the UI, never a real update, rollback or restart.
const root=path.resolve('dist'),mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.webmanifest':'application/manifest+json'};
const server=createServer(async(req,res)=>{
 const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname+(req.url==='/'?'index.html':''));
 if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 try{res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(await readFile(file));}catch{res.writeHead(404).end();}
});
server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:'+server.address().port,iso=()=>new Date().toISOString();
const hostileNotes='---\nhighlights:\n  security: true\n---\n# Release notes\n\n## Security\n- Tightened **validation** of enrollment links.\n- [bad](javascript:alert(1)) and <img src=x onerror=alert(1)> and [evil](https://evil.example/x)\n\n## New features\n- See [the guide](docs/upgrading.md) and [the repo](https://github.com/DahanItamar/DockNest/pull/1).\n';
const updateState=(over={})=>({state:'update-available',current:{version:'2.2.0',schemaVersion:4},consent:{checkEnabled:true,decidedBy:{id:'admin',name:'Fixture administrator'},decidedAt:iso()},check:{status:'ok',checkedAt:iso(),lastSuccessAt:iso(),nextCheckAt:null,error:null,latest:{version:'v2.3.0',publishedAt:iso(),releaseUrl:'https://github.com/DahanItamar/DockNest/releases/tag/v2.3.0',minUpgradeFrom:null}},updater:{present:true,version:'1.4',supported:true,selfUpdateFailed:false,blocked:false,status:'connected',lastHeartbeatAt:iso(),installMode:'source'},offer:{update:{version:'v2.3.0',releaseUrl:'https://github.com/DahanItamar/DockNest/releases/tag/v2.3.0'},cli:null,blocked:null},active:null,...over});
const running={active:true,phase:'build',to:'v2.3.0',state:'running',stale:false,updatedAt:iso(),events:[]};
const idle={active:false,phase:null,to:null,state:null,stale:false,updatedAt:null,events:[]};
const newMock=(over={})=>({auth:'admin',locked:false,version:'2.2.0',schema:4,state:updateState(),progress:idle,whatsNew:{show:false},reauth:200,request:{status:202,body:{requestId:'req-1'}},consent:{status:200},calls:[],bodies:{},...over});
const meta={version:'v2.3.0',publishedAt:iso(),releaseUrl:'https://github.com/DahanItamar/DockNest/releases/tag/v2.3.0',highlights:{security:true,features:3,improvements:5},highlightsVerified:true,compatibility:{minimumMet:true,updatesDatabase:'yes',fromSchema:4,toSchema:5},downtime:{seconds:240,basis:'last-run'},pauses:['Backups and restores'],notesMarkdown:hostileNotes,notesSource:'verified'};
const baseState={servers:[],sites:[],policies:[],backups:[],jobs:[{id:'j1',siteId:'s1',type:'backup',status:'running',stage:'transferring',createdAt:iso()}],restores:[],audit:[],storage:{used:0,total:1e12},worker:{online:true},maintenance:{}};
const EXEMPT=['/api/updates/progress','/api/version','/api/auth/status','/api/auth/logout','/api/updates','/api/updates/status'];
function handler(mock){
 return route=>{
  const req=route.request(),p=new URL(req.url()).pathname,m=req.method(),json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  mock.calls.push(m+' '+p);if(req.postData())mock.bodies[m+' '+p]=req.postData();
  if(mock.locked&&!EXEMPT.includes(p)&&!/^\/api\/updates\/requests\/[^/]+\/acknowledge$/.test(p))return json({error:'UPDATE_IN_PROGRESS'},423);
  if(p==='/api/updates/progress')return json(typeof mock.progress==='function'?mock.progress():mock.progress);
  if(p==='/api/version')return json({version:mock.version,schemaVersion:mock.schema});
  if(p==='/api/auth/status')return json(mock.auth?{authenticated:true,setupRequired:false,csrfToken:'fixture',user:{id:mock.auth,name:'Fixture '+mock.auth,role:mock.auth},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000}:{authenticated:false,setupRequired:false});
  if(!mock.auth)return json({error:'Sign in'},401);
  if(p==='/api/state')return json({...baseState,update:{available:mock.state.offer?.update?.version||null}});
  if(p==='/api/auth/activity')return json({});
  if(p==='/api/auth/reauth')return json(mock.reauth===200?{reauthenticated:true}:{error:'Invalid password or code.'},mock.reauth);
  if(p==='/api/updates/consent'&&m==='POST')return mock.consent.status===200?json((mock.state=updateState({consent:{checkEnabled:JSON.parse(req.postData()).checkEnabled,decidedBy:null,decidedAt:iso()}}),mock.state)):json({error:'Another administrator already answered.',code:'ALREADY_DECIDED'},409);
  if(p==='/api/updates/settings'&&m==='PATCH'){mock.state={...mock.state,consent:{...mock.state.consent,checkEnabled:JSON.parse(req.postData()).checkEnabled}};return json(mock.state)}
  if(p==='/api/updates/check'&&m==='POST')return json(mock.state);
  if(p==='/api/updates'&&m==='GET')return json(mock.state);
  if(p==='/api/updates/status')return json({requestId:'req-1',from:'v2.2.0',to:'v2.3.0',state:'running',stale:true});
  if(p.startsWith('/api/updates/releases/'))return json(meta);
  if(p==='/api/updates/history')return json({items:[{id:'r1',version:'v2.2.0',at:iso(),outcome:'succeeded',source:'in-app'},{id:null,version:'v2.1.0',at:iso(),outcome:'succeeded',source:'cli'},{id:'r0',version:'v2.1.5',at:iso(),outcome:'rolled_back',source:'in-app'}],next:null});
  if(p==='/api/updates/whats-new')return json(mock.whatsNew);
  if(p==='/api/updates/whats-new/seen')return route.fulfill({status:204});
  if(p==='/api/updates/requests'&&m==='POST')return json(mock.request.body,mock.request.status);
  if(/\/acknowledge$/.test(p))return json(mock.state);
  return json({});
 };
}
let browser;const errors=[];
async function open(mock,{width=1440,height=1000,hash='',colorScheme}={}){
 const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',colorScheme});
 const page=await context.newPage();
 page.on('pageerror',error=>errors.push(error.message));
 await context.route('**/api/**',handler(mock));
 await page.goto(base+'/'+hash);
 return {context,page};
}
const heightOf=async locator=>Math.round((await locator.boundingBox()).height);
async function noWrap(page,scope){
 const bad=await page.evaluate(scope=>[...document.querySelectorAll(scope+' button:not(.icon):not([role=tab]):not(.text):not(.switch), '+scope+' a.button')].filter(el=>el.offsetParent!==null).filter(el=>el.getBoundingClientRect().height>46||el.scrollWidth>el.clientWidth+1).map(el=>el.textContent.trim()),scope);
 assert.deepEqual(bad,[],'Button labels never wrap or overflow: '+scope);
}
try{
 browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true}).catch(()=>chromium.launch({headless:true}));

 // 1. Overview, tabs, cards, switch, notes, history.
 {
  const mock=newMock(),{context,page}=await open(mock);
  const nav=page.getByRole('navigation').getByRole('button',{name:'Update Center, 1 update available'});
  await nav.waitFor();
  await nav.click();
  await page.getByRole('heading',{name:'Update Center',level:1}).waitFor();
  assert.equal(await page.evaluate(()=>location.hash),'#/update-center');
  await page.getByRole('tab').nth(1).waitFor();
  assert.deepEqual(await page.getByRole('tab').allTextContents(),['Overview','What\u2019s new'],'2.3.1: tabs are Overview and What is new only');
  await page.getByRole('heading',{name:'DockNest 2.3.0'}).waitFor();
  await page.getByRole('heading',{name:'Before you update'}).waitFor();
  await page.getByText('Yes, schema v4 to v5',{exact:true}).waitFor();
  await page.getByText('Estimate: about 4 min (based on your last update)',{exact:true}).waitFor();
  await page.getByText('Connected \u00b7 v1.4').waitFor();
  assert.equal(await page.getByRole('link',{name:/3 new features/}).count(),1);
  assert.equal(await page.locator('.dn-chip').count(),0,'No highlight chips');
  const update=page.getByRole('button',{name:'Update now'});
  assert.equal(await heightOf(update),40);
  const cards=await page.locator('.uc-split>.card').evaluateAll(els=>els.map(el=>Math.round(el.getBoundingClientRect().height)));
  assert.equal(cards[0],cards[1],'Sibling cards mirror each other');
  // 2.3.1: Automatic checks has only the switch (no footer row); the Host updater footer stays.
  assert.equal(await page.locator('.uc-split .card-footer').count(),1,'Only the Host updater card has a footer');
  assert.equal(await page.getByRole('button',{name:/^Turn (on|off)$/}).count(),0,'No Turn on/off link');
  await noWrap(page,'.uc-page');
  const toggle=page.getByRole('switch',{name:'Automatic checks'});
  assert.equal(await toggle.getAttribute('aria-checked'),'true');
  // A pill switch (36x20 track, 16px thumb) inside a 44px hit area, untouched by the global button box styles.
  const sw=await toggle.evaluate(el=>{const r=el.getBoundingClientRect(),t=getComputedStyle(el,'::before'),k=getComputedStyle(el,'::after'),s=getComputedStyle(el);return {box:[Math.round(r.width),Math.round(r.height)],track:[t.width,t.height,t.borderTopLeftRadius],thumb:[k.width,k.height],fill:s.backgroundColor}});
  assert.deepEqual(sw.box,[44,44],'44px touch target');
  assert.deepEqual(sw.track,['36px','20px','9999px'],'pill track'); assert.deepEqual(sw.thumb,['16px','16px'],'16px thumb');
  assert.equal(sw.fill,'rgba(0, 0, 0, 0)','the hit area itself is not filled');
  await toggle.click();
  await page.locator('[role=switch][aria-checked=false]').waitFor();
  assert.equal(await page.getByRole('button',{name:'Check now'}).count(),0,'No Check now while checks are off');
  assert.ok(mock.calls.includes('PATCH /api/updates/settings'));
  await page.getByRole('tab',{name:'What\u2019s new'}).click();
  await page.getByText('Verified release notes. Checked with the release signature.').waitFor();
  assert.equal(await page.evaluate(()=>location.hash),'#/update-center/whats-new');
  const rendered=page.locator('.notes');
  assert.equal(await rendered.locator('img,script,iframe').count(),0);
  assert.ok((await rendered.innerHTML()).includes('&lt;img src=x onerror=alert(1)&gt;'),'Raw HTML shows as inert text');
  const hrefs=await rendered.locator('a').evaluateAll(els=>els.map(el=>el.href));
  assert.deepEqual(hrefs,['https://github.com/DahanItamar/DockNest/blob/v2.3.0/docs/upgrading.md','https://github.com/DahanItamar/DockNest/pull/1']);
  assert.ok(!(await rendered.textContent()).includes('highlights'),'Front matter is stripped');
  // 2.3.1: History is a closed-by-default disclosure at the bottom of the Overview; old #/update-center/history links open the Overview.
  await page.getByRole('tab',{name:'Overview'}).click();
  const recent=page.getByRole('button',{name:'Recent updates',exact:true});
  assert.equal(await recent.getAttribute('aria-expanded'),'false');assert.equal(await page.locator('.uc-recent-list').count(),0);
  await recent.click();
  assert.equal(await recent.getAttribute('aria-expanded'),'true');
  await page.locator('.uc-recent-list li').first().waitFor();
  assert.equal(await page.locator('.uc-recent-list li').count(),3);assert.equal(await page.locator('table.hist').count(),0,'No history table');
  await page.getByText('Rolled back',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Open GitHub',exact:true}).count(),1,'Report entry on the rolled-back row only');
  assert.equal(await page.getByRole('link',{name:/Rolling back/}).count()>=1,true);
  for(const width of [320,402]){await page.setViewportSize({width,height:874});assert.equal(await page.evaluate(()=>[...document.querySelectorAll('.uc-recent-list *')].every(el=>el.scrollWidth<=el.clientWidth+1)&&document.documentElement.scrollWidth<=innerWidth+1),true,'Recent updates not truncated at '+width);}
  await page.setViewportSize({width:1280,height:900});
  await page.evaluate(()=>{location.hash='#/update-center/history'});
  await page.getByRole('tab',{name:'Overview'}).waitFor();assert.equal(await page.getByRole('tab',{name:'Overview'}).getAttribute('aria-selected'),'true');
  await context.close();
 }

 // 2. Setup card: live detection without a reload, and the not-responding state.
 {
  const mock=newMock({state:updateState({updater:{present:false,version:null,supported:false,selfUpdateFailed:false,blocked:false,status:'not-installed',lastHeartbeatAt:null},offer:{update:{version:'v2.3.0'},cli:null,blocked:null}})}),{context,page}=await open(mock,{hash:'#/update-center'});
  await page.getByRole('heading',{name:'Set up the host updater'}).waitFor();
  await page.getByText('sudo scripts/install-updater.sh',{exact:true}).waitFor();
  await page.getByText('Waiting for the updater\u2026').waitFor();
  assert.equal(await page.getByRole('button',{name:'Update now'}).count(),0);
  assert.equal(await page.locator('details.advanced').getAttribute('open'),null,'Command line disclosure is closed by default');
  mock.state=updateState();
  await page.getByText('Connected. The updater is ready, no reload needed.').waitFor({timeout:8000});
  await page.getByRole('button',{name:'Update now'}).waitFor();
  mock.state=updateState({updater:{present:true,version:'1.4',supported:true,status:'not-responding',lastHeartbeatAt:new Date(Date.now()-3600e3).toISOString()}});
  await page.getByRole('button',{name:'Check connection'}).click();
  await page.getByText('The host updater is not responding',{exact:true}).first().waitFor();
  await page.getByText(/Not responding \u00b7 last seen/).waitFor();
  assert.equal(await page.getByRole('button',{name:'Update now'}).getAttribute('aria-disabled'),'true');
  await page.getByText('sudo scripts/install-updater.sh --repair',{exact:true}).waitFor();
  await context.close();
 }

 // 3. Confirm dialog: re-authentication errors keep the values, then the lock view takes over.
 {
  const mock=newMock(),{context,page}=await open(mock,{hash:'#/update-center'});
  await page.getByRole('button',{name:'Update now'}).click();
  const dialog=page.getByRole('dialog',{name:'Start the update to DockNest v2.3.0?'});
  await dialog.waitFor();
  assert.ok((await dialog.textContent()).includes('If the new version fails before DockNest changes its own data, DockNest returns to v2.2.0 by itself. If it fails after that, DockNest stops and a server administrator has to finish the rollback. Backups stay paused until then.'));
  assert.ok((await dialog.textContent()).includes('a backup of s1 is running'));
  const start=dialog.getByRole('button',{name:'Start update'});
  assert.equal(await start.getAttribute('aria-disabled'),'true');
  await dialog.getByText('Enter your password and a 6-digit code').waitFor();
  await dialog.getByLabel('Password').fill('wrong-password');await dialog.getByLabel('Authenticator code').fill('123456');
  mock.reauth=401;await start.click();
  await dialog.getByRole('alert').getByText('The password or code was not accepted. Check them and try again.').waitFor();
  assert.equal(await dialog.getByLabel('Password').inputValue(),'wrong-password','Values are kept');
  assert.equal(await dialog.getByLabel('Password').getAttribute('aria-invalid'),'true');
  assert.equal(await dialog.getByLabel('Authenticator code').getAttribute('aria-describedby'),'uc-confirm-error');
  assert.equal(mock.calls.filter(c=>c==='POST /api/updates/requests').length,0,'No request without re-authentication');
  mock.reauth=200;mock.request={status:409,body:{error:'raw',code:'UPDATER_LOW_DISK'}};await start.click();
  await dialog.getByRole('alert').getByText(/too little free disk space/).waitFor();
  assert.equal(await dialog.getByLabel('Password').getAttribute('aria-invalid'),null);
  mock.request={status:202,body:{requestId:'req-1'}};mock.locked=true;mock.progress=running;
  await start.click();
  await page.getByRole('heading',{name:'Updating DockNest to v2.3.0',level:1}).waitFor();
  assert.deepEqual(JSON.parse(mock.bodies['POST /api/updates/requests']),{version:'v2.3.0'});
  assert.equal(await page.locator('.berry-sidebar').count(),0,'The lock view replaces the whole app');
  await context.close();
 }

 // Blocked hero: its Recent updates link opens the disclosure (no dead control), which also starts open.
 {
  const mock=newMock({state:updateState({state:'updater-blocked',offer:{update:null,cli:null,blocked:{code:'needs-host-ack',message:'Blocked fixture'}}})}),{context,page}=await open(mock,{hash:'#/update-center'});
  await page.getByRole('heading',{name:'Updates are blocked'}).waitFor();
  const toggle=page.locator('#uc-recent-toggle');
  assert.equal(await toggle.getAttribute('aria-expanded'),'true','Recent updates starts open while updates are blocked');
  await page.locator('.uc-hero-state').getByRole('button',{name:'Recent updates'}).click();
  assert.equal(await toggle.getAttribute('aria-expanded'),'true');
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'uc-recent-toggle','Focus moves to Recent updates');
  await context.close();
 }

 // 4. Consent: asked once, Escape records nothing, ALREADY_DECIDED, no dialog afterwards.
 {
  const mock=newMock({state:updateState({state:'consent-pending',consent:{checkEnabled:null,decidedBy:null,decidedAt:null},check:null,offer:{update:null,cli:null,blocked:null}})}),{context,page}=await open(mock);
  const dialog=page.getByRole('dialog',{name:'Check GitHub daily for new versions?'});
  await dialog.waitFor();
  assert.ok(!(await dialog.textContent()).match(/IP address/i),'No IP wording');
  assert.equal(await heightOf(dialog.getByRole('button',{name:'No, keep checks off'})),40);
  assert.equal(await heightOf(dialog.getByRole('button',{name:'Yes, check daily'})),40);
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'hidden'});
  assert.equal(mock.calls.filter(c=>c.includes('/api/updates/consent')).length,0,'Escape records nothing');
  await page.reload();
  await dialog.waitFor();
  mock.consent={status:409};
  await dialog.getByRole('button',{name:'Yes, check daily'}).click();
  await page.getByRole('dialog',{name:'Update checks are already set'}).getByText(/Another administrator already chose: daily checks/).waitFor();
  await page.getByRole('button',{name:'Close',exact:true}).click();
  mock.consent={status:200};mock.state=updateState();
  await page.reload();
  await page.getByRole('navigation').waitFor();
  assert.equal(await page.getByRole('dialog').count(),0,'Asked once');
  await context.close();
 }
 {
  const mock=newMock({state:updateState({state:'consent-pending',consent:{checkEnabled:null,decidedBy:null,decidedAt:null},check:null,offer:{update:null,cli:null,blocked:null}})}),{context,page}=await open(mock);
  await page.getByRole('dialog',{name:'Check GitHub daily for new versions?'}).getByRole('button',{name:'Yes, check daily'}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
  assert.deepEqual(JSON.parse(mock.bodies['POST /api/updates/consent']),{checkEnabled:true});
  assert.equal(mock.calls.filter(c=>c==='POST /api/updates/consent').length,1);
  await context.close();
 }

 // 5. The lock view replaces every route, for every role and signed out, on progress or on any 423.
 for(const auth of ['admin','operator',null]){
  for(const hash of ['','#/setup','#/update-center','#/enroll/'+'A'.repeat(43)]){
   const mock=newMock({auth,locked:true,progress:running}),{context,page}=await open(mock,{hash});
   await page.getByRole('heading',{name:'Updating DockNest to v2.3.0',level:1}).waitFor();
   assert.equal(await page.locator('.berry-sidebar,.auth-card,main#content').count(),0,`Only the lock view: ${auth} ${hash}`);
   assert.equal(await page.locator('.dn-stage[aria-current=step] .dn-stage-name').textContent(),'Install');
   assert.equal(await page.locator('h1').evaluate(el=>document.activeElement===el),true,'The heading takes focus');
   assert.match(await page.title(),/^Updating DockNest to v2\.3\.0/);
   await page.getByText(/Elapsed \d\d:\d\d/).waitFor();
   await context.close();
  }
 }
 {
  // Progress idle but an API call returns 423: the lock view appears and holds for two polls before it gives up.
  const mock=newMock({locked:true,progress:idle}),{context,page}=await open(mock);
  await page.getByRole('heading',{name:/Updating DockNest/,level:1}).waitFor();
  mock.locked=false;
  await page.getByRole('navigation').waitFor({timeout:8000});
  await context.close();
 }
 {
  // API unreachable on load (502 from the proxy during the restart): Reconnecting, then back to the running view.
  let down=true;
  const mock=newMock({locked:true,progress:running});
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  const inner=handler(mock);
  await context.route('**/api/**',route=>{if(down&&new URL(route.request().url()).pathname==='/api/updates/progress')return route.fulfill({status:503,body:'<html>bad gateway</html>'});return inner(route)});
  await page.goto(base+'/');
  await page.getByText('Reconnecting to DockNest\u2026').waitFor();
  down=false;
  await page.getByText('DockNest is back. Continuing the update.').waitFor({timeout:15000});
  await context.close();
 }

 // 6. Result screens.
 {
  const mock=newMock({locked:true,progress:running}),{context,page}=await open(mock);
  await page.getByRole('heading',{name:'Updating DockNest to v2.3.0'}).waitFor();
  mock.locked=false;mock.progress={...running,state:'rolled_back',active:false,phase:'release'};
  await page.getByRole('heading',{name:'The update did not complete',level:1}).waitFor({timeout:6000});
  await page.getByText('The update failed and DockNest returned to v2.2.0 automatically. No data was lost.').waitFor();
  const back=page.getByRole('button',{name:'Back to DockNest'}),retry=page.getByRole('button',{name:'Retry update'});
  assert.equal(await heightOf(back),await heightOf(retry),'Identical buttons per row');
  await noWrap(page,'.progress-view');
  assert.equal(await retry.getAttribute('aria-disabled'),null);
  assert.equal(await page.getByRole('button',{name:/Open GitHub/}).count(),0,'Failure reports are a 2.3.0 feature');
  await retry.click();
  await page.getByRole('dialog',{name:'Start the update to DockNest v2.3.0?'}).waitFor();
  assert.equal(mock.calls.includes('POST /api/updates/requests'),false);
  await context.close();
 }
 {
  // Retry stays disabled with a visible reason when the updater blocks the target.
  const mock=newMock({locked:true,progress:running,state:updateState({state:'updater-blocked',offer:{update:null,cli:null,blocked:{code:'needs-host-ack',message:'blocked'}}})}),{context,page}=await open(mock);
  await page.getByRole('heading',{name:'Updating DockNest to v2.3.0'}).waitFor();
  mock.locked=false;mock.progress={...running,state:'rolled_back',active:false,phase:'release'};
  const retry=page.getByRole('button',{name:'Retry update'});
  await retry.waitFor({timeout:6000});
  assert.equal(await retry.getAttribute('aria-disabled'),'true');
  await page.getByText(/blocked until a server operator confirms/).waitFor();
  await context.close();
 }
 {
  const mock=newMock({locked:true,progress:running}),{context,page}=await open(mock);
  await page.getByRole('heading',{name:'Updating DockNest to v2.3.0'}).waitFor();
  mock.locked=false;mock.version='2.3.0';mock.schema=5;mock.progress={...running,state:'succeeded',active:false,phase:'cleanup'};
  await page.getByRole('heading',{name:'DockNest is running v2.3.0',level:1}).waitFor({timeout:6000});
  await page.getByText('Health checks passed').waitFor();
  await page.getByText('Settings and data kept (schema v4 to v5)').waitFor();
  mock.progress=idle;mock.whatsNew={show:true,version:'v2.3.0',markdown:'# Notes\n\n- A **safe** note.\n'};
  await page.getByRole('button',{name:'Reload DockNest'}).click();
  await page.getByText('DockNest updated to v2.3.0').waitFor();
  await page.getByRole('button',{name:'What\u2019s new'}).click();
  const dialog=page.getByRole('dialog',{name:'What\u2019s new in DockNest v2.3.0'});
  await dialog.waitFor();
  await dialog.getByRole('button',{name:'Got it'}).click();
  await dialog.waitFor({state:'hidden'});
  assert.ok(mock.calls.includes('POST /api/updates/whats-new/seen'));
  await page.reload();
  await page.getByRole('navigation').waitFor();
  assert.equal(await page.getByText('DockNest updated to v2.3.0').count(),0,'The toast shows once');
  await context.close();
 }
 {
  const mock=newMock({locked:true,progress:{...running,state:'needs_action',phase:'health'},state:updateState({state:'updater-blocked'})}),{context,page}=await open(mock);
  await page.getByRole('heading',{name:'The update needs manual action',level:1}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Back to DockNest'}).count(),0,'Locked: no way back');
  await page.getByText('sudo scripts/install-updater.sh --status',{exact:true}).waitFor();
  await page.getByText('DockNest unlocks automatically when the host confirms.').waitFor();
  assert.ok(!(await page.locator('.progress-card').textContent()).match(/rollback hint|git checkout/i),'No rollback hint on the public view');
  assert.equal(await page.getByRole('alert').count()>0,true);
  mock.locked=false;mock.progress={...idle,state:'resolved'};
  await page.getByRole('navigation').waitFor({timeout:6000});
  await context.close();
 }
 {
  const mock=newMock({locked:true,progress:{...running,stale:true}}),{context,page}=await open(mock);
  await page.getByText(/The updater has not reported progress since/).waitFor();
  await page.getByText('docker compose ps',{exact:true}).waitFor();
  mock.progress={...running,state:'lost',active:false,stale:false};
  const close=page.getByRole('button',{name:'Close this record'});
  await close.waitFor();
  mock.locked=true;
  await close.click();
  assert.ok(mock.calls.includes('POST /api/updates/requests/req-1/acknowledge'));
  await context.close();
 }

 // 7. Report a bug: allow-listed fields only, new tab without opener or referrer, nothing sent to DockNest's server.
 for(const auth of ['admin','operator']){
  const mock=newMock({auth}),{context,page}=await open(mock);
  const github=[];
  await context.route('https://github.com/**',route=>{github.push({url:route.request().url(),referer:route.request().headers().referer});return route.fulfill({status:200,contentType:'text/html',body:'<title>GitHub</title>'})});
  await page.getByRole('button',{name:'Open account preferences'}).click();
  const settings=page.getByRole('dialog',{name:'Settings'});
  await settings.getByRole('button',{name:/Open GitHub/}).click();
  const dialog=page.getByRole('dialog',{name:'Review what will be shared'});
  await dialog.waitFor();
  await dialog.getByText('This issue will be public on GitHub and linked to your GitHub account.',{exact:false}).waitFor();
  const link=dialog.getByRole('link',{name:/Open GitHub/});
  assert.equal(await link.getAttribute('target'),'_blank');assert.equal(await link.getAttribute('rel'),'noopener noreferrer');assert.equal(await link.getAttribute('referrerpolicy'),'no-referrer');
  const url=new URL(await link.getAttribute('href'));
  assert.equal(url.origin+url.pathname,'https://github.com/DahanItamar/DockNest/issues/new');
  const expected=auth==='admin'?['install_mode','template','title','version']:['template','title','version'];
  assert.deepEqual([...url.searchParams.keys()].sort(),expected);
  assert.equal(url.searchParams.get('template'),'bug-report.yml');assert.equal(url.searchParams.get('version'),'v2.2.0');
  if(auth==='admin')assert.equal(url.searchParams.get('install_mode'),'source');
  const before=mock.calls.length,popup=context.waitForEvent('page');
  await link.click();
  const tab=await popup;await tab.waitForLoadState();
  assert.equal(github.length,1);assert.equal(github[0].url,url.href);assert.equal(github[0].referer,undefined,'No referrer is sent');
  assert.equal(await tab.evaluate(()=>window.opener),null,'No opener');
  assert.deepEqual(mock.calls.slice(before).filter(c=>/report|issue/i.test(c)),[],'Nothing is posted to DockNest');
  await context.close();
 }

 // 8. Mobile 390 px, light and dark: no horizontal scroll, stacked full-width actions, one row of tabs.
 for(const width of [390,320]){
  const mock=newMock(),{context,page}=await open(mock,{width,height:844,hash:'#/update-center'});
  await page.getByRole('heading',{name:'DockNest 2.3.0'}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No horizontal scroll '+width);
  const tabs=await page.getByRole('tab').evaluateAll(els=>els.map(el=>Math.round(el.getBoundingClientRect().y)));
  assert.equal(new Set(tabs).size,1,'Tabs stay in one row');
  const [a]=await page.locator('.uc-hero-row>button').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect(),p=el.parentElement.getBoundingClientRect();return [Math.round(r.width),Math.round(p.width),Math.round(r.height)]}));
  assert.equal(a[0],a[1],'Update action fills the card width');assert.equal(a[2],44);
  await noWrap(page,'.uc-page');
  await page.getByRole('button',{name:'Update now'}).click();
  const dialog=page.getByRole('dialog',{name:'Start the update to DockNest v2.3.0?'});
  await dialog.waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await noWrap(page,'dialog');
  await context.close();
 }
 {
  const mock=newMock({locked:true,progress:{...running,state:'rolled_back',active:false,phase:'release'}}),{context,page}=await open(mock,{width:390,height:844,colorScheme:'dark'});
  await page.getByRole('heading',{name:'The update did not complete'}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const widths=await page.locator('.progress-actions button').evaluateAll(els=>els.map(el=>Math.round(el.getBoundingClientRect().width)));
  assert.equal(new Set(widths).size,1,'Rows stack full width at 480 px and below');
  await noWrap(page,'.progress-view');
  await page.getByRole('button',{name:'Switch to dark theme'}).click();
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.progress-view')).backgroundColor),'rgb(16, 23, 36)','Dark tokens apply to the lock view');
  await context.close();
 }
 assert.deepEqual(errors,[]);
 console.log('Update Center UI passed against a mocked API: overview, tabs, setup card, confirm re-authentication errors, consent once, lock view on every route and role (progress and 423), result screens, Report a bug URL, 390 and 320 px. No real update, rollback or restart was tested.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
