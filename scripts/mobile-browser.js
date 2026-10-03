import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';

// Serve only built assets on loopback; every API response is a browser fixture.
const root=path.resolve('dist'),mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.webmanifest':'application/manifest+json'};
const server=createServer(async(req,res)=>{
 const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname+(req.url==='/'?'index.html':''));
 if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 try{res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(await readFile(file));}catch{res.writeHead(404).end();}
});
server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const stamp=new Date().toISOString(),longName='Production website with a long descriptive name for mobile layout checks';
const jobs=Array.from({length:12},(_,i)=>({id:'job-'+i,siteId:'site',type:i%2?'restore':'backup',status:i<5?'running':'completed',stage:i<5?'transferring':'completed',createdAt:stamp}));
const state={servers:[{id:'host',name:'Fixture host',host:'server.example.invalid',username:'fixture',port:22}],sites:[{id:'site',serverId:'host',name:longName,config:{domains:['long-website-name.example.invalid'],healthUrl:'https://long-website-name.example.invalid/health',containers:[]}}],policies:[],backups:[],jobs,restores:[],audit:Array.from({length:12},(_,i)=>({id:'audit-'+i,createdAt:stamp,action:'backup.completed.for.long-website-name.example.invalid',actor:'administrator-with-long-name@example.invalid',details:{message:'Long detail '+('fixture-text-without-spaces'.repeat(12))}})),storage:{used:0,total:1e12},worker:{online:true},maintenance:{title:'Briefly under maintenance',message:'We will be back shortly.',color:'#147d73'}};
const accounts={users:[{id:'admin',name:'Fixture administrator',email:'admin@example.invalid',role:'admin',status:'active',activeSessions:1},{id:'operator',name:'Operator with a long name to exercise wrapping',email:'operator-with-long-name@example.invalid',role:'operator',status:'active',activeSessions:2},{id:'pending',name:'Pending operator',role:'operator',status:'pending',invitationExpiresAt:stamp}],security:{idleMinutes:30,absoluteHours:8,invitationMinutes:15}};
let browser;
try{
 browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/**',route=>{
  const endpoint=new URL(route.request().url()).pathname;
  const auth={authenticated:true,setupRequired:false,csrfToken:'fixture',user:{id:'admin',name:'Fixture administrator',role:'admin'},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000};
  return route.fulfill({json:endpoint==='/api/auth/status'?auth:endpoint==='/api/state'?state:endpoint==='/api/access'?accounts:endpoint==='/api/auth/activity'?auth:{}});
 });
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.locator('.dash-metrics').waitFor();
 await mkdir('test-results/mobile',{recursive:true});
 async function navigate(name){
  if(page.viewportSize().width<900)await page.getByRole('button',{name:'Open navigation',exact:true}).click();
  await page.getByRole('navigation').getByRole('button',{name,exact:true}).click();
  await page.evaluate(()=>scrollTo(0,0));
 }
 async function fits(label){
  const problems=await page.evaluate(()=>{
   const failures=[];
   if(document.documentElement.scrollWidth>innerWidth+1)failures.push('page horizontal overflow');
   for(const wrap of document.querySelectorAll('.table-wrap')){
    if(wrap.scrollWidth>wrap.clientWidth+1)failures.push('table horizontal overflow');
    const bounds=wrap.getBoundingClientRect();
    for(const cell of wrap.querySelectorAll('tbody td')){
     const box=cell.getBoundingClientRect();
     if(box.left<bounds.left-1||box.right>bounds.right+1||cell.scrollWidth>cell.clientWidth+1)failures.push('cropped cell '+cell.dataset.label);
     if(!cell.dataset.label)failures.push('missing mobile label');
    }
   }
   return failures;
  });
  assert.deepEqual(problems,[],label);
 }
 for(const width of [320,390,680]){
  await page.setViewportSize({width,height:844});
  await page.evaluate(()=>scrollTo(0,0));
  await page.getByRole('button',{name:'Active job notifications',exact:true}).click();
  const box=await page.locator('.berry-popover').boundingBox();
  assert.ok(box.x>=12&&box.x+box.width<=width-11,'Notifications fit '+width+'px viewport');
  assert.equal(await page.locator('.berry-popover').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await page.screenshot({path:'test-results/mobile/notifications-'+width+'.png',animations:'disabled'});
  await page.keyboard.press('Escape');assert.equal(await page.locator('.berry-popover').count(),0);
  await navigate('Overview');await page.getByText('View chart data',{exact:true}).click();await fits('Chart data at '+width);
  for(const name of ['Jobs','Audit','Access','Maintenance']){
   await navigate(name);await page.locator('.mobile-table').waitFor();await fits(name+' at '+width);
   assert.equal(await page.locator('.mobile-table tbody tr').first().evaluate(el=>getComputedStyle(el).display),'grid');
   if(name==='Audit'){await page.getByText('View details',{exact:true}).first().click();await fits('Expanded audit details at '+width);}
   if(name==='Jobs'){
    await page.getByRole('button',{name:'View job',exact:true}).first().click();await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByRole('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);await page.getByRole('button',{name:'Close dialog',exact:true}).click();
    const pager=page.getByRole('group',{name:'Jobs pagination',exact:true});await pager.getByRole('button',{name:'Jobs next page',exact:true}).click();await fits('Jobs last page at '+width);
    assert.equal(await page.locator('.mobile-table tbody tr').count(),2);await pager.getByRole('button',{name:'Jobs previous page',exact:true}).click();
   }
   if(width===390){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'test-results/mobile/'+name.toLowerCase()+'-390.png',animations:'disabled'});}
  }
 }
 await page.setViewportSize({width:1440,height:1000});await navigate('Jobs');
 assert.equal(await page.locator('.mobile-table').evaluate(el=>getComputedStyle(el).display),'table','Desktop retains the table layout');
 assert.equal(await page.locator('.mobile-table tbody tr').first().locator('td').count(),5);
 await page.screenshot({path:'test-results/mobile/jobs-desktop.png',animations:'disabled'});
 assert.deepEqual(errors,[]);
 console.log('Mobile browser checks passed: notifications, chart data, Jobs, Audit, Access, maintenance, expanded details and pagination at 320/390/680px; desktop tables preserved. Synthetic fixtures only.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
