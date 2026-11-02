import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

// Launch a new site from the Map (docs/launch-site.md) against a mocked API: both sources, the check with install offers
// (including git), the trust warning with the fresh sign-in check, the timeline, waiting DNS, failure, needs attention,
// certificate failed, the Remove launch offer and the Deploy keys section, on desktop and a 390 px phone, light and dark.
// Waits are on conditions; every timestamp is seeded in the past. Run against a dev server:
// TEST_BASE_URL=http://127.0.0.1:5205. Set SHOTS_DIR to also write screenshots of the built screens.
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
const KEYS=[{id:'k1',name:'Shop deploy key',gitHost:'github.com',pinnedFromServerId:'a',pinnedFromName:'Commerce host',createdAt:ago(3*86400)},{id:'k2',name:'Docs repo key',gitHost:'gitlab.com',pinnedFromServerId:'b',pinnedFromName:'Content host',createdAt:ago(14*86400)}];
const PUB='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ7vQ2mK4nT0xS9fHq3Lw8bYzR1uE6cVdPaGhN5oXtZk docknest-shop-deploy-key',FP='SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',FP2='SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s';
const steps=(done,running,failed)=>[['check','Check'],['fetch','Fetch source'],['build','Build'],['start','Start'],['check_health','Health check'],['web','nginx and certificate'],['first_backup','First backup'],['restore_test','Restore test scheduled']].map(([step,label],i)=>({step,label,state:i<done?'done':i===failed?'failed':i===running?'running':'pending',...(i<done||i===running||i===failed?{startedAt:ago(300-i*30),finishedAt:i<done?ago(290-i*30):null}:{}),...(i===failed?{detail:'The nginx file could not be removed'}:{})}));
let mock,browser;const errors=[];
const reset=()=>{mock={checkMode:'ok',checks:[],launches:[],reauths:0,needReauth:false,launch:null,dnsCalls:0,retries:0,removes:0,installs:[],keys:KEYS.map(k=>({...k})),keyCalls:[],hostFp:FP,created:[],repins:[]}};
reset();
const okChecks=[{id:'docker',title:'Docker',status:'ok',value:'28.1'},{id:'compose',title:'Compose',status:'ok',value:'2.29'},{id:'nginx',title:'nginx',status:'ok',value:'1.26'},{id:'port',title:'Port 443',status:'ok',value:'Free'},{id:'dns',title:'DNS',status:'ok',value:'Points here'}];
function checkResult(body){
 if(mock.checkMode==='nginx')return {ok:false,checks:okChecks.map(c=>c.id==='nginx'?{...c,status:'block',value:'Missing',install:{package:'nginx',command:'sudo apt-get install -y nginx',supported:true}}:c.id==='compose'?c:c).concat([{id:'git',title:'Git',status:'block',value:'Missing',install:{package:'git',command:'sudo apt-get install -y git',supported:true}}]),blockers:['nginx is missing. Install it to continue.','Git is missing.']};
 if(mock.checkMode==='port')return {ok:false,checks:okChecks.map(c=>c.id==='port'?{...c,status:'block',value:'In use'}:c.id==='dns'?{...c,status:'block',value:'Other server'}:c),blockers:['Port 443 is used by another program.','shop2.example.com points to another server.']};
 return {ok:true,checks:okChecks,warnings:[],services:[{name:'web',ports:[8080]},{name:'db',ports:[]}],webService:'web',builds:body.source==='git'};
}
const LAUNCH_STATES={
 running:()=>({id:'l1',state:'running',domain:'shop2.example.com',statusLine:'Building the image…',steps:steps(2,2),actions:{cancel:true}}),
 waiting_dns:()=>({id:'l1',state:'waiting_dns',domain:'shop2.example.com',steps:steps(8,-1),backups:'Daily',restoreTests:'Weekly',dns:{type:'A',name:'shop2.example.com',value:'192.0.2.10'}}),
 done:()=>({id:'l1',state:'done',domain:'shop2.example.com',steps:steps(8,-1),backups:'Daily',restoreTests:'Weekly',certificate:{state:'ok'}}),
 failed:()=>({id:'l1',state:'failed',domain:'shop2.example.com',reason:'The image did not build. Everything was removed.',steps:steps(2,-1,2)}),
 attention:()=>({id:'l1',state:'needs_attention',domain:'shop2.example.com',reason:'Cleanup did not finish. Commerce host stays on hold.',steps:steps(4,-1,4)}),
 cert:()=>({id:'l1',state:'done',domain:'shop2.example.com',backups:'Daily',restoreTests:'Weekly',steps:steps(8,-1),certificate:{state:'failed',reason:"Let's Encrypt refused it: too many requests."}})
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
  if(endpoint==='/api/deploy-keys'&&m==='GET')return json({keys:mock.keys});
  if(endpoint==='/api/deploy-keys/host-key'){mock.keyCalls.push(['host-key',body]);return json({fingerprint:mock.hostFp,gitHost:body.gitHost})}
  if(endpoint==='/api/deploy-keys'&&m==='POST'){if(mock.needReauth)return reauth();mock.created.push(body);const k={id:'k'+(mock.keys.length+1),name:body.name,gitHost:body.gitHost,pinnedFromServerId:body.serverId,pinnedFromName:'Commerce host',createdAt:ago(5),publicKey:PUB,fingerprint:body.fingerprint};mock.keys.push(k);return json({key:k},201)}
  let mm=endpoint.match(/^\/api\/deploy-keys\/([^/]+)(?:\/(.+))?$/);
  if(mm){const k=mock.keys.find(x=>x.id===mm[1]);
   if(m==='GET')return json({key:{...k,publicKey:PUB,fingerprint:FP}});
   if(mm[2]==='host-key')return json({fingerprint:FP2,previous:FP,gitHost:k.gitHost});
   if(mm[2]==='repin'){if(mock.needReauth)return reauth();mock.repins.push([mm[1],body]);return json({key:k})}
   if(m==='DELETE'){if(mock.needReauth)return reauth();mock.keys=mock.keys.filter(x=>x.id!==mm[1]);return json({deleted:true})}}
  if(endpoint==='/api/servers/a/launch/check'){mock.checks.push(body);return json(checkResult(body))}
  if(endpoint==='/api/servers/a/launch'){if(mock.needReauth)return reauth();mock.launches.push(body);mock.launch=mock.launch||'running';return json({launch:{id:'l1'}},202)}
  mm=endpoint.match(/^\/api\/launches\/([^/]+)(?:\/(.+))?$/);
  if(mm){
   if(mm[2]==='check-dns'){mock.dnsCalls++;mock.launch=mock.next||'done';return json({ok:true})}
   if(mm[2]==='retry'){mock.retries++;mock.launch='running';return json({ok:true})}
   if(mm[2]==='cancel'){mock.launch='failed';return json({ok:true})}
   if(mm[2]==='remove'){if(mock.needReauth)return reauth();mock.removes++;mock.launch='removed';return json({ok:true},202)}
   return json(mock.launch==='removed'?{id:'l1',state:'removed',domain:'shop2.example.com'}:LAUNCH_STATES[mock.launch||'running']());
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
async function openNew(page,server='Commerce host'){
 await gotoMap(page);
 if(phone(page))await page.locator('.map-list-group',{hasText:server}).getByRole('button',{name:'Add site'}).click();
 else await page.getByRole('button',{name:'Add a site to '+server}).click();
 await page.getByRole('button',{name:/New site/}).click();
 await page.getByRole('heading',{name:'New site'}).waitFor();
}
const dialog=page=>page.locator('dialog[open]').last();
async function shot(page,name,scheme){if(!shots)return;await page.mouse.move(2,2);await page.waitForTimeout(80);await page.screenshot({path:`${shots}/${name}-${phone(page)?'phone':'desktop'}-${scheme}.png`,animations:'disabled'})}
// No sideways scroll and every button in the dialog footer has the same height and one line.
async function layoutOk(page){
 const r=await page.evaluate(()=>{
  const d=[...document.querySelectorAll('dialog[open]')].pop();if(!d)return {ok:true};
  const bs=[...d.querySelectorAll('.map-dialog-foot button')].filter(b=>b.offsetParent!==null);
  const hs=[...new Set(bs.map(b=>Math.round(b.getBoundingClientRect().height)))];
  const lines=bs.every(b=>b.getBoundingClientRect().height<64);
  return {sideways:document.documentElement.scrollWidth>innerWidth+1||d.scrollWidth>d.clientWidth+1,hs,lines};
 });
 assert.ok(!r.sideways,'sideways scroll');assert.ok(r.hs?.length<=1,'footer buttons differ in height: '+r.hs);assert.ok(r.lines!==false,'a footer button wraps');
}
async function fillCompose(page,domain='shop2.example.com'){
 await page.getByRole('textbox',{name:'Compose file'}).fill('services:\n  web:\n    image: demo/shop:1.5\n    ports:\n      - "8080:8080"\n  db:\n    image: postgres:16\n');
 await page.getByLabel('Domain').fill(domain);
}
async function toCheck(page){await page.getByRole('button',{name:'Check',exact:true}).click();await page.getByRole('heading',{name:/Ready to launch|Cannot launch yet/}).waitFor()}
async function reauth(page){
 await page.getByText('Please confirm it is you').waitFor();
 await page.getByLabel('Password').fill('pw');await page.getByLabel('Authenticator code').fill('123456');
 await page.getByRole('button',{name:'Verify and continue'}).click();
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
   assert.deepEqual(mock.checks[0],{source:'compose',compose:'services:\n  web:\n    image: demo/shop:1.5\n    ports:\n      - "8080:8080"\n  db:\n    image: postgres:16\n',webService:'web',domain:'shop2.example.com'});
   assert.equal(await d.getByText(/builds and runs code/).count(),0,'no trust warning for a pasted Compose file without a build');
   await shot(page,'32-built-launch-check',scheme);await layoutOk(page);
   // Launch asks for the fresh sign-in check, then goes
   mock.needReauth=true;
   await page.getByRole('button',{name:'Launch',exact:true}).click();
   await reauth(page);
   await page.getByRole('heading',{name:'Launching shop2.example.com'}).waitFor();
   assert.equal(mock.reauths,1);
   assert.deepEqual(mock.launches[0].env,{SECRET_KEY:'s3cret'});
   assert.equal(mock.launches[0].webService,'web');
   await d.getByText('Building the image…').waitFor();
   await d.getByRole('progressbar').waitFor();
   assert.ok(await d.locator('.dn-tl-item').count()>=8,'a timeline of the steps');
   assert.ok((await d.locator('.dn-tl-dur').allTextContents()).some(x=>/min|\ds/.test(x)),'durations from seeded times');
   await shot(page,'33-built-launch-progress',scheme);await layoutOk(page);
   // Closing keeps it running
   await page.getByRole('button',{name:'Close',exact:true}).click();
   await page.locator('dialog[open]').waitFor({state:'detached'});
   assert.deepEqual(offOrigin,[]);
   await context.close();
  });
  await scenario('git '+tag,async()=>{
   const {context,page}=await open({width,height,scheme});
   await openNew(page);
   await page.getByRole('tab',{name:'Git repository'}).click();
   await page.getByLabel('Repository URL').fill('https://git.example.com/shop/demo-shop.git');
   await page.getByLabel('Branch or tag').fill('v1.4.2');
   await page.getByLabel('Compose file').fill('deploy/compose.yaml');
   await page.getByLabel('Deploy key').selectOption({label:'Shop deploy key'});
   await page.getByLabel('Domain').fill('shop2.example.com');
   assert.equal(await dialog(page).getByLabel('Backups').inputValue(),'daily');
   await dialog(page).getByLabel('Restore tests').selectOption('monthly');
   await shot(page,'34-built-launch-git',scheme);await layoutOk(page);
   await toCheck(page);
   assert.deepEqual(mock.checks[0],{source:'git',repo:'https://git.example.com/shop/demo-shop.git',ref:'v1.4.2',composePath:'deploy/compose.yaml',deployKeyId:'k1',domain:'shop2.example.com'});
   await dialog(page).getByText('This builds and runs code from the repository on Commerce host. Only use repositories you trust.').waitFor();
   await dialog(page).getByLabel('Web service').selectOption('web');
   await shot(page,'35-built-launch-trust',scheme);await layoutOk(page);
   await page.getByRole('button',{name:'Launch',exact:true}).click();
   await page.getByRole('heading',{name:'Launching shop2.example.com'}).waitFor();
   assert.equal(mock.launches[0].source,'git');assert.equal(mock.launches[0].restoreTests,'monthly');assert.equal(mock.launches[0].deployKeyId,'k1');assert.equal(mock.launches[0].env.constructor,Object);
   await context.close();
  });
  await scenario('install offers '+tag,async()=>{
   const {context,page}=await open({width,height,scheme});
   mock.checkMode='nginx';
   await openNew(page);await fillCompose(page);await toCheck(page);
   const d=dialog(page);
   await d.getByRole('heading',{name:'Cannot launch yet'}).waitFor();
   assert.equal(await page.getByRole('button',{name:'Launch',exact:true}).isDisabled(),true);
   await d.getByRole('button',{name:'Install nginx'}).waitFor();await d.getByRole('button',{name:'Install Git'}).waitFor();await d.getByRole('button',{name:'Show command'}).waitFor();
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
  await scenario('blocked refusal '+tag,async()=>{
   const {context,page}=await open({width,height,scheme});
   mock.checkMode='port';
   await openNew(page);await fillCompose(page);await toCheck(page);
   const d=dialog(page);
   await d.getByText('Port 443 is used by another program. shop2.example.com points to another server.').waitFor();
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
   await d.getByText('A shop2.example.com → 192.0.2.10').waitFor();
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
   await shot(second.page,'42-built-launch-certificate-failed',scheme);await layoutOk(second.page);
   mock.launch='cert';mock.next='done';
   await e.getByRole('button',{name:'Try again'}).click();
   await e.getByText('Launched. Backups and restore tests are on.').waitFor();
   await second.context.close();
  });
 }
 for(const [width,height,scheme] of [[1440,900,'light'],[390,844,'dark'],[1440,900,'dark'],[390,844,'light']]){
  const tag=`${width}-${scheme}`;
  await scenario('remove launch '+tag,async()=>{
   const {context,page}=await open({width,height,scheme});
   await openSite(page,'shop2.example.com');
   const panel=page.locator('.map-panel, dialog[open]').last();
   await panel.getByText(/Launched 3 hours ago\. You can remove it until /).waitFor();
   await panel.getByText(/The first backup stays\./).waitFor();
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
   await shot(page,'45-built-deploy-keys-list',scheme);
   // copy the public key
   await sec.getByRole('button',{name:'Copy public key of Shop deploy key'}).click();
   await page.getByText('Public key of Shop deploy key copied.').waitFor();
   assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),PUB);
   // create: form, host key confirm, public key
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
   // re-pin after a rotation
   await sec.getByRole('button',{name:'Re-pin host key of Shop deploy key'}).click();
   await d.getByRole('heading',{name:'Re-pin github.com'}).waitFor();
   await d.getByText('Host key changed').waitFor();await d.getByText(FP2).waitFor();
   await shot(page,'49-built-deploy-key-repin',scheme);await layoutOk(page);
   await d.getByRole('button',{name:'Re-pin',exact:true}).click();
   await page.getByText('github.com is pinned again.').waitFor();
   assert.equal(mock.repins[0][1].fingerprint,FP2);
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
 if(errors.length)throw new Error('Page errors: '+errors.join(' | '));
 console.log('launch browser suite passed');
}finally{await browser.close()}
