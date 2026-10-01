import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { prepareServerKey, serverReportCommand } from '../src/server-onboarding.js';
const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const problems = [];
page.on('pageerror', error => problems.push(error.message));
await mkdir('data/screenshots', { recursive: true });
try {
  await page.goto('http://127.0.0.1:3000');
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  await page.getByLabel('Password', { exact: true }).waitFor();
  await page.getByLabel('2FA code').waitFor();
  assert.equal(await page.locator('input').count(), 2, 'Login has only password and code inputs');
  await page.screenshot({ path: 'data/screenshots/setup-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Setup must fit mobile viewport');
  await page.screenshot({ path: 'data/screenshots/setup-mobile.png', fullPage: true });
  // Isolated browser-only empty fixtures exercise UI navigation without creating an administrator.
  await page.route('**/api/auth/status', route => route.fulfill({ json: { authenticated: true, setupRequired: false, csrfToken: 'fixture', user: { name: 'Administrator', role: 'admin', email: 'ui-test@example.org' }, serverTime: Date.now(), idleExpiresAt: Date.now()+1800000, absoluteExpiresAt: Date.now()+28800000 } }));
  await page.route('**/api/access', route => route.fulfill({ json: { users: [], security: { idleMinutes: 30, absoluteHours: 8, invitationMinutes: 15 } } }));
  await page.route('**/api/auth/activity', route => route.fulfill({ json: { serverTime: Date.now(), idleExpiresAt: Date.now()+1800000, absoluteExpiresAt: Date.now()+28800000 } }));
  await page.route('**/api/state', route => route.fulfill({ json: { servers: [], sites: [], policies: [], backups: [], jobs: [], restores: [], audit: [], storage: { used: 0, total: 1000000 }, maintenance: { title: 'Briefly under maintenance', message: 'We will be back shortly.', color: '#147d73' } } }));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.reload();
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  await page.screenshot({ path: 'data/screenshots/dashboard-desktop.png', fullPage: true });
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
    return route.fulfill({status:201,json:{id:'fixture-server',status:'connected'}});
  });
  for(const mode of ['existing','new']){
    await page.getByRole('button',{name:'Add server',exact:true}).click();
    const dialog=page.getByRole('dialog');
    await dialog.getByLabel('Server name',{exact:true}).fill('Fixture Ubuntu');
    await dialog.getByLabel('IP address or hostname',{exact:true}).fill('server.example.org');
    await dialog.getByRole('button',{name:'Continue',exact:true}).click();
    if(mode==='existing')await dialog.getByLabel('Select SSH private key file').setInputFiles({name:'fixture_key',mimeType:'text/plain',buffer:Buffer.from(prepared.privateKey)});
    else{
      await dialog.getByLabel('SSH key option').selectOption('new');
      await dialog.getByRole('button',{name:'Create dedicated key',exact:true}).click();
      await dialog.getByRole('button',{name:'Dedicated key ready',exact:true}).waitFor();
    }
    await dialog.getByRole('button',{name:'Continue',exact:true}).click();
    await dialog.getByLabel('Paste the JSON result from your server').fill(JSON.stringify({version:1,hostname:'fixture',username:'root',uid:0,dockerInstalled:true,hostKeys:[{algorithm:'ssh-ed25519',fingerprint:'ab'.repeat(32)}]}));
    await dialog.getByRole('button',{name:'Read server result'}).click();
    if(mode==='new'){
      await page.screenshot({path:'data/screenshots/server-wizard-desktop.png',fullPage:true});
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'Wizard fits mobile');
      await page.screenshot({path:'data/screenshots/server-wizard-mobile.png',fullPage:true});
      await page.setViewportSize({width:1440,height:960});
    }
    await dialog.getByRole('button',{name:'Test connection & save'}).click();
    await dialog.waitFor({state:'hidden'});
  }
  assert.equal(saved,2,'Existing and dedicated key paths both submit verified connection details');
  for (const name of ['Servers', 'Sites & schedules', 'Backups', 'Jobs', 'Maintenance', 'Audit', 'Access']) {
    await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
    await page.locator('#content h1').waitFor();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Dashboard must fit mobile viewport');
  await page.screenshot({ path: 'data/screenshots/dashboard-mobile.png', fullPage: true });
  assert.deepEqual(problems, [], 'No uncaught browser errors');
  console.log('Browser smoke passed: setup desktop/mobile, eight dashboard views, responsive layout, no uncaught errors.');
} finally { await browser.close(); }
