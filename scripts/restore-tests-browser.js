import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

// Restore tests UI (docs/restore-tests.md) against the mocked API contract: overview columns and consistency, the
// failed-test alert, test jobs and their timeline, the Restore tests dialog (switch, live-server gate, presets and
// custom values), operators, phone 390, both themes and reduced motion. Run against a dev server serving this
// worktree: TEST_BASE_URL=http://127.0.0.1:5311. SHOTS_DIR also writes screenshots.
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5173',origin=new URL(base).origin,shots=process.env.SHOTS_DIR;
if(shots)await mkdir(shots,{recursive:true});
const NOW=Date.now(),ago=hours=>new Date(NOW-hours*3600000).toISOString();
const REASON='The database didn\u2019t start in 30 minutes.';
const servers=[
 {id:'fr',name:'Frankfurt-1',host:'fra.example.invalid',port:22,username:'root',status:'connected',capabilities:{freeBytes:84*1024**3,cpus:8}},
 {id:'ash',name:'Ashburn-1',host:'iad.example.invalid',port:22,username:'root',status:'connected',capabilities:{freeBytes:41*1024**3,cpus:2}},
 {id:'nas',name:'Home NAS',host:'nas.example.invalid',port:22,username:'root',status:'connected',capabilities:{freeBytes:3*1024**3,cpus:4}}
];
const sites=[
 {id:'s1',name:'cinderbean.com',serverId:'fr',config:{containers:['cinderbean-web','cinderbean-db'],domains:['cinderbean.com']}},
 {id:'s2',name:'pawmeadow.com',serverId:'ash',config:{containers:['pawmeadow-web','pawmeadow-db']}},
 {id:'s3',name:'northgrid.com',serverId:'fr',config:{containers:['northgrid-web']}},
 {id:'s4',name:'brightsmile.com',serverId:'ash',config:{containers:['brightsmile-web']}}
];
const backups=sites.flatMap((site,i)=>[0,1,2].map(n=>({id:`bk-${site.id}-${n}`,siteId:site.id,size:(2.1+n*0.1)*1024**3,capturedAt:ago(10+n*24+i),pinned:n===0&&i===0,verified:true,
 restoreTest:{status:site.id==='s4'?'not-tested':n===2?'not-tested':'passed',testId:null,testedAt:null}})));
const policies=sites.map(site=>({siteId:site.id,enabled:true,schedule:'0 2 * * *',timezone:'UTC',retention:7}));
const STEP_ORDER=['check_space','copy_backup','restore_copy','start_containers','check_health','clean_up'];
const LABEL={check_space:'Check space',copy_backup:'Copy backup',restore_copy:'Restore copy',start_containers:'Start containers',check_health:'Check health',clean_up:'Clean up'};
const settings=(over={})=>({enabled:false,cadence:'weekly',serverId:null,allowLiveServer:false,allowInternet:false,timeLimitMinutes:30,memoryMb:1024,cpus:1,probe:null,nextDueAt:null,skipReason:null,...over});
const last=(id,result,hours,over={})=>({id,result,finishedAt:ago(hours),restoreSeconds:84,internet:false,failedStep:null,reason:null,serverName:'Ashburn-1',...over});
const detailFor=(id,siteId,result,failedAt)=>({id,siteId,backupId:'bk-'+siteId+'-0',backupCapturedAt:ago(30),serverId:'ash',serverName:'Ashburn-1',trigger:'manual',state:'finished',result,failedStep:failedAt||null,reason:failedAt?REASON:null,
 restoreSeconds:84,totalSeconds:1900,createdAt:ago(26),startedAt:ago(26),finishedAt:ago(25.5),deadlineAt:ago(25),cancelRequested:false,cleanup:'done',limits:{memoryMb:1024,cpus:1,timeLimitMinutes:30,internet:false},checks:[],
 steps:STEP_ORDER.map((step,i)=>{const at=STEP_ORDER.indexOf(failedAt);const state=failedAt?(i<at?'done':i===at?'failed':step==='clean_up'?'done':'skipped'):'done';
  return {step,label:LABEL[step],state,startedAt:new Date(NOW-26*3600000+i*60000).toISOString(),finishedAt:new Date(NOW-26*3600000+i*60000+(i===at?1800000:[2,60,120,14,20,8][i]*1000)).toISOString(),detail:step===failedAt?REASON:step==='clean_up'?'Test copy removed':null}})});
let mock;
function freshMock({failed=false}={}){
 mock={needReverify:false,reverified:false,reauths:0,saves:[],runs:[],cancels:[],cleanups:[],runError:null,saveError:null,cardFail:false,
  cards:{
   s1:{settings:settings({enabled:true,cadence:'daily',serverId:'ash'}),last:failed?last('t1','failed',30,{failedStep:'check_health',reason:REASON}):last('t1','passed',48),active:null,items:[],next:null},
   s2:{settings:settings({enabled:true,serverId:'nas'}),last:last('t2','passed',24*5),active:null,items:[],next:null},
   s3:{settings:settings({enabled:true,serverId:'ash'}),last:last('t3','couldnt_run',24*3,{reason:'The test server ran low on disk.'}),active:null,items:[],next:null},
   s4:{settings:settings(),last:null,active:null,items:[],next:null}
  },
  details:{t1:detailFor('t1','s1',failed?'failed':'passed',failed?'check_health':null),t2:detailFor('t2','s2','passed'),running:{...detailFor('t9','s4','passed'),id:'t9',state:'running',result:null,finishedAt:null,steps:STEP_ORDER.map((step,i)=>({step,label:LABEL[step],state:i<2?'done':i===2?'running':'pending',startedAt:i<3?ago(0.1):null,finishedAt:i<2?ago(0.05):null,detail:null}))}},
  jobs:[
   {id:'job-t1',siteId:'s1',type:'restore-test',status:failed?'failed':'completed',stage:failed?'check_health':'clean_up',createdAt:ago(26),details:{testId:'t1'}},
   {id:'job-t2',siteId:'s2',type:'restore-test',status:'completed',stage:'clean_up',createdAt:ago(120),details:{testId:'t2'}},
   {id:'job-b1',siteId:'s3',type:'backup',status:'completed',stage:'completed',createdAt:ago(30)}
  ]};
}
freshMock();
const state=()=>({servers,sites,jobs:mock.jobs,backups,policies,audit:[],storage:{used:1e9,total:1e12},worker:{online:true}});
const json=(route,body,status=200)=>route.fulfill({status,json:body});

let browser;const errors=[];
async function open({role='admin',width=1440,height=900,scheme='light',motion=true,page:start='Overview'}={}){
 const context=await browser.newContext({viewport:{width,height},reducedMotion:motion?'no-preference':'reduce',colorScheme:scheme});
 await context.addInitScript(s=>{try{localStorage.setItem('docknest-theme',s)}catch{}},scheme);
 const page=await context.newPage(),offOrigin=[];
 page.on('pageerror',e=>errors.push(e.message));
 context.on('request',req=>{const u=new URL(req.url());if(!['data:','blob:'].includes(u.protocol)&&u.origin!==origin)offOrigin.push(u.href)});
 await page.route('**/api/**',route=>{
  const req=route.request(),url=new URL(req.url()),endpoint=url.pathname,method=req.method(),body=method==='GET'?null:req.postDataJSON?.()||{};
  const auth={authenticated:true,setupRequired:false,csrfToken:'fixture',user:{id:'u1',name:'Fixture user',role},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000};
  let m;
  if(endpoint==='/api/auth/reauth'){if(body.password==='pw'&&body.code==='123456'){mock.reverified=true;mock.reauths++;return json(route,{ok:true})}return json(route,{error:'No'},401)}
  if((m=endpoint.match(/^\/api\/sites\/([^/]+)\/restore-tests\/settings$/))&&method==='PUT'){
   if(role!=='admin')return json(route,{error:'Only administrators can change restore tests.'},403);
   if(mock.needReverify&&!mock.reverified&&(body.allowInternet||body.allowLiveServer))return json(route,{error:'raw',code:'REVERIFY_REQUIRED'},403);
   if(mock.saveError)return json(route,{error:'raw',code:mock.saveError},mock.saveError==='REVERIFY_REQUIRED'?403:409);
   mock.saves.push({siteId:m[1],body});mock.cards[m[1]].settings={...mock.cards[m[1]].settings,...body};return json(route,mock.cards[m[1]].settings);
  }
  if((m=endpoint.match(/^\/api\/sites\/([^/]+)\/restore-tests$/))){
   if(method==='GET')return mock.cardFail?json(route,{error:'Not found'},404):json(route,mock.cards[m[1]]||{settings:settings(),last:null,active:null,items:[],next:null});
   if(mock.runError)return json(route,{error:mock.runError.message,code:mock.runError.code},mock.runError.code==='TOO_MANY_TESTS'?429:409);
   mock.runs.push({siteId:m[1],body});mock.cards[m[1]].active={id:'t9',state:'queued',step:'check_space'};
   mock.jobs.unshift({id:'job-t9',siteId:m[1],type:'restore-test',status:'test_queued',stage:'check_space',createdAt:new Date().toISOString(),details:{testId:'t9'}});
   return json(route,{id:'t9',jobId:'job-t9'},202);
  }
  if((m=endpoint.match(/^\/api\/restore-tests\/([^/]+)\/(cancel|cleanup)$/))){(m[2]==='cancel'?mock.cancels:mock.cleanups).push(m[1]);if(m[2]==='cancel')mock.details.running.cancelRequested=true;return json(route,{ok:true},202);}
  if((m=endpoint.match(/^\/api\/restore-tests\/([^/]+)$/)))return mock.details[m[1]==='t9'?'running':m[1]]?json(route,mock.details[m[1]==='t9'?'running':m[1]]):json(route,{error:'Not found'},404);
  return json(route,endpoint==='/api/auth/status'?auth:endpoint==='/api/state'?state():endpoint==='/api/version'?{version:'0.0.0'}:endpoint==='/api/updates/progress'?{active:false,state:'idle'}:{});
 });
 await page.goto(base+'/');
 await page.locator('.berry-sidebar').waitFor();
 if(width<900)await page.getByRole('button',{name:'Open navigation'}).click();
 if(start!=='Overview')await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:start,exact:true}).click();
 else if(width<900)await page.getByRole('button',{name:'Open navigation'}).click();
 return {context,page,offOrigin};
}
const noOverflow=async(page,label)=>{const o=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}));assert.ok(o.sw<=o.cw,label+': horizontal overflow '+o.sw+' > '+o.cw)};
const shot=async(page,name)=>{if(shots){await page.waitForTimeout(700);await page.screenshot({path:path.join(shots,name+'.png')})}};
const row=(page,name)=>page.locator('.dash-site',{hasText:name});
const dialog=page=>page.getByRole('dialog');
const css=(locator,prop)=>locator.evaluate((el,p)=>getComputedStyle(el)[p],prop);

async function overview(scheme,width){
 freshMock();
 const {context,page,offOrigin}=await open({scheme,width});
 await page.locator('.dash-site').first().waitFor();
 await page.waitForFunction(()=>document.querySelector('.dash-site-latest .status'));
 const head=await page.locator('.dash-sites .dash-panel-head').innerText();
 assert.equal(head.replace(/\s+/g,' ').trim(),'Sites at a glance Manage sites','no eyebrow, no count badge');
 assert.equal(await page.locator('.dash-sites .dash-count,.dash-sites .dash-eyebrow').count(),0);
 assert.equal((await page.locator('.dash-site-columns span').allTextContents()).filter(Boolean).join(' '),'Site / server Last test Schedule');
 const latest=await page.locator('.dash-site-latest').allTextContents();
 assert.deepEqual(latest.map(x=>x.trim()),['Passed · 2 days ago','Passed · 5 days ago','Couldn\u2019t run · 3 days ago','Not tested']);
 assert.deepEqual((await page.locator('.dash-site-schedule').allTextContents()).map(x=>x.trim()),Array(4).fill('Daily at 02:00'));
 const summaries=(await page.locator('.dash-site > summary').allTextContents()).join(' ');
 assert.doesNotMatch(summaries,/recovery points?|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2}/i,'no date and no recovery-point count in the summary');
 assert.equal(await page.locator('.dash-site-schedule small,.dash-site-latest small,.dash-site-latest b').count(),0,'summary has nothing but the status and the schedule');
 assert.equal(await page.locator('.dash-sites .dash-summary').count(),1,'the intro strip stays on a healthy overview');
 // Consistency: the summary equals the card's latest test, for every site
 for(const site of sites){
  const c=mock.cards[site.id],expected=c.last?{passed:'Passed',failed:'Failed',couldnt_run:'Couldn\u2019t run'}[c.last.result]:'Not tested';
  assert.match((await row(page,site.name).locator('.dash-site-latest').textContent()).trim(),new RegExp('^'+expected),site.name);
 }
 // Opened site: Run test link and a tested status per backup
 await row(page,'cinderbean.com').locator('summary').click();
 const open1=row(page,'cinderbean.com');
 await open1.getByRole('button',{name:'Run test'}).waitFor();
 const marks=await open1.locator('.dash-backup .rt-meta .status').allTextContents();
 assert.deepEqual(marks.map(x=>x.trim()),['Passed','Passed','Not tested']);
 await shot(page,`overview-${width}-${scheme}`);
 await noOverflow(page,'overview '+width);
 // Run test posts once, shows the notice, and the row turns into "Testing now"
 await open1.getByRole('button',{name:'Run test'}).click();
 await page.getByRole('status').filter({hasText:'Test started.'}).waitFor();
 assert.deepEqual(mock.runs.map(r=>r.siteId),['s1']);
 await page.waitForFunction(()=>/Testing now/.test(document.querySelector('.dash-site-latest').textContent),null,{timeout:8000});
 assert.equal(await open1.getByRole('button',{name:'Run test'}).isDisabled(),true,'one unfinished test per site');
 assert.equal(offOrigin.length,0,'no off-origin requests');
 await context.close();
}

async function failedAlert(scheme,width){
 freshMock({failed:true});
 const {context,page}=await open({scheme,width});
 const alert=page.locator('.dash-sites .alert-panel.alert-error');
 await alert.waitFor();
 assert.equal((await alert.locator('b').textContent()).trim(),'Restore test failed');
 assert.match(await alert.textContent(),/The database didn\u2019t start in 30 minutes\./);
 const actions=await alert.locator('.rp-actions button').allTextContents();
 assert.deepEqual(actions,['Run again','Open job']);
 assert.equal(await page.locator('.dash-sites .dash-summary').count(),0,'the alert takes the strip’s place');
 assert.equal(await alert.locator('.rp-actions button').first().getAttribute('class'),'primary');
 assert.match((await row(page,'cinderbean.com').locator('.dash-site-latest').textContent()).trim(),/^Failed · yesterday$/);
 assert.equal((await row(page,'cinderbean.com').locator('.dash-site-latest .status').getAttribute('class')).includes('status-failed'),true);
 await shot(page,`failed-${width}-${scheme}`);
 await noOverflow(page,'failed alert '+width);
 await alert.getByRole('button',{name:'Run again'}).click();
 await page.getByRole('status').filter({hasText:'Test started.'}).waitFor();
 assert.equal(mock.runs.length,1);
 await context.close();
}

async function jobs(scheme,width){
 freshMock({failed:true});
 const {context,page}=await open({scheme,width,page:'Jobs'});
 const table=page.locator('table.data-table');
 await table.waitFor();
 const rows=table.locator('tbody tr');
 assert.match(await rows.first().textContent(),/testcinderbean\.com/);
 assert.equal(await table.locator('tbody tr').first().locator('td').nth(1).textContent().then(x=>x.trim()),'Failed');
 assert.match(await rows.first().locator('td').nth(2).textContent(),/check health/);
 await rows.first().getByRole('button',{name:'View job'}).click();
 const d=dialog(page);
 await d.getByRole('heading',{name:'Job details'}).waitFor();
 await d.locator('.dn-tl-item').nth(5).waitFor();
 const names=await d.locator('.dn-tl-item .dn-tl-name').evaluateAll(els=>els.map(e=>e.firstChild.textContent));
 assert.deepEqual(names,['Check space','Copy backup','Restore copy','Start containers','Check health','Clean up']);
 const bad=d.locator('.dn-tl-item.is-bad');
 assert.equal(await bad.count(),1);
 assert.match(await bad.textContent(),/Check health/);
 assert.match(await bad.locator('small').textContent(),/didn\u2019t start/);
 assert.equal(await css(bad.locator('small'),'color'),await css(bad.locator('.rt-tl-ic'),'color'),'failed caption is red like its icon');
 assert.match(await d.locator('.dn-tl-item').last().locator('small').textContent(),/Test copy removed/);
 assert.equal(await d.locator('.alert-panel.alert-error').count(),1);
 assert.match(await d.locator('.dn-hero').textContent(),/Restore test\s*Failed/);
 assert.equal(await d.getByRole('button',{name:'Run again'}).count(),1);
 await shot(page,`job-${width}-${scheme}`);
 await noOverflow(page,'job details '+width);
 await d.getByRole('button',{name:'Close dialog'}).click();
 await context.close();
}

async function runningJob(){
 freshMock();
 mock.jobs.unshift({id:'job-t9',siteId:'s4',type:'restore-test',status:'test_running',stage:'restore_copy',createdAt:ago(0.1),details:{testId:'t9'}});
 const {context,page}=await open({page:'Jobs'});
 const first=page.locator('table.data-table tbody tr').first();
 assert.match(await first.textContent(),/Running/);
 assert.match(await first.locator('td').nth(2).textContent(),/restore copy/);
 await first.getByRole('button',{name:'View job'}).click();
 await dialog(page).getByRole('button',{name:'Cancel test'}).click();
 await dialog(page).getByRole('status').filter({hasText:'Stopping the test.'}).waitFor();
 assert.deepEqual(mock.cancels,['t9']);
 await context.close();
}

async function settingsDialog({role='admin',scheme='light',width=1440,motion=true}={}){
 freshMock();
 const {context,page}=await open({role,scheme,width,motion,page:'Sites & schedules'});
 const card=page.locator('.site-card',{hasText:'brightsmile.com'});
 await card.waitFor();
 return {context,page,card};
}
const switchOf=d=>d.getByRole('switch',{name:'Auto tests'});

async function dialogFlow(scheme){
 const {context,page,card}=await settingsDialog({scheme});
 await card.getByRole('button',{name:'Restore tests'}).click();
 const d=dialog(page);
 await d.getByRole('heading',{name:'Restore tests'}).waitFor();
 await d.getByRole('switch').waitFor();
 // Off by default: How often disabled, no live alert, Advanced closed
 assert.equal(await switchOf(d).getAttribute('aria-checked'),'false');
 assert.equal(await d.getByLabel('How often').isDisabled(),true);
 assert.equal(await d.locator('details.rt-adv').evaluate(el=>el.open),false);
 assert.equal(await d.locator('details.rt-adv summary').evaluate(el=>getComputedStyle(el).listStyleType),'none');
 assert.equal(await d.locator('summary .rt-chev').count(),1,'product chevron icon');
 // Switch OFF look: solid border-control track, light knob (tokens)
 const root=await page.evaluate(()=>{const s=getComputedStyle(document.documentElement);return {bc:s.getPropertyValue('--border-control').trim(),pf:s.getPropertyValue('--primary-foreground').trim()}});
 const sw=switchOf(d),rgb=hex=>{const n=parseInt(hex.slice(1),16);return `rgb(${n>>16}, ${n>>8&255}, ${n&255})`};
 assert.equal(await sw.evaluate(el=>getComputedStyle(el,'::before').backgroundColor),rgb(root.bc),'off track is --border-control');
 assert.equal(await sw.evaluate(el=>getComputedStyle(el,'::after').backgroundColor),rgb(root.pf),'off knob is --primary-foreground');
 await shot(page,`dialog-off-${scheme}`);
 // No server yet: Run test disabled with its reason; the switch never changes that
 const run=d.getByRole('button',{name:'Run test'});
 assert.equal(await run.isDisabled(),true);
 assert.match(await d.locator('.rt-why').textContent(),/^Choose a test server to run one\.$/);
 // Server choices: placeholder first, live server marked
 const options=await d.getByLabel('Test server').locator('option').allTextContents();
 assert.deepEqual(options,['Choose a server','Frankfurt-1','Ashburn-1 (live server)','Home NAS']);
 assert.equal(await d.locator('.alert-panel.alert-warning').count(),0);
 // Live server gate
 await d.getByLabel('Test server').selectOption({label:'Ashburn-1 (live server)'});
 const warn=d.locator('.alert-panel.alert-warning');
 await warn.waitFor();
 assert.match(await warn.textContent(),/Live server/);
 assert.equal(await run.isDisabled(),true);
 assert.match(await d.locator('.rt-why').textContent(),/^Allow live server to run one\.$/);
 await warn.getByLabel('Allow live server').check();
 assert.equal(await run.isDisabled(),false);
 assert.equal((await d.locator('.rt-why').textContent()).trim(),'');
 // Changing the server clears the opt-in
 await d.getByLabel('Test server').selectOption({label:'Home NAS'});
 assert.equal(await d.locator('.alert-panel.alert-warning').count(),0);
 await d.getByLabel('Test server').selectOption({label:'Ashburn-1 (live server)'});
 assert.equal(await d.getByLabel('Allow live server').isChecked(),false,'opt-in is not remembered across servers');
 await d.getByLabel('Allow live server').check();
 // Run test works while the schedule is off, and shows the caption with the enter motion
 await run.click();
 const done=d.locator('.rt-why.rt-done');
 await done.waitFor();
 assert.equal((await done.textContent()).trim(),'Test started.');
 assert.equal(await css(done,'color'),await page.evaluate(()=>{const e=document.createElement('i');e.style.color='var(--success)';document.body.append(e);const c=getComputedStyle(e).color;e.remove();return c}));
 assert.match(await css(done,'animationName'),/dn-enter/);
 assert.equal(mock.saves.at(-1).body.enabled,false);
 assert.equal(mock.saves.at(-1).body.allowLiveServer,true);
 assert.deepEqual(mock.runs.map(r=>r.siteId),['s4']);
 await shot(page,`dialog-live-${scheme}`);
 // Footer order and sizes
 const buttons=await d.locator('.modal-foot button').allTextContents();
 assert.deepEqual(buttons,['Cancel','Run test','Save']);
 const heights=await d.locator('.modal-foot button').evaluateAll(els=>els.map(e=>Math.round(e.getBoundingClientRect().height)));
 assert.equal(new Set(heights).size,1,'equal button heights');
 // Turn on, pick weekly, open Advanced, presets
 await sw.click();
 assert.equal(await sw.getAttribute('aria-checked'),'true');
 assert.equal(await d.getByLabel('How often').isDisabled(),false);
 await d.getByLabel('How often').selectOption('monthly');
 await d.locator('details.rt-adv summary').click();
 const time=d.getByLabel('Time limit'),mem=d.getByLabel('Memory'),cpu=d.getByLabel('CPU');
 assert.deepEqual(await time.locator('option').allTextContents(),['15 min','30 min','1 hour','2 hours','Custom']);
 assert.deepEqual(await mem.locator('option').allTextContents(),['512 MB','1 GB','2 GB','4 GB','8 GB','Custom']);
 assert.deepEqual(await cpu.locator('option').allTextContents(),['Half a core','1 core','2 cores','4 cores','Custom']);
 assert.deepEqual([await time.inputValue(),await mem.inputValue(),await cpu.inputValue()],['30','1024','1'],'defaults 30 min, 1 GB, 1 core');
 assert.equal(await d.locator('details.rt-adv input[aria-label^="Custom"]').count(),0);
 // Custom reveals a plain text input with range placeholders; invalid values show inline messages
 await time.selectOption('custom');
 const t=d.getByLabel('Custom time limit in minutes');
 await t.waitFor();
 assert.equal(await t.getAttribute('type'),'text');assert.equal(await t.getAttribute('inputmode'),'numeric');
 assert.equal(await t.getAttribute('placeholder'),'10 to 120 minutes');
 assert.equal(await t.evaluate(el=>document.activeElement===el),true,'custom input takes focus');
 await t.fill('5');
 await d.getByText('Enter 10 to 120 minutes.').waitFor();
 assert.equal(await t.getAttribute('aria-invalid'),'true');
 await d.getByRole('button',{name:'Save'}).click();
 assert.equal(mock.saves.length,1,'an invalid custom value is not saved');
 await t.fill('45');
 assert.equal(await d.getByText('Enter 10 to 120 minutes.').count(),0);
 await mem.selectOption('custom');
 const m=d.getByLabel('Custom memory in MB');
 assert.equal(await m.getAttribute('placeholder'),'256 to 16384 MB');
 await m.fill('20000');await d.getByText('Enter 256 to 16384 MB.').waitFor();
 await m.fill('1536');
 await cpu.selectOption('custom');
 const c=d.getByLabel('Custom CPU in cores');
 assert.equal(await c.getAttribute('inputmode'),'decimal');assert.equal(await c.getAttribute('placeholder'),'0.5 to the server\u2019s cores');
 await c.fill('9');await d.getByText('Enter 0.5 to 2 cores.').waitFor();
 await c.fill('0.2');await d.getByText('Enter 0.5 to 2 cores.').waitFor();
 await c.fill('1.5');
 for(const input of [t,m,c])assert.equal(await input.getAttribute('type'),'text','plain text input, no spinner');
 await d.getByLabel('Health check path').fill('/health');
 await shot(page,`dialog-advanced-${scheme}`);
 await d.getByRole('button',{name:'Save'}).click();
 await page.getByRole('status').filter({hasText:'Restore test settings saved.'}).waitFor();
 const saved=mock.saves.at(-1).body;
 assert.deepEqual({...saved,probe:saved.probe},{enabled:true,cadence:'monthly',serverId:'ash',allowLiveServer:true,allowInternet:false,timeLimitMinutes:45,memoryMb:1536,cpus:1.5,probe:{path:'/health'}});
 // Reopen: saved values come back; non-preset values open as Custom
 await card.getByRole('button',{name:'Restore tests'}).click();
 const d2=dialog(page);
 await d2.getByRole('switch').waitFor();
 assert.equal(await switchOf(d2).getAttribute('aria-checked'),'true');
 await d2.locator('details.rt-adv summary').click();
 assert.equal(await d2.getByLabel('Custom time limit in minutes').inputValue(),'45');
 assert.equal(await d2.getByLabel('Test server').inputValue(),'ash');
 await d2.getByRole('button',{name:'Cancel'}).click();
 await context.close();
}

async function dialogErrors(){
 const {context,page,card}=await settingsDialog();
 await card.getByRole('button',{name:'Restore tests'}).click();
 const d=dialog(page);await d.getByRole('switch').waitFor();
 await d.getByLabel('Test server').selectOption({label:'Home NAS'});
 mock.runError={code:'TOO_MANY_TESTS',message:'You have run 6 tests for this site today. Try again tomorrow.'};
 await d.getByRole('button',{name:'Run test'}).click();
 await d.getByText('You have run 6 tests for this site today. Try again tomorrow.').waitFor();
 assert.equal(await d.locator('.rt-why.rt-done').count(),0);
 mock.runError={code:'NO_VERIFIED_BACKUP',message:'raw'};
 await d.getByRole('button',{name:'Run test'}).click();
 await d.getByText('This site has no verified backup yet.').waitFor();
 mock.saveError='LIVE_SERVER_NOT_ALLOWED';
 await d.getByRole('button',{name:'Save'}).click();
 await d.getByText('Allow live server to use that server.').waitFor();
 // Turning tests on without a server is stopped on the page
 mock.saveError=null;
 await d.getByLabel('Test server').selectOption('');
 await switchOf(d).click();
 await d.getByRole('button',{name:'Save'}).click();
 await d.getByText('Choose a test server first.').waitFor();
 await context.close();
}

async function internetAndReverify(){
 const {context,page,card}=await settingsDialog();
 mock.needReverify=true;
 await card.getByRole('button',{name:'Restore tests'}).click();
 const d=dialog(page);await d.getByRole('switch',{name:'Auto tests'}).waitFor();
 await d.getByLabel('Test server').selectOption({label:'Home NAS'});
 await d.locator('details.rt-adv summary').click();
 const net=d.getByRole('switch',{name:'Allow internet'});
 assert.equal(await net.getAttribute('aria-checked'),'false','internet is off by default');
 assert.equal(await d.locator('.sb-switch-row').count(),2);
 assert.equal(await d.getByText('Internet access').count(),0);
 await net.click();
 const warn=d.locator('.alert-panel.alert-warning');
 assert.match(await warn.textContent(),/Internet accessThe test copy can reach the internet with your live keys\. Email stays blocked\./);
 await shot(page,'dialog-internet');
 await d.getByRole('button',{name:'Save'}).click();
 // The app's own confirm-it-is-you step appears inside the dialog, nothing is saved yet
 const box=d.getByRole('group',{name:'Please confirm it is you'});
 await box.waitFor();
 assert.equal(mock.saves.length,0);
 await box.getByLabel('Password').fill('bad');await box.getByLabel('Authenticator code').fill('000000');
 await box.getByRole('button',{name:'Verify and continue'}).click();
 await box.getByText('That password or code was not right. Try again.').waitFor();
 await box.getByLabel('Password').fill('pw');await box.getByLabel('Authenticator code').fill('123456');
 await box.getByRole('button',{name:'Verify and continue'}).click();
 await page.getByRole('status').filter({hasText:'Restore test settings saved.'}).waitFor();
 assert.equal(mock.saves.at(-1).body.allowInternet,true);assert.equal(mock.reauths,1);
 // Live server needs the same check
 mock.reverified=false;
 await card.getByRole('button',{name:'Restore tests'}).click();
 const d2=dialog(page);await d2.getByRole('switch',{name:'Auto tests'}).waitFor();
 await d2.getByLabel('Test server').selectOption({label:'Ashburn-1 (live server)'});
 await d2.getByLabel('Allow live server').check();
 await d2.getByRole('button',{name:'Save'}).click();
 await d2.getByRole('group',{name:'Please confirm it is you'}).waitFor();
 await d2.getByRole('button',{name:'Not now'}).click();
 assert.equal(await d2.getByRole('group',{name:'Please confirm it is you'}).count(),0);
 await context.close();
}

async function operator(){
 const {context,page,card}=await settingsDialog({role:'operator'});
 await card.getByRole('button',{name:'Restore tests'}).click();
 const d=dialog(page);await d.getByRole('switch').waitFor();
 assert.equal(await d.getByRole('button',{name:'Save'}).count(),0,'operators cannot save settings');
 assert.equal(await switchOf(d).isDisabled(),true);
 assert.equal(await d.getByLabel('Test server').isDisabled(),true);
 assert.match(await d.textContent(),/Only an administrator can change these settings\./);
 await d.locator('details.rt-adv summary').click();
 assert.equal(await d.getByRole('switch',{name:'Allow internet'}).isDisabled(),true);
 await context.close();
 // An operator with a saved server can run a test and sees the API's limit message
 freshMock();
 const second=await open({role:'operator',page:'Sites & schedules'});
 const p=second.page;
 await p.locator('.site-card',{hasText:'cinderbean.com'}).getByRole('button',{name:'Restore tests'}).click();
 const d3=dialog(p);await d3.getByRole('switch').waitFor();
 assert.equal(await d3.getByRole('button',{name:'Run test'}).isDisabled(),false);
 mock.runError={code:'TOO_MANY_TESTS',message:'You have run 6 tests for this site today. Try again tomorrow.'};
 await d3.getByRole('button',{name:'Run test'}).click();
 await d3.getByText('You have run 6 tests for this site today. Try again tomorrow.').waitFor();
 mock.runError=null;
 await d3.getByRole('button',{name:'Run test'}).click();
 await d3.locator('.rt-why.rt-done').waitFor();
 assert.equal(mock.saves.length,0,'an operator run does not save settings');
 assert.deepEqual(mock.runs.map(r=>r.siteId),['s1']);
 await second.context.close();
}

async function phone(scheme){
 const {context,page,card}=await settingsDialog({width:390,height:844,scheme});
 await noOverflow(page,'sites 390');
 await card.getByRole('button',{name:'Restore tests'}).click();
 const d=dialog(page);await d.getByRole('switch').waitFor();
 await d.getByLabel('Test server').selectOption({label:'Ashburn-1 (live server)'});
 await d.locator('details.rt-adv summary').click();
 await d.getByLabel('Memory').selectOption('custom');
 await d.getByLabel('Custom memory in MB').fill('x');
 await noOverflow(page,'dialog 390');
 const box=await d.evaluate(el=>({sw:el.scrollWidth,cw:el.clientWidth}));assert.ok(box.sw<=box.cw,'dialog has no sideways scroll');
 const buttons=d.locator('.modal-foot button');
 const sizes=await buttons.evaluateAll(els=>els.map(e=>{const r=e.getBoundingClientRect(),g=document.createRange();g.selectNodeContents(e);return {h:r.height,w:r.width,lines:Math.round(g.getBoundingClientRect().height/parseFloat(getComputedStyle(e).lineHeight))}}));
 for(const s of sizes){assert.ok(s.h>=44,'button is at least 44px tall: '+s.h);assert.equal(s.lines,1,'button text does not wrap')}
 assert.equal(new Set(sizes.map(s=>Math.round(s.w))).size,1,'equal button widths on the phone');
 assert.equal(await css(d,'scrollbarWidth'),'none');
 await d.locator('.modal-foot').scrollIntoViewIfNeeded();
 await shot(page,`dialog-390-${scheme}`);
 await d.getByRole('button',{name:'Cancel'}).click();
 await context.close();
}

async function motion(){
 // Reduced motion: no hover or enter motion on the new pieces
 const {context,page}=await open({motion:false});
 await row(page,'cinderbean.com').locator('summary').waitFor();
 const chev=row(page,'cinderbean.com').locator('.dash-chevron');
 assert.equal(await css(chev,'transitionDuration'),'0s');
 await context.close();
 // With motion: arrow, restore icon and chevrons use the shared timing and the approved transforms
 const {context:c2,page:p2}=await open({motion:true});
 await row(p2,'cinderbean.com').locator('summary').waitFor();
 const link=row(p2,'cinderbean.com');
 await link.locator('summary').click();
 const run=link.getByRole('button',{name:'Run test'}),lib=link.getByRole('button',{name:'Open library'});
 const tokens=await p2.evaluate(()=>{const s=getComputedStyle(document.documentElement);return {base:s.getPropertyValue('--dur-base').trim()}});
 const secs=tokens.base.endsWith('ms')?parseFloat(tokens.base)/1000:parseFloat(tokens.base);
 assert.equal(parseFloat(await css(run.locator('svg'),'transitionDuration')),secs,'restore icon uses --dur-base');
 await run.hover();await p2.waitForTimeout(secs*1000+150);
 assert.equal(await css(run.locator('svg'),'transform'),'matrix(0.707107, -0.707107, 0.707107, 0.707107, 0, 0)','restore icon rotates -45deg');
 await lib.hover();await p2.waitForTimeout(secs*1000+150);
 assert.equal(await css(lib.locator('svg'),'transform'),'matrix(1, 0, 0, 1, 2, 0)','arrow moves 2px right');
 await link.locator('summary').click();
 await row(p2,'pawmeadow.com').locator('summary').hover();await p2.waitForTimeout(secs*1000+150);
 assert.equal(await css(row(p2,'pawmeadow.com').locator('.dash-chevron'),'transform'),'matrix(1, 0, 0, 1, 0, 2)','closed-row chevron dips 2px');
 await c2.close();
}

async function pickerRules(){
 // The approved picker rules are in the shipped stylesheet and supported by this browser
 const {context,page}=await open({page:'Sites & schedules'});
 const rules=await page.evaluate(()=>{const out=[];const walk=list=>{for(const r of list){if(r.cssRules&&!(r instanceof CSSStyleRule))walk(r.cssRules);if(r.cssText&&/position-area/.test(r.cssText))out.push(r.cssText)}};for(const s of document.styleSheets){try{walk(s.cssRules)}catch{}}return out});
 assert.ok(rules.some(t=>/position-area:\s*block-end span-inline-end/.test(t)&&/position-try(-fallbacks)?:\s*flip-block/.test(t)&&/scrollbar-width:\s*none/.test(t)),'select picker opens downward first with a hidden scrollbar');
 await context.close();
}

browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
try{
 for(const scheme of ['light','dark']){
  await overview(scheme,1440);await failedAlert(scheme,1440);await jobs(scheme,1440);await dialogFlow(scheme);await phone(scheme);
 }
 await overview('light',390);await failedAlert('dark',390);await jobs('light',390);
 await runningJob();await dialogErrors();await internetAndReverify();await operator();await motion();await pickerRules();
 assert.deepEqual(errors,[],'no page errors');
 console.log('Restore tests browser suite passed.');
}finally{await browser.close()}
