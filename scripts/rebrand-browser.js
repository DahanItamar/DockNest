import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
const directory='data/theme-verification/routes';
await mkdir(directory,{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 const problems=[];page.on('pageerror',error=>problems.push(error.message));
 const now=Date.now(),time=hours=>new Date(now-hours*3600000).toISOString();
 const state={servers:[{id:'production',name:'Production EU',note:'Main production host',username:'root',host:'198.51.100.20',port:22,hostKey:'ab'.repeat(32)},{id:'staging',name:'Staging',note:'Preview environment',username:'deploy',host:'198.51.100.21',port:22,hostKey:'cd'.repeat(32)}],sites:[{id:'acme',name:'Acme Store',serverId:'production',config:{containers:['shop-web','shop-db'],domains:['shop.example.invalid'],healthUrl:'https://shop.example.invalid/health'}},{id:'portfolio',name:'Portfolio',serverId:'production',config:{containers:['portfolio-web'],domains:['portfolio.example.invalid']}},{id:'docs',name:'Docs Portal',serverId:'staging',config:{containers:['docs-web','docs-db'],domains:['docs.example.invalid']}},{id:'agency',name:'Agency Site',serverId:'staging',config:{containers:['agency-web'],domains:[]}}],policies:[{siteId:'acme',enabled:true,schedule:'0 2 * * *',timezone:'Asia/Jerusalem',retention:7},{siteId:'portfolio',enabled:true,schedule:'0 3 * * *',timezone:'Asia/Jerusalem',retention:7},{siteId:'docs',enabled:false,schedule:'0 4 * * *',timezone:'Asia/Jerusalem',retention:7},{siteId:'agency',enabled:true,schedule:'0 1 * * 1',timezone:'Asia/Jerusalem',retention:14}],backups:[{id:'acme-latest',siteId:'acme',capturedAt:time(2),createdAt:time(2),size:1.8*1024**3,verified:true,status:'verified',pinned:true,downtimeMs:1200},{id:'acme-previous',siteId:'acme',createdAt:time(26),size:1.7*1024**3,verified:true,status:'verified',pinned:false,downtimeMs:1100},{id:'portfolio-latest',siteId:'portfolio',createdAt:time(4),size:840*1024**2,verified:true,status:'verified',pinned:false,downtimeMs:900},{id:'docs-latest',siteId:'docs',createdAt:time(30),size:420*1024**2,verified:true,status:'verified',pinned:false,downtimeMs:800}],jobs:[{id:'job-acme',siteId:'acme',type:'backup',status:'running',stage:'uploading',createdAt:time(.2)},{id:'job-docs',siteId:'docs',type:'backup',status:'failed',stage:'preflight',createdAt:time(1)},{id:'job-portfolio',siteId:'portfolio',type:'backup',status:'completed',stage:'completed',createdAt:time(4)}],audit:[{id:'audit-1',action:'backup.created',actor:'Administrator',createdAt:time(2),details:{siteId:'acme',backupId:'acme-latest'}},{id:'audit-2',action:'server.details',actor:'Administrator',createdAt:time(3),details:{name:'Production EU'}},{id:'audit-3',action:'policy.updated',actor:'Operator',createdAt:time(4),details:{siteId:'docs',enabled:false}}],storage:{used:124*1024**3,total:500*1024**3},maintenance:{title:'Back shortly',message:'We are carrying out scheduled maintenance. Please try again soon.',color:'#5E35B1'}};
 const targets=[{id:'primary',name:'Primary storage',host:'storage.example.invalid',port:22,username:'docknest',root:'/home/docknest',auth_type:'ssh-key',capacity_bytes:1e12},{id:'secondary',name:'Secondary storage',host:'archive.example.invalid',port:22,username:'docknest',root:'/home/archive',auth_type:'password',capacity_bytes:2e12}];
 let role='admin';
 await page.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:true,csrfToken:'fixture',user:{id:'admin',name:'Administrator',role},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000}}));
 await page.route('**/api/auth/activity',r=>r.fulfill({json:{}}));
 await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.route('**/api/storage-targets',r=>r.fulfill({json:{targets,activeTargetId:'primary'}}));
 await page.route('**/api/storage-report',r=>r.fulfill({json:{generatedAt:new Date().toISOString(),storages:[],sites:[],totals:{packages:0,bytes:0,estimateUpToBytes:0,estimateUpToPercent:0},growth:{days:30,points:[],fromBytes:0,toBytes:0,changeBytes:0},method:''}}));
 await page.route('**/api/access',r=>r.fulfill({json:{users:[{id:'admin',name:'Administrator',email:'admin@example.invalid',role:'admin',status:'active',activeSessions:1},{id:'operator',name:'Sam Operator',email:'sam@example.invalid',role:'operator',status:'active',activeSessions:0}],security:{idleMinutes:30,invitationMinutes:15,absoluteHours:8}}}));
 await page.addInitScript(()=>localStorage.setItem('docknest-theme','light'));
 await page.goto(process.env.TEST_BASE_URL||'http://127.0.0.1:5173');
 const routes=[['Overview','dashboard'],['Servers','servers'],['Sites & schedules','sites'],['Backups','backups'],['Jobs','jobs'],['Maintenance','maintenance'],['Audit','audit'],['Storage','storage'],['Access','access']];
 async function navigate(name){if(await page.evaluate(()=>innerWidth<900&&!document.querySelector('.mobile-open')))await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('navigation').getByRole('button',{name,exact:true}).click();await page.evaluate(()=>document.fonts.ready);await page.waitForFunction(()=>[...document.querySelectorAll('img[src^="/brand/"]')].every(image=>image.complete&&image.naturalWidth>0));}
 async function equalCards(selector){const cards=await page.locator(selector).evaluateAll(elements=>elements.map(el=>{const r=el.getBoundingClientRect();return {width:r.width,height:r.height,x:r.x,y:r.y}}));if(cards.length>=2){for(const card of cards){assert.ok(Math.abs(card.width-cards[0].width)<1,'Equal widths: '+selector);assert.ok(Math.abs(card.height-cards[0].height)<1,'Equal heights: '+selector);}}}
 for(const theme of ['light','dark']){
  if(theme==='dark')await page.getByRole('button',{name:'Switch to dark theme'}).click();
  for(const [route,slug] of routes){
   await page.setViewportSize({width:1440,height:1000});await navigate(route);
   if(route==='Sites & schedules')await equalCards('.site-card');
   if(route==='Storage'){await equalCards('.storage-card');const bars=await page.locator('.storage-card-actions').evaluateAll(elements=>elements.map(el=>({y:el.getBoundingClientRect().y,height:el.getBoundingClientRect().height})));assert.ok(Math.abs(bars[0].y-bars[1].y)<1,'Storage action baselines');assert.ok(Math.abs(bars[0].height-bars[1].height)<1,'Storage action heights');}
   if(route==='Access')await equalCards('.access-grid>.panel');
   if(route==='Backups'){await page.locator('.backup-group>summary').first().click();assert.equal(await page.locator('.backup-group[open] .recovery-row').count(),2);assert.equal(await page.getByRole('button',{name:'Download full ZIP acme-latest'}).count(),1);}
   await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${directory}/${slug}-${theme}.png`,fullPage:true});
   for(const width of [1920,1280,1024,768,390,320]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,route+' fits '+width);}
   await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${directory}/${slug}-${theme}-mobile.png`,fullPage:true});
  }
 }
 await page.setViewportSize({width:1440,height:1000});await navigate('Sites & schedules');
 let queued=0;await page.route('**/api/sites/acme/backup',r=>{queued++;assert.equal(r.request().method(),'POST');assert.deepEqual(r.request().postDataJSON(),{});return r.fulfill({json:{id:'fixture-queued'}});});
 await page.getByRole('article',{name:'Acme Store',exact:true}).getByRole('button',{name:'Back up now',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Backup queued.'}).waitFor();assert.equal(queued,1);
 await navigate('Backups');await page.locator('.backup-group>summary').first().click();
 let pin;await page.route('**/api/backups/acme-latest/pin',r=>{pin=r.request().postDataJSON();return r.fulfill({json:{ok:true}});});
 await page.getByRole('button',{name:'Unpin backup acme-latest',exact:true}).click();await page.getByRole('status').filter({hasText:'Backup unpinned.'}).waitFor();assert.deepEqual(pin,{pinned:false});
 await page.getByRole('button',{name:'Restore backup acme-latest',exact:true}).click();await page.getByRole('dialog').getByLabel('Target server').waitFor();await page.getByRole('button',{name:'Close dialog'}).click();
 await navigate('Maintenance');let saved;
 await page.route('**/api/maintenance',r=>{assert.equal(r.request().method(),'PATCH');saved=r.request().postDataJSON();return r.fulfill({json:saved});});
 await page.getByLabel('Page title',{exact:true}).fill('Scheduled update');await page.getByRole('button',{name:'Save design',exact:true}).click();await page.getByRole('status').filter({hasText:'Maintenance design saved.'}).waitFor();assert.equal(saved.title,'Scheduled update');assert.equal(saved.color.toLowerCase(),'#5e35b1');
 role='operator';await page.reload();await navigate('Sites & schedules');assert.equal(await page.getByRole('button',{name:'Remove site',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Back up now',exact:true}).count(),4);assert.equal(await page.getByRole('navigation').getByRole('button',{name:'Access',exact:true}).count(),0);assert.equal(await page.getByRole('navigation').getByRole('button',{name:'Storage',exact:true}).count(),0);
 const authPage=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 authPage.on('pageerror',error=>problems.push(error.message));
 await authPage.addInitScript(()=>localStorage.setItem('docknest-theme','light'));
 await authPage.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:false,setupRequired:true}}));
 await authPage.route('**/api/auth/invite-info',r=>r.fulfill({json:{name:'Sam Operator',expiresAt:new Date(Date.now()+900000).toISOString(),serverTime:Date.now()}}));
 for(const [slug,hash,heading] of [['signin','','Sign in'],['setup','#/setup','Set up DockNest'],['enrollment','#/enroll/'+ 'x'.repeat(43),'Set up access for Sam Operator']]){
  await authPage.goto((process.env.TEST_BASE_URL||'http://127.0.0.1:5173')+'/'+hash);
  await authPage.getByRole('heading',{name:heading,exact:true}).waitFor();
  for(const theme of ['light','dark']){
   if(await authPage.locator('html').getAttribute('data-theme')!==theme)await authPage.getByRole('button',{name:'Switch to '+theme+' theme'}).click();
   for(const [width,height,suffix] of [[1440,1000,''],[390,844,'-mobile']]){
    await authPage.setViewportSize({width,height});await authPage.evaluate(()=>document.fonts.ready);
    await authPage.waitForFunction(()=>[...document.querySelectorAll('img[src^="/brand/"]')].every(img=>img.complete&&img.naturalWidth>0));
    assert.equal(await authPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,slug+' '+theme+' fits '+width);
    await authPage.screenshot({path:directory+'/'+slug+'-'+theme+suffix+'.png',fullPage:true});
   }
  }
 }
 await authPage.close();
 assert.deepEqual(problems,[]);
 console.log('Full-site UI checks passed: all nine routes in light and dark, desktop/mobile screenshots, six responsive widths, equal card geometry, grouped recovery points, unchanged backup/pin/restore/maintenance requests and existing operator restrictions.');
}finally{await browser.close();}
