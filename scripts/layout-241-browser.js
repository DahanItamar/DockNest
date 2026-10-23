// 2.4.1 layout checks against a mocked API: wide-screen frame, Overview metric grid, Audit table, collapsed rail,
// page filters, several storage destinations. Synthetic fixtures only; no real backup or restore is exercised.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5173';
const evidence=process.env.LAYOUT_EVIDENCE_DIR||'';
if(evidence)await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
const GB=1e9,TB=1e12,time=i=>new Date(Date.now()-i*3600000).toISOString();
const UUID='3617ffd0-0ebb-4c8d-a0cf-e1b2c3d4e5f6';
const servers=Array.from({length:6},(_,i)=>({id:'host-'+i,name:'Docker host '+i,username:'root',host:'192.0.2.'+(i+1),port:22,hostKey:'ab'.repeat(32)}));
const sites=Array.from({length:9},(_,i)=>({id:'site-'+i,name:'Website '+i,serverId:servers[i%6].id,config:{containers:['web-'+i,'db-'+i],domains:['s'+i+'.example.invalid']}}));
const backups=Array.from({length:40},(_,i)=>({id:'backup-'+i,siteId:'site-'+(i%9),capturedAt:time(i*5),createdAt:time(i*5),verified:true,size:480*1048576,pinned:false}));
const jobs=Array.from({length:60},(_,i)=>({id:'job-'+i,siteId:'site-'+(i%9),type:'backup',status:'completed',stage:'completed',createdAt:time(i)}));
const codes=['auth.login','updater.refused','updater.requested','auth.reauth','job.superseded','backup.completed','site.update'];
const audit=Array.from({length:70},(_,i)=>({id:'e'+i,createdAt:time(i),action:codes[i%codes.length],actor:['job.superseded'].includes(codes[i%codes.length])?'worker':i%5===1?'system':i%9===0?'deleted-'+UUID:UUID,details:{note:'fixture'}}));
const all=[
 {id:'t0',name:'hetzner-storage-box-frankfurt-primary',host:'u123456.your-storagebox.de',port:23,username:'u123456',root:'/home/docknest',auth_type:'ssh-key',capacity_bytes:TB},
 {id:'t1',name:'s3-eu-central-archive-immutable-copy-with-a-very-long-name',kind:'s3',endpoint:'https://s3.eu-central-1.amazonaws.com',bucket:'docknest-archive-immutable-eu-central',objectLock:{mode:'COMPLIANCE',days:30},root:'docknest/',capacity_bytes:null},
 {id:'t2',name:'office-nas-offsite-copy',host:'nas.office.example.invalid',port:22,username:'docknest',root:'/volume1/docknest',auth_type:'ssh-key',capacity_bytes:2*TB},
 {id:'t3',name:'wasabi-us-east-1-cold',kind:'s3',endpoint:'https://s3.wasabisys.com',bucket:'cold',objectLock:null,root:'cold/',capacity_bytes:null},
 {id:'t4',name:'backblaze-b2-amsterdam-secondary',kind:'s3',endpoint:'https://s3.eu-central-003.backblazeb2.com',bucket:'docknest-b2',objectLock:{mode:'GOVERNANCE',days:7},root:'b2/',capacity_bytes:null},
];
async function open(width,height,{side='expanded',count=3,theme='light',health=true,nearlyFull=false}={}){
 const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const targets=all.slice(0,count),active=nearlyFull?{...targets[0],capacity_bytes:110*GB}:targets[0];
 const state={servers,sites,backups,jobs:health?jobs:[{...jobs[0],status:'failed',error:'The worker reported this error for the attempt.'},...jobs.slice(1)],audit,actors:{[UUID]:'Fixture administrator'},policies:sites.map(site=>({siteId:site.id,enabled:true,schedule:'0 2 * * *',timezone:'UTC',retention:site.id==='site-0'?1:7})),storage:{used:106.1*GB,total:active.capacity_bytes||0,name:active.name},worker:{running:true,online:true,lastSeen:new Date().toISOString()},maintenance:{title:'Back shortly',message:'Soon.',color:'#5E35B1'}};
 await page.addInitScript(([t,s])=>{localStorage.setItem('docknest-theme',t);localStorage.setItem('docknest-sidebar',s)},[theme,side]);
 await page.route('**/api/**',r=>r.fulfill({json:{}}));
 await page.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:true,csrfToken:'f',user:{id:'admin',name:'Administrator',role:'admin'},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000}}));
 await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.route('**/api/storage-targets',r=>r.fulfill({json:{targets,activeTargetId:active.id}}));
 await page.route('**/api/updates/**',r=>r.fulfill({status:404,json:{}}));
 await page.goto(base);await page.locator('main#content').waitFor();await page.waitForTimeout(500);
 const navigate=async name=>{if(await page.evaluate(()=>innerWidth<900&&!document.querySelector('.mobile-open')))await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name,exact:true}).click();await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(250);};
 return {page,context,errors,navigate,close:()=>context.close()};
}
const shot=async(page,name)=>{if(evidence)await page.screenshot({path:evidence+'/'+name+'.png'})};
try{
 // 4: wide screens use the width: modest edge padding, no big empty side margins, rail expanded or collapsed.
 for(const [width,height] of [[1920,1100],[2560,1300],[3840,1600]])for(const side of ['expanded','collapsed']){
  const app=await open(width,height,{side});
  for(const route of ['Overview','Servers','Sites & schedules','Backups','Jobs','Audit','Storage']){
   await app.navigate(route);
   const margins=await app.page.evaluate(()=>{const main=document.querySelector('main#content').getBoundingClientRect(),workspace=document.querySelector('.workspace').getBoundingClientRect(),style=getComputedStyle(document.querySelector('main#content'));return {left:Math.round(main.left-workspace.left),right:Math.round(workspace.right-main.right),padding:parseFloat(style.paddingLeft),scroll:document.documentElement.scrollWidth-innerWidth};});
   assert.ok(margins.left<=200&&margins.right<=200,`${route} side margins at ${width} ${side}: ${JSON.stringify(margins)}`);
   assert.ok(margins.padding>=40&&margins.padding<=48,`${route} edge padding at ${width}: ${margins.padding}`);assert.ok(margins.scroll<=0,'no horizontal scroll');
  }
  if(width===2560){await app.navigate('Audit');await shot(app.page,'audit-2560-'+side);await app.navigate('Overview');await shot(app.page,'overview-2560-'+side);await app.navigate('Sites & schedules');await shot(app.page,'sites-2560-'+side);await app.navigate('Jobs');await shot(app.page,'jobs-2560-'+side);}
  assert.deepEqual(app.errors,[]);await app.close();
 }
 // 11: Overview metrics: 3 columns x 2 rows at every desktop width, edges aligned.
 for(const [width,height] of [[1024,900],[1440,1000],[1920,1100],[2560,1300],[3840,1600]]){
  const app=await open(width,height);
  const box=await app.page.evaluate(()=>{const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}},cards=[...document.querySelectorAll('.dash-metrics>.dash-metric,.dash-metrics .metric-stack>.dash-metric')].map(rect);return cards;});
  assert.equal(box.length,4);const [purple,blue,jobsCard,downtime]=box,near=(a,b,message)=>assert.ok(Math.abs(a-b)<=1,message+` at ${width}: ${a} vs ${b}`);
  near(purple.top,blue.top,'large cards share a top');near(purple.top,jobsCard.top,'stack top');near(purple.bottom,blue.bottom,'large cards share a bottom');near(purple.bottom,downtime.bottom,'stack bottom');
  near(blue.left-purple.right,jobsCard.left-blue.right,'equal column gaps');near(downtime.top-jobsCard.bottom,blue.left-purple.right,'stack gap equals the column gap');assert.ok(jobsCard.left>blue.left,'third column');
  assert.equal(await app.page.getByRole('button',{name:'Month',exact:true}).getAttribute('aria-pressed'),'true','Recovery points opens on Month');assert.equal(await app.page.getByRole('button',{name:'Year',exact:true}).getAttribute('aria-pressed'),'false');
  if(width===1440)await shot(app.page,'overview-1440');
  await app.close();
 }
 // 6: Audit: readable labels, display names, nothing truncated, raw code in the details.
 for(const [width,height] of [[1280,900],[1440,1000],[2560,1300]]){
  const app=await open(width,height);await app.navigate('Audit');
  const cells=await app.page.evaluate(()=>[...document.querySelectorAll('.data-table th,.data-table td')].map(cell=>({text:cell.innerText.trim(),cut:cell.scrollWidth>cell.clientWidth+1,tag:cell.tagName})));
  assert.deepEqual(cells.filter(cell=>cell.cut),[],'No audit cell is truncated at '+width);
  const text=cells.map(cell=>cell.text).join('|');
  for(const label of ['Signed in','Update refused','Update requested','Re-authenticated','Job superseded','Fixture administrator','System','Worker'])assert.ok(text.includes(label),label+' is shown');
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(text),'No raw id in the table');assert.ok(!text.includes('auth.login'),'No raw action code in the table');assert.ok(text.includes('Unknown user'),'Unknown ids read as Unknown user');
  const rows=await app.page.locator('tbody tr').count();assert.ok(rows>=10,'At least ten rows ('+rows+')');
  await app.page.getByRole('button',{name:'View details'}).first().click();const dialog=app.page.getByRole('dialog',{name:'Audit details'});await dialog.getByText(/auth\.login|updater\.|job\.superseded/).first().waitFor();
  await dialog.getByRole('button').first().click().catch(()=>{});
  assert.deepEqual(app.errors,[]);await app.close();
 }
 // The Audit and Jobs tables fill the viewport: the pager is near the bottom, not halfway down.
 for(const route of ['Audit','Jobs']){
  const app=await open(2560,1300);await app.navigate(route);
  const bottom=await app.page.evaluate(()=>document.querySelector('.pagination').getBoundingClientRect().bottom);assert.ok(bottom>1300-200,route+' pager sits near the bottom of a 1300px screen ('+Math.round(bottom)+')');
  await app.close();
 }
 // 7: collapsed rail: a 44px health button and a 44px capacity ring, no text, no frame at rest, ring only on keyboard focus.
 for(const [width,height] of [[1440,1000],[2560,1300]])for(const theme of ['light','dark'])for(const health of [true,false]){
  const app=await open(width,height,{side:'collapsed',theme,health});
  const rail=await app.page.evaluate(()=>{const health=document.querySelector('.system-health'),ring=document.querySelector('.compact-storage-button'),box=el=>{const r=el.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height),top:r.top,bottom:r.bottom,left:r.left,right:r.right}},style=getComputedStyle(health),visibleText=[...document.querySelectorAll('.berry-sidebar .system-health-label,.berry-sidebar .health-short,.berry-sidebar .compact-storage-button b,.berry-sidebar .compact-storage-button small')].filter(el=>{const r=el.getBoundingClientRect();return r.width>2&&r.height>2&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none'}).map(el=>el.textContent);return {health:box(health),ring:box(ring),outline:style.outlineStyle,border:style.borderTopWidth,visibleText,label:health.getAttribute('aria-label')};});
  assert.deepEqual([rail.health.w,rail.health.h,rail.ring.w,rail.ring.h],[44,44,44,44],'44px health and ring buttons');
  assert.ok(rail.health.bottom<=rail.ring.top+0.5,'health and ring do not overlap');assert.deepEqual(rail.visibleText,[],'no text in the rail');
  assert.ok(rail.outline==='none'&&rail.border==='0px','no frame at rest');assert.match(rail.label,/System health/);
  await app.page.locator('.system-health').focus();await app.page.keyboard.press('Shift+Tab');await app.page.keyboard.press('Tab');
  const focused=await app.page.evaluate(()=>{const style=getComputedStyle(document.querySelector('.system-health'));return {matches:document.querySelector('.system-health').matches(':focus-visible'),width:style.outlineWidth,style:style.outlineStyle}});
  if(focused.matches)assert.deepEqual([focused.width,focused.style],['2px','solid'],'focus ring only on focus-visible');
  if(health&&theme==='light')await shot(app.page,'rail-'+width+'-'+theme+'-healthy');
  if(!health)await shot(app.page,'rail-'+width+'-'+theme+'-review');
  await app.page.locator('.compact-storage-button').hover();await app.page.locator('#compact-storage-details').waitFor();assert.ok((await app.page.locator('#compact-storage-details').innerText()).includes('hetzner-storage-box-frankfurt-primary'),'popover names the destination');
  await app.close();
 }
 // Phones keep the same 24px gap between the last card or row and the pager, and Audit's details icon shares its label row.
 {
  const app=await open(402,900);
  for(const [route,label,selector] of [['Sites & schedules','Sites','.site-card'],['Servers','Servers','.server-card'],['Audit','Audit','.table-wrap']]){
   await app.navigate(route);const pager=app.page.getByRole('group',{name:label+' pagination',exact:true}),next=pager.getByRole('button',{name:label+' next page',exact:true});
   const gap=()=>app.page.evaluate(sel=>{const items=[...document.querySelectorAll(sel)],bottom=Math.max(...items.map(item=>item.getBoundingClientRect().bottom));return Math.round(document.querySelector('.pagination').getBoundingClientRect().top-bottom)},selector);
   for(let page=1;page<=2;page++){assert.equal(await gap(),24,label+' pager gap on a phone, page '+page);if(await next.isDisabled())break;await next.click();await app.page.waitForTimeout(150);}
  }
  await app.navigate('Audit');
  const row=await app.page.evaluate(()=>{const cell=document.querySelector('td.audit-details'),button=cell.querySelector('button').getBoundingClientRect(),label=getComputedStyle(cell,'::before'),box=cell.getBoundingClientRect();return {height:Math.round(box.height),button:Math.round(button.height),display:getComputedStyle(cell).display,labelMargin:label.marginBottom}});
  assert.equal(row.display,'flex');assert.ok(row.height<=row.button+32,'details cell is one row ('+row.height+')');assert.equal(row.labelMargin,'0px');
  await app.close();
 }
 // 9: the header has no search box; each list page has one funnel filter with the record count.
 {
  const app=await open(1440,1000);assert.equal(await app.page.getByLabel('Search pages').count(),0);assert.equal(await app.page.locator('.berry-header input').count(),0);
  for(const [route,placeholder] of [['Servers','Filter servers'],['Sites & schedules','Filter sites'],['Backups','Filter recovery points'],['Jobs','Filter jobs'],['Audit','Filter audit events']]){
   await app.navigate(route);const filter=app.page.getByLabel('Filter '+route,{exact:true});assert.equal(await filter.count(),1,route);assert.match(await filter.getAttribute('placeholder'),new RegExp('^'+placeholder));
   const bar=await app.page.evaluate(()=>{const b=document.querySelector('.filter-bar');return {icon:b.querySelector('svg')?.getAttribute('class')||'',count:b.querySelector('span')?.textContent||'',border:getComputedStyle(b).borderTopWidth}});
   assert.match(bar.icon,/filter/);assert.doesNotMatch(bar.icon,/search/);assert.match(bar.count,/^\d+ (record|records|server|servers)$/);assert.equal(bar.border,'1px');
  }
  await app.navigate('Servers');await shot(app.page,'servers-1440');await app.close();
 }
 // 10: several storage destinations: names labelled, nothing overflows or overlaps, long names stay inside their cards.
 for(const count of [1,2,3,5])for(const [width,height] of [[1440,1000],[2560,1300],[402,900]])for(const side of width>=900?['expanded','collapsed']:['expanded']){
  const app=await open(width,height,{side,count});
  const ok=await app.page.evaluate(()=>({overflow:document.documentElement.scrollWidth-innerWidth,sidebar:document.querySelector('.berry-sidebar-storage .storage-name')?.getAttribute('title')||null}));assert.ok(ok.overflow<=0,`no horizontal overflow (${count}, ${width}, ${side})`);
  if(width>=900&&side==='expanded')assert.equal(ok.sidebar,'hetzner-storage-box-frankfurt-primary','The sidebar readout names its destination');
  await app.navigate('Storage');await app.page.locator('.storage-card').first().waitFor();
  const cards=await app.page.evaluate(()=>[...document.querySelectorAll('.storage-card')].map(card=>({fits:card.scrollWidth<=card.clientWidth+1,selected:card.querySelector('.status-success')?.textContent||null,name:card.querySelector('.storage-card-name')?.getAttribute('title'),oneLine:(()=>{const n=card.querySelector('.storage-card-name');return n.scrollHeight<=n.clientHeight+1})(),buttons:[...card.querySelectorAll('.storage-card-actions button')].map(b=>b.getBoundingClientRect().height)})));
  assert.ok(cards.every(card=>card.fits&&card.oneLine),'cards contain their text and the title is one line');assert.ok(cards.every(card=>card.buttons.every(h=>h<=44)),'footer labels never wrap');assert.equal(cards.filter(card=>card.selected==='Used for new backups').length,1,'exactly one selected destination');
  const fills=await app.page.evaluate(()=>[...document.querySelectorAll('.storage-card-actions')].map(f=>{const cs=getComputedStyle(f),r=f.getBoundingClientRect(),inner=r.width-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight),bs=[...f.querySelectorAll('button')].map(b=>b.getBoundingClientRect());return {n:bs.length,inner,widths:bs.map(b=>b.width),span:bs.length?bs[bs.length-1].right-bs[0].left:0,stacked:bs.length>1&&Math.abs(bs[0].top-bs[1].top)>4}}));
  for(const f of fills){if(f.stacked)assert.ok(f.widths.every(w=>Math.abs(w-f.inner)<=2),'stacked footer buttons fill the width');else{assert.ok(Math.abs(f.span-f.inner)<=2,`footer buttons fill the row (${f.n} buttons, ${width})`);assert.ok(f.widths.every(w=>Math.abs(w-f.widths[0])<=2),'footer buttons share the row equally')}}
  if(width>=900)assert.ok(cards.length<=4);
  if(count===5&&width>=900)assert.equal(await app.page.getByRole('group',{name:'Storage destinations pagination',exact:true}).count(),1,'five destinations paginate by viewport');
  assert.deepEqual(app.errors,[]);await app.close();
 }
 console.log('2.4.1 layout passed: wide-screen frame at 1920/2560/3840 with the rail expanded and collapsed, Overview 3x2 grid at five widths, Audit labels, names and no truncation, collapsed rail (light, dark, healthy, review), page filters, several storage destinations at 1440, 2560 and 402.');
}finally{await browser.close();}

