import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

// Keys safe UI (docs/keys-safe.md) against a mocked API: the padlock on Map nodes, the Keys section of the Map panel, the
// Keys row on app cards, "Mark as known-good" behind the sign-in re-check, the Recovery kit check card on Self Backup and the
// ownership notes of the move review. 1280 and 390 px, light and dark, no horizontal scroll, and no key material anywhere in
// the page. Fictional names only. Run against a server: TEST_BASE_URL=http://127.0.0.1:3000. SHOTS_DIR also writes screenshots.
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5173',shots=process.env.SHOTS_DIR,now=Date.now(),past=ms=>new Date(now-ms).toISOString();
if(shots)await mkdir(shots,{recursive:true});
const DAY=86400000,HOUR=3600000;
const SHOP='5e0f3b1c-6a2d-4c8e-9f10-2b3c4d5e6f70',WIKI='6f1a4c2d-7b3e-4d9f-8a21-3c4d5e6f7a81',LEDGER='7a2b5d3e-8c4f-4eaa-9b32-4d5e6f7a8b92',MEDIA='8b3c6e4f-9d50-4fbb-8c43-5e6f7a8b9ca3',LAND='9c4d7f50-ae61-40cc-9d54-6f7a8b9cadb4';
const key=(ruleId,name,app,location,fingerprint,extra)=>({ruleId,app,name,location,fingerprint,backupId:'bk',...extra});
const keysOf=(state,keys,changed=[],knownGood={at:past(3*DAY),source:'safe-edit'})=>({state,keys,changed,knownGood});
const site=(id,name,keys,config={containers:[name.toLowerCase()+'-web']})=>({id,name,serverId:'s1',config:{...config,domains:[name.toLowerCase()+'.example.com']},keys});
const sites=[
 site(SHOP,'Shop',keysOf('green',[
  key('laravel-app-key','APP_KEY','Laravel or Firefly III','file:/srv/shop/.env','3a9c71e2',{status:'verified',verifiedAt:past(9*DAY)}),
  key('rails-secret-key-base','SECRET_KEY_BASE','Rails apps (Mastodon, GitLab)','file:/srv/shop/.env','8d04b6f1',{status:'in-backup'})])),
 site(WIKI,'Wiki',keysOf('amber',[key('n8n-encryption-key','N8N_ENCRYPTION_KEY','n8n','file:/srv/wiki/.env','51be0a7d',{status:'changed',changedAt:past(2*DAY)})],
  [{item:'/srv/wiki/compose.yaml',kind:'file',firstSeenAt:past(2*DAY)},{item:'/srv/wiki/.env',kind:'file',firstSeenAt:past(2*DAY)}])),
 site(LEDGER,'Ledger',keysOf('red',[key('laravel-app-key','APP_KEY','Laravel or Firefly III','file:/srv/ledger/.env.production','c2175e90',{status:'missing',reasonCode:'not-included',reason:'The file is not one of the files this app backs up.'})])),
 site(MEDIA,'Media',keysOf('none',[],[],null)),
 {id:LAND,name:'Landing',serverId:'s1',config:{kind:'static',documentRoot:'/var/www/landing'},keys:keysOf('none',[],[],null)}
];
const state=list=>({servers:[{id:'s1',name:'Server 1',host:'srv.example.invalid',port:22,username:'root',status:'connected',capabilities:{freeBytes:61*1024**3}},{id:'s2',name:'Server 2',host:'srv2.example.invalid',port:22,username:'root',status:'connected',capabilities:{freeBytes:30*1024**3}}],
 sites:list,policies:list.map(s=>({siteId:s.id,enabled:true,schedule:'0 2 * * *',timezone:'UTC',retention:7})),backups:[],jobs:[],restores:[],audit:[],storage:{used:0,total:1e12}});
const kitState=kitCheck=>({settings:{enabled:true,schedule:'0 3 * * *',timezone:'UTC',hasPassphrase:true},destination:{available:true,name:'Backup Box',recoveryDirectory:'docknest'},latest:{id:'sb1',finishedAt:past(6*HOUR),size:2048,checksum:'0'.repeat(64),storage:{mode:'remote',name:'Backup Box'}},active:null,kitCheck,emergency:{split:false}});
const mock={known:[],needReauth:true,busy:false,reauths:0,kit:{last:{checkedAt:past(3*HOUR),result:'passed',reason:null},active:false},kitPosts:[],runs:[],writes:[],list:sites,previews:0,requests:[]};
// A move preview with the three ownership findings of the ADR (the shape the helper adds to the move checks).
const preview=({siteId,targetServerId})=>({id:'m1',siteId,targetServerId,ok:false,verdict:'blocked',sentence:'Cannot move.',needsMoveAnyway:false,estimateSeconds:180,downtimeSeconds:30,undoDays:7,preflightHash:'h',
 blockers:['/srv/shop/uploads already exists on Server 2 and is not empty.'],warnings:[{id:'owner-map',text:'Server 2 runs Docker with user namespace remapping, so files owned by UID 1000 will show as a different owner inside the containers.',advanced:false},{id:'noexec',text:'x',advanced:true}],
 advanced:{ports:[],checks:[
  {id:'owner-map',status:'warn',title:'Owners',text:'Server 2 runs Docker with user namespace remapping, so files owned by UID 1000 will show as a different owner inside the containers.'},
  {id:'target-filesystem',status:'block',title:'Target folder',text:'/srv/shop/uploads already exists on Server 2 and is not empty.'},
  {id:'file-mode',status:'warn',title:'Modes',text:"Server 2 mounts /srv with noexec; the app's scripts in /srv/shop/bin will not run."}]}});

const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
const errors=[],offOrigin=[];
const asLink=async(loc,label,w)=>{await loc.waitFor();const s=await loc.evaluate(e=>{const c=getComputedStyle(e);return {bw:parseFloat(c.borderTopWidth)+parseFloat(c.borderLeftWidth),bg:c.backgroundColor,td:c.textDecorationLine,sw:document.documentElement.scrollWidth}});assert.equal(s.bw,0,label+' has no border');assert.ok(/rgba\(0, 0, 0, 0\)|transparent/.test(s.bg),label+' has no fill: '+s.bg);assert.ok(s.td.includes('underline'),label+' is underlined');assert.ok(s.sw<=w,label+' does not overflow at '+w)};
async function open(theme,width,{role='admin',route='Map',self=kitState(mock.kit)}={}){
 const page=await browser.newPage({viewport:{width,height:width<500?874:900}});
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{const u=new URL(r.url());if(!['data:','blob:'].includes(u.protocol)&&u.origin!==new URL(base).origin)offOrigin.push(u.href)});
 await page.route('**/api/**',route=>{
  const req=route.request(),path=new URL(req.url()).pathname,method=req.method();
  if(method!=='GET'&&!/auth\/activity/.test(path))mock.requests.push(method+' '+path);
  if(path==='/api/auth/status')return route.fulfill({json:{authenticated:true,csrfToken:'fixture',user:{id:'u1',name:'Person',role},serverTime:now,idleExpiresAt:now+1800000,absoluteExpiresAt:now+28800000}});
  if(path==='/api/state')return route.fulfill({json:state(mock.list)});
  if(path==='/api/auth/reauth'){const b=req.postDataJSON();if(b.password==='pw'&&b.code==='123456'){mock.needReauth=false;mock.reauths++;return route.fulfill({json:{ok:true}})}return route.fulfill({status:401,json:{error:'No'}})}
  if(/\/keys\/known-good$/.test(path)){
   if(mock.needReauth)return route.fulfill({status:403,json:{error:'Verify your own authenticator or recovery code before this change.',code:'REAUTH_REQUIRED'}});
   if(mock.busy)return route.fulfill({status:409,json:{error:'This app is busy. Try again when its job finishes.',code:'SITE_BUSY'}});
   mock.known.push(path.split('/')[3]);
   mock.list=mock.list.map(s=>s.id===path.split('/')[3]?{...s,keys:keysOf('green',[],[])}:s);
   return route.fulfill({json:keysOf('green',[],[])});
  }
  if(path==='/api/self-backup'&&method==='GET')return route.fulfill({json:{...self,kitCheck:mock.kit}});
  if(path==='/api/self-backup/kit-check'){mock.kitPosts.push(1);return route.fulfill({status:202,json:{id:'k',result:'queued'}})}
  if(path==='/api/self-backup/run'){mock.runs.push(1);return route.fulfill({status:202,json:{ok:true}})}
  if(path==='/api/moves'&&method==='POST'){const p=preview(req.postDataJSON());return route.fulfill({status:201,json:mock.previews++===0?{...p,ok:true,verdict:'ready-with-notes',blockers:[],advanced:{...p.advanced,checks:[]}}:p})}
  if(path.startsWith('/api/servers/')&&path.endsWith('/test'))return route.fulfill({json:{ok:true}});
  if(path==='/api/updates/progress')return route.fulfill({json:{active:false,state:'idle'}});
  if(path==='/api/version')return route.fulfill({json:{version:'0.0.0'}});
  return route.fulfill({json:path.startsWith('/api/servers')&&path.endsWith('/discover')?{containers:[]}:{}});
 });
 await page.addInitScript(t=>localStorage.setItem('docknest-theme',t),theme);
 await page.emulateMedia({reducedMotion:'reduce',colorScheme:theme});
 await page.goto(base);
 if(width<500)await page.getByRole('button',{name:'Open navigation',exact:true}).click();
 await page.getByRole('navigation').getByRole('button',{name:route,exact:true}).click();
 if(width<500)await page.locator('.berry-shell.mobile-open').waitFor({state:'detached'});
 return page;
}
const shot=async(page,name,theme,width)=>{if(shots)await page.screenshot({path:`${shots}/${name}-${width}-${theme}.png`,animations:'disabled'})};
const noOverflow=async page=>{try{await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth,null,{timeout:5000})}catch(e){const w=await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,6).map(e=>e.tagName+'.'+e.className+' '+Math.round(e.getBoundingClientRect().right)));throw new Error('horizontal scroll: '+JSON.stringify(w))}};
// Key material: a base64 or hex run of 24 or more characters, a "base64:" prefix or a PEM header would mean a value leaked into the page.
const noKeyMaterial=async(page,why)=>{const text=await page.evaluate(()=>document.body.innerText+' '+[...document.querySelectorAll('[title],[aria-label],input')].map(e=>[e.title,e.getAttribute('aria-label'),e.value].filter(Boolean).join(' ')).join(' '));
 const long=text.replace(/\/[\w./-]+/g,'').match(/[A-Za-z0-9+/=_-]{24,}/);
 assert.equal(long,null,'no long token in the page: '+why+' '+long);
 assert.equal(/base64:|BEGIN [A-Z ]*KEY/.test(text),false,'no key prefix: '+why)};
const openSite=async(page,id)=>{await page.locator('[data-node="site:'+id+'"]').focus();await page.keyboard.press('Enter')};
const fresh=()=>{Object.assign(mock,{previews:0,known:[],needReauth:true,busy:false,reauths:0,list:sites,requests:[],kitPosts:[],runs:[],kit:{last:{checkedAt:past(3*HOUR),result:'passed',reason:null},active:false}})};

for(const [theme,width] of [['light',1280],['dark',1280],['light',390],['dark',390]]){
 const phone=width<500;fresh();
 // Apps page: one Keys line per app with keys, in the status colour and plain words; none for Media and Landing.
 let page=await open(theme,width,{route:'Apps & Schedules'});
 await page.waitForFunction(()=>document.querySelectorAll('.site-card').length>=4);
 const row=name=>page.locator('.site-card',{hasText:name}).locator('.def-row',{hasText:'Keys'});
 await row('Shop').getByText('2 found, in last backup',{exact:true}).waitFor();
 await row('Wiki').getByText('Key changed since last backup',{exact:true}).waitFor();
 await row('Ledger').getByText('1 missing from last backup',{exact:true}).waitFor();
 assert.equal(await page.locator('.site-card',{hasText:'Media'}).locator('.def-row',{hasText:'Keys'}).count(),0,'no Keys line when no keys were found');
 await noOverflow(page);await noKeyMaterial(page,'apps');
 await shot(page,'keys-card',theme,width);
 await page.close();

 // Map: padlock on each node with keys and none otherwise; the panel lists names, places, fingerprints and states.
 page=await open(theme,width);
 if(!phone){
  await page.waitForSelector('[data-node="site:'+SHOP+'"]');
  const lock=id=>page.locator('[data-node="site:'+id+'"] .map-lock');
  assert.equal(await lock(SHOP).getAttribute('aria-label'),'Every key was found in the last backup');
  assert.equal(await lock(WIKI).getAttribute('aria-label'),'A key or file changed since it was last known good');
  assert.equal(await lock(LEDGER).getAttribute('aria-label'),'A key is missing from the last backup');
  assert.equal(await lock(MEDIA).count(),0,'no grey padlock when there are no keys');
  assert.equal(await lock(LAND).count(),0,'static websites have no padlock');
  await shot(page,'keys-map',theme,width);
  await openSite(page,SHOP);
  let panel=page.locator('.map-panel');await panel.waitFor();
  const keys=panel.locator('.keys-section');
  await keys.getByText('APP_KEY',{exact:true}).waitFor();
  await keys.getByText('3a9c 71e2',{exact:true}).waitFor();
  await keys.getByText(/Verified in a restore test on/).waitFor();
  await keys.getByText('In last backup',{exact:true}).waitFor();
  await keys.getByText('DockNest never shows or stores key values. It compares fingerprints.').waitFor();
  assert.equal(await keys.getByRole('button',{name:'Mark as known-good'}).count(),0,'nothing changed, nothing to mark');
  await noKeyMaterial(page,'map shop');await keys.scrollIntoViewIfNeeded();await shot(page,'keys-panel-good',theme,width);
  await openSite(page,LEDGER);
  await keys.getByText('Missing from last backup',{exact:true}).waitFor();
  await keys.getByText(/The file is not one of the files this app backs up\. Add \/srv\/ledger\/\.env\.production/).waitFor();
  await asLink(keys.getByRole('button',{name:'Add file'}),'Add file',width);
  await keys.scrollIntoViewIfNeeded();await shot(page,'keys-panel-missing',theme,width);
  await openSite(page,MEDIA);
  await keys.getByText(/No app keys found\./).waitFor();
  await keys.scrollIntoViewIfNeeded();await shot(page,'keys-panel-none',theme,width);
  await openSite(page,LAND);
  assert.equal(await panel.locator('.keys-section').count(),0,'static websites have no keys section');
  // Changed: mark as known-good needs the sign-in check, then the call goes through once.
  await openSite(page,WIKI);
  await keys.getByText('/srv/wiki/compose.yaml',{exact:true}).waitFor();
  await keys.getByText(/Changed 2 days ago, newer than the last backup/).waitFor();
  await keys.scrollIntoViewIfNeeded();await shot(page,'keys-panel-changed',theme,width);
  await asLink(keys.getByRole('button',{name:'Mark as known-good'}),'Mark as known-good',width);
  await keys.getByRole('button',{name:'Mark as known-good'}).click();
  await keys.getByRole('group',{name:'Please confirm it is you'}).waitFor();
  assert.deepEqual(mock.known,[],'nothing is marked before the sign-in check');
  await keys.scrollIntoViewIfNeeded();await shot(page,'keys-reauth',theme,width);
  await keys.getByLabel('Password').fill('pw');await keys.getByLabel('Authenticator code').fill('123456');
  await keys.getByRole('button',{name:'Verify and continue'}).click();
  await keys.getByText('Marked as known-good.').waitFor();
  assert.deepEqual(mock.known,[WIKI],'marked once, after the check');assert.equal(mock.reauths,1);
  assert.deepEqual(mock.requests.filter(r=>/known-good|reauth/.test(r)),['POST /api/sites/'+WIKI+'/keys/known-good','POST /api/auth/reauth','POST /api/sites/'+WIKI+'/keys/known-good']);
  await noKeyMaterial(page,'after known-good');
 }else{
  await page.locator('.map-list').waitFor();
  await noOverflow(page);await shot(page,'keys-map',theme,width);
  await page.getByRole('button',{name:'Details for Ledger'}).click();
  const keys=page.getByRole('dialog').locator('.keys-section');
  await keys.getByText('Missing from last backup',{exact:true}).waitFor();
  await keys.getByRole('button',{name:'Add file'}).waitFor();
  await noOverflow(page);await noKeyMaterial(page,'phone panel');await keys.scrollIntoViewIfNeeded();await shot(page,'keys-panel-missing',theme,width);
 }
 await page.close();

 // Self Backup: Recovery kit check in its three states.
 for(const [name,kit,assertions] of [
  ['ok',{last:{checkedAt:past(3*HOUR),result:'passed',reason:null,kitDate:past(4*HOUR)},active:false},async p=>{await p.getByText(/Opened on .* with the saved passphrase/).waitFor();await p.getByText('Kit checked',{exact:true}).waitFor();await p.getByText(/^Kit from /).waitFor();await p.getByText('It cannot prove your own copy of the passphrase is right.',{exact:false}).waitFor()}],
  ['failed',{last:{checkedAt:past(3*HOUR),result:'failed',reason:'hashes',kitDate:past(4*HOUR)},active:false},async p=>{await p.getByText(/^Kit from /).waitFor();await p.getByText(/Did not open on/).waitFor();await p.getByRole('alert').getByText('The newest kit did not open: its checksum differs.',{exact:false}).waitFor();await p.getByRole('button',{name:'Make a new kit'}).waitFor()}],
  ['failed-nokit',{last:{checkedAt:past(3*HOUR),result:'failed',reason:'no_kit',kitDate:past(4*HOUR)},active:false},async p=>{assert.equal(await p.getByText(/^Kit from /).count(),0,'no kit date when the check never found a kit');await p.getByText(/Did not open on/).waitFor()}],
  ['failed-nodate',{last:{checkedAt:past(3*HOUR),result:'failed',reason:'unreadable',kitDate:null},active:false},async p=>{assert.equal(await p.getByText(/^Kit from /).count(),0,'no kit date without one on record');await p.getByText(/Did not open on/).waitFor()}],
  ['never',{last:null,active:false},async p=>{await p.getByText('Not checked yet',{exact:true}).waitFor();await p.getByText('No kit checked yet. It is checked after the next Self Backup.').waitFor()}]]){
  fresh();mock.kit=kit;
  page=await open(theme,width,{route:'Self Backup'});
  const card=page.locator('section.card',{has:page.getByRole('heading',{name:'Recovery kit check'})});await card.waitFor();
  await assertions(card);
  await card.scrollIntoViewIfNeeded();await noOverflow(page);await noKeyMaterial(page,'kit '+name);
  await shot(page,'keys-kit-'+name,theme,width);
  if(name==='failed'){
   await card.getByRole('button',{name:'Check now'}).click();await page.waitForFunction(()=>true);
   await card.getByRole('button',{name:'Make a new kit'}).click();
   await page.waitForFunction(()=>true);
   assert.equal(mock.kitPosts.length,1,'Check now asks for one check');assert.equal(mock.runs.length,1,'Make a new kit starts a Self Backup');
  }
  await page.close();
 }
}

// Failure and role paths (one pass, light 1280).
{
 fresh();mock.busy=true;
 let page=await open('light',1280);
 await openSite(page,WIKI);
 const keys=page.locator('.map-panel .keys-section');
 await keys.getByRole('button',{name:'Mark as known-good'}).click();
 await keys.getByLabel('Password').fill('pw');await keys.getByLabel('Authenticator code').fill('123456');
 await keys.getByRole('button',{name:'Verify and continue'}).click();
 await keys.getByRole('alert').getByText('This app is busy. Try again when its job finishes.').waitFor();
 assert.deepEqual(mock.known,[],'a busy app is not marked');
 await page.close();
 fresh();
 page=await open('light',1280,{role:'viewer'});
 await openSite(page,WIKI);
 await page.locator('.map-panel .keys-section').getByText('/srv/wiki/compose.yaml',{exact:true}).waitFor();
 assert.equal(await page.locator('.map-panel .keys-section button').count(),0,'a viewer sees the state and no action');
 await page.close();
 // Move review: the three ownership findings are their own notes, the block stays a block, nothing is joined into one note.
 fresh();
 page=await open('light',1280);
 await page.locator('[data-node="site:'+SHOP+'"]').focus();await page.keyboard.press('Enter');
 await page.locator('.map-panel').getByRole('button',{name:'Move to…'}).click();
 const d=page.getByRole('dialog');await d.getByRole('heading',{name:'Move Shop to'}).waitFor();
 await page.waitForFunction(()=>![...document.querySelectorAll('dialog button')].some(b=>/Checking/.test(b.textContent)));
 await d.getByRole('button',{name:/^Server 2/}).click();
 await page.getByRole('button',{name:'Save changes'}).click();
 const review=page.getByRole('dialog');await review.getByRole('heading',{name:'Cannot move yet'}).waitFor();
 assert.equal(await review.locator('.alert-panel').count(),3,'three notes, one for each finding');
 assert.equal(await review.locator('.alert-panel.alert-error').count(),1,'the existing folder blocks');
 assert.equal(await review.locator('.alert-panel.alert-warning').count(),2);
 assert.equal(await review.getByText('already exists on Server 2 and is not empty.',{exact:false}).count(),1,'the block is not repeated');
 assert.equal(await review.getByRole('button',{name:'Move',exact:true}).isDisabled(),true);
 await shot(page,'keys-move-ownership','light',1280);
 await page.close();
}
assert.deepEqual(offOrigin,[],'nothing leaves the page');
assert.deepEqual(errors,[]);
await browser.close();
console.log('Keys safe browser checks passed.');
