import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
// A worker that lost its lease must not overwrite the recovery_required status written by the new lease holder.
const root=await mkdtemp(join(tmpdir(),'dbm-supersede-'));
Object.assign(process.env,{DATA_DIR:join(root,'data'),BACKUP_DIR:join(root,'backups'),MASTER_KEY_FILE:join(root,'master.key'),BACKUP_STORAGE:'local',NODE_ENV:'test'});
await writeFile(process.env.MASTER_KEY_FILE,randomBytes(32).toString('base64'));
const {db}=await import('../src/db.js');
const {enqueueBackup,enqueueScrub,claimJob,executeJob}=await import('../src/engine.js');
const {executeSelfBackup}=await import('../src/self-backup.js');
const at=new Date().toISOString(),takeover="UPDATE jobs SET status='recovery_required',stage='recovery_required',error='Worker interrupted.' WHERE id=?";
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('server-x','x','127.0.0.1',1,'root','not-a-sealed-key','a'.repeat(64),'unchecked',at);
for(const site of ['site-x','site-y','site-z'])db.prepare('INSERT INTO sites(id,server_id,name,config,created_at) VALUES(?,?,?,?,?)').run(site,'server-x',site,'{}',at);
const status=job=>db.prepare('SELECT status,stage,error FROM jobs WHERE id=?').get(job);
test('a superseded backup job keeps recovery_required instead of being overwritten as failed',async()=>{
 const queued=enqueueBackup('site-x','test'),job=claimJob();assert.equal(job.id,queued.id);
 db.prepare(takeover).run(job.id);
 await executeJob(job);
 assert.deepEqual({...status(job.id)},{status:'recovery_required',stage:'recovery_required',error:'Worker interrupted.'});
 assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='job.superseded' AND target=?").get(job.id));
 db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(job.id);
});
test('a job still owned by this worker records its own failure',async()=>{
 enqueueBackup('site-y','test');const job=claimJob();await executeJob(job);
 assert.equal(status(job.id).status,'failed');
});
test('a superseded scrub keeps recovery_required',async()=>{
 db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES('job-origin','site-z','backup','completed','completed',?)").run(at);
 db.prepare("INSERT INTO backups(id,site_id,job_id,captured_at,path,size,checksum,manifest,created_at) VALUES('backup-z','site-z','job-origin',?,?,1,?,'{}',?)").run(at,join(root,'missing.enc'),'b'.repeat(64),at);
 const scrub=enqueueScrub('backup-z','test'),job=claimJob();assert.equal(job.id,scrub.id);
 db.prepare(takeover).run(job.id);await executeJob(job);
 assert.equal(status(job.id).status,'recovery_required');
 assert.equal(db.prepare("SELECT COUNT(*) n FROM backup_verifications WHERE backup_id='backup-z'").get().n,0);
 db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(job.id);
});
test('a superseded restore records no verification evidence and leaves the restore for recovery review',async()=>{
 db.prepare("INSERT INTO restores(id,backup_id,server_id,mode,plan,status,created_at) VALUES('restore-z','backup-z','server-x','new-copy','{}','queued',?)").run(at);
 const job={id:'job-restore',site_id:'site-z',type:'restore',status:'running',details:JSON.stringify({restoreId:'restore-z',backupId:'backup-z'})};
 db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,details) VALUES(?,?,?,?,?,?,?)").run(job.id,job.site_id,'restore','running','preflight',at,job.details);
 db.prepare(takeover).run(job.id);await executeJob(job);
 assert.equal(status(job.id).status,'recovery_required');
 assert.equal(db.prepare("SELECT status FROM restores WHERE id='restore-z'").get().status,'recovery_required');
 assert.equal(db.prepare("SELECT COUNT(*) n FROM backup_verifications WHERE backup_id='backup-z'").get().n,0);
});
test('a superseded DockNest self-backup keeps the outcome recorded by the new holder',async()=>{
 const insert=db.prepare("INSERT INTO manager_backups(id,status,created_at,error) VALUES(?,?,?,?)");
 insert.run('kit-old','failed',at,'Worker interrupted. Previous successful DockNest backup is kept.');
 await executeSelfBackup({id:'kit-old',created_at:at,target_id:null});
 assert.equal(db.prepare("SELECT error FROM manager_backups WHERE id='kit-old'").get().error,'Worker interrupted. Previous successful DockNest backup is kept.');
 insert.run('kit-own','running',at,null);
 await executeSelfBackup({id:'kit-own',created_at:at,target_id:null});
 assert.match(db.prepare("SELECT status,error FROM manager_backups WHERE id='kit-own'").get().error,/DockNest backup failed/);
});
