import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

// Domains on the Map and on the app pages (docs/domains.md) against a mocked API: the Domains column and its toggle, one path
// panel per state (all good, certificate failing, wrong DNS, CGNAT, Cloudflare token, checking, never checked, check error,
// partial, points nowhere), the app panel's Domains section, the Move review warnings, the phone list, the viewer who sees no
// domains, and that nothing is checked until someone presses the button. Light and dark, 1280 and 390 px (no horizontal scroll).
// Run against a dev server or the built app: TEST_BASE_URL=http://127.0.0.1:5173. Set SHOTS_DIR to also write screenshots.
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5173',shots=process.env.SHOTS_DIR,now=Date.now();
if(shots)await mkdir(shots,{recursive:true});
const SHOP='5e0f3b1c-6a2d-4c8e-9f10-2b3c4d5e6f70',WIKI='6a1f3b1c-6a2d-4c8e-9f10-2b3c4d5e6f71',HOME='7b2f3b1c-6a2d-4c8e-9f10-2b3c4d5e6f72';
const servers=[
 {id:'s1',name:'Server 1',host:'192.0.2.10',port:22,username:'root',status:'connected',capabilities:{freeBytes:61*1024**3}},
 {id:'s2',name:'Server 2',host:'192.0.2.20',port:22,username:'root',status:'connected',capabilities:{freeBytes:85*1024**3}}
];
const sites=[
 {id:SHOP,name:'Shop',serverId:'s1',config:{containers:['shop-web','shop-db'],domains:['shop.example.invalid','www.shop.example.invalid','wiki.example.invalid']}},
 {id:WIKI,name:'Ledger',serverId:'s1',config:{containers:['ledger-web'],domains:['ledger.example.invalid','never.example.invalid']}},
 {id:HOME,name:'Home',serverId:'s2',config:{containers:['home-web'],domains:['home.example.invalid','blog.example.invalid']}}
];
const state={servers,sites,policies:[],backups:[],jobs:[],restores:[],audit:[],storage:{used:0,total:1e12},worker:{online:true},maintenance:{}};
const hop=(state,reason,params)=>({state,reason,...(params?{params}:{})});
const skipped=hop('unknown','skipped');
const checkedAt=new Date(now-3*3600e3).toISOString();
const row=(domain,serverId,siteId,hops,trigger='backup')=>({domain,serverId,siteId,hops,worst:hops?Object.values(hops).reduce((w,h)=>({ok:0,unknown:1,warn:2,fail:3}[h.state]>{ok:0,unknown:1,warn:2,fail:3}[w]?h.state:w),'ok'):'unknown',checkedAt:hops?checkedAt:null,trigger:hops?trigger:null});
const good=(extra={})=>({dns:hop('ok','points-to-server',{addresses:['192.0.2.10'],serverId:'s1'}),proxy:hop('ok','routed',{proxy:'nginx',serverId:'s1',upstream:'http://127.0.0.1:8083'}),app:hop('ok','running'),certificate:hop('ok','valid',{name:'example.invalid',notAfter:'2027-01-02T00:00:00Z'}),...extra});
const domainRows=()=>[
 row('shop.example.invalid','s1',SHOP,good()),
 row('www.shop.example.invalid','s1',SHOP,good({proxy:hop('warn','incomplete',{proxy:'traefik',serverId:'s1',upstream:'http://shop-web:8080'})})),
 row('wiki.example.invalid','s1',SHOP,good({certificate:hop('warn','renewal-port80',{name:'wiki.example.invalid',notAfter:'2027-01-02T00:00:00Z'})})),
 row('never.example.invalid','s1',WIKI,null),
 row('home.example.invalid','s2',HOME,{dns:hop('warn','cgnat',{address:'198.51.100.7'}),proxy:hop('ok','routed',{proxy:'caddy',serverId:'s2',upstream:'http://127.0.0.1:3000'}),app:hop('ok','running'),certificate:hop('unknown','managed-by-proxy',{proxy:'caddy'})}),
 row('blog.example.invalid','s2',HOME,{dns:hop('warn','cloudflare-token-expired'),proxy:hop('ok','routed',{proxy:'nginx',serverId:'s2',upstream:'http://127.0.0.1:2368'}),app:hop('ok','running'),certificate:hop('ok','valid',{name:'blog.example.invalid',notAfter:'2027-03-01T00:00:00Z'})}),
 row('ledger.example.invalid',null,WIKI,{dns:hop('fail','wrong-record',{address:'192.0.2.99'}),proxy:skipped,app:skipped,certificate:skipped}),
 row('old.example.invalid',null,null,{dns:hop('fail','no-record'),proxy:skipped,app:hop('unknown','no-app'),certificate:skipped})
];
const groups={servers:{s1:['shop.example.invalid','www.shop.example.invalid','wiki.example.invalid','never.example.invalid'],s2:['home.example.invalid','blog.example.invalid']},pointsNowhere:['ledger.example.invalid','old.example.invalid'],unplaced:[]};
const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
const errors=[];
const shot=async(page,name,theme,width)=>{if(shots)await page.screenshot({path:`${shots}/${name}-${width}-${theme}.png`})};
const noOverflow=page=>page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth);

// scenario: {role, domains (rows), failJob, holdJob (a promise the job waits for), deniedDomains}. calls records every domain request.
const asLink=async(loc,label,w)=>{await loc.waitFor();const s=await loc.evaluate(e=>{const c=getComputedStyle(e);return {bw:parseFloat(c.borderTopWidth)+parseFloat(c.borderLeftWidth),bg:c.backgroundColor,td:c.textDecorationLine,sw:document.documentElement.scrollWidth}});assert.equal(s.bw,0,label+' has no border');assert.ok(/rgba\(0, 0, 0, 0\)|transparent/.test(s.bg),label+' has no fill: '+s.bg);assert.ok(s.td.includes('underline'),label+' is underlined');assert.ok(s.sw<=w,label+' does not overflow at '+w)};
async function open(theme,width,scenario={}){
 const {role='admin',failJob=false,hold=null,denied=false}=scenario,calls=[],rows=scenario.rows||domainRows();
 const page=await browser.newPage({viewport:{width,height:width<500?874:900}});
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:true,csrfToken:'fixture',user:{name:'Person',role},serverTime:now,idleExpiresAt:now+1800000,absoluteExpiresAt:now+28800000}}));
 await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.route('**/api/auth/activity',r=>r.fulfill({json:{}}));
 await page.route('**/api/storage-targets',r=>r.fulfill({json:{targets:[],activeTargetId:null}}));
 await page.route('**/api/**',async r=>{
  const q=r.request(),url=new URL(q.url()),path=url.pathname.replace(/^\/api/,'');
  if(path==='/domains'&&q.method()==='GET'){calls.push({method:'GET',path});return denied?r.fulfill({status:403,json:{error:'Operator access required.'}}):r.fulfill({json:{domains:rows,groups}})}
  if(path==='/domains/check'){const body=q.postDataJSON();calls.push({method:'POST',path,body});return r.fulfill({status:202,json:{jobId:'job-1'}})}
  if(path==='/jobs/job-1'){calls.push({method:'GET',path});if(hold)await hold;return r.fulfill({json:failJob?{id:'job-1',status:'failed',error:'DockNest could not read the proxy routes on a server. Test the server connection, then check again.'}:{id:'job-1',status:'completed'}})}
  if(path==='/moves'&&q.method()==='POST'){calls.push({method:'POST',path});return r.fulfill({json:{id:'mv1',siteId:SHOP,targetServerId:'s2',ok:true,verdict:'ready-with-notes',estimateSeconds:180,downtimeSeconds:30,undoDays:7,preflightHash:'h',blockers:[],
   warnings:[{id:'domains',text:'3 domains stop working until DNS points to Server 2: shop.example.invalid, www.shop.example.invalid, wiki.example.invalid.',advanced:false},{id:'domains',text:'cdn.example.invalid reaches Shop through the proxy on Server 1. The move does not change that proxy, so point it to Server 2 after the move.',advanced:false}],advanced:{ports:[],nginx:null,envKeys:[],dns:{mode:'manual',record:null,cloudflareAvailable:false},tests:{},checks:[]}}})}
  if(/^\/moves/.test(path)&&q.method()==='GET')return r.fulfill({json:{moves:[]}});
  return r.fallback();
 });
 await page.addInitScript(t=>localStorage.setItem('docknest-theme',t),theme);
 await page.emulateMedia({reducedMotion:'reduce',colorScheme:theme});
 await page.goto(base);
 if(width<500)await page.getByRole('button',{name:'Open navigation',exact:true}).click();
 await page.getByRole('navigation').getByRole('button',{name:'Map',exact:true}).click();
 if(width<500)await page.locator('.berry-shell.mobile-open').waitFor({state:'detached'});
 await (width<500?page.locator('.map-list'):page.locator('.map-viewport')).waitFor();
 return {page,calls};
}
// Opens the path panel of one domain: a node on the Map, a row under the app on a phone.
async function openDomain(page,phone,name){
 if(phone)await page.locator('.map-list').getByRole('button',{name,exact:false}).filter({hasText:name}).first().click();
 else await page.locator(`[data-node="domain:${name}"]`).click();
 const side=page.locator('.map-panel,dialog.map-dialog');await side.waitFor();
 await side.getByRole('heading',{name,exact:true}).waitFor();
 return side;
}
const hopOf=(side,name)=>side.locator('.map-hop').filter({has:side.page().locator('.map-hop-head b',{hasText:new RegExp('^'+name+'$')})});
const stateOf=(side,name)=>hopOf(side,name).locator('.status').innerText();

for(const [theme,width] of [['light',1280],['dark',1280],['light',390],['dark',390]]){
 const phone=width<500,tag=(n)=>shot;
 // A1: the Map. Nothing is checked on arrival: only GET /domains.
 {
  const {page,calls}=await open(theme,width);
  if(!phone){
   assert.equal(await page.locator('[data-node^="domain:"]').count(),8,'one node per domain');
   assert.ok(await page.locator('.map-dtitle',{hasText:'Points nowhere'}).count(),'Points nowhere group');
   assert.ok(await page.locator('.map-lines .dwire.st-ok').count()>0&&await page.locator('.map-lines .dwire.st-er').count()===0,'lines are coloured by the worst step; a red domain points nowhere');
   assert.ok(await page.locator('.map-lines .dstub.nowhere').count()===2,'a red stub for each domain that points nowhere');
   assert.ok(await page.locator('.map-lines .dwire.st-nc').count()===1,'the never-checked domain has a dashed line');
   const first=await page.locator('[data-node="domain:shop.example.invalid"]').boundingBox(),server=await page.locator('[data-node="server:s1"]').boundingBox();
   assert.ok(first.x+first.width<server.x,'domains sit left of the servers');
   // The column hides and shows, and the choice is kept.
   const toggle=page.getByRole('button',{name:'Domains',exact:true});
   await toggle.click();assert.equal(await page.locator('[data-node^="domain:"]').count(),0);
   await toggle.click();assert.equal(await page.locator('[data-node^="domain:"]').count(),8);
  }else{
   const shopRow=page.locator('.map-list li',{hasText:'Shop'}).first();
   assert.ok(await shopRow.locator('.map-list-domains li').count()>=3,'domains are listed under their app');
   assert.ok(await page.getByRole('heading',{name:'Domains that point nowhere'}).count());
  }
  await noOverflow(page);await shot(page,'A1-map-domains',theme,width);
  assert.deepEqual(calls.filter(c=>c.method==='POST'),[],'opening the Map checks nothing');
  assert.equal(calls.filter(c=>c.method==='GET'&&c.path==='/domains').length,1,'one read, no polling');
  await page.close();
 }
 // A2 to A6, A10, A11: the path states.
 const cases=[
  ['A2-path-all-good','shop.example.invalid',{dns:'success',proxy:'success',app:'success',certificate:'success'},[]],
  ['A3-path-cert-fail','wiki.example.invalid',{dns:'success',proxy:'success',app:'success',certificate:'needs-review'},['Open port 80 in the firewall, then check again.']],
  ['A4-path-dns-wrong','ledger.example.invalid',{dns:'failed',proxy:'queued',app:'queued',certificate:'queued'},['is not the address of any server connected to DockNest','Change the A record at your DNS provider']],
  ['A5-path-cgnat','home.example.invalid',{dns:'needs-review',proxy:'success',app:'success',certificate:'queued'},['CGNAT']],
  ['A6-path-token','blog.example.invalid',{dns:'needs-review',proxy:'success',app:'success',certificate:'success'},['The saved Cloudflare token has expired']],
  ['A10-state-partial','www.shop.example.invalid',{dns:'success',proxy:'needs-review',app:'success',certificate:'success'},['This list may be incomplete']],
  ['A11-points-nowhere','old.example.invalid',{dns:'failed',proxy:'queued',app:'queued',certificate:'queued'},['Add an A record at your DNS provider']]
 ];
 const WORDS={success:'OK','needs-review':'Needs review',failed:'Failed',queued:'Not checked'};
 for(const [name,domain,expect,texts] of cases){
  const {page}=await open(theme,width);
  const side=await openDomain(page,phone,domain);
  for(const [k,st] of Object.entries(expect))assert.equal(await stateOf(side,{dns:'DNS',proxy:'Proxy',app:'App',certificate:'Certificate'}[k]),WORDS[st],`${domain} ${k}`);
  for(const t of texts)assert.ok((await side.innerText()).includes(t),`${domain} says: ${t}`);
  assert.ok((await side.innerText()).includes('Checked 3 hours ago, during a backup'),'the time of the last check');
  assert.equal(await side.getByRole('button',{name:'Check again'}).count(),1,'Check again');
  await asLink(side.getByRole('button',{name:'Check again'}),'Check again',width);
  assert.equal(await side.getByRole('button',{name:'Open app'}).count(),domain==='old.example.invalid'?0:1);
  if(name==='A6-path-token')assert.equal(await side.getByRole('button',{name:'Open Connections'}).count(),1,'a link to Connections for the token');
  await noOverflow(page);await shot(page,name,theme,width);
  await page.close();
 }
 // A7 checking, then the result: Check again posts the domain, shows Checking, and reads the list again when the job ends.
 {
  let release;const hold=new Promise(done=>{release=done});
  const {page,calls}=await open(theme,width,{hold});
  const side=await openDomain(page,phone,'shop.example.invalid');
  await side.getByRole('button',{name:'Check again'}).click();
  await side.getByText('Checking…').first().waitFor();
  assert.equal(await side.getByText('Checking…').count(),5,'every step says Checking');
  assert.ok(await side.getByRole('button',{name:'Check again'}).isDisabled(),'one check at a time');
  assert.deepEqual(calls.find(c=>c.method==='POST').body,{domain:'shop.example.invalid'});
  await noOverflow(page);await shot(page,'A7-state-checking',theme,width);
  release();
  await side.getByText('Checking…').first().waitFor({state:'detached'});
  assert.equal(calls.filter(c=>c.path==='/domains'&&c.method==='GET').length,2,'the list is read again after the check');
  await page.close();
 }
 // A8 never checked: Check now is the primary action.
 {
  const {page}=await open(theme,width);
  const side=await openDomain(page,phone,'never.example.invalid');
  await side.getByText('Not checked yet',{exact:true}).waitFor();
  assert.ok((await side.innerText()).includes('It changes nothing.'));
  assert.ok(await side.getByRole('button',{name:'Check now'}).evaluate(b=>b.classList.contains('primary')));
  await noOverflow(page);await shot(page,'A8-state-never',theme,width);
  await page.close();
 }
 // A9 error: the job fails; the last known results stay, with their time, and the domain turns amber.
 {
  const {page}=await open(theme,width,{failJob:true});
  const side=await openDomain(page,phone,'shop.example.invalid');
  await side.getByRole('button',{name:'Check again'}).click();
  await side.getByRole('alert').waitFor();
  assert.ok((await side.getByRole('alert').innerText()).includes('Test the server connection, then check again.'));
  assert.ok((await side.innerText()).includes('Last known result, checked 3 hours ago'));
  assert.equal(await stateOf(side,'DNS'),'OK','the last known results stay');
  await noOverflow(page);await shot(page,'A9-state-error',theme,width);
  if(!phone){await side.getByRole('button',{name:'Close'}).click();assert.ok(await page.locator('[data-node="domain:shop.example.invalid"] .map-badge.dom-needs-review').count(),'the domain turns amber')}
  await page.close();
 }
 // A12 the app panel: one row per domain with its worst step; a row opens the path panel.
 {
  const {page}=await open(theme,width);
  if(phone)await page.locator('.map-list-group',{hasText:'Server 1'}).getByRole('button',{name:'Details for Shop'}).click();
  else await page.locator(`[data-node="site:${SHOP}"]`).click();
  const side=page.locator('.map-panel,dialog.map-dialog');await side.waitFor();
  const rows=side.locator('.map-drows li');
  assert.equal(await rows.count(),3);
  assert.deepEqual(await rows.locator('.status').allInnerTexts(),['OK','Needs review','Needs review']);
  await noOverflow(page);await shot(page,'A12-app-domains',theme,width);
  await rows.nth(2).getByRole('button').click();
  await side.getByRole('heading',{name:'wiki.example.invalid',exact:true}).waitFor();
  await page.close();
 }
 // A13 the Move review: each domain warning is its own amber note, and nothing is blocked.
 {
  const {page}=await open(theme,width);
  if(phone)await page.locator('.map-list li',{hasText:'Shop'}).first().getByRole('button',{name:'More actions for Shop'}).click();
  else await page.locator(`[data-node="site:${SHOP}"]`).click();
  if(phone)await page.getByRole('menuitem',{name:/Move to/}).click();
  else await page.locator('.map-panel').getByRole('button',{name:/Move to/}).click();
  await page.locator('dialog.map-dialog').getByRole('button',{name:/Server 2/}).first().click();
  if(!phone)await page.locator('.map-viewport').waitFor();
  const dialog=page.locator('dialog.map-dialog');
  if(!phone){await page.getByRole('button',{name:'Save changes'}).click()}
  await dialog.getByText('Ready to move').waitFor();
  const notes=dialog.locator('.alert-panel.alert-warning');
  assert.equal(await notes.count(),2,'two domain warnings, each in its own note');
  assert.ok((await notes.nth(0).innerText()).includes('3 domains stop working until DNS points to Server 2'));
  assert.ok((await notes.nth(1).innerText()).includes('cdn.example.invalid reaches Shop through the proxy on Server 1'));
  assert.ok(await dialog.getByRole('button',{name:'Move',exact:true}).isEnabled(),'warnings never block');
  await shot(page,'A13-move-domains',theme,width);
  await page.close();
 }
}

// Roles: a viewer is never offered domains and the page does not break (the API answers 403).
{
 const {page}=await open('light',1280,{role:'viewer',denied:true});
 assert.equal(await page.locator('[data-node^="domain:"]').count(),0);
 assert.equal(await page.getByRole('button',{name:'Domains',exact:true}).count(),0);
 await page.close();
}
// An operator reads and checks but cannot move nodes around.
{
 const {page,calls}=await open('light',1280,{role:'operator'});
 await page.locator('[data-node="domain:shop.example.invalid"]').waitFor();
 assert.ok(calls.some(c=>c.path==='/domains'));
 await page.close();
}
// Keyboard: a domain node opens its path with Enter, and Escape closes the panel and returns focus to the node.
{
 const {page}=await open('light',1280);
 const node=page.locator('[data-node="domain:wiki.example.invalid"]');
 await node.focus();await page.keyboard.press('Enter');
 await page.locator('.map-panel').getByRole('heading',{name:'wiki.example.invalid'}).waitFor();
 await page.keyboard.press('Escape');
 await page.locator('.map-panel').waitFor({state:'detached'});
 assert.equal(await node.evaluate(n=>n===document.activeElement),true,'focus returns to the node');
 assert.match(await node.getAttribute('aria-label'),/^wiki\.example\.invalid\. Needs review\./);
 await page.close();
}

await browser.close();
assert.deepEqual(errors,[],'no page errors');
console.log('Domains browser checks passed.');
