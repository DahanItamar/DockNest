import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
// 2.16.4: SQLite files editor in the site form, the failed-backup fix view, and one Jobs row per restore test.
// Every name here is invented; the API is mocked.
const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
const shots='data/jobs-sqlite-verification';await mkdir(shots,{recursive:true});
const iso=(minutesAgo)=>new Date(Date.now()-minutesAgo*60000).toISOString();
const services=()=>[
 {container:'web',engine:'generic',sqliteFiles:['/data/app.db','/data/sessions.db'],sqliteVersion:'3.45.1',sqliteSigtermConfirmed:true},
 {container:'worker',engine:'generic',sqliteFiles:['/data/app.db','/data/sessions.db'],sqliteVersion:'3.45.1',sqliteSigtermConfirmed:false},
 {container:'queue',engine:'generic',sqliteFiles:['/data/queue.db'],sqliteVersion:'3.45.1',sqliteSigtermConfirmed:false},
 {container:'cache',engine:'generic',sqliteFiles:[],sqliteVersion:'3.45.1',sqliteSigtermConfirmed:false},
 {container:'proxy',engine:'generic',sqliteFiles:[]}
];
const names=['web','worker','queue','cache','proxy'];
const stepNames=['check_space','copy_backup','restore_copy','start_containers','check_health','clean_up'];
const labels={check_space:'Check space',copy_backup:'Copy backup',restore_copy:'Restore copy',start_containers:'Start containers',check_health:'Check health',clean_up:'Clean up'};
const testDetail=(id,failed)=>({id,siteId:'site',state:'finished',result:failed?'failed':'passed',failedStep:failed?'check_health':null,reason:failed?'The website did not answer on /health (HTTP 502).':null,totalSeconds:failed?420:250,
 steps:stepNames.map(step=>({step,label:labels[step],state:failed&&step==='check_health'?'failed':'done',startedAt:iso(30),finishedAt:iso(29),detail:failed&&step==='check_health'?'The website did not answer on /health (HTTP 502).':null}))});
const stepJob=(id,testId,status,step,age)=>({id,siteId:'site',type:'restore-test',status,stage:status==='failed'?'failed':'completed',createdAt:iso(age),details:{testId,step}});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const site={id:'site',serverId:'host',name:'Blog',config:{kind:'docker',containers:names,services:services(),domains:['blog.example.invalid'],healthUrl:'http://127.0.0.1:3200/',stagingRoot:'/var/lib/docknest',deliveryMode:'staged',composeFiles:['/srv/blog/compose.yml'],configFiles:[],maintenance:{required:true,directory:'/var/lib/docknest/maintenance/site',publicUrl:'https://blog.example.invalid',healthUrl:'http://127.0.0.1:3200/'}}};
 const failedBackup={id:'job-bad',siteId:'site',type:'backup',status:'failed',stage:'preflight',createdAt:iso(60),error:'SQLite database file is missing or not a regular file: /data/app.db',details:{}};
 const linkBackup={id:'job-link',siteId:'site',type:'backup',status:'failed',stage:'preflight',createdAt:iso(120),error:'SQLite database path contains a symbolic link: /data/queue.db',details:{}};
 const oldBackup={id:'job-old',siteId:'site',type:'backup',status:'failed',stage:'preflight',createdAt:iso(180),error:'SQLite database path is unreadable or contains a symbolic link',details:{}};
 const state={servers:[{id:'host',name:'Source host'}],sites:[site],policies:[{siteId:'site',enabled:true,schedule:'0 2 * * *',timezone:'UTC',retention:7}],audit:[],storage:{used:0,total:1e12},
  backups:[{id:'bk',siteId:'site',capturedAt:iso(1500),size:1000,manifest:{downtimeSeconds:1320}}],
  jobs:[failedBackup,linkBackup,oldBackup,
   stepJob('t2f','T2','completed','clean_up',300),stepJob('t2e','T2','completed','check_health',305),stepJob('t2a','T2','completed','check_space',310),
   stepJob('t1b','T1','completed','clean_up',1500),stepJob('t1a','T1','completed','check_space',1510),
   {id:'ok',siteId:'site',type:'backup',status:'completed',stage:'completed',createdAt:iso(1600),details:{}}]};
 await page.route('**/api/**',r=>r.fulfill({status:404,json:{error:'not mocked'}}));
 await page.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:true,csrfToken:'fixture',user:{id:'admin',name:'Reviewer',role:'admin'},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+3600000}}));
 await page.route('**/api/auth/activity',r=>r.fulfill({json:{}}));
 await page.route('**/api/updates/progress',r=>r.fulfill({json:{}}));
 await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.route('**/api/servers/host/discover',r=>r.fulfill({json:{containers:names.map(name=>({name,image:name,state:'running'})),staticSites:[]}}));
 await page.route('**/api/restore-tests/T2',r=>r.fulfill({json:testDetail('T2',true)}));
 await page.route('**/api/restore-tests/T1',r=>r.fulfill({json:testDetail('T1',false)}));
 const saved=[];let queued=0;
 await page.route('**/api/sites/site',r=>{if(r.request().method()!=='PATCH')return r.fallback();const body=r.request().postDataJSON();saved.push(body);site.config=body.config;return r.fulfill({json:site});});
 await page.route('**/api/sites/site/backup',r=>{queued+=1;return r.fulfill({json:{id:'new'}});});
 await page.goto(process.env.TEST_BASE_URL||'http://127.0.0.1:5177');
 const nav=name=>page.getByRole('navigation').getByRole('button',{name,exact:true}).click();
 const dialog=page.getByRole('dialog').first();

 // 1. Site form: one group per service, a shared group for identical lists.
 await nav('Sites & schedules');
 await page.getByRole('button',{name:'Edit configuration',exact:true}).click();
 await dialog.getByText('Advanced backup settings',{exact:true}).waitFor();
 assert.equal(await dialog.locator('details[open]>summary',{hasText:'Advanced backup settings'}).count(),1,'opens when the site declares files');
 assert.equal(await dialog.locator('.sq-group').count(),4,'shared web+worker, queue, cache, proxy');
 assert.equal(await dialog.locator('.sq-group',{hasText:'Shared list'}).locator('.sq-tag').allTextContents().then(x=>x.join()),'web,worker');
 assert.equal(await dialog.locator('.sq-group',{hasText:'proxy'}).getByRole('button').count(),0,'no add link without a recorded SQLite version');
 assert.equal(await dialog.locator('.sq-group',{hasText:'proxy'}).getByText('No SQLite declared').count(),1);
 await page.screenshot({path:shots+'/site-form-1440.png'});
 const shared=dialog.getByLabel('Database files for web, worker');
 assert.equal(await shared.inputValue(),'/data/app.db\n/data/sessions.db');
 await shared.fill('/data/app.db\n/data/extra.db');
 await dialog.locator('.sq-group',{hasText:'cache'}).getByRole('button',{name:'Add database file'}).click();
 await dialog.getByLabel('Database files for cache').fill('/data/cache.db');
 await dialog.getByRole('button',{name:'Continue',exact:true}).click();
 await dialog.getByRole('checkbox',{name:/reviewed external dependencies/}).check();
 await dialog.getByRole('checkbox',{name:/normal stop/}).check();
 await dialog.getByRole('checkbox',{name:/No containers or processes/}).check();
 await dialog.getByRole('button',{name:'Save configuration',exact:true}).click();
 await dialog.waitFor({state:'hidden'});
 const first=saved.at(-1).config.services;
 assert.deepEqual(first.map(x=>x.sqliteFiles),[['/data/app.db','/data/extra.db'],['/data/app.db','/data/extra.db'],['/data/queue.db'],['/data/cache.db'],[]]);
 assert.equal(first[0].sqliteVersion,'3.45.1');assert.equal(first[0].sqliteSigtermConfirmed,true);assert.equal(first[4].sqliteVersion,undefined);assert.equal(first[0].engine,'generic');
 // Edit separately, and refuse an empty list under SIGTERM acceptance and relative paths.
 site.config.services=services();
 await page.getByRole('button',{name:'Edit configuration',exact:true}).click();
 await dialog.getByRole('button',{name:'Edit separately',exact:true}).click();
 assert.equal(await dialog.locator('.sq-group').count(),5);
 await dialog.getByLabel('Database files for web',{exact:true}).fill('');
 await dialog.getByRole('button',{name:'Continue',exact:true}).click();
 await dialog.getByText(/SIGTERM confirmation needs at least one SQLite file/).waitFor();
 await dialog.getByLabel('Database files for web',{exact:true}).fill('data/app.db');
 await dialog.getByRole('button',{name:'Continue',exact:true}).click();
 await dialog.getByText(/use absolute paths/).waitFor();
 await dialog.getByLabel('Database files for web',{exact:true}).fill('/data/a.db');
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 site.config.services=services();await page.reload();

 // 2. Failed backup: names the file, the service, the actions.
 await nav('Jobs');
 const row=job=>page.locator('tr',{hasText:job});
 await page.locator('tbody tr').first().waitFor();
 await page.getByRole('button',{name:'View job'}).first().click();
 const alert=dialog.locator('.alert-panel');
 await alert.getByText('A declared database file is missing.').waitFor();
 assert.equal(await alert.locator('.path-box code').textContent(),'/data/app.db');
 assert.match(await alert.locator('.path-box small').textContent(),/Missing in services web, worker/);
 assert.match(await alert.locator('.dn-next').textContent(),/next scheduled backup \(every day at 02:00\)/);
 assert.match(await alert.locator('.later small').textContent(),/offline for about 22 min/);
 assert.equal(await alert.getByRole('button').allTextContents().then(x=>x.join('|')),'Remove path|Open settings|Back up now');
 await page.screenshot({path:shots+'/job-fix-1440.png'});
 await alert.getByRole('button',{name:'Remove path'}).click();
 const confirm=page.locator('dialog.sq-confirm');
 await confirm.getByText(/no longer health-checked/).waitFor();
 await confirm.getByRole('button',{name:'Cancel'}).click();
 assert.equal(saved.length,1,'cancel saves nothing');
 await alert.getByRole('button',{name:'Remove path'}).click();
 await confirm.getByRole('button',{name:'Remove path'}).click();
 await alert.getByText(/was removed from the site/).waitFor();
 const removed=saved.at(-1).config.services;
 assert.deepEqual(removed.map(x=>x.sqliteFiles),[['/data/sessions.db'],['/data/sessions.db'],['/data/queue.db'],[],[]]);
 assert.equal(removed[0].sqliteSigtermConfirmed,true);
 await page.setViewportSize({width:390,height:900});await page.screenshot({path:shots+'/job-fix-390.png'});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal scroll at 390');
 const heights=await alert.locator('.btn-row button').evaluateAll(b=>b.map(x=>x.getBoundingClientRect().height));assert.ok(heights.every(h=>h===heights[0]),'buttons share one height');
 await page.setViewportSize({width:1440,height:1000});
 await dialog.getByRole('button',{name:'Close dialog'}).first().click();
 // Back up now queues a backup; Open settings opens the site form.
 await page.getByRole('button',{name:'View job'}).nth(1).click();
 await alert.getByText('A declared database file is now a link.').waitFor();
 await alert.getByRole('button',{name:'Back up now'}).click();
 await dialog.waitFor({state:'hidden'});assert.equal(queued,1);
 await page.getByRole('button',{name:'View job'}).nth(2).click();
 await alert.getByText('A declared database file is missing, unreadable or a link.').waitFor();
 assert.equal(await alert.locator('.path-box').count(),0);
 assert.equal(await alert.getByRole('button').allTextContents().then(x=>x.join('|')),'Open settings|Back up now');
 await alert.getByRole('button',{name:'Open settings'}).click();
 await page.getByRole('heading',{name:'Edit site configuration'}).waitFor();
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();

 // 3. Jobs list: one row per restore test, steps folded under it.
 await nav('Jobs');
 await page.locator('tbody tr').first().waitFor();
 assert.equal(await page.locator('tbody tr',{hasText:'restore test'}).count(),2,'two tests, five step jobs');
 const failedRow=page.locator('tbody tr',{hasText:'restore test'}).filter({hasText:'Failed at check health'});
 await failedRow.waitFor();
 await page.locator('tbody tr',{hasText:'6 steps, 4 min'}).waitFor();
 await page.getByRole('button',{name:'Show steps'}).first().click();
 const failedStep=page.locator('tr.test-step.is-fail');
 await failedStep.getByText('Check health').waitFor();
 assert.match(await failedStep.textContent(),/did not answer on \/health/);
 assert.equal(await page.locator('tr.test-step').count(),6);
 await page.screenshot({path:shots+'/jobs-1440.png'});
 await page.setViewportSize({width:390,height:900});await page.screenshot({path:shots+'/jobs-390.png',fullPage:true});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'jobs: no horizontal scroll at 390');
 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:'Hide steps'}).click();
 assert.equal(await page.locator('tr.test-step').count(),0);
 await page.locator('tbody tr',{hasText:'restore test'}).first().getByRole('button',{name:'View job'}).click();
 await page.getByText('Restore test failed').waitFor();
 assert.deepEqual(errors,[]);
 console.log('Jobs and SQLite passed: per-service SQLite editor with shared group, failed-backup fix view with confirmed removal, one row per restore test.');
}finally{await browser.close();}
