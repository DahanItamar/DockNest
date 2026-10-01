import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { prepareServerKey, serverReportCommand } from '../src/server-onboarding.js';
const baseUrl = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const problems = [];
page.on('pageerror', error => problems.push(error.message));
await mkdir('data/screenshots', { recursive: true });
try {
  await page.goto(baseUrl);
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  await page.getByLabel('Password', { exact: true }).waitFor();
  await page.getByLabel('2FA code').waitFor();
  assert.equal(await page.locator('input').count(), 2, 'Login has only password and code inputs');
  assert.equal(await page.locator('.auth-card img.brand-lockup').count(),0,'Login logo belongs only in the header');
  assert.equal(await page.locator('.auth-header img.brand-lockup').count(),1,'Header displays the brand once');
  assert.equal(await page.title(),'DockNest — Docker Backup & Restore');
  for(const asset of ['favicon.svg','favicon.ico','apple-touch-icon.png','app-icon-192.png','app-icon-512.png','site.webmanifest','logo-horizontal-light.svg','logo-horizontal-dark.svg','logo-tagline-light.svg','logo-tagline-dark.svg']){
    assert.equal((await page.request.get(baseUrl+'/brand/'+asset)).status(),200,asset+' must be served');
  }
  async function checkContrast(){
    const failures=await page.evaluate(()=>{
      const styles=getComputedStyle(document.documentElement);
      function luminance(token){const hex=styles.getPropertyValue('--'+token).trim().replace('#','');const rgb=[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;}
      return [['text-primary','surface',4.5],['text-secondary','background',4.5],['text-muted','surface',4.5],['text-muted','surface-muted',4.5],['primary-foreground','accent',4.5],['primary-foreground','accent-hover',4.5],['link','surface',4.5],['link','accent-soft',4.5],['success','success-surface',4.5],['warning','warning-surface',4.5],['error','error-surface',4.5],['info','info-surface',4.5],['border-control','surface',3],['border-control','surface-muted',3],['focus-ring','background',3],['focus-ring','surface',3]].flatMap(([a,b,min])=>{const l=[luminance(a),luminance(b)].sort((x,y)=>y-x),ratio=(l[0]+.05)/(l[1]+.05);return ratio>=min?[]:[a+'/'+b+': '+ratio.toFixed(2)];});
    });
    assert.deepEqual(failures,[],'Semantic rendered palette must meet contrast targets');
  }
  await checkContrast();
  await page.evaluate(async()=>{await Promise.race([Promise.allSettled(document.getAnimations().map(a=>a.finished)),new Promise(resolve=>setTimeout(resolve,500))]);});
  await page.screenshot({ path: 'data/screenshots/setup-desktop.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Setup must fit mobile viewport');
  await page.evaluate(async()=>{await Promise.race([Promise.allSettled(document.getAnimations().map(a=>a.finished)),new Promise(resolve=>setTimeout(resolve,500))]);});
  await page.screenshot({ path: 'data/screenshots/setup-mobile.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button',{name:'Switch to dark theme'}).click();
  await page.locator('html[data-theme="dark"]').waitFor();
  await checkContrast();
  await page.evaluate(async()=>{await Promise.race([Promise.allSettled(document.getAnimations().map(a=>a.finished)),new Promise(resolve=>setTimeout(resolve,500))]);});
  await page.screenshot({path:'data/screenshots/setup-dark-mobile.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:1440,height:960});
  await page.evaluate(async()=>{await Promise.race([Promise.allSettled(document.getAnimations().map(a=>a.finished)),new Promise(resolve=>setTimeout(resolve,500))]);});
  await page.screenshot({path:'data/screenshots/setup-dark-desktop.png',fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'Switch to light theme'}).click();
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.evaluate(()=>getComputedStyle(document.body).transitionDuration),'0s','Reduced motion disables fallback transitions');
  await page.getByRole('button',{name:'Switch to dark theme'}).click();
  await page.locator('html[data-theme="dark"]').waitFor();
  assert.equal(await page.evaluate(()=>document.getAnimations().length),0,'Reduced motion switches without animation');
  await page.getByRole('button',{name:'Switch to light theme'}).click();
  await page.emulateMedia({reducedMotion:'no-preference'});
  // Isolated browser-only empty fixtures exercise UI navigation without creating an administrator.
  await page.route('**/api/auth/status', route => route.fulfill({ json: { authenticated: true, setupRequired: false, csrfToken: 'fixture', user: { name: 'Administrator', role: 'admin', email: 'ui-test@example.org' }, serverTime: Date.now(), idleExpiresAt: Date.now()+1800000, absoluteExpiresAt: Date.now()+28800000 } }));
  await page.route('**/api/access', route => route.fulfill({ json: { users: [], security: { idleMinutes: 30, absoluteHours: 8, invitationMinutes: 15 } } }));
  await page.route('**/api/auth/activity', route => route.fulfill({ json: { serverTime: Date.now(), idleExpiresAt: Date.now()+1800000, absoluteExpiresAt: Date.now()+28800000 } }));
  let fixtureServers=[];
  await page.route('**/api/state', route => route.fulfill({ json: { servers: fixtureServers, sites: [], policies: [], backups: [], jobs: [], restores: [], audit: [], storage: { used: 0, total: 1000000 }, maintenance: { title: 'Briefly under maintenance', message: 'We will be back shortly.', color: '#147d73' } } }));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.reload();
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  await page.evaluate(async()=>{await Promise.race([Promise.allSettled(document.getAnimations().map(a=>a.finished)),new Promise(resolve=>setTimeout(resolve,500))]);});
  await page.screenshot({ path: 'data/screenshots/dashboard-desktop.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button',{name:'Switch to dark theme'}).click();
  await page.locator('html[data-theme="dark"]').waitFor();
  await page.locator('img[src="/brand/logo-horizontal-dark.svg"]').waitFor();
  await page.evaluate(async()=>{await Promise.race([Promise.allSettled(document.getAnimations().map(a=>a.finished)),new Promise(resolve=>setTimeout(resolve,500))]);});
  await page.screenshot({path:'data/screenshots/dashboard-dark-desktop.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'Dark dashboard fits mobile');
  await page.evaluate(async()=>{await Promise.race([Promise.allSettled(document.getAnimations().map(a=>a.finished)),new Promise(resolve=>setTimeout(resolve,500))]);});
  await page.screenshot({path:'data/screenshots/dashboard-dark-mobile.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:1440,height:960});
  await page.getByRole('button',{name:'Switch to light theme'}).click();
  // Wizard requests stay inside browser fixtures; no real remote connection or key installation occurs.
  const prepared = await prepareServerKey();
  await page.route('**/api/servers/onboarding', route => route.fulfill({json:{reportCommand:serverReportCommand}}));
  await page.route('**/api/servers/prepare-key', route => route.fulfill({json:prepared}));
  let saved = 0;
  await page.route('**/api/servers/connect', route => {
    const body=route.request().postDataJSON();
    assert.equal(body.host,'server.example.org');
    assert.equal(body.username,'root');
    assert.equal(body.hostKey,'ab'.repeat(32));
    assert.equal(body.privateKey,prepared.privateKey);
    saved++;
    return route.fulfill({status:201,json:{id:'fixture-server',name:'Fixture Ubuntu',status:'connected'}});
  });
  for(const mode of ['existing','new']){
    await page.getByRole('button',{name:'Add server',exact:true}).click();
    const dialog=page.getByRole('dialog');
    await dialog.getByLabel('Server name',{exact:true}).fill('Fixture Ubuntu');
    await dialog.getByLabel('IP address or hostname',{exact:true}).fill('server.example.org');
    await dialog.getByRole('button',{name:'Continue',exact:true}).click();
    if(mode==='existing'){
      await dialog.getByLabel('SSH key option').selectOption('existing');
      await dialog.getByLabel('Select SSH private key file').setInputFiles({name:'fixture_key',mimeType:'text/plain',buffer:Buffer.from(prepared.privateKey)});
    }
    else{
      await dialog.getByLabel('SSH key option').selectOption('new');
      await dialog.getByRole('button',{name:'Create dedicated key',exact:true}).click();
      await dialog.getByRole('button',{name:'Dedicated key ready',exact:true}).waitFor();
    }
    await dialog.getByRole('button',{name:'Continue',exact:true}).click();
    await dialog.getByLabel('Paste the JSON result from your server').fill(JSON.stringify({version:1,hostname:'fixture',username:'root',uid:0,dockerInstalled:true,hostKeys:[{algorithm:'ssh-ed25519',fingerprint:'ab'.repeat(32)}]}));
    await dialog.getByRole('button',{name:'Read server result'}).click();
    if(mode==='new'){
      await page.evaluate(async()=>{await Promise.race([Promise.allSettled(document.getAnimations().map(a=>a.finished)),new Promise(resolve=>setTimeout(resolve,500))]);});
  await page.screenshot({path:'data/screenshots/server-wizard-desktop.png',fullPage:true,animations:'disabled'});
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'Wizard fits mobile');
      await page.evaluate(async()=>{await Promise.race([Promise.allSettled(document.getAnimations().map(a=>a.finished)),new Promise(resolve=>setTimeout(resolve,500))]);});
  await page.screenshot({path:'data/screenshots/server-wizard-mobile.png',fullPage:true,animations:'disabled'});
      await page.setViewportSize({width:1440,height:960});
    }
    await dialog.getByRole('button',{name:'Test connection & save'}).click();
    await dialog.getByRole('heading',{name:'Fixture Ubuntu is connected'}).waitFor();
    if(mode==='new'){
      await page.route('**/api/servers/fixture-server/discover',route=>route.fulfill({json:{containers:[{name:'first-site',image:'app:latest',state:{status:'running'}}]}}));
      await dialog.getByRole('button',{name:'Add a site',exact:true}).click();
      await dialog.getByLabel('Docker container (site)').waitFor();
      assert.equal(await dialog.getByLabel('Source server').inputValue(),'fixture-server','Successful connection hands off the chosen server');
      await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
    }else await dialog.getByRole('button',{name:'Done',exact:true}).click();
    await dialog.waitFor({state:'hidden'});
  }
  assert.equal(saved,2,'Existing and dedicated key paths both submit verified connection details');
  // Site discovery and save are browser fixtures; no containers are stopped or backed up.
  fixtureServers=[{id:'host-one',name:'Production'},{id:'host-two',name:'Other server'}];
  let discoveryFailed=true,createdSites=0;
  await page.route('**/api/servers/host-one/discover',route=>route.fulfill({json:{containers:[{name:'shop',image:'shop:latest',state:{status:'running'},mounts:[{type:'volume',destination:'/data'}]},{name:'shop-db',image:'postgres:17',state:'running'}]}}));
  await page.route('**/api/servers/host-two/discover',route=>discoveryFailed?route.fulfill({status:502,json:{error:'The server is unavailable. Retry the connection.'}}):route.fulfill({json:{containers:[]}}));
  await page.route('**/api/sites',route=>{
    const body=route.request().postDataJSON();
    assert.equal(body.serverId,'host-one');assert.equal(body.name,'My shop');
    assert.deepEqual(body.config.containers,['shop','shop-db']);
    assert.equal(body.config.stagingRoot,'/var/lib/docknest');
    assert.equal(body.config.exclusiveSourcesConfirmed,true);assert.equal(body.config.cleanShutdownConfirmed,true);assert.equal(body.config.externalReferencesConfirmed,true);
    createdSites++;return route.fulfill({status:201,json:{id:'fixture-site'}});
  });
  await page.getByRole('button',{name:'Refresh dashboard'}).click();
  await page.getByRole('navigation').getByRole('button',{name:'Sites & schedules'}).click();
  await page.getByRole('button',{name:'Add site',exact:true}).click();
  const siteDialog=page.getByRole('dialog');
  assert.equal(await siteDialog.getByRole('button',{name:'Continue',exact:true}).isDisabled(),true);
  await siteDialog.getByLabel('Source server').selectOption('host-one');
  await siteDialog.getByLabel('Docker container (site)').selectOption('shop');
  await siteDialog.getByText('Include other containers in this site (optional)',{exact:true}).click();
  await siteDialog.getByRole('checkbox',{name:'shop-db'}).check();
  await page.screenshot({path:'data/screenshots/site-selection-desktop.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'Site selection fits mobile');
  await page.screenshot({path:'data/screenshots/site-selection-mobile.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:1440,height:960});
  await siteDialog.getByRole('button',{name:'Continue',exact:true}).click();
  assert.equal(await siteDialog.getByLabel('Site name',{exact:true}).inputValue(),'shop','Container name becomes the site name');
  await siteDialog.getByLabel('Site name',{exact:true}).fill('My shop');
  await siteDialog.getByRole('button',{name:'Continue',exact:true}).click();
  await siteDialog.getByRole('checkbox',{name:/reviewed external dependencies/}).check();
  await siteDialog.getByRole('checkbox',{name:/normal stop/}).check();
  await siteDialog.getByRole('checkbox',{name:/No containers or processes/}).check();
  await siteDialog.getByRole('button',{name:'Back',exact:true}).click();
  assert.equal(await siteDialog.getByLabel('Site name',{exact:true}).inputValue(),'My shop','Back preserves edited settings');
  await siteDialog.getByRole('button',{name:'Continue',exact:true}).click();
  await siteDialog.getByRole('button',{name:'Add site',exact:true}).click();
  await siteDialog.waitFor({state:'hidden'});assert.equal(createdSites,1);
  await page.getByRole('button',{name:'Add site',exact:true}).click();
  await siteDialog.getByLabel('Source server').selectOption('host-one');
  await siteDialog.getByLabel('Docker container (site)').selectOption('shop');
  await siteDialog.getByLabel('Source server').selectOption('host-two');
  await siteDialog.getByRole('alert').getByText('The server is unavailable. Retry the connection.',{exact:true}).waitFor();
  assert.equal(await siteDialog.getByRole('button',{name:'Continue',exact:true}).isDisabled(),true,'A failed server switch cannot reuse a previous selection');
  discoveryFailed=false;await siteDialog.getByRole('button',{name:'Retry container discovery'}).click();
  await siteDialog.getByText(/No Docker containers found/).waitFor();
  assert.equal(await siteDialog.getByRole('button',{name:'Continue',exact:true}).isDisabled(),true,'Empty discovery cannot create a site');
  await siteDialog.getByRole('button',{name:'Cancel',exact:true}).click();
  let storageFixture=[];
  await page.route('**/api/storage-targets',route=>route.fulfill({json:{targets:storageFixture,activeTargetId:storageFixture[0]?.id}}));
  await page.route('**/api/storage-targets/connect',route=>{
    const body=route.request().postDataJSON();
    assert.equal(body.authType,'password');assert.equal(body.port,22);assert.equal(body.capacityBytes,1e12);
    assert.equal(body.host,'u681095.your-storagebox.de');assert.equal(body.username,'u681095');
    assert.ok(!body.privateKey);
    storageFixture=[{id:'storage-fixture',name:body.name,host:body.host,port:body.port,username:body.username,root:body.root,auth_type:'password',capacity_bytes:body.capacityBytes,hasCredential:true}];
    return route.fulfill({status:201,json:storageFixture[0]});
  });
  await page.getByRole('navigation').getByRole('button',{name:'Storage',exact:true}).click();
  await page.getByRole('button',{name:'Add storage destination'}).click();
  for(const label of ['Destination name','Storage hostname','Storage username'])assert.equal(await page.getByLabel(label,{exact:true}).inputValue(),'','Connection details start blank');
  await page.getByLabel('Destination name',{exact:true}).fill('Hetzner Storage Box');
  await page.getByLabel('Storage hostname',{exact:true}).fill('u681095.your-storagebox.de');
  await page.getByLabel('Storage username',{exact:true}).fill('u681095');
  await page.getByLabel('Authentication method').selectOption('ssh-key');
  await page.getByLabel('Storage SSH private key').waitFor();
  assert.equal(await page.getByLabel('Storage password',{exact:true}).count(),0,'SSH auth does not keep a hidden password field');
  await page.getByLabel('Authentication method').selectOption('password');
  await page.getByLabel('Storage password',{exact:true}).fill('fixture-only-not-a-real-password');
  await page.getByLabel('Verified SSH host fingerprint').fill('ab'.repeat(32));
  await page.getByRole('button',{name:'Test & connect storage'}).click();
  await page.getByRole('heading',{name:'Hetzner Storage Box · Selected for new backups'}).waitFor();
  assert.equal(await page.getByLabel('Storage password',{exact:true}).count(),0,'Successful connection discards the password input');
  await page.route('**/api/storage-targets/storage-fixture/tree',route=>route.fulfill({json:{root:'/home/docknest',limited:false,servers:[{id:'host-one',name:'Production',sites:[{id:'fixture-site',name:'Shop',days:[{date:'2026-10-01',backups:[{id:'fixture-backup',capturedAt:'2026-10-01T20:30:00Z',size:1024*1024,pinned:false,verified:true,relativePath:'production--host-one/shop--fixture-site/2026-10-01/20-30-00Z--fixture-backup/payload.enc'}]}]}]}]}}));
  await page.getByRole('button',{name:'Browse backup folders'}).click();
  await page.getByText('Server: Production',{exact:true}).waitFor();
  await page.getByText('2026-10-01 · 1 backup',{exact:true}).click();
  assert.equal(await page.locator('.backup-tree').getByRole('link',{name:'Download'}).getAttribute('href'),'/api/backups/fixture-backup/download');
  await page.screenshot({path:'data/screenshots/storage-desktop.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'Storage tree fits mobile');
  await page.screenshot({path:'data/screenshots/storage-mobile.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:1440,height:960});
  for (const name of ['Servers', 'Sites & schedules', 'Backups', 'Jobs', 'Maintenance', 'Audit', 'Storage', 'Access']) {
    await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
    await page.locator('#content h1').waitFor();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Dashboard must fit mobile viewport');
  await page.evaluate(async()=>{await Promise.race([Promise.allSettled(document.getAnimations().map(a=>a.finished)),new Promise(resolve=>setTimeout(resolve,500))]);});
  await page.screenshot({ path: 'data/screenshots/dashboard-mobile.png', fullPage: true, animations: 'disabled' });
  assert.deepEqual(problems, [], 'No uncaught browser errors');
  const setupPage=await browser.newPage();
  let setupVerified=false;
  await setupPage.route('**/api/auth/status',route=>route.fulfill({json:{setupRequired:!setupVerified,authenticated:setupVerified,csrfToken:'fixture',user:{name:'QA',role:'admin'},serverTime:Date.now()}}));
  await setupPage.route('**/api/state',route=>route.fulfill({json:{servers:[],sites:[],jobs:[],backups:[],policies:[],audit:[],storage:{}}}));
  await setupPage.route('**/api/auth/setup',route=>{
    const body=route.request().postDataJSON();assert.equal(body.name,'QA');assert.equal(body.email,'qa@example.invalid');assert.equal(body.setupToken,'fixture-only-token');
    return route.fulfill({status:201,json:{enrollmentRequired:true,challenge:'fixture-challenge',qrDataUrl:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E',secret:'fixture-only-secret',recoveryCodes:['fixture-recovery-code']}});
  });
  await setupPage.route('**/api/auth/verify',route=>{assert.equal(route.request().postDataJSON().challenge,'fixture-challenge');setupVerified=true;return route.fulfill({json:{csrfToken:'fixture',user:{name:'QA',role:'admin'}}});});
  await setupPage.goto(baseUrl);
  await setupPage.getByRole('heading',{name:'Sign in',exact:true}).waitFor();
  assert.equal(await setupPage.getByText(/set-admin-password\.ps1/).count(),0,'Login never displays the removed Windows setup instructions');
  assert.equal(await setupPage.getByRole('button',{name:'Sign in',exact:true}).isEnabled(),true,'First-run sign in is clickable');
  await setupPage.getByRole('button',{name:'Sign in',exact:true}).click();
  await setupPage.getByRole('heading',{name:'Set up DockNest',exact:true}).waitFor();
  await setupPage.getByLabel('Administrator name').fill('QA');await setupPage.getByLabel('Administrator email').fill('qa@example.invalid');
  await setupPage.getByLabel('Setup token').fill('fixture-only-token');await setupPage.getByLabel('System password',{exact:true}).fill('fixture-password');await setupPage.getByLabel('Confirm system password').fill('fixture-password');
  await setupPage.getByRole('button',{name:'Continue setup'}).click();
  await setupPage.getByRole('heading',{name:'Connect your authenticator'}).waitFor();
  await setupPage.getByRole('checkbox',{name:'I saved my recovery codes securely.'}).check();
  await setupPage.getByLabel('Authenticator code').fill('123456');await setupPage.getByRole('button',{name:'Confirm administrator'}).click();
  await setupPage.getByRole('heading',{name:'Overview',exact:true}).waitFor();
  assert.ok(setupVerified,'Separate administrator enrollment confirms the factor before opening the dashboard');
  await setupPage.close();
  console.log('Browser smoke passed: setup desktop/mobile, eight dashboard views, responsive layout, no uncaught errors.');
} finally { await browser.close(); }
