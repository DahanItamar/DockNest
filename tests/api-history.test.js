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

test.after(async()=>{server.close();db.close();await rm(directory,{recursive:true,force:true});});
