import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {startSftpFixture} from './sftp-fixture.js';
import {backupFilename,managerBackupFilename} from '../src/backup-layout.js';

const root=await mkdtemp(join(tmpdir(),'docknest-storage-layout-'));
Object.assign(process.env,{DATA_DIR:root,MASTER_KEY_FILE:join(root,'master.key'),NODE_ENV:'test',BACKUP_STORAGE:'unconfigured'});
await writeFile(process.env.MASTER_KEY_FILE,randomBytes(32).toString('base64'));
const {db,id}=await import('../src/db.js'),{seal}=await import('../src/crypto.js');
const {backupDirectory,managerBackupDirectory,storageJoin,makeDirectory,openWrite,statFile,syncFile}=await import('../src/storage.js');
const {encryptStream,verifyEncrypted}=await import('../src/engine.js');
const {preparePublication,authenticatePublication,reconcileArtifacts,claimDeletion,finishDeletion}=await import('../src/artifact-journal.js');
const fixture=await startSftpFixture(),target=id(),at=new Date('2026-10-03T12:13:14Z');
db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(target,'Fixture',fixture.options.host,fixture.options.port,fixture.options.username,fixture.options.hostKey,'password',seal(fixture.options.password),'/backups',1e12,'connected',at.toISOString(),at.toISOString());
db.prepare("INSERT INTO settings VALUES('backup_storage_target',?)").run(target);
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run('server-1','Production / EU','localhost',22,'fixture','synthetic','0'.repeat(64),at.toISOString());
db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run('site-1','server-1','My Shop','{}',at.toISOString());
after(async()=>{await fixture.close();db.close();await rm(root,{recursive:true,force:true});});

test('SFTP publications, interrupted cleanup and retention share the strict server/site folder safely',async()=>{
 const directory=backupDirectory({id:'server-1',name:'Production / EU'},{id:'site-1',name:'My Shop'});
 assert.equal(directory,'sftp:'+target+':/backups/BACKUP/production-eu--server-1/my-shop--site-1');
 await makeDirectory(directory);
 for(const backupId of ['first','second','interrupted']){
  const published=storageJoin(directory,backupFilename(backupId,at)),temporary=published+'.partial';
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,'site-1','backup','running','transferring',?)").run(backupId,at.toISOString());
  await encryptStream(Readable.from(['synthetic archive']),await openWrite(temporary));await syncFile(temporary);
  preparePublication({backupId,jobId:backupId,siteId:'site-1',temporary,published,manifest:{},capturedAt:at.toISOString()});
  if(backupId!=='interrupted')authenticatePublication(backupId,await verifyEncrypted(temporary),(await statFile(temporary)).size);
 }
 assert.equal((await reconcileArtifacts(verifyEncrypted)).published,2);
 const stored=[...fixture.files.keys()];
 assert.equal(stored.length,2);assert.ok(stored.every(file=>/^\/backups\/BACKUP\/production-eu--server-1\/my-shop--site-1\/backup_2026-10-03_12-13-14Z--(first|second)\.tar\.gz\.enc$/.test(file)));
 assert.equal(claimDeletion('first'),true);await finishDeletion('first');
 assert.equal([...fixture.files.keys()].length,1);assert.ok(await verifyEncrypted(db.prepare("SELECT path FROM backups WHERE id='second'").get().path));
});
test('recovery kits are direct siblings of server folders and a configured BACKUP root is reused',()=>{
 const keyId='0123456789abcdef';
 assert.equal(storageJoin(managerBackupDirectory(target,keyId),managerBackupFilename(keyId,'manager-1',at)),'sftp:'+target+':/backups/BACKUP/docknest-recovery/docknest_0123456789abcdef_2026-10-03_12-13-14Z--manager-1.dkit');
 db.prepare('UPDATE storage_targets SET root=? WHERE id=?').run('/backups/BACKUP',target);
 assert.equal(backupDirectory('server-1','site-1'),'sftp:'+target+':/backups/BACKUP/server-1--server-1/site-1--site-1');
 assert.equal(managerBackupDirectory(target,keyId),'sftp:'+target+':/backups/BACKUP/docknest-recovery');
});
