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
for(const [theme,width] of [['light',1440],['dark',1440],['light',402],['dark',402]]){
 exportState.current=null;calls.length=0;
 const page=await open(theme,width);
 await page.getByRole('button',{name:'Download full ZIP fleur-latest'}).click();
 const dialog=page.getByRole('dialog',{name:'Preparing your ZIP'});await dialog.waitFor();
 assert.ok(calls.includes('POST /api/backups/fleur-latest/zip-exports'),'starts the preparation');
 // Preparing: step, progress bar, percent, time left, close note.
 exportState.current={...exportState.current,bytesDone:40,etaSeconds:200};
 await dialog.getByText('Checking the backup',{exact:true}).first().waitFor();
 await dialog.getByText('40%',{exact:true}).waitFor({timeout:6000});
 await dialog.getByText('About 4 min left',{exact:true}).waitFor();
 assert.equal(await dialog.locator('progress').getAttribute('value'),'40');
 await dialog.getByText('You can close this window, the ZIP keeps preparing',{exact:false}).waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow');
 // Close and reopen: the same preparation is shown, not a second one.
 await dialog.getByRole('button',{name:'Close dialog'}).click();await dialog.waitFor({state:'detached'});
 const posts=calls.filter(c=>c.startsWith('POST')).length;
 await page.getByRole('button',{name:'Download full ZIP fleur-latest'}).click();
 await page.getByRole('dialog',{name:'Preparing your ZIP'}).getByText('40%',{exact:true}).waitFor();
 assert.equal(calls.filter(c=>c.startsWith('POST')).length,posts,'reopening reuses the running preparation');
 // Ready.
 exportState.current={...exportState.current,status:'ready',bytesDone:100,etaSeconds:null,expiresAt:new Date(Date.now()+3600000).toISOString()};
 const ready=page.getByRole('dialog',{name:'Your ZIP is ready'});await ready.waitFor({timeout:6000});
 await ready.getByText('Ready for 60 minutes',{exact:true}).waitFor();
 const download=ready.getByRole('button',{name:'Download ZIP',exact:true});
 const height=await download.evaluate(el=>el.getBoundingClientRect().height);assert.ok(height>=(width<500?44:40),'button height '+height);
 const [request]=await Promise.all([page.waitForRequest(r=>r.url().endsWith('/zip-exports/e1/download')).catch(()=>null),page.evaluate(()=>0),download.click().catch(()=>{})]);
 await page.waitForTimeout(300);
 await ready.getByRole('button',{name:'Discard'}).click();
 assert.ok(calls.includes('DELETE /api/backups/fleur-latest/zip-exports/e1'),'cancel deletes the preparation');
 // Failure and retry.
 exportState.current=null;
 await page.getByRole('button',{name:'Download full ZIP fleur-latest'}).click();
 const second=page.getByRole('dialog');await second.waitFor();
 while(!exportState.current)await page.waitForTimeout(50);
 exportState.current={...exportState.current,status:'failed',error:'The backup could not be verified, so no ZIP was prepared. The encrypted download remains available.'};
 const failed=page.getByRole('dialog',{name:'The ZIP could not be prepared'});await failed.waitFor({timeout:6000});
 await failed.getByText('could not be verified',{exact:false}).waitFor();
 await failed.getByRole('button',{name:'Try again',exact:true}).waitFor();
 if(process.env.SHOTS_DIR)await page.screenshot({path:`${process.env.SHOTS_DIR}/zip-failed-${theme}-${width}.png`});
 await failed.getByRole('button',{name:'Try again',exact:true}).click();
 await page.getByRole('dialog',{name:'Preparing your ZIP'}).waitFor({timeout:6000});
 await page.close();
}
assert.deepEqual(errors,[]);
await browser.close();
console.log('ZIP dialog browser checks passed.');
