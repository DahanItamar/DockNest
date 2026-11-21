import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
// Login typing animation: password dots follow the real input, OTP digits animate, no focus border, reduced motion is still.
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

// Typing animation: password dots follow the real input, OTP digits animate, no focus border, reduced motion is still.
for(const reduced of [false,true]){
 const {context,page}=await open({reduced});
 await signIn(page);
 const pw=password(page),dots=page.locator(".pw-dot");
 assert.equal(await pw.evaluate(e=>e===e.ownerDocument.querySelector("input[type=password]")),true,"the labelled field is the real password input");
 assert.equal(await pw.getAttribute("autocomplete"),"current-password","autofill attribute kept");
 assert.equal(await page.locator(".pw-dots").count(),1);
 assert.equal(await page.locator(".pw-dots").getAttribute("aria-hidden"),"true","the overlay is hidden from assistive tech");
 await pw.focus();assert.equal(await pw.evaluate(e=>document.activeElement===e),true,"the real input takes focus");
 await pw.pressSequentially("abc123");assert.equal(await dots.count(),6,"one dot per typed character");
 await pw.press("Backspace");assert.equal(await dots.count(),5,"Backspace removes a dot");
 await pw.fill("pasted-secret");assert.equal(await dots.count(),13,"paste or fill draws every dot");
 assert.equal(await dots.first().evaluate(e=>getComputedStyle(e).animationName),reduced?"none":"pw-pop",reduced?"reduced motion: dots do not animate":"each dot pops in");
 assert.equal(await pw.evaluate(e=>getComputedStyle(e).color),"rgba(0, 0, 0, 0)","the native glyphs are transparent, the overlay draws the mask");
 // no focus border or ring, but a visible caret
 await page.mouse.move(2,2);
 const look=()=>pw.evaluate(e=>{const c=getComputedStyle(e);return {border:c.borderTopColor,outline:c.outlineStyle,caret:c.caretColor}});
 const on=await look();await pw.evaluate(e=>e.blur());const off=await look();
 assert.equal(on.outline,"none","no focus ring on the password input");
 assert.equal(on.border,off.border,"focus does not change the password border");
 assert.notEqual(on.caret,"rgba(0, 0, 0, 0)","the caret stays visible");
 await pw.focus();
 await page.getByRole("button",{name:"Show password"}).click();
 assert.equal(await page.locator(".pw-dots").count(),0,"revealed: the overlay is gone, the text is the input");
 assert.equal(await pw.inputValue(),"pasted-secret");
 await page.getByRole("button",{name:"Hide password"}).click();assert.equal(await dots.count(),13,"hidden again: dots return");
 await pw.fill("");assert.equal(await dots.count(),0,"an empty field has no dots");
 // 2FA
 await pw.fill("secret1");await page.getByRole("button",{name:"Continue",exact:true}).click();await codeInput(page).waitFor();
 const code=codeInput(page),boxes=page.locator(".otp-box");
 await code.pressSequentially("48");
 assert.equal(await page.locator(".otp-digit").count(),2,"two digits drawn");
 assert.equal(await page.locator(".otp-digit").first().evaluate(e=>getComputedStyle(e).animationName),reduced?"none":"otp-in");
 await code.press("Backspace");assert.equal(await page.locator(".otp-digit").count(),1,"Backspace removes the digit");
 const active=page.locator(".otp-box.otp-active");
 assert.equal(await active.count(),1);
 assert.equal(await active.evaluate(e=>getComputedStyle(e).outlineStyle),"none","no focus ring on the active box");
 assert.equal(await page.locator(".otp-caret").count(),1,"a caret marks the active box");
 assert.notEqual(await active.evaluate(e=>getComputedStyle(e).backgroundColor),await boxes.last().evaluate(e=>getComputedStyle(e).backgroundColor),"the active box is tinted");
 assert.equal(await page.locator(".otp-caret").evaluate(e=>getComputedStyle(e).animationName),reduced?"none":"otp-blink");
 await code.fill("4a8-2");assert.equal(await code.inputValue(),"482","paste keeps digits only");
 await context.close();
}
await browser.close();
assert.deepEqual(problems,[]);
console.log("Login typing checks passed: dots follow the input, paste, backspace, reveal toggle, autofill attribute, OTP digits, no focus border, reduced motion.");
