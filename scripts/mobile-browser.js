import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';

// Serve only built assets (or set TEST_BASE_URL, e.g. a Vite dev server) on loopback; every API response is a browser fixture.
const root=path.resolve('dist'),mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.webmanifest':'application/manifest+json'};
const server=createServer(async(req,res)=>{
 const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname+(req.url==='/'?'index.html':''));
 if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 try{res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(await readFile(file));}catch{res.writeHead(404).end();}
});
server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const stamp=new Date().toISOString(),longName='Production website with a long descriptive name for mobile layout checks';
const jobs=Array.from({length:12},(_,i)=>({id:'job-'+i,siteId:'site',type:i%2?'restore':'backup',status:i<5?'running':'completed',stage:i<5?'transferring':'completed',createdAt:stamp}));
const state={servers:[{id:'host',name:'Fixture host',host:'server.example.invalid',username:'fixture',port:22}],sites:[{id:'site',serverId:'host',name:longName,config:{domains:['long-website-name.example.invalid'],healthUrl:'https://long-website-name.example.invalid/health',containers:[]}}],policies:[],backups:Array.from({length:14},(_,i)=>({id:'backup-'+i,siteId:'site-'+i,status:'completed',createdAt:stamp,capturedAt:stamp,size:1e8,kind:'full'})),jobs,restores:[],audit:Array.from({length:12},(_,i)=>({id:'audit-'+i,createdAt:stamp,action:'backup.completed.for.long-website-name.example.invalid',actor:'administrator-with-long-name@example.invalid',details:{message:'Long detail '+('fixture-text-without-spaces'.repeat(12))}})),storage:{used:0,total:1e12},worker:{online:true},maintenance:{title:'Briefly under maintenance',message:'We will be back shortly.',color:'#147d73'}};
const accounts={users:[{id:'admin',name:'Fixture administrator',email:'admin@example.invalid',role:'admin',status:'active',activeSessions:1},{id:'operator',name:'Operator with a long name to exercise wrapping',email:'operator-with-long-name@example.invalid',role:'operator',status:'active',activeSessions:2},{id:'pending',name:'Pending operator',role:'operator',status:'pending',invitationExpiresAt:stamp}],security:{idleMinutes:30,absoluteHours:8,invitationMinutes:15}};
const selfBackup={latest:{finishedAt:stamp,size:592000,release:'0.1.0',checksum:'a'.repeat(64),storage:{mode:'remote',name:'Fixture SFTP storage'}},settings:{enabled:true,hasPassphrase:true,schedule:'0 3 * * *',timezone:'UTC',nextRun:stamp},destination:{name:'Fixture SFTP storage',available:true}};
let browser;
try{
 browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/**',route=>{
  const endpoint=new URL(route.request().url()).pathname;
  const auth={authenticated:true,setupRequired:false,csrfToken:'fixture',user:{id:'admin',name:'Fixture administrator',role:'admin'},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000};
  return route.fulfill({json:endpoint==='/api/auth/status'?auth:endpoint==='/api/state'?state:endpoint==='/api/access'?accounts:endpoint==='/api/self-backup'?selfBackup:endpoint==='/api/storage-targets'?{targets:[{id:'t1',name:'Fixture SFTP storage',kind:'sftp',host:'storage.example.invalid',port:22,username:'fixture',root:'/backups',status:'connected'}],activeTargetId:'t1'}:endpoint==='/api/auth/activity'?auth:{}});
 });
 await page.goto(process.env.TEST_BASE_URL||'http://127.0.0.1:'+server.address().port);
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
 // 2.3.1: header lockup, controls and drawer at iPhone widths (402x874 is the iPhone 17 Pro).
 const rects=sel=>page.evaluate(selector=>[...document.querySelectorAll(selector)].filter(el=>el.getClientRects().length).map(el=>{const b=el.getBoundingClientRect();return{left:b.left,right:b.right,top:b.top,bottom:b.bottom,w:b.width,h:b.height,label:el.getAttribute('aria-label')||el.className}}),sel);
 const hit=(a,b)=>a.left<b.right-.5&&a.right>b.left+.5&&a.top<b.bottom-.5&&a.bottom>b.top+.5;
 for(const width of [320,360,390,402,430,480]){
  await page.setViewportSize({width,height:874});await page.evaluate(()=>scrollTo(0,0));
  const logo=(await rects('.berry-header .brand-lockup'))[0],controls=await rects('.berry-header-tools button,.berry-header .berry-menu');
  assert.ok(logo&&logo.w>0,'logo visible at '+width);
  for(const control of controls){assert.ok(!hit(logo,control),'header control '+control.label+' overlaps the logo at '+width);assert.ok(control.w>=44&&control.h>=44,'header control '+control.label+' is 44px at '+width);assert.ok(control.right<=width+.5&&control.left>=-.5,'header control '+control.label+' inside viewport at '+width);}
  for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++)assert.ok(!hit(controls[i],controls[j]),'header controls overlap at '+width);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no horizontal scroll at '+width);
  await page.getByRole('button',{name:'Open navigation',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Open navigation',exact:true}).getAttribute('aria-expanded'),'true');
  assert.equal(await page.getByText('Collapse menu',{exact:true}).isVisible(),false,'drawer has no Collapse menu item at '+width);
  const closers=await page.locator('.berry-shell button:visible').evaluateAll(list=>list.filter(el=>!el.closest('dialog')&&el.getAttribute('aria-hidden')!=='true'&&/close|collapse|toggle navigation|open navigation/i.test((el.getAttribute('aria-label')||'')+' '+el.textContent)&&!/notification/i.test(el.getAttribute('aria-label')||'')).map(el=>el.getAttribute('aria-label')||el.textContent));
  assert.deepEqual(closers,['Open navigation'],'exactly one close control in the open drawer at '+width);
  if(width===402){await page.screenshot({path:'test-results/mobile/drawer-402.png',animations:'disabled'});}
  await page.getByRole('button',{name:'Open navigation',exact:true}).click();
  await page.locator('.berry-shell.mobile-open').waitFor({state:'detached'});
 }
 // Card footers on phones: buttons never overlap the content above them.
 for(const width of [320,402,480]){
  await page.setViewportSize({width,height:874});
  for(const name of ['Servers','Sites & schedules','Storage','DockNest backup','Update Center']){
   try{await navigate(name)}catch(e){await page.screenshot({path:'test-results/mobile/fail.png'});throw new Error('navigate '+name+' '+width+': '+e.message.slice(0,80))}await page.waitForTimeout(150);
   const bad=await page.evaluate(()=>{const out=[],hitTest=(a,b)=>a.left<b.right-.5&&a.right>b.left+.5&&a.top<b.bottom-.5&&a.bottom>b.top+.5;for(const footer of document.querySelectorAll('.card-footer')){const f=footer.getBoundingClientRect(),card=footer.closest('.card');if(!f.height)continue;
    if(card)for(const sibling of [...card.children].filter(c=>c!==footer&&(c.compareDocumentPosition(footer)&Node.DOCUMENT_POSITION_FOLLOWING))){const b=sibling.getBoundingClientRect();if(b.height&&b.bottom>f.top+.5)out.push('footer overlaps preceding content');}
    const kids=[...footer.children].map(c=>c.getBoundingClientRect());for(let i=0;i<kids.length;i++){if(kids[i].top<f.top-.5||kids[i].bottom>f.bottom+.5)out.push('footer child outside footer');for(let j=i+1;j<kids.length;j++)if(hitTest(kids[i],kids[j]))out.push('footer children overlap');}}
    return out;});
   assert.deepEqual(bad,[],name+' card footers at '+width);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,name+' no horizontal scroll at '+width);
  }
 }
 // 2.3.1 Backups on phones: 6 groups per page, no reserved empty height, one compact 44px pager row.
 for(const width of [320,402]){
  await page.setViewportSize({width,height:874});await navigate('Backups');
  const pager=page.getByRole('group',{name:'Backup sites pagination',exact:true});await pager.waitFor();
  assert.equal(await page.locator('.backup-library>*').count(),6,'Six site groups per phone page at '+width);
  const geometry=await page.evaluate(()=>{const p=document.querySelector('.pagination').getBoundingClientRect(),last=document.querySelector('.backup-library').lastElementChild.getBoundingClientRect(),buttons=[...document.querySelectorAll('.pagination button')].map(b=>b.getBoundingClientRect()),page=document.querySelector('.pagination-page').getBoundingClientRect();return{gap:p.top-last.bottom,heights:buttons.map(b=>b.height),sameRow:buttons.every(b=>Math.abs(b.top-buttons[0].top)<1)&&Math.abs((page.top+page.bottom)/2-(buttons[0].top+buttons[0].bottom)/2)<2,min:getComputedStyle(document.querySelector('.paged-content')).minHeight};});
  assert.ok(geometry.gap<=24,'No reserved empty area above the pager at '+width+' ('+geometry.gap+'px)');
  assert.deepEqual(geometry.heights.map(Math.round),[44,44]);assert.equal(geometry.sameRow,true,'Previous, page and Next share one row');assert.equal(geometry.min,'0px');
  await pager.getByRole('button',{name:'Backup sites next page',exact:true}).click();
  assert.equal(await page.locator('.backup-library>*').count(),6);
  await pager.getByRole('button',{name:'Backup sites previous page',exact:true}).click();
 }
 for(const width of [320,390,402,680]){
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
   if(name==='Audit'){await page.getByText('View details',{exact:true}).first().click();await page.getByRole('dialog').waitFor();assert.equal(await page.getByRole('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true,'Audit details fit '+width);await page.getByRole('button',{name:'Close dialog',exact:true}).click();await fits('Audit after details at '+width);}
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
 console.log('Mobile browser checks passed: notifications, chart data, Jobs, Audit, Access, maintenance, expanded details and pagination at 320/390/402/680px; header, drawer and card footers at 320-480px; desktop tables preserved. Synthetic fixtures only.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
