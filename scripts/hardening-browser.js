import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

// Hardening score UI (docs/hardening-score.md) against a mocked API: the Hardening row on every Sites card, the Findings
// dialog (alert by grade, 5 per page, Fix under the finding on a phone) and the Map details section. Read-only for every
// role. Light and dark, 1440 and 390 px. Run against a dev server: TEST_BASE_URL=http://127.0.0.1:5173
// Set SHOTS_DIR to also write screenshots.
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5173',shots=process.env.SHOTS_DIR,now=Date.now(),past=ms=>new Date(now-ms).toISOString();
if(shots)await mkdir(shots,{recursive:true});
const finding=(id,severity,title,container,fix)=>({id,severity,title,container,fix});
const findings=[
 finding('privileged','high','Privileged mode','shop-app','Remove privileged: true and add only the capabilities it needs.'),
 finding('docker-socket','high','Docker socket mounted','shop-app','Remove the docker.sock mount or use a read-only socket proxy.'),
 finding('root','medium','Runs as root','shop-db','Set user: to a non-root UID in the Compose file.'),
 finding('ports','medium','Ports open to the network','shop-db','Bind ports to 127.0.0.1 and publish through your reverse proxy.'),
 finding('no-new-privileges','low','Privilege escalation allowed','shop-app','Add security_opt: no-new-privileges:true to the service.'),
 finding('memory','low','No memory limit','shop-app','Set mem_limit so one service cannot exhaust server memory.'),
 finding('latest','low','Unpinned image tag','shop-web','Pin the image to a version tag or digest, not latest.')
];
const site=(id,name,hardening,extra={})=>({id,name,serverId:'s1',config:{containers:['c-'+id],domains:[name+'.example.com']},hardening,...extra});
const graded=(grade,list,passed)=>({grade,checkedAt:past(5*3600000),passed,total:passed+list.length,findings:list});
const never={grade:null,checkedAt:null,passed:0,total:0,findings:[]};
const sites=[
 site('f','Shop',graded('F',findings,2)),
 site('a','Blog',graded('A',[],9)),
 site('n','Wiki',never),
 {id:'st',name:'Landing',serverId:'s1',config:{kind:'static',documentRoot:'/var/www/landing'},hardening:never}
];
const state=extra=>({servers:[{id:'s1',name:'Production',host:'srv.example.invalid',port:22,username:'root',status:'connected'}],sites:extra.sites||sites,policies:[],backups:[],jobs:extra.jobs||[],restores:[],audit:[],storage:{used:0,total:1e12},worker:{online:true},maintenance:{}});
const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
const errors=[],writes=[];
async function open(theme,width,{role='admin',data=state({}),route='Sites & schedules'}={}){
 const page=await browser.newPage({viewport:{width,height:width<500?874:900}});
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:true,csrfToken:'fixture',user:{name:'Person',role},serverTime:now,idleExpiresAt:now+1800000,absoluteExpiresAt:now+28800000}}));
 await page.route('**/api/state',r=>r.fulfill({json:data}));
 await page.route('**/api/auth/activity',r=>r.fulfill({json:{}}));
 await page.route('**/api/**',r=>{const q=r.request();if(q.method()!=='GET'&&!/auth\/activity/.test(q.url()))writes.push(q.method()+' '+q.url());return r.fallback();});
 await page.addInitScript(t=>localStorage.setItem('docknest-theme',t),theme);
 await page.emulateMedia({reducedMotion:'reduce',colorScheme:theme});
 await page.goto(base);
 if(width<500)await page.getByRole('button',{name:'Open navigation',exact:true}).click();
 await page.getByRole('navigation').getByRole('button',{name:route,exact:true}).click();
 if(width<500)await page.locator('.berry-shell.mobile-open').waitFor({state:'detached'});
 return page;
}
const shot=async(page,name,theme,width)=>{if(shots)await page.screenshot({path:`${shots}/hardening-${name}-${width}-${theme}.png`});};
const noOverflow=page=>page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth);

for(const [theme,width] of [['light',1440],['dark',1440],['light',390],['dark',390]]){
 const phone=width<500;
 // Sites page: every card has a Hardening row.
 let page=await open(theme,width);
 await page.waitForFunction(()=>document.querySelectorAll('.site-card').length===4);
 await page.waitForFunction(()=>[...document.querySelectorAll('.site-card')].every(c=>[...c.querySelectorAll('dt')].some(t=>t.textContent==='Hardening')));
 const row=name=>page.locator('.site-card',{hasText:name}).locator('.def-row',{hasText:'Hardening'});
 await row('Shop').getByText('Grade F',{exact:true}).waitFor();
 await row('Shop').getByText('7 to fix',{exact:true}).waitFor();
 await row('Blog').getByText('Grade A',{exact:true}).waitFor();
 await row('Blog').getByText('All passed',{exact:true}).waitFor();
 assert.equal(await row('Blog').getByRole('button').count(),0,'no Findings button when everything passed');
 await row('Wiki').getByText('Not checked yet. Next backup checks it.',{exact:true}).waitFor();
 await row('Landing').getByText('Static site, nothing to check.',{exact:true}).waitFor();
 assert.equal(await page.getByText('Checking…').count(),0,'Checking only while a backup runs');
 await noOverflow(page);await shot(page,'sites',theme,width);
 // Findings dialog: error alert for F, 5 per page, severity on the Finding cell.
 await row('Shop').getByRole('button',{name:'Findings for Shop',exact:true}).click();
 let dialog=page.locator('dialog.hd-dialog');await dialog.waitFor();
 await dialog.getByRole('alert').getByText('2 serious risks to fix first.').waitFor();
 assert.equal(await dialog.locator('.alert-panel.alert-error').count(),1);
 await dialog.getByText('2 of 9 checks passed, 5 hours ago.').waitFor();
 await page.waitForFunction(()=>document.querySelectorAll('dialog.hd-dialog tbody tr').length===5);
 assert.equal(await dialog.locator('tbody .status-failed').count(),2,'severity is the StatusLabel state');
 assert.equal(await dialog.locator('tbody .status-needs-review').count(),2);
 const fixes=await dialog.evaluate(el=>{const th=[...el.querySelectorAll('th')][2],td=el.querySelector('tbody td:nth-child(3)'),inline=el.querySelector('.hd-fix-inline');return {th:getComputedStyle(th).display,td:getComputedStyle(td).display,inline:getComputedStyle(inline).display};});
 if(phone){assert.deepEqual(fixes,{th:'none',td:'none',inline:'block'},'Fix moves under the finding on a phone');}
 else{assert.notEqual(fixes.td,'none');assert.equal(fixes.inline,'none');}
 await noOverflow(page);await shot(page,'dialog-f',theme,width);
 await dialog.getByRole('button',{name:/next/i}).first().click();
 await page.waitForFunction(()=>document.querySelectorAll('dialog.hd-dialog tbody tr').length===2);
 await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Findings for Shop'||document.activeElement===document.body);
 await page.close();
}

// Alert by grade: warning for D, none for C, B and A.
for(const [grade,list,variant] of [['D',findings.slice(2,4),'alert-warning'],['C',findings.slice(2,3),null],['B',findings.slice(4,6),null]]){
 const data=state({sites:[site('x','Grade'+grade,graded(grade,list,6))]});
 const page=await open('light',1440,{data});
 await page.getByRole('button',{name:'Findings for Grade'+grade,exact:true}).click();
 const dialog=page.locator('dialog.hd-dialog');await dialog.waitFor();
 await page.waitForFunction(n=>document.querySelectorAll('dialog.hd-dialog tbody tr').length===n,list.length);
 assert.equal(await dialog.locator('.alert-panel').count(),variant?1:0,'alert for grade '+grade);
 if(variant){assert.equal(await dialog.locator('.'+variant).count(),1);await dialog.getByText(grade==='D'?'2 risks to fix.':'',{exact:false}).first().waitFor();}
 await page.close();
}

// A backup of an ungraded site is running: only that site says Checking.
{
 const data=state({jobs:[{id:'j1',siteId:'n',type:'backup',status:'running',createdAt:past(60000)}]});
 const page=await open('light',1440,{data});
 await page.waitForFunction(()=>document.querySelectorAll('.site-card').length===4);
 await page.locator('.site-card',{hasText:'Wiki'}).getByText('Checking…').waitFor();
 assert.equal(await page.getByText('Checking…').count(),1);
 assert.equal(await page.locator('.site-card',{hasText:'Landing'}).getByText('Checking…').count(),0);
 await page.close();
}

// Viewers see it, and nothing changes a site.
{
 const page=await open('light',1440,{role:'viewer'});
 await page.waitForFunction(()=>document.querySelectorAll('.site-card').length===4);
 await page.getByRole('button',{name:'Findings for Shop',exact:true}).click();
 await page.locator('dialog.hd-dialog').waitFor();
 assert.equal(await page.locator('dialog.hd-dialog button:not(.icon):not([aria-label])').evaluateAll(b=>b.map(x=>x.textContent.trim()).filter(t=>!/^(Close|Previous|Next|\d+)$/i.test(t))).then(a=>a.length),0,'dialog holds no action');
 await page.close();
}

// Map details panel: def-list first, then Hardening with 3 findings and See all; the panel scrolls inside itself.
for(const theme of ['light','dark']){
 const page=await open(theme,1440,{route:'Map'});
 await page.waitForSelector('[data-node="site:f"]');
 const before=await page.evaluate(()=>document.documentElement.scrollHeight);
 await page.locator('[data-node="site:f"]').click();
 const panel=page.locator('.map-panel');await panel.waitFor();
 const section=panel.locator('.hd-section');await section.getByText('Grade F',{exact:true}).waitFor();
 assert.equal(await section.locator('.hd-list li').count(),3);
 const order=await panel.evaluate(el=>{const d=el.querySelector('.map-defs'),s=el.querySelector('.hd-section');return !!(d.compareDocumentPosition(s)&Node.DOCUMENT_POSITION_FOLLOWING);});
 assert.equal(order,true,'definition list comes first');
 const scroll=await panel.evaluate(el=>{const body=el.querySelector('.map-panel-body');return {inner:body.scrollHeight>=body.clientHeight,page:document.documentElement.scrollHeight};});
 assert.equal(scroll.page,before,'the page never grows');
 await shot(page,'map-f',theme,1440);
 await section.getByRole('button',{name:'See all',exact:true}).click();
 const dialog=page.locator('dialog.hd-dialog');await dialog.waitFor();
 await page.waitForFunction(()=>document.querySelectorAll('dialog.hd-dialog tbody tr').length===5);
 await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
 await page.locator('[data-node="site:a"]').click();
 await panel.locator('.hd-section').getByText('All passed',{exact:true}).waitFor();
 assert.equal(await panel.getByRole('button',{name:'See all'}).count(),0);
 await shot(page,'map-a',theme,1440);
 await page.locator('[data-node="site:n"]').click();
 await panel.locator('.hd-section').getByText('Not checked yet. Next backup checks it.').waitFor();
 await page.locator('[data-node="site:st"]').click();
 await panel.locator('.hd-section').getByText('Static site, nothing to check.').waitFor();
 await page.close();
}
assert.deepEqual(writes,[],'the hardening views send no changing request');
assert.deepEqual(errors,[]);
await browser.close();
console.log('Hardening browser checks passed.');
