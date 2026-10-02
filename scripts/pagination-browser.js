import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
const directory=process.env.PAGINATION_EVIDENCE_DIR||'data/pagination-verification';
await mkdir(directory,{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const time=i=>new Date(Date.now()-i*3600000).toISOString();
 const servers=Array.from({length:29},(_,i)=>({id:'host-'+i,name:'Docker host '+i,username:'root',host:'192.0.2.'+(i+1),port:22,hostKey:'ab'.repeat(32)}));
 const sites=Array.from({length:45},(_,i)=>({id:'site-'+i,name:'Website '+i,serverId:servers[i%29].id,config:{containers:['web-'+i,'db-'+i],domains:['site-'+i+'.example.invalid'],healthUrl:'https://site-'+i+'.example.invalid/health'}}));
 const backups=Array.from({length:506},(_,i)=>({id:'backup-'+i,siteId:'site-'+(i<25?0:1+Math.floor((i-25)/24)),capturedAt:time(i),createdAt:time(i),verified:true,size:1048576,pinned:false}));
 const audit=Array.from({length:137},(_,i)=>({id:'event-'+i,createdAt:time(i),action:'fixture.audit.'+i,actor:'Administrator',details:{siteId:'site-'+i,review:'Synthetic audit details'}}));
 const jobs=Array.from({length:76},(_,i)=>({id:'job-'+i,siteId:sites[i%44].id,type:'backup',status:'completed',stage:'completed',createdAt:time(i)}));
 const state={servers,sites,backups,jobs,audit,policies:sites.map(site=>({siteId:site.id,enabled:true,schedule:'0 2 * * *',timezone:'Asia/Jerusalem',retention:7})),storage:{used:504*1048576,total:1e12},maintenance:{title:'Back shortly',message:'Scheduled maintenance. Please return soon.',color:'#5E35B1'}};
 const targets=Array.from({length:11},(_,i)=>({id:'target-'+i,name:'Backup destination '+i,host:'storage-'+i+'.example.invalid',port:22,username:'docknest',root:'/home/docknest',auth_type:'ssh-key',capacity_bytes:1e12}));
 const users=Array.from({length:31},(_,i)=>({id:i?'person-'+i:'admin',name:i?'Operator '+i:'Administrator',role:i?'operator':'admin',status:'active',activeSessions:0}));
 await page.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:true,csrfToken:'fixture',user:{id:'admin',name:'Administrator',role:'admin'},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000}}));
 await page.route('**/api/auth/activity',r=>r.fulfill({json:{}}));
 await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.route('**/api/storage-targets',r=>r.fulfill({json:{targets,activeTargetId:'target-0'}}));
 await page.route('**/api/access',r=>r.fulfill({json:{users,security:{idleMinutes:30,absoluteHours:8,invitationMinutes:15}}}));
 await page.addInitScript(()=>localStorage.setItem('docknest-theme','light'));
 await page.goto(process.env.TEST_BASE_URL||'http://127.0.0.1:5173');
 const navigate=async name=>{if(await page.evaluate(()=>innerWidth<900&&!document.querySelector('.mobile-open')))await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name,exact:true}).click();await page.evaluate(()=>document.fonts.ready);};
 await navigate('Audit');
 const auditPager=()=>page.getByRole('group',{name:'Audit pagination',exact:true});
 assert.equal(await page.locator('tbody tr').count(),10);
 await auditPager().getByRole('button',{name:'Audit next page',exact:true}).click();
 await page.getByRole('button',{name:'Refresh dashboard'}).click();
 await auditPager().getByRole('status').filter({hasText:'11-20 of 137'}).waitFor();
 assert.equal(await auditPager().getByLabel('Audit page',{exact:true}).textContent(),'Page 2 of 14','Refresh preserves page');
 await page.getByLabel('Filter Audit').fill('fixture.audit.136');
 await page.getByText('fixture.audit.136',{exact:true}).waitFor();assert.equal(await page.locator('tbody tr').count(),1);
 await page.getByLabel('Filter Audit').fill('');await page.getByText('fixture.audit.0',{exact:true}).waitFor();
 assert.equal(await auditPager().getByLabel('Audit page',{exact:true}).textContent(),'Page 1 of 14','Search resets page');
 const auditY=(await auditPager().boundingBox()).y+await page.evaluate(()=>scrollY);
 for(let i=1;i<14;i++)await auditPager().getByRole('button',{name:'Audit next page',exact:true}).click();
 await auditPager().getByRole('status').filter({hasText:'131-137 of 137'}).waitFor();
 assert.equal(await auditPager().getByRole('button',{name:'Audit next page',exact:true}).isDisabled(),true);assert.ok(Math.abs((await auditPager().boundingBox()).y+await page.evaluate(()=>scrollY)-auditY)<1,'Audit pager stays in place on a partial last page');
 state.audit=audit.slice(0,4);await page.getByRole('button',{name:'Refresh dashboard'}).click();
 await page.getByText('fixture.audit.0',{exact:true}).waitFor();assert.equal(await page.locator('tbody tr').count(),4,'Shrinking collection clamps the page');
 state.audit=audit;await page.getByRole('button',{name:'Refresh dashboard'}).click();
 await auditPager().getByLabel('Audit page',{exact:true}).waitFor();assert.equal(await auditPager().getByLabel('Audit page',{exact:true}).textContent(),'Page 1 of 14');
 assert.equal(await auditPager().locator('select,input[type=range]').count(),0,'Fixed pagination has no dropdowns, sliders or page-size controls');
 const tableBox=await page.locator('.table-wrap').evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight}));
 assert.equal(tableBox.height,tableBox.scroll,'Tables use natural height, with no forced vertical scrollbar');assert.equal(await page.locator('input[type=range]').count(),0,'Pagination has no sliders');

 await navigate('Jobs');const jobPager=page.getByRole('group',{name:'Jobs pagination',exact:true});assert.equal(await page.locator('tbody tr').count(),10);const jobY=(await jobPager.boundingBox()).y+await page.evaluate(()=>scrollY);
 for(let i=1;i<8;i++)await jobPager.getByRole('button',{name:'Jobs next page',exact:true}).click();assert.equal(await page.locator('tbody tr').count(),6);assert.ok(Math.abs((await jobPager.boundingBox()).y+await page.evaluate(()=>scrollY)-jobY)<1,'Jobs pager stays in place on a partial last page');
 const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const pagerY=async pager=>(await pager.boundingBox()).y+await page.evaluate(()=>scrollY);
 async function partialPage(label,selector,fullCount){
  const pager=page.getByRole('group',{name:label+' pagination',exact:true});
  await settle();assert.equal(await page.locator(selector).count(),fullCount);
  const y=await pagerY(pager),next=pager.getByRole('button',{name:label+' next page',exact:true});
  while(!await next.isDisabled())await next.click();
  await settle();assert.equal(await page.locator(selector).count(),1);
  assert.ok(Math.abs(await pagerY(pager)-y)<1.1,label+' pager stays in place on a one-item last page');
  while(!await pager.getByRole('button',{name:label+' previous page',exact:true}).isDisabled())await pager.getByRole('button',{name:label+' previous page',exact:true}).click();
  await settle();assert.ok(Math.abs(await pagerY(pager)-y)<1.1,label+' pager stays in place returning to the full page');
 }
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});
  await navigate('Servers');await partialPage('Servers','.server-card',4);
  await navigate('Sites & schedules');await partialPage('Sites','.site-card',4);
  await navigate('Backups');await partialPage('Backup sites','.backup-group',3);
  await page.locator('.backup-group>summary').first().click();
  await partialPage('Recovery points for Website 0','.backup-group[open] .recovery-row',3);
 }
 await page.setViewportSize({width:1440,height:1000});
 await navigate('Servers');await page.getByLabel('Filter Servers').fill('Docker host 28');assert.equal(await page.locator('.server-card').count(),1);assert.equal(await page.getByRole('group',{name:'Servers pagination',exact:true}).count(),0,'Single-page search has no empty reserved page or pager');await page.getByLabel('Filter Servers').fill('');
 await navigate('Backups');await page.locator('.backup-group>summary').first().click();
 const historyPager=page.getByRole('group',{name:'Recovery points for Website 0 pagination',exact:true});
 assert.equal(await page.locator('.backup-group[open] .recovery-row').count(),3);
 await historyPager.getByRole('button',{name:'Recovery points for Website 0 next page',exact:true}).click();
 const link=page.getByRole('link',{name:'Download full ZIP backup-3',exact:true});
 assert.equal(await link.getAttribute('href'),'/api/backups/backup-3/download?format=zip');
 let pin;await page.route('**/api/backups/backup-3/pin',r=>{pin=r.request().postDataJSON();return r.fulfill({json:{ok:true}})});
 await page.getByRole('button',{name:'Pin backup backup-3',exact:true}).click();await page.getByRole('status').filter({hasText:'Backup pinned.'}).waitFor();assert.deepEqual(pin,{pinned:true});
 await page.getByRole('button',{name:'Restore backup backup-3',exact:true}).click();await page.getByRole('dialog').getByLabel('Target server').waitFor();await page.getByRole('button',{name:'Close dialog'}).click();
 const routes=[['Overview','dashboard','.dash-site',5],['Servers','servers','.server-card',4],['Sites & schedules','sites','.site-card',4],['Backups','backups','.backup-group',3],['Jobs','jobs','tbody tr',10],['Maintenance','maintenance','tbody tr',5],['Audit','audit','tbody tr',10],['Storage','storage','.storage-card',2],['Access','access','tbody tr',5]];
 for(const theme of ['light']){
  if(theme==='dark')await page.getByRole('button',{name:'Switch to dark theme'}).click();
  for(const [route,slug,selector,count] of routes){
   await page.setViewportSize({width:1440,height:1000});await navigate(route);
   await page.locator(selector).first().waitFor().catch(async e=>{await page.screenshot({path:'data/pagination-failure.png',fullPage:true});console.log(route,errors);throw e});assert.equal(await page.locator(selector).count(),count,route+' bounded record count');
   if(route==='Backups')await page.locator('.backup-group>summary').first().click();
   if(route==='Overview')await page.locator('.dash-site>summary').first().click();
   if(route==='Audit')await page.locator('.audit-details>summary').first().click();
   await page.waitForFunction(()=>[...document.querySelectorAll('img[src^="/brand/"]')].every(img=>img.complete&&img.naturalWidth>0));
   await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:directory+'/'+slug+'-'+theme+'.png',fullPage:true});
   for(const width of [1920,1280,1024,768,390,320]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,route+' fits '+width);}
   await page.setViewportSize({width:390,height:844});await page.screenshot({path:directory+'/'+slug+'-'+theme+'-mobile.png',fullPage:true});
  }
 }
 assert.deepEqual(errors,[]);
 console.log('Large-data pagination passed: every main route bounded in light-only presentation and six widths; search reset, refresh preservation, shrink clamping, fixed page sizes, consistent Previous/Next controls, natural table height and original backup/restore actions passed.');
}finally{await browser.close();}
