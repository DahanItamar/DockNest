// Synthetic Storage page checks: S3 form validation, focus, errors, region derivation,
// Object Lock confirmation/warnings, live status, reset, layout and SFTP regressions.
// Uses a loopback fake S3 endpoint only; no real provider or Linux restore is exercised.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { startS3Fixture } from '../tests/s3-fixture.js';
const reservation=createServer();reservation.listen(0,'127.0.0.1');await new Promise(resolve=>reservation.once('listening',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const directory=await mkdtemp(join(tmpdir(),'docknest-storage-ui-'));
Object.assign(process.env,{DATA_DIR:directory,MASTER_KEY_FILE:join(directory,'master.key'),NODE_ENV:'test',BACKUP_STORAGE:'unconfigured',SECURE_COOKIES:'false',APP_ORIGIN:`http://127.0.0.1:${port}`});
await writeFile(process.env.MASTER_KEY_FILE,randomBytes(32).toString('base64'));
const {app}=await import('../src/server.js'),{db,id}=await import('../src/db.js'),{digest,seal}=await import('../src/crypto.js');
const fixture=await startS3Fixture(),user=id(),token=randomBytes(32).toString('base64url'),now=new Date().toISOString();
db.prepare("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)").run(user,'fixture@example.invalid','fixture',seal('JBSWY3DPEHPK3PXP'),'[]',now,'Fixture administrator','admin');
db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token),user,'fixture-csrf',Date.now()+3600000,Date.now(),Date.now(),Date.now());
db.prepare("INSERT INTO settings VALUES('worker_heartbeat',?)").run(JSON.stringify({running:true,lastSeen:now}));
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run('server-1','Production','localhost',22,'root','synthetic','0'.repeat(64),now);
db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run('site-1','server-1','Shop','{}',now);
db.prepare("INSERT INTO policies(site_id,enabled,schedule,timezone,retention) VALUES('site-1',1,'0 2 * * *','UTC',3)").run();
const server=app.listen(port,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${port}`;
let browser;
try{
 browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addCookies([{name:'dbm_session',value:token,url:base}]);
 const page=await context.newPage(),errors=[],consoleMessages=[],posts=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>consoleMessages.push(message.text()));
 page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/api/storage-targets'))posts.push(new URL(request.url()).pathname);});
 await page.goto(base);
 // A first administrator sign-in asks about update checks before anything else; answer it as a user would.
 await page.getByRole('dialog',{name:'Check GitHub daily for new versions?'}).getByRole('button',{name:'No, keep checks off'}).click();
 await page.getByRole('dialog').waitFor({state:'detached'});
 await page.getByRole('button',{name:'Storage',exact:true}).first().click();
 // S5: the live region exists before any action.
 assert.equal(await page.locator('p.sr-only[role="status"]').count(),1);
 await page.getByRole('button',{name:'Add storage destination',exact:true}).click();
 const form=page.locator('form.storage-form');
 await form.getByLabel('Destination name').fill('Fixture bucket');
 await form.getByLabel('Destination type').selectOption('s3');
 await form.locator('.badge',{hasText:'Beta'}).first().waitFor();
 // B6: region follows the endpoint until edited.
 const region=form.locator('input[name="region"]'),endpoint=form.locator('input[name="endpoint"]');
 await endpoint.fill('https://s3.us-west-004.backblazeb2.com');assert.equal(await region.inputValue(),'us-west-004');
 await endpoint.fill('https://0123abcd.r2.cloudflarestorage.com');assert.equal(await region.inputValue(),'auto');
 await region.fill('eu-central-1');await endpoint.fill('https://s3.us-west-004.backblazeb2.com');assert.equal(await region.inputValue(),'eu-central-1');
 // B3: patterns are valid in Chrome and block malformed values before any request.
 await region.fill('NOT VALID REGION');await form.locator('input[name="bucket"]').fill('Bad_Bucket!!');
 await form.locator('input[name="accessKeyId"]').fill(fixture.credentials.accessKeyId);await form.locator('input[name="secretAccessKey"]').fill('wrong-secret');
 await form.getByRole('button',{name:'Test & connect storage'}).click();
 assert.equal(await region.evaluate(element=>element.validity.patternMismatch),true);
 assert.equal(await form.locator('input[name="bucket"]').evaluate(element=>element.validity.patternMismatch),true);
 assert.equal(posts.length,0,'Invalid values must not be posted');
 assert.ok(!consoleMessages.some(message=>/pattern attribute value/i.test(message)),consoleMessages.join('\n'));
 // B7: Compliance requires confirmation; warning compares lock days with retention.
 await form.getByLabel('Keep immutable copies with S3 Object Lock').check();
 await form.getByLabel('Object Lock mode').selectOption('COMPLIANCE');
 await form.getByText('Nobody can remove locked backups early, not even the account owner.',{exact:false}).waitFor();
 await form.getByText('Shop keeps about 3 days',{exact:false}).waitFor();
 await form.getByLabel('Keep each backup for (days)').fill('2');
 assert.equal(await form.getByText('Shop keeps about 3 days',{exact:false}).count(),0);
 await region.fill('us-east-1');await form.locator('input[name="bucket"]').fill(fixture.options.bucket);await endpoint.fill(fixture.options.endpoint);await form.getByLabel('Addressing style').selectOption('path');
 const submit=form.getByRole('button',{name:'Test & connect storage'});
 assert.equal(await submit.getAttribute('aria-disabled'),'true');
 await submit.click({force:true});await form.getByText('Confirm that you understand Compliance mode before connecting.',{exact:false}).waitFor();
 assert.equal(posts.length,0);
 await form.getByLabel('I understand locked backups cannot be deleted before the date, by anyone.').check();
 assert.equal(await submit.getAttribute('aria-disabled'),null);
 await form.getByLabel('Keep immutable copies with S3 Object Lock').uncheck();
 // B2 + B4 + B5: an upstream 401 keeps the session and form, focus stays on the button while busy, and the error is focused in the form.
 fixture.faults.status={status:401,code:''};fixture.faults.delayMs=1500;
 await submit.focus();await page.keyboard.press('Enter');
 assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Testing storage…');
 await page.keyboard.press('Enter');
 await form.locator('#storage-form-error').waitFor();
 assert.equal(await page.evaluate(()=>document.activeElement?.id),'storage-form-error');
 assert.ok(await form.locator('#storage-form-error').evaluate(element=>{const box=element.getBoundingClientRect();return box.top>=0&&box.bottom<=innerHeight;}));
 assert.match(await form.locator('#storage-form-error').textContent(),/^Could not connect storage\./);
 assert.equal(posts.filter(path=>path.endsWith('/s3/connect')).length,1,'Second Enter while busy is ignored');
 assert.equal(await form.locator('input[name="secretAccessKey"]').inputValue(),'wrong-secret');fixture.faults.delayMs=0;
 fixture.faults.status=null;
 // Successful connect: live status announced, form resets to SFTP without Object Lock (S6).
 await form.locator('input[name="secretAccessKey"]').fill(fixture.credentials.secretAccessKey);
 await submit.click();
 await page.locator('p.sr-only[role="status"]',{hasText:'Storage connected.'}).waitFor();
 await page.locator('.storage-card .badge',{hasText:'Beta'}).waitFor();
 await page.getByRole('button',{name:'Add storage destination',exact:true}).click();
 assert.equal(await page.locator('form.storage-form').getByLabel('Destination type').inputValue(),'sftp');
 assert.equal(await page.locator('form.storage-form input[name="endpoint"]').count(),0);
 // S2: 24px between stacked S3 rows and 44px selects at desktop and phone widths.
 await page.locator('form.storage-form').getByLabel('Destination type').selectOption('s3');
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:900});
  const gap=await page.locator('form.storage-form .form-grid').evaluateAll(grids=>grids[1].firstElementChild.getBoundingClientRect().top-grids[0].lastElementChild.getBoundingClientRect().bottom);
  assert.ok(gap>=23.5,'Row gap '+gap+' at '+width);
  for(const height of await page.locator('form.storage-form select').evaluateAll(selects=>selects.map(select=>select.getBoundingClientRect().height)))assert.ok(Math.abs(height-44)<1,'Select height '+height+' at '+width);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }
 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:'Cancel connection',exact:true}).click();
 // B4 + B5 on cards: keyboard focus stays on Test connection and failures appear in the card.
 fixture.faults.status={status:500,code:'InternalError'};
 const test=page.locator('.storage-card').getByRole('button',{name:'Test connection'});
 await test.focus();await page.keyboard.press('Enter');
 await page.locator('.storage-card [role="alert"]').waitFor({timeout:15000});
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Test connection');
 fixture.faults.status=null;
 // SFTP regression: errors render in the same form alert, a double Enter posts once, session survives.
 await page.getByRole('button',{name:'Add storage destination',exact:true}).click();
 const sftp=page.locator('form.storage-form');
 await sftp.getByLabel('Destination name').fill('Closed SFTP');await sftp.locator('input[name="host"]').fill('127.0.0.1');await sftp.locator('input[name="port"]').fill('1');
 await sftp.locator('input[name="username"]').fill('fixture');await sftp.locator('input[name="password"]').fill('fixture-not-a-real-credential');
 await sftp.locator('input[name="hostKey"]').fill('SHA256:'+'A+/b'.repeat(10)+'abc');
 const before=posts.filter(path=>path.endsWith('/storage-targets/connect')).length;
 await sftp.getByRole('button',{name:'Test & connect storage'}).focus();await page.keyboard.press('Enter');await page.keyboard.press('Enter');
 await sftp.locator('#storage-form-error').waitFor({timeout:30000});
 assert.equal(posts.filter(path=>path.endsWith('/storage-targets/connect')).length-before,1);
 await page.getByRole('heading',{name:'Remote backup destinations'}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('Synthetic Storage page passed: S3 validation, region derivation, Object Lock confirmation and warnings, focus and in-form errors, upstream 401 handling, live status, reset, layout and SFTP regressions. Fake S3 endpoint only.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await fixture.close();db.close();await rm(directory,{recursive:true,force:true});}
