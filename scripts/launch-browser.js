import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

// Launch a new site from the Map (docs/launch-site.md) against a mocked API that follows the shapes of the launch engine
// (src/launches): both sources, the check with install offers (including git), the trust warning with the fresh sign-in
// check, the timeline, waiting DNS, failure, needs attention, certificate failed, the Remove launch offer and the Deploy
// keys section, on desktop and a 390 px phone, light and dark. Waits are on conditions; every timestamp is seeded in the
// past. Run against a dev server: TEST_BASE_URL=http://127.0.0.1:5205. Set SHOTS_DIR to also write screenshots.
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5173',origin=new URL(base).origin,shots=process.env.SHOTS_DIR;
if(shots)await mkdir(shots,{recursive:true});
const T=Date.now(),ago=s=>new Date(T-s*1000).toISOString(),ahead=s=>new Date(T+s*1000).toISOString();
const state={
 servers:[
  {id:'a',name:'Commerce host',host:'a.example.invalid',port:22,username:'root',status:'connected',capabilities:{freeBytes:90*1024**3,dockerVersion:'28.1',composeVersion:'2.29.0',nginx:{installed:true},certbot:{installed:true}}},
  {id:'b',name:'Content host',host:'b.example.invalid',port:22,username:'root',status:'connected',capabilities:{freeBytes:60*1024**3}}
 ],
 sites:[{id:'s1',name:'blog.example.com',serverId:'b',config:{containers:['blog'],domains:['blog.example.com']}},
  {id:'s2',name:'shop2.example.com',serverId:'b',config:{containers:['web'],domains:['shop2.example.com']},launch:{id:'l9',launchedAt:ago(3*3600),removeUntil:ahead(21*3600)}}],
 jobs:[],backups:[],policies:[],audit:[],storage:{used:0,total:1e12},worker:{online:true}
};
const PUB='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ7vQ2mK4nT0xS9fHq3Lw8bYzR1uE6cVdPaGhN5oXtZk docknest-shop-deploy-key',FP='SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',FP2='SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s';
const KEYS=[
 {id:'11111111-1111-4111-8111-111111111111',name:'Shop deploy key',gitHost:'github.com',publicKey:PUB,fingerprint:'SHA256:keykeykeykey',hostKey:{sha256:FP,type:'ssh-ed25519'},pinnedFromServerId:'a',pinnedFromServerName:'Commerce host',pinnedAt:ago(3*86400),createdAt:ago(3*86400)},
 {id:'22222222-2222-4222-8222-222222222222',name:'Docs repo key',gitHost:'gitlab.com',publicKey:PUB,fingerprint:'SHA256:keykeykeykey',hostKey:{sha256:FP,type:'ssh-ed25519'},pinnedFromServerId:'b',pinnedFromServerName:'Content host',pinnedAt:ago(14*86400),createdAt:ago(14*86400)}];
// Steps as the engine answers them: states queued, running, waiting, done, failed, skipped, pending.
const ORDER=['check','fetch','build','start','check_health','web','certificate','save','maintenance','first_backup'];
const steps=({done=0,running=-1,failed=-1,waiting=-1,teardown=null}={})=>[...ORDER.map((step,i)=>({step,state:i<done?'done':i===failed?'failed':i===running?'running':i===waiting?'waiting':'pending',startedAt:i<done||i===running||i===failed||i===waiting?ago(300-i*30):null,finishedAt:i<done||i===failed?ago(290-i*30):null,detail:null,result:{}})),{step:'teardown',state:teardown||'pending',startedAt:teardown?ago(60):null,finishedAt:teardown==='failed'?ago(30):null,detail:teardown==='failed'?'The nginx file could not be removed':null,result:{}}];
let mock,browser;const errors=[];
const reset=()=>{mock={noPorts:false,checkMode:'ok',checks:[],launches:[],reauths:0,needReauth:false,launch:null,next:null,dnsCalls:0,retries:0,removes:0,cancels:0,installs:[],keys:KEYS.map(k=>({...k})),keyCalls:[],created:[],pins:[],hostFp:FP,movedPin:false,listOpen:true}};
reset();
const ck=(id,title,ok,text,extra={})=>({id,title,ok,status:ok?'ok':'block',value:text,text,...extra});
const okChecks=[ck('docker','Docker',true,'28.1'),ck('compose','Docker Compose',true,'2.29'),ck('nginx','nginx',true,'1.26'),ck('certbot','certbot',true,''),ck('space','Free space',true,'')];
function checkResult(body){
 const base={slug:'shop2-example-com',folder:'/srv/docknest/shop2-example-com',domain:body.domain,www:'www.'+body.domain,gate:{ok:true,refusals:[]},services:mock.noPorts?[{name:'web',ports:[],build:false}]:[{name:'web',ports:[8080],build:false},{name:'db',ports:[],build:false}],composeName:null,refHead:null,blockers:[],warnings:[],builds:false,dns:{records:[{type:'A',name:body.domain,value:'192.0.2.10'}],answers:{A:[],AAAA:[]},pointsHere:true},testServers:[{id:'b',name:'Content host'}]};
 if(mock.checkMode==='nginx'){const bad=[ck('nginx','nginx',false,'nginx is missing. Install it to continue.',{code:'NGINX_MISSING',install:{package:'nginx',command:'sudo apt-get install -y nginx',supported:true}}),ck('git','Git',false,'Git is missing.',{code:'GIT_MISSING',install:{package:'git',command:'sudo apt-get install -y git',supported:true}})];return {...base,ok:false,checks:[okChecks[0],okChecks[1],...bad],blockers:bad.map(x=>x.text)}}
 if(mock.checkMode==='refusal'){const bad=ck('domain','Domain',false,'nginx on this server already serves '+body.domain+'. DockNest never takes over another site.',{code:'NGINX_DOMAIN_SERVED'});return {...base,ok:false,checks:[...okChecks,bad],blockers:[bad.text],gate:{ok:false,refusals:[{code:'BUILD_SETTING_REFUSED',service:'web',field:null}]},dns:{...base.dns,pointsHere:false}}}
 return {...base,ok:true,checks:okChecks,builds:body.source==='git',warnings:mock.warn?['The image is large.']:[]};
}
const view=extra=>{const v={id:'l1',serverId:'a',serverName:'Commerce host',siteId:null,slug:'shop2-example-com',domain:'shop2.example.com',source:'compose',repo:null,state:'running',failedStep:null,reason:null,removing:false,cancelRequested:false,envKeys:[],dns:null,progress:0,statusLine:'Checking the server…',certificate:null,backups:null,restoreTests:null,steps:steps({done:1,running:2}),actions:{cancel:false,checkDns:false,remove:false,retry:false},removeUntil:null,createdAt:ago(600),startedAt:ago(590),finishedAt:null,...extra};v.progress=extra.progress??Math.round(v.steps.filter(x=>ORDER.includes(x.step)&&x.state==='done').length/ORDER.length*100);return v};
const dnsOf=records=>({...records[0],records});
const LAUNCH_STATES={
 running:()=>view({steps:steps({done:2,running:2}),statusLine:'Building the image…',actions:{cancel:false}}),
 cancelable:()=>view({state:'queued',steps:steps({done:1,running:1}),actions:{cancel:true}}),
 waiting_dns:()=>view({state:'waiting_dns',siteId:'s9',steps:steps({done:6,waiting:6}).map(s=>s.step==='save'||s.step==='first_backup'?{...s,state:'done'}:s),dns:dnsOf([{type:'A',name:'shop2.example.com',value:'192.0.2.10'},{type:'AAAA',name:'shop2.example.com',value:'2001:db8::10'}]),certificate:{state:'waiting_dns',reason:null},backups:{firstBackup:'done',schedule:'0 2 * * *',timezone:'UTC',nextRun:null},restoreTests:{enabled:true,serverId:'b',reason:null},actions:{checkDns:true,remove:true},removeUntil:ahead(23*3600),finishedAt:ago(120)}),
 done:()=>view({state:'done',siteId:'s9',steps:steps({done:9}),certificate:{state:'issued',reason:null},backups:{firstBackup:'done',schedule:'0 2 * * *',timezone:'UTC',nextRun:null},restoreTests:{enabled:true,serverId:'b',reason:null},actions:{remove:true},removeUntil:ahead(23*3600),finishedAt:ago(120)}),
 failed:()=>view({state:'failed',failedStep:'build',reason:'The image did not build. Everything was removed.',steps:steps({done:2,failed:2}).map(s=>s.step==='teardown'?{...s,state:'done'}:s),finishedAt:ago(100)}),
 attention:()=>view({state:'needs_attention',failedStep:'check_health',reason:'Cleanup did not finish. Commerce host stays on hold.',steps:steps({done:4,failed:4,teardown:'failed'}),actions:{retry:true}}),
 cert:()=>view({state:'done',siteId:'s9',certificate:{state:'failed',reason:"Let's Encrypt refused it: too many requests."},steps:steps({done:9}).map(s=>s.step==='certificate'?{...s,state:'failed',detail:"Let's Encrypt refused it: too many requests."}:s),restoreTests:{enabled:true,serverId:'b',reason:null},actions:{checkDns:true,remove:true},removeUntil:ahead(23*3600),finishedAt:ago(120)}),
 removing:()=>view({state:'done',removing:true,steps:steps({done:9,teardown:'running'})}),
 maintenanceFailed:()=>view({state:'done',siteId:'s9',steps:steps({done:9}).map(s=>s.step==='maintenance'?{...s,state:'failed',detail:'nginx could not load the maintenance page.'}:s),certificate:{state:'issued',reason:null},backups:{firstBackup:'done',schedule:'0 2 * * *',timezone:'UTC',nextRun:null},restoreTests:{enabled:true,serverId:'b',reason:null},actions:{remove:true},removeUntil:ahead(23*3600),finishedAt:ago(120)}),
 removed:()=>view({state:'removed',steps:steps({done:9,teardown:'done'})})
};
async function open({width=1440,height=900,scheme='light'}={}){
 const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',colorScheme:scheme});
 await context.grantPermissions(['clipboard-read','clipboard-write'],{origin}).catch(()=>{});
 await context.addInitScript(s=>{try{localStorage.setItem('docknest-theme',s)}catch{}},scheme);
 const page=await context.newPage(),offOrigin=[];
 page.on('pageerror',e=>errors.push(e.message));
 context.on('request',req=>{const u=new URL(req.url());if(!['data:','blob:'].includes(u.protocol)&&u.origin!==origin)offOrigin.push(u.href)});
 await page.route('**/api/**',route=>{
  const req=route.request(),endpoint=new URL(req.url()).pathname,m=req.method(),body=req.postDataJSON?.()||{};
  const auth={authenticated:true,setupRequired:false,csrfToken:'fixture',user:{id:'u1',name:'Fixture user',role:'admin'},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000};
  const json=(j,status=200)=>route.fulfill({status,json:j}),reauth=()=>json({error:'Please confirm it is you.',code:'REAUTH_REQUIRED'},403);
  if(endpoint==='/api/auth/status')return json(auth);
  if(endpoint==='/api/state')return json({...state,alertsAccess:true});
  if(endpoint==='/api/version')return json({version:'0.0.0'});
  if(endpoint==='/api/auth/reauth'){if(body.password==='pw'&&body.code==='123456'){mock.needReauth=false;mock.reauths++;return json({ok:true})}return json({error:'no'},401)}
  if(endpoint==='/api/moves')return json({moves:[]});
  if(endpoint==='/api/storage-targets')return json({targets:[],activeTargetId:null});
  if(endpoint==='/api/alerts')return json({role:'admin',providers:[],connections:[],nodes:[],rules:[],events:[],sourceKinds:[],limits:{},settings:{}});
  if(endpoint==='/api/connections/providers')return json({providers:[{id:'telegram',label:'Telegram',icon:'brand-telegram',fields:[]}]});
  if(endpoint==='/api/connections')return json({role:'admin',settings:{certificateDays:14},connections:[]});
  // Deploy keys, as src/launches/deploy-keys.js: reading a host key needs no re-verification and stores nothing; create,
  // repin and delete need it; create and repin carry the confirmed fingerprint (409 HOST_KEY_CHANGED when it moved).
  if(endpoint==='/api/deploy-keys'&&m==='GET')return json({keys:mock.keys});
  if(endpoint==='/api/deploy-keys/host-key'){mock.keyCalls.push(['host-key',body]);return json({gitHost:body.gitHost,fingerprint:FP,type:'ssh-ed25519'})}
  let mm=endpoint.match(/^\/api\/deploy-keys\/([^/]+)\/host-key$/);
  if(mm){const k=mock.keys.find(x=>x.id===mm[1]);mock.keyCalls.push(['key-host-key',body]);return json({fingerprint:mock.hostFp,type:'ssh-ed25519',changed:mock.hostFp!==k.hostKey.sha256,previous:{fingerprint:k.hostKey.sha256,serverId:k.pinnedFromServerId,serverName:k.pinnedFromServerName,pinnedAt:k.pinnedAt}})}
  mm=endpoint.match(/^\/api\/deploy-keys(?:\/([^/]+))?(?:\/(repin))?$/);
  if(mm&&m!=='GET'){
   if(mock.needReauth)return reauth();
   if(m==='DELETE'){mock.keys=mock.keys.filter(x=>x.id!==mm[1]);return json({deleted:true})}
   const now=mm[2]?mock.hostFp:FP;
   if(body.fingerprint!==now)return json({error:'The SSH key is not the one you confirmed.',code:'HOST_KEY_CHANGED',hostKey:{fingerprint:now,type:'ssh-ed25519'}},409);
   if(mm[2]){mock.pins.push([mm[1],body]);const k=mock.keys.find(x=>x.id===mm[1]);const previous={serverId:k.pinnedFromServerId,serverName:k.pinnedFromServerName};Object.assign(k,{hostKey:{sha256:body.fingerprint,type:'ssh-ed25519'},pinnedFromServerId:body.serverId,pinnedFromServerName:state.servers.find(s=>s.id===body.serverId)?.name});return json({key:k,...(mock.movedPin&&previous.serverId!==body.serverId?{replacedPin:{...previous,text:'Launches on '+previous.serverName+' with this key now need the Git host key confirmed from there again.'}}:{})})}
   mock.created.push(body);const k={id:'33333333-3333-4333-8333-333333333333',name:body.name,gitHost:body.gitHost,publicKey:PUB,fingerprint:'SHA256:newkeynewkey',hostKey:{sha256:FP,type:'ssh-ed25519'},pinnedFromServerId:body.serverId,pinnedFromServerName:state.servers.find(s=>s.id===body.serverId)?.name,pinnedAt:ago(5),createdAt:ago(5)};mock.keys.push(k);return json({key:k},201);
  }
  if(endpoint==='/api/servers/a/launch'&&m==='GET')return json({launches:mock.reopen?[LAUNCH_STATES[mock.reopen](),{...LAUNCH_STATES.done(),id:'l8'}]:[]});
  if(endpoint==='/api/servers/a/launch/check'){mock.checks.push(body);return json(checkResult(body))}
  if(endpoint==='/api/servers/a/launch'){if(mock.needReauth)return reauth();if(!body.webPort)return json({error:'Enter the container port that serves the website.',code:'INVALID_PORT',field:'webPort'},400);if(body.cleanShutdownConfirmed!==true)return json({error:'Confirm that the app saves its data when its containers stop.',code:'SHUTDOWN_CONFIRM_REQUIRED'},400);if(body.source==='git'&&body.trustConfirmed!==true)return json({error:'Confirm that you trust this repository.',code:'TRUST_REQUIRED'},400);mock.launches.push(body);mock.launch=mock.launch||'running';return json({launch:{id:'l1'}},202)}
  mm=endpoint.match(/^\/api\/launches\/([^/]+)(?:\/(.+))?$/);
  if(mm){
   if(mm[2]==='check-dns'){mock.dnsCalls++;mock.launch=mock.next||'done';return json(LAUNCH_STATES[mock.launch]())}
   if(mm[2]==='retry'){if(mock.needReauth)return reauth();mock.retries++;mock.launch='running';return json(LAUNCH_STATES.running())}
   if(mm[2]==='cancel'){mock.cancels++;mock.launch='failed';return json(LAUNCH_STATES.failed())}
   if(mm[2]==='remove'){if(mock.needReauth)return reauth();mock.removes++;mock.launch='removed';return json(LAUNCH_STATES.removing(),202)}
   return json(LAUNCH_STATES[mock.launch||'running']());
  }
  if(endpoint==='/api/servers/a/install'){mock.installs.push(body.package);return json({job:{id:'j1'}},202)}
  if(endpoint==='/api/servers/a/test')return json({ok:true});
  if(endpoint==='/api/jobs/j1')return json({job:{id:'j1',status:'completed',details:{steps:[{name:'Install',status:'completed'}]}}});
  return json({});
 });
 await page.goto(base);
 await page.waitForFunction(()=>document.querySelector('nav, .dash-metrics'),null,{timeout:30000});
 await page.evaluate(()=>document.fonts.ready);
 return {context,page,offOrigin};
}
const phone=page=>page.viewportSize().width<768;
async function gotoMap(page){
 if(phone(page)){await page.getByRole('button',{name:'Open navigation'}).click()}
 await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Map',exact:true}).first().click();
 await page.locator('.map-root').waitFor();
}
// Desktop: the "+" beside the server opens New site with that server. Phone: Add site on the server, then the New site row.
async function openNew(page,server='Commerce host'){
 await gotoMap(page);
 if(phone(page)){
  await page.locator('.map-list-group',{hasText:server}).getByRole('button',{name:'Add site'}).click();
  await page.getByRole('button',{name:/New site/}).click();
 }else await page.getByRole('button',{name:'Add a site to '+server}).click();
 await page.getByRole('heading',{name:'New site'}).waitFor();
}
const dialog=page=>page.locator('dialog[open]').last();
async function shot(page,name,scheme){if(!shots)return;await page.mouse.move(2,2);await page.waitForTimeout(80);await page.screenshot({path:`${shots}/${name}-${phone(page)?'phone':'desktop'}-${scheme}.png`,animations:'disabled'})}
// No sideways scroll and every button in the dialog footer has the same height and one line.
async function layoutOk(page){
 const r=await page.evaluate(()=>{
  const d=[...document.querySelectorAll('dialog[open]')].pop();if(!d)return {ok:true};
  const bs=[...d.querySelectorAll('.map-dialog-foot button, .modal-foot button')].filter(b=>b.offsetParent!==null);
  const hs=[...new Set(bs.map(b=>Math.round(b.getBoundingClientRect().height)))];
  const lines=bs.every(b=>b.getBoundingClientRect().height<64);
  return {sideways:document.documentElement.scrollWidth>innerWidth+1||d.scrollWidth>d.clientWidth+1,hs,lines};
 });
 assert.ok(!r.sideways,'sideways scroll');assert.ok(r.hs?.length<=1,'footer buttons differ in height: '+r.hs);assert.ok(r.lines!==false,'a footer button wraps');
}
const COMPOSE='services:\n  web:\n    image: demo/shop:1.5\n    ports:\n      - "8080:8080"\n  db:\n    image: postgres:16\n';
async function tickShutdown(page){await dialog(page).getByLabel(/I verified that a normal stop cleanly closes/).check()}
async function fillCompose(page,domain='shop2.example.com'){
 await page.getByRole('textbox',{name:'Compose file'}).fill(COMPOSE);
 await page.getByLabel('Domain').fill(domain);
 await tickShutdown(page);
}
async function toCheck(page){await page.getByRole('button',{name:'Check',exact:true}).click();await page.getByRole('heading',{name:/Ready to launch|Cannot launch yet/}).waitFor()}
async function reauth(page){
 await page.getByText('Please confirm it is you').waitFor();
 await page.getByLabel('Password').fill('pw');await page.getByLabel('Authenticator code').fill('123456');
 await page.getByRole('button',{name:'Verify',exact:true}).click();
}
async function openConnections(page){
 if(phone(page)){await page.getByRole('button',{name:'Open navigation'}).click()}
 await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Connections',exact:true}).first().click();
 await page.getByRole('heading',{name:'Deploy keys'}).waitFor();
 await page.getByRole('heading',{name:'Deploy keys'}).scrollIntoViewIfNeeded();
}
async function openSite(page,name){
 await gotoMap(page);
 if(phone(page))await page.locator('.map-list li',{hasText:name}).getByRole('button',{name:'Details'}).click();
 else await page.locator('.map-site',{hasText:name}).first().click();
 await page.getByRole('heading',{name}).waitFor();
}
const only=process.argv[2];
async function scenario(name,fn){if(only&&only!==name)return;reset();process.stdout.write(name+' ... ');await fn();console.log('ok')}

browser=await chromium.launch({channel:'chrome',headless:true}).catch(()=>chromium.launch({headless:true}));
try{
 for(const [width,height,scheme] of [[1440,900,'light'],[390,844,'dark'],[1440,900,'dark'],[390,844,'light']]){
  const tag=`${width}-${scheme}`;
  await scenario('compose '+tag,async()=>{
   const {context,page,offOrigin}=await open({width,height,scheme});
   await openNew(page);
   const d=dialog(page);
   assert.equal(await page.getByRole('button',{name:'Check',exact:true}).isDisabled(),true,'Check waits for a source and a domain');
   await fillCompose(page);
   // The two included rows are on this tab too, as text: the server decides daily backups and weekly restore tests
   await d.getByText('Backups',{exact:true}).waitFor();await d.getByText('Daily',{exact:true}).waitFor();await d.getByText('Restore tests',{exact:true}).waitFor();await d.getByText('Weekly',{exact:true}).waitFor();
   // Environment: reserved and invalid names are refused, values hide, a variable can be removed
   await page.getByRole('button',{name:'Add variable'}).click();
   await page.getByLabel('Key',{exact:true}).fill('COMPOSE_FILE');
   await d.getByText('This name is reserved.').waitFor();
   await page.getByLabel('Key',{exact:true}).fill('SECRET_KEY');await page.getByLabel('Value',{exact:true}).fill('s3cret');
   await page.getByRole('button',{name:'Add variable',exact:true}).last().click();
   assert.equal(await page.getByLabel('Value for SECRET_KEY').getAttribute('type'),'password');
   await page.getByRole('button',{name:'Add variable'}).click();
   await page.getByLabel('Key',{exact:true}).fill('GONE');await page.getByLabel('Value',{exact:true}).fill('x');
   await page.getByRole('button',{name:'Add variable',exact:true}).last().click();
   await page.getByRole('button',{name:'Remove GONE'}).click();
   assert.equal(await page.getByLabel('Value for GONE').count(),0);
   assert.deepEqual(await page.getByLabel('Web service').locator('option').allTextContents(),['web','db']);
   await shot(page,'31-built-launch-compose',scheme);await layoutOk(page);
   await toCheck(page);
   assert.deepEqual(mock.checks[0],{source:'compose',compose:COMPOSE,webService:'web',domain:'shop2.example.com'});
   assert.equal(await d.getByText(/builds and runs code/).count(),0,'no trust warning for a pasted Compose file');
   await d.getByText('Docker',{exact:true}).waitFor();await d.getByText('Points here').waitFor();
   await shot(page,'32-built-launch-check',scheme);await layoutOk(page);
   // Launch asks for the fresh sign-in check, then goes
   mock.needReauth=true;
   await page.getByRole('button',{name:'Launch',exact:true}).click();
   await reauth(page);
   await page.getByRole('heading',{name:'Launching shop2.example.com'}).waitFor();
   assert.equal(mock.reauths,1);
   assert.deepEqual(mock.launches[0].env,{SECRET_KEY:'s3cret'});
   assert.equal(mock.launches[0].webService,'web');assert.equal(mock.launches[0].webPort,8080);assert.equal(mock.launches[0].testServerId,'b');assert.equal(mock.launches[0].cleanShutdownConfirmed,true);
   assert.equal('trustConfirmed' in mock.launches[0],false);
   await d.getByText('Building the image…').waitFor();
   await d.getByRole('progressbar').waitFor();
   assert.ok(await d.locator('.dn-tl-item').count()>=9,'a timeline of the steps');
   assert.ok((await d.locator('.dn-tl-dur').allTextContents()).some(x=>/min|\ds/.test(x)),'durations from seeded times');
   // Past the start step there is nothing to cancel: only Close
   assert.equal(await d.getByRole('button',{name:'Cancel'}).count(),0);
   await shot(page,'33-built-launch-progress',scheme);await layoutOk(page);
   // Closing keeps it running
   await page.getByRole('button',{name:'Close',exact:true}).click();
   await page.locator('dialog[open]').waitFor({state:'detached'});
   assert.deepEqual(offOrigin,[]);
   await context.close();
  });
  await scenario('web port '+tag,async()=>{
   const {context,page}=await open({width,height,scheme});
   mock.noPorts=true;
   await openNew(page);await fillCompose(page);await toCheck(page);
   const d=dialog(page);
   // The Compose file publishes no port: the owner enters the container port; Launch waits for it
   assert.equal(await d.getByRole('button',{name:'Launch',exact:true}).isDisabled(),true);
   await d.getByLabel('Web port').fill('3000');
   await d.getByRole('button',{name:'Launch',exact:true}).click();
   await d.getByRole('heading',{name:'Launching shop2.example.com'}).waitFor();
   assert.equal(mock.launches[0].webPort,3000);
   await context.close();
  });
  await scenario('cancel before start '+tag,async()=>{
   const {context,page}=await open({width,height,scheme});
   mock.launch='cancelable';
   await openNew(page);await fillCompose(page);await toCheck(page);
   await page.getByRole('button',{name:'Launch',exact:true}).click();
   const d=dialog(page);
   await d.getByRole('heading',{name:'Launching shop2.example.com'}).waitFor();
   await d.getByRole('button',{name:'Cancel'}).click();
   await d.getByRole('heading',{name:'Launch stopped'}).waitFor();
   assert.equal(mock.cancels,1);
   await context.close();
  });
  await scenario('git '+tag,async()=>{
   const {context,page}=await open({width,height,scheme});
   await openNew(page);
   await page.getByRole('tab',{name:'Git repository'}).click();
   const d=dialog(page);
   await page.getByLabel('Repository URL').fill('git@github.com:shop/demo-shop.git');
   await page.getByLabel('Branch or tag').fill('v1.4.2');
   await page.getByLabel('Compose file').fill('deploy/compose.yaml');
   await page.getByLabel('Deploy key').selectOption({label:'Shop deploy key'});
   await page.getByLabel('Domain').fill('shop2.example.com');
   assert.equal(await page.getByRole('button',{name:'Check',exact:true}).isDisabled(),true,'Check waits for the clean-shutdown confirmation');
   await tickShutdown(page);
   // The same two included rows as on the Compose tab
   await d.getByText('Backups',{exact:true}).waitFor();await d.getByText('Daily',{exact:true}).waitFor();await d.getByText('Restore tests',{exact:true}).waitFor();
   if(width>=768){ // board 06: two columns, two rows
    const box=async l=>(await d.getByLabel(l).boundingBox());
    const [b,k,c,m]=[await box('Branch or tag'),await box('Deploy key'),await box('Compose file'),await box('Domain')];
    assert.ok(Math.abs(b.y-k.y)<2&&Math.abs(c.y-m.y)<2&&c.y>b.y+40&&k.x>b.x+100&&m.x>c.x+100&&Math.abs(b.x-c.x)<2,'Branch | Deploy key over Compose file | Domain');
   }
   await shot(page,'34-built-launch-git',scheme);await layoutOk(page);
   // An https address takes no deploy key
   await page.getByLabel('Repository URL').fill('https://git.example.com/shop/demo-shop.git');
   assert.equal(await page.getByLabel('Deploy key').isDisabled(),true);
   await page.getByLabel('Repository URL').fill('git@github.com:shop/demo-shop.git');
   await toCheck(page);
   assert.deepEqual(mock.checks[0],{source:'git',repo:{url:'git@github.com:shop/demo-shop.git',ref:'v1.4.2',composePath:'deploy/compose.yaml'},deployKeyId:KEYS[0].id,domain:'shop2.example.com'});
   await dialog(page).getByText('This builds and runs code from the repository on Commerce host. Only use repositories you trust.').waitFor();
   await dialog(page).getByLabel('Web service').selectOption('db');await dialog(page).getByLabel('Web service').selectOption('web');
   await shot(page,'35-built-launch-trust',scheme);await layoutOk(page);
   await page.getByRole('button',{name:'Launch',exact:true}).click();
   await page.getByRole('heading',{name:'Launching shop2.example.com'}).waitFor();
   assert.equal(mock.launches[0].source,'git');assert.equal(mock.launches[0].trustConfirmed,true);assert.equal(mock.launches[0].deployKeyId,KEYS[0].id);assert.equal(mock.launches[0].webService,'web');
   await context.close();
  });
  await scenario('install offers '+tag,async()=>{
   const {context,page}=await open({width,height,scheme});
   mock.checkMode='nginx';
   await openNew(page);await fillCompose(page);await toCheck(page);
   const d=dialog(page);
   await d.getByRole('heading',{name:'Cannot launch yet'}).waitFor();
   assert.equal(await page.getByRole('button',{name:'Launch',exact:true}).isDisabled(),true);
   await d.getByRole('button',{name:'Install nginx'}).waitFor();await d.getByRole('button',{name:'Install Git'}).waitFor();
   await d.getByRole('button',{name:'Show command'}).click();
   await page.getByRole('heading',{name:'Install nginx yourself'}).waitFor();
   await page.getByText('sudo apt-get install -y nginx').waitFor();
   await page.getByRole('button',{name:'Close',exact:true}).click();
   await d.getByRole('heading',{name:'Cannot launch yet'}).waitFor();
   await shot(page,'36-built-launch-blocked-install',scheme);await layoutOk(page);
   await d.getByRole('button',{name:'Install Git'}).click();
   await page.getByRole('heading',{name:'Install Git on Commerce host'}).waitFor();
   await page.getByRole('button',{name:'Install Git'}).last().click();
   await page.getByRole('heading',{name:'Git is installed'}).waitFor();
   assert.deepEqual(mock.installs,['git']);
   mock.checkMode='ok';
   await page.getByRole('button',{name:'Check again'}).click();
   await page.getByRole('heading',{name:'Ready to launch'}).waitFor();
   await context.close();
  });
  await scenario('refusal '+tag,async()=>{
   const {context,page}=await open({width,height,scheme});
   mock.checkMode='refusal';
   await openNew(page);await fillCompose(page);await toCheck(page);
   const d=dialog(page);
   await d.getByText('nginx on this server already serves shop2.example.com. DockNest never takes over another site. A build setting in this Compose file is not allowed. (web)').waitFor();
   await d.getByText('Not yet').waitFor();
   await shot(page,'37-built-launch-blocked',scheme);await layoutOk(page);
   mock.checkMode='ok';
   await d.getByRole('button',{name:'Check again'}).click();
   await page.getByRole('heading',{name:'Ready to launch'}).waitFor();
   await context.close();
  });
  await scenario('waiting dns '+tag,async()=>{
   const {context,page}=await open({width,height,scheme});
   mock.launch='waiting_dns';mock.next='done';
   await openNew(page);await fillCompose(page);await toCheck(page);
   await page.getByRole('button',{name:'Launch',exact:true}).click();
   const d=dialog(page);
   await d.getByRole('heading',{name:'shop2.example.com is ready'}).waitFor();
   await d.getByText('Waiting for DNS').waitFor();
   await d.getByText('A shop2.example.com → 192.0.2.10').waitFor();await d.getByText('AAAA shop2.example.com → 2001:db8::10').waitFor();
   assert.equal(await d.getByRole('button',{name:'Open site'}).isDisabled(),true);
   await shot(page,'38-built-launch-waiting-dns',scheme);await layoutOk(page);
   await d.getByRole('button',{name:'Check again'}).click();
   await d.getByRole('heading',{name:'shop2.example.com is live'}).waitFor();
   assert.equal(mock.dnsCalls,1);
   await d.getByText('Launched. Backups and restore tests are on.').waitFor();
   await shot(page,'39-built-launch-done',scheme);await layoutOk(page);
   await context.close();
  });
  await scenario('failed '+tag,async()=>{
   const {context,page}=await open({width,height,scheme});
   mock.launch='failed';
   await openNew(page);await fillCompose(page);await toCheck(page);
   await page.getByRole('button',{name:'Launch',exact:true}).click();
   const d=dialog(page);
   await d.getByRole('heading',{name:'Launch stopped'}).waitFor();
   await d.getByText('The image did not build. Everything was removed.').waitFor();
   await shot(page,'40-built-launch-failed',scheme);await layoutOk(page);
   await d.getByRole('button',{name:'Back'}).click();
   await page.getByRole('heading',{name:'New site'}).waitFor();
   assert.equal(await page.getByLabel('Domain').inputValue(),'shop2.example.com','the form is kept');
   await context.close();
  });
  await scenario('needs attention and certificate '+tag,async()=>{
   const {context,page}=await open({width,height,scheme});
   mock.launch='attention';
   await openNew(page);await fillCompose(page);await toCheck(page);
   await page.getByRole('button',{name:'Launch',exact:true}).click();
   const d=dialog(page);
   await d.getByRole('heading',{name:'Needs your attention'}).waitFor();
   await d.getByText('Cleanup did not finish. Commerce host stays on hold.').waitFor();
   await shot(page,'41-built-launch-needs-attention',scheme);await layoutOk(page);
   await d.getByRole('button',{name:'Try again'}).click();
   await d.getByRole('heading',{name:/Launching/}).waitFor();
   assert.equal(mock.retries,1);
   await context.close();
   const second=await open({width,height,scheme});
   mock.launch='cert';mock.next='done';
   await openNew(second.page);await fillCompose(second.page);await toCheck(second.page);
   await second.page.getByRole('button',{name:'Launch',exact:true}).click();
   const e=dialog(second.page);
   await e.getByText('Certificate failed').waitFor();
   await e.getByText("Let's Encrypt refused it: too many requests. The site runs on HTTP.").waitFor();
   assert.equal(await e.getByText('Failed',{exact:true}).count(),0,'no second Failed row');
   await shot(second.page,'42-built-launch-certificate-failed',scheme);await layoutOk(second.page);
   mock.launch='cert';mock.next='done';
   await e.getByRole('button',{name:'Try again'}).click();
   await e.getByText('Launched. Backups and restore tests are on.').waitFor();
   await second.context.close();
  });
  await scenario('maintenance step '+tag,async()=>{
   const {context,page}=await open({width,height,scheme});
   mock.launch='maintenanceFailed';
   await openNew(page);await fillCompose(page);await toCheck(page);
   await page.getByRole('button',{name:'Launch',exact:true}).click();
   const d=dialog(page);
   await d.getByRole('heading',{name:'shop2.example.com is live'}).waitFor();
   await d.getByText('nginx could not load the maintenance page. Set it up from the site.').waitFor();
   await d.getByText('Launched. Backups and restore tests are on.').waitFor();
   await shot(page,'51-built-launch-maintenance-failed',scheme);await layoutOk(page);
   await context.close();
   // while it runs the step has its own row in the timeline
   const run=await open({width,height,scheme});
   mock.launch='running';
   await openNew(run.page);await fillCompose(run.page);await toCheck(run.page);
   await run.page.getByRole('button',{name:'Launch',exact:true}).click();
   await dialog(run.page).locator('.dn-tl-item',{hasText:'Maintenance page'}).waitFor();
   await run.context.close();
  });
  await scenario('reopen a running launch '+tag,async()=>{
   const {context,page}=await open({width,height,scheme});
   mock.reopen='running';mock.launch='running';
   await gotoMap(page);
   if(phone(page))await page.locator('.map-list-group',{hasText:'Commerce host'}).getByRole('button',{name:'Details'}).click();
   else await page.locator('[data-node="server:a"]').click();
   const panel=page.locator('.map-panel, dialog[open]').last();
   await panel.getByRole('heading',{name:'Commerce host'}).waitFor();
   await panel.getByText('Launches',{exact:true}).waitFor();
   assert.equal(await panel.getByRole('button',{name:/shop2.example.com/}).count(),1,'only launches that are still going are listed');
   await shot(page,'52-built-launch-reopen',scheme);
   await panel.getByRole('button',{name:/shop2.example.com/}).click();
   await dialog(page).getByRole('heading',{name:'Launching shop2.example.com'}).waitFor();
   await dialog(page).getByText('Building the image…').waitFor();
   await context.close();
  });
  await scenario('remove launch '+tag,async()=>{
   const {context,page}=await open({width,height,scheme});
   await openSite(page,'shop2.example.com');
   const panel=page.locator('.map-panel, dialog[open]').last();
   await panel.getByText(/^Launched 3 hours ago\. Removable until /).waitFor();
   assert.equal(await panel.getByText('Launch',{exact:true}).count(),0,'no label above the offer');
   await shot(page,'43-built-remove-launch-offer',scheme);
   await panel.getByRole('button',{name:'Remove launch'}).click();
   const d=dialog(page);
   await d.getByRole('heading',{name:'Remove launch?'}).waitFor();
   await d.getByText(/containers, volumes, the nginx file and the certificate\. Backups stay\./).waitFor();
   mock.needReauth=true;
   await d.getByRole('button',{name:'Remove launch'}).click();
   await d.getByText('Please confirm it is you').waitFor();
   assert.equal(await d.getByRole('button',{name:'Remove launch'}).isDisabled(),true,'waits for the check');
   await shot(page,'44-built-remove-launch-confirm',scheme);await layoutOk(page);
   await reauth(page);
   await dialog(page).getByRole('heading',{name:'Launch removed'}).waitFor();
   assert.equal(mock.removes,1);assert.equal(mock.reauths,1);
   await context.close();
  });
  await scenario('deploy keys '+tag,async()=>{
   const {context,page,offOrigin}=await open({width,height,scheme});
   await openConnections(page);
   const sec=page.locator('section[aria-labelledby=dk-heading]');
   await sec.getByText('Shop deploy key').waitFor();
   await sec.getByText('github.com').waitFor();await sec.getByText('Commerce host').waitFor();await sec.getByText('3 days ago').waitFor();
   await sec.getByText('14 days ago').waitFor();
   assert.equal(await sec.getByRole('button',{name:'New key'}).count(),1);
   for(const b of await sec.locator('.icon-button').all()){assert.ok(await b.getAttribute('aria-label'),'icon button label');assert.ok(await b.getAttribute('title'),'icon button title')}
   await shot(page,'45-built-deploy-keys-list',scheme);
   await sec.getByRole('button',{name:'Copy public key of Shop deploy key'}).click();
   await page.getByText('Public key of Shop deploy key copied.').waitFor();
   assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),PUB);
   // create: form, the server reads the host key (409 HOST_KEY_CONFIRM), confirm, public key
   await sec.getByRole('button',{name:'New key'}).click();
   const d=dialog(page);
   await d.getByRole('heading',{name:'New deploy key'}).waitFor();
   assert.equal(await d.getByRole('button',{name:'Next'}).isDisabled(),true);
   await d.getByLabel('Name').fill('Admin repo key');await d.getByLabel('Git host').fill('github.com');
   await d.getByLabel('Read from').selectOption({label:'Commerce host'});
   await shot(page,'46-built-deploy-key-new',scheme);await layoutOk(page);
   await d.getByRole('button',{name:'Next'}).click();
   await d.getByRole('heading',{name:'Confirm github.com'}).waitFor();
   await d.getByText(FP).waitFor();
   assert.deepEqual(mock.keyCalls[0],['host-key',{gitHost:'github.com',serverId:'a'}]);
   assert.equal(mock.created.length,0,'nothing is created before the confirmation');
   await shot(page,'47-built-deploy-key-host-confirm',scheme);await layoutOk(page);
   mock.needReauth=true;
   await d.getByRole('button',{name:'Pin key'}).click();
   await reauth(page);
   await d.getByRole('heading',{name:'Admin repo key'}).waitFor();
   assert.deepEqual(mock.created[0],{name:'Admin repo key',gitHost:'github.com',serverId:'a',fingerprint:FP});
   await d.getByText('Add it as a read-only deploy key at github.com.').waitFor();
   await d.getByText(PUB).waitFor();
   await d.getByText('github.com, from Commerce host').waitFor();
   await shot(page,'48-built-deploy-key-public',scheme);await layoutOk(page);
   await d.getByRole('button',{name:'Done'}).click();
   await sec.getByText('Admin repo key').waitFor();
   // re-pin after a rotation: the pinned and the new fingerprint, confirm
   mock.hostFp=FP2;
   await sec.getByRole('button',{name:'Re-pin host key of Shop deploy key'}).click();
   await d.getByRole('heading',{name:'Re-pin github.com'}).waitFor();
   await d.getByText('Host key changed').waitFor();await d.getByText(FP2).waitFor();await d.getByText(FP,{exact:true}).waitFor();
   await shot(page,'49-built-deploy-key-repin',scheme);await layoutOk(page);
   mock.needReauth=true;
   await d.getByRole('button',{name:'Re-pin',exact:true}).click();
   await reauth(page);
   await page.getByText('github.com is pinned again.').waitFor();
   assert.equal(mock.pins[0][1].fingerprint,FP2);
   // pinning from another server: the answer says the first server needs the key confirmed again
   mock.movedPin=true;
   await sec.getByRole('button',{name:'Re-pin host key of Docs repo key'}).click();
   await d.getByRole('heading',{name:'Re-pin gitlab.com'}).waitFor();
   await d.getByLabel('Read from').selectOption({label:'Commerce host'});
   await d.getByText('Host key changed').waitFor();
   mock.needReauth=true;
   await d.getByRole('button',{name:'Re-pin',exact:true}).click();
   await reauth(page);
   await d.getByText('Launches on Content host with this key now need the Git host key confirmed from there again.').waitFor();
   await d.getByRole('button',{name:'Done'}).click();
   // delete, then the empty state
   mock.keys=mock.keys.slice(0,1);
   await sec.getByRole('button',{name:/Delete /}).first().click();
   await dialog(page).getByRole('button',{name:'Delete',exact:true}).click();
   await sec.getByText('No deploy keys yet').waitFor();
   await shot(page,'50-built-deploy-keys-empty',scheme);
   assert.deepEqual(offOrigin,[]);
   await context.close();
  });
 }
 await scenario('plus on every server',async()=>{
  const {context,page}=await open({width:1440,height:900});
  await gotoMap(page);
  assert.equal(await page.locator('.map-plus').count(),2,'a + beside every server, also one with sites');
  await page.getByRole('button',{name:'Add a site to Content host'}).click();
  await page.getByRole('heading',{name:'New site'}).waitFor();
  await context.close();
 });
 if(errors.length)throw new Error('Page errors: '+errors.join(' | '));
 console.log('launch browser suite passed');
}finally{await browser.close()}
