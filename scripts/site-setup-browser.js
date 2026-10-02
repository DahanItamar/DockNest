import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const state={servers:[{id:'host',name:'Source host'}],sites:[],policies:[],jobs:[],audit:[],backups:[],storage:{used:0,total:1e12}};
 const docker=[{name:'leads-worker',image:'worker',state:'running',labels:{'com.docker.compose.project':'leads'},backupConfiguration:{composeFiles:['/root/leads/compose.yml'],configFiles:['/root/leads/.env','/root/leads/.env.production']}},{name:'leads-web',image:'web',state:'running',labels:{'com.docker.compose.project':'leads'},webHints:{healthUrls:['http://127.0.0.1:3200/'],domains:['leads.example.org']}}];
 const staticSite={name:'example.org',kind:'static',domains:['example.org'],documentRoot:'/var/www/example.org',healthUrl:'https://example.org',configFiles:['/etc/nginx/sites-available/example']};
 await page.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:true,csrfToken:'fixture',user:{id:'admin',name:'Reviewer',role:'admin'},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000}}));
 await page.route('**/api/auth/activity',r=>r.fulfill({json:{}}));await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.route('**/api/servers/host/discover',r=>r.fulfill({json:{containers:docker,staticSites:[staticSite]}}));
 await page.goto(process.env.TEST_BASE_URL||'http://127.0.0.1:5176');await page.getByRole('navigation').getByRole('button',{name:'Sites & schedules',exact:true}).click();
 const dialog=page.getByRole('dialog');let submitted;
 await page.route('**/api/sites',r=>{submitted=r.request().postDataJSON();state.sites=[{id:'site',...submitted}];return r.fulfill({json:state.sites[0]});});
 await page.getByRole('button',{name:'Add site',exact:true}).click();await dialog.getByRole('button',{name:'Select site leads',exact:true}).click();await dialog.getByRole('button',{name:'Continue',exact:true}).click();
 assert.equal(await dialog.getByLabel('Application health URL').inputValue(),'http://127.0.0.1:3200/');assert.match(await dialog.getByLabel('Environment and other configuration files (one absolute path per line)',{exact:true}).inputValue(),/\.env.production/);
 await dialog.getByText('Advanced backup settings',{exact:true}).click();assert.equal(await dialog.getByLabel('Domains (comma separated)').inputValue(),'leads.example.org');await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:'Add site',exact:true}).click();await dialog.getByLabel('Find a site').fill('missing-site');await dialog.getByText('No sites match this search.',{exact:true}).waitFor();assert.equal(await dialog.getByRole('button',{name:'Select site leads',exact:true}).count(),0);await dialog.getByLabel('Find a site').fill('example.org');await dialog.getByRole('button',{name:'Select site example.org',exact:true}).click();await dialog.getByRole('button',{name:'Continue',exact:true}).click();
 assert.equal(await dialog.getByLabel('Application health URL').inputValue(),'https://example.org');assert.equal(await dialog.getByLabel('Environment and other configuration files (one absolute path per line)',{exact:true}).inputValue(),staticSite.configFiles[0]);await dialog.getByRole('button',{name:'Continue',exact:true}).click();
 assert.equal(await dialog.getByRole('checkbox',{name:/normal stop/}).count(),0);await dialog.getByRole('checkbox',{name:/reviewed external dependencies/}).check();await dialog.getByRole('checkbox',{name:/No deployment or process/}).check();
 await mkdir('data/site-setup-verification',{recursive:true});for(const width of [1440,390,320]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'data/site-setup-verification/review-'+width+'.png',fullPage:true});}
 await dialog.getByRole('button',{name:'Add site',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(submitted.config.kind,'static');assert.equal(submitted.config.documentRoot,staticSite.documentRoot);assert.deepEqual(submitted.config.containers,[]);assert.equal(submitted.config.maintenanceRequired,false);
 await page.getByRole('button',{name:'Edit configuration',exact:true}).click();assert.equal(await dialog.getByLabel('Application health URL').inputValue(),'https://example.org');assert.equal(await dialog.getByRole('button',{name:'Continue',exact:true}).isEnabled(),true);await dialog.getByRole('button',{name:'Cancel',exact:true}).click();assert.deepEqual(errors,[]);
 console.log('Site setup passed: detected Docker health/domain/env files, searchable static discovery, saved static configuration, editing and three responsive widths.');
}finally{await browser.close();}
