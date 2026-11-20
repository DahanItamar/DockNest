import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

// "Restore on a new server" section of the Check readiness dialog (docs/restore-check.md) against a mocked API:
// findings, none found, error, partial scan, an older answer without restoreGaps, the Ignore / Note / Undo answers,
// Save a copy in backups, and the administrator and operator roles. Light and dark, 1280 and 390 px.
// Run against a dev server: TEST_BASE_URL=http://127.0.0.1:5173. Set SHOTS_DIR to also write screenshots.
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5173',shots=process.env.SHOTS_DIR,now=Date.now();
if(shots)await mkdir(shots,{recursive:true});
const key=n=>String(n).repeat(64).slice(0,64);
const find=(n,kind,extra)=>({key:key(n),kind,path:'',line:null,schedule:null,matched:'',includable:false,includePaths:[],included:false,message:'',decision:null,note:null,...extra});
const findings=()=>[
 find(1,'host-schedule',{path:'/etc/cron.d/shop',line:2,schedule:'*/5 * * * *',matched:'/srv/shop/data',includable:true,includePaths:['/etc/cron.d/shop'],message:'A scheduled task in /etc/cron.d/shop uses this app’s folder /srv/shop/data. A new server would not have it.'}),
 find(2,'external-network',{path:'proxy-net',matched:'shop-web',message:'The app uses the Docker network proxy-net, which another project created. Create it on the new server before starting the app.'}),
 find(3,'certificate',{path:'/etc/letsencrypt/live/shop.example.com',includable:false,message:'The certificate for shop.example.com lives in /etc/letsencrypt. A new server needs one issued again or copied by hand.'}),
 find(4,'host-schedule',{path:'/etc/systemd/system/shop-backup.service',schedule:'daily',includable:true,includePaths:['/etc/systemd/system/shop-backup.timer','/etc/systemd/system/shop-backup.service'],included:true,message:'A systemd timer runs a script that uses this app’s folder.'}),
 find(5,'env-file',{path:'/opt/secrets/shop.env',includable:true,includePaths:['/opt/secrets/shop.env'],decision:'ignore',message:'A Compose env_file lies outside the project folder.'}),
 find(6,'bind-outside',{path:'/mnt/media',decision:'note',note:'Media comes back from the NAS.',message:'A bind mount lies outside the app folder. It is copied and restored at the same path.'})
];
const checks=[{name:'Containers and configuration files',ok:true,message:'Found.'},{name:'Network and mount sources',ok:false,required:false,message:'Not copied: /srv/shop/cache.'}];
const readiness=restoreGaps=>({ready:true,checks,...(restoreGaps===undefined?{}:{restoreGaps})});
const SCENES={
 findings:readiness({findings:findings(),complete:true,limits:{}}),
 none:readiness({findings:[],complete:true,limits:{}}),
 error:readiness({error:'The server did not answer in time.'}),
 partial:readiness({findings:findings().slice(0,2),complete:false,limits:{files:400}}),
 partialEmpty:readiness({findings:[],complete:false,limits:{files:400}}),
 dup:readiness({findings:[
  find(1,'host-schedule',{path:'/etc/cron.d/shop',line:2,includable:true,includePaths:['/etc/cron.d/shop'],message:'A scheduled task uses this app’s folder.'}),
  find(7,'host-schedule',{path:'/etc/cron.d/shop',line:5,includable:true,includePaths:['/etc/cron.d/shop'],message:'A second line of the same file uses this app’s folder.'}),
  find(8,'host-schedule',{path:'/etc/systemd/system/shop-backup.service',schedule:'daily',includable:true,includePaths:['/etc/systemd/system/shop-backup.timer','/etc/systemd/system/shop-backup.service'],message:'A systemd timer uses this app’s folder.'})
 ],complete:true,limits:{}}),
 older:readiness()
};
const config={containers:['c1'],domains:['shop.example.com'],configFiles:['/srv/shop/.env']},siteFor=scene=>({id:'s1',name:'Shop',serverId:'s1',config:scene==='dup'?{...config,configFiles:[...config.configFiles,'/etc/systemd/system/shop-backup.timer']}:config});
const site=siteFor('findings');
const state={servers:[{id:'s1',name:'Production',host:'srv.example.invalid',port:22,username:'root',status:'connected'}],sites:[site],policies:[],backups:[],jobs:[],restores:[],audit:[],storage:{used:0,total:1e12},worker:{online:true},maintenance:{}};
const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
const errors=[];
async function open(theme,width,{role='admin',scene='findings',onWrite=()=>null}={}){
 const page=await browser.newPage({viewport:{width,height:width<500?874:900}}),calls=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:true,csrfToken:'fixture',user:{name:'Person',role},serverTime:now,idleExpiresAt:now+1800000,absoluteExpiresAt:now+28800000}}));
 await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.route('**/api/auth/activity',r=>r.fulfill({json:{}}));
 await page.route('**/api/sites/s1/readiness',r=>r.fulfill({json:SCENES[scene]}));
 await page.route('**/api/sites/s1',r=>{const q=r.request();if(q.method()==='GET')return r.fulfill({json:siteFor(scene)});calls.push({method:q.method(),url:q.url(),body:q.postDataJSON()});return onWrite(r,'site')||r.fulfill({json:site});});
 await page.route('**/api/sites/s1/restore-decisions/*',r=>{const q=r.request();calls.push({method:q.method(),url:q.url(),body:q.postDataJSON?.()});return onWrite(r,'decision')||r.fulfill({json:{ok:true}});});
 await page.addInitScript(t=>localStorage.setItem('docknest-theme',t),theme);
 await page.emulateMedia({reducedMotion:'reduce',colorScheme:theme});
 await page.goto(base);
 if(width<500)await page.getByRole('button',{name:'Open navigation',exact:true}).click();
 await page.getByRole('navigation').getByRole('button',{name:'Apps & schedules',exact:true}).click();
 if(width<500)await page.locator('.berry-shell.mobile-open').waitFor({state:'detached'});
 await page.getByRole('button',{name:'Check readiness',exact:true}).click();
 await page.locator('dialog[open]').waitFor();
 page.calls=calls;
 return page;
}
const shot=async(page,name,theme,width)=>{if(shots)await page.locator('dialog[open]').screenshot({path:`${shots}/restore-check-${name}-${width}-${theme}.png`});};
const noOverflow=page=>page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('dialog[open]')].every(d=>d.scrollWidth<=d.clientWidth));
const row=(page,text)=>page.locator('.rg-item',{hasText:text});

for(const [theme,width] of [['light',1280],['dark',1280],['light',390],['dark',390]]){
 const phone=width<500,tag=`${theme} ${width}`;
 // Findings as an administrator: the existing checks stay, the section sits below them.
 let page=await open(theme,width);
 let dialog=page.locator('dialog[open]');
 await dialog.getByText('Not copied: /srv/shop/cache.').waitFor();
 await dialog.getByRole('heading',{name:'Restore on a new server'}).waitFor();
 const order=await dialog.evaluate(d=>d.querySelector('ul').compareDocumentPosition(d.querySelector('.rg')));
 assert.ok(order&4,'the section is below the check list');
 assert.equal(await page.locator('.rg-item').count(),6);
 assert.equal(await dialog.locator('.rg-item').first().locator('.rg-link',{hasText:'Save a copy in backups'}).count(),1);
 assert.equal(await dialog.locator('.rg-item .rg-link:not(.rg-link-quiet)',{hasText:'Save a copy in backups'}).count(),1,'one Save a copy link: only the first finding is includable and open');
 await dialog.getByText('Saves a copy in the backup. The restore guide says where to put it back by hand.').waitFor();
 await row(page,'Saved').or(row(page,'systemd timer')).first().getByText('Saved in backups').waitFor();
 await row(page,'/opt/secrets/shop.env').getByText('Ignored').waitFor();
 await row(page,'/mnt/media').getByText('Noted').waitFor();
 await dialog.getByText('Media comes back from the NAS.').waitFor();
 assert.equal(await dialog.locator('.rg-item button:not(.icon-button):not(.rg-link)').count(),0,'no bordered buttons in rows');
 assert.equal(await dialog.locator('.rg-item .status').evaluateAll(l=>l.every(e=>getComputedStyle(e).backgroundColor==='rgba(0, 0, 0, 0)')),true,'status is icon and text, with no pill');
 assert.equal(await dialog.getByText(/docker (run|exec)|bash -c|curl /).count(),0,'no command text');
 await noOverflow(page);await shot(page,'findings',theme,width);
 // Overflow menu: keyboard and Escape.
 const more=row(page,'proxy-net').getByRole('button',{name:/^More actions for/});
 await more.click();
 assert.equal(await page.getByRole('menuitem').count(),2);
 await page.keyboard.press('ArrowDown');
 await page.keyboard.press('Escape');
 await page.getByRole('menuitem').first().waitFor({state:'detached'});
 assert.equal(await dialog.evaluate(()=>document.activeElement?.getAttribute('aria-haspopup')),'menu','focus returns to the trigger');
 assert.equal(await dialog.evaluate(()=>document.querySelector('dialog[open]')!==null),true,'Escape closed only the menu');
 await more.click();await shot(page,'menu',theme,width);await page.keyboard.press('Escape');
 // Ignore, then Undo.
 await more.click();await page.getByRole('menuitem',{name:'Ignore'}).click();
 await row(page,'proxy-net').getByText('Ignored').waitFor();
 assert.deepEqual(page.calls.at(-1).body,{decision:'ignore'});assert.equal(page.calls.at(-1).method,'PUT');
 assert.match(page.calls.at(-1).url,new RegExp('/restore-decisions/'+key(2)+'$'));
 await row(page,'proxy-net').getByRole('button',{name:/^More actions for/}).click();await page.getByRole('menuitem',{name:'Undo'}).click();
 await row(page,'proxy-net').getByText('Ignored').waitFor({state:'detached'});
 assert.equal(page.calls.at(-1).method,'DELETE');
 // Note: 500 characters, no number spinners, saved text shown.
 await row(page,'proxy-net').getByRole('button',{name:/^More actions for/}).click();await page.getByRole('menuitem',{name:'Note'}).click();
 const area=dialog.getByRole('textbox',{name:/Note for/});
 assert.equal(await area.getAttribute('maxlength'),'500');
 await area.fill('x'.repeat(520));assert.equal((await area.inputValue()).length,500);
 await dialog.getByText('500/500').waitFor();
 await area.fill('Created by the proxy project.');await shot(page,'note',theme,width);
 await dialog.getByRole('button',{name:'Save note'}).click();
 await row(page,'proxy-net').getByText('Created by the proxy project.').waitFor();
 assert.deepEqual(page.calls.at(-1).body,{decision:'note',note:'Created by the proxy project.'});
 // Save a copy in backups adds the files to the app's configuration files through the app update.
 await row(page,'/etc/cron.d/shop').getByRole('button',{name:'Save a copy in backups'}).click();
 await row(page,'/etc/cron.d/shop').getByText('Saved in backups').waitFor();
 const patch=page.calls.find(c=>c.method==='PATCH');
 assert.deepEqual(patch.body.config.configFiles,['/srv/shop/.env','/etc/cron.d/shop']);assert.equal(patch.body.name,'Shop');
 assert.deepEqual(patch.body.config.containers,['c1'],'other fields are kept');assert.deepEqual(patch.body.config.domains,['shop.example.com'],'other fields are kept');
 assert.equal(await row(page,'/etc/cron.d/shop').getByRole('button',{name:'Save a copy in backups'}).count(),0);
 await page.close();

 // Operator: Ignore and Note work, Save a copy is disabled with its reason.
 page=await open(theme,width,{role:'operator'});dialog=page.locator('dialog[open]');
 const save=row(page,'/etc/cron.d/shop').getByRole('button',{name:'Save a copy in backups'});
 await save.waitFor();assert.equal(await save.isDisabled(),true);
 await row(page,'/etc/cron.d/shop').getByText('An administrator can add this.',{exact:false}).waitFor();
 await row(page,'/etc/cron.d/shop').getByRole('button',{name:/^More actions for/}).click();await page.getByRole('menuitem',{name:'Ignore'}).click();
 await row(page,'/etc/cron.d/shop').getByText('Ignored').waitFor();
 await shot(page,'operator',theme,width);await page.close();

 // A refusal from the server is shown as the plain text.
 page=await open(theme,width,{onWrite:(r,what)=>what==='site'?r.fulfill({status:403,json:{error:'Administrator access required.',code:'ADMIN_REQUIRED'}}):null});
 await row(page,'/etc/cron.d/shop').getByRole('button',{name:'Save a copy in backups'}).click();
 await page.getByRole('alert').getByText('An administrator can add this.').waitFor();
 await row(page,'/etc/cron.d/shop').getByText('Saved in backups').waitFor({state:'detached'});
 await page.close();

 // None found, error, partial, older answer.
 page=await open(theme,width,{scene:'none'});
 await page.getByText('Nothing outside the app folder that a new server would miss').waitFor();
 assert.equal(await page.locator('.rg-item').count(),0);await shot(page,'none',theme,width);await page.close();
 page=await open(theme,width,{scene:'error'});
 await page.getByRole('alert').getByText('The server did not answer in time.',{exact:false}).waitFor();
 await page.getByText('Not copied: /srv/shop/cache.').waitFor();await shot(page,'error',theme,width);await page.close();
 page=await open(theme,width,{scene:'partial'});
 await page.getByText('The scan stopped early; there may be more').waitFor();
 assert.equal(await page.locator('.rg-item').count(),2);await shot(page,'partial',theme,width);await page.close();
 page=await open(theme,width,{scene:'partialEmpty'});
 await page.getByText('Nothing found so far, but the scan stopped early').waitFor();
 assert.equal(await page.getByText('Nothing outside the app folder that a new server would miss').count(),0,'no success line for a partial scan');await page.close();
 // Include keeps one entry per path and updates sibling findings that are now covered.
 page=await open(theme,width,{scene:'dup'});
 await row(page,'shop-backup.service').getByRole('button',{name:'Save a copy in backups'}).click();
 await row(page,'shop-backup.service').getByText('Saved in backups').waitFor();
 assert.deepEqual(page.calls.find(c=>c.method==='PATCH').body.config.configFiles,['/srv/shop/.env','/etc/systemd/system/shop-backup.timer','/etc/systemd/system/shop-backup.service'],'no duplicate paths');
 await page.locator('.rg-item',{hasText:'/etc/cron.d/shop:2'}).getByRole('button',{name:'Save a copy in backups'}).click();
 await page.locator('.rg-item',{hasText:'/etc/cron.d/shop:5'}).getByText('Saved in backups').waitFor();
 await page.close();
 page=await open(theme,width,{scene:'older'});
 assert.equal(await page.locator('.rg').count(),0,'an older answer shows no section');
 await page.getByText('Not copied: /srv/shop/cache.').waitFor();await page.close();
 console.log('restore check UI ok',tag,phone?'(phone)':'');
}
await browser.close();
assert.deepEqual(errors,[],'no page errors');
