import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {providerList} from '../src/alerts/providers/index.js';

// Administration, Connections against a mocked API that behaves like the real one (docs/alert-channels.md, "API"):
// write-only secrets (`<key>Set` flags), REAUTH_REQUIRED on Connection writes, 409 CONNECTION_IN_USE, the operator
// setting, and one fixed sentence for a failed operator test. Fictional names, tokens and addresses only.
// Run against a server that serves the built app: TEST_BASE_URL=http://127.0.0.1:3000. SHOTS_DIR also writes pictures.
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5173',origin=new URL(base).origin,shots=process.env.SHOTS_DIR;
if(shots)await mkdir(shots,{recursive:true});
const providers=providerList(),errors=[];
const now=Date.now(),ago=ms=>new Date(now-ms).toISOString();
const RTL='התראות צוות לילה';
const LONG='Night shift on-call rotation for the very long named European datacenter cluster 07';
const state={servers:[{id:'fr',name:'Frankfurt-1',host:'fra.example.invalid',port:22,username:'root',status:'connected'}],sites:[{id:'s1',name:'cinderbean.com',serverId:'fr',config:{containers:[1,2]}}],jobs:[{id:'job-0001-aaaa',siteId:'s1',type:'backup',status:'failed',stage:'capture',createdAt:ago(36e5),details:{}}],backups:[],policies:[],audit:[],storage:{used:0,total:1e12},worker:{online:true},alertsAccess:true};
const db={};
function seed(kind='normal'){
 Object.assign(db,{connections:[],seq:1,needReauth:false,testError:null,calls:[],settings:{allowPrivateNetwork:false,operatorsManage:true},legacyChanged:false,role:'admin',access:true});
 if(kind==='empty')return;
 const c=(provider,name,values,extra={})=>db.connections.push({id:'c'+(db.seq++),provider,name,values,secretReadable:true,usedBy:[],createdAt:ago(9e8),updatedAt:ago(9e8),lastTest:null,lastTestAt:null,lastSend:null,lastSendAt:null,testError:null,sendError:null,editable:true,...extra});
 if(kind==='many'){for(let i=0;i<55;i++)c('telegram',`Ops bot ${String(i+1).padStart(2,'0')}`,{tokenSet:true,chatId:'-100'+i});return}
 c('whatsapp','My WhatsApp',{tokenSet:true,phoneNumberId:'104829371650',to:'15550142',template:'docknest_alert',language:'en'},{usedBy:[{id:'n1',name:'Ops WhatsApp'},{id:'n2',name:'Weekend alerts'}],lastTest:'ok',lastTestAt:ago(12e4)});
 c('discord','Team Discord',{urlSet:true},{usedBy:[{id:'n3',name:'Team Discord'}],lastTest:'ok',lastTestAt:ago(36e5)});
 c('ntfy','Phone alerts',{server:'https://ntfy.sh',topic:'docknest-cinderbean-7f3k',tokenSet:false},{usedBy:[{id:'n4',name:'Night alerts'}],lastTest:'failed',lastTestAt:ago(864e5),testError:'ntfy refused the message.',lastSend:'failed',lastSendAt:ago(8e7),sendError:'ntfy does not accept this token, or the topic is protected.'});
 c('telegram','Ops bot',{tokenSet:true,chatId:'-1001234567890'},{usedBy:[{id:'n5',name:'Ops Telegram'}],lastTest:'ok',lastTestAt:ago(3*864e5)});
 c('email','Mail account',{host:'smtp.fastmail.com',port:587,security:'starttls',username:'alerts@harborpaws.com',passwordSet:true,from:'alerts@harborpaws.com',to:['ops@harborpaws.com'],subjectPrefix:'[DockNest]'},{usedBy:[{id:'n6',name:'Email alerts'}],lastTest:'ok',lastTestAt:ago(5*864e5)});
 c('slack','Old Slack',{urlSet:true});
 c('webhook','Home automation hook',{urlSet:true,headerSet:true},{usedBy:[{id:'n7',name:'Home hook'}]});
 c('telegram',LONG,{tokenSet:true,chatId:'-1009'},{usedBy:Array.from({length:24},(_,i)=>({id:'u'+i,name:'Node '+(i+1)}))});
 c('telegram',RTL,{tokenSet:true},{});
}
const view=x=>({...x,editable:db.role==='admin'||x.provider!=='webhook'});
const secretKeys=id=>providers.find(p=>p.id===id).fields.filter(f=>f.secret).map(f=>f.key);
function api(req,endpoint){
 const parts=endpoint.split('/').filter(Boolean).slice(2),m=req.method(),body=req.postDataJSON?.()||{};
 const ok=json=>({json}),err=(status,error,extra={})=>({status,json:{error,...extra}});
 if(!db.access&&db.role!=='admin')return err(403,'Alerts are managed by an administrator.',{code:'ALERTS_ADMIN_REQUIRED'});
 if(parts[0]==='providers')return ok({providers});
 if(parts[0]==='settings'){if(db.role!=='admin')return err(403,'Administrator access required.',{code:'ADMIN_REQUIRED'});if(db.needReauth)return err(403,'Verify your own authenticator or recovery code before this change.',{code:'REAUTH_REQUIRED'});db.calls.push(['settings',JSON.stringify(body)]);Object.assign(db.settings,body);return ok({settings:db.settings})}
 if(!parts.length&&m==='GET')return ok({connections:db.connections.map(view),settings:db.settings,legacyChanged:db.legacyChanged,limits:{connections:60,nodes:40,lines:200},role:db.role});
 const test=c=>{db.calls.push(['test',c?.id||'unsaved',JSON.stringify(body)]);if(db.testError){if(c){c.lastTest='failed';c.lastTestAt=new Date().toISOString();c.testError=db.testError}return err(502,db.role==='admin'?db.testError:'DockNest could not deliver to this address.',{code:'TEST_FAILED'})}if(c){c.lastTest='ok';c.lastTestAt=new Date().toISOString()}const p=providers.find(x=>x.id===(c?.provider||body.provider));return ok({ok:true,delivered:!p?.testNote,...(p?.testNote?{note:p.testNote}:{})})};
 if(parts[0]==='test')return test(body.connectionId?db.connections.find(x=>x.id===body.connectionId)&&null:null);
 if(!parts.length&&m==='POST'){
  if(db.needReauth)return err(403,'Verify your own authenticator or recovery code before this change.',{code:'REAUTH_REQUIRED'});
  if(body.provider==='telegram'&&!/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(body.values?.token||''))return err(400,'Paste the bot token exactly as BotFather shows it.',{field:'token'});
  db.calls.push(['create',JSON.stringify(body)]);
  const values={};for(const [k,v] of Object.entries(body.values||{}))if(secretKeys(body.provider).includes(k))values[k+'Set']=!!v;else values[k]=v;
  const c={id:'c'+(db.seq++),provider:body.provider,name:body.name,values,secretReadable:true,usedBy:[],lastTest:null,editable:true};db.connections.push(c);return {status:201,json:view(c)};
 }
 const c=db.connections.find(x=>x.id===parts[0]);if(!c)return err(404,'This connection does not exist.');
 if(parts[1]==='test')return test(c);
 if(m==='PATCH'){
  const sensitive=Object.keys(body.values||{}).length>0;
  if(sensitive&&db.needReauth)return err(403,'Verify your own authenticator or recovery code before this change.',{code:'REAUTH_REQUIRED'});
  db.calls.push(['update',JSON.stringify(body)]);if(body.name)c.name=body.name;for(const [k,v] of Object.entries(body.values||{}))if(secretKeys(c.provider).includes(k))c.values[k+'Set']=!!v;else c.values[k]=v;return ok(view(c));
 }
 if(m==='DELETE'){if(c.usedBy.length)return err(409,`This connection is used by ${c.usedBy.map(n=>`"${n.name}"`).join(', ')}.`,{code:'CONNECTION_IN_USE',nodes:c.usedBy.map(n=>n.name)});if(db.needReauth)return err(403,'Verify your own authenticator or recovery code before this change.',{code:'REAUTH_REQUIRED'});db.calls.push(['delete',c.id]);db.connections=db.connections.filter(x=>x!==c);return ok({deleted:true})}
 return err(404,'Not found.');
}
let browser;
async function open({role='admin',width=1440,height=900,scheme='light',kind='normal',path:at='/',nav=true}={}){
 seed(kind);db.role=role;
 const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',colorScheme:scheme});
 await context.addInitScript(s=>{try{localStorage.setItem('docknest-theme',s)}catch{}},scheme);
 const page=await context.newPage(),offOrigin=[];
 page.on('pageerror',e=>errors.push(e.message));
 context.on('request',req=>{const u=new URL(req.url());if(!['data:','blob:'].includes(u.protocol)&&u.origin!==origin)offOrigin.push(u.href)});
 await page.route('**/api/**',async route=>{
  const req=route.request(),endpoint=new URL(req.url()).pathname;
  const auth={authenticated:true,setupRequired:false,csrfToken:'fixture',user:{id:'u1',name:'Fixture user',role},serverTime:Date.now(),idleExpiresAt:Date.now()+1800000,absoluteExpiresAt:Date.now()+28800000};
  if(endpoint.startsWith('/api/connections')){if(db.hold&&endpoint==='/api/connections'&&req.method()==='GET')await db.hold;return route.fulfill(api(req,endpoint))}
  if(endpoint==='/api/auth/reauth'){const b=req.postDataJSON();if(b.password==='pw'&&b.code==='123456'){db.needReauth=false;return route.fulfill({json:{ok:true}})}return route.fulfill({status:401,json:{error:'No'}})}
  if(endpoint==='/api/updates/progress')return route.fulfill({json:{active:false,state:'idle'}});
  if(endpoint==='/api/jobs/job-0001-aaaa')return route.fulfill({json:state.jobs[0]});
  if(endpoint.startsWith('/api/jobs/'))return route.fulfill({status:404,json:{error:'Job not found.'}});
  return route.fulfill({json:endpoint==='/api/auth/status'?auth:endpoint==='/api/state'?{...state,alertsAccess:db.access||role==='admin'}:endpoint==='/api/version'?{version:'0.0.0'}:{}});
 });
 await page.goto(base+at);
 await page.locator('.berry-sidebar').waitFor();
 if(nav){if(width<900)await page.getByRole('button',{name:'Open navigation'}).click();await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Connections',exact:true}).click();await page.getByRole('heading',{level:1,name:'Connections'}).waitFor()}
 return {context,page,offOrigin};
}
const dialog=page=>page.locator('dialog.cx-dialog[open]');
async function fits(page,label){const o=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}));assert.ok(o.sw<=o.cw,label+': horizontal overflow '+o.sw+'>'+o.cw)}
async function shot(page,name){if(shots){await page.waitForTimeout(80);await page.screenshot({path:path.join(shots,name+'.png')})}}
async function pickProvider(d,label){await d.locator('.cx-combo').first().click();const pop=d.page().locator('.cx-pop');await pop.getByRole('searchbox').fill(label.slice(0,4));await pop.getByRole('option',{name:label,exact:true}).click();await pop.waitFor({state:'detached'})}
// Fictional values that pass each provider's own validation.
const FILL={
 telegram:{token:'123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_x',chatId:'-1001234567890'},
 email:{host:'smtp.fastmail.com',port:'587',username:'alerts@harborpaws.com',password:'fixture-pass',from:'alerts@harborpaws.com',to:'ops@harborpaws.com, dana@harborpaws.com'},
 whatsapp:{token:'EAAGfixtureWhatsAppToken0123456789',phoneNumberId:'104829371650',to:'+1 555 0142'},
 discord:{url:'https://discord.com/api/webhooks/123456789012345678/Fixture_Discord-Token_0123456789'},
 slack:{url:'https://hooks.slack.com/services/T0FIXTURE/B0FIXTURE/fixtureSlackToken0123'},
 teams:{url:'https://prod-01.westus.logic.azure.com/workflows/fixture/triggers/manual/paths/invoke?sig=fixture'},
 googlechat:{url:'https://chat.googleapis.com/v1/spaces/AAAAfixture/messages?key=fixtureKey&token=fixtureToken'},
 mattermost:{url:'https://chat.example.com/hooks/fixturehookid0123456789'},
 ntfy:{topic:'docknest-cinderbean-7f3k'},
 gotify:{server:'https://gotify.example.com',token:'AbCdEfGhIjKlMnO'},
 pushover:{token:'azGDORePK8gMaC0QOYAMyEEuzJnyUi',user:'uQiRzpo4DXghDmr9QzzfQu27cmVRsG'},
 matrix:{server:'https://matrix.example.org',room:'!fixtureRoom:example.org',token:'syt_fixture_matrix_token_0123'},
 webhook:{url:'https://hooks.example.net/docknest/fixture-0123'},
};
async function fill(d,provider){for(const [key,value] of Object.entries(FILL[provider]))await d.locator(`input[data-key="${key}"]`).fill(value)}

async function emptyAndList(scheme){
 {const {context,page}=await open({scheme,kind:'empty'});
  await page.getByRole('heading',{name:'No connections yet'}).waitFor();
  await page.getByText('A connection holds the login for one provider. Add one, then pick it on an alert node.').waitFor();
  await shot(page,`connections-empty-1440-${scheme}`);
  await page.locator('.empty').getByRole('button',{name:'New connection'}).click();
  await dialog(page).getByRole('heading',{name:'New connection'}).waitFor();
  assert.equal(await dialog(page).getByRole('button',{name:'Save'}).isDisabled(),true,'Save waits for a provider');
  await context.close();}
 const {context,page,offOrigin}=await open({scheme});
 const table=page.locator('table.data-table');await table.waitFor();
 assert.deepEqual(await table.locator('th').allTextContents(),['Name','Provider','Used by','Last test','Actions']);
 await page.getByRole('alert').filter({hasText:'Phone alerts failed'}).getByText('The last message did not reach ntfy.',{exact:false}).waitFor();
 const row=name=>table.locator('tr',{has:page.locator('b',{hasText:name})});
 await row('My WhatsApp').getByText('Accepted · 2 min ago').waitFor();
 await row('Team Discord').getByText('Delivered · 1 hour ago').waitFor();
 await row('Phone alerts').getByText('Failed · yesterday').waitFor();
 await row('Old Slack').getByText('Not used').waitFor();await row('Old Slack').getByText('Not tested').waitFor();
 await row(RTL).getByText('Add the chat ID').waitFor();
 // Straight columns: every cell of a column starts at the same x; the long name and the long "Used by" are cut, not wrapped
 const xs=await table.locator('tbody tr').evaluateAll(rows=>rows.map(r=>[...r.children].map(td=>Math.round(td.getBoundingClientRect().left))));
 for(const r of xs)assert.deepEqual(r,xs[0],'aligned columns');
 const heights=await table.locator('tbody tr').evaluateAll(rows=>rows.map(r=>Math.round(r.getBoundingClientRect().height)));
 assert.ok(heights.every(h=>h===heights[0]),'one row height: '+heights.join());
 assert.equal(await row(LONG).locator('b').getAttribute('title'),LONG);
 assert.ok(await row(LONG).locator('b').evaluate(e=>e.scrollWidth>e.clientWidth),'a long name is cut with an ellipsis');
 assert.equal(await row(RTL).locator('b').textContent(),RTL,'right-to-left name intact');
 // No icon boxes: provider icons have no background or border
 assert.ok(await table.locator('.cx-prov svg').first().evaluate(e=>{const s=getComputedStyle(e.parentElement);return s.borderStyle==='none'||s.borderWidth==='0px'}),'no icon border');
 await fits(page,'list '+scheme);
 await shot(page,`connections-1440-${scheme}`);
 // Send test from a row: success updates the row; every error class shows its own sentence
 await row('Team Discord').getByRole('button',{name:'Send test with Team Discord'}).click();
 await page.getByText('Team Discord: Delivered.').waitFor();await row('Team Discord').getByText('Delivered · just now').waitFor();
 for(const sentence of ['Discord does not accept this webhook. Create a new one and paste it again.','Discord could not find the destination. Check the address.','Discord refused the message.','Discord is not answering right now.','Discord could not be reached.','The server answered with a redirect. Paste the final URL.','Discord asked DockNest to slow down.']){
  db.testError=sentence;await row('Team Discord').getByRole('button',{name:'Send test with Team Discord'}).click();
  await page.getByRole('alert').getByText('Team Discord: '+sentence).waitFor();
 }
 db.testError=null;await row('Team Discord').getByText('Failed · just now').waitFor();
 // Delete while in use: the nodes are named and Delete stays off; an unused one goes after a re-verification
 await row('My WhatsApp').getByRole('button',{name:'Delete My WhatsApp'}).click();
 const del=page.locator('dialog.cx-confirm[open]');await del.getByText('Ops WhatsApp, Weekend alerts').waitFor();
 assert.equal(await del.getByRole('button',{name:'Delete'}).isDisabled(),true);
 await shot(page,`connections-delete-in-use-1440-${scheme}`);
 await del.getByRole('button',{name:'Cancel'}).click();await del.waitFor({state:'detached'});
 db.needReauth=true;await row('Old Slack').getByRole('button',{name:'Delete Old Slack'}).click();
 await del.getByRole('button',{name:'Delete'}).click();await del.getByText('Please confirm it is you').waitFor();
 await del.getByLabel('Password').fill('pw');await del.getByLabel('Authenticator code').fill('123456');await del.getByRole('button',{name:'Verify and continue'}).click();
 await page.getByText('Old Slack is deleted.').waitFor();assert.ok(db.calls.some(c=>c[0]==='delete'));
 // Settings: two slim switches, each asks for a re-verification
 const sw=page.getByRole('switch',{name:'Operators can manage alerts'});assert.equal(await sw.getAttribute('aria-checked'),'true');
 const box=await sw.evaluate(e=>{const s=getComputedStyle(e,'::before');return {w:s.width,h:s.height,r:s.borderRadius}});assert.deepEqual([box.w,box.h],['36px','20px'],'slim pill switch');
 db.needReauth=true;await sw.click();await page.locator('.cx-settings').getByText('Please confirm it is you').waitFor();
 await page.locator('.cx-settings').getByLabel('Password').fill('pw');await page.locator('.cx-settings').getByLabel('Authenticator code').fill('123456');await page.locator('.cx-settings').getByRole('button',{name:'Verify and continue'}).click();
 await page.waitForFunction(()=>document.querySelector('[role=switch][aria-labelledby="cx-operators"]').getAttribute('aria-checked')==='false');
 assert.ok(db.calls.some(c=>c[0]==='settings'&&c[1]==='{"operatorsManage":false}'));
 assert.deepEqual(offOrigin,[],'off-origin requests');
 await context.close();
}

async function everyProvider(scheme){
 const {context,page}=await open({scheme,kind:'empty'});
 for(const p of providers){
  await page.getByRole('button',{name:'New connection'}).first().click();
  const d=dialog(page);await d.waitFor();
  await pickProvider(d,p.label);
  for(const f of p.fields.filter(x=>!x.more&&!(p.id==='email'&&x.key==='password')))await d.getByText(f.label,{exact:true}).first().waitFor();
  assert.equal(await d.getByLabel('Name',{exact:true}).inputValue(),'My '+(p.id==='webhook'?'webhook':p.label),'a name follows the provider');
  if(p.fields.some(f=>f.required&&!f.default))await d.getByText('Add the missing details.').waitFor();
  await fill(d,p.id);
  if(p.fields.some(f=>f.more)){await d.getByText('More options').click();for(const f of p.fields.filter(x=>x.more))await d.getByText(f.label,{exact:true}).first().waitFor()}
  if(p.id==='whatsapp'){await d.getByText('Uses your own Meta WhatsApp Business account. Meta may charge for messages.').waitFor();await d.getByRole('link',{name:'How to get these'}).waitFor();await d.getByText('Create a Utility template named docknest_alert',{exact:false}).waitFor()}
  if(p.id==='webhook'){await d.getByText('For advanced users',{exact:true}).waitFor();await d.locator('pre.command-preview').getByText('"event": "backup.failed"',{exact:false}).waitFor()}
  if(p.id==='email')await d.getByText('Subject prefix').waitFor();
  assert.equal(await d.getByRole('button',{name:'Save'}).isDisabled(),false,p.id+': Save opens when every required field is filled');
  if(['whatsapp','discord','ntfy','webhook','email'].includes(p.id))await shot(page,`dialog-${p.id}-1440-${scheme}`);
  await d.getByRole('button',{name:'Send test'}).click();await d.getByText(p.testNote||'Delivered.').waitFor();
  await d.getByRole('button',{name:'Save'}).click();await d.waitFor({state:'detached'});
  const sent=JSON.parse(db.calls.filter(c=>c[0]==='create').at(-1)[1]);assert.equal(sent.provider,p.id);
  for(const [k,v] of Object.entries(FILL[p.id]))if(k!=='port'&&k!=='to')assert.equal(String(sent.values[k]),v,p.id+'.'+k);
 }
 assert.equal(db.connections.length,13);
 await context.close();
}

async function editAndReauth(scheme){
 const {context,page}=await open({scheme});
 await page.getByRole('button',{name:'Edit Ops bot'}).click();
 const d=dialog(page);await d.getByRole('heading',{name:'Edit connection'}).waitFor();
 assert.equal(await d.locator('.cx-combo').first().isDisabled(),true,'the provider is locked');
 await d.getByText('Saved, hidden').waitFor();assert.equal(await d.locator('input[type=password]').count(),0,'no secret field until replace');
 await shot(page,`dialog-edit-1440-${scheme}`);
 await d.getByRole('button',{name:'Replace bot token'}).click();
 await d.getByText('New bot token').waitFor();await d.getByText('The saved one is replaced when you save.').waitFor();await d.getByText('If this login leaked, also revoke it at the provider.').waitFor();
 await d.locator('input[data-key="token"]').fill('987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_y');
 db.needReauth=true;await d.getByRole('button',{name:'Save'}).click();
 await d.getByText('Please confirm it is you').waitFor();await d.getByLabel('Password').fill('nope');await d.getByLabel('Authenticator code').fill('000000');await d.getByRole('button',{name:'Verify and continue'}).click();
 await d.getByText('That password or code was not right. Try again.').waitFor();
 await d.getByLabel('Password').fill('pw');await d.getByLabel('Authenticator code').fill('123456');await d.getByRole('button',{name:'Verify and continue'}).click();
 await d.waitFor({state:'detached'});
 assert.deepEqual(JSON.parse(db.calls.find(c=>c[0]==='update')[1]),{values:{token:'987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_y'}},'only the replaced secret is sent');
 // Changing a server asks for the saved secret again (the API rule, shown before it refuses)
 await page.getByRole('button',{name:'Edit Mail account'}).click();await d.waitFor();
 await d.locator('input[data-key="host"]').fill('smtp.other.example');
 await d.getByText('Enter it again: it goes to the new mail server.').waitFor();assert.equal(await d.getByRole('button',{name:'Save'}).isDisabled(),true);
 await d.getByRole('button',{name:'Cancel'}).click();await d.waitFor({state:'detached'});
 // A server error names its field, which is marked and focused
 await page.getByRole('button',{name:'New connection'}).first().click();await d.waitFor();await pickProvider(d,'Telegram');
 await d.locator('input[data-key="token"]').fill('not-a-token');await d.locator('input[data-key="chatId"]').fill('-1001');
 await d.getByRole('button',{name:'Save'}).click();await d.getByText('Paste the bot token exactly as BotFather shows it.').waitFor();
 assert.equal(await d.locator('input[data-key="token"]').getAttribute('aria-invalid'),'true');
 await page.keyboard.press('Escape');await d.waitFor({state:'detached'});
 await context.close();
}

// The header's New connection is clickable before the list has loaded; that click must not be lost (it used to be, which made the keyboard test time out on a slow runner).
async function clickBeforeListLoads(){
 let release;const {context,page}=await open({kind:'empty',nav:false});
 db.hold=new Promise(r=>{release=r});
 await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Connections',exact:true}).click();
 await page.getByRole('button',{name:'New connection'}).first().click();
 await page.getByText('Loading connections…').waitFor();assert.equal(await dialog(page).count(),0,'nothing opens before the list is there');
 db.hold=null;release();
 await dialog(page).waitFor({timeout:5000});
 await page.keyboard.press('Escape');await dialog(page).waitFor({state:'detached'});
 await page.getByRole('heading',{name:'No connections yet'}).waitFor();assert.equal(await dialog(page).count(),0,'the dialog does not come back after a reload');
 await context.close();
}

async function keyboardOnly(){
 const {context,page}=await open({kind:'empty'});
 await page.getByRole('button',{name:'New connection'}).first().focus();await page.keyboard.press('Enter');
 const d=dialog(page);await d.waitFor();
 assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('cx-combo')),true,'focus starts on Provider');
 await page.keyboard.press('ArrowDown');await page.locator('.cx-pop').waitFor();
 assert.equal(await page.evaluate(()=>document.activeElement.type),'search','search has focus');
 // The list opens downward, below its button, and has no scrollbar unless it must
 const b=await d.locator('.cx-combo').first().boundingBox(),pop=await page.locator('.cx-pop').boundingBox();assert.ok(pop.y>=b.y+b.height,'opens downward');
 await page.keyboard.type('ntf');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
 await page.locator('.cx-pop').waitFor({state:'detached'});
 assert.ok(await page.waitForFunction(()=>document.activeElement?.classList.contains('cx-combo'),null,{timeout:2000}).then(()=>true,()=>false),'focus returns to the button');
 await page.keyboard.press('Tab');await page.keyboard.press('Tab');await page.keyboard.press('Tab');
 await page.keyboard.type('docknest-cinderbean-7f3k');
 assert.equal(await d.locator('input[data-key="topic"]').inputValue(),'docknest-cinderbean-7f3k','reached Topic by Tab');
 await d.getByRole('button',{name:'Save'}).focus();await page.keyboard.press('Enter');await d.waitFor({state:'detached'});
 assert.equal(JSON.parse(db.calls.find(c=>c[0]==='create')[1]).provider,'ntfy');
 await page.getByRole('button',{name:'New connection'}).first().click();await d.waitFor();await page.keyboard.press('Escape');await d.waitFor({state:'detached'});
 await context.close();
}

async function phone(scheme){
 const {context,page}=await open({scheme,width:390,height:844});
 await page.locator('table.mobile-table').waitFor();await fits(page,'phone list '+scheme);
 const cells=await page.locator('tbody tr').first().locator('td').evaluateAll(t=>t.map(td=>getComputedStyle(td,'::before').content));
 assert.deepEqual(cells,['"Name"','"Provider"','"Used by"','"Last test"','"Actions"'],'each value keeps its label on a phone');
 await shot(page,`connections-390-${scheme}`);
 await page.getByRole('button',{name:'New connection'}).first().click();const d=dialog(page);await d.waitFor();await pickProvider(d,'WhatsApp');
 const r=await d.boundingBox();assert.ok(Math.abs(r.y+r.height-844)<=1&&Math.abs(r.width-390)<=1,'a bottom sheet');
 for(const bt of await d.locator('.modal-foot button').all())assert.ok((await bt.boundingBox()).height>=44,'44 px buttons');
 await fits(page,'phone dialog');await shot(page,`dialog-whatsapp-390-${scheme}`);
 await context.close();
}

async function manyAndRoles(){
 {const {context,page}=await open({kind:'many'});
  await page.getByText('1-10 of 55').waitFor();await page.getByRole('button',{name:'Connections next page'}).click();await page.getByText('11-20 of 55').waitFor();
  assert.equal(await page.locator('tbody tr').count(),10);await context.close();}
 // An operator with the setting on: Other is shown, not editable; no settings; a failed test is one sentence
 {const {context,page}=await open({role:'operator'});
  assert.equal(await page.locator('.cx-settings').count(),0,'settings are for administrators');
  await page.getByRole('button',{name:'View Home automation hook'}).click();const d=dialog(page);
  await d.getByText('Only an administrator can change this connection.',{exact:false}).waitFor();assert.equal(await d.getByRole('button',{name:'Save'}).count(),0);
  await d.getByRole('button',{name:'Close',exact:true}).click();await d.waitFor({state:'detached'});
  db.testError='Telegram does not accept this bot token.';await page.getByRole('button',{name:'Send test with Ops bot'}).click();
  await page.getByText('Ops bot: DockNest could not deliver to this address.').waitFor();db.testError=null;
  // Losing permission mid-session: the next state hides the page; the API refuses
  db.access=false;await page.waitForFunction(()=>![...document.querySelectorAll('.berry-sidebar nav button')].some(b=>b.textContent==='Connections'),null,{timeout:12000});
  await page.getByText('Alerts are managed by an administrator').waitFor();
  await context.close();}
 // Legacy changes made in 2.9 after the upgrade
 {const {context,page}=await open({nav:false});db.legacyChanged=true;await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Connections',exact:true}).click();
  await page.getByText('Alert changes made in an older DockNest version are not shown here. Enter them again.').waitFor();await context.close();}
 // The job link in an alert opens that job after sign-in, then the address is plain again
 {const {context,page}=await open({nav:false,path:'/?job=job-0001-aaaa'});
  await page.locator('dialog.job-dialog[open]').waitFor();assert.equal(await page.evaluate(()=>location.search),'');
  await page.getByRole('heading',{level:1,name:'Job activity'}).waitFor();await context.close();}
 {const {context,page}=await open({nav:false,path:'/?job=job-gone-0000'});
  await page.getByText('This job is not in DockNest any more.',{exact:false}).waitFor();await context.close();}
}

try{
 browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
 for(const scheme of ['light','dark']){await emptyAndList(scheme);await phone(scheme)}
 await everyProvider('light');await everyProvider('dark');
 await editAndReauth('light');await editAndReauth('dark');
 await clickBeforeListLoads();await keyboardOnly();await manyAndRoles();
 assert.deepEqual(errors,[],'page errors');
 console.log('Connections browser checks passed');
}finally{await browser?.close()}
