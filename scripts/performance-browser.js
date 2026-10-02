import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5174';
const browser=await chromium.launch({channel:'chrome',headless:true});
const records=[];
try{
 for(const authenticated of [false,true]){
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
   window.__perf={longTasks:[],lcp:0};
   new PerformanceObserver(list=>window.__perf.longTasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:true});
   new PerformanceObserver(list=>{window.__perf.lcp=list.getEntries().at(-1)?.startTime||0;}).observe({type:'largest-contentful-paint',buffered:true});
  });
  await page.route('**/api/auth/status',route=>route.fulfill({json:{authenticated,csrfToken:'fixture',user:{id:'admin',name:'Administrator',role:'admin'}}}));
  await page.route('**/api/state',route=>route.fulfill({json:{servers:[],sites:[],backups:[],jobs:[],policies:[],audit:[],storage:{}}}));
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
  await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:80,downloadThroughput:1.5*1024*1024/8,uploadThroughput:750*1024/8});
  await page.goto(base);await page.locator(authenticated?'.dash-growth':'.auth-card').waitFor();
  await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(1000);
  const record=await page.evaluate(authenticated=>({scenario:authenticated?'dashboard':'sign-in',...window.__perf,resources:performance.getEntriesByType('resource').filter(e=>!e.name.includes('/api/')).map(e=>({name:e.name.split('/').at(-1),transfer:e.transferSize,duration:Math.round(e.duration)}))}),authenticated);
  records.push(record);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).scrollbarWidth),'none');
  if(authenticated){
   await page.keyboard.press('End');await page.waitForFunction(()=>scrollY>0);
   await page.keyboard.press('Home');await page.waitForFunction(()=>scrollY===0);
   await page.mouse.wheel(0,400);await page.waitForFunction(()=>scrollY>0);
   await page.reload();await page.locator('.dash-growth').waitFor();
   assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).scrollbarWidth),'none');
  }
  assert.deepEqual(errors,[]);await page.close();
 }
 // Simulate a reload while all JS and CSS are still in flight: the critical
 // document scrollbar rule must already apply from the HTML alone.
 const page=await browser.newPage();
 await page.route('**/assets/**',route=>route.abort());await page.goto(base);
 assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).scrollbarWidth),'none');
 await page.close();
 await mkdir('data/performance',{recursive:true});
 await writeFile('data/performance/after.json',JSON.stringify(records,null,2)+'\n');
 console.log(JSON.stringify(records.map(({scenario,lcp,longTasks,resources})=>({scenario,lcp,longTasks,jsBytes:resources.filter(x=>x.name.endsWith('.js')).reduce((sum,x)=>sum+x.transfer,0)})),null,2));
 console.log('Scrollbar remains hidden before assets load and after reload; wheel and keyboard scrolling remain available.');
}finally{await browser.close();}
