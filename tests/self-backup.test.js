import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startSftpFixture } from './sftp-fixture.js';
const root=await mkdtemp(join(tmpdir(),'docknest-self-backup-'));
Object.assign(process.env,{DATA_DIR:root,MASTER_KEY_FILE:join(root,'master.key'),NODE_ENV:'test',BACKUP_STORAGE:'unconfigured',SECURE_COOKIES:'false',APP_ORIGIN:'http://127.0.0.1:3000'});
await writeFile(process.env.MASTER_KEY_FILE,randomBytes(32).toString('base64'));
const {app}=await import('../src/server.js');
const {db,id}=await import('../src/db.js');
const {digest,seal}=await import('../src/crypto.js');
const {saveSelfBackupSettings,enqueueSelfBackup,tickSelfBackup,claimSelfBackup,executeSelfBackup,selfBackupStatus,readLatestSelfBackup,recoverInterruptedSelfBackups,pruneSelfBackups}=await import('../src/self-backup.js');
const {restoreRecoveryKit,exportRecoveryKit}=await import('../src/recovery-kit.js');
const {testStorageTarget,storageCapacity}=await import('../src/storage.js');
const fixture=await startSftpFixture(),target=id(),secondTarget=id();
function seedTarget(targetId,name,root){const options=fixture.options;db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(targetId,name,options.host,options.port,options.username,options.hostKey,'password',seal(options.password),root,1e12,'connected',new Date().toISOString(),new Date().toISOString());}
const passphrase=randomBytes(32).toString('base64url');
const administrator=id(),operator=id(),csrf='fixture-csrf',tokens=[randomBytes(32).toString('base64url'),randomBytes(32).toString('base64url')];
for(const [index,user] of [administrator,operator].entries()){
 db.prepare("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)").run(user,user+'@example.invalid','fixture',seal('JBSWY3DPEHPK3PXP'),'[]',new Date().toISOString(),'Fixture',index?'operator':'admin');
 db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(tokens[index]),user,csrf,Date.now()+3600000,Date.now(),Date.now(),Date.now());
}
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const request=(route,{index=0,body,headers={}}={})=>fetch(`http://127.0.0.1:${server.address().port}/api/self-backup`+route,{method:body?'POST':'GET',headers:{Cookie:'dbm_session='+tokens[index],Origin:process.env.APP_ORIGIN,'x-csrf-token':csrf,'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
const settings={enabled:false,schedule:'0 3 * * *',timezone:'UTC',passphrase,recoverySecretSaved:true};
test('self-backup is opt-in, administrator-only, CSRF protected and never returns the recovery secret',async()=>{
 assert.equal(selfBackupStatus().settings,null);assert.equal(claimSelfBackup(),null);tickSelfBackup();
 assert.equal((await request('',{index:1})).status,403);
 assert.equal((await request('/settings',{index:1,body:settings})).status,403);
 assert.equal((await request('/download',{index:1})).status,403);
 assert.equal((await request('/settings',{body:settings,headers:{'x-csrf-token':'wrong'}})).status,403);
 assert.equal((await request('/settings',{body:{...settings,passphrase:'short'}})).status,400);
 assert.equal((await request('/settings',{body:{...settings,timezone:'not-a-timezone'}})).status,400);
 assert.equal((await request('/settings',{body:settings})).status,200);
 const response=await request('');const text=await response.text();assert.ok(!text.includes(passphrase));assert.equal(JSON.parse(text).retention,1);
 assert.ok(!db.prepare("SELECT value FROM settings WHERE key='manager_backup_config'").get().value.includes(passphrase));
 assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit_events').all()).includes(passphrase));
 assert.throws(()=>enqueueSelfBackup(administrator),/connected SFTP/);
 await testStorageTarget({...fixture.options,root:'/backups'});await testStorageTarget({...fixture.options,root:'/other'});
 seedTarget(target,'Connected backups','/backups');seedTarget(secondTarget,'Other destination','/other');
 db.prepare("INSERT INTO settings VALUES('backup_storage_target',?)").run(target);
 assert.equal(selfBackupStatus().destination.name,'Connected backups');
 fixture.files.set('/backups/unrelated-file',Buffer.from('preserved'));
});
test('the prior local kit remains downloadable until the first remote upload succeeds',async()=>{
 const legacy=id(),directory=join(root,'manager-backups');await mkdir(directory,{recursive:true});
 const evidence=await exportRecoveryKit({database:db,masterKey:process.env.MASTER_KEY_FILE,output:join(directory,legacy+'.dkit'),passphrase});
 const bytes=await readFile(join(directory,legacy+'.dkit'));
 db.prepare("INSERT INTO manager_backups(id,status,created_at,finished_at,checksum,size,release) VALUES(?,'completed',?,?,?,?,?)").run(legacy,new Date().toISOString(),new Date().toISOString(),evidence.sha256,bytes.length,'legacy');
 fixture.faults.writes=true;enqueueSelfBackup(administrator);await executeSelfBackup(claimSelfBackup());fixture.faults.writes=false;
 assert.equal(selfBackupStatus().latest.storage.mode,'local');assert.deepEqual((await readLatestSelfBackup()).bytes,bytes);
});
test('worker creates an encrypted consistent kit, replaces one copy only after success, and preserves it when replacement fails',async()=>{
 db.prepare("INSERT INTO settings VALUES('fixture_metadata','preserved')").run();
 const first=enqueueSelfBackup(administrator);assert.throws(()=>enqueueSelfBackup(administrator),/already queued/);assert.throws(()=>saveSelfBackupSettings(settings,administrator),/Wait/);
 const run=claimSelfBackup();assert.equal(run.id,first.id);assert.equal(claimSelfBackup(),null);await executeSelfBackup(run);
 assert.equal(selfBackupStatus().latest.id,first.id);
 const original=await readLatestSelfBackup();assert.ok(!original.bytes.includes(Buffer.from('fixture_metadata')));
 const download=await request('/download');assert.equal(download.status,200);assert.equal(download.headers.get('x-backup-sha256'),original.checksum);assert.deepEqual(Buffer.from(await download.arrayBuffer()),original.bytes);
 const next=enqueueSelfBackup(administrator);await executeSelfBackup(claimSelfBackup());assert.equal(selfBackupStatus().latest.id,next.id);
 assert.equal([...fixture.files.keys()].filter(name=>name.endsWith('.dkit')).length,1);
 assert.equal((await storageCapacity()).used,selfBackupStatus().latest.size);
 const saved=await readLatestSelfBackup(),master=await readFile(process.env.MASTER_KEY_FILE);
 await writeFile(process.env.MASTER_KEY_FILE,'invalid');enqueueSelfBackup(administrator);await executeSelfBackup(claimSelfBackup());
 assert.equal(selfBackupStatus().lastAttempt.status,'failed');assert.equal(selfBackupStatus().latest.id,next.id);assert.deepEqual((await readLatestSelfBackup()).bytes,saved.bytes);await writeFile(process.env.MASTER_KEY_FILE,master);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,0);
});
test('scheduled runs deduplicate and imported kits pause self-backup and revoke sessions',async()=>{
 saveSelfBackupSettings({...settings,enabled:true},administrator);
 const due=new Date(selfBackupStatus().settings.nextRun);tickSelfBackup(new Date(due.getTime()-1));assert.equal(selfBackupStatus().active,null);
 tickSelfBackup(due);tickSelfBackup(due);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM manager_backups WHERE status='queued'").get().n,1);
 await executeSelfBackup(claimSelfBackup());
 const fresh=join(root,'fresh-manager'),input=join(root,'downloaded.dkit');await writeFile(input,(await readLatestSelfBackup()).bytes);
 await restoreRecoveryKit({input,directory:fresh,passphrase});
 const restored=new DatabaseSync(join(fresh,'state.sqlite'));
 assert.equal(restored.prepare("SELECT value FROM settings WHERE key='fixture_metadata'").get().value,'preserved');
 assert.equal(JSON.parse(restored.prepare("SELECT value FROM settings WHERE key='manager_backup_config'").get().value).enabled,false);
 assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM manager_backups').get().n,0);restored.close();
 assert.equal(await readFile(join(fresh,'master.key'),'utf8'),await readFile(process.env.MASTER_KEY_FILE,'utf8'));
});
test('queued uploads keep their selected destination; failed transfer stages and host key changes keep the prior kit',async()=>{
 const prior=selfBackupStatus().latest;
 for(const fault of ['fsync','rename','corruptReads']){
  fixture.faults[fault]=true;enqueueSelfBackup(administrator);await executeSelfBackup(claimSelfBackup());fixture.faults[fault]=false;
  assert.equal(selfBackupStatus().lastAttempt.status,'failed');assert.equal(selfBackupStatus().latest.id,prior.id);
 }
 const pinned=db.prepare('SELECT host_key FROM storage_targets WHERE id=?').get(target).host_key;
 db.prepare('UPDATE storage_targets SET host_key=? WHERE id=?').run('0'.repeat(64),target);
 enqueueSelfBackup(administrator);await executeSelfBackup(claimSelfBackup());assert.equal(selfBackupStatus().latest.id,prior.id);
 db.prepare('UPDATE storage_targets SET host_key=? WHERE id=?').run(pinned,target);
 const queued=enqueueSelfBackup(administrator);db.prepare("UPDATE settings SET value=? WHERE key='backup_storage_target'").run(secondTarget);
 await executeSelfBackup(claimSelfBackup());
 assert.equal(db.prepare('SELECT target_id FROM manager_backups WHERE id=?').get(queued.id).target_id,target);
 assert.match(db.prepare('SELECT path FROM manager_backups WHERE id=?').get(queued.id).path,/\/backups\/docknest-manager\//);
 enqueueSelfBackup(administrator);await executeSelfBackup(claimSelfBackup());
 assert.equal(selfBackupStatus().latest.storage.name,'Other destination');
 assert.equal([...fixture.files.keys()].filter(name=>name.endsWith('.dkit')).length,1);
 assert.equal(fixture.files.get('/backups/unrelated-file').toString(),'preserved');
 assert.ok(fixture.events.some(event=>event.operation==='fsync'));assert.ok(fixture.events.some(event=>event.operation==='rename'));
});
test('active downloads protect the old copy during replacement and expired leases allow cleanup',async()=>{
 const old=selfBackupStatus().latest,lease=id();db.prepare('INSERT INTO manager_backup_downloads VALUES(?,?,?)').run(lease,old.id,Date.now()+60000);
 enqueueSelfBackup(administrator);await executeSelfBackup(claimSelfBackup());assert.ok(db.prepare('SELECT 1 FROM manager_backups WHERE id=?').get(old.id));
 db.prepare('UPDATE manager_backup_downloads SET expires_at=0 WHERE id=?').run(lease);await pruneSelfBackups();
 assert.equal(db.prepare('SELECT 1 FROM manager_backups WHERE id=?').get(old.id),undefined);
 assert.equal([...fixture.files.keys()].filter(name=>name.endsWith('.dkit')).length,1);
});
test('interrupted runs keep the last kit and tampered downloads fail closed',async()=>{
 const latest=selfBackupStatus().latest;enqueueSelfBackup(administrator);claimSelfBackup();await recoverInterruptedSelfBackups();
 assert.equal(selfBackupStatus().latest.id,latest.id);assert.equal(selfBackupStatus().active,null);
 const row=db.prepare('SELECT path FROM manager_backups WHERE id=?').get(latest.id),file=row.path.slice(row.path.indexOf(':/')+1),bytes=fixture.files.get(file);bytes[50]^=1;
 await assert.rejects(readLatestSelfBackup(),/file integrity/);assert.equal((await request('/download')).status,503);
});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));await fixture.close();db.close();await rm(root,{recursive:true,force:true});});
