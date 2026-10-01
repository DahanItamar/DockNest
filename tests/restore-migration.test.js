import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('legacy restore migration preserves IDs and plans and allows finished-history retention',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'docknest-migration-'));
 const env={...process.env,DATA_DIR:directory,BACKUP_DIR:join(directory,'backups')};
 try{
  execFileSync(process.execPath,['--input-type=module','-e',"const {db}=await import('./src/db.js');db.close();"],{env});
  const old=new DatabaseSync(join(directory,'state.sqlite'));
  old.exec(`
   DROP TABLE restores;
   CREATE TABLE restores (id TEXT PRIMARY KEY,backup_id TEXT NOT NULL REFERENCES backups(id),server_id TEXT NOT NULL REFERENCES servers(id),mode TEXT NOT NULL,plan TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
   INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('host','fixture','localhost',22,'root','fixture','fixture','2026-01-01');
   INSERT INTO sites VALUES('site','host','fixture','{}','2026-01-01');
   INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES('job','site','backup','completed','completed','2026-01-01');
   INSERT INTO backups VALUES('backup','site','job','2026-01-01','fixture',10,'fixture','{}',0,1,'2026-01-01');
   INSERT INTO restores VALUES('restore','backup','host','new-copy','{"backupId":"backup","evidence":"preserved"}','completed','2026-01-01');
  `);old.close();
  const output=execFileSync(process.execPath,['--input-type=module','-e',"const {db}=await import('./src/db.js');console.log(JSON.stringify(db.prepare('SELECT * FROM restores').get()));db.prepare(\"DELETE FROM backups WHERE id='backup'\").run();console.log(JSON.stringify(db.prepare('SELECT * FROM restores').get()));db.close();"],{env,encoding:'utf8'});
  const [before,after]=output.trim().split('\n').map(JSON.parse);
  assert.equal(before.id,'restore');assert.equal(before.backup_id,'backup');assert.equal(JSON.parse(before.plan).evidence,'preserved');
  assert.equal(after.id,before.id);assert.equal(after.backup_id,null);assert.equal(after.plan,before.plan);
 }finally{await rm(directory,{recursive:true,force:true});}
});
