import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
const temporary=await mkdtemp(join(tmpdir(),'dbm-engine-'));
process.env.DATA_DIR=join(temporary,'data');
const {encryptStream,verifyEncrypted}=await import('../src/engine.js');
test('authenticated streaming backup rejects tampering, truncation and wrong key',async()=>{
 const secret=randomBytes(32),file=join(temporary,'capture.enc');
 await encryptStream(Readable.from([Buffer.alloc(128*1024,43),Buffer.from('site snapshot')]),createWriteStream(file),secret);
 const digest=await verifyEncrypted(file,secret);assert.match(digest,/^[a-f0-9]{64}$/);
 await assert.rejects(verifyEncrypted(file,randomBytes(32)));
 const bytes=await readFile(file);bytes[64]^=1;await writeFile(join(temporary,'corrupt.enc'),bytes);
 await assert.rejects(verifyEncrypted(join(temporary,'corrupt.enc'),secret));
 await writeFile(join(temporary,'short.enc'),bytes.subarray(0,20));
 await assert.rejects(verifyEncrypted(join(temporary,'short.enc'),secret),/Truncated/);
});
test('durable queue prevents site overlap and serializes source server jobs',async()=>{
 const {db}=await import('../src/db.js');const {enqueueBackup,claimJob}=await import('../src/engine.js');
 for(const server of ['server-a','server-b'])db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(server,server,'localhost',22,'root','encrypted','a'.repeat(64),'unchecked',new Date().toISOString());
 for(const [site,server] of [['site-a','server-a'],['site-b','server-a'],['site-c','server-b']])db.prepare('INSERT INTO sites(id,server_id,name,config,created_at) VALUES(?,?,?,?,?)').run(site,server,site,'{}',new Date().toISOString());
 const first=enqueueBackup('site-a','test');assert.throws(()=>enqueueBackup('site-a','test'),/active/);
 enqueueBackup('site-b','test');const third=enqueueBackup('site-c','test');
 assert.equal(claimJob().id,first.id);assert.equal(claimJob().id,third.id);assert.equal(claimJob(),undefined);
 db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(first.id);assert.equal(claimJob().site_id,'site-b');
});
test('retention keeps pinned backups and active downloads then prunes oldest',async()=>{
 const {db}=await import('../src/db.js');const {retain}=await import('../src/engine.js');const {config}=await import('../src/config.js');
 const job=db.prepare("SELECT id FROM jobs WHERE site_id='site-a' LIMIT 1").get().id;
 db.prepare("INSERT INTO policies(site_id,enabled,schedule,timezone,retention) VALUES('site-a',0,'0 0 * * *','UTC',7)").run();
 for(let i=0;i<10;i++){
  const backupId='retention-'+i,file=join(config.backupDir,backupId+'.enc');await writeFile(file,'fixture');
  db.prepare('INSERT INTO backups(id,site_id,job_id,captured_at,path,size,checksum,manifest,pinned,verified,created_at) VALUES(?,?,?,?,?,?,?,?,?,1,?)').run(backupId,'site-a',job,new Date(2026,0,i+1).toISOString(),file,7,'checksum','{}',i===9?1:0,new Date().toISOString());
 }
 db.prepare('INSERT INTO downloads(id,backup_id,expires_at) VALUES(?,?,?)').run('active-download','retention-0',Date.now()+60000);
 await retain('site-a');
 assert.equal(db.prepare("SELECT count(*) AS n FROM backups WHERE site_id='site-a'").get().n,9);
 assert.ok(db.prepare("SELECT id FROM backups WHERE id='retention-0'").get());
 assert.equal(db.prepare("SELECT id FROM backups WHERE id='retention-1'").get(),undefined);
 assert.ok(db.prepare("SELECT id FROM backups WHERE id='retention-9' AND pinned=1").get());
 db.prepare("DELETE FROM downloads WHERE id='active-download'").run();await retain('site-a');
 assert.equal(db.prepare("SELECT count(*) AS n FROM backups WHERE site_id='site-a'").get().n,8);
 await assert.rejects(readFile(join(config.backupDir,'retention-0.enc')),/ENOENT/);
});
test.after(async()=>{const {db}=await import('../src/db.js');db.close();await rm(temporary,{recursive:true,force:true});});
