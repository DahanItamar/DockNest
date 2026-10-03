import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {startSftpFixture} from './sftp-fixture.js';
const root=await mkdtemp(join(tmpdir(),'docknest-migration-'));
Object.assign(process.env,{DATA_DIR:root,MASTER_KEY_FILE:join(root,'master.key'),NODE_ENV:'test',BACKUP_STORAGE:'unconfigured'});
await writeFile(process.env.MASTER_KEY_FILE,randomBytes(32).toString('base64'));
const {db}=await import('../src/db.js'),{seal}=await import('../src/crypto.js');
const {migrationPlan,migrateStorage}=await import('../src/storage-migration.js');
const fixture=await startSftpFixture(),at='2026-10-03T12:13:14Z',target='storage';
db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(target,'Fixture',fixture.options.host,fixture.options.port,fixture.options.username,fixture.options.hostKey,'password',seal(fixture.options.password),'/backups',1e12,'connected',at,at);
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run('server','Production','localhost',22,'fixture','synthetic','0'.repeat(64),at);
db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run('site','server','Shop','{}',at);
db.prepare("INSERT INTO settings VALUES('deployment_hold','true')").run();
const {makeDirectory}=await import('../src/storage.js');
await makeDirectory('sftp:storage:/backups/old');
function archive(id){
 const source='/backups/old/'+id+'.enc',bytes=Buffer.from('synthetic encrypted bytes '+id),checksum=createHash('sha256').update(bytes).digest('hex');
 fixture.files.set(source,bytes);
 db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,'site','backup','completed','completed',?)").run(id,at);
 db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,'site',id,at,'sftp:storage:'+source,bytes.length,checksum,'{}',1,1,at);
 return source;
}
after(async()=>{await fixture.close();db.close();await rm(root,{recursive:true,force:true});});
test('migration preserves bytes, pins, history and publication paths, retains originals and is repeatable',async()=>{
 const source=archive('first'),before=db.prepare("SELECT * FROM backups WHERE id='first'").get(),entry=migrationPlan()[0];
 db.prepare("INSERT INTO artifact_operations VALUES(?,?,?,?,?,'completed',?,?,?, ?,?)").run('first','first','site',before.path+'.partial',before.path,'{}',before.checksum,before.size,at,at);
 assert.deepEqual(await migrateStorage(),{migrated:1,originalsRetained:true});
 const afterRow=db.prepare("SELECT * FROM backups WHERE id='first'").get();assert.deepEqual({...afterRow,path:before.path},{...before});
 assert.deepEqual(fixture.files.get(entry.destination.slice('sftp:storage:'.length)),fixture.files.get(source));
 assert.equal(db.prepare("SELECT published FROM artifact_operations WHERE backup_id='first'").get().published,entry.destination);
 assert.equal((await migrateStorage()).migrated,0);
});
test('interrupted publication resumes from journal and corrupt source never updates metadata',async()=>{
 archive('retry');const entry=migrationPlan()[0];fixture.faults.rename=true;
 await assert.rejects(migrateStorage());assert.equal(db.prepare("SELECT path FROM backups WHERE id='retry'").get().path,entry.source);
 fixture.faults.rename=false;assert.equal((await migrateStorage()).migrated,1);
 const source=archive('corrupt'),original=db.prepare("SELECT path FROM backups WHERE id='corrupt'").get().path;
 fixture.files.get(source)[0]^=1;await assert.rejects(migrateStorage(),/checksum/);
 assert.equal(db.prepare("SELECT path FROM backups WHERE id='corrupt'").get().path,original);
 fixture.files.get(source)[0]^=1;
});
test('active downloads and destination collisions block changes; manager kits use recovery folder',async()=>{
 db.prepare('INSERT INTO downloads VALUES(?,?,?)').run('download','corrupt',Date.now()+60000);
 await assert.rejects(migrateStorage(),/Active operations/);db.prepare('DELETE FROM downloads').run();
 const entry=migrationPlan()[0],destination=entry.destination.slice('sftp:storage:'.length);
 // A journaled destination is also verified rather than overwritten.
 fixture.files.set(destination,Buffer.from('unrelated'));
 await assert.rejects(migrateStorage());fixture.files.delete(destination);await migrateStorage();
 const id='00000000-0000-4000-8000-000000000001',source='/backups/docknest-manager/0123456789abcdef/'+id+'.dkit',bytes=Buffer.from('synthetic encrypted recovery kit');
 fixture.files.set(source,bytes);
 db.prepare("INSERT INTO manager_backups(id,status,created_at,checksum,size,target_id,path) VALUES(?,'completed',?,?,?,?,?)").run(id,at,createHash('sha256').update(bytes).digest('hex'),bytes.length,target,'sftp:storage:'+source);
 assert.match(migrationPlan()[0].destination,/BACKUP\/docknest-recovery\/docknest_0123456789abcdef_/);
 assert.equal((await migrateStorage()).migrated,1);assert.ok(fixture.files.has(source));
});
