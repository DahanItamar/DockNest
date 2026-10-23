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
  {id:'a',name:'itamar-Srv',host:'a.example.invalid',port:22,username:'root',status:'connected',capabilities:{freeBytes:57*1024**3}},
  {id:'c',name:'Quiet server with a rather long name that must not break',host:'c.example.invalid',port:22,username:'root',status:'failed'},
  {id:'d',name:'zeta-Srv',host:'d.example.invalid',port:22,username:'root',status:'connected'}
 ],
 sites:[
  {id:'1',name:'shop.example.com',serverId:'b',config:{containers:[1,2,3]}},
  {id:'2',name:'blog.example.com',serverId:'a',config:{containers:[1]}},
  {id:'3',name:long,serverId:'b',config:{containers:[1,2]}},
  {id:'4',name:'api.example.com',serverId:'a'},
  {id:'5',name:'wiki.example.com',serverId:'b'}
 ],
 jobs:[],backups:[],policies:[],audit:[],storage:{used:0,total:1e12},worker:{online:true}
};
let browser;const errors=[];
// Mocked move API. Servers: a ok, b home of site 1, c blocked, d long downtime.
// Shapes follow docs/moving-sites.md, "API for the UI".
const mock={previews:[],starts:[],cancels:[],continues:[],switchBacks:0,removals:[],resolves:[],tokens:[],cfSaved:false,askRemove:false,listMoves:[],needReauth:false,reauths:0,siteMoving:false,forceAnyway:false,phase:'running',withDns:true};
const HASH='a'.repeat(64);
function preview({siteId,targetServerId,options}){
 const env=options?.envRewrite?.length||options?.askBeforeSwitch?'-opt':'',id='m-'+siteId+'-'+targetServerId+env;
 const base={id,siteId,targetServerId,ok:true,mailBlocked:true,verdict:'ready',sentence:'Shop is ready to move.',needsMoveAnyway:false,estimateSeconds:180,downtimeSeconds:30,undoDays:7,preflightHash:HASH,blockers:[],warnings:[],advanced:{ports:[{from:80,to:80,changed:false},{from:8080,to:8081,changed:true}],nginx:{file:'/etc/nginx/conf.d/docknest-1.conf',notCopied:['client_max_body_size']},envKeys:[{key:'DATABASE_URL',masked:'postgres://203.0.113.7:5432/app',rewrite:false},{key:'REDIS_HOST',masked:'203.0.113.7',rewrite:false}],dns:{mode:'manual',cloudflareAvailable:false},tests:{mailBlocking:'where the server firewall allows it'},checks:[{id:'disk',status:'ok',title:'Disk space',text:'Plenty of room on the new server.'},{id:'port',status:'warn',title:'Ports',text:'Port 8080 is taken, 8081 will be used.'}]}};
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
 const src=(await boxes(page,`.map-site[data-site="${siteId}"]`))[0],t=(await page.locator('.map-server',{hasText:serverName}).first().boundingBox());
 await page.mouse.move(src.x+src.w/2,src.y+src.h/2);await page.mouse.down();
 await page.mouse.move(t.x+t.width/2,t.y+t.height/2,{steps:5});
 await page.locator('.map-lines path.drag').waitFor();
 if(release){await page.mouse.up();}
}
const dialog=page=>page.getByRole('dialog');
async function reverify(page){const d=page.getByRole('dialog');await d.getByLabel('Password').fill('pw');await d.getByLabel('Authenticator code').fill('123456');await d.getByRole('button',{name:'Verify and continue'}).click();await d.getByRole('group',{name:'Please confirm it is you'}).waitFor({state:'detached'});}
async function trapped(page){ // focus stays inside the open dialog after several Tab presses
 for(let i=0;i<8;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('dialog')),true,'focus trapped');}
}
async function moveFlow(page,scheme){
 Object.assign(mock,{previews:[],starts:[],cancels:[],continues:[],switchBacks:0,removals:[],resolves:[],tokens:[],cfSaved:false,askRemove:false,listMoves:[],needReauth:false,reauths:0,siteMoving:false,forceAnyway:false,phase:'running',blockA:false,changeOnce:false,dnsWrong:false});
 const save=page.getByRole('button',{name:'Save changes'});
 assert.equal(await save.isDisabled(),true,'save starts disabled');
 // Keyboard path: focus a site, press Enter, choose a server
 await page.locator('.map-site[data-site="1"]').focus();await page.keyboard.press('Enter');
 await dialog(page).getByRole('heading',{name:'Move shop.example.com to'}).waitFor();
 await dialog(page).getByText('This server is not connected. Reconnect it first.').waitFor();
 assert.equal(await dialog(page).getByRole('button',{name:/Quiet server/}).isDisabled(),true);
 await page.waitForFunction(()=>![...document.querySelectorAll('dialog button')].some(b=>/Checking/.test(b.textContent)));
 await dialog(page).getByRole('button',{name:/^itamar-Srv/}).click();
 await page.getByText(/will move to itamar-Srv/).waitFor();
 await page.waitForFunction(()=>!document.querySelector('.map-toolbar .primary').disabled);
 await page.getByRole('button',{name:'Undo change'}).click();
 assert.equal(await save.isDisabled(),true);
 await page.locator('.map-fade').waitFor();await page.getByText('Part of the map is out of view',{exact:false}).waitFor();
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
 assert.equal(await page.getByRole('button',{name:'Undo change'}).count(),1);
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
   assert.equal(await page.locator('.map-lines path:not(.drag)').count(),5,'connectors');
   assert.equal(await page.locator('.map-handle').count(),4+5,'connection handles');
   assert.equal(await page.locator('.map-handle').first().evaluate(e=>e.getBoundingClientRect().width>0),true);
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
   const all=[...await boxes(page,'.map-server'),...await boxes(page,'.map-site')];
   for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++)assert.ok(!overlap(all[i],all[j]),'overlap '+i+' '+j);
   // Long names truncate inside the card
   const card=page.locator('.map-site',{hasText:'very-long-site-name'});
   assert.ok(await card.locator('.map-name').evaluate(e=>e.scrollWidth>e.clientWidth),'truncated');
   assert.equal(await card.getAttribute('title'),long);
   // Fit shows everything inside the viewport
   const vp=await page.locator('.map-viewport').boundingBox();
   const kFit=await scaleOf(page);assert.ok(kFit>=0.85-0.001&&kFit<=1,"fit scale between 85% and 100%");
   if(kFit>0.851)for(const b of all)assert.ok(b.x>=vp.x-1&&b.y>=vp.y-1&&b.x+b.w<=vp.x+vp.width+1&&b.y+b.h<=vp.y+vp.height+1,"inside after fit");
   assert.ok(parseFloat(await page.locator(".map-site .map-name").first().evaluate(e=>getComputedStyle(e).fontSize))===14,"card text uses body size");
   // Auto layout is stable across a reload
   const before=JSON.stringify(await boxes(page,'.map-site'));
   await page.reload();
   await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Map',exact:true}).click();
   await page.locator('.map-site').first().waitFor();
   assert.equal(JSON.stringify(await boxes(page,'.map-site')),before,'stable layout');
   assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>/map|layout|position/i.test(k)).length),0,'nothing persisted');
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
   await moveFlow(page,scheme);
   await page.getByRole('button',{name:'Fit to screen'}).click();
   await fits(page,'desktop '+scheme);
   await shot(page,scheme,'1440');
   assert.deepEqual(offOrigin,[],'off-origin requests');
   await context.close();
  }
  // Operator: read only, no save button
  {
   const {context,page}=await open({role:'operator',scheme});
   await page.locator('.map-site').first().waitFor();
   assert.equal(await page.getByRole('button',{name:/Save changes/}).count(),0);
   assert.equal(await page.locator('.map-site.movable').count(),0);
   await page.locator('.map-viewport').focus();
   assert.equal(await page.getByRole('button',{name:'Undo change'}).count(),0);
   const src=(await boxes(page,'.map-site'))[0];await page.mouse.move(src.x+10,src.y+10);await page.mouse.down();await page.mouse.move(src.x+10,src.y+300,{steps:4});await page.mouse.up();
   assert.equal(await page.locator('.map-lines path.drag').count(),0,'operators cannot drag');
   await context.close();
  }
  // Phone list
  {
   const {context,page}=await open({width:402,height:874,scheme});
   await page.locator('.map-list').waitFor();
   assert.equal(await page.locator('.map-canvas').count(),0,'no canvas on phone');
     const heads=await page.locator('.map-list h2').allTextContents();
   assert.deepEqual(heads,['itamar-Srv','mobiX-Srv','Quiet server with a rather long name that must not break','zeta-Srv']);
   assert.equal(await page.locator('.map-list li').count(),5);
   await page.getByText('No sites on this server yet.').first().waitFor();
   assert.equal(await page.getByRole('list').filter({hasText:'blog.example.com'}).count()>=1,true);
   await fits(page,'phone '+scheme);
   // Move to... opens the same dialogs as full-screen sheets
   Object.assign(mock,{previews:[],starts:[],cancels:[],continues:[],switchBacks:0,removals:[],resolves:[],tokens:[],cfSaved:false,askRemove:false,listMoves:[],needReauth:false,reauths:0,siteMoving:false,forceAnyway:false,phase:'running',blockA:false,changeOnce:false,dnsWrong:false});
   await page.getByRole('listitem').filter({hasText:'shop.example.com'}).getByRole('button',{name:'Move to…'}).click();
   const d=dialog(page);
   await d.getByRole('heading',{name:'Move shop.example.com to'}).waitFor();
   await d.getByText('This server is not connected. Reconnect it first.').waitFor();
   assert.equal(await d.getByRole('button',{name:/Quiet server/}).isDisabled(),true,'blocked target greyed');
   await page.waitForFunction(()=>[...document.querySelectorAll('dialog button')].every(b=>!/Checking/.test(b.textContent)));
   const box=await d.boundingBox();assert.ok(box.width>=401&&box.height>=873,'full-screen sheet');
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
  const {context,page}=await open({width:760,height:900});
  await page.locator('.map-list').waitFor();await fits(page,'tablet');await context.close();
 }
 assert.deepEqual(errors,[],'page errors');
 console.log('Map browser checks passed.');
}finally{await browser.close();}
