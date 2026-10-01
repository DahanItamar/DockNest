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
  for (const name of ['Servers', 'Sites & schedules', 'Backups', 'Jobs', 'Maintenance', 'Audit', 'Access']) {
    await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
    await page.locator('#content h1').waitFor();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Dashboard must fit mobile viewport');
  await page.evaluate(async()=>{await Promise.race([Promise.allSettled(document.getAnimations().map(a=>a.finished)),new Promise(resolve=>setTimeout(resolve,500))]);});
  await page.screenshot({ path: 'data/screenshots/dashboard-mobile.png', fullPage: true, animations: 'disabled' });
  assert.deepEqual(problems, [], 'No uncaught browser errors');
  console.log('Browser smoke passed: setup desktop/mobile, eight dashboard views, responsive layout, no uncaught errors.');
} finally { await browser.close(); }
