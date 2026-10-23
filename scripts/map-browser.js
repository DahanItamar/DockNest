import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

// Read-only Map page against a mocked API: servers, sites and connectors, stable automatic layout on reload, no overlaps,
// zoom and fit, the phone list at 402 px, light and dark, names and roles. Run against a dev server:
// TEST_BASE_URL=http://127.0.0.1:5205. Set SHOTS_DIR to also write screenshots (1440x900 and 402x874, both themes).
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5173',origin=new URL(base).origin,shots=process.env.SHOTS_DIR;
if(shots)await mkdir(shots,{recursive:true});
const long='very-long-site-name-'.repeat(8)+'.example.com';
const state={
 servers:[
  {id:'b',name:'mobiX-Srv',host:'b.example.invalid',port:22,username:'root',status:'connected',capabilities:{freeBytes:13*1024**3}},
  {id:'a',name:'itamar-Srv',host:'a.example.invalid',port:22,username:'root',status:'connected',capabilities:{freeBytes:57*1024**3,dockerVersion:'27.0.1',composeVersion:'2.29.0',nginx:{installed:false},certbot:{installed:true}}},
  {id:'c',name:'Quiet server with a rather long name that must not break',host:'c.example.invalid',port:22,username:'root',status:'failed'},
  {id:'d',name:'zeta-Srv',host:'d.example.invalid',port:22,username:'root',status:'connected'}
 ],
 sites:[
  {id:'1',name:'shop.example.com',serverId:'b',config:{containers:[1,2,3],services:[{container:'db',engine:'postgres',version:'16.2',database:'shop_db'},{container:'cache',engine:'redis',version:'7.4.1'},{container:'app',engine:'generic'}],domains:['shop.example.com']}},
  {id:'2',name:'blog.example.com',serverId:'a',config:{containers:[1],domains:['blog.example.com','www.blog.example.com']}},
  {id:'3',name:long,serverId:'b',config:{containers:[1,2]}},
  {id:'4',name:'api.example.com',serverId:'a'},
  {id:'5',name:'wiki.example.com',serverId:'b'}
 ],
 jobs:[],backups:[{id:'bk1',siteId:'1',capturedAt:new Date().toISOString()},{id:'bk2',siteId:'2'}],policies:[{siteId:'3',enabled:true},{siteId:'4',enabled:false}],audit:[],storage:{used:0,total:1e12},worker:{online:true}
};
const targets={targets:[{id:'t1',name:'nas-backup',kind:'sftp',status:'connected',capacity_bytes:2e12,trackedBytes:8e11},{id:'t2',name:'offsite-s3',kind:'s3',status:'connected',trackedBytes:5e9}],activeTargetId:'t1'};
let browser;const errors=[];
// Mocked move API. Servers: a ok, b home of site 1, c blocked, d long downtime.
// Shapes follow docs/moving-sites.md, "API for the UI".
const mock={discovers:0,tests:0,needNginx:false,jobStatus:'running',installs:[],previews:[],starts:[],cancels:[],continues:[],switchBacks:0,removals:[],resolves:[],tokens:[],cfSaved:false,askRemove:false,listMoves:[],needReauth:false,reauths:0,siteMoving:false,forceAnyway:false,phase:'running',withDns:true};
const HASH='a'.repeat(64);
function preview({siteId,targetServerId,options}){
 const env=options?.envRewrite?.length||options?.askBeforeSwitch?'-opt':'',id='m-'+siteId+'-'+targetServerId+env;
 const base={id,siteId,targetServerId,ok:true,mailBlocked:true,verdict:'ready',sentence:'Shop is ready to move.',needsMoveAnyway:false,estimateSeconds:180,downtimeSeconds:30,undoDays:7,preflightHash:HASH,blockers:[],warnings:[],advanced:{ports:[{from:80,to:80,changed:false},{from:8080,to:8081,changed:true}],nginx:{file:'/etc/nginx/conf.d/docknest-1.conf',notCopied:['client_max_body_size']},envKeys:[{key:'DATABASE_URL',masked:'postgres://203.0.113.7:5432/app',rewrite:false},{key:'REDIS_HOST',masked:'203.0.113.7',rewrite:false}],dns:{mode:'manual',cloudflareAvailable:false},tests:{mailBlocking:'where the server firewall allows it'},checks:[{id:'disk',status:'ok',title:'Disk space',text:'Plenty of room on the new server.'},{id:'port',status:'warn',title:'Ports',text:'Port 8080 is taken, 8081 will be used.'}]}};
const nginx={id:'nginx',status:'block',title:'itamar-Srv needs nginx',text:mock.unsupported?'':'DockNest found Ubuntu 24.04 and can install it for you.',install:{package:'nginx',command:'sudo apt-get update && sudo apt-get install -y nginx',supported:!mock.unsupported,reason:mock.unsupported?'This server packages offer Docker 20.10; this site needs 28 or newer. Install Docker from the Docker repository instead.':undefined}};
 if(mock.needNginx&&targetServerId==='a')return {...base,ok:false,verdict:'blocked',sentence:'Cannot move.',blockers:['itamar-Srv needs nginx. Install it, then try again.'],advanced:{...base.advanced,checks:[nginx]}};
 if(targetServerId==='c'||(mock.blockA&&targetServerId==='a'))return {...base,ok:false,verdict:'blocked',sentence:'Cannot move.',blockers:['This server is not connected. Reconnect it first.']};
 if(targetServerId==='d')return {...base,verdict:'ready-with-notes',needsMoveAnyway:true,mailBlocked:false,estimateSeconds:4000,downtimeSeconds:2400,warnings:[{id:'big',text:'The database is large.',advanced:false,requiresConfirmation:true},{id:'extra',text:'Extra note for the advanced list.',advanced:true}]};
 return base;
}
const NAMES=['Check both servers','Copy to the new server','Test the new copy','Switch','Wait for the domain'];
const stepsFor=phase=>{
 const done={running:2,waiting_switch:3,switching:3,waiting_dns:4,done:5,cancelling:1,cancelled:1,rolling_back:1,rolled_back:0,needs_attention:2}[phase]??0;
 return NAMES.map((label,i)=>({step:'s'+i,label,state:i<done?'done':i===done&&!['cancelled','rolled_back','waiting_switch'].includes(phase)?(phase==='needs_attention'?'failed':'running'):'pending'}));
};
function moveState(){
 const p=mock.phase;
 return {id:'m',state:p,steps:stepsFor(p),progress:{running:40,waiting_switch:60,switching:70,waiting_dns:90,done:100,cancelling:20,cancelled:20,rolling_back:30,rolled_back:0,needs_attention:50}[p]??0,
  statusLine:{running:'Copying to the new server.',waiting_switch:'The new copy works. Ready when you are.',cancelling:'Cancelling and cleaning up.',rolling_back:'Switching back to the old server.',rolled_back:'Your site is back on the old server.'}[p]||'',
  sourceName:'mobiX-Srv',actions:{cancel:p==='running'||p==='waiting_switch',switchBack:p==='done'&&!mock.askRemove,removeOldCopy:p==='done',askRemoveOldCopy:p==='done'&&mock.askRemove,resolve:p==='needs_attention'?['retry','undo']:[]},cancelLabel:p==='cancelling'?'Cancelling...':'Cancel',error:p==='needs_attention'?'The old server did not answer. Check it, then open the move again.':null,
  dns:mock.withDns?{type:'A',name:'shop.example.com',value:'203.0.113.7'}:null};
}

async function open({role='admin',width=1440,height=900,scheme='light',appState=state}={}){
 const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',colorScheme:scheme});
 await context.addInitScript(s=>{try{localStorage.setItem('docknest-theme',s)}catch{}},scheme);
 const page=await context.newPage(),offOrigin=[];
 page.on('pageerror',e=>errors.push(e.message));
 context.on('request',req=>{const u=new URL(req.url());if(!['data:','blob:'].includes(u.protocol)&&u.origin!==origin)offOrigin.push(u.href)});
 await page.route('**/api/**',route=>{
  const endpoint=new URL(route.request().url()).pathname;
  const auth={authenticated:true,setupRequired:false,csrfToken:'fixture',user:{id:'u1',name:'Fixture user',role},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000};
  const req=route.request();
  if(endpoint==='/api/auth/reauth'){const b=req.postDataJSON();if(b.password==='pw'&&b.code==='123456'){mock.needReauth=false;mock.reauths++;return route.fulfill({json:{ok:true}});}return route.fulfill({status:401,json:{error:'No'}});}
  if(endpoint==='/api/settings/cloudflare-dns'){if(req.method()==='PUT'&&mock.needReauth)return route.fulfill({status:403,json:{error:'Please confirm it is you.',code:'REAUTH_REQUIRED'}});if(req.method()==='PUT'){const t=req.postDataJSON().token;if(t==='bad')return route.fulfill({status:400,json:{error:'Cloudflare did not accept this token.'}});mock.tokens.push(t);mock.cfSaved=true;return route.fulfill({json:{configured:true,zones:['example.com'],savedAt:'2026-10-23T00:00:00Z'}});}return route.fulfill({json:{configured:mock.cfSaved}});}
  if(endpoint.startsWith('/api/moves')){
   const parts=endpoint.split('/').filter(Boolean),body=req.postDataJSON?.()||{};
   if(req.method()==='POST'&&parts.length>=4&&mock.needReauth)return route.fulfill({status:403,json:{error:'Please confirm it is you.',code:'REAUTH_REQUIRED'}});
   if(parts.length===2&&req.method()==='POST'&&mock.siteMoving)return route.fulfill({status:409,json:{error:'raw',code:'SITE_MOVING'}});
   if(parts[3]==='start'&&mock.installRunning)return route.fulfill({status:409,json:{error:'An install is running on this server. Wait for it to finish, then try again.',code:'INSTALL_RUNNING'}});
   if(parts[3]==='start'&&mock.forceAnyway){mock.forceAnyway=false;return route.fulfill({status:409,json:{error:'raw',code:'MOVE_ANYWAY_REQUIRED'}});}
   if(parts.length===2&&req.method()==='POST'){mock.previews.push(body);return route.fulfill({status:201,json:preview(body)});}
   if(parts[3]==='start'){if(mock.changeOnce){mock.changeOnce=false;return route.fulfill({status:409,json:{error:'Something changed.',code:'PREFLIGHT_CHANGED'}});}mock.starts.push({id:parts[2],body});mock.phase='running';return route.fulfill({status:202,json:{ok:true}});}
   if(parts[3]==='continue'){mock.continues.push(body.gate);if(body.gate==='dns'&&mock.dnsWrong)return route.fulfill({status:409,json:{error:'The domain still points to the old server.'}});mock.phase=body.gate==='owner-switch'?'waiting_dns':mock.phase;return route.fulfill({json:{ok:true}});}
   if(parts[3]==='cancel'){mock.cancels.push(parts[2]);mock.phase='cancelled';return route.fulfill({json:{ok:true}});}
   if(parts[3]==='switch-back'){mock.switchBacks++;mock.phase='switched_back';return route.fulfill({status:202,json:{ok:true}});}
   if(parts[3]==='remove-old-copy'){if(body.confirmation!=='shop.example.com')return route.fulfill({status:409,json:{error:'The name does not match.'}});mock.removals.push(body);mock.phase='cleaned';return route.fulfill({status:202,json:{ok:true}});}
   if(parts[3]==='resolve'){mock.resolves.push(body.action);mock.phase=body.action==='undo'?'rolling_back':'running';return route.fulfill({json:{ok:true}});}
   if(parts.length===2)return route.fulfill({json:{moves:mock.listMoves}});
   if(parts.length===3)return route.fulfill({json:moveState()});
   return route.fulfill({json:[]});
  }
  if(endpoint==='/api/servers/a/discover'){mock.discovers++;return route.fulfill({json:{containers:[{name:'crm-web',Labels:{'com.docker.compose.project':'crm.example.com','com.docker.compose.service':'web'}},{name:'crm-db',Labels:{'com.docker.compose.project':'crm.example.com','com.docker.compose.service':'db'}},{name:'wiki',Labels:{}}],staticSites:[{documentRoot:'/var/www/landing',name:'landing.example.com',configFiles:[]}]}});}
  if(endpoint==='/api/servers/a/test'){mock.tests++;return route.fulfill({json:{ok:true}});}
  if(endpoint==='/api/storage-targets')return route.fulfill({json:targets});
  if(endpoint==='/api/servers/a/install'&&req.method()==='POST'){if(mock.needReauth)return route.fulfill({status:403,json:{error:'Please confirm it is you.',code:'REAUTH_REQUIRED'}});if(mock.alreadyInstalled)return route.fulfill({status:409,json:{error:'Docker is installed but not running. Start it, then check again.',code:'ALREADY_INSTALLED'}});mock.installs.push(req.postDataJSON());mock.jobStatus='running';return route.fulfill({status:202,json:{job:{id:'j1'}}});}
  if(endpoint==='/api/jobs/j1')return route.fulfill({json:{job:{id:'j1',type:'install',status:mock.jobStatus,details:{steps:[{name:'Connected to itamar-Srv',status:'completed'},{name:'Package list updated',status:mock.jobStatus==='running'?'running':'completed'},{name:'Installing nginx',status:mock.jobStatus==='running'?'pending':'completed'}]}}}});
  if(endpoint==='/api/updates/progress')return route.fulfill({json:{active:false,state:'idle'}});
  return route.fulfill({json:endpoint==='/api/auth/status'?auth:endpoint==='/api/state'?appState:endpoint==='/api/version'?{version:'0.0.0'}:{}});
 });
 await page.goto(base+'/');
 await page.locator('.berry-sidebar').waitFor();
 if(width<900)await page.getByRole('button',{name:'Open navigation'}).click();
 await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Map',exact:true}).click();
 return {context,page,offOrigin};
}
const boxes=(page,sel)=>page.locator(sel).evaluateAll(els=>els.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,id:e.dataset.site||e.id}}));
const overlap=(a,b)=>a.x<b.x+b.w-0.5&&b.x<a.x+a.w-0.5&&a.y<b.y+b.h-0.5&&b.y<a.y+a.h-0.5;
async function fits(page,label){const o=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}));assert.ok(o.sw<=o.cw,label+': horizontal overflow');}
async function shot(page,scheme,size){if(shots)await page.screenshot({path:path.join(shots,`map-${size}-${scheme}.png`)});}
const scaleOf=page=>page.locator('.map-canvas').evaluate(el=>new DOMMatrix(getComputedStyle(el).transform).a);

async function dragSite(page,siteId,serverName,release=true){
 const port=page.locator(`[data-port-site="${siteId}"]`).first(),src=await port.boundingBox(),t=(await page.locator('.map-server',{hasText:serverName}).first().boundingBox());
 await page.mouse.move(src.x+src.width/2,src.y+src.height/2);await page.mouse.down();
 await page.mouse.move(t.x+t.width/2,t.y+t.height/2,{steps:5});
 // A drag that lands while the map is refreshing does not register; callers retry, so do not fail here
 await page.locator('.map-lines path.warn').waitFor({timeout:5000}).catch(()=>{});
 if(release){await page.mouse.up();}
}
async function dragSiteToEmpty(page,siteId){
 const port=page.locator(`[data-port-site="${siteId}"]`).first(),src=await port.boundingBox(),vp=await page.locator('.map-viewport').boundingBox();
 await page.mouse.move(src.x+src.width/2,src.y+src.height/2);await page.mouse.down();
 await page.mouse.move(src.x-40,Math.min(vp.y+vp.height-60,src.y+90),{steps:5});await page.mouse.up();
}
const dialog=page=>page.getByRole('dialog');
async function reverify(page){const d=page.getByRole('dialog');await d.getByLabel('Password').fill('pw');await d.getByLabel('Authenticator code').fill('123456');await d.getByRole('button',{name:'Verify and continue'}).click();await d.getByRole('group',{name:'Please confirm it is you'}).waitFor({state:'detached'});}
async function trapped(page){ // focus stays inside the open dialog after several Tab presses
 for(let i=0;i<8;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('dialog')),true,'focus trapped');}
}
async function moveFlow(page,scheme){
 Object.assign(mock,{previews:[],starts:[],cancels:[],continues:[],switchBacks:0,removals:[],resolves:[],tokens:[],cfSaved:false,askRemove:false,listMoves:[],needReauth:false,reauths:0,siteMoving:false,forceAnyway:false,phase:'running',blockA:false,changeOnce:false,dnsWrong:false,needNginx:false,jobStatus:'running',installs:[]});
 const save=page.getByRole('button',{name:'Save changes'});
 assert.equal(await save.isDisabled(),true,'save starts disabled');
 // Keyboard path: focus a site, press Enter, choose a server
 await page.locator('.map-site[data-site="1"]').focus();await page.keyboard.press('Enter');
 await page.locator('.map-panel').getByRole('button',{name:'Move to…'}).click();
 await dialog(page).getByRole('heading',{name:'Move shop.example.com to'}).waitFor();
 await dialog(page).getByText('This server is not connected. Reconnect it first.').waitFor();
 assert.equal(await dialog(page).getByRole('button',{name:/Quiet server/}).isDisabled(),true);
 await page.waitForFunction(()=>![...document.querySelectorAll('dialog button')].some(b=>/Checking/.test(b.textContent)));
 await dialog(page).getByRole('button',{name:/^itamar-Srv/}).click();
 await page.getByText(/will move to itamar-Srv/).waitFor();
 await page.waitForFunction(()=>!document.querySelector('.map-toolbar .primary').disabled);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(await save.isDisabled(),true);
 // Blocked target: greyed with the reason; nothing pending
 await dragSite(page,'1','Quiet server',false);
 await page.locator('.map-server.blocked').getByText('This server is not connected. Reconnect it first.').waitFor();
 await shot(page,scheme,'1440-1-drag-blocked');
 await page.mouse.up();
 await page.getByText(/cannot move to Quiet server.*not connected/).waitFor();
 assert.equal(await save.isDisabled(),true,'blocked target keeps save off');
 // Valid target
 await dragSite(page,'1','itamar-Srv',false);
 await page.locator('.map-server.target').waitFor();
 await shot(page,scheme,'1440-2-drag');
 await page.mouse.up();
 await page.getByText(/will move to itamar-Srv/).waitFor();
 await page.waitForFunction(()=>!document.querySelector('.map-toolbar .primary').disabled);
 assert.equal(await page.getByRole('button',{name:'Cancel',exact:true}).count(),1);
 await shot(page,scheme,'1440-3-pending');
 // Review dialog: simple summary, advanced collapsed
 await save.click();
 await dialog(page).getByRole('heading',{name:'Ready to move'}).waitFor();
 const d=dialog(page);
 await d.getByText('shop.example.com',{exact:false}).first().waitFor();
 await d.getByText('3 minutes').waitFor();await d.getByText('30 s').waitFor();await d.getByText('7 days').waitFor();
 const adv=d.getByRole('button',{name:'Advanced settings'});
 assert.equal(await adv.getAttribute('aria-expanded'),'false');
 assert.equal(await d.getByText('DATABASE_URL').count(),0,'advanced hidden');
 await shot(page,scheme,'1440-4-review');
 await adv.click();
 assert.equal(await d.getByLabel('DATABASE_URL').isChecked(),false,'env rewrite off by default');
 assert.equal(await d.getByLabel('Ask me before switching').isChecked(),false,'ask before switching off by default');
 await d.getByText('Port 8080 is taken, 8081 will be used.').waitFor();
 await d.getByText('Yes. The test copy cannot send email.').waitFor();
 const cfBox=d.getByLabel('Switch DNS for me (Cloudflare)');
 assert.equal(await cfBox.isDisabled(),true,'needs a saved token first');
 await d.getByLabel('Cloudflare token').fill('bad');await d.getByRole('button',{name:'Save token'}).click();
 await d.getByRole('alert').getByText('Cloudflare did not accept this token.').waitFor();
 await d.getByLabel('Cloudflare token').fill('secret-token-123');mock.needReauth=true;await d.getByRole('button',{name:'Save token'}).click();
 await d.getByRole('group',{name:'Please confirm it is you'}).waitFor();await reverify(page);
 await d.getByText('Cloudflare token: Saved').waitFor();
 assert.deepEqual(mock.tokens,['secret-token-123']);
 assert.equal(await page.evaluate(()=>document.body.innerHTML.includes('secret-token-123')||[...document.querySelectorAll('input')].some(i=>i.value.includes('secret-token'))),false,'token never shown again');
 assert.equal(await cfBox.isChecked(),true);await cfBox.uncheck();
 await shot(page,scheme,'1440-5-advanced');
 await trapped(page);
 // Escape cancels and focus returns to the opener
 await page.keyboard.press('Escape');await dialog(page).waitFor({state:'detached'});
 await page.waitForFunction(()=>document.activeElement?.textContent==='Save changes');
 // Move: start, progress, DNS wait, done
 await save.click();await d.getByRole('heading',{name:'Ready to move'}).waitFor();
 await d.getByRole('button',{name:'Advanced settings'}).click();await d.getByText('Cloudflare token: Saved').waitFor();await d.getByLabel('REDIS_HOST').check();
 await d.getByLabel('Ask me before switching').check();
mock.changeOnce=true;mock.needReauth=true; // the servers changed since the preview; first the sign-in check is asked for
 mock.forceAnyway=true;
 await d.getByRole('button',{name:'Move',exact:true}).click();
 await d.getByRole('group',{name:'Please confirm it is you'}).waitFor();
 await reverify(page);
 await d.getByText('This move needs your OK first',{exact:false}).waitFor();
 assert.equal(mock.starts.length,0);
 await d.getByRole('button',{name:'Move',exact:true}).click();
 await d.getByText(/Something changed on the servers/).waitFor();
 assert.equal(mock.starts.length,0);
 assert.equal(mock.starts.length,0);
 await d.getByRole('button',{name:'Move',exact:true}).click();
 await d.getByRole('heading',{name:'Moving shop.example.com'}).waitFor();
 assert.deepEqual(mock.previews.at(-1).options,{dnsMode:'manual',envRewrite:['REDIS_HOST'],askBeforeSwitch:true});
 assert.equal(mock.starts[0].id,'m-1-a-opt');assert.equal(mock.starts[0].body.preflightHash,'a'.repeat(64));assert.equal(mock.starts[0].body.moveAnyway,undefined);
 await d.getByRole('progressbar').waitFor();assert.equal(await d.getByRole('progressbar').getAttribute('aria-valuenow'),'40');
 await d.getByText('Copying to the new server.').waitFor();
 await d.getByRole('listitem').filter({hasText:'Check both servers'}).getByText('done').waitFor({state:'attached'});
 assert.equal(await d.getByRole('button',{name:'Cancel'}).isEnabled(),true,'cancel before the switch');
 assert.equal(await d.locator('[role=status]').count()>=1,true,'live region');
 await shot(page,scheme,'1440-6-moving');
 mock.phase='waiting_switch';
 await d.getByRole('heading',{name:'shop.example.com is ready to switch'}).waitFor({timeout:6000});
 await shot(page,scheme,'1440-6b-switch');
mock.needReauth=true;await d.getByRole('button',{name:'Switch now'}).click();
 await d.getByRole('group',{name:'Please confirm it is you'}).waitFor();
 await shot(page,scheme,'1440-6c-reauth');
 await d.getByLabel('Password').fill('wrong');await d.getByLabel('Authenticator code').fill('000000');await d.getByRole('button',{name:'Verify and continue'}).click();
 await d.getByRole('alert').getByText('That password or code was not right. Try again.').waitFor();
 await reverify(page);
 assert.deepEqual(mock.continues,['owner-switch']);
 mock.phase='switching';
 await d.getByText('The switch has started and cannot be cancelled.').waitFor({timeout:6000});
 assert.equal(await d.getByRole('button',{name:'Cancel'}).isDisabled(),true,'no cancel after the switch');
 mock.phase='waiting_dns';
 await d.getByText(/Waiting for the domain to point here/).waitFor({timeout:6000});
 await d.getByText('A shop.example.com').waitFor();await d.getByText('203.0.113.7',{exact:false}).waitFor();
 assert.equal(await d.getByRole('button',{name:'Copy'}).count(),1);
 await shot(page,scheme,'1440-7-done');
 await d.getByRole('button',{name:'Copy'}).click();
 mock.dnsWrong=true;await d.getByRole('button',{name:'Check DNS now'}).click();
 await d.getByRole('alert').getByText('The domain still points to the old server.').waitFor();
 assert.ok(mock.continues.includes('dns'));mock.dnsWrong=false;
 mock.phase='done';
 await d.getByText('The domain points to the new server.').waitFor({timeout:6000});
 // Switch back is offered from `actions`; then the old copy can be removed after 7 days
 await d.getByRole('button',{name:'Switch back'}).click();
 await d.getByRole('heading',{name:'Switch back to mobiX-Srv?'}).waitFor();
await d.getByText('stay on itamar-Srv (not copied back)',{exact:false}).waitFor();
 await shot(page,scheme,'1440-7c-switchback');
 await d.getByRole('button',{name:'Cancel'}).click();assert.equal(mock.switchBacks,0);
 await d.getByRole('button',{name:'Switch back'}).click();
 await d.getByRole('heading',{name:'Switch back to mobiX-Srv?'}).waitFor();
 await d.getByRole('button',{name:'Switch back'}).click();
 assert.equal(mock.switchBacks,1);
 await d.getByRole('heading',{name:'shop.example.com is back on mobiX-Srv'}).waitFor({timeout:6000});
 mock.phase='done';mock.askRemove=true;
 mock.listMoves=[{id:'m',siteId:'1',siteName:'shop.example.com',targetServerId:'a',state:'done',actions:{askRemoveOldCopy:true,resolve:[]}}];
 await d.getByRole('button',{name:'Close'}).click();await dialog(page).waitFor({state:'detached'});
 await page.getByText('The old copy can be removed').waitFor();
 await page.getByRole('button',{name:'Open',exact:true}).click();
 await d.getByText('Remove old copy?').waitFor({timeout:6000});
 assert.equal(await d.getByRole('button',{name:'Switch back'}).count(),0,'no switch back after 7 days');
 await d.getByRole('button',{name:'Remove old copy'}).click();
 await d.getByRole('heading',{name:'Remove old copy?'}).waitFor();
 const rm=d.getByRole('button',{name:'Remove old copy'});
 assert.equal(await d.getByLabel('Also delete the old data').isChecked(),false,'delete data unticked');
 assert.equal(await rm.isDisabled(),true,'name required');
 await shot(page,scheme,'1440-7b-remove');
 await d.getByLabel('Type the site name to confirm').fill('shop.example.com');
 await d.getByLabel('Also delete the old data').check();
mock.needReauth=true;await rm.click();
 await d.getByRole('group',{name:'Please confirm it is you'}).waitFor();
 await reverify(page);
 await d.getByRole('heading',{name:'Old copy removed'}).waitFor({timeout:6000});
 await d.getByRole('heading',{name:'Old copy removed'}).waitFor({timeout:6000});
 assert.deepEqual(mock.removals,[{confirmation:'shop.example.com',deleteData:true}]);
 mock.listMoves=[];mock.askRemove=false;
 await d.getByRole('button',{name:'Close'}).click();await dialog(page).waitFor({state:'detached'});
 assert.equal(await save.isDisabled(),true,'pending cleared after finish');
 // Cancel path
 mock.phase='running';
 // The map refreshes after Close; retry the drag until it registers as a pending change
 for(let i=0;i<5&&await save.isDisabled();i++){await page.waitForLoadState('networkidle');await dragSite(page,'1','itamar-Srv');}
 await save.click();
 await d.getByRole('button',{name:'Move',exact:true}).click();
 await d.getByRole('button',{name:'Cancel'}).click();
 await d.getByRole('heading',{name:'Move cancelled'}).waitFor({timeout:6000});
 assert.equal(mock.cancels.length,1);
 await d.getByRole('button',{name:'Close'}).click();
 // Long downtime: warning and "Move anyway"
mock.siteMoving=true;await dragSite(page,'1','zeta-Srv');await save.click();
 await d.getByText('This site is already being moved. Wait for that move to finish.').waitFor();
 await d.getByRole('button',{name:'Cancel'}).click();mock.siteMoving=false;
 await dragSite(page,'1','zeta-Srv');await save.click();
 await d.getByText(/offline for a long time/).waitFor();
 const go=d.getByRole('button',{name:'Move',exact:true});
 assert.equal(await go.isDisabled(),true,'long downtime blocks until confirmed');
 await shot(page,scheme,'1440-8-warning');
 await d.getByLabel('I accept about 40 minutes offline').check();assert.equal(await go.isEnabled(),true);
 await go.click();
 await d.getByRole('heading',{name:'Moving shop.example.com'}).waitFor();
 assert.equal(mock.starts.at(-1).body.moveAnyway,true,'Move anyway is sent');
 // Failure, undo and attention states
 mock.phase='cancelling';
 await d.getByRole('heading',{name:'Cancelling the move'}).waitFor({timeout:6000});
 assert.equal(await d.getByRole('button',{name:'Cancelling...'}).isDisabled(),true);
 mock.phase='rolling_back';
 await d.getByRole('heading',{name:'Undoing the move'}).waitFor({timeout:6000});
 mock.phase='needs_attention';
 await d.getByRole('alert').getByText('The old server did not answer.',{exact:false}).waitFor({timeout:6000});
 await shot(page,scheme,'1440-8b-attention');
 await d.getByRole('button',{name:'Try again'}).waitFor();
 await d.getByRole('button',{name:'Undo'}).click();
 assert.deepEqual(mock.resolves,['undo']);
 mock.phase='rolled_back';
 await d.getByRole('heading',{name:'Move undone'}).waitFor({timeout:6000});
 await d.getByText('Your site is back on the old server.').first().waitFor();
 await d.getByRole('button',{name:'Close'}).click();
 // Blocked at review time: plain red sentence, no Move
 await dragSite(page,'1','itamar-Srv');mock.blockA=true;await save.click();
 await d.getByRole('heading',{name:'Cannot move yet'}).waitFor();
 await d.getByRole('alert').getByText('This server is not connected. Reconnect it first.').waitFor();
 assert.equal(await d.getByRole('button',{name:'Move',exact:true}).isDisabled(),true);
 await shot(page,scheme,'1440-9-blocked');
 await d.getByRole('button',{name:'Cancel'}).click();mock.blockA=false;
}

async function stateIsClean(page,label){
 const save=page.getByRole('button',{name:'Save changes'});
 assert.equal(await save.isDisabled(),true,label+': save stays off');
 assert.equal(await page.getByRole('button',{name:'Cancel',exact:true}).count(),0,label+': nothing to cancel');
 assert.equal(await page.locator('.map-lines path.warn, .map-lines path.pending').count(),0,label+': no changed line');
 assert.equal(await page.locator('.map-site.lost').count(),0,label+': no site is unconnected');
}
// Details and add panels: one at a time, same size, Escape and Close, focus returns to what opened them.
async function panelChecks(page,scheme){
 const panel=page.locator('.map-panel'),save=page.getByRole('button',{name:'Save changes'});
 const sizes=[];
 const size=async()=>{const b=await panel.boundingBox();sizes.push([Math.round(b.width),Math.round(b.height)])};
 // Clicking a node opens its details and never starts a change
 await page.locator('.map-site[data-site="1"]').click();
 await panel.getByRole('heading',{name:'shop.example.com'}).waitFor();
 assert.equal(await panel.getByRole('heading',{name:'shop.example.com'}).evaluate(e=>document.activeElement===e),true,'panel title is focused on open');
 await panel.getByText('PostgreSQL 16.2 · shop_db').waitFor();await panel.getByText('Redis 7.4.1').waitFor();
 assert.equal(await panel.getByText('Generic').count()+await panel.getByText('app',{exact:true}).count(),0,'only detected databases are listed');
 await panel.getByText('Moves together with the site.').waitFor();
 await panel.getByText(/^Today .*, passed$/).waitFor();
 assert.equal(await panel.locator('dd',{hasText:/^3$/}).count(),1,'containers show a count, never indexes');
 assert.equal(await panel.getByText('1, 2, 3').count(),0);
 await panel.getByText('nas-backup').waitFor();await panel.getByText('mobiX-Srv').waitFor();
 assert.equal(await panel.getByRole('button',{name:'Open site'}).count(),1);assert.equal(await panel.getByRole('button',{name:'Move to…'}).count(),1);
 assert.equal(await save.isDisabled(),true,'a click is not a change');
 assert.equal(await page.locator('.map-lines path.warn, .map-lines path.pending').count(),0);
 assert.equal(await page.locator('.map-db, .map-domain').count(),0,'no database or domain nodes');
 await size();await shot(page,scheme,'1440-2a-details-site');
 // Only one panel at a time: a server replaces it. Escape closes it and focus returns to the node
 await page.locator('.map-server[data-node="server:b"]').click();
 await panel.getByRole('heading',{name:'mobiX-Srv'}).waitFor();assert.equal(await panel.count(),1);
 await panel.getByText('Docker').first().waitFor();await size();
 await page.keyboard.press('Escape');await panel.waitFor({state:'detached'});
 await page.waitForFunction(()=>document.activeElement?.dataset?.node==='server:b');
 // Keyboard: Enter on a node
 await page.locator('.map-storage').first().focus();await page.keyboard.press('Enter');
 await panel.getByRole('heading',{name:'nas-backup'}).waitFor();await panel.getByText('Backed up here').waitFor();
 await panel.getByText('shop.example.com').waitFor();await size();
 assert.equal(await panel.getByRole('button',{name:'Open storage'}).count(),1);
 await panel.getByRole('button',{name:'Close'}).click();await panel.waitFor({state:'detached'});
 await page.waitForFunction(()=>document.activeElement?.dataset?.node==='storage:t1');
 // Server tools: a missing one offers Install, using the install flow
 await page.locator('.map-server[data-node="server:a"]').click();
 await panel.getByText('27.0.1').waitFor();await panel.getByText('Missing').waitFor();await panel.getByText('Installed').waitFor();
 await size();await shot(page,scheme,'1440-2b-details-server');
 await panel.getByRole('button',{name:'Install nginx'}).click();
 const d=dialog(page);
 await d.getByRole('heading',{name:'Install nginx on itamar-Srv'}).waitFor();
 Object.assign(mock,{needReauth:false,installs:[],jobStatus:'running',tests:0});
 await d.locator('.map-dialog-foot').getByRole('button',{name:'Install nginx'}).click();
 await d.getByRole('heading',{name:'Installing nginx'}).waitFor();
 mock.jobStatus='completed';
 await d.getByRole('heading',{name:'nginx is installed'}).waitFor({timeout:6000});
 await d.getByRole('button',{name:'Check again'}).click();
 await dialog(page).waitFor({state:'detached'});
 assert.equal(mock.tests,1,'server is checked again');
 await panel.getByRole('heading',{name:'itamar-Srv'}).waitFor();
 await panel.getByRole('button',{name:'Close'}).click();
 // "+" at the top right: add a server or backup storage with the existing screens
 const plus=page.getByRole('button',{name:'Add to the map'});
 await plus.click();
 await panel.getByRole('heading',{name:'Add to the map'}).waitFor();
 await panel.getByText('Connect another server by SSH').waitFor();await panel.getByText('A place to keep backups').waitFor();
 await size();await shot(page,scheme,'1440-2c-add');
 await panel.getByRole('searchbox',{name:'Search'}).fill('stor');
 assert.equal(await panel.getByRole('button',{name:/^Server/}).count(),0,'search filters');
 await panel.getByRole('searchbox',{name:'Search'}).fill('');
 await page.keyboard.press('Escape');await panel.waitFor({state:'detached'});
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Add to the map');
 await plus.click();await panel.getByRole('button',{name:/^Server/}).click();
 await page.getByRole('dialog',{name:'Connect a server'}).waitFor();
 await page.getByRole('button',{name:'Close dialog'}).click();await page.getByRole('dialog').waitFor({state:'detached'});
 // "+" on a server: discovered sites that are not added yet
 await page.getByRole('button',{name:'Add a site to itamar-Srv'}).click();
 await panel.getByRole('heading',{name:'Add to itamar-Srv'}).waitFor();
 await panel.getByText('Found on this server (3)').waitFor();
 await panel.getByText('Docker · 2 containers').waitFor();await panel.getByText('nginx site · static files').waitFor();
 assert.equal(await panel.getByText('Discover again').count(),1);
 await size();await shot(page,scheme,'1440-2d-add-server');
 await panel.getByRole('searchbox',{name:'Search'}).fill('crm');
 assert.equal(await panel.locator('.map-row').count(),1,'search filters sites');
 await panel.getByRole('searchbox',{name:'Search'}).fill('');
 // Footer: "Not listed?" on the left, "Discover again" on the right edge
 const pb=await panel.boundingBox(),nl=await panel.getByText('Not listed?').boundingBox(),da=await panel.getByRole('button',{name:'Discover again'}).boundingBox();
 assert.ok(nl.x-pb.x<24,'Not listed? on the left');assert.ok(pb.x+pb.width-(da.x+da.width)<=24,'Discover again on the right edge');
 const before=mock.discovers;await panel.getByRole('button',{name:'Discover again'}).click();
 await page.waitForFunction(n=>true,before);await panel.getByText('Found on this server (3)').waitFor();
 assert.ok(mock.discovers>before,'discovery runs again');
 for(const z of sizes)assert.deepEqual(z,sizes[0],'every panel is the same size');
 // A row opens the existing Add site wizard with that site already chosen
 await panel.getByRole('button',{name:/crm.example.com/}).click();
 await panel.waitFor({state:'detached'});
 const w=page.getByRole('dialog',{name:'Discover & add a site'});await w.waitFor();
 await w.getByRole('button',{name:'Select site crm.example.com'}).waitFor();
 await page.waitForFunction(()=>document.querySelector('[aria-label="Select site crm.example.com"]')?.getAttribute('aria-pressed')==='true');
 await page.getByRole('button',{name:'Close dialog'}).click();await page.getByRole('dialog').waitFor({state:'detached'});
 // Open server goes to the existing Servers page, then back to the map
 await page.locator('.map-server[data-node="server:b"]').click();
 await panel.getByRole('button',{name:'Open server'}).click();
 await page.getByRole('heading',{level:1,name:'Servers'}).waitFor();
 await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Map',exact:true}).click();
 await page.locator('.map-site').first().waitFor();
 await page.getByRole('button',{name:'Fit to screen'}).click();
}

async function reconnectChecks(page,scheme){
 const save=page.getByRole('button',{name:'Save changes'});
 // Pull the line off the server and let go in empty space: not connected, save is off with the reason
 await dragSiteToEmpty(page,'3');
 await page.locator('.map-site.lost').waitFor();
 await page.getByText('Connect every site to a server to save').waitFor();
 assert.equal(await save.isDisabled(),true,'save is off while a site is not connected');
 await page.locator('.map-site.lost .map-caption',{hasText:'Not connected'}).waitFor();
 assert.equal(await page.locator('.map-lines path.warn').count(),1,'dashed amber line');
 assert.equal(await page.locator('.map-lines path.wire').count(),4,'other lines stay');
 assert.equal((await save.evaluate(e=>getComputedStyle(e).backgroundColor))===(await page.getByRole('button',{name:'Cancel',exact:true}).evaluate(e=>getComputedStyle(e).backgroundColor)),false,'save looks disabled');
 await shot(page,scheme,'1440-3b-not-connected');
 // Only one change at a time
 const p5=await page.locator('[data-port-site="5"]').first().boundingBox();await page.mouse.move(p5.x+p5.width/2,p5.y+p5.height/2);await page.mouse.down();
 await page.getByText('Save or cancel the current change first.').waitFor();
 await page.mouse.up();
 // Cancel restores the line
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await stateIsClean(page,'after cancel');
 assert.equal(await page.locator('.map-lines path.wire').count(),5,'line restored');
 // Dropping it back on its own server undoes the change
 await dragSiteToEmpty(page,'3');await page.locator('.map-site.lost').waitFor();
 await dragSite(page,'3','mobiX-Srv');
 await page.locator('.map-live',{hasText:'stays on mobiX-Srv'}).waitFor();
 await stateIsClean(page,'back on its own server');
 // Reconnect to a different server: the existing move, save is on and the warning is gone
 await dragSiteToEmpty(page,'3');await page.locator('.map-site.lost').waitFor();
 await dragSite(page,'3','itamar-Srv');
 await page.waitForFunction(()=>!document.querySelector('.map-toolbar .primary').disabled);
 assert.equal(await page.getByText('Connect every site to a server to save').count(),0);
 assert.equal(await page.locator('.map-lines path.pending').count(),1,'new line');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 // Keyboard: Delete disconnects, Enter opens "Connect to", the sheet connects
 const card=page.locator('.map-site[data-site="3"]');
 await card.focus();await page.keyboard.press('Delete');
 await page.locator('.map-site.lost').waitFor();
 await card.focus();await page.keyboard.press('Enter');
 await page.locator('.map-panel').getByRole('button',{name:'Move to…'}).click();
 const d=dialog(page);
 await d.getByRole('heading',{name:/^Connect .* to$/}).waitFor();
 await page.waitForFunction(()=>![...document.querySelectorAll('dialog button')].some(b=>/Checking/.test(b.textContent)));
 await d.getByRole('button',{name:/^mobiX-Srv/}).click();
 await page.locator('.map-live',{hasText:'stays on mobiX-Srv'}).waitFor();
 await stateIsClean(page,'keyboard reconnect');
}
async function installFlow(page,scheme){
 const d=dialog(page),save=page.getByRole('button',{name:'Save changes'});
 if(await page.getByRole('button',{name:'Cancel',exact:true}).count())await page.getByRole('button',{name:'Cancel',exact:true}).click();
 Object.assign(mock,{needNginx:true,needReauth:false,installs:[],jobStatus:'running',blockA:false});
 await dragSite(page,'1','itamar-Srv');
 await page.waitForFunction(()=>!document.querySelector('.map-toolbar .primary').disabled);
 await save.click();
 await d.getByRole('heading',{name:'Cannot move yet'}).waitFor();
 await d.getByText('itamar-Srv needs nginx.',{exact:false}).first().waitFor();
 const sizes=[],feet=[];
 const measure=async()=>{sizes.push(await d.boundingBox());feet.push(await d.locator('.map-dialog-foot button').evaluateAll(bs=>bs.map(b=>{const r=b.getBoundingClientRect();return [r.x,r.y,r.width,r.height].map(Math.round)})))};
 await measure();
 await shot(page,scheme,'1440-9b-install-needed');
 assert.equal(await d.getByRole('button',{name:'Install nginx'}).count(),1);
 // Show command: code box, Copy, Check again
 await d.getByRole('button',{name:'Show command'}).click();
 await d.getByRole('heading',{name:'Install nginx yourself'}).waitFor();
 await d.getByText('sudo apt-get update && sudo apt-get install -y nginx').waitFor();
 await d.getByRole('button',{name:'Copy'}).waitFor();
 await measure();await shot(page,scheme,'1440-9c-command');
 await d.getByRole('button',{name:'Close'}).click();
 await d.getByRole('heading',{name:'Cannot move yet'}).waitFor();
 // Install: needs a fresh sign-in check, then the progress
 await d.getByRole('button',{name:'Install nginx'}).click();
 await d.getByRole('heading',{name:'Install nginx on itamar-Srv'}).waitFor();
 await measure();
 mock.needReauth=true;
 await d.locator('.map-dialog-foot').getByRole('button',{name:'Install nginx'}).click();
 await d.getByRole('group',{name:'Please confirm it is you'}).waitFor();
 await shot(page,scheme,'1440-9d-install-confirm');
 await reverify(page);
 await d.getByRole('heading',{name:'Installing nginx'}).waitFor();
 assert.deepEqual(mock.installs,[{package:'nginx'}]);
 await d.getByText('Connected to itamar-Srv').waitFor();
 assert.equal(await d.getByRole('button',{name:'Check again'}).isDisabled(),true,'check again waits for the install');
 await measure();await shot(page,scheme,'1440-9e-installing');
 mock.jobStatus='completed';mock.needNginx=false;
 await d.getByRole('heading',{name:'nginx is installed'}).waitFor({timeout:6000});
 await d.getByRole('button',{name:'Check again'}).click();
 await d.getByRole('heading',{name:'Ready to move'}).waitFor();
 await measure();
 for(const s of sizes){assert.equal(s.width,sizes[0].width,'same sheet width');assert.equal(s.height,sizes[0].height,'same sheet height');assert.equal(s.x,sizes[0].x);assert.equal(s.y,sizes[0].y)}
 for(const f of feet)assert.deepEqual(f.at(-1),feet[0].at(-1),'primary button in the same place on every step');
 for(const f of feet)assert.deepEqual(f.at(-2),feet[0].at(-2),'secondary button in the same place on every step');
 await d.getByRole('button',{name:'Cancel'}).click();
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 // Unsupported systems: a plain note, no Install button; the command only when it is known
 mock.needNginx=true;mock.unsupported=true;
 await dragSite(page,'1','itamar-Srv');await save.click();
 await d.getByRole('heading',{name:'Cannot move yet'}).waitFor();
 assert.equal(await d.getByRole('button',{name:'Install nginx'}).count(),0);
 await d.getByText('packages offer Docker 20.10',{exact:false}).waitFor();
 assert.equal(await d.getByText('DockNest cannot install',{exact:false}).count(),0,'the reason replaces the generic line');
 assert.equal(await d.getByRole('button',{name:'Show command'}).count(),1);
 await d.getByRole('button',{name:'Cancel'}).click();
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 mock.needNginx=true;mock.unsupported=false;mock.alreadyInstalled=true;
 await dragSite(page,'1','itamar-Srv');await save.click();
 await d.getByRole('button',{name:'Install nginx'}).first().click();
 await d.locator('.map-dialog-foot').getByRole('button',{name:'Install nginx'}).click();
 await d.getByRole('alert').getByText('Docker is installed but not running. Start it, then check again.').waitFor();
 assert.equal(await d.locator('.map-dialog-foot').getByRole('button',{name:'Check again'}).count(),1);
 mock.alreadyInstalled=false;mock.needNginx=false;
 await d.locator('.map-dialog-foot').getByRole('button',{name:'Check again'}).click();
 await d.getByRole('heading',{name:'Ready to move'}).waitFor();
 mock.installRunning=true;
 await d.getByRole('button',{name:'Move',exact:true}).click();
 await d.getByRole('alert').getByText('An install is running on this server.',{exact:false}).waitFor();
 mock.installRunning=false;
 await d.getByRole('button',{name:'Cancel'}).click();
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 mock.needNginx=false;mock.unsupported=false;
}

browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
try{
 for(const scheme of ['light','dark']){
  // Desktop canvas
  {
   const {context,page,offOrigin}=await open({scheme});
   await page.getByRole('heading',{level:1,name:'Map'}).waitFor();
   assert.equal(await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Map',exact:true}).getAttribute('aria-current'),'page');
   assert.equal(await page.locator('.map-server').count(),4,'servers');
   assert.equal(await page.locator('.map-site').count(),5,'sites');
   assert.equal(await page.locator('.map-lines path.wire').count(),5,'connectors');
   assert.equal(await page.locator('.map-port.in.grab').count(),5,'incoming ports of sites');
   assert.equal(await page.locator('.map-db, .map-domain').count(),0,'no database or domain nodes on the canvas');
   assert.equal(await page.locator('.map-storage').count(),2,'backup storage');
   assert.equal(await page.locator('.map-lines path.backup').count(),3,'backup lines');
   assert.equal(await page.locator('.map-stub').count(),2,'open outputs');
   await page.getByText('1.1 TB free of 1.8 TB').waitFor();
   // Order: servers by name
   const names=await page.locator('.map-server .map-name').allTextContents();
   assert.deepEqual(names,[...names].sort((x,y)=>x.toLowerCase()<y.toLowerCase()?-1:1),'server order');
   // Groups and status labels
   const g=page.getByRole('group',{name:'itamar-Srv'});
   assert.equal(await g.locator('.map-site').count(),2);
   await g.getByText('Connected').waitFor();await g.getByText('2 sites · 57.0 GB free').waitFor();
   await page.getByText('Needs attention').waitFor();
   assert.ok(await page.locator('.map-lines').getAttribute('aria-hidden')==='true');
   // No overlaps (screen space)
   const all=[...await boxes(page,'.map-server'),...await boxes(page,'.map-site'),...await boxes(page,'.map-storage')];
   for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++)assert.ok(!overlap(all[i],all[j]),'overlap '+i+' '+j);
   // Long names truncate inside the card
   const card=page.locator('.map-site',{hasText:'very-long-site-name'});
   assert.ok(await card.locator('.map-name').evaluate(e=>e.scrollWidth>e.clientWidth),'truncated');
   assert.equal(await card.getAttribute('title'),long);
   // The map takes the height left on screen: the map and the hint below it are fully visible without scrolling
   assert.ok(await page.locator('.map-hint').evaluate(e=>e.getBoundingClientRect().bottom<=window.innerHeight),'hint in view');
   // The map always opens at 100%; nodes are never shrunk to make a big map fit
   assert.ok(Math.abs(await scaleOf(page)-1)<0.001,'opens at 100%');
   const vp=await page.locator('.map-viewport').boundingBox(),first=(await boxes(page,'.map-server'))[0];
   assert.ok(first.x>=vp.x-1&&first.y>=vp.y-1,'the first server is in view');
   assert.ok(parseFloat(await page.locator(".map-site .map-name").first().evaluate(e=>getComputedStyle(e).fontSize))===14,"card text uses body size");
   // Auto layout is stable across a reload
   const before=JSON.stringify(await boxes(page,'.map-site'));
   await page.reload();
   await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Map',exact:true}).click();
   await page.locator('.map-site').first().waitFor();
   assert.equal(JSON.stringify(await boxes(page,'.map-site')),before,'stable layout');
   assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>/map|layout|position/i.test(k)).length),0,'nothing persisted');
   // Fit shrinks the map when asked, down to the minimum, and everything is then inside the viewport
   await page.getByRole('button',{name:'Fit to screen'}).click();
   const kFit=await scaleOf(page);assert.ok(kFit>=0.45-0.001&&kFit<1,"fit scale between 45% and 100%");
   if(kFit>0.451)for(const b of [...await boxes(page,'.map-server'),...await boxes(page,'.map-site'),...await boxes(page,'.map-storage')])assert.ok(b.x>=vp.x-1&&b.y>=vp.y-1&&b.x+b.w<=vp.x+vp.width+1&&b.y+b.h<=vp.y+vp.height+1,"inside after fit");
   // Zoom buttons, keyboard, fit
   const k0=await scaleOf(page);
   await page.getByRole('button',{name:'Zoom in'}).click();assert.ok(await scaleOf(page)>k0,'zoom in');
   await page.getByRole('button',{name:'Zoom out'}).click();await page.getByRole('button',{name:'Zoom out'}).click();assert.ok(await scaleOf(page)<k0,'zoom out');
   await page.getByRole('button',{name:'Fit to screen'}).click();assert.ok(Math.abs(await scaleOf(page)-k0)<0.001,'fit restores');
   const viewport=page.locator('.map-viewport');await viewport.focus();
   const x0=(await boxes(page,'.map-server'))[0].x;await page.keyboard.press('ArrowRight');
   assert.ok((await boxes(page,'.map-server'))[0].x<x0,'keyboard pan');
   await page.keyboard.press('+');assert.ok(await scaleOf(page)>k0,'keyboard zoom');
   await page.keyboard.press('0');assert.ok(Math.abs(await scaleOf(page)-k0)<0.001,'keyboard fit');
   const m=await viewport.boundingBox();
   await page.mouse.move(m.x+m.width/2,m.y+m.height/2);await page.mouse.wheel(0,-300);
   await page.waitForFunction(k=>new DOMMatrix(getComputedStyle(document.querySelector('.map-canvas')).transform).a>k,k0);
   await page.getByRole('button',{name:'Fit to screen'}).click();
   await panelChecks(page,scheme);
   await reconnectChecks(page,scheme);
   await moveFlow(page,scheme);
   await installFlow(page,scheme);
   await page.getByRole('button',{name:'Fit to screen'}).click();
   await fits(page,'desktop '+scheme);
   await shot(page,scheme,'1440');
   assert.deepEqual(offOrigin,[],'off-origin requests');
   await context.close();
  }
  // Disabled Save is a grey filled button in its toolbar row, and a state change never shrinks the map
  {
   const {context,page}=await open({scheme});
   await page.locator('.map-site').first().waitFor();
   const save=page.getByRole('button',{name:'Save changes'});
   assert.equal(await save.isDisabled(),true);
   assert.equal(await save.evaluate(e=>{const bg=el=>getComputedStyle(el).backgroundColor,own=bg(e);let p=e.parentElement;while(p&&/rgba\(0, 0, 0, 0\)|transparent/.test(bg(p)))p=p.parentElement;return own!==bg(p||document.body)&&!/rgba\(0, 0, 0, 0\)/.test(own)}),true,'disabled save is a filled grey button');
   const row=await page.locator('.map-toolbar').boundingBox(),sb=await save.boundingBox();
   assert.ok(sb.y>=row.y-1&&sb.y+sb.height<=row.y+row.height+1&&sb.height>=39,'save sits inside its toolbar row');
   await page.locator('.map-site[data-site="3"]').focus();await page.keyboard.press('Delete');
   await page.locator('.map-site.lost').waitFor();
   assert.ok(Math.abs(await scaleOf(page)-1)<0.001,'still 100% after disconnecting a site');
   await page.getByRole('button',{name:'Cancel',exact:true}).click();
   assert.ok(Math.abs(await scaleOf(page)-1)<0.001,'still 100% after cancelling');
   await page.locator('.map-site[data-site="3"]').focus();await page.keyboard.press('Delete');
   const note=await page.locator('.map-live').textContent();assert.ok(note.length<120&&note.includes('…'),'long names are shortened in the status line');
   assert.equal(await page.locator('.map-live').evaluate(e=>e.getBoundingClientRect().height<=40),true,'status line stays on one or two short lines');
   await shot(page,scheme,'1440-3c-not-connected-100');
   await context.close();
  }
  // Large screen: still 100%, centred, and fully in view
  {
   const {context,page}=await open({width:2551,height:1257,scheme});
   await page.locator('.map-site').first().waitFor();
   assert.ok(Math.abs(await scaleOf(page)-1)<0.001,'100% on a large screen');
   await page.locator('.map-site[data-site="1"]').click();await page.locator('.map-panel').waitFor();
   await shot(page,scheme,'2551');
   await context.close();
  }
  // Operator: read only, no save button
  {
   const {context,page}=await open({role:'operator',scheme});
   await page.locator('.map-site').first().waitFor();
   assert.equal(await page.getByRole('button',{name:/Save changes/}).count(),0);
   assert.equal(await page.locator('.map-site.movable').count(),0);
   await page.locator('.map-viewport').focus();
   assert.equal(await page.getByRole('button',{name:'Cancel',exact:true}).count(),0);
   const src=(await boxes(page,'.map-site'))[0];await page.mouse.move(src.x+10,src.y+10);await page.mouse.down();await page.mouse.move(src.x+10,src.y+300,{steps:4});await page.mouse.up();
   assert.equal(await page.locator('.map-lines path.warn').count(),0,'operators cannot drag');
   assert.equal(await page.locator('[data-port-site]').count(),0,'operators have no grab handles');
   assert.equal(await page.locator('.map-storage').count(),0,'operators do not load storage');
   assert.equal(await page.getByRole('button',{name:'Add to the map'}).count()+await page.locator('.map-plus').count(),0,'operators cannot add');
   await page.locator('.map-site').first().click();
   await page.locator('.map-panel').getByRole('button',{name:'Open site'}).waitFor();
   assert.equal(await page.locator('.map-panel').getByRole('button',{name:'Move to…'}).count(),0,'operators cannot move');
   await context.close();
  }
  // Phone list
  {
   const {context,page}=await open({width:402,height:874,scheme});
   await page.locator('.map-list').waitFor();
   assert.equal(await page.locator('.map-canvas').count(),0,'no canvas on phone');
     const heads=await page.locator('.map-list h2').allTextContents();
   assert.deepEqual(heads,['itamar-Srv','mobiX-Srv','Quiet server with a rather long name that must not break','zeta-Srv','Backup storage']);
   assert.equal(await page.locator('.map-list li').count(),5);
   await page.getByText('No sites on this server yet.').first().waitFor();
   assert.equal(await page.getByRole('list').filter({hasText:'blog.example.com'}).count()>=1,true);
   await fits(page,'phone '+scheme);
   // Details and Add site are full-screen sheets with the same footer in the same place
   await page.getByRole('listitem').filter({hasText:'shop.example.com'}).getByRole('button',{name:'Details'}).click();
   const sheet=dialog(page);
   await sheet.getByRole('heading',{name:'shop.example.com'}).waitFor();await sheet.getByText('PostgreSQL 16.2 · shop_db').waitFor();
   const foot1=await sheet.locator('.map-dialog-foot').boundingBox();
   await shot(page,scheme,'402-0-details');
   await page.keyboard.press('Escape');await sheet.waitFor({state:'detached'});
   await page.locator('.map-list-group',{hasText:'itamar-Srv'}).getByRole('button',{name:'Add site'}).click();
   await sheet.getByRole('heading',{name:'Add to itamar-Srv'}).waitFor();await sheet.getByText('Found on this server (3)').waitFor();
   assert.deepEqual(await sheet.locator('.map-dialog-foot').boundingBox(),foot1,'footer stays put');
   await sheet.getByText('Not listed?').waitFor();
   for(const b of await sheet.getByRole('button').all())assert.ok((await b.boundingBox()).height>=43.5,'phone buttons 44px');
   await shot(page,scheme,'402-0-add-site');
   await sheet.getByRole('button',{name:'Close'}).first().click();await sheet.waitFor({state:'detached'});
   await fits(page,'phone panels '+scheme);
   // Move to... opens the same dialogs as full-screen sheets
   Object.assign(mock,{previews:[],starts:[],cancels:[],continues:[],switchBacks:0,removals:[],resolves:[],tokens:[],cfSaved:false,askRemove:false,listMoves:[],needReauth:false,reauths:0,siteMoving:false,forceAnyway:false,phase:'running',blockA:false,changeOnce:false,dnsWrong:false});
   await page.getByRole('listitem').filter({hasText:'shop.example.com'}).getByRole('button',{name:'Move to…'}).click();
   const d=dialog(page);
   await d.getByRole('heading',{name:'Move shop.example.com to'}).waitFor();
   await d.getByText('This server is not connected. Reconnect it first.').waitFor();
   assert.equal(await d.getByRole('button',{name:/Quiet server/}).isDisabled(),true,'blocked target greyed');
   await page.waitForFunction(()=>[...document.querySelectorAll('dialog button')].every(b=>!/Checking/.test(b.textContent)));
   const box=await d.boundingBox();assert.ok(box.width>=401&&box.height>=873,'full-screen sheet');
   // Long reasons wrap inside their card, and opening the sheet focuses the title, not Cancel
   assert.equal(await d.locator('.map-targets button').evaluateAll(bs=>bs.every(b=>[b,...b.children].every(e=>e.scrollWidth<=e.clientWidth+1))),true,'target text stays inside the card');
   assert.equal(await page.evaluate(()=>document.activeElement?.tagName),'H2','title focused on open');
   await shot(page,scheme,'402-1-target');
   await d.getByRole('button',{name:/^itamar-Srv/}).click();
   await d.getByRole('heading',{name:'Ready to move'}).waitFor();
   for(const b of await d.getByRole('button').all())assert.ok((await b.boundingBox()).height>=43.5,'phone buttons 44px');
   await fits(page,'phone sheet '+scheme);await shot(page,scheme,'402-2-review');
   await d.getByRole('button',{name:'Move',exact:true}).click();
   await d.getByRole('heading',{name:'Moving shop.example.com'}).waitFor();await d.getByText('Copying to the new server.').waitFor();
   await shot(page,scheme,'402-3-moving');
   mock.phase='waiting_dns';
   await d.getByText(/Waiting for the domain to point here/).waitFor({timeout:6000});
   await fits(page,'phone done '+scheme);await shot(page,scheme,'402-4-done');
   await d.getByRole('button',{name:'Close'}).click();
   assert.equal(mock.starts.length,1);
   await page.evaluate(()=>window.scrollTo(0,0));
   await shot(page,scheme,'402');
   await context.close();
  }
 }
 // Empty state and tablet width list
 {
  const {context,page}=await open({appState:{...state,servers:[],sites:[]}});
  await page.getByText('Nothing to show yet').waitFor();await context.close();
 }
 {
  const {context,page}=await open({appState:{...state,servers:state.servers.slice(0,2),sites:state.sites.slice(0,2)}});
  await page.locator('.map-site').first().waitFor();
  assert.ok(Math.abs(await scaleOf(page)-1)<0.001,'small maps stay at 100%');assert.equal(await page.locator('.map-fade').count(),0,'no fade when everything fits');await context.close();
 }
 {
  // A big map still opens at 100% at the top left, with the out-of-view hint; Fit shrinks it
  const servers=Array.from({length:6},(_,i)=>({id:'big'+i,name:'Server '+(i+1),host:'h'+i+'.example.invalid',port:22,username:'root',status:'connected'}));
  const sites=Array.from({length:20},(_,i)=>({id:'bs'+i,name:'site-'+String(i).padStart(2,'0')+'.example.com',serverId:'big'+(i%6),config:{containers:[1]}}));
  const {context,page}=await open({appState:{...state,servers,sites,backups:[],policies:[]}});
  await page.locator('.map-site').first().waitFor();
  assert.ok(Math.abs(await scaleOf(page)-1)<0.001,'big map opens at 100%');
  await page.locator('.map-fade').waitFor();await page.getByText('Part of the map is out of view',{exact:false}).waitFor();
  const vp=await page.locator('.map-viewport').boundingBox(),s1=(await boxes(page,'.map-server'))[0];
  assert.ok(s1.x>=vp.x&&s1.y>=vp.y&&s1.y<vp.y+vp.height/2,'the first server is at the top left');
  await page.getByRole('button',{name:'Fit to screen'}).click();
  assert.ok(await scaleOf(page)<0.99,'Fit shrinks a big map');
  await page.keyboard.press('Escape');
  await context.close();
 }
 {
  const {context,page}=await open({width:760,height:900});
  await page.locator('.map-list').waitFor();await fits(page,'tablet');await context.close();
 }
 assert.deepEqual(errors,[],'page errors');
 console.log('Map browser checks passed.');
}finally{await browser.close();}
