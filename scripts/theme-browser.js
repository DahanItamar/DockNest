import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:'dark'}),page=await context.newPage(),errors=[],writes=[];
 page.on('pageerror',e=>errors.push(e.message));
 const now=Date.now(),state={servers:[],sites:[],jobs:[],backups:[],policies:[],audit:[],worker:{running:true,online:true},storage:{used:10e9,total:100e9}};
 await context.route('**/api/**',r=>{if(r.request().method()!=='GET'&&!r.request().url().endsWith('/auth/activity'))writes.push(r.request().url());return r.fulfill({json:r.request().url().includes('/auth/status')?{authenticated:true,csrfToken:'fixture',user:{id:'admin',name:'Administrator',role:'admin'},serverTime:now,idleExpiresAt:now+1800000,absoluteExpiresAt:now+28800000}:state})});
 const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5176';await page.goto(base);await page.locator('.dash-metrics').waitFor();
 assert.equal(await page.locator('html').getAttribute('data-theme'),'light','Light remains the default even on a dark OS');
 async function contrast(){
  const failures=await page.evaluate(()=>{
   const s=getComputedStyle(document.documentElement),l=t=>{const hex=s.getPropertyValue('--'+t).trim().slice(1),c=[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722};
   return [['text-primary','surface',4.5],['text-secondary','background',4.5],['text-muted','surface',4.5],['text-muted','surface-muted',4.5],['primary-foreground','button-primary',4.5],['primary-foreground','button-primary-hover',4.5],['link','surface',4.5],['accent','accent-soft',4.5],['success','success-surface',4.5],['warning','warning-surface',4.5],['error','error-surface',4.5],['info','info-surface',4.5],['border-control','surface',3],['border-control','surface-muted',3],['focus-ring','background',3],['focus-ring','surface',3]].flatMap(([a,b,min])=>{const n=[l(a),l(b)].sort((x,y)=>y-x),r=(n[0]+.05)/(n[1]+.05);return r>=min?[]:[a+'/'+b+': '+r.toFixed(2)]});
  });assert.deepEqual(failures,[]);
 }
 await contrast();const toggle=page.getByRole('button',{name:'Switch to dark theme'});await toggle.hover();await page.waitForTimeout(280);assert.notEqual(await toggle.locator('.sun-rays').evaluate(el=>getComputedStyle(el).transform),'none');
 await toggle.click();await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');await contrast();
 assert.match(await page.locator('.brand-image').getAttribute('src'),/logo-blue/);await page.waitForFunction(()=>document.querySelector('.brand-image').complete&&document.querySelector('.brand-image').naturalWidth>0);
 await page.getByRole('button',{name:'Switch to light theme'}).hover();await page.waitForTimeout(280);assert.notEqual(await page.locator('.theme-symbol .moon-star').first().evaluate(el=>getComputedStyle(el).transform),'none');
 // Hold the React bundle to verify the saved dark preference is applied before it runs.
 let release;const gate=new Promise(r=>release=r);await page.route('**/assets/index-*.js',async r=>{await gate;await r.continue()});
 await page.reload({waitUntil:'commit'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).backgroundColor),'rgb(24, 33, 49)');release();await page.locator('.dash-metrics').waitFor();await page.unroute('**/assets/index-*.js');
 const other=await context.newPage();await other.goto(base);await other.locator('.dash-metrics').waitFor();await other.getByRole('button',{name:'Switch to light theme'}).click();await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');await other.close();
 await page.getByRole('button',{name:'Switch to dark theme'}).focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 await page.emulateMedia({reducedMotion:'reduce'});await page.getByRole('button',{name:'Switch to light theme'}).hover();assert.equal(await page.locator('.moon-star').first().evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
 await mkdir('data/theme-verification',{recursive:true});await page.screenshot({path:'data/theme-verification/dashboard-dark.png',animations:'disabled'});
 for(const width of [1440,1024,768,390,320]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);const box=await page.locator('.theme-toggle').boundingBox();assert.ok(box.width>=34&&box.height>=34);assert.equal(box.width,box.height,'Theme control stays square at every viewport')}
 assert.deepEqual(writes,[],'Appearance changes do not write to operational APIs');assert.deepEqual(errors,[]);
 const locked=await browser.newContext();await locked.addInitScript(()=>{Storage.prototype.getItem=()=>{throw Error('Storage blocked')};Storage.prototype.setItem=()=>{throw Error('Storage blocked')}});const auth=await locked.newPage();await auth.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:false}}));await auth.goto(base);await auth.getByRole('heading',{name:'Sign in',exact:true}).waitFor();await auth.getByRole('button',{name:'Switch to dark theme'}).click();await auth.waitForFunction(()=>document.documentElement.dataset.theme==='dark');await locked.close();
 console.log('Themes passed: light/dark contrast, custom hover icons, keyboard, persistence before React, tab sync, blocked storage, mobile fit, reduced motion and no operational writes.');
}finally{await browser.close();}
