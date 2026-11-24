import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

// Podman and rootless engines in the UI (docs/podman-rootless.md) against the mocked API: Discover & add an app grouped by
// engine (with the "One app, one engine" refusal), the engine badge on apps, the restore-test refusal reason, the engines of
// a Podman-only server, desktop and phone, both themes. Run against a dev server serving this worktree:
// TEST_BASE_URL=http://127.0.0.1:5311 (npm run dev:web). SHOTS_DIR also writes screenshots.
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5173',origin=new URL(base).origin,shots=process.env.SHOTS_DIR;
if(shots)await mkdir(shots,{recursive:true});
const NOW=Date.now();
const notes={engine:'podman',rootless:true,user:'svc',uid:1002};
const appUser={engine:'docker',rootless:true,user:'app',uid:1001};
const servers=[
 {id:'s1',name:'Server 1',host:'one.example.invalid',port:22,username:'root',status:'connected',hostKey:'SHA256:fixture',note:'',capabilities:{docker:'28.0.1',architecture:'x86_64',freeBytes:50*1024**3,engines:[
  {engine:'docker',rootless:false,version:'28.0.1',cgroupDelegated:true},{...appUser,version:'28.0.1',cgroupDelegated:true},{...notes,version:'5.2.1',cgroupDelegated:true}]}},
 {id:'s2',name:'Server 2',host:'two.example.invalid',port:22,username:'root',status:'connected',hostKey:'SHA256:fixture',note:'',capabilities:{docker:'28.0.1',architecture:'x86_64',freeBytes:50*1024**3,engines:[
  {engine:'docker',rootless:false,version:'28.0.1',cgroupDelegated:true},{...notes,version:'5.2.1',cgroupDelegated:false}]}},
 {id:'s3',name:'Podman box',host:'three.example.invalid',port:22,username:'root',status:'connected',hostKey:'SHA256:fixture',note:'',capabilities:{docker:null,architecture:'x86_64',freeBytes:50*1024**3,engines:[
  {engine:'podman',rootless:false,version:'5.2.1',cgroupDelegated:true}]}}
];
const sites=[
 {id:'a1',name:'Blog',serverId:'s1',config:{containers:['blog-web'],domains:[]}},
 {id:'a2',name:'Notes',serverId:'s1',config:{containers:['notes-app'],runtime:notes,domains:[]}}
];
const c=(name,project,service,runtime)=>({id:name.padEnd(12,'0'),name,image:'registry.example.invalid/'+service+':1',state:'running',running:true,labels:project?{'com.docker.compose.project':project,'com.docker.compose.service':service}:{},mounts:[],ports:{},...(runtime?{runtime}:{runtime:{engine:'docker',rootless:false}})});
const discovered={containers:[c('shop-web','shop','web'),c('shop-db','shop','db',notes),c('fresh-web','fresh','web'),c('notes2-app','notes2','app',appUser),c('queue-svc','queue','svc',notes),c('queue-db','queue','db',notes)],staticSites:[]};
const policies=sites.map(site=>({siteId:site.id,enabled:true,schedule:'0 2 * * *',timezone:'UTC',retention:7}));
const state=()=>({servers,sites,jobs:[],backups:[],policies,audit:[],storage:{used:1e9,total:1e12},worker:{online:true}});
const json=(route,body,status=200)=>route.fulfill({status,json:body});
let browser;const errors=[];

async function open({width=1280,height=800,scheme='light'}={}){
 const context=await browser.newContext({viewport:{width,height},colorScheme:scheme});
 await context.addInitScript(s=>{try{localStorage.setItem('docknest-theme',s)}catch{}},scheme);
 const page=await context.newPage(),offOrigin=[];
 page.on('pageerror',e=>errors.push(e.message));
 context.on('request',req=>{const u=new URL(req.url());if(!['data:','blob:'].includes(u.protocol)&&u.origin!==origin)offOrigin.push(u.href)});
 await page.route('**/api/**',route=>{
  const req=route.request(),endpoint=new URL(req.url()).pathname,method=req.method();
  const auth={authenticated:true,setupRequired:false,csrfToken:'fixture',user:{id:'u1',name:'Fixture user',role:'admin'},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000};
  let m;
  if((m=endpoint.match(/^\/api\/servers\/([^/]+)\/discover$/)))return json(route,discovered);
  if((m=endpoint.match(/^\/api\/sites\/([^/]+)\/restore-tests$/)))return json(route,{settings:{enabled:true,cadence:'weekly',serverId:'s2',allowLiveServer:false,allowInternet:false,timeLimitMinutes:30,memoryMb:1024,cpus:1,probe:null,nextDueAt:null,skipReason:null},last:null,active:null,items:[],next:null});
  if((m=endpoint.match(/^\/api\/sites\/([^/]+)\/self-heal$/)))return json(route,{enabled:false,maxRestarts:3,windowMinutes:60,watched:[],stream:null,items:[],nextCursor:null,canEdit:true});
  return json(route,endpoint==='/api/auth/status'?auth:endpoint==='/api/state'?state():endpoint==='/api/version'?{version:'0.0.0'}:endpoint==='/api/updates/progress'?{active:false,state:'idle'}:{});
 });
 await page.goto(base+'/');
 await page.locator('.berry-sidebar').waitFor();
 if(width<900)await page.getByRole('button',{name:'Open navigation'}).click();
 return {context,page,offOrigin};
}
const go=async(page,name,width)=>{await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name,exact:true}).click();};
const noOverflow=async(page,label)=>{const o=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}));assert.ok(o.sw<=o.cw,label+': horizontal overflow '+o.sw+' > '+o.cw)};
const shot=async(page,name)=>{if(shots){await page.waitForTimeout(600);await page.screenshot({path:path.join(shots,name+'.png')})}};
const noEmoji=async(page,label)=>{const text=await page.locator('body').innerText();assert.ok(!/\p{Extended_Pictographic}/u.test(text),label+': an emoji reached the page')};

async function discover(scheme,width){
 const {context,page,offOrigin}=await open({scheme,width});
 await go(page,'Apps & Schedules',width);
 await page.getByRole('button',{name:/Add app/}).first().click();
 const d=page.getByRole('dialog');
 await d.getByRole('heading',{name:'Discover & add an app'}).waitFor();
 await d.getByRole('combobox',{name:/Source server/}).selectOption('s1');
 await d.locator('.application-group').first().waitFor();
 // Headings name the engine; rootful Docker comes first.
 const headings=await d.locator('h3.engine-heading').allInnerTexts();
 assert.equal(headings[0],'Docker');
 // A Compose project split over two engines is refused in words, and cannot be selected.
 const shop=d.getByRole('region',{name:'shop'});
 await shop.getByText('One app, one engine').waitFor();
 await shop.getByText("shop's containers run in two engines. Make two apps.").waitFor();
 assert.equal(await shop.getByRole('button',{name:'Select app shop'}).isDisabled(),true);
 await shot(page,`P1-engines-discover-${width}-${scheme}`);
 await d.getByRole('textbox',{name:/Find an app/}).fill('queue');
 // Another engine is named on its card; selecting it keeps its engine for the saved app.
 const queue=d.getByRole('region',{name:'queue'});
 await queue.getByText('Podman rootless, user svc').first().waitFor();
 await queue.getByRole('button',{name:'Select app queue'}).click();
 await d.getByText('2 services included: queue-svc, queue-db').waitFor();
 await shot(page,`P1b-engine-selected-${width}-${scheme}`);
 await noOverflow(page,'discover '+width);await noEmoji(page,'discover');
 assert.deepEqual(offOrigin,[]);
 await context.close();
}

async function apps(scheme,width){
 const {context,page}=await open({scheme,width});
 await go(page,'Apps & Schedules',width);
 const card=page.locator('.site-card',{hasText:'Notes'});
 await card.getByText('Podman rootless, user svc').waitFor();
 await card.getByText('Self-heal, Safe Edit and moves are not available for this engine yet.').waitFor();
 assert.equal(await page.locator('.site-card',{hasText:'Blog'}).getByText('Podman').count(),0,'a rootful Docker app shows no engine row');
 await shot(page,`P3-apps-badge-${width}-${scheme}`);
 await noOverflow(page,'apps '+width);await noEmoji(page,'apps');
 await context.close();
}

async function refusal(scheme,width){
 const {context,page}=await open({scheme,width});
 await go(page,'Apps & Schedules',width);
 const card=page.locator('.site-card',{hasText:'Notes'});
 await card.getByRole('button',{name:/^More actions for /}).first().click();
 await page.getByRole('menuitem',{name:'Restore tests'}).click();
 const d=page.getByRole('dialog');
 await d.getByRole('heading',{name:'Restore tests'}).waitFor();
 await d.getByText('Server 2 cannot test Notes').waitFor();
 await d.getByText(/cannot limit memory for user apps, so DockNest will not test there/).first().waitFor();
 await d.getByText('Podman rootless, user svc').first().waitFor();
 assert.equal(await d.getByRole('button',{name:'Run test'}).isDisabled(),true,'Run test is refused, not offered');
 // Another server that does run the engine, with delegation, clears the reason.
 await d.getByRole('combobox',{name:'Test server'}).selectOption('s1');
 assert.equal(await d.getByText('cannot test Notes').count(),0);
 await d.getByRole('combobox',{name:'Test server'}).selectOption('s2');
 await shot(page,`P2-runtime-refusal-${width}-${scheme}`);
 await noOverflow(page,'refusal '+width);await noEmoji(page,'refusal');
 await context.close();
}

async function podmanOnly(scheme,width){
 const {context,page}=await open({scheme,width});
 await go(page,'Servers',width);
 const card=page.locator('.card',{hasText:'Podman box'});
 await card.getByText('Podman',{exact:true}).first().waitFor();
 await card.getByText('No Docker daemon on this server.').waitFor();
 await shot(page,`P4-podman-only-server-${width}-${scheme}`);
 await noOverflow(page,'servers '+width);await noEmoji(page,'servers');
 await context.close();
}

browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{});
try{
 for(const scheme of ['light','dark'])for(const width of [1280,390]){await discover(scheme,width);await apps(scheme,width);await refusal(scheme,width);await podmanOnly(scheme,width);}
}finally{await browser.close();}
assert.deepEqual(errors,[],'page errors: '+errors.join(' | '));
console.log('Podman UI checks passed.');
