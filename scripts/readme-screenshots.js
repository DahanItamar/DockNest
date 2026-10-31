import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

// Documentation captures are generated exclusively from synthetic API responses (documentation-range addresses, example domains).
// Start the UI first (for example `npx vite --host 127.0.0.1 --port 5199 --strictPort`) and set TEST_BASE_URL to it.
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5176';
const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true}).catch(()=>chromium.launch({headless:true}));
const now=Date.now(),time=hours=>new Date(now-hours*3600000).toISOString(),iso=time(0);
const servers=[
 {id:'demo-host-1',name:'Commerce host',note:'Customer stores',host:'192.0.2.10',username:'root',port:22,hostKey:'ab'.repeat(32),status:'connected',capabilities:{freeBytes:96*1024**3}},
 {id:'demo-host-2',name:'Content host',note:'Blogs and documentation',host:'198.51.100.20',username:'root',port:22,hostKey:'cd'.repeat(32),status:'connected',capabilities:{freeBytes:64*1024**3}},
 {id:'demo-host-3',name:'Staging',note:'',host:'203.0.113.30',username:'deploy',port:22,hostKey:'ef'.repeat(32),status:'connected',capabilities:{freeBytes:38*1024**3}}];
const names=['Demo Shop','Studio Journal','Product Catalog','Help Center','Team Portal','Demo Gallery','Documentation','Landing Page'];
const sites=names.map((name,i)=>({id:'demo-site-'+i,name,serverId:servers[i%3].id,config:i===7?{kind:'static',containers:[],documentRoot:'/var/www/demo.example.com',domains:['demo.example.com']}:{kind:'docker',containers:['demo-'+i+'-web','demo-'+i+'-db'],domains:['demo-'+i+'.example.com'],healthUrl:'http://127.0.0.1:8080/health'}}));
const backups=Array.from({length:40},(_,i)=>({id:'demo-recovery-'+i,siteId:sites[i%8].id,createdAt:time(i*4+1),capturedAt:time(i*4+1),verified:true,size:(120+i*9)*1024**2,pinned:i===0,downtimeMs:i%8===7?0:2200+i*100}));
const diag=(command,start,ms,extra={})=>({phase:'finish',command,at:new Date(now-start*1000+ms).toISOString(),elapsedMs:ms,outcome:'ok',...extra});
const runningJob={id:'demo-job-1',siteId:sites[1].id,type:'backup',status:'running',stage:'transferring',createdAt:time(0.1),startedAt:time(0.1),details:{transfer:{done:612*1024**2,total:1024**3,startedAt:time(0.05),updatedAt:iso},diagnostics:[diag('docker inspect',400,900),diag('docker stop',300,2100),diag('docker commit',290,5200),diag('docker save',280,14000),diag('tar',270,22000),diag('docker start',250,1800)]}};
const jobs=Array.from({length:24},(_,i)=>i===1?runningJob:({id:'demo-job-'+i,siteId:sites[i%8].id,type:i%6===0?'restore':'backup',status:i===8?'failed':'completed',stage:i===8?'preflight':'completed',createdAt:time(i*5),startedAt:time(i*5),finishedAt:time(i*5-0.05)}));
const storageTargets={activeTargetId:'demo-storage-1',targets:[
 {id:'demo-storage-1',name:'Backup vault',kind:'sftp',host:'198.51.100.50',status:'connected',capacity_bytes:512*1024**3,trackedBytes:24*1024**3},
 {id:'demo-storage-2',name:'Offsite bucket',kind:'s3',host:'s3.example.com',status:'connected',capacity_bytes:0,trackedBytes:9*1024**3}]};
const providers=[{id:'telegram',label:'Telegram',icon:'brand-telegram',group:'chat'},{id:'email',label:'Email',icon:'mail',group:'email'}];
const alerts={role:'admin',providers,connections:[{id:'demo-conn-1',provider:'telegram',name:'Ops Telegram'},{id:'demo-conn-2',provider:'email',name:'Team email'}],
 nodes:[{id:'demo-alert-1',name:'Ops Telegram',provider:'telegram',connectionId:'demo-conn-1',needsConnection:false,lastSend:'ok'},{id:'demo-alert-2',name:'Team email',provider:'email',connectionId:'demo-conn-2',needsConnection:false,lastSend:'ok'}],
 rules:[{id:'demo-rule-1',nodeId:'demo-alert-1',channelId:'demo-alert-1',sourceKind:'docknest',sourceId:null,events:['update-available']},
  {id:'demo-rule-2',nodeId:'demo-alert-1',channelId:'demo-alert-1',sourceKind:'server',sourceId:servers[0].id,events:['unreachable']},
  {id:'demo-rule-3',nodeId:'demo-alert-2',channelId:'demo-alert-2',sourceKind:'site',sourceId:sites[0].id,events:['backup-failed']},
  {id:'demo-rule-4',nodeId:'demo-alert-2',channelId:'demo-alert-2',sourceKind:'server',sourceId:servers[1].id,events:['unreachable']}]};
const state={servers,sites,backups,jobs,restores:[],policies:sites.map(site=>({siteId:site.id,enabled:true,schedule:'0 2 * * *',timezone:'UTC',retention:7})),audit:[],storage:{used:24*1024**3,total:256*1024**3},worker:{running:true,online:true,lastSeen:iso},maintenance:{title:'Back shortly',message:'We are updating this demo site.'}};
const updates={state:'update-available',current:{version:'2.3.0',schemaVersion:5},consent:{checkEnabled:true,decidedBy:{id:'demo-admin',name:'Administrator'},decidedAt:iso},check:{status:'ok',checkedAt:iso,lastSuccessAt:iso,nextCheckAt:null,error:null,latest:{version:'v2.4.0',publishedAt:iso,releaseUrl:'https://github.com/DahanItamar/DockNest/releases/latest',minUpgradeFrom:null}},updater:{present:true,version:'1.4',supported:true,selfUpdateFailed:false,blocked:false,status:'connected',lastHeartbeatAt:iso,installMode:'source'},offer:{update:{version:'v2.4.0',releaseUrl:'https://github.com/DahanItamar/DockNest/releases/latest'},cli:null,blocked:null},active:null};
const meta={version:'v2.4.0',publishedAt:iso,releaseUrl:'https://github.com/DahanItamar/DockNest/releases/latest',highlights:{security:false,features:2,improvements:4},highlightsVerified:true,compatibility:{minimumMet:true,updatesDatabase:'yes',fromSchema:5,toSchema:5},downtime:{seconds:240,basis:'last-run'},pauses:['Backups and restores'],notesMarkdown:'# Release notes\n\n## New features\n- Problem reports without personal data.\n- Clearer failure explanations.\n\n## Improvements\n- Faster job list.\n',notesSource:'verified'};
async function open({width=1440,height=1000,scale=2,theme='light'}={}){
 const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:scale,reducedMotion:'reduce',colorScheme:theme});
 await context.addInitScript(t=>{try{localStorage.setItem('docknest-theme',t)}catch{}},theme);
 await context.route('**/api/**',route=>{
  const path=new URL(route.request().url()).pathname;
  const json=path==='/api/auth/status'?{authenticated:true,setupRequired:false,csrfToken:'demo-fixture',user:{id:'demo-admin',name:'Administrator',role:'admin'},serverTime:now,idleExpiresAt:now+1800000,absoluteExpiresAt:now+28800000}
  :path==='/api/state'?{...state,update:{available:'v2.4.0'}}:path==='/api/storage-targets'?storageTargets:path==='/api/alerts'?alerts:path==='/api/updates'?updates:path==='/api/version'?{version:'2.3.0',schemaVersion:5}
  :path.startsWith('/api/updates/releases/')?meta:path==='/api/updates/history'?{items:[{id:'r1',version:'v2.3.0',at:time(200),outcome:'succeeded',source:'in-app'},{id:null,version:'v2.2.0',at:time(900),outcome:'succeeded',source:'cli'}],next:null}
  :path==='/api/updates/progress'?{active:false,phase:null,to:null,state:null,stale:false,updatedAt:null,events:[]}:path==='/api/updates/whats-new'?{show:false}:{};
  return route.fulfill({json});
 });
 const page=await context.newPage();
 await page.goto(base);
 await page.locator('.dash-metrics').waitFor();await page.evaluate(()=>document.fonts.ready);
 return {context,page};
}
const settle=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const go=(page,name)=>page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name,exact:true}).click();
const shot=(page,file)=>page.screenshot({path:'docs/media/'+file,animations:'disabled'});
try{
 await mkdir('docs/media',{recursive:true});
 let {context,page}=await open();
 await page.waitForFunction(()=>[...document.images].every(image=>image.complete));
 await shot(page,'dashboard.png');
 await go(page,'Servers');await page.locator('.server-card').first().waitFor();await settle(page);
 assert.equal(await page.locator('.server-card').count(),3);await shot(page,'servers.png');
 await go(page,'Backups');await page.locator('.backup-group').first().waitFor();await settle(page);
 assert.ok((await page.locator('.backup-site-name b').allTextContents()).every(name=>names.includes(name)));await shot(page,'backups.png');
 await go(page,'Jobs');await settle(page);
 await page.locator('tr',{hasText:'Studio Journal'}).filter({hasText:/running/i}).first().getByRole('button',{name:'View job'}).click();
 await page.getByRole('dialog').waitFor();await settle(page);await shot(page,'job-details.png');
 await context.close();
 ({context,page}=await open({height:1300}));
 await go(page,'Map');await page.locator('.map-site').first().waitFor();
 // Storage and alert nodes load from their own requests; capture only once both are drawn.
 await page.locator('[data-node^="storage:"]').first().waitFor();await page.locator('[data-node^="alert:"]').first().waitFor();
 await page.getByRole('button',{name:'Fit to screen'}).click();await settle(page);
 assert.equal(await page.locator('.map-site').count(),sites.length);await shot(page,'map.png');
 await context.close();
 // Same 1440x1000 viewport as the other three images in the README's 2x2 grid, so the cells line up.
 ({context,page}=await open({height:1000}));
 await page.getByRole('navigation').getByRole('button',{name:/Update Center/}).click();
 await page.getByRole('heading',{name:'Update Center',level:1}).waitFor();await settle(page);await shot(page,'update-center.png');
 await context.close();
 ({context,page}=await open({theme:'dark'}));await settle(page);await shot(page,'dashboard-dark.png');await context.close();
 ({context,page}=await open({width:402,height:874,scale:2}));await settle(page);await shot(page,'dashboard-mobile.png');await context.close();
 console.log('Documentation screenshots captured with synthetic data only.');
}finally{await browser.close();}
