import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const state={servers:[{id:'host',name:'Source host'}],sites:[],policies:[],jobs:[],audit:[],backups:[],storage:{used:0,total:1e12}};
 const docker=[{name:'leads-worker',image:'worker',state:'running',labels:{'com.docker.compose.project':'leads'},backupConfiguration:{composeFiles:['/root/leads/compose.yml'],configFiles:['/root/leads/.env','/root/leads/.env.production']}},{name:'leads-web',image:'web',state:'running',labels:{'com.docker.compose.project':'leads'},webHints:{healthUrls:['http://127.0.0.1:3200/'],domains:['leads.example.org']}},
  {name:'media-web',image:'web',state:'running',labels:{'com.docker.compose.project':'media'}},{name:'media-db',image:'postgres',state:'running',labels:{'com.docker.compose.project':'media'}},
  {name:'paper-web',image:'web',state:'running',labels:{'com.docker.compose.project':'paperless'}},{name:'paper-redis',image:'redis',state:'running',labels:{'com.docker.compose.project':'paperless'}}];
 const staticSite={name:'example.org',kind:'static',domains:['example.org'],documentRoot:'/var/www/example.org',healthUrl:'https://example.org',configFiles:['/etc/nginx/sites-available/example']};
 await page.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:true,csrfToken:'fixture',user:{id:'admin',name:'Reviewer',role:'admin'},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000}}));
 await page.route('**/api/auth/activity',r=>r.fulfill({json:{}}));await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.route('**/api/servers/host/discover',r=>r.fulfill({json:{containers:docker,staticSites:[staticSite]}}));
 await page.goto(process.env.TEST_BASE_URL||'http://127.0.0.1:5176');await page.getByRole('navigation').getByRole('button',{name:'Apps & schedules',exact:true}).click();
 const dialog=page.getByRole('dialog');let submitted;
 await page.route('**/api/sites',r=>{submitted=r.request().postDataJSON();state.sites=[{id:'site',...submitted}];return r.fulfill({json:state.sites[0]});});
 await page.getByRole('button',{name:'Add app',exact:true}).click();await dialog.getByRole('button',{name:'Select app leads',exact:true}).click();await dialog.getByRole('button',{name:'Continue',exact:true}).click();
 assert.equal(await dialog.getByLabel('Application health URL').inputValue(),'http://127.0.0.1:3200/');assert.match(await dialog.getByLabel('Environment and other configuration files (one absolute path per line)',{exact:true}).inputValue(),/\.env.production/);
 await dialog.getByText('Advanced backup settings',{exact:true}).click();assert.equal(await dialog.getByLabel('Domains (comma separated)').inputValue(),'leads.example.org');await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:'Add app',exact:true}).click();await dialog.getByLabel('Find an app').fill('missing-site');await dialog.getByText('No apps match this search.',{exact:true}).waitFor();assert.equal(await dialog.getByRole('button',{name:'Select app leads',exact:true}).count(),0);await dialog.getByLabel('Find an app').fill('example.org');await dialog.getByRole('button',{name:'Select app example.org',exact:true}).click();await dialog.getByRole('button',{name:'Continue',exact:true}).click();
 assert.equal(await dialog.getByLabel('Application health URL').inputValue(),'https://example.org');assert.equal(await dialog.getByLabel('Environment and other configuration files (one absolute path per line)',{exact:true}).inputValue(),staticSite.configFiles[0]);await dialog.getByRole('button',{name:'Continue',exact:true}).click();
 assert.equal(await dialog.getByRole('checkbox',{name:/normal stop/}).count(),0);await dialog.getByRole('checkbox',{name:/reviewed external dependencies/}).check();await dialog.getByRole('checkbox',{name:/No deployment or process/}).check();
 await mkdir('data/site-setup-verification',{recursive:true});for(const width of [1440,390,320]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'data/site-setup-verification/review-'+width+'.png',fullPage:true});}
 await dialog.getByRole('button',{name:'Add app',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(submitted.config.kind,'static');assert.equal(submitted.config.documentRoot,staticSite.documentRoot);assert.deepEqual(submitted.config.containers,[]);assert.equal(submitted.config.maintenanceRequired,false);
 await page.getByRole('button',{name:'Edit configuration',exact:true}).click();assert.equal(await dialog.getByLabel('Application health URL').inputValue(),'https://example.org');assert.equal(await dialog.getByRole('button',{name:'Continue',exact:true}).isEnabled(),true);await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 // Coverage: what other apps on this server back up is hidden; a partly covered project keeps its free services.
 const app=(id,name,containers)=>({id,serverId:'host',name,config:{kind:'docker',containers}});
 state.sites.push(app('media','Gallery',['media-web','media-db']),app('paper','Paperless',['paper-redis']));
 await page.setViewportSize({width:1440,height:1000});
 const openWizard=async()=>{await page.reload();await page.getByRole('navigation').getByRole('button',{name:'Apps & schedules',exact:true}).click();await page.getByRole('button',{name:'Add app',exact:true}).click();await dialog.getByRole('button',{name:'Refresh containers',exact:true}).waitFor();};
 await openWizard();
 await dialog.getByText('Hidden because other apps already back them up: example.org, Gallery.',{exact:true}).waitFor();
 for(const name of ['media','example.org'])assert.equal(await dialog.getByRole('button',{name:'Select app '+name,exact:true}).count(),0,name);
 await dialog.getByLabel('Find an app').fill('paperless');await dialog.getByText('1 more service already backed up in Paperless',{exact:true}).waitFor();
 assert.equal(await dialog.locator('.application-group',{hasText:'paperless'}).locator('.site-services').textContent(),'paper-web');
 const narrow=async name=>{await page.setViewportSize({width:390,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,name);await page.screenshot({path:'data/site-setup-verification/'+name+'-390.png',fullPage:true});await page.setViewportSize({width:1440,height:1000});};
 await narrow('partly-covered');
 await dialog.getByText('My app needs a custom selection',{exact:true}).click();
 assert.deepEqual(await dialog.getByLabel('Docker container (app)').locator('option').evaluateAll(options=>options.map(option=>option.value).filter(Boolean)),['leads-worker','leads-web','paper-web']);
 // The server refuses a container another app took meanwhile; the wizard shows its message.
 await page.unroute('**/api/sites');await page.route('**/api/sites',r=>r.fulfill({status:409,json:{error:'paper-web is already backed up in Paperless. Edit that app instead.',code:'CONTAINER_ALREADY_BACKED_UP'}}));
 await dialog.getByRole('button',{name:'Select app paperless',exact:true}).click();await dialog.getByRole('button',{name:'Continue',exact:true}).click();
 await dialog.getByLabel('Public website URL').fill('https://paper.example.org');await dialog.getByLabel('Application health URL').fill('http://127.0.0.1:8000/');await dialog.getByLabel('Compose project files (one absolute path per line)',{exact:true}).fill('/root/paperless/compose.yml');await dialog.getByRole('button',{name:'Continue',exact:true}).click();
 for(const name of [/reviewed external dependencies/,/normal stop/,/No containers or processes outside/])await dialog.getByRole('checkbox',{name}).check();
 await dialog.getByRole('button',{name:'Add app',exact:true}).click();
 const refused=dialog.getByRole('alert');await refused.getByText('The app could not be saved',{exact:true}).waitFor();assert.equal(await refused.getByText('paper-web is already backed up in Paperless. Edit that app instead.',{exact:true}).count(),1);
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 // The Map "+" follows the same rule; on a phone the partly covered row's caption wraps inside the sheet.
 await page.getByRole('navigation').getByRole('button',{name:'Map',exact:true}).click();await page.setViewportSize({width:390,height:900});
 await page.locator('.map-list-group',{hasText:'Source host'}).getByRole('button',{name:'Add app'}).click();
 const sheet=page.getByRole('dialog');await sheet.getByText('Hidden because other apps already back them up: example.org, Gallery.',{exact:true}).waitFor();
 await sheet.getByText('Docker · 1 container · 1 more service already backed up in Paperless',{exact:true}).waitFor();
 assert.equal(await sheet.locator('.map-row').evaluateAll(rows=>rows.every(row=>row.scrollWidth<=row.clientWidth)),true,'map rows wrap');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'map sheet');await page.screenshot({path:'data/site-setup-verification/map-add-390.png'});
 await page.keyboard.press('Escape');await sheet.waitFor({state:'detached'});await page.setViewportSize({width:1440,height:1000});
 // Everything covered: an empty state that names the apps, instead of "No Docker containers found".
 state.sites.push(app('leads','Leads',['leads-worker','leads-web']),app('paper-more','Paper web',['paper-web']));
 await openWizard();
 await dialog.getByText('Everything on Source host is already backed up.',{exact:true}).waitFor();
 await dialog.getByText('It belongs to example.org, Leads, Gallery, Paper web, Paperless. To change what an app includes, use Edit configuration on its card.',{exact:true}).waitFor();
 await narrow('all-covered');
 assert.equal(await dialog.getByText(/No Docker containers found/).count(),0);
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();assert.deepEqual(errors,[]);
 console.log('App setup passed: detected Docker health/domain/env files, searchable static discovery, saved static configuration, editing, three responsive widths, hidden and partly covered apps in the wizard and the Map, the server refusal and the all-covered empty state.');
}finally{await browser.close();}
