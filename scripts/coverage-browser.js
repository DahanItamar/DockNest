import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

// Backup coverage (docs/coverage-and-restore-check.md A2-A4) against a mocked API: the closed Apps panel that reads nothing,
// loading, error with retry, empty, partial and the list (order, one row per item, 8 per page), Add app pre-selection,
// Skip with a note and Unskip, the Map toggle, and the "How DockNest will recreate it" step with its
// old-helper fallback. Light and dark, 1280 and 390 px. Run against a dev server or the built app: TEST_BASE_URL=http://127.0.0.1:5173
// Set SHOTS_DIR to also write screenshots.
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5173',shots=process.env.SHOTS_DIR,now=Date.now();
if(shots)await mkdir(shots,{recursive:true});
const item=(kind,name,status,extra={})=>({kind,name,status,...extra});
const filler=Array.from({length:6},(_,i)=>item('container','svc-'+(i+1),'backed-up',{app:{id:'shop',name:'Shop'}}));
const covered=[
 item('container','worker','not-backed-up'),
 item('container','db2','not-backed-up'),
 item('volume','pgdata','not-backed-up',{usedBy:['db2','db3']}),
 item('volume','scratch','not-backed-up',{usedBy:[]}),
 item('container','db','pending',{app:{id:'shop',name:'Shop'}}),
 item('container','cache','skipped',{note:'Rebuilt every time it starts'}),
 item('container','shop-web','backed-up',{app:{id:'shop',name:'Shop'}}),
 ...filler
];
const servers=[
 {id:'s1',name:'Production',host:'192.0.2.10',port:22,username:'root',status:'connected'},
 {id:'s2',name:'Staging',host:'192.0.2.11',port:22,username:'root',status:'connected'},
 {id:'s3',name:'Broken',host:'192.0.2.12',port:22,username:'root',status:'connected'},
 {id:'s4',name:'Empty',host:'192.0.2.13',port:22,username:'root',status:'connected'},
 {id:'s5',name:'Waiting',host:'192.0.2.14',port:22,username:'root',status:'connected'}
];
const sites=[{id:'shop',name:'Shop',serverId:'s1',config:{containers:['shop-web','db'],domains:['shop.example.com']}}];
const state={servers,sites,policies:[],backups:[],jobs:[],restores:[],audit:[],storage:{used:0,total:1e12},worker:{online:true},maintenance:{}};
const discover={staticSites:[],certificates:[],containers:['worker','db2','db3'].map(name=>({id:'id-'+name,name,image:'example/'+name+':1',state:'running',running:true,labels:{},mounts:[],ports:{},networks:name==='worker'?[]:['shopnet']}))};
const compose='services:\n  worker:\n    image: example/worker:1\n    environment:\n      - API_TOKEN\n';
const describe={compose,containers:[{name:'worker',environment:['API_TOKEN'],unsupported:['Device /dev/dri is not recreated']}]};
const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
const errors=[];
const shot=async(page,name,theme,width)=>{if(shots)await page.screenshot({path:`${shots}/${name}-${width}-${theme}.png`});};
const noOverflow=page=>page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth);

// scenario.coverage(serverId, attempt) -> {status, body}; calls collects every request that reaches the mock.
async function open(theme,width,{role='admin',route='Apps & schedules',coverage,helper='ok',delay=0}={}){
 const calls=[],attempts={};
 const page=await browser.newPage({viewport:{width,height:width<500?874:900}});
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:true,csrfToken:'fixture',user:{name:'Person',role},serverTime:now,idleExpiresAt:now+1800000,absoluteExpiresAt:now+28800000}}));
 await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.route('**/api/auth/activity',r=>r.fulfill({json:{}}));
 await page.route('**/api/storage-targets',r=>r.fulfill({json:{targets:[],activeTargetId:null}}));
 await page.route('**/api/**',async r=>{
  const q=r.request(),url=new URL(q.url()),path=url.pathname.replace(/^\/api/,'');
  const hit=/^\/servers\/([^/]+)\/(coverage|discover|describe-containers)/.exec(path);
  if(!hit&&!/coverage\/ignores/.test(path))return r.fallback();
  calls.push({method:q.method(),path:path+url.search,body:q.postData()?JSON.parse(q.postData()):null});
  if(/coverage\/ignores/.test(path))return r.fulfill({json:{}});
  const [,id,what]=hit;
  if(what==='discover')return r.fulfill({json:discover});
  if(what==='describe-containers')return helper==='old'?r.fulfill({status:422,json:{error:'Unsupported helper operation'}}):r.fulfill({json:describe});
  attempts[id]=(attempts[id]||0)+1;
  if(delay)await new Promise(done=>setTimeout(done,delay));
  const answer=(coverage||defaultCoverage)(id,attempts[id]);
  return r.fulfill({status:answer.status||200,json:answer.body});
 });
 await page.addInitScript(t=>localStorage.setItem('docknest-theme',t),theme);
 await page.emulateMedia({reducedMotion:'reduce',colorScheme:theme});
 await page.goto(base);
 if(width<500)await page.getByRole('button',{name:'Open navigation',exact:true}).click();
 await page.getByRole('navigation').getByRole('button',{name:route,exact:true}).click();
 if(width<500)await page.locator('.berry-shell.mobile-open').waitFor({state:'detached'});
 return {page,calls};
}
function defaultCoverage(id,attempt){
 if(id==='s2')return {body:{complete:false,problems:['Docker did not answer for 2 containers.'],items:[item('container','api','not-backed-up'),item('container','queue','backed-up',{app:{id:'shop',name:'Shop'}})]}};
 if(id==='s3')return attempt===1?{status:500,body:{error:'SSH connection to 192.0.2.12 timed out.'}}:{body:{complete:true,problems:[],items:[item('container','web','backed-up',{app:{id:'shop',name:'Shop'}})]}};
 if(id==='s5')return {body:{complete:true,problems:[],items:[item('container','queue','pending',{app:{id:'shop',name:'Shop'}})]}};
 if(id==='s4')return {body:{complete:true,problems:[],items:[]}};
 return {body:{complete:true,problems:[],items:covered}};
}
const rows=page=>page.locator('.bc-row');
const row=(page,name)=>page.locator('.bc-row',{has:page.locator('b',{hasText:new RegExp('^'+name+'$')})});
const panel=page=>page.locator('.bc-panel');

for(const [theme,width] of [['light',1280],['dark',1280],['light',390],['dark',390]]){
 const phone=width<500;
 // Closed on arrival: nothing is read until the panel is opened.
 let {page,calls}=await open(theme,width,{delay:400});
 await panel(page).getByRole('button',{name:'Check coverage',exact:true}).waitFor();
 assert.equal(calls.filter(c=>/coverage/.test(c.path)).length,0,'the Apps page does not scan by itself');
 assert.equal(await rows(page).count(),0);
 await shot(page,'cov-closed',theme,width);
 // Loading, then the list.
 await panel(page).getByRole('button',{name:'Check coverage',exact:true}).click();
 await panel(page).getByText('Scanning Production…').waitFor();
 await shot(page,'cov-loading',theme,width);
 await rows(page).first().waitFor();
 assert.equal(calls.filter(c=>/coverage$/.test(c.path)).length,1,'one scan per opening');
 assert.equal(await rows(page).count(),8,'eight rows per page');
 assert.notEqual(await row(page,'cache').locator('.status').first().evaluate(e=>e.className),await row(page,'db').locator('.status').first().evaluate(e=>e.className),'Skipped and First backup pending look different');
 const names=await rows(page).locator('b').allTextContents();
 assert.deepEqual(names.slice(0,5),['db2','worker','pgdata','scratch','db'],'not backed up first, then pending, skipped, backed up');
 await panel(page).getByText('4 not backed up, 1 waiting for a first backup, 1 skipped, 7 backed up.',{exact:false}).waitFor();
 assert.equal(await panel(page).getByText('Everything here is covered').count(),0);
 // No pills or badges, no repeated labels, no number inputs.
 assert.equal(await page.locator('.bc-panel [class*="pill"],.bc-panel [class*="badge"],.bc-panel input[type=number]').count(),0);
 assert.equal(await page.locator('.bc-panel td,.bc-panel th,.bc-panel [data-label]').count(),0,'rows are not a labelled table');
 assert.ok(await panel(page).locator('.status-needs-review').count()>=3,'status is the shared StatusLabel');
 await noOverflow(page);await shot(page,'cov-list',theme,width);
 // Pager: page two holds the rest, backed up last.
 await panel(page).getByRole('button',{name:/next/i}).first().click();
 assert.ok(await rows(page).count()>0&&await rows(page).count()<=8);
 await panel(page).getByRole('button',{name:/previous/i}).first().click();

 // Skip with a note: dialog, 200 max, PUT, the row changes in place, no second scan.
 const scans=calls.filter(c=>/coverage$/.test(c.path)).length;
 await row(page,'worker').getByRole('button',{name:'More actions for worker'}).click();
 await page.getByRole('menuitem',{name:'Skip',exact:true}).click();
 const dialog=page.locator('dialog.bc-dialog');await dialog.waitFor();
 assert.equal(await dialog.locator('input[name=note]').getAttribute('maxlength'),'200');
 assert.equal(await dialog.locator('textarea').count(),0,'the note is one line');
 await dialog.locator('input[name=note]').fill('Rebuilt by a nightly job');
 await shot(page,'cov-skip',theme,width);
 await dialog.getByRole('button',{name:'Skip',exact:true}).click();
 await dialog.waitFor({state:'detached'});
 const put=calls.find(c=>c.method==='PUT');
 assert.deepEqual(put.body,{kind:'container',name:'worker',note:'Rebuilt by a nightly job'});
 assert.equal(put.path,'/servers/s1/coverage/ignores');
 await row(page,'worker').getByText('Skipped',{exact:true}).waitFor();
 await row(page,'worker').getByText('Rebuilt by a nightly job').waitFor();
 assert.equal(calls.filter(c=>/coverage$/.test(c.path)).length,scans,'skipping does not scan again');
 // Unskip needs no dialog.
 await row(page,'worker').getByRole('button',{name:'More actions for worker'}).click();
 await page.getByRole('menuitem',{name:'Unskip',exact:true}).click();
 await row(page,'worker').getByText('Not backed up',{exact:true}).waitFor();
 assert.ok(calls.some(c=>c.method==='DELETE'&&c.path==='/servers/s1/coverage/ignores/container/worker'));
 assert.equal(await page.locator('dialog.bc-dialog').count(),0);
 // Menu keyboard: Escape closes and returns focus.
 const more=row(page,'worker').getByRole('button',{name:'More actions for worker'});
 await more.focus();await page.keyboard.press('ArrowDown');
 await page.getByRole('menuitem',{name:'Skip',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('role')),'menuitem');
 await page.keyboard.press('Escape');
 await page.getByRole('menuitem').waitFor({state:'detached'});
 assert.equal(await more.evaluate(el=>el===document.activeElement),true);
 await page.close();

 // Add app on a volume selects the containers that use it, then previews how plain containers are recreated.
 ({page,calls}=await open(theme,width));
 await panel(page).getByRole('button',{name:'Check coverage',exact:true}).click();
 await row(page,'pgdata').waitFor();
 await row(page,'pgdata').getByRole('button').first().click();
 let wizard=page.locator('dialog .site-wizard,dialog.site-wizard,form.site-wizard').first();
 await page.locator('.selection-summary').getByText('2 services included: db2, db3').waitFor();
 await page.getByRole('button',{name:'Continue',exact:true}).click();
 await page.getByRole('heading',{name:'How DockNest will recreate these containers'}).waitFor();
 assert.ok(calls.some(c=>c.path==='/servers/s1/describe-containers?containers=db2,db3'));
 await page.locator('.bc-yaml').waitFor();
 await page.getByText('1 variable listed by name: API_TOKEN').waitFor();
 await page.getByText('Cannot be recreated automatically').waitFor();
 assert.equal(await page.locator('.bc-recreate').getByText(/secret|password=/i).count(),0,'no values are shown');
 assert.equal(await page.getByRole('button',{name:'Continue',exact:true}).isEnabled(),true);
 await noOverflow(page);await shot(page,'add-recreate',theme,width);
 await page.getByRole('button',{name:'Back',exact:true}).click();
 await page.locator('.selection-summary').getByText('db2, db3').waitFor();
 await page.close();

 // A container inside a suggested network group is pre-ticked alone, not the whole group.
 ({page}=await open(theme,width));
 await panel(page).getByRole('button',{name:'Check coverage',exact:true}).click();
 await row(page,'db2').getByRole('button').first().click();
 await page.locator('.selection-summary').getByText('1 services included: db2').waitFor();
 await page.close();

 // Add app on a container pre-selects it; an old helper still lets the user continue.
 ({page,calls}=await open(theme,width,{helper:'old'}));
 await panel(page).getByRole('button',{name:'Check coverage',exact:true}).click();
 await row(page,'worker').getByRole('button').first().click();
 await page.locator('.selection-summary').getByText('worker').first().waitFor();
 await page.getByRole('button',{name:'Continue',exact:true}).click();
 await page.getByText('Update the helper on this server to preview').waitFor();
 assert.equal(await page.getByRole('button',{name:'Continue',exact:true}).isEnabled(),true);
 await shot(page,'add-old-helper',theme,width);
 await page.close();

 // Partial: the banner lists the problems and nothing says everything is covered.
 ({page}=await open(theme,width));
 await panel(page).getByRole('button',{name:'Check coverage',exact:true}).click();
 await panel(page).getByLabel('Server').selectOption('s2');
 await page.getByText('The scan was incomplete').waitFor();
 await page.getByText('Docker did not answer for 2 containers.').waitFor();
 assert.equal(await panel(page).getByText('Everything here is covered').count(),0);
 await shot(page,'cov-partial',theme,width);
 // Only a pending app: never reads as covered.
 await panel(page).getByLabel('Server').selectOption('s5');
 await row(page,'queue').getByText('First backup pending').waitFor();
 assert.equal(await panel(page).getByText('Everything here is covered').count(),0);
 // Empty.
 await panel(page).getByLabel('Server').selectOption('s4');
 await panel(page).getByText('No containers or volumes',{exact:true}).waitFor();
 await shot(page,'cov-empty',theme,width);
 // Error, then Try again.
 await panel(page).getByLabel('Server').selectOption('s3');
 await page.getByText('Could not scan this server').waitFor();
 await page.getByText('SSH connection to 192.0.2.12 timed out.').waitFor();
 await shot(page,'cov-error',theme,width);
 await page.getByRole('button',{name:'Try again',exact:true}).click();
 await row(page,'web').waitFor();
 await panel(page).getByText('Everything here is covered by an app or skipped on purpose.').waitFor();
 await page.close();
}

// Map: reads nothing until Coverage is on; the node says "N not backed up" in plain caption text, with no badge.
for(const [theme,width] of [['light',1280],['dark',1280],['light',390],['dark',390]]){
 const phone=width<500;
 const {page,calls}=await open(theme,width,{route:'Map'});
 await page.getByRole('button',{name:'Coverage',exact:true}).waitFor();
 await page.waitForTimeout(300);
 assert.equal(calls.filter(c=>/coverage/.test(c.path)).length,0,'the Map does not scan until Coverage is on');
 await page.getByRole('button',{name:'Coverage',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Coverage',exact:true}).getAttribute('aria-pressed'),'true');
 await page.getByText('4 not backed up').first().waitFor();
 await page.getByText('1 waiting for a first backup').first().waitFor();
 assert.equal(await page.getByText('All backed up').count(),0,'pending never reads as all backed up');
 await page.getByText('1 not backed up').first().waitFor();
 assert.equal(await page.locator('.map-root [class*="pill"],.map-root .bc-pill').count(),0,'no pills on the Map');
 await noOverflow(page);await shot(page,'map-coverage',theme,width);
 // The server panel lists the same rows.
 if(phone)await page.locator('.map-list-group',{hasText:'Production'}).getByRole('button',{name:'Details'}).first().click();
 else await page.locator('[data-node="server:s1"]').click();
 const side=page.locator('.map-panel,dialog.map-dialog');await side.waitFor();
 await side.locator('.bc-row').first().waitFor();
 assert.equal(await side.locator('.bc-row').count(),8);
 await shot(page,'map-coverage-panel',theme,width);
 await page.close();
}

await browser.close();
assert.deepEqual(errors,[],'no page errors');
console.log('Backup coverage browser checks passed.');
