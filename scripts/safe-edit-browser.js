import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

// Safe Edit UI (docs/safe-edit.md) against the mocked API contract: every approved board state at 1280 and 390, light
// and dark, no horizontal scroll, buttons that never wrap and share one height, no environment value rendered, the
// Reload button full width on a phone, operators and static sites, the sites page entry, the history list, the
// re-verification prompt, and an existing dialog that must look exactly as before.
// REAL_API=1 runs the main flow against the real routes and engine with a faked helper (REAL_PORT, default 5398).
// Run against a dev server serving this worktree: TEST_BASE_URL=http://127.0.0.1:5311. SHOTS_DIR writes screenshots.
const REAL=process.env.REAL_API==='1',realPort=Number(process.env.REAL_PORT||5398);
const base=REAL?'http://127.0.0.1:'+realPort:process.env.TEST_BASE_URL||'http://127.0.0.1:5173',origin=new URL(base).origin,shots=process.env.SHOTS_DIR;
if(shots)await mkdir(shots,{recursive:true});
const NOW=Date.now(),ago=m=>new Date(NOW-m*60000).toISOString();
const SECRET='newsecretvalue-7Q',OTHER='another-secret-value-9Z';

const servers=[
 {id:'srv1',name:'Commerce host',note:'Customer stores',host:'192.0.2.10',username:'root',port:22,hostKey:'ab'.repeat(32),status:'connected',capabilities:{freeBytes:96*1024**3,docker:true,nginx:true}},
 {id:'srv2',name:'Content host',note:'Blogs',host:'198.51.100.20',username:'root',port:22,hostKey:'cd'.repeat(32),status:'connected',capabilities:{freeBytes:64*1024**3,docker:true,nginx:true}},
 {id:'srv3',name:'Staging',note:'',host:'203.0.113.30',username:'deploy',port:22,hostKey:'ef'.repeat(32),status:'connected',capabilities:{freeBytes:38*1024**3,docker:true,nginx:true}}
];
const names=['Demo Shop','Studio Journal','Product Catalog','Help Center','Team Portal','Demo Gallery','Documentation','Landing Page'];
const sites=names.map((name,i)=>({id:'demo-site-'+i,name,serverId:servers[i%3].id,incremental:{enabled:false,interval:4},
 config:i===7?{kind:'static',containers:[],documentRoot:'/var/www/demo.example.com',domains:['demo.example.com']}:{kind:'docker',containers:['demo-'+i+'-web','demo-'+i+'-db'],domains:['demo-'+i+'.example.com'],ports:['8080'],healthUrl:'http://127.0.0.1:8080/health'}}));
sites[0].config.domains=['shop.example.com'];
const backups=Array.from({length:16},(_,i)=>({id:'demo-recovery-'+i,siteId:sites[i%8].id,createdAt:ago(60*(i*4+1)),capturedAt:ago(60*(i*4+1)),verified:true,size:(120+i*9)*1024**2,pinned:i===0,downtimeMs:2200}));
const policies=sites.map(s=>({siteId:s.id,enabled:true,schedule:'0 2 * * *',timezone:'UTC',retention:7}));
const state=()=>({servers,sites,backups,jobs:[],restores:[],policies,audit:[],storage:{used:1e9,total:1e12},worker:{running:true,online:true,lastSeen:new Date().toISOString()},maintenance:{title:'Back shortly',message:'Updating.'}});
const providers=[{id:'telegram',label:'Telegram',icon:'brand-telegram',group:'chat'}];

const COMPOSE=`services:
  web:
    image: demo/shop:1.5
    ports:
      - "8080:8080"
      - "9090:9090"
    env_file: .env
    depends_on:
      - db
  db:
    image: postgres:16
    volumes:
      - dbdata:/var/lib/postgresql/data
volumes:
  dbdata:`;
const lineOf=text=>COMPOSE.split('\n').findIndex(l=>l.includes(text))+1;
const ENV='/srv/shop/.env';
const noPort=container=>({host:null,container,protocol:'tcp',hostIp:'',at:null}),port=(host,container,at=null)=>({host,container,protocol:'tcp',hostIp:'',at});
const at=(text,file='compose.yaml')=>({file,line:lineOf(text)});
const viewFor=(over={})=>({siteId:'demo-site-0',kind:'compose',files:[{path:'compose.yaml',inode:11,sha256:'a'.repeat(64),text:COMPOSE}],
 env:[{file:ENV,keys:['APP_ENV','DATABASE_URL','SECRET_KEY','SMTP_PASSWORD'].map(key=>({key,set:true}))}],
 services:[{name:'web',image:'demo/shop:1.5',imageAt:at('demo/shop'),imageReason:null,imageVariable:null,ports:[port(8080,8080,at('8080:8080')),port(9090,9090,at('9090:9090'))],frozen:false,healthcheck:true},{name:'db',image:'postgres:16',imageAt:at('postgres'),imageReason:null,imageVariable:null,ports:[noPort(5432)],frozen:false,healthcheck:false}],
 usable:{compose:true,env:true,ports:true,image:true},reasons:{},healthUrl:true,...over});
const DIFF={files:[{path:'compose.yaml',hunks:[{oldStart:3,newStart:3,lines:[{type:'remove',text:'image: demo/shop:1.4'},{type:'add',text:'image: demo/shop:1.5'},{type:'context',text:'ports:'},{type:'context',text:'- "8080:8080"'},{type:'add',text:'- "9090:9090"'}]}]}],env:[]};
const stepsOf=(phase)=>{
 const t=i=>ago(12-i);
 const S=(step,state,i,secs,detail)=>({step,state,startedAt:state==='pending'||state==='skipped'?null:t(i),finishedAt:state==='done'||state==='failed'?new Date(NOW-(12-i)*60000+secs*1000).toISOString():null,detail:detail||null});
 if(phase==='running')return [S('backup','done',0,48),S('apply','running',1,12),S('check_health','pending'),S('finish','pending')];
 if(phase==='done')return [S('backup','done',0,48),S('apply','done',1,12),S('check_health','done',2,9),S('finish','done',3,1)];
 if(phase==='rolled')return [S('backup','done',0,48),S('apply','done',1,12),S('check_health','failed',2,120,'No answer from the health check'),S('roll_back','done',4,19),S('finish','skipped')];
 return [S('backup','done',0,48),S('apply','done',1,12),S('check_health','failed',2,120,'No answer from the health check'),S('roll_back','failed',4,31,'The old version did not start'),S('finish','skipped')];
};
const editFor=phase=>({id:'e1',siteId:sites[0].id,state:phase==='running'?'running':phase==='attention'?'needs_attention':'done',result:phase==='done'?'applied':phase==='rolled'?'rolled_back':null,
 reason:phase==='rolled'?'No healthy answer in 2 minutes. The previous version runs again.':phase==='attention'?'Rollback failed. The maintenance page is on.':null,backupId:'demo-recovery-0',steps:stepsOf(phase),dataCopyNote:phase==='attention'?'A copy of the data is kept on the server.':null,restore:phase==='attention'&&mock.restored?{jobId:'j1',running:true}:null,actions:{cancel:phase==='running'&&false,retry:phase==='attention',restoreBackup:phase==='attention'&&!mock.restored}});

let mock;
function freshMock(){
 mock={reviewMode:'ok',phase:'running',needReauth:false,reverified:false,loadReauth:false,loadFail:false,hold:null,view:viewFor(),requests:[],loads:0,retries:0,cancels:0,restored:0,dataRollback:false,
  history:[{id:'e1',state:'done',result:'applied',createdAt:ago(180),changed:['services.web.image'],env:{added:[],replaced:[],removed:[]}},{id:'e2',state:'done',result:'rolled_back',createdAt:ago(60*30),changed:['services.web.ports'],env:{added:[],replaced:['SECRET_KEY'],removed:[]}}]};
}
freshMock();
const json=(route,body,status=200)=>route.fulfill({status,json:body});
let browser;const errors=[];

async function open({role='admin',width=1280,scheme='light',start='Map'}={}){
 const context=await browser.newContext({viewport:{width,height:width<500?844:800},reducedMotion:'reduce',colorScheme:scheme});
 await context.addInitScript(s=>{try{localStorage.setItem('docknest-theme',s)}catch{}},scheme);
 const page=await context.newPage(),offOrigin=[];
 page.on('pageerror',e=>errors.push(e.message));
 context.on('request',req=>{const u=new URL(req.url());if(!['data:','blob:'].includes(u.protocol)&&u.origin!==origin)offOrigin.push(u.href)});
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),endpoint=url.pathname,method=req.method(),body=method==='GET'?null:req.postDataJSON?.()||{};
  const auth={authenticated:true,setupRequired:false,csrfToken:'fixture',user:{id:'u1',name:'Fixture user',role},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000};
  let m;
  if(endpoint==='/api/auth/reauth'){if(body.password==='pw'&&body.code==='123456'){mock.reverified=true;return json(route,{ok:true})}return json(route,{error:'No'},401)}
  if((m=endpoint.match(/^\/api\/sites\/([^/]+)\/edit\/(review|apply)$/))&&method==='POST'){
   mock.requests.push({kind:m[2],body});
   if(m[2]==='review'){
    if(mock.reviewMode==='dataNotLocal')return json(route,{code:'DATA_NOT_LOCAL',error:'This site keeps its data outside the server. Change the image by hand.'},422);
    if(mock.reviewMode==='blocked')return json(route,{code:'PRIVILEGE_ADDED',error:'This change adds privileged mode. Edit it by hand.'},422);
    if(mock.reviewMode==='conflict')return json(route,{code:'FILE_CHANGED',error:'This file changed on the server. Reload it.'},422);
    return json(route,{token:'tok-1',diff:DIFF,summary:{health:'url',dataRollback:mock.dataRollback,dataBytes:mock.dataRollback?1288490188:null},warnings:[{code:'PUBLIC_PORT',port:9090,message:'Port 9090 is reachable from the internet.'},...(mock.dataRollback?[{code:'LARGE_DATA_COPY',bytes:1288490188,message:'The safety copy of the data is large.'}]:[])]});
   }
   if(mock.needReauth&&!mock.reverified)return json(route,{code:'REAUTH_REQUIRED',error:'Confirm it is you.'},403);
   if(mock.applyError)return json(route,{code:mock.applyError,error:'raw'},409);
   return json(route,{edit:{id:'e1'}},202);
  }
  if((m=endpoint.match(/^\/api\/sites\/([^/]+)\/edit$/))&&method==='GET'){
   mock.loads++;
   if(mock.hold)await mock.hold;
   if(mock.loadFail)return json(route,{error:'Could not read the files.'},502);
   if(mock.loadReauth&&!mock.reverified)return json(route,{code:'REAUTH_REQUIRED',error:'Confirm it is you.'},403);
   return json(route,mock.view);
  }
  if(endpoint==='/api/site-edits/e1/cancel'){mock.cancels++;return json(route,{ok:true},202)}
  if(endpoint==='/api/site-edits/e1/restore-backup'){mock.restored++;return json(route,{ok:true},202)}
  if(endpoint==='/api/site-edits/e1/retry'){mock.retries++;mock.phase='done';return json(route,{ok:true},202)}
  if((m=endpoint.match(/^\/api\/site-edits\/([^/]+)$/)))return json(route,editFor(mock.phase));
  if(endpoint.match(/^\/api\/sites\/([^/]+)\/edits$/))return json(route,{items:mock.history,nextCursor:null});
  const out=endpoint==='/api/auth/status'?auth:endpoint==='/api/state'?state():endpoint==='/api/version'?{version:'0.0.0'}:endpoint==='/api/updates/progress'?{active:false,state:'idle'}
   :endpoint==='/api/storage-targets'?{activeTargetId:'t1',targets:[{id:'t1',name:'Backup vault',kind:'sftp',host:'198.51.100.50',status:'connected',capacity_bytes:512*1024**3,trackedBytes:24*1024**3}]}
   :endpoint==='/api/alerts'?{role,providers,connections:[],nodes:[],rules:[]}:/\/incremental/.test(endpoint)?{enabled:false,interval:4,available:true}:endpoint==='/api/moves'?{moves:[]}:{};
  return json(route,out);
 });
 await page.goto(base+'/');
 await page.locator('.berry-sidebar').waitFor();
 if(width<900)await page.getByRole('button',{name:'Open navigation'}).click();
 await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:start,exact:true}).click();
 return {context,page,offOrigin};
}
const shot=async(page,n,slug,width,scheme)=>{if(shots){await page.mouse.move(2,2);await page.waitForTimeout(250);await page.screenshot({path:path.join(shots,`${n}-safe-edit-${slug}-${width>500?'desktop':'phone'}-${scheme}.png`)})}};
const dlg=page=>page.locator('dialog[open].dialog-edge');
const settle=page=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,60)))));

// Layout rules every state must keep.
async function layout(page,label){
 await settle(page);
 const r=await page.evaluate(()=>{
  const d=document.querySelector('dialog[open].dialog-edge');
  const wraps=[...d.querySelectorAll('button')].filter(b=>b.offsetParent&&!b.matches('[role=tab],.icon-button,.map-link')).filter(b=>b.getBoundingClientRect().height>48).map(b=>b.textContent.trim());
  const foot=[...d.querySelectorAll('.map-dialog-foot button')].map(b=>Math.round(b.getBoundingClientRect().height*2)/2);
  const body=d.querySelector('.map-dialog-body');
  return {sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,bw:body.scrollWidth,bc:body.clientWidth,wraps,foot,nowrap:[...d.querySelectorAll('.map-dialog-foot button,.rp-actions button')].every(b=>getComputedStyle(b).whiteSpace==='nowrap'),text:d.innerText};
 });
 assert.ok(r.sw<=r.cw,label+': page horizontal overflow');
 assert.ok(r.bw<=r.bc+1,label+': dialog horizontal overflow '+r.bw+' > '+r.bc);
 assert.deepEqual(r.wraps,[],label+': a button is taller than one line');
 assert.ok(new Set(r.foot).size<=1,label+': footer buttons differ in height '+r.foot);
 assert.ok(r.nowrap,label+': buttons must not wrap');
 assert.ok(!r.text.includes(SECRET)&&!r.text.includes(OTHER),label+': an environment value is rendered');
}
async function openSite(page,width,name='Demo Shop'){
 if(await page.locator('.map-panel-foot').first().isVisible()&&await page.locator('.map-panel-foot').getByRole('button',{name:'Edit',exact:true}).count())return;
 if(width>500)await page.locator('.map-site',{hasText:name}).first().click();
 else await page.locator('.map-list li',{hasText:name}).getByRole('button',{name:'Details'}).click();
 await page.locator('.map-panel-foot').first().waitFor();
}
const editButton=page=>page.locator('.map-panel-foot').getByRole('button',{name:'Edit',exact:true});
async function startEdit(page,width){await openSite(page,width);await editButton(page).click();await dlg(page).waitFor()}
async function dirtyEnv(page,value=SECRET){
 await dlg(page).getByRole('tab',{name:'Environment'}).click();
 await dlg(page).getByRole('button',{name:'Replace SECRET_KEY'}).click();
 await dlg(page).getByLabel('New value for SECRET_KEY').fill(value);
}
const review=async page=>{await dlg(page).getByRole('button',{name:'Review',exact:true}).click()};

async function boards(width,scheme){
 freshMock();
 const {context,page,offOrigin}=await open({width,scheme});
 const tag=`${width} ${scheme}`;
 // 09 loading
 let release;mock.hold=new Promise(r=>{release=r});
 await openSite(page,width);await editButton(page).click();await dlg(page).waitFor();
 await dlg(page).getByText('Reading files').waitFor();
 assert.equal(await dlg(page).getByRole('button',{name:'Review',exact:true}).isDisabled(),true,'Review is off while loading');
 await shot(page,'09','loading',width,scheme);await layout(page,'loading '+tag);
 mock.hold=null;release();
 // 01 edit
 await dlg(page).locator('textarea.se-code').waitFor();
 assert.equal(await dlg(page).locator('textarea').inputValue(),COMPOSE);
 assert.equal(await dlg(page).getByRole('button',{name:'Review',exact:true}).isDisabled(),true,'Review is off until something changed');
 await shot(page,'01','edit',width,scheme);await layout(page,'edit '+tag);
 // The new dialog carries the edge, and an existing dialog is unchanged.
 const edge=await dlg(page).evaluate(el=>{const c=getComputedStyle(el);return {w:c.borderTopWidth,c:c.borderTopColor}});
 assert.equal(edge.w,'1px');assert.equal(edge.c,scheme==='dark'?'rgb(53, 50, 59)':'rgba(0, 0, 0, 0)','dialog edge colour');
 // 02 environment: write-only values
 await dirtyEnv(page);
 await dlg(page).getByLabel('New value for SECRET_KEY').waitFor();
 await shot(page,'02','env',width,scheme);await layout(page,'env '+tag);
 const keys=await dlg(page).locator('code').allTextContents();
 assert.ok(['APP_ENV','DATABASE_URL','SECRET_KEY','SMTP_PASSWORD'].every(k=>keys.includes(k)));
 assert.equal(await dlg(page).locator('input[type=password]').getAttribute('autocomplete'),'new-password');
 await dlg(page).getByRole('button',{name:'Save SECRET_KEY'}).click();
 assert.equal(await dlg(page).locator('input[type=password]').count(),0,'the value input closes after Save');
 assert.ok(!(await page.content()).includes(SECRET),'a saved value is not in the page');
 assert.match(await dlg(page).innerText(),/Replaced/);
 assert.equal((await dlg(page).innerText()).match(/Saved/g).length,3,'untouched rows stay Saved');
 // Replace opens empty, never prefilled
 await dlg(page).getByRole('button',{name:'Replace DATABASE_URL'}).click();
 assert.equal(await dlg(page).getByLabel('New value for DATABASE_URL').inputValue(),'');
 await dlg(page).getByRole('button',{name:'Cancel',exact:true}).first().click();
 // 12 ports
 await dlg(page).getByRole('tab',{name:'Ports'}).click();
 await dlg(page).getByRole('button',{name:'Edit host port for web 9090'}).click();
 await dlg(page).getByLabel('Host port for web 9090').fill('9091');
 await shot(page,'12','ports',width,scheme);await layout(page,'ports '+tag);
 assert.equal(await dlg(page).getByText('Not published').count(),1);
 await dlg(page).getByRole('tab',{name:'Compose'}).click();
 const edited=await dlg(page).locator('textarea').inputValue();
 assert.ok(edited.includes('"9091:9090"')&&edited.includes('"8080:8080"'),'the guided port edit is the same text edit');
 // Image guided edit and back
 await dlg(page).getByRole('tab',{name:'Image'}).click();
 await dlg(page).getByLabel('web').fill('demo/shop:1.6');
 await dlg(page).getByRole('tab',{name:'Compose'}).click();
 assert.ok((await dlg(page).locator('textarea').inputValue()).includes('image: demo/shop:1.6'));
 // 10 blocked
 const shortCompose=`services:\n  web:\n    image: demo/shop:1.5\n    privileged: true\n    ports:\n      - "8080:8080"\n    env_file: .env`;
 await dlg(page).locator('textarea').fill(shortCompose);
 mock.reviewMode='blocked';await review(page);
 await dlg(page).getByText('This change adds privileged mode. Edit it by hand.').waitFor();
 assert.equal(await dlg(page).getByRole('button',{name:'Review',exact:true}).isDisabled(),true,'Review stays off after a refusal');
 await shot(page,'10','blocked',width,scheme);await layout(page,'blocked '+tag);
 await dlg(page).locator('textarea').fill(shortCompose.replace('    privileged: true\n',''));
 assert.equal(await dlg(page).getByRole('button',{name:'Review',exact:true}).isDisabled(),false,'editing clears the refusal');
 // 11 conflict
 mock.reviewMode='conflict';await review(page);
 const reload=dlg(page).getByRole('button',{name:'Reload'});await reload.waitFor();
 assert.equal(await dlg(page).getByRole('button',{name:'Review',exact:true}).isDisabled(),true);
 const w=await page.evaluate(()=>{const b=document.querySelector('dialog[open] .rp-actions button').getBoundingClientRect(),p=document.querySelector('dialog[open] .alert-panel').getBoundingClientRect();return {b:b.width,p:p.width-32-20-12}});
 if(width<500)assert.ok(w.b>=w.p-2,`Reload is full width on a phone (${w.b} of ${w.p})`);else assert.ok(w.b<w.p-40,'Reload keeps its width on desktop');
 await shot(page,'11','conflict',width,scheme);await layout(page,'conflict '+tag);
 mock.reviewMode='ok';const loads=mock.loads;await reload.click();
 await dlg(page).locator('textarea.se-code').waitFor();
 assert.ok(mock.loads>loads,'Reload reads the files again');
 assert.equal(await dlg(page).locator('textarea').inputValue(),COMPOSE,'Reload brings the server text back');
 // 03 review, then apply with re-verification
 await dirtyEnv(page);await dlg(page).getByRole('button',{name:'Save SECRET_KEY'}).click();
 await dlg(page).getByRole('tab',{name:'Ports'}).click();await dlg(page).getByRole('button',{name:'Edit host port for web 9090'}).click();await dlg(page).getByLabel('Host port for web 9090').fill('9091');
 await review(page);
 await dlg(page).getByText('Review changes').waitFor();
 await dlg(page).getByText('New published port').waitFor();
 assert.match(await dlg(page).innerText(),/reachable from the internet/);
 assert.match(await dlg(page).innerText(),/Data rollback\s*No/);
 assert.equal(await dlg(page).locator('.alert-warning').count(),1,'the internet warning is amber');
 const body=mock.requests.at(-1).body;
 assert.equal(body.env[0].file,'/srv/shop/.env');assert.equal(body.env[0].key,'SECRET_KEY');assert.equal(body.env[0].value,SECRET,'the value travels to the API once');
 assert.ok(body.files[0].text.includes('9091:9090')&&body.files[0].sha256==='a'.repeat(64));
 await shot(page,'03','review',width,scheme);await layout(page,'review '+tag);
 await dlg(page).getByRole('button',{name:'Back',exact:true}).click();
 await dlg(page).getByRole('tab',{name:'Environment'}).waitFor();
 assert.ok(!(await dlg(page).innerText()).includes(SECRET));
 await review(page);await dlg(page).getByText('Review changes').waitFor();
 mock.needReauth=true;mock.phase='running';
 await dlg(page).getByRole('button',{name:'Apply',exact:true}).click();
 await dlg(page).getByText('Please confirm it is you').waitFor();
 await layout(page,'reauth '+tag);
 await dlg(page).getByLabel('Password').fill('pw');await dlg(page).getByLabel('Authenticator code').fill('123456');
 await dlg(page).getByRole('button',{name:'Verify and continue'}).click();
 // 13 applying
 await dlg(page).getByText('Applying the change…').waitFor();
 assert.equal(await dlg(page).locator('[role=progressbar]').getAttribute('aria-valuenow'),'25');
 assert.equal(await dlg(page).getByRole('button',{name:'Cancel',exact:true}).count(),0,'no Cancel once Apply started');
 await shot(page,'13','applying',width,scheme);await layout(page,'applying '+tag);
 // 14 done (event: the poll of GET /api/site-edits/:id, only while active)
 mock.phase='done';
 await dlg(page).getByText('Change applied').waitFor({timeout:9000});
 await shot(page,'14','done',width,scheme);await layout(page,'done '+tag);
 await dlg(page).getByRole('button',{name:'Close',exact:true}).click();await dlg(page).waitFor({state:'detached'});
 // 04 rolled back
 await startEdit(page,width);await dirtyEnv(page);await dlg(page).getByRole('button',{name:'Save SECRET_KEY'}).click();await review(page);
 mock.phase='rolled';await dlg(page).getByRole('button',{name:'Apply',exact:true}).click();
 await dlg(page).getByText('No healthy answer in 2 minutes. The previous version runs again.').waitFor();
 await dlg(page).getByText('No answer from the health check').waitFor();
 await shot(page,'04','rolled-back',width,scheme);await layout(page,'rolled '+tag);
 await dlg(page).getByRole('button',{name:'Edit again'}).click();
 await dlg(page).locator('textarea.se-code').waitFor();
 await dlg(page).getByRole('button',{name:'Cancel',exact:true}).click();await dlg(page).waitFor({state:'detached'});
 // 15 needs attention
 await startEdit(page,width);await dirtyEnv(page);await dlg(page).getByRole('button',{name:'Save SECRET_KEY'}).click();await review(page);
 mock.phase='attention';await dlg(page).getByRole('button',{name:'Apply',exact:true}).click();
 await dlg(page).getByText('Rollback failed. The maintenance page is on.').waitFor();
 assert.equal(await dlg(page).locator('.alert-error').getByRole('button').count(),2,'the red panel carries Try again and Restore backup');
 if(width<500){const ws=await dlg(page).locator('.rp-actions button').evaluateAll(l=>l.map(b=>Math.round(b.getBoundingClientRect().width)));assert.equal(new Set(ws).size,1,'panel buttons share one width on a phone')}
 await dlg(page).getByText('A copy of the data is kept on the server.').waitFor();
 await shot(page,'15','needs-attention',width,scheme);await layout(page,'attention '+tag);
 await dlg(page).getByRole('button',{name:'Try again'}).click();
 await dlg(page).getByText('Change applied').waitFor({timeout:9000});assert.equal(mock.retries,1);
 await dlg(page).getByRole('button',{name:'Close',exact:true}).click();await dlg(page).waitFor({state:'detached'});
 // Restore backup calls the route and shows the running restore
 await startEdit(page,width);await dirtyEnv(page);await dlg(page).getByRole('button',{name:'Save SECRET_KEY'}).click();await review(page);
 mock.phase='attention';await dlg(page).getByRole('button',{name:'Apply',exact:true}).click();
 await dlg(page).getByRole('button',{name:'Restore backup'}).click();
 await dlg(page).getByText('Restoring the backup. Follow it in Jobs.').waitFor();
 assert.equal(mock.restored,1);assert.equal(await dlg(page).getByRole('button',{name:'Restore backup'}).count(),0);
 assert.deepEqual(offOrigin,[],'no off-origin requests');
 await context.close();
}

async function existingDialogUnchanged(scheme){
 freshMock();
 const {context,page}=await open({width:1280,scheme});
 await openSite(page,1280);
 await page.locator('.map-panel-foot').getByRole('button',{name:/Move to/}).click();
 const d=page.locator('dialog[open].map-dialog');await d.waitFor();
 const s=await d.evaluate(el=>{const c=getComputedStyle(el);return {w:c.borderTopWidth,style:c.borderTopStyle,r:c.borderRadius,bg:c.backgroundColor}});
 assert.equal(s.w,'0px','an existing dialog keeps no border');assert.equal(await d.evaluate(el=>el.classList.contains('dialog-edge')),false);
 await context.close();
}

async function roles(){
 freshMock();
 // Operators: no Edit action, history is read-only.
 let {context,page}=await open({role:'operator',width:1280});
 await openSite(page,1280);
 assert.equal(await editButton(page).count(),0,'operators get no Edit');
 await page.getByRole('button',{name:'Edit history'}).click();
 const d=page.locator('dialog[open]');await d.getByText('Rolled back').waitFor();
 assert.equal(await d.getByRole('button',{name:/^Edit /}).count(),0);
 await d.getByRole('button',{name:'Open edit from 3 hours ago'}).click().catch(()=>{});
 await context.close();
 // Static sites: nothing to edit.
 ({context,page}=await open({width:1280}));
 await page.locator('.map-site',{hasText:'Landing Page'}).first().click();
 await page.locator('.map-panel-foot').first().waitFor();
 assert.equal(await editButton(page).count(),0,'static sites hide Edit');
 await context.close();
 // Sites page: Edit and History on the card, history opens an edit timeline, static card has no Edit.
 ({context,page}=await open({width:1280,start:'Sites & schedules'}));
 await page.locator('.site-card').first().waitFor();
 const card=page.locator('.site-card',{hasText:'Demo Shop'});
 await card.getByRole('button',{name:'Edit history for Demo Shop'}).click();
 const h=page.locator('dialog[open].dialog-edge');
 await h.getByText('Applied').waitFor();
 await layout(page,'history');
 mock.phase='done';
 await h.getByRole('button',{name:/Open edit from 3 hours ago/}).click();
 await h.getByText('Change applied').waitFor();
 await h.getByRole('button',{name:'Close',exact:true}).click();
 await card.getByRole('button',{name:'Edit Demo Shop with Safe Edit'}).click();
 await h.locator('textarea.se-code').waitFor();
 assert.equal(await h.locator('input[type=password]').count(),0);
 await h.getByRole('button',{name:'Cancel',exact:true}).click();
 await context.close();
 // Load asks for re-verification, then continues.
 freshMock();mock.loadReauth=true;
 ({context,page}=await open({width:1280}));
 await startEdit(page,1280);
 await dlg(page).getByText('Please confirm it is you').waitFor();
 await dlg(page).getByLabel('Password').fill('pw');await dlg(page).getByLabel('Authenticator code').fill('123456');
 await dlg(page).getByRole('button',{name:'Verify and continue'}).click();
 await dlg(page).locator('textarea.se-code').waitFor();
 await context.close();
 // Load failure offers Try again.
 freshMock();mock.loadFail=true;
 ({context,page}=await open({width:1280}));
 await startEdit(page,1280);
 await dlg(page).getByText('Could not read the files.').waitFor();
 mock.loadFail=false;await dlg(page).getByRole('button',{name:'Try again'}).click();
 await dlg(page).locator('textarea.se-code').waitFor();
 await context.close();
 // Single-container site: no Compose tab. Image set through ${TAG}: guided edit declines.
 freshMock();
 mock.view=viewFor({kind:'container',files:[],env:[{file:'container',keys:[{key:'TAG',set:true}]}],services:[{name:'web',image:'shop:${TAG}',ports:[port(8080,8080)],frozen:false,healthcheck:true}],usable:{compose:false,env:true,ports:true,image:false},reasons:{compose:{code:'NO_COMPOSE',message:'This site has no Compose file to edit.'},image:{code:'IMAGE_FROM_ENV',message:'Edit TAG in Environment.'}}});
 ({context,page}=await open({width:1280}));
 await startEdit(page,1280);
 assert.equal(await dlg(page).getByRole('tab',{name:'Compose'}).count(),0);
 await dlg(page).getByRole('tab',{name:'Image'}).click();
 await dlg(page).getByText('Edit TAG in Environment.').waitFor();
 await dlg(page).getByRole('button',{name:'Open Environment'}).click();
 await dlg(page).getByRole('button',{name:'Replace TAG'}).waitFor();
 // Ports of a single container travel as containerChanges.
 await dlg(page).getByRole('tab',{name:'Ports'}).click();
 await dlg(page).getByRole('button',{name:'Edit host port for web 8080'}).click();
 await dlg(page).getByLabel('Host port for web 8080').fill('8081');
 await review(page);await dlg(page).getByText('Review changes').waitFor();
 assert.deepEqual(mock.requests.at(-1).body.containerChanges,{ports:[{host:8081,container:8080,protocol:'tcp'}]});
 await context.close();
 // Hand edit makes a guided row decline; an invalid port and an invalid variable name never reach Review.
 freshMock();
 ({context,page}=await open({width:1280}));
 await startEdit(page,1280);
 await dlg(page).locator('textarea').fill(COMPOSE.replace('"9090:9090"','"7000:9090"'));
 await dlg(page).getByRole('tab',{name:'Ports'}).click();
 await dlg(page).getByRole('button',{name:'Edit host port for web 9090'}).click();
 await dlg(page).getByLabel('Host port for web 9090').fill('9092');
 await dlg(page).getByText('Some ports are set in a way that needs the file.').waitFor();
 await dlg(page).getByRole('button',{name:'Edit this in Compose'}).click();
 await dlg(page).getByRole('tab',{name:'Environment'}).click();
 await dlg(page).getByRole('button',{name:'Add variable'}).click();
 await dlg(page).getByLabel('Variable name').fill('COMPOSE_FILE');
 await dlg(page).getByLabel('Value for COMPOSE_FILE').fill(OTHER);
 assert.equal(await dlg(page).getByLabel('Variable name').getAttribute('aria-invalid'),'true');
 await context.close();
 // Review shows the data copy size and the large-copy warning; DATA_NOT_LOCAL is a blocked panel with the server's sentence.
 freshMock();mock.dataRollback=true;
 ({context,page}=await open({width:1280}));
 await startEdit(page,1280);await dirtyEnv(page);await dlg(page).getByRole('button',{name:'Save SECRET_KEY'}).click();await review(page);
 await dlg(page).getByText('Large data copy').waitFor();
 assert.match(await dlg(page).innerText(),/Data rollback\s*Yes, 1\.2 GB/);
 await context.close();
 freshMock();mock.reviewMode='dataNotLocal';
 ({context,page}=await open({width:1280}));
 await startEdit(page,1280);await dirtyEnv(page);await dlg(page).getByRole('button',{name:'Save SECRET_KEY'}).click();await review(page);
 await dlg(page).getByText('This site keeps its data outside the server. Change the image by hand.').waitFor();
 await context.close();
 // The server's file and line win over the UI's own search: two identical port lines, only the reported one changes.
 freshMock();
 {const NL=String.fromCharCode(10),L=COMPOSE.split(NL),k=L.findIndex(l=>l.includes('9090:9090'));L.splice(k,0,L[k]);const twice=L.join(NL);
  mock.view=viewFor({files:[{path:'compose.yaml',inode:11,sha256:'a'.repeat(64),text:twice}]});
  ({context,page}=await open({width:1280}));
  await startEdit(page,1280);
  await dlg(page).getByRole('tab',{name:'Ports'}).click();
  await dlg(page).getByRole('button',{name:'Edit host port for web 9090'}).click();
  await dlg(page).getByLabel('Host port for web 9090').fill('9091');
  await dlg(page).getByRole('tab',{name:'Compose'}).click();
  const t=await dlg(page).locator('textarea').inputValue();
  assert.equal(t.split(NL)[lineOf('9090:9090')-1].includes('9091:9090'),true);assert.equal((t.match(/9090:9090/g)||[]).length,1,'only the reported line changed');
  await context.close();}
 // Busy site: the 409 sentence is shown at Apply.
 freshMock();mock.applyError='SITE_BUSY';
 ({context,page}=await open({width:1280}));
 await startEdit(page,1280);await dirtyEnv(page);await dlg(page).getByRole('button',{name:'Save SECRET_KEY'}).click();await review(page);
 await dlg(page).getByRole('button',{name:'Apply',exact:true}).click();
 await dlg(page).getByText('This site is busy right now. Try again soon.').waitFor();
 await context.close();
}


// REAL_API=1: the same screens against the real routes and engine (src/site-edits). Starts DockNest in this process on
// a throwaway database, serves the built app (run `npm run build` first) and fakes only the server's helper.
async function realApi(){
 const {existsSync}=await import('node:fs');
 const {mkdtemp,writeFile:write}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {randomBytes,randomUUID,createHash}=await import('node:crypto');
 if(!existsSync('dist/index.html'))throw new Error('REAL_API=1 serves the built app: run npm run build first.');
 const dir=await mkdtemp(path.join(tmpdir(),'docknest-se-real-'));
 Object.assign(process.env,{DATA_DIR:dir,BACKUP_DIR:path.join(dir,'backups'),BACKUP_STORAGE:'local',MASTER_KEY_FILE:path.join(dir,'master.key'),SETUP_TOKEN_FILE:path.join(dir,'setup.token'),SECURE_COOKIES:'false',NODE_ENV:'test',APP_ORIGIN:origin});
 await mkdir(process.env.BACKUP_DIR,{recursive:true});await write(process.env.MASTER_KEY_FILE,randomBytes(32).toString('base64'));
 const root=new URL('../src/',import.meta.url);
 const {app}=await import(new URL('server.js',root)),{db}=await import(new URL('db.js',root)),{digest}=await import(new URL('crypto.js',root));
 const {claimJob,executeJob}=await import(new URL('engine.js',root));
 const se=await import(new URL('site-edits/engine.js',root)),tokens=await import(new URL('site-edits/tokens.js',root));
 let now=Date.now();se.editTransport.now=()=>now;tokens.tokenClock.now=()=>now;
 const sha=t=>createHash('sha256').update(t).digest('hex');
 const TEXT='services:\n  web:\n    image: shop:1.0\n    ports:\n      - "8080:80"\n  db:\n    image: postgres:16\n';
 const calls=[];
 se.editTransport.remote=async(_server,request)=>{
  calls.push(request.operation);
  switch(request.operation){
   case 'discover':return {containers:['shop-web','shop-db'].map(name=>({name,labels:{'com.docker.compose.project':'shop','com.docker.compose.project.config_files':'/srv/shop/compose.yaml','com.docker.compose.project.working_dir':'/srv/shop','com.docker.compose.project.environment_file':'/srv/shop/.env'}}))};
   case 'edit-load':return {files:[{path:'/srv/shop/compose.yaml',inode:11,sha256:sha(TEXT),text:TEXT}],env:[{file:'/srv/shop/.env',keys:['DB_PASSWORD','TAG']}],services:[{name:'web',image:'shop:1.0',ports:[{host:8080,container:80,protocol:'tcp',hostIp:'',at:{file:'/srv/shop/compose.yaml',line:5}}],imageAt:{file:'/srv/shop/compose.yaml',line:3},imageReason:null,imageVariable:null,frozen:false,healthcheck:true},{name:'db',image:'postgres:16',ports:[],frozen:false,healthcheck:false}],composeVersion:'2.29.1',usable:{compose:true,env:true,ports:true,image:true},reasons:{}};
   case 'edit-check':return {ok:true,verdict:{changed:['services.web.ports'],imageChanged:false,newPorts:[{host:8081,allAddresses:true}],hashes:[{path:'/srv/shop/compose.yaml',before:sha(TEXT),after:'b'.repeat(64)}],reviewedModelSha256:'c'.repeat(64)}};
   case 'edit-prepare':return {ok:true,pulled:[]};
   case 'edit-apply':return {ok:true,startedAt:now/1000};
   case 'edit-poll':return {state:'healthy',healthSeconds:61};
   case 'edit-rollback':case 'edit-finish':return {ok:true};
   case 'edit-status':return {journal:true,files:'candidate',maintenance:true};
   default:throw new Error('unexpected '+request.operation);
  }
 };
 const iso=()=>new Date().toISOString();
 const userId=randomUUID(),token=randomBytes(32).toString('base64url');
 db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(userId,userId+'@example.invalid','fixture','fixture','[]',iso(),'Fixture admin','admin');
 db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token),userId,randomBytes(16).toString('hex'),Date.now()+3600000,Date.now(),Date.now(),Date.now());
 db.prepare('INSERT INTO update_preferences(id,check_enabled,decided_by,decided_at) VALUES(1,0,?,?)').run(userId,iso());
 const serverId=randomUUID(),siteId=randomUUID();
 db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,status,capabilities,created_at) VALUES(?,?,?,?,?,?,?,'connected',?,?)").run(serverId,'Commerce host','192.0.2.10',22,'root','fixture','0'.repeat(64),JSON.stringify({freeBytes:50*1024**3}),iso());
 db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId,serverId,'shop',JSON.stringify({containers:['shop-web','shop-db'],composeFiles:['/srv/shop/compose.yaml'],healthUrl:''}),iso());
 db.prepare("INSERT INTO policies VALUES (?,0,'0 2 * * *','UTC',7,NULL)").run(siteId);
 const listener=app.listen(realPort,'127.0.0.1');await new Promise((resolve,reject)=>{listener.once('listening',resolve);listener.once('error',reject)});
 const drive=async()=>{
  for(let round=0;round<400;round++){
   const row=db.prepare('SELECT result,state FROM site_edits WHERE site_id=?').get(siteId);
   if(row&&row.result!==null)return row;
   se.tickSiteEdits();const job=claimJob();
   if(!job){now+=1000;await new Promise(r=>setTimeout(r,20));continue}
   if(job.type==='backup'){
    const backupId=randomUUID();
    db.prepare("UPDATE jobs SET status='completed',stage='completed',finished_at=?,details=? WHERE id=?").run(iso(),JSON.stringify({backupId,editId:JSON.parse(job.details).editId}),job.id);
    db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(backupId,job.site_id,job.id,iso(),path.join(dir,backupId+'.enc'),4096,'a'.repeat(64),JSON.stringify({kind:'docker',containers:[]}),0,1,iso());
    continue;
   }
   await executeJob(job);
  }
  throw new Error('the edit did not finish');
 };
 try{
  const context=await browser.newContext({viewport:{width:1280,height:800},reducedMotion:'reduce'});
  await context.addCookies([{name:'dbm_session',value:token,url:base}]);
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/');await page.locator('.berry-sidebar').waitFor();
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Sites & schedules',exact:true}).click();
  const card=page.locator('.site-card',{hasText:'shop'});
  await card.getByRole('button',{name:'Edit shop with Safe Edit'}).click();
  const d=dlg(page);
  await d.locator('textarea.se-code').waitFor();
  assert.equal(await d.locator('textarea').inputValue(),TEXT,'the real load returns the files');
  // Ports: guided edit, then an environment value, then Review through the real gate.
  await d.getByRole('tab',{name:'Ports'}).click();
  await d.getByRole('button',{name:'Edit host port for web 80'}).click();
  await d.getByLabel('Host port for web 80').fill('8081');
  await d.getByRole('tab',{name:'Environment'}).click();
  await d.getByRole('button',{name:'Replace DB_PASSWORD'}).click();
  await d.getByLabel('New value for DB_PASSWORD').fill(SECRET);
  await d.getByRole('button',{name:'Save DB_PASSWORD'}).click();
  await shot(page,'R1','real-edit',1280,'light');
  await d.getByRole('button',{name:'Review',exact:true}).click();
  await d.getByText('Review changes').waitFor();
  await d.getByText('New published port').waitFor();
  assert.match(await d.innerText(),/DB_PASSWORD=\(changed\)/);
  assert.ok(!(await page.content()).includes(SECRET),'the review never shows the value');
  assert.match(await d.innerText(),/8081:80/);
  await shot(page,'R2','real-review',1280,'light');
  await d.getByRole('button',{name:'Apply',exact:true}).click();
  await d.getByText('Applying changes').waitFor();
  const finished=await drive();
  assert.equal(finished.result,'applied');
  await d.getByText('Change applied').waitFor({timeout:9000});
  await shot(page,'R3','real-done',1280,'light');
  const dump=JSON.stringify(['site_edits','site_edit_steps','jobs','audit_events'].map(t=>db.prepare('SELECT * FROM '+t).all()));
  assert.ok(!dump.includes(SECRET),'no environment value in SQLite');
  assert.ok(calls.includes('edit-apply'),'the engine ran the helper steps');
  // History reads GET /sites/:id/edits.
  await d.getByRole('button',{name:'Close',exact:true}).click();
  await card.getByRole('button',{name:'Edit history for shop'}).click();
  await dlg(page).getByText('Applied').waitFor();
  assert.deepEqual(errors,[],'no page errors');
  await context.close();
 }finally{listener.close()}
}

browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
try{
 if(REAL){await realApi();console.log('Safe Edit browser suite passed against the real API.');process.exit(0)}
 for(const width of [1280,390])for(const scheme of ['light','dark'])await boards(width,scheme);
 for(const scheme of ['light','dark'])await existingDialogUnchanged(scheme);
 await roles();
 assert.deepEqual(errors,[],'no page errors');
 console.log('Safe Edit browser suite passed.');
}finally{await browser.close()}
