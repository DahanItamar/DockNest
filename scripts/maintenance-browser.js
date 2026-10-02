import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {maintenanceDefaults,renderMaintenancePage} from '../shared/maintenance-design.js';
const browser=await chromium.launch({channel:'chrome',headless:true});
await mkdir('docs/design/maintenance-system',{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 let design={...maintenanceDefaults};
 const state={servers:[{id:'host',name:'Production'}],sites:[{id:'site',name:'Storefront',serverId:'host',config:{domains:['store.example.invalid'],healthUrl:'https://store.example.invalid/health'}}],backups:[],jobs:[],audit:[],policies:[],storage:{used:0,total:1e12}};
 await page.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:true,csrfToken:'fixture',user:{id:'admin',name:'Administrator',role:'admin'}}}));
 await page.route('**/api/state',r=>r.fulfill({json:{...state,maintenance:design}}));
 let saved;await page.route('**/api/maintenance',r=>{saved=r.request().postDataJSON();design={...saved};return r.fulfill({json:saved})});
 await page.addInitScript(()=>localStorage.setItem('docknest-theme','light'));
 await page.goto(process.env.TEST_BASE_URL||'http://127.0.0.1:5173');
 await page.getByRole('navigation').getByRole('button',{name:'Maintenance',exact:true}).click();
 const frame=page.frameLocator('iframe[title="Maintenance visitor preview"]');
 await frame.getByRole('heading',{name:maintenanceDefaults.title}).waitFor();
 assert.equal(await frame.locator('.maintenance-animation').count(),1);
 assert.equal(await frame.locator('html').evaluate(()=>innerWidth),1100,'Desktop canvas has a real desktop viewport');
 await page.getByLabel('Page title',{exact:true}).fill('Prepared with care');
 await frame.getByRole('heading',{name:'Prepared with care'}).waitFor();
 await page.getByRole('button',{name:'Refresh dashboard'}).click();
 assert.equal(await page.getByLabel('Page title',{exact:true}).inputValue(),'Prepared with care','Refresh preserves unsaved edits');
 await page.getByRole('button',{name:'Reset changes',exact:true}).click();
 assert.equal(await page.getByLabel('Page title',{exact:true}).inputValue(),maintenanceDefaults.title);
 await page.getByRole('tab',{name:'Appearance'}).click();
 await page.getByRole('radio',{name:'Editorial',exact:true}).check();
 await page.getByLabel('Heading style').selectOption('bold');
 await page.getByRole('button',{name:'Save design',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Maintenance design saved.'}).waitFor();
 assert.equal(saved.layout,'editorial');assert.equal(saved.theme,'light');assert.equal(saved.typeScale,'bold');
 await page.getByRole('button',{name:'Phone preview',exact:true}).click();
 assert.equal(await frame.locator('html').evaluate(()=>innerWidth),390,'Phone canvas uses 390px');
 assert.equal(await frame.locator('html').evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.getByRole('button',{name:'Desktop preview',exact:true}).click();
 await page.getByRole('tab',{name:'Content'}).click();await page.getByRole('button',{name:'Studio pause',exact:false}).click();
 await page.getByRole('button',{name:'Save design',exact:true}).click();
 let deploy=0;await page.route('**/api/sites/site/maintenance/deploy',r=>{deploy++;assert.deepEqual(r.request().postDataJSON(),{});return r.fulfill({json:{ok:true}})});
 await page.getByRole('button',{name:'Deploy page',exact:true}).click();await page.getByRole('status').filter({hasText:'Maintenance deployment requested.'}).waitFor();assert.equal(deploy,1);
 let enabled;await page.route('**/api/sites/site/maintenance',r=>{enabled=r.request().postDataJSON();return r.fulfill({json:{ok:true}})});
 await page.getByRole('button',{name:'Enable',exact:true}).click();assert.equal(enabled,undefined,'Enable still needs confirmation');
 await page.getByRole('button',{name:'Confirm change',exact:true}).click();await page.getByRole('status').filter({hasText:'Maintenance change requested.'}).waitFor();assert.deepEqual(enabled,{enabled:true});
 await page.getByRole('button',{name:'Dismiss message',exact:true}).click();
 for(const theme of ['light']){if(theme==='dark')await page.getByRole('button',{name:'Switch to dark theme',exact:true}).click();
  for(const [width,height,suffix]of [[1440,1000,''],[390,844,'-mobile']]){await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'docs/design/full-site-implemented/maintenance-'+theme+suffix+'.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)}
 }
 const font=await readFile('public/fonts/Roboto-Latin.woff2');
 const visitor=await browser.newPage({reducedMotion:'reduce'});visitor.on('pageerror',e=>errors.push(e.message));
 for(const layout of ['studio','editorial','compact'])for(const theme of ['light']){
  const html=renderMaintenancePage({...maintenanceDefaults,layout,theme},{interactive:false,font:'data:font/woff2;base64,'+font.toString('base64')});
  await visitor.setContent(html);await visitor.evaluate(()=>document.fonts.ready);
  for(const [width,height,suffix]of [[1440,1000,''],[390,844,'-mobile']]){await visitor.setViewportSize({width,height});assert.equal(await visitor.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Visitor '+layout+' '+theme+' fits '+width);await visitor.screenshot({path:'docs/design/maintenance-system/visitor-'+layout+'-'+theme+suffix+'.png',fullPage:true})}
 }
 await visitor.emulateMedia({reducedMotion:'no-preference'});await visitor.setContent(renderMaintenancePage(maintenanceDefaults,{interactive:false}));
 const motion=await visitor.locator('.site-window').evaluate(el=>getComputedStyle(el).animationName);assert.equal(motion,'site-float');
 const before=await visitor.locator('.site-window').evaluate(el=>getComputedStyle(el).transform);await visitor.waitForTimeout(500);assert.notEqual(await visitor.locator('.site-window').evaluate(el=>getComputedStyle(el).transform),before);
 await visitor.emulateMedia({reducedMotion:'reduce'});assert.equal(await visitor.locator('.site-window').evaluate(el=>getComputedStyle(el).animationName),'none');
 assert.equal(await visitor.locator('.scene').evaluate(el=>getComputedStyle(el).borderWidth),'0px');
 assert.deepEqual(errors,[]);
 console.log('Maintenance studio passed: real desktop/phone canvas, live copy, draft preservation, reset, persisted layout/theme/type, offline visitor assets, all visitor compositions, existing deployment and confirmation requests.');
}finally{await browser.close()}
