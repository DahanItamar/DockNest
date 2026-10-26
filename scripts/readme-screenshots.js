import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import nodePath from 'node:path';

// Documentation captures are generated exclusively from synthetic API responses (documentation-range addresses, example domains).
// Start the UI first (for example `npx vite --host 127.0.0.1 --port 5199 --strictPort`) and set TEST_BASE_URL to it.
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5176';
const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true}).catch(()=>chromium.launch({headless:true}));
const now=Date.now(),time=hours=>new Date(now-hours*3600000).toISOString(),iso=time(0);
const servers=[
 {id:'demo-host-1',name:'Commerce host',note:'Customer stores',host:'192.0.2.10',username:'root',port:22,hostKey:'ab'.repeat(32)},
 {id:'demo-host-2',name:'Content host',note:'Blogs and documentation',host:'192.0.2.20',username:'root',port:22,hostKey:'cd'.repeat(32)},
 {id:'demo-host-3',name:'Staging',note:'',host:'203.0.113.30',username:'deploy',port:22,hostKey:'ef'.repeat(32)}];
const names=['Demo Shop','Studio Journal','Product Catalog','Help Center','Team Portal','Demo Gallery','Documentation','Landing Page'];
const sites=names.map((name,i)=>({id:'demo-site-'+i,name,serverId:servers[i%2].id,config:i===7?{kind:'static',containers:[],documentRoot:'/var/www/demo.example.com',domains:['demo.example.com']}:{kind:'docker',containers:['demo-'+i+'-web','demo-'+i+'-db'],domains:['demo-'+i+'.example.com'],healthUrl:'http://127.0.0.1:8080/health'}}));
const backups=Array.from({length:40},(_,i)=>({id:'demo-recovery-'+i,siteId:sites[i%8].id,createdAt:time(i*4+1),capturedAt:time(i*4+1),verified:true,size:(120+i*9)*1024**2,pinned:i===0,downtimeMs:i%8===7?0:2200+i*100}));
const diag=(command,start,ms,extra={})=>({phase:'finish',command,at:new Date(now-start*1000+ms).toISOString(),elapsedMs:ms,outcome:'ok',...extra});
const runningJob={id:'demo-job-1',siteId:sites[1].id,type:'backup',status:'running',stage:'transferring',createdAt:time(0.1),startedAt:time(0.1),details:{transfer:{done:612*1024**2,total:1024**3,startedAt:time(0.05),updatedAt:iso},diagnostics:[diag('docker inspect',400,900),diag('docker stop',300,2100),diag('docker commit',290,5200),diag('docker save',280,14000),diag('tar',270,22000),diag('docker start',250,1800)]}};
const jobs=Array.from({length:24},(_,i)=>i===1?runningJob:({id:'demo-job-'+i,siteId:sites[i%8].id,type:i%6===0?'restore':'backup',status:i===8?'failed':'completed',stage:i===8?'preflight':'completed',createdAt:time(i*5),startedAt:time(i*5),finishedAt:time(i*5-0.05)}));
const state={servers,sites,backups,jobs,restores:[],policies:sites.map(site=>({siteId:site.id,enabled:true,schedule:'0 2 * * *',timezone:'UTC',retention:7})),audit:[],storage:{used:24*1024**3,total:256*1024**3},worker:{running:true,online:true,lastSeen:iso},maintenance:{title:'Back shortly',message:'We are updating this demo site.'}};
const updates={state:'update-available',current:{version:'2.3.0',schemaVersion:5},consent:{checkEnabled:true,decidedBy:{id:'demo-admin',name:'Administrator'},decidedAt:iso},check:{status:'ok',checkedAt:iso,lastSuccessAt:iso,nextCheckAt:null,error:null,latest:{version:'v2.4.0',publishedAt:iso,releaseUrl:'https://github.com/DahanItamar/DockNest/releases/latest',minUpgradeFrom:null}},updater:{present:true,version:'1.4',supported:true,selfUpdateFailed:false,blocked:false,status:'connected',lastHeartbeatAt:iso,installMode:'source'},offer:{update:{version:'v2.4.0',releaseUrl:'https://github.com/DahanItamar/DockNest/releases/latest'},cli:null,blocked:null},active:null};
const meta={version:'v2.4.0',publishedAt:iso,releaseUrl:'https://github.com/DahanItamar/DockNest/releases/latest',highlights:{security:false,features:2,improvements:4},highlightsVerified:true,compatibility:{minimumMet:true,updatesDatabase:'yes',fromSchema:5,toSchema:5},downtime:{seconds:240,basis:'last-run'},pauses:['Backups and restores'],notesMarkdown:'# Release notes\n\n## New features\n- Problem reports without personal data.\n- Clearer failure explanations.\n\n## Improvements\n- Faster job list.\n',notesSource:'verified'};
async function open({width=1440,height=1000,scale=2,theme='light',fx=null}={}){
 const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:scale,reducedMotion:'reduce',colorScheme:theme});
 await context.addInitScript(t=>{try{localStorage.setItem('docknest-theme',t)}catch{}},theme);
 await context.route('**/api/**',route=>{
  const path=new URL(route.request().url()).pathname;
  const own=fx?.route?.(path,route.request().method());
  const json=own!==undefined?own:path==='/api/auth/status'?{authenticated:true,setupRequired:false,csrfToken:'demo-fixture',user:{id:'demo-admin',name:'Administrator',role:'admin'},serverTime:now,idleExpiresAt:now+1800000,absoluteExpiresAt:now+28800000}
  :path==='/api/state'?{...(fx?.state||state),update:{available:'v2.4.0'}}:path==='/api/updates'?updates:path==='/api/version'?{version:'2.3.0',schemaVersion:5}
  :path.startsWith('/api/updates/releases/')?meta:path==='/api/updates/history'?{items:[{id:'r1',version:'v2.3.0',at:time(200),outcome:'succeeded',source:'in-app'},{id:null,version:'v2.2.0',at:time(900),outcome:'succeeded',source:'cli'}],next:null}
  :path==='/api/updates/progress'?{active:false,phase:null,to:null,state:null,stale:false,updatedAt:null,events:[]}:path==='/api/updates/whats-new'?{show:false}:{};
  return route.fulfill({json});
 });
 const page=await context.newPage();
 await page.goto(base);
 await page.locator('.dash-metrics').waitFor();await page.evaluate(()=>document.fonts.ready);
 return {context,page};
}
// Hero animation and social preview: a separate fictional fleet (no real names, no placeholder domains).
// README_ONLY=hero renders just these. Needs ffmpeg for the GIF. SOCIAL_OUT=<file.png> also writes the 1280x640 social preview.
const fleet={
 servers:[
  {id:'fx-fra',name:'Frankfurt-1',note:'',host:'192.0.2.11',username:'root',port:22,hostKey:'ab'.repeat(32),status:'connected',capabilities:{freeBytes:212*1024**3}},
  {id:'fx-ash',name:'Ashburn-1',note:'',host:'192.0.2.12',username:'root',port:22,hostKey:'cd'.repeat(32),status:'connected',capabilities:{freeBytes:388*1024**3}},
  {id:'fx-nas',name:'Home NAS',note:'',host:'192.0.2.13',username:'root',port:22,hostKey:'ef'.repeat(32),status:'connected',capabilities:{freeBytes:1624*1024**3}}],
 sites:[['cinderbean.com','fx-fra',true],['pawmeadow.com','fx-fra',true],['northgrid.com','fx-ash',true],['brightsmile.com','fx-ash',true],['pagehouse.com','fx-nas',true]]
  .map(([name,serverId,docker],i)=>({id:'fx-site-'+i,name,serverId,config:docker?{kind:'docker',containers:[name.split('.')[0]+'-web',name.split('.')[0]+'-db'],domains:[name,'www.'+name]}:{kind:'static',containers:[],documentRoot:'/var/www/'+name,domains:[name]}}))
};
fleet.backups=fleet.sites.flatMap((site,i)=>Array.from({length:6},(_,k)=>({id:'fx-b-'+i+'-'+k,siteId:site.id,createdAt:time(k*24+i+2),capturedAt:time(k*24+i+2),verified:true,size:(180+i*70)*1024**2,pinned:false,downtimeMs:2400})));
fleet.state={servers:fleet.servers,sites:fleet.sites,backups:fleet.backups,jobs:[],restores:[],policies:fleet.sites.map(site=>({siteId:site.id,enabled:true,schedule:'0 2 * * *',timezone:'UTC',retention:7})),audit:[],storage:{used:61*1024**3,total:512*1024**3},worker:{running:true,online:true,lastSeen:iso}};
const fleetRoute=(route,method)=>route==='/api/storage-targets'?{activeTargetId:'fx-store',targets:[{id:'fx-store',name:'Offsite storage',kind:'sftp',capacity_bytes:2*1024**4,trackedBytes:61*1024**3}]}
 :route==='/api/moves'&&method==='POST'?{id:'fx-move',ok:true,verdict:'ok',estimateSeconds:540,downtimeSeconds:95,undoDays:7,warnings:[],checks:[],advanced:{ports:[{from:'8080',to:'8080',changed:false}],nginx:{file:'/etc/nginx/sites-enabled/pawmeadow.com.conf'}},mailBlocked:true,preflightHash:'fixture'}
 :route==='/api/moves'?{moves:[]}:route==='/api/alerts'?{channels:[],rules:[],credentials:[]}:undefined;
async function social(file){
 const {context,page}=await open({width:1280,height:1000,scale:2,fx:{state:fleet.state,route:fleetRoute}});
 try{
  await go(page,'Map');await page.locator('.map-site').first().waitFor();
  await page.getByRole('button',{name:'Fit to screen'}).click();await settle(page);
  const center=async selector=>{const b=await page.locator(selector).first().boundingBox();return {x:b.x+b.width/2,y:b.y+b.height/2}};
  const from=await center('[data-port-site="'+fleet.sites[1].id+'"]'),to=await center('[data-node="server:fx-ash"]');
  await page.mouse.move(from.x,from.y);await page.mouse.down();
  for(let i=1;i<=10;i++){await page.mouse.move(from.x+(to.x-from.x)*i/10,from.y+(to.y-from.y)*i/10);await settle(page)}
  await page.mouse.up();await page.mouse.move(640,990);await settle(page);
  const map=(await page.locator('.map-viewport').screenshot({animations:'disabled'})).toString('base64');
  const logo=(await readFile('docs/media/logo-blue.png')).toString('base64');
  const card=await context.newPage();await card.setViewportSize({width:1280,height:640});
  await card.setContent('<style>*{box-sizing:border-box;margin:0}body{width:1280px;height:640px;background:#f3f1fb;font-family:Inter,Segoe UI,Arial,sans-serif;color:#1d1b2e;display:flex;align-items:center;padding:0 56px;gap:48px}.t{width:420px}.t img{width:260px;display:block;margin-bottom:36px}h1{font-size:38px;line-height:1.18;font-weight:700;letter-spacing:-.01em}p{margin-top:20px;font-size:21px;line-height:1.4;color:#4b4866}.m{flex:1;border-radius:16px;overflow:hidden;box-shadow:0 18px 50px rgba(60,40,120,.18);border:1px solid #ddd8f0;background:#fff}.m img{width:100%;height:auto;display:block}</style><div class="t"><img src="data:image/png;base64,'+logo+'"><h1>Self-hosted Docker backup and restore with a visual server map.</h1><p>Move sites between servers safely.</p></div><div class="m"><img src="data:image/png;base64,'+map+'"></div>');
  await card.screenshot({path:file,scale:'css'});
 }finally{await context.close()}
}
// Story GIF: dashboard, a backup job with live progress, a verified recovery point, then a Map move. Each scene is its own page, so the cuts are clean.
const fleetJobs=(running,fraction)=>{
 const site=fleet.sites[0],id=running?'fx-job-live':'fx-job-done',total=1024**3;
 const steps=[['docker inspect',900],['docker stop',2100],['docker commit',5200],['docker save',14000],['tar volumes',22000],['pg_dump',6400],['docker start',1800]];
 const shown=running?Math.max(2,Math.round(steps.length*fraction)):steps.length;
 const live={id,siteId:site.id,type:'backup',status:running?'running':'completed',stage:running?'transferring':'completed',createdAt:time(0.1),startedAt:time(0.1),...(running?{}:{finishedAt:time(0.02)}),details:{transfer:{done:running?Math.round(total*fraction):total,total,startedAt:time(0.05),updatedAt:iso},diagnostics:steps.slice(0,shown).map(([c,ms],i)=>diag(c,400-i*40,ms))}};
 const past=fleet.sites.slice(1).map((st,i)=>({id:'fx-job-'+i,siteId:st.id,type:'backup',status:'completed',stage:'completed',createdAt:time(i*5+3),startedAt:time(i*5+3),finishedAt:time(i*5+2.95)}));
 return [live,...past];
};
async function hero(){
 const out='docs/media',dir=await (async()=>{const d=nodePath.join(tmpdir(),'docknest-hero-'+process.pid);await mkdir(d,{recursive:true});return d})();
 const list=[];let n=0;
 const still=(page,name)=>page.screenshot({path:out+'/'+name,animations:'disabled'});
 const snap=async(page,hold)=>{hold=hold>0.2?hold*0.75:hold;const f=nodePath.join(dir,'f'+String(n++).padStart(4,'0')+'.png');await page.screenshot({path:f,animations:'disabled'});list.push([f,hold])};
 const scene=async(opts,fn)=>{const {context,page}=await open({width:1280,height:860,scale:1,...opts});try{await fn(page)}finally{await context.close()}};
 const jobsScene=(running,fraction,hold,still_)=>scene({fx:{state:{...fleet.state,jobs:fleetJobs(running,fraction)},route:fleetRoute}},async page=>{
  await go(page,'Jobs');await settle(page);
  await page.locator('tr',{hasText:'cinderbean.com'}).first().getByRole('button',{name:'View job'}).click();
  await page.getByRole('dialog').waitFor();await settle(page);await snap(page,hold);if(still_)await still(page,still_);
 });
 try{
  await scene({fx:{state:{...fleet.state,jobs:fleetJobs(false,1)},route:fleetRoute}},async page=>{await settle(page);await snap(page,2.6)});
  await jobsScene(true,0.3,1.3);await jobsScene(true,0.62,1.3,'why-capture.png');await jobsScene(true,0.92,1.3);await jobsScene(false,1,2.2);
  await scene({fx:{state:{...fleet.state,jobs:fleetJobs(false,1)},route:fleetRoute}},async page=>{
   await go(page,'Backups');await page.locator('.backup-group').first().waitFor();await settle(page);await snap(page,2.8);await still(page,'why-verified.png');
  });
  const moving=fleet.sites[0],mv={state:'running',progress:5,statusLine:'Backing up '+moving.name+'.',actions:{cancel:true},sourceName:'Frankfurt-1',steps:[]};
  const stepList=done=>[['Back up the site','Test a copy on Ashburn-1','Wait for your DNS change','Switch to Ashburn-1'].map((label,i)=>({step:'s'+i,label,state:i<done?'done':i===done?'running':'pending'}))][0];
  const route=(path,method)=>path==='/api/moves/fx-move/start'?{ok:true}:path==='/api/moves/fx-move'&&method==='GET'?{id:'fx-move',...mv}:fleetRoute(path,method);
  await scene({height:860,fx:{state:{...fleet.state,jobs:fleetJobs(false,1)},route}},async page=>{
   await go(page,'Map');await page.locator('.map-site').first().waitFor();
   await page.getByRole('button',{name:'Fit to screen'}).click();await settle(page);
   assert.equal(await page.locator('.map-site').count(),fleet.sites.length);
   const center=async selector=>{const b=await page.locator(selector).first().boundingBox();return {x:b.x+b.width/2,y:b.y+b.height/2}};
   await page.mouse.move(640,360);await snap(page,0.8);
   const port=await center('[data-port-site="'+moving.id+'"]'),target=await center('[data-node="server:fx-ash"]');
   await page.mouse.move(port.x,port.y);await page.mouse.down();
   const steps=14;
   for(let i=1;i<=steps;i++){const k=i/steps,e=k*k*(3-2*k);await page.mouse.move(port.x+(target.x-port.x)*e,port.y+(target.y-port.y)*e);await settle(page);await snap(page,i===steps?0.5:0.07)}
   await page.mouse.up();await settle(page);
   await page.getByText(/will move to/).first().waitFor();await page.mouse.move(640,840);await snap(page,1.2);await still(page,'why-map.png');
   await page.getByRole('button',{name:'Save changes'}).click();await page.getByRole('dialog').waitFor();await settle(page);await snap(page,2);
   await page.getByRole('button',{name:'Move',exact:true}).click();
   mv.steps=stepList(0);await page.getByText('Backing up '+moving.name).waitFor();await settle(page);await snap(page,1.2);
   Object.assign(mv,{progress:55,statusLine:'Testing a copy on Ashburn-1.',steps:stepList(1)});await page.getByText('Testing a copy on Ashburn-1.').waitFor({timeout:6000});await settle(page);await snap(page,1.2);
   Object.assign(mv,{state:'done',progress:100,actions:{switchBack:true},dns:{type:'A',name:moving.name,value:'192.0.2.12'},steps:stepList(4)});
   await page.getByText('All done.').waitFor({timeout:6000});await settle(page);await snap(page,2.8);
  });
  const q=f=>f.split(nodePath.sep).join('/'),nl=String.fromCharCode(10);
  await writeFile(nodePath.join(dir,'list.txt'),list.map(([f,d])=>"file '"+q(f)+"'"+nl+'duration '+d).join(nl)+nl+"file '"+q(list.at(-1)[0])+"'"+nl);
  const ff=spawnSync('ffmpeg',['-y','-v','error','-f','concat','-safe','0','-i',nodePath.join(dir,'list.txt'),'-vf','fps=12,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5','-loop','0',out+'/map-move.gif'],{encoding:'utf8'});
  if(ff.status!==0)throw new Error('ffmpeg failed: '+ff.stderr);
 }finally{await rm(dir,{recursive:true,force:true});}
}
const settle=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const go=(page,name)=>page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name,exact:true}).click();
const shot=(page,file)=>page.screenshot({path:'docs/media/'+file,animations:'disabled'});
try{
 await mkdir('docs/media',{recursive:true});
 if(process.env.README_ONLY==='hero'){await hero();if(process.env.SOCIAL_OUT)await social(process.env.SOCIAL_OUT);console.log('Hero animation captured with fictional data only.');await browser.close();process.exit(0)}
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
 await page.getByRole('button',{name:'Fit to screen'}).click();await settle(page);
 assert.equal(await page.locator('.map-site').count(),sites.length);await shot(page,'map.png');
 await context.close();
 ({context,page}=await open({height:1100}));
 await page.getByRole('navigation').getByRole('button',{name:/Update Center/}).click();
 await page.getByRole('heading',{name:'Update Center',level:1}).waitFor();await settle(page);await shot(page,'update-center.png');
 await context.close();
 ({context,page}=await open({theme:'dark'}));await settle(page);await shot(page,'dashboard-dark.png');await context.close();
 ({context,page}=await open({width:402,height:874,scale:2}));await settle(page);await shot(page,'dashboard-mobile.png');await context.close();
 console.log('Documentation screenshots captured with synthetic data only.');
}finally{await browser.close();}
