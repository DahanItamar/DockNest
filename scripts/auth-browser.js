import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
// Sign-in and first-run setup: split screen, monochrome scope, one generic inline error, reduced motion.
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:5173';
const shots=process.env.TEST_SCREENSHOT_DIR||'data/auth-verification';
await mkdir(shots,{recursive:true});
const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
const problems=[];
const qr='data:image/svg+xml;utf8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#fff"/><path d="M10 10h60v60H10zM130 10h60v60h-60zM10 130h60v60H10zM90 90h20v20H90zM130 130h60v60h-60z" fill="#000"/></svg>');
const codes=['k7m2-x9qf','p3vd-8hna','t6yc-2wze','b9rj-4mkd','h5xs-7ugq','n2fa-6ctv','w8le-3pyb','d4oz-1kri'];
async function open({theme='light',width=1440,height=900,reduced=false,status={authenticated:false,setupRequired:false},login=200,verify=200,setup=200}={}){
 const context=await browser.newContext({viewport:{width,height},reducedMotion:reduced?'reduce':'no-preference'});
 const page=await context.newPage();page.on('pageerror',e=>problems.push(e.message));
 await page.addInitScript(t=>localStorage.setItem('docknest-theme',t),theme);
 await page.route('**/api/auth/status',r=>r.fulfill({json:status}));
 const answer=(code,ok)=>code===429?{status:429,json:{error:'Too many attempts. Try again later.'}}:code===401?{status:401,json:{error:'Invalid password or code.'}}:{json:ok};
 await page.route('**/api/auth/login',r=>r.fulfill(answer(login,{challenge:'c'.repeat(43)})));
 await page.route('**/api/auth/verify',r=>r.fulfill(answer(verify,{enrollmentRequired:false,csrfToken:'x',user:{id:'a',name:'Admin',role:'admin'}})));
 await page.route('**/api/auth/setup',r=>r.fulfill(answer(setup,{enrollmentRequired:true,challenge:'c'.repeat(43),qrDataUrl:qr,secret:'JBSWY3DPEHPK3PXP',recoveryCodes:codes})));
 return {context,page};
}
const colour=(page,selector,prop)=>page.locator(selector).first().evaluate((el,p)=>getComputedStyle(el)[p],prop);
const noBox=async page=>assert.equal(await page.locator('.alert,.alert-panel,.notice[role=alert]').count(),0,'no alert box on the auth pages');
async function fit(page,label){
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,label+' has no horizontal scroll');
}
async function fill(page){await page.getByLabel('Password',{exact:true}).fill('secret1');await page.getByLabel('2FA code').fill('123456')}
const signIn=async page=>{await page.goto(base);await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor()};

// 1. Desktop sign-in layout, tokens and animation, both themes.
for(const theme of ['light','dark']){
 const {context,page}=await open({theme});
 await signIn(page);
 assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
 const panel=page.locator('.lg-brandpanel');await panel.waitFor();
 assert.match(await panel.innerText(),/Backups you can prove\.\s*Servers you can move\./);
 assert.match(await panel.innerText(),/Self-hosted Docker backup and restore/);
 assert.equal(await page.locator('.lg-brandpanel .lg-path').count(),40,'twenty lines in each set');
 assert.deepEqual(await page.locator('.lg-pg').evaluateAll(g=>g.map(x=>getComputedStyle(x).animationDuration)),['52s','60s']);
 assert.equal(await page.locator('.lg-paths path').evaluateAll(p=>p.every(x=>getComputedStyle(x).animationName==='none')),true,'only transforms move, never the path data');
 assert.match(await colour(page,'.lg-brandpanel .lg-logo','maskImage'),/\/brand\/logo\.png/);
 const heading=await page.locator('.lg-title').evaluate(el=>getComputedStyle(el).color);
 assert.equal(await colour(page,'.lg-brandpanel .lg-logo','backgroundColor'),heading,'monochrome logo uses the heading colour');
 assert.equal(await colour(page,'button.primary.wide','backgroundColor'),heading,'monochrome primary button');
 assert.equal(await page.locator('.lg-rise').evaluateAll(e=>e.map(x=>getComputedStyle(x).animationName+' '+getComputedStyle(x).animationDelay).join()),'dn-enter 0s,dn-enter 0.12s');
 await noBox(page);await fit(page,'sign-in '+theme);
 assert.equal(await page.locator('.lg-m-logo').isVisible(),false,'phone logo hidden on desktop');
 const pw=page.getByLabel('Password',{exact:true});assert.equal(await pw.getAttribute('type'),'password');
 await page.getByRole('button',{name:'Show password'}).click();assert.equal(await pw.getAttribute('type'),'text');
 await page.getByRole('button',{name:'Hide password'}).click();assert.equal(await pw.getAttribute('type'),'password');
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'))});
 assert.equal(await colour(page,'.lg-pg','animationPlayState'),'paused','a hidden tab pauses the drift');
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:false,configurable:true});document.dispatchEvent(new Event('visibilitychange'))});
 assert.equal(await colour(page,'.lg-pg','animationPlayState'),'running');
 await page.waitForTimeout(400);
 await page.screenshot({path:`${shots}/signin-${theme}-1440.png`});
 await context.close();
}

// 2. One generic error for a wrong password or a wrong code, inline, with a red border.
for(const [name,login,verify] of [['wrong password',401,200],['wrong code',200,401]]){
 const {context,page}=await open({login,verify});
 await signIn(page);
 await fill(page);await page.getByRole('button',{name:'Sign in',exact:true}).click();
 const alert=page.getByRole('alert');await alert.waitFor();
 assert.equal(await alert.count(),1,name+': one alert');
 assert.equal((await alert.innerText()).trim(),'Invalid password or code.',name+': generic copy');
 assert.equal(await alert.locator('svg').count(),1);
 assert.equal(await alert.locator('svg').evaluate(s=>s.getAttribute('width')),'16');
 assert.equal(await alert.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)',name+': no box');
 await noBox(page);
 for(const label of [/^Password$/,/2FA code/])assert.equal(await page.getByLabel(label).first().getAttribute('aria-invalid'),'true',name+': both inputs flagged, nothing is revealed');
 await page.waitForTimeout(400);
 const red=await page.locator('input[name=code]').evaluate(el=>getComputedStyle(el).borderTopColor);
 assert.equal(red,await page.evaluate(()=>{const e=document.createElement('i');e.style.color=getComputedStyle(document.documentElement).getPropertyValue('--error');document.body.append(e);const c=getComputedStyle(e).color;e.remove();return c}),name+': red border');
 const [a,b]=await Promise.all([page.locator('.lg-err').boundingBox(),page.locator('button.primary.wide').boundingBox()]);
 assert.ok(a.y+a.height<=b.y,name+': error above the button');
  if(name==='wrong code'){await page.waitForTimeout(500);await page.screenshot({path:`${shots}/signin-wrong-code-light-1440.png`})}
 await context.close();
}
{
 const {context,page}=await open({theme:'dark',login:429});
 await signIn(page);await fill(page);await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.getByRole('alert').getByText('Too many attempts. Try again later.',{exact:true}).waitFor();
  await noBox(page);await page.waitForTimeout(500);await page.screenshot({path:`${shots}/signin-too-many-dark-1440.png`});await context.close();
}

// 3. Reduced motion stops every animation on the page.
{
 const {context,page}=await open({reduced:true});
 await signIn(page);
 assert.equal(await page.locator('.lg-pg,.lg-rise').evaluateAll(e=>e.every(x=>getComputedStyle(x).animationName==='none')),true,'reduced motion: no drift, no rise');
 await context.close();
}

// 4. Phone: form only with the small logo, no sideways scroll, 44px targets.
for(const theme of ['light','dark']){
 const {context,page}=await open({theme,width:390,height:844,login:401});
 await signIn(page);
 assert.equal(await page.locator('.lg-brandpanel').isVisible(),false,'no side panel under 1024');
 assert.equal(await page.locator('.lg-m-logo .lg-logo').isVisible(),true,'small logo above the form');
 await fit(page,'phone sign-in');
 for(const sel of ['button.primary.wide','input[name=password]','input[name=code]','.lg-eye'])assert.ok((await page.locator(sel).first().boundingBox()).height>=44,sel+' is at least 44px high on a phone');
 assert.ok((await page.locator('.lg-eye').boundingBox()).width>=44);
 await fill(page);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('alert').waitFor();await fit(page,'phone error');
 await page.screenshot({path:`${shots}/signin-error-${theme}-390.png`,fullPage:true});
 await context.close();
}
{
 const {context,page}=await open({width:1023,height:800});
 await signIn(page);
 assert.equal(await page.locator('.lg-brandpanel').isVisible(),false,'1023 is the form only');
 await context.close();
 const wide=await open({width:1024,height:800});await signIn(wide.page);
 assert.equal(await wide.page.locator('.lg-brandpanel').isVisible(),true,'1024 is the split screen');await wide.context.close();
}

// 5. First-run setup: same layout, short inline errors, QR and recovery codes.
for(const [theme,width,height] of [['light',1440,900],['dark',1440,900],['light',390,844],['dark',390,844]]){
 const {context,page}=await open({theme,width,height,status:{authenticated:false,setupRequired:true}});
 await page.goto(base+'/#/setup');await page.getByRole('heading',{name:'Set up DockNest',exact:true}).waitFor();
 assert.equal(await page.locator('.auth-page .lg-brandpanel').count(),1);
 await page.getByLabel('Administrator name').fill('Alex');await page.getByLabel('Administrator email').fill('alex@example.com');
 await page.getByLabel('Setup token',{exact:true}).fill('t'.repeat(20));
 await page.getByLabel('System password',{exact:true}).fill('abcd');await page.getByLabel('Confirm system password').fill('abce');
 await page.getByRole('button',{name:'Continue setup'}).click();
 await page.getByRole('alert').getByText('Passwords do not match.',{exact:true}).waitFor();
 await noBox(page);assert.equal(await page.getByLabel('Confirm system password').getAttribute('aria-invalid'),'true');
 await fit(page,'setup '+theme+width);
  await page.waitForTimeout(500);
 await page.screenshot({path:`${shots}/setup-1-error-${theme}-${width}.png`,fullPage:true});
 await page.getByLabel('Confirm system password').fill('abcd');await page.getByRole('button',{name:'Continue setup'}).click();
 await page.getByRole('heading',{name:'Connect your authenticator',exact:true}).waitFor();
 assert.equal(await page.locator('.auth-qr').count(),1);assert.equal(await page.locator('.recovery-codes code').count(),8);
 await noBox(page);await fit(page,'authenticator '+theme+width);
 if(width<500)for(const sel of ['button.primary.wide','input[name=code]'])assert.ok((await page.locator(sel).first().boundingBox()).height>=44);
  await page.waitForTimeout(500);
 await page.screenshot({path:`${shots}/setup-2-authenticator-${theme}-${width}.png`,fullPage:true});
 await context.close();
}
{
 const {context,page}=await open({status:{authenticated:false,setupRequired:true},setup:429});
 await page.goto(base+'/#/setup');await page.getByRole('heading',{name:'Set up DockNest',exact:true}).waitFor();
 await page.getByLabel('Administrator name').fill('Alex');await page.getByLabel('Administrator email').fill('alex@example.com');
 await page.getByLabel('Setup token',{exact:true}).fill('t'.repeat(20));await page.getByLabel('System password',{exact:true}).fill('abcd');await page.getByLabel('Confirm system password').fill('abcd');
 await page.getByRole('button',{name:'Continue setup'}).click();
 await page.getByRole('alert').getByText('Too many attempts. Try again later.',{exact:true}).waitFor();await context.close();
}

// 6. The app is unchanged: outside .auth-page the primary button keeps the purple token.
{
 const {context,page}=await open({status:{authenticated:false,message:'Your session ended. Sign in again.'}});
 await page.goto(base);await page.getByText('Your session ended. Sign in again.').first().waitFor();
 assert.equal(await page.locator('.auth-page').count(),0);
 assert.equal(await colour(page,'button.primary','backgroundColor'),'rgb(94, 53, 177)','app primary button is still purple');
 await context.close();
}
await browser.close();
assert.deepEqual(problems,[]);
console.log('Auth page checks passed: split screen at 1024, monochrome scope, one generic inline error, reduced motion, phone targets, setup screens, app tokens unchanged.');
