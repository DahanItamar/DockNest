import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
const directory='docs/design/servers-implemented';
await mkdir(directory,{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 let role='admin',failState=false;
 const state={servers:[
  {id:'production',name:'Production EU',note:'Main storefront host',username:'root',host:'198.51.100.20',port:22,hostKey:'ab'.repeat(32)},
  {id:'commerce',name:'Commerce host',note:'Customer stores',username:'deploy',host:'198.51.100.21',port:22,hostKey:'cd'.repeat(32)},
  {id:'staging',name:'Staging',note:'',username:'deploy',host:'198.51.100.22',port:22,hostKey:'ef'.repeat(32)},
  {id:'docs',name:'Documentation host',note:'Documentation and help center. Changes are reviewed in staging before release.',username:'root',host:'192.0.2.23',port:22,hostKey:'01'.repeat(32)}
 ],sites:[{id:'store',name:'Storefront',serverId:'production'}],policies:[],jobs:[],backups:[],audit:[],storage:{used:0,total:1000}};
 await page.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:true,csrfToken:'fixture',user:{name:'UI Reviewer',role},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000}}));
 await page.route('**/api/state',r=>failState?r.fulfill({status:503,json:{error:'Fixture refresh unavailable.'}}):r.fulfill({json:state}));
 await page.route('**/api/auth/activity',r=>r.fulfill({json:{}}));
 await page.addInitScript(()=>localStorage.setItem('docknest-theme','light'));
 await page.goto(process.env.TEST_BASE_URL||'http://127.0.0.1:5173');
 await page.getByRole('navigation').getByRole('button',{name:'Servers',exact:true}).click();
 await page.getByRole('article',{name:'Production EU',exact:true}).waitFor();
 await page.evaluate(()=>document.fonts.ready);
 const card=name=>page.getByRole('article',{name,exact:true});
 assert.equal(await page.locator('.server-card').count(),4);
 assert.equal(await card('Production EU').getByLabel('1 configured site').count(),1);
 assert.equal(await card('Production EU').locator('code').filter({hasText:'ab'.repeat(32)}).textContent(),'ab'.repeat(32),'Complete SSH fingerprint remains visible');
 async function measure(){
  const boxes=await page.locator('.server-card').evaluateAll(cards=>cards.map(card=>{const r=card.getBoundingClientRect(),f=card.querySelector('footer').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,actions:f.y,actionWidth:f.width}}));
  const width=page.viewportSize().width;
  for(const box of boxes)assert.ok(Math.abs(box.actionWidth-box.width+2)<1,'Action bar fills the card');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No overflow at '+width);
  for(const box of boxes){assert.ok(Math.abs(box.width-boxes[0].width)<1,'Equal widths at '+width);assert.ok(Math.abs(box.height-boxes[0].height)<1,'Equal card heights at '+width);}
  if(width>1100){for(const [a,b] of [[0,1],[2,3]]){assert.ok(Math.abs(boxes[a].y-boxes[b].y)<1,'Aligned rows');assert.ok(Math.abs(boxes[a].actions-boxes[b].actions)<1,'Aligned action bars');}assert.ok(Math.abs(boxes[0].x-40)<1,'Available-width grid');}
 }
 await measure();
 await page.screenshot({path:directory+'/servers-light.png',fullPage:true});
 let tested=0;
 await page.route('**/api/servers/production/test',r=>{tested++;assert.equal(r.request().method(),'POST');assert.deepEqual(r.request().postDataJSON(),{});return r.fulfill({json:{fixture:true,connection:'ok'}});});
 await card('Production EU').getByRole('button',{name:'Test connection',exact:true}).click();
 await page.getByRole('dialog',{name:'Connection diagnostics'}).waitFor();assert.equal(tested,1);
 await page.getByRole('button',{name:'Close dialog'}).click();
 await page.route('**/api/servers/production/discover',r=>r.fulfill({json:{containers:[{name:'shop',image:'shop:latest',state:'running'}]}}));
 await card('Production EU').getByRole('button',{name:'Discover sites',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Select site shop',exact:true}).waitFor();
 assert.equal(await page.getByRole('dialog').getByLabel('Source server').inputValue(),'production','Discovery retains selected server');
 await page.getByRole('button',{name:'Close dialog'}).click();
 let edited=0;
 await page.route('**/api/servers/production/details',r=>{edited++;assert.equal(r.request().method(),'PATCH');assert.deepEqual(r.request().postDataJSON(),{name:'Production EU',note:'Main storefront host - reviewed'});state.servers[0].note='Main storefront host - reviewed';return r.fulfill({json:state.servers[0]});});
 await card('Production EU').getByRole('button',{name:'Edit details',exact:true}).click();
 await page.getByRole('dialog').getByLabel('Server note (optional)').fill('Main storefront host - reviewed');
 await page.getByRole('dialog').getByRole('button',{name:'Save details',exact:true}).click();
 await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(edited,1);
 await card('Production EU').getByText('Main storefront host - reviewed',{exact:true}).waitFor();
 await page.getByLabel('Filter Servers').fill('nothing-matches');
 await page.getByRole('heading',{name:'No matching servers'}).waitFor();
 await page.getByRole('button',{name:'Clear filter',exact:true}).click();assert.equal(await page.locator('.server-card').count(),4);
 await page.getByLabel('Filter Servers').fill('Commerce host');
 assert.equal(await page.locator('.server-card').count(),1);
 assert.ok(await page.locator('.server-card').evaluate(el=>Math.abs(el.getBoundingClientRect().width-document.querySelector('.server-grid').getBoundingClientRect().width)<1),'Single result fills the row');
 await page.getByLabel('Filter Servers').fill('');
 await page.getByRole('button',{name:'Dismiss message'}).click();
 await page.getByRole('button',{name:'Switch to dark theme'}).click();
 await page.screenshot({path:directory+'/servers-dark.png',fullPage:true});
 for(const width of [1920,1440,1280,1024,768,390,320]){await page.setViewportSize({width,height:900});await measure();}
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:directory+'/servers-mobile-dark.png',fullPage:true});
 await page.getByRole('button',{name:'Switch to light theme'}).click();
 await page.screenshot({path:directory+'/servers-mobile.png',fullPage:true});
 await page.setViewportSize({width:1440,height:1000});
 failState=true;
 await page.getByRole('button',{name:'Refresh dashboard'}).click();
 await page.getByRole('alert').filter({hasText:'Fixture refresh unavailable.'}).waitFor();assert.equal(await page.locator('.server-card').count(),4);
 failState=false;
 role='operator';await page.reload();
 await page.getByRole('navigation').getByRole('button',{name:'Servers',exact:true}).click();
 await card('Production EU').waitFor();
 assert.equal(await page.getByRole('button',{name:'Edit details',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'Add server',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'Test connection',exact:true}).count(),4);
 state.servers=[];state.sites=[];
 await page.getByRole('button',{name:'Refresh dashboard'}).click();
 await page.getByRole('heading',{name:'Connect your first Docker host'}).waitFor();assert.equal(await page.getByRole('button',{name:'Add server',exact:true}).count(),0);
 role='admin';await page.reload();
 await page.getByRole('navigation').getByRole('button',{name:'Servers',exact:true}).click();
 await page.getByRole('heading',{name:'Connect your first Docker host'}).waitFor();
 await page.screenshot({path:directory+'/servers-empty.png',fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('Servers browser checks passed: existing test/discovery/edit requests, complete fingerprints, filtering, retained state on refresh errors, role restrictions, both themes and seven responsive widths with equal card heights and action bars.');
}finally{await browser.close();}
