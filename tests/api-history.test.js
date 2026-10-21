import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const directory=await mkdtemp(join(tmpdir(),'docknest-history-'));
Object.assign(process.env,{DATA_DIR:directory,BACKUP_DIR:join(directory,'backups'),BACKUP_STORAGE:'local',MASTER_KEY_FILE:join(directory,'master.key'),SETUP_TOKEN_FILE:join(directory,'setup.token'),SECURE_COOKIES:'false',NODE_ENV:'test',APP_ORIGIN:'http://127.0.0.1:3000'});
await writeFile(process.env.MASTER_KEY_FILE,randomBytes(32).toString('base64'));
const {app}=await import('../src/server.js');
const {db,id}=await import('../src/db.js');
const {digest}=await import('../src/crypto.js');
const {recordVerification,backupVerification,backupVerifications}=await import('../src/recovery-evidence.js');
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}/api`;
const token=randomBytes(32).toString('base64url'),csrf='fixture-csrf',user=id(),site=id(),host=id(),job=id(),at=new Date().toISOString();
db.prepare("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)").run(user,'qa@example.invalid','fixture','fixture','[]',at,'QA','operator');
db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token),user,csrf,Date.now()+3600000,Date.now(),Date.now(),Date.now());
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(host,'QA','localhost',22,'root','fixture','0'.repeat(64),at);
db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(site,host,'QA site','{}',at);
db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','completed','completed',?)").run(job,site,at);
const stamp=index=>new Date(Date.UTC(2026,0,1,0,0,index)).toISOString();
function backup(name,capturedAt){db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(name,site,job,capturedAt,join(directory,'private-'+name),100,'a'.repeat(64),'{}',0,1,capturedAt);}
function request(route){return fetch(base+route,{headers:{Cookie:'dbm_session='+token,Origin:process.env.APP_ORIGIN,'x-csrf-token':csrf}});}
// Counts statements that read verification evidence so list endpoints cannot regress to one query per backup.
function countVerificationQueries(){
 const prepare=db.prepare,counter={count:0,restore:()=>{db.prepare=prepare;}};
 db.prepare=function(sql,...rest){if(/FROM backup_verifications\b/.test(sql))counter.count++;return prepare.call(this,sql,...rest);};
 return counter;
}
for(let index=0;index<60;index++)backup('list-'+String(index).padStart(3,'0'),stamp(index%20));
recordVerification('list-001','integrity',{status:'passed',method:'authentication'});
recordVerification('list-001','application',{status:'failed',scope:'fixture check'});
recordVerification('list-042','consistency',{status:'declared',method:'operator confirmation'});

test('batched verification loader matches the single-backup shape for every id',()=>{
 const ids=['list-001','list-042','list-007','unknown'],batched=backupVerifications([...ids,'list-001']);
 assert.equal(batched.size,ids.length);
 for(const backupId of ids)assert.deepEqual(batched.get(backupId),backupVerification(backupId));
 assert.equal(batched.get('list-001').integrity.status,'passed');assert.equal(batched.get('list-001').application.scope,'fixture check');
 assert.equal(backupVerifications([]).size,0);
 assert.equal(backupVerifications(Array.from({length:40000},(_value,index)=>'bulk-'+index)).size,40000);
});
test('state builds the backup list with a constant number of verification queries',async()=>{
 const before=countVerificationQueries();let response;
 try{response=await request('/state');}finally{before.restore();}
 assert.equal(response.status,200);const state=await response.json();
 assert.equal(state.backups.length,60);assert.equal(before.count,1);
 for(const item of state.backups){assert.deepEqual(item.verification,backupVerification(item.id));assert.equal(item.path,undefined);}
 for(let index=60;index<300;index++)backup('list-'+String(index).padStart(3,'0'),stamp(index%20));
 const after=countVerificationQueries();
 try{assert.equal((await request('/state')).status,200);}finally{after.restore();}
 assert.equal(after.count,before.count);
});
async function walk(route,limit){
 const items=[],pages=[];let cursor=null;
 do{const response=await request(`/${route}?limit=${limit}`+(cursor?'&cursor='+encodeURIComponent(cursor):''));assert.equal(response.status,200);const page=await response.json();assert.ok(page.items.length<=limit);pages.push(page);items.push(...page.items);cursor=page.nextCursor;}while(cursor);
 return {items,pages};
}
const ordered=(table,time)=>db.prepare(`SELECT id FROM ${table} ORDER BY ${time} DESC,id DESC`).all().map(row=>row.id);
test('backup history pages walk every backup once in stable keyset order without storage paths',async()=>{
 const counter=countVerificationQueries();let result;
 try{result=await walk('backups',37);}finally{counter.restore();}
 const expected=ordered('backups','captured_at');
 assert.deepEqual(result.items.map(item=>item.id),expected);assert.equal(new Set(result.items.map(item=>item.id)).size,expected.length);
 assert.equal(result.pages.length,Math.ceil(expected.length/37));assert.equal(result.pages.at(-1).nextCursor,null);
 assert.equal(counter.count,result.pages.length,'one verification query per page, not per backup');
 for(const item of result.items){assert.equal(item.path,undefined);assert.equal(item.status,'Verified');assert.deepEqual(item.verification,backupVerification(item.id));}
 assert.equal(result.items.find(item=>item.id==='list-001').verification.integrity.status,'passed');
});
test('a cursor stays stable when newer rows arrive between page requests',async()=>{
 const first=await (await request('/backups?limit=5')).json();
 backup('newest-arrival',stamp(59));
 const second=await (await request('/backups?limit=5&cursor='+first.nextCursor)).json();
 const expected=ordered('backups','captured_at');
 assert.deepEqual([...first.items,...second.items].map(item=>item.id),expected.filter(name=>name!=='newest-arrival').slice(0,10));
 assert.equal((await (await request('/backups?limit=1')).json()).items[0].id,'newest-arrival');
});
test('job, restore and audit history paginate with the same keyset contract',async()=>{
 for(let index=0;index<25;index++){
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','completed','completed',?)").run('job-'+index,site,stamp(index%7));
  db.prepare("INSERT INTO restores(id,backup_id,server_id,mode,plan,status,created_at) VALUES(?,?,?,'fresh',?,'completed',?)").run('restore-'+index,'list-001',host,JSON.stringify({serverId:host}),stamp(index%7));
  db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?)').run('audit-'+index,user,'fixture.event',null,JSON.stringify({index}),stamp(index%7));
 }
 for(const [route,table] of [['jobs','jobs'],['restores','restores'],['audit','audit_events']]){
  const {items,pages}=await walk(route,4);
  assert.deepEqual(items.map(item=>item.id),ordered(table,'created_at'));assert.ok(pages.length>1);
  assert.ok(items.every(item=>item.createdAt&&!('verification' in item)));
 }
 const restore=(await walk('restores',200)).items.find(item=>item.id==='restore-3');assert.deepEqual(restore.plan,{serverId:host});
 const event=(await walk('audit',200)).items.find(item=>item.id==='audit-3');assert.deepEqual(event.details,{index:3});
});
test('history endpoints validate limit and cursor and require a session',async()=>{
 const forged=Buffer.from(JSON.stringify({at:'x'})).toString('base64url');
 for(const query of ['limit=0','limit=201','limit=abc','limit=1.5','cursor=not-base64-json','cursor='+forged,'cursor='+'a'.repeat(600)]){
  const response=await request('/backups?'+query);assert.equal(response.status,400,query);assert.match((await response.json()).error,/limit|cursor/i);
 }
 const largest=await request('/jobs?limit=200');assert.equal(largest.status,200);assert.ok((await largest.json()).items.length<=200);
 const defaulted=await (await request('/backups')).json();assert.equal(defaulted.items.length,50);assert.equal(typeof defaulted.nextCursor,'string');
 for(const route of ['backups','jobs','restores','audit']){const response=await fetch(`${base}/${route}`);assert.equal(response.status,401);await response.text();}
});
test('state lists break equal timestamps by id descending, matching the history endpoints',async()=>{
 const tied='2099-01-01T00:00:00.000Z',names=['tie-a','tie-c','tie-b'];
 for(const name of names){
  backup(name,tied);
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','completed','completed',?)").run(name,site,tied);
  db.prepare("INSERT INTO restores(id,backup_id,server_id,mode,plan,status,created_at) VALUES(?,?,?,'fresh','{}','completed',?)").run(name,'list-001',host,tied);
  db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?)').run(name,user,'fixture.tie',null,'{}',tied);
 }
 const state=await (await request('/state')).json();
 for(const [list,table,time] of [['backups','backups','captured_at'],['jobs','jobs','created_at'],['restores','restores','created_at'],['audit','audit_events','created_at']]){
  assert.deepEqual(state[list].slice(0,3).map(item=>item.id),['tie-c','tie-b','tie-a'],list);
  assert.deepEqual(state[list].map(item=>item.id),ordered(table,time),list);
 }
});

test.after(async()=>{server.close();db.close();await rm(directory,{recursive:true,force:true});});
