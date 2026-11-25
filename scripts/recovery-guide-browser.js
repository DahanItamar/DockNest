import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

// Recovery Guide page and export dialog (docs/recovery-guide.md) against a mocked API, with fake names only: the fleet
// overview and an app page, the never-made, out-of-date and partial states, the export dialog (default, login details
// with the fresh sign-in check, creating, failing), and no sideways scrolling or a sticky dialog footer on a phone.
// Light and dark, 1280 and 390 px. Run against a server: TEST_BASE_URL=http://127.0.0.1:3000
// Set SHOTS_DIR to also write screenshots.
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5173',shots=process.env.SHOTS_DIR,now=Date.now();
if(shots)await mkdir(shots,{recursive:true});
const app=(id,name,status,extra={})=>({id,name,server:'Server 1',kind:'compose',about:name+' runs on the server Server 1. It is a Compose project.',status,statusText:status==='verified'?'Verified: a restore test passed on 12 November 2026, from the main backup.':status==='untested'?'Backed up, not tested yet.':'Not backed up yet.',lastBackup:status==='none'?null:'18 November 2026, 03:10 UTC',lastTest:status==='verified'?'Passed on 12 November 2026.':'No restore test yet.',schedule:'Backed up on a schedule: 0 3 * * * (UTC).',keys:null,keyGaps:[],hasLoginNote:false,
 works:{steps:['Open https://'+name.toLowerCase()+'.example.com. The website should load.'],command:'docker ps --filter name='+name.toLowerCase()},
 down:['Open DockNest and sign in.','Open Apps and choose '+name+'.','Read its newest job under Jobs.'],
 restore:{steps:['Open DockNest and sign in.','Open Backups and choose the newest backup.','Choose Restore, choose the server and confirm.'],independent:[{text:'Make a private folder and download the backup into it.',command:'mkdir -p -m 0700 /srv/restore/'+name.toLowerCase()+' \\\n  && cd /srv/restore/'+name.toLowerCase()},{text:'Start the app.',command:'docker compose up -d'}],expertGuide:'https://example.invalid/independent-recovery.md'},...extra});
const apps=[app('a1','Shop','verified'),app('a2','Wiki','verified'),app('a3','Ledger','untested'),app('a4','Media','verified')];
const guide=list=>({title:'Recovery Guide',version:'3.0.0',secrets:false,
 startHere:{server:['Get a new Linux server.','Install Docker, Git and Node.js 24 on it.'],install:[{text:'Download DockNest at the same version.',command:'git clone --branch v3.0.0 https://example.invalid/docknest.git'},{text:'Start it.'}],storage:['Open DockNest and sign in.','Open Storage. Each backup storage should say Connected.']},
 order:list.map((a,i)=>({appId:a.id,name:a.name,reason:i===0?'Restore it first: Shop and Wiki use its database.':'It does not depend on another app.'})),
 fleet:{about:'DockNest backs up the apps below and checks that they can be restored.',whoToAsk:'Call Person 1 first. Person 2 has the shared accounts.',servers:[{name:'Server 1',apps:list.map(a=>a.name),note:'Rented server at the hosting provider.'}],apps:list.map(a=>({name:a.name,server:'Server 1',lastBackup:a.lastBackup?'18 November 2026':'None yet',status:a.statusText,lastTest:a.lastTest})),storage:[{name:'Main storage',kind:'SFTP server',holds:['the main backups','the recovery kit and this guide, in the folder docknest-recovery']}],kit:{summary:'One kit, opened with your recovery passphrase.',details:['The recovery passphrase is not in this guide. Keep it where the owner told you.']}},
 apps:list});
const page_data=kind=>kind==='never'?{made:false,madeAt:null,madeBy:null,outdated:false,changes:[],notes:'',guide:guide(apps)}
 :{made:true,madeAt:new Date(now-86400000).toISOString(),madeBy:'Person',outdated:kind==='outdated',changes:kind==='outdated'?[{code:'app_added',label:'An app was added.'},{code:'server_address_changed',label:'A server address changed.'}]:[],notes:'Call Person 1 first.',guide:guide(kind==='ok'?apps.map(a=>a.id==='a3'?{...a,status:'verified',statusText:'Verified: a restore test passed on 12 November 2026, from the main backup.',lastTest:'Passed on 12 November 2026.'}:a):apps)};
const state={servers:[{id:'s1',name:'Server 1',host:'srv.example.invalid',port:22,username:'root',status:'connected'}],sites:[],policies:[],backups:[],jobs:[],restores:[],audit:[],storage:{used:0,total:1e12},worker:{online:true},maintenance:{}};
const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
const errors=[];
async function open(theme,width,{role='admin',kind='ok',pdf,loadFails=false,reauthFails=false}={}){
 const page=await browser.newPage({viewport:{width,height:width<500?874:900}}),calls={pdf:[],reauth:[],notes:[]};
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:true,csrfToken:'fixture',user:{name:'Person',role},serverTime:now,idleExpiresAt:now+1800000,absoluteExpiresAt:now+28800000}}));
 await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.route('**/api/auth/activity',r=>r.fulfill({json:{}}));
 await page.route('**/api/runbook',r=>loadFails?r.fulfill({status:500,json:{error:'The Recovery Guide could not be loaded.'}}):r.fulfill({json:page_data(kind)}));
 await page.route('**/api/runbook/notes',r=>{calls.notes.push(r.request().postDataJSON());r.fulfill({json:{saved:true}})});
 await page.route('**/api/auth/reauth',r=>{calls.reauth.push(r.request().postDataJSON());reauthFails?r.fulfill({status:401,json:{error:'bad'}}):r.fulfill({json:{ok:true}})});
 await page.route('**/api/runbook/pdf',async r=>{const body=r.request().postDataJSON();calls.pdf.push(body);await (pdf?.(r,body,calls)??r.fulfill({status:200,contentType:'application/pdf',headers:{'Content-Disposition':'attachment; filename="recovery-guide.pdf"'},body:Buffer.from('%PDF-1.7 fixture')}))});
 await page.addInitScript(t=>localStorage.setItem('docknest-theme',t),theme);
 await page.emulateMedia({reducedMotion:'reduce',colorScheme:theme});
 await page.goto(base);
 if(width<500)await page.getByRole('button',{name:'Open navigation',exact:true}).click();
 await page.getByRole('navigation').getByRole('button',{name:'Recovery Guide',exact:true}).click();
 if(width<500)await page.locator('.berry-shell.mobile-open').waitFor({state:'detached'});
 page.calls=calls;
 return page;
}
const shot=async(page,name,theme,width,full=true)=>{if(shots)await page.screenshot({path:`${shots}/recovery-guide-${name}-${width}-${theme}.png`,fullPage:full});};
const noOverflow=async(page,what)=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no sideways scroll: '+what);
const dialogOf=page=>page.locator('dialog.rg-dialog');
const asLink=async(loc,label,w)=>{await loc.waitFor();const s=await loc.evaluate(e=>{const c=getComputedStyle(e);return {bw:parseFloat(c.borderTopWidth)+parseFloat(c.borderLeftWidth),bg:c.backgroundColor,td:c.textDecorationLine,sw:document.documentElement.scrollWidth}});assert.equal(s.bw,0,label+' has no border');assert.ok(/rgba\(0, 0, 0, 0\)|transparent/.test(s.bg),label+' has no fill: '+s.bg);assert.ok(s.td.includes('underline'),label+' is underlined');assert.ok(s.sw<=w,label+' does not overflow at '+w)};
const openDialog=async page=>{await page.getByRole('button',{name:'Download Recovery Guide (PDF)',exact:true}).click();await dialogOf(page).waitFor()};

for(const [theme,width] of [['light',1280],['dark',1280],['light',390],['dark',390]]){
 const phone=width<500;
 // Fleet overview: Start here, the restore order, then the tables; the PDF is a text link, not a button.
 let page=await open(theme,width);
 await page.getByRole('heading',{name:'If something happens to me'}).waitFor();
 for(const h of ['Start here','Restore everything in this order','Who to ask','Your servers','Your apps','Where the backups are','The emergency kit'])await page.getByRole('heading',{name:h,exact:true}).waitFor();
 assert.equal(await page.getByText('Runbook').count(),0,'the word Runbook is never shown');
 assert.equal(await page.locator('.rb-meta button.link-action').count(),1,'one text link for the PDF');
 await asLink(page.locator('.rb-meta button.link-action'),'PDF link',width);
 assert.equal(await page.getByRole('button',{name:/Download Recovery Guide/}).evaluate(b=>b.classList.contains('primary')),false,'the PDF link is not a primary button');
 await page.getByText('Up to date',{exact:true}).waitFor();
 assert.equal(await page.locator('.rb-start .rb-note').count(),3,'new server, install DockNest, connect storage');
 assert.equal(await page.locator('.rg-cmd').count()>0,true,'commands sit in monospaced boxes');
 await noOverflow(page,'fleet');
 if(phone){ // tables stack, with the column name on each value
  assert.equal(await page.locator('.rg-table tbody tr').first().locator('td').first().evaluate(td=>getComputedStyle(td).display),'block');
  assert.equal(await page.locator('.rg-table td').first().evaluate(td=>getComputedStyle(td,'::before').content),'"Server"');
 }
 await shot(page,'fleet',theme,width);
 // One app: Shop is verified, Ledger is not and says so.
 await page.getByRole('button',{name:'Shop',exact:true}).click();
 await page.getByRole('heading',{name:'Shop: what to do'}).waitFor();
 await page.getByText('Verified',{exact:true}).waitFor();
 await page.getByRole('heading',{name:'Without DockNest'}).waitFor();
 await noOverflow(page,'app');await shot(page,'app',theme,width);
 await page.getByRole('button',{name:'Ledger',exact:true}).click();
 await page.getByText('Verified',{exact:true}).waitFor();
 await page.close();

 // Never made: one empty state with a primary action that opens the dialog.
 page=await open(theme,width,{kind:'never'});
 await page.getByRole('heading',{name:'No Recovery Guide yet'}).waitFor();
 assert.equal(await page.locator('.rb-paper').count(),0);
 await noOverflow(page,'never');await shot(page,'never',theme,width);
 await page.getByRole('button',{name:'Make the Recovery Guide',exact:true}).click();await dialogOf(page).waitFor();
 await page.close();

 // Out of date: amber panel names what changed; "Make it again" opens the dialog.
 page=await open(theme,width,{kind:'outdated'});
 await page.getByText('This Recovery Guide is out of date',{exact:true}).waitFor();
 await page.getByText('An app was added. A server address changed.').waitFor();
 await page.getByText('Out of date',{exact:true}).waitFor();
 await noOverflow(page,'outdated');await shot(page,'outdated',theme,width);
 await page.getByRole('button',{name:'Make it again',exact:true}).click();await dialogOf(page).waitFor();
 await page.close();

 // Partial: Ledger has no restore test, and the panel says its steps are not verified.
 page=await open(theme,width,{kind:'partial'});
 await page.getByText('Some steps are not verified',{exact:true}).waitFor();
 await page.getByText('Ledger: no restore test has passed on its newest backup yet. Its steps are not verified.').waitFor();
 await page.getByText('No restore test yet',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Ledger',exact:true}).click();
 await page.getByText('Not verified',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Fleet overview',exact:true}).click();
 await noOverflow(page,'partial');await shot(page,'partial',theme,width);
 await page.close();

 // Export dialog, default: every app ticked, addresses and logins off, commands on.
 page=await open(theme,width);
 await openDialog(page);
 const dialog=dialogOf(page);
 assert.equal(await dialog.locator('.rg-checks input:checked').count(),4);
 const on=async name=>dialog.getByRole('checkbox',{name:new RegExp('^'+name)}).isChecked();
 assert.equal(await on('Server addresses'),false);assert.equal(await on('Login details'),false);
 assert.equal(await on('Include commands'),true,'Include commands is on by default');
 for(const n of ['Restore test history','Schedules','Your notes'])assert.equal(await on(n),true);
 assert.equal(await dialog.locator('.alert-panel').count(),0);
 await noOverflow(page,'dialog');await shot(page,'export-dialog',theme,width,false);
 if(phone){ // the footer stays at the bottom of the sheet while the form scrolls
  await dialog.locator('.rg-body').evaluate(el=>{el.scrollTop=0});
  const [foot,sheet]=await Promise.all([dialog.locator('.rg-foot').boundingBox(),dialog.boundingBox()]);
  assert.ok(Math.abs(foot.y+foot.height-(sheet.y+sheet.height))<=1,'the footer sits at the bottom of the sheet');
  assert.equal(await dialog.locator('.rg-foot').evaluate(el=>getComputedStyle(el).position),'sticky');
 }
 // Select none disables nothing silently: it says what to do and refuses to create.
 await dialog.getByRole('button',{name:'Select none'}).click();
 await dialog.getByText('Choose at least one app.').waitFor();
 await dialog.getByRole('button',{name:'Create PDF'}).click({force:true});
 assert.equal(page.calls.pdf.length,0,'no request without an app');
 await dialog.getByRole('button',{name:'Select all'}).click();
 // Login details: a warning, and "audit" is named.
 await dialog.getByRole('checkbox',{name:/^Login details/}).check();
 await dialog.getByText(/Keep it like a password\. Creating it is recorded in the audit log\./).waitFor();
 await shot(page,'export-credentials',theme,width,false);
 await page.close();

 // Creating: the server is slow; the dialog says so and locks its inputs.
 let release;const gate=new Promise(r=>{release=r});
 page=await open(theme,width,{pdf:async(r)=>{await gate;await r.fulfill({status:200,contentType:'application/pdf',body:Buffer.from('%PDF-1.7 fixture')})}});
 await openDialog(page);
 const download=page.waitForEvent('download');
 await dialogOf(page).getByRole('button',{name:'Create PDF'}).click();
 await dialogOf(page).getByText('Creating the PDF…').waitFor();
 await dialogOf(page).getByRole('button',{name:'Creating PDF…'}).waitFor();
 assert.equal(await dialogOf(page).locator('fieldset').evaluate(f=>f.disabled),true,'inputs are disabled while creating');
 await shot(page,'export-generating',theme,width,false);
 release();
 assert.equal((await download).suggestedFilename(),'recovery-guide.pdf');
 await dialogOf(page).waitFor({state:'detached'});
 assert.deepEqual(page.calls.pdf[0].include,{addresses:false,logins:false,commands:true,tests:true,schedules:true,notes:true});
 assert.equal(page.calls.pdf[0].apps.length,4);
 await page.close();

 // Failure: the plain message stays in the dialog and Create PDF stays available.
 page=await open(theme,width,{pdf:r=>r.fulfill({status:500,json:{error:'The PDF could not be created. Nothing was saved. Try again.'}})});
 await openDialog(page);
 await dialogOf(page).getByRole('button',{name:'Create PDF'}).click();
 await dialogOf(page).getByText('The PDF could not be created. Nothing was saved. Try again.').waitFor();
 assert.equal(await dialogOf(page).getByRole('button',{name:'Create PDF'}).isEnabled(),true);
 await noOverflow(page,'dialog error');await shot(page,'export-error',theme,width,false);
 await page.close();
}

// Login details need the fresh sign-in check: the server answers REAUTH_REQUIRED, the dialog asks inside itself, then retries once.
{
 const reauthNeeded=(r,body,calls)=>calls.reauth.length?r.fulfill({status:200,contentType:'application/pdf',body:Buffer.from('%PDF-1.7 fixture')}):r.fulfill({status:403,json:{error:'Verify your own authenticator or recovery code before this change.',code:'REAUTH_REQUIRED'}});
 const page=await open('light',1280,{pdf:reauthNeeded});
 await openDialog(page);const dialog=dialogOf(page);
 await dialog.getByRole('checkbox',{name:/^Login details/}).check();
 await dialog.getByRole('button',{name:'Create PDF'}).click();
 await dialog.getByRole('group',{name:'Please confirm it is you'}).waitFor();
 assert.equal(page.calls.pdf[0].include.logins,true);
 assert.equal(await dialog.getByRole('button',{name:'Verify and create PDF'}).isDisabled(),true,'needs a password and a code');
 await dialog.getByLabel('Password').fill('fixture-password');
 await dialog.getByLabel('Authenticator code').fill('123456');
 const download=page.waitForEvent('download');
 await dialog.getByRole('button',{name:'Verify and create PDF'}).click();
 await download;
 assert.deepEqual(page.calls.reauth,[{password:'fixture-password',code:'123456'}]);
 assert.equal(page.calls.pdf.length,2,'the PDF is requested again once verified');
 await page.close();
 // A wrong code says so and creates nothing.
 const bad=await open('light',1280,{pdf:reauthNeeded,reauthFails:true});
 await openDialog(bad);
 await dialogOf(bad).getByRole('checkbox',{name:/^Login details/}).check();
 await dialogOf(bad).getByRole('button',{name:'Create PDF'}).click();
 await dialogOf(bad).getByLabel('Password').fill('x');await dialogOf(bad).getByLabel('Authenticator code').fill('000000');
 await dialogOf(bad).getByRole('button',{name:'Verify and create PDF'}).click();
 await dialogOf(bad).getByText('That password or code was not right. Try again.').waitFor();
 assert.equal(bad.calls.pdf.length,1);
 await bad.close();
}

// Who to ask: edit and save, nothing else changes.
{
 const page=await open('light',1280);
 await page.getByRole('button',{name:'Edit note',exact:true}).click();
 await page.getByLabel(/Who to ask, and where to find things/).fill('Call Person 3.');
 await page.getByRole('button',{name:'Save note',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.rg-notes'));
 assert.deepEqual(page.calls.notes,[{notes:'Call Person 3.'}]);
 await page.close();
}

// The page fails to load: a plain message with a retry, never a blank page.
{
 const page=await open('light',1280,{loadFails:true});
 await page.getByText('The Recovery Guide could not be loaded',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Try again',exact:true}).waitFor();
 await page.close();
}

// Only administrators see the page or its navigation entry.
{
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 await page.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:true,csrfToken:'fixture',user:{name:'Viewer',role:'viewer'},serverTime:now,idleExpiresAt:now+1800000,absoluteExpiresAt:now+28800000}}));
 await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.route('**/api/auth/activity',r=>r.fulfill({json:{}}));
 await page.goto(base);
 await page.getByRole('navigation').getByRole('button',{name:'Overview'}).or(page.getByRole('navigation').getByRole('button',{name:'Dashboard'})).first().waitFor();
 assert.equal(await page.getByRole('navigation').getByRole('button',{name:'Recovery Guide',exact:true}).count(),0);
 await page.close();
}

await browser.close();
assert.deepEqual(errors,[],'no page errors');
console.log('Recovery Guide UI checks passed');
