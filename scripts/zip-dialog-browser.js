import {chromium} from 'playwright';
import assert from 'node:assert/strict';

// "Download ZIP" dialog against a mocked API: preparing with progress, ready, failed, retry, reopening, cancel; light and
// dark, desktop and a 402 px phone. Run against a dev server: TEST_BASE_URL=http://127.0.0.1:5230
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5173',now=Date.now();
const state={servers:[{id:'production',name:'Production'}],sites:[{id:'DemoShop',name:'DemoShop',serverId:'production'}],policies:[],backups:[{id:'fleur-latest',siteId:'DemoShop',createdAt:new Date(now-7200000).toISOString(),capturedAt:new Date(now-7200000).toISOString(),verified:true,size:11.5*1024**3,pinned:false}],jobs:[],audit:[],storage:{used:1,total:2}};
const browser=await chromium.launch({channel:'chrome',headless:true});
const errors=[];
const exportState={current:null},calls=[];
async function open(theme,width){
 const page=await browser.newPage({viewport:{width,height:width<500?874:900}});
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:true,csrfToken:'fixture',user:{name:'Administrator',role:'admin'},serverTime:now,idleExpiresAt:now+1800000,absoluteExpiresAt:now+28800000}}));
 await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.route('**/api/auth/activity',r=>r.fulfill({json:{}}));
 await page.route('**/api/backups/fleur-latest/zip-exports**',r=>{
  const request=r.request(),url=new URL(request.url());calls.push(request.method()+' '+url.pathname);
  if(url.pathname.endsWith('/download'))return r.fulfill({status:200,contentType:'application/zip',headers:{'content-disposition':'attachment; filename="x.zip"'},body:'PK'});
  if(request.method()==='POST'){exportState.current={id:'e1',backupId:'fleur-latest',status:'preparing',bytesDone:0,bytesTotal:100,etaSeconds:null,expiresAt:null,error:null};return r.fulfill({status:202,json:exportState.current});}
  if(request.method()==='DELETE'){exportState.current=null;return r.fulfill({json:{id:'e1',status:'expired'}});}
  if(url.pathname.endsWith('/zip-exports'))return r.fulfill({json:{export:exportState.current&&['preparing','ready'].includes(exportState.current.status)?exportState.current:null}});
  return r.fulfill({json:exportState.current});
 });
 await page.addInitScript(t=>localStorage.setItem('docknest-theme',t),theme);
 await page.emulateMedia({reducedMotion:'reduce',colorScheme:theme});
 await page.goto(base);
 if(width<500)await page.getByRole('button',{name:'Open navigation',exact:true}).click();
 await page.getByRole('navigation').getByRole('button',{name:'Backups',exact:true}).click();
 await page.locator('.berry-shell.mobile-open').waitFor({state:'detached'});
 await page.locator('.backup-group>summary').first().click();
 return page;
}
const shot=async(page,name,theme,width)=>{if(process.env.SHOTS_DIR)await page.screenshot({path:`${process.env.SHOTS_DIR}/zip-${name}-${theme}-${width}.png`});};
const geometry=async dialog=>dialog.evaluate(el=>{const box=n=>{const r=n.getBoundingClientRect();return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)];};const buttons=[...el.querySelectorAll('.zip-foot button')];return {dialog:box(el),buttons:buttons.map(box),foot:getComputedStyle(el.querySelector('.zip-foot')).padding};});
for(const [theme,width] of [['light',1440],['dark',1440],['light',402],['dark',402]]){
 exportState.current=null;calls.length=0;
 const page=await open(theme,width);
 const trigger=page.getByRole('button',{name:'Download full ZIP fleur-latest'});
 await trigger.click();
 const dialog=page.locator('dialog.zip-dialog');await dialog.waitFor();
 await page.waitForFunction(()=>true);
 for(let i=0;i<100&&!calls.includes('POST /api/backups/fleur-latest/zip-exports');i++)await page.waitForTimeout(50);
 assert.ok(calls.includes('POST /api/backups/fleur-latest/zip-exports'),'starts the preparation');
 exportState.current={...exportState.current,bytesDone:40,etaSeconds:200};
 await dialog.getByText('40%',{exact:true}).waitFor({timeout:6000});
 await dialog.getByText('About 4 min left',{exact:true}).waitFor();
 assert.equal(await dialog.locator('progress').getAttribute('value'),'40');
 await dialog.getByText('You can close this window, the ZIP keeps preparing',{exact:false}).waitFor();
 assert.equal(await dialog.getByRole('button',{name:'Download ZIP',exact:true}).isDisabled(),true,'Download is disabled while preparing');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow');
 const preparing=await geometry(dialog);await shot(page,'preparing',theme,width);
 // Phone: a bottom sheet, full width, attached to the bottom edge, buttons right under the content
 if(width<500){assert.equal(preparing.dialog[0],0);assert.equal(preparing.dialog[2],width);assert.equal(preparing.dialog[1]+preparing.dialog[3],874,'sheet sits on the bottom edge');assert.ok(preparing.dialog[3]<=340,'sheet is not full height');}
 // Escape closes and returns focus to the trigger; reopening reuses the running preparation.
 await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Download full ZIP fleur-latest');
 const posts=calls.filter(c=>c.startsWith('POST')).length;
 await trigger.click();
 await dialog.getByText('40%',{exact:true}).waitFor();
 assert.equal(calls.filter(c=>c.startsWith('POST')).length,posts,'reopening reuses the running preparation');
 // Ready: same dialog size and the same button positions.
 exportState.current={...exportState.current,status:'ready',bytesDone:100,etaSeconds:null,expiresAt:new Date(Date.now()+3600000).toISOString()};
 const ready=page.getByRole('dialog',{name:'Your ZIP is ready'});await ready.waitFor({timeout:6000});
 await ready.getByText('Ready for 60 minutes',{exact:true}).waitFor();
 const readyBox=await geometry(ready);await shot(page,'ready',theme,width);
 assert.deepEqual(readyBox,preparing,'Dialog and buttons keep their size and place between states');
 assert.equal(readyBox.foot,width<500?'16px':'16px 24px');
 for(const b of readyBox.buttons)assert.ok(b[3]>=(width<500?44:40),'button height '+b[3]);
 await Promise.all([page.waitForRequest(r=>r.url().endsWith('/zip-exports/e1/download')).catch(()=>null),ready.getByRole('button',{name:'Download ZIP',exact:true}).click().catch(()=>{})]);
 await page.waitForTimeout(300);
 if(await ready.count()===0)await trigger.click();
 await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();
 assert.ok(calls.includes('DELETE /api/backups/fleur-latest/zip-exports/e1'),'Cancel deletes the prepared ZIP');
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Download full ZIP fleur-latest');
 // Failed, expired and cancelled-elsewhere states: plain text, Try again, same geometry.
 for(const [name,title,patch,text] of [
  ['failed','The ZIP could not be prepared',{status:'failed',error:'The backup could not be verified, so no ZIP was prepared. The encrypted download remains available.'},'could not be verified'],
  ['expired','This ZIP is no longer available',{status:'expired'},'ready time ran out'],
  ['cancelled','The ZIP was cancelled',null,'cancelled from another window']]){
  exportState.current=null;
  await trigger.click();
  while(!exportState.current)await page.waitForTimeout(50);
  const open=page.locator('dialog.zip-dialog');await open.waitFor();
  if(patch)exportState.current={...exportState.current,...patch};else{exportState.current=undefined;}
  if(!patch)await page.route('**/api/backups/fleur-latest/zip-exports/e1',r=>r.fulfill({status:404,json:{error:'ZIP preparation not found.'}}));
  const shown=page.getByRole('dialog',{name:title});await shown.waitFor({timeout:6000});
  await shown.getByText(text,{exact:false}).waitFor();
  await shown.getByRole('button',{name:'Try again',exact:true}).waitFor();
  assert.deepEqual(await geometry(shown),preparing,name+' keeps the dialog geometry');
  await shot(page,name,theme,width);
  await shown.getByRole('button',{name:'Cancel',exact:true}).click();await shown.waitFor({state:'detached'});
  if(!patch)await page.unroute('**/api/backups/fleur-latest/zip-exports/e1');
 }
 // Retry starts a new preparation.
 exportState.current=null;await trigger.click();while(!exportState.current)await page.waitForTimeout(50);
 exportState.current={...exportState.current,status:'failed',error:'The full ZIP could not be prepared. The encrypted download remains available.'};
 await page.getByRole('button',{name:'Try again',exact:true}).click();
 await page.getByRole('dialog',{name:'Preparing your ZIP'}).waitFor({timeout:6000});
 await page.close();
}
assert.deepEqual(errors,[]);
await browser.close();
console.log('ZIP dialog browser checks passed.');
