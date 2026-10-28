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
const password=page=>page.getByLabel('Password',{exact:true});
async function step1(page){await password(page).fill('secret1');await page.getByRole('button',{name:'Continue',exact:true}).click()}
const codeInput=page=>page.getByLabel('Authentication code');
async function step2(page){await step1(page);await page.getByRole('heading',{name:'Two-factor code',exact:true}).waitFor();await codeInput(page).waitFor()}
const wait=(page,fn,arg)=>page.waitForFunction(fn,arg);
async function until(cond){for(let i=0;i<200&&!cond();i++)await new Promise(r=>setTimeout(r,25));assert.ok(cond(),'condition was not met in time')}
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
 await password(page).fill('secret1');
 assert.equal(await page.locator('button.primary.wide').getAttribute('aria-disabled'),null,'primary is at full emphasis once a password is typed');
 await wait(page,h=>getComputedStyle(document.querySelector('button.primary.wide')).backgroundColor===h,heading);
 assert.equal(await colour(page,'button.primary.wide','backgroundColor'),heading,'monochrome primary button');
 assert.equal(await page.locator('.lg-rise').evaluateAll(e=>e.map(x=>getComputedStyle(x).animationName+' '+getComputedStyle(x).animationDelay).join()),'dn-enter 0s,dn-enter 0.12s');
 await noBox(page);await fit(page,'sign-in '+theme);
 assert.equal(await page.locator('.lg-head-logo').isVisible(),false,'top-bar wordmark hidden on desktop');
 {const [w,t]=await Promise.all([page.locator('.lg-bp-top .lg-logo').boundingBox(),page.locator('.lg-head .theme-toggle').boundingBox()]);assert.ok(Math.abs((w.y+w.height/2)-(t.y+t.height/2))<=1,'wordmark and theme toggle share one row on desktop');}
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

// 2. One generic error for a wrong password (step 1) or a wrong code (step 2), inline, with a red border.
{
 const {context,page}=await open({login:401});
 await signIn(page);await step1(page);
 const alert=page.getByRole('alert');await alert.waitFor();
 assert.equal(await alert.count(),1,'wrong password: one alert');
 assert.equal((await alert.innerText()).trim(),'Invalid password or code.','wrong password: generic copy');
 assert.equal(await alert.locator('svg').count(),1);
 assert.equal(await page.getByRole('heading',{name:'Sign in',exact:true}).isVisible(),true,'wrong password stays on step 1');
 assert.equal(await password(page).getAttribute('aria-invalid'),'true');
 await noBox(page);await context.close();
}
{
 const {context,page}=await open({verify:401});
 await signIn(page);await step2(page);
 await codeInput(page).pressSequentially('123456');
 const alert=page.getByRole('alert');await alert.waitFor();
 assert.equal(await alert.count(),1,'wrong code: one alert');
 assert.equal((await alert.innerText()).trim(),'Invalid password or code.','wrong code: generic copy');
 assert.equal(await alert.locator('svg').evaluate(s=>s.getAttribute('width')),'16');
 assert.equal(await alert.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)','wrong code: no box');
 await noBox(page);
 assert.equal(await codeInput(page).getAttribute('aria-invalid'),'true','wrong code: input flagged');
 await wait(page,()=>document.querySelector('.otp-input').value==='');
 await wait(page,()=>document.activeElement===document.querySelector('.otp-input'));
 const red=await page.locator('.otp-group').first().evaluate(el=>getComputedStyle(el).borderTopColor);
 assert.equal(red,await page.evaluate(()=>{const e=document.createElement('i');e.style.color=getComputedStyle(document.documentElement).getPropertyValue('--error');document.body.append(e);const c=getComputedStyle(e).color;e.remove();return c}),'wrong code: red border');
 const [x,y]=await Promise.all([page.locator('.lg-err').boundingBox(),page.locator('button.primary.wide').boundingBox()]);
 assert.ok(x.y+x.height<=y.y,'wrong code: error above the button');
 await page.screenshot({path:`${shots}/signin-wrong-code-light-1440.png`});
 await context.close();
}
{
 const {context,page}=await open({theme:'dark',login:429});
 await signIn(page);await step1(page);
 await page.getByRole('alert').getByText('Too many attempts. Try again later.',{exact:true}).waitFor();
 await noBox(page);await page.screenshot({path:`${shots}/signin-too-many-dark-1440.png`});await context.close();
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
 const {context,page}=await open({theme,width:390,height:844,verify:401});
 await signIn(page);
 assert.equal(await page.locator('.lg-brandpanel').isVisible(),false,'no side panel under 1024');
 assert.equal(await page.locator('.lg-head-logo').isVisible(),true,'wordmark in the top bar');
 const [lg,tg]=await Promise.all([page.locator('.lg-head-logo').boundingBox(),page.locator('.lg-head .theme-toggle').boundingBox()]);
 assert.ok(Math.abs((lg.y+lg.height/2)-(tg.y+tg.height/2))<=1,'wordmark and theme toggle share one row');
 assert.equal(await page.locator('.lg-mark').count(),0,'no second logo above the title');
 await fit(page,'phone sign-in');
 for(const sel of ['button.primary.wide','input[name=password]','.lg-eye'])assert.ok((await page.locator(sel).first().boundingBox()).height>=44,sel+' is at least 44px high on a phone');
 assert.ok((await page.locator('.lg-eye').boundingBox()).width>=44);
 await step2(page);await fit(page,'phone step 2');
 const cells=await page.locator('.otp-box').evaluateAll(e=>e.map(x=>x.getBoundingClientRect().width));
 assert.equal(cells.length,6);assert.ok(Math.min(...cells)>=44,'cells are at least 44px wide');
 assert.ok((await page.locator('button.primary.wide').boundingBox()).height>=44);
 await codeInput(page).pressSequentially('123456');await page.getByRole('alert').waitFor();await fit(page,'phone error');
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
// 7. Two-step flow: use cases.
const track=async page=>{const bodies=[];await page.route('**/api/auth/verify',r=>{bodies.push(r.request().postDataJSON());return r.fulfill({json:{enrollmentRequired:false,csrfToken:'x',user:{id:'a',name:'Admin',role:'admin'}}})});return bodies};
{ // paste / autofill fills all cells and submits exactly once; non-digits are dropped
 const {context,page}=await open();const bodies=await track(page);
 await signIn(page);await step2(page);
 assert.equal(await page.locator('button.primary.wide').getAttribute('aria-disabled'),'true','sign-in is quiet until six digits');
 await codeInput(page).fill('48 29-13');
 await until(()=>bodies.length>0);
 assert.deepEqual(bodies.map(b=>b.code),['482913'],'one verify call with the pasted code');
 assert.equal(bodies[0].challenge,'c'.repeat(43));
 await context.close();
}
{ // typing, Backspace across cells, arrows, Home/End; only digits accepted
 const {context,page}=await open({verify:401});
 await signIn(page);await step2(page);
 const input=codeInput(page),filled=()=>page.locator('.otp-box.otp-filled').count(),active=()=>page.locator('.otp-box').evaluateAll(e=>e.findIndex(x=>x.classList.contains('otp-active')));
 await input.pressSequentially('48x2');
 assert.equal(await input.inputValue(),'482','letters are ignored');
 assert.equal(await filled(),3);
 await page.keyboard.press('Backspace');await page.keyboard.press('Backspace');
 assert.equal(await input.inputValue(),'4');assert.equal(await filled(),1);assert.equal(await active(),1,'caret moves back across cells');
 await input.pressSequentially('791');await page.keyboard.press('Home');await wait(page,()=>document.querySelector('.otp-input').selectionStart===0);
 assert.equal(await active(),0,'Home goes to the first cell');
 await page.keyboard.press('End');await wait(page,()=>document.querySelector('.otp-input').selectionStart===4);
 assert.equal(await active(),4);
 await page.keyboard.press('ArrowLeft');await wait(page,()=>document.querySelector('.otp-input').selectionStart===3);
 assert.equal(await active(),3,'arrow keys move the active cell');
 assert.equal(await input.getAttribute('autocomplete'),'one-time-code');assert.equal(await input.getAttribute('inputmode'),'numeric');
 await context.close();
}
{ // recovery code swap, Enter submits, swap back, Back to step 1
 const {context,page}=await open();const bodies=await track(page);
 await signIn(page);await step2(page);
 await page.getByRole('button',{name:'Use a recovery code',exact:true}).click();
 const rec=page.getByLabel('Recovery code');await rec.waitFor();
 assert.equal(await page.locator('.otp').count(),0,'boxes are replaced by a text field');
 assert.equal(await page.getByText('Have your app?').count(),1);
 await rec.fill('k7m2-x9qf');await page.keyboard.press('Enter');
 await until(()=>bodies.length>0);
 assert.deepEqual(bodies.map(b=>b.code),['k7m2-x9qf'],'recovery code is sent as typed');
 await context.close();
}
{
 const {context,page}=await open({verify:401});
 await signIn(page);await step2(page);
 await page.getByRole('button',{name:'Use a recovery code',exact:true}).click();
 await page.getByRole('button',{name:'Use the 6-digit code',exact:true}).click();
 await codeInput(page).waitFor();
 await page.getByRole('button',{name:'Back',exact:true}).click();
 await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();
 await wait(page,()=>document.activeElement&&document.activeElement.getAttribute('name')==='password');
 assert.equal(await password(page).inputValue(),'','Back returns to step 1 with the challenge dropped');
 assert.equal(await page.getByRole('button',{name:'Continue',exact:true}).count(),1);
 await context.close();
}
{ // keyboard only: Tab to password, Enter, type the code, nothing needs a mouse
 const {context,page}=await open();const bodies=await track(page);
 await signIn(page);
 for(let i=0;i<5&&await page.evaluate(()=>document.activeElement.getAttribute('name'))!=='password';i++)await page.keyboard.press('Tab');
 assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('name')),'password','password is reachable with Tab');
 await page.keyboard.type('secret1');await page.keyboard.press('Enter');
 await page.getByRole('heading',{name:'Two-factor code',exact:true}).waitFor();
 await wait(page,()=>document.activeElement===document.querySelector('.otp-input'));
 await page.keyboard.type('123456');
 await until(()=>bodies.length>0);
 assert.deepEqual(bodies.map(b=>b.code),['123456'],'keyboard-only sign-in');
 await context.close();
}
{ // repeated failures offer a fresh start
 const {context,page}=await open({verify:401});
 await signIn(page);await step2(page);
 for(let i=1;i<=3;i++){await codeInput(page).pressSequentially('111111');await page.getByRole('alert').waitFor();await wait(page,()=>document.querySelector('.otp-input').value===''&&!document.querySelector('.otp-input').disabled);}
 await page.getByRole('button',{name:'Start again',exact:true}).click();
 await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();
 await context.close();
}
{ // reduced motion: no digit rise, caret blink or shake
 const {context,page}=await open({reduced:true,verify:401});
 await signIn(page);await step2(page);
 await codeInput(page).pressSequentially('12');
 assert.equal(await page.locator('.otp-digit,.otp-caret').evaluateAll(e=>e.length>0&&e.every(x=>getComputedStyle(x).animationName==='none')),true,'reduced motion: digits and caret are still');
 await codeInput(page).pressSequentially('3456');await page.getByRole('alert').waitFor();
 assert.equal(await colour(page,'.otp-boxes','animationName'),'none','reduced motion: no shake');
 await context.close();
}
{ // motion on: digits rise, the caret blinks, an error shakes
 const {context,page}=await open({verify:401});
 await signIn(page);await step2(page);
 await codeInput(page).pressSequentially('12');
 assert.equal(await colour(page,'.otp-digit','animationName'),'otp-in');
 assert.equal(await colour(page,'.otp-caret','animationName'),'otp-blink');
 await codeInput(page).pressSequentially('3456');await page.getByRole('alert').waitFor();
 assert.equal(await colour(page,'.otp-boxes','animationName'),'otp-shake');
 await context.close();
}
{ // empty password: Continue does nothing silently, native validation flags the field and no request is sent
 const {context,page}=await open();let logins=0;await page.route('**/api/auth/login',r=>{logins++;return r.fulfill({json:{challenge:'c'.repeat(43)}})});
 await signIn(page);
 assert.equal(await page.getByRole('button',{name:'Continue',exact:true}).getAttribute('aria-disabled'),'true');
 await page.getByRole('button',{name:'Continue',exact:true}).click({force:true});
 await wait(page,()=>document.activeElement===document.querySelector('input[name=password]'));
 assert.equal(await password(page).evaluate(e=>e.validity.valueMissing),true,'the empty field is flagged');
 assert.equal(logins,0,'no login request for an empty password');
 await context.close();
}
{ // network or rate-limit errors do not count as failed codes
 const {context,page}=await open({verify:429});
 await signIn(page);await step2(page);
 for(let i=0;i<3;i++){await codeInput(page).pressSequentially('111111');await page.getByRole('alert').getByText('Too many attempts. Try again later.',{exact:true}).waitFor();await wait(page,()=>document.querySelector('.otp-input').value===''&&!document.querySelector('.otp-input').disabled);}
 assert.equal(await page.getByRole('button',{name:'Back',exact:true}).count(),1,'still Back after three 429s');
 await context.close();
}
for(const theme of ['light','dark']){ // the faded primary stays readable (4.5:1) and the swap link and Back are 44px targets on a phone
 const {context,page}=await open({theme,width:390,height:844});
 await signIn(page);await step2(page);
 const r=await page.locator('button.primary.wide').evaluate(b=>{
  const parse=c=>{const m=c.match(/[\d.]+/g).map(Number);return m.slice(0,3)};
  const surface=parse(getComputedStyle(document.querySelector('.lg-left')).backgroundColor);
  const op=Number(getComputedStyle(b).opacity),bg=parse(getComputedStyle(b).backgroundColor),fg=parse(getComputedStyle(b).color);
  const mix=(c)=>c.map((v,i)=>v*op+surface[i]*(1-op));
  const lum=c=>{const a=c.map(v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)});return .2126*a[0]+.7152*a[1]+.0722*a[2]};
  const l1=lum(mix(bg)),l2=lum(mix(fg));return (Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05)});
 assert.ok(r>=4.5,theme+': faded primary contrast '+r.toFixed(2));
 assert.ok((await page.locator('.lg-alt button').boundingBox()).height>=44,theme+': swap link is a 44px target');
 assert.ok((await page.locator('.lg-back').boundingBox()).height>=44,theme+': Back is a 44px target');
 await context.close();
}
{ // number inputs show no spin buttons anywhere
 const {context,page}=await open();await signIn(page);
 await page.evaluate(()=>{const i=document.createElement('input');i.type='number';i.min='1';i.max='10';i.id='probe';document.body.append(i)});
 const r=await page.locator('#probe').evaluate(el=>{const rules=[...document.styleSheets].flatMap(sh=>[...sh.cssRules]).filter(x=>x.selectorText&&x.selectorText.includes('::-webkit-inner-spin-button')&&x.selectorText.includes('::-webkit-outer-spin-button'));return {box:getComputedStyle(el).appearance,hidden:rules.some(x=>x.style.getPropertyValue('-webkit-appearance')==='none'&&x.style.margin==='0px'),type:el.type,min:el.min}});
 assert.equal(r.box,'textfield');assert.equal(r.hidden,true,'inner and outer spin buttons are hidden in the shared stylesheet');assert.equal(r.type,'number');assert.equal(r.min,'1','type and min stay');
 await page.locator('#probe').fill('5');await page.locator('#probe').press('ArrowUp');
 assert.equal(await page.locator('#probe').inputValue(),'6','keyboard ArrowUp still steps the value');
 await context.close();
}
await browser.close();
assert.deepEqual(problems,[]);
console.log('Auth page checks passed: split screen at 1024, monochrome scope, one generic inline error, reduced motion, phone targets, setup screens, app tokens unchanged.');
