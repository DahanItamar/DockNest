import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rename,rm,stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const root=await mkdtemp(join(tmpdir(),'docknest-journals-'));
process.env.DATA_DIR=root;process.env.BACKUP_DIR=root;process.env.BACKUP_STORAGE='local';process.env.NODE_ENV='test';
await writeFile(join(root,'master.key'),randomBytes(32).toString('base64'));
const {db}=await import('../src/db.js');
const {encryptStream,verifyEncrypted}=await import('../src/engine.js');
const {preparePublication,authenticatePublication,reconcileArtifacts,claimDeletion,finishDeletion}=await import('../src/artifact-journal.js');
const {recordVerification,backupVerification}=await import('../src/recovery-evidence.js');
const {syncFile}=await import('../src/storage.js');
after(async()=>{db.close();await rm(root,{recursive:true,force:true});});
test('reconciliation recovers authenticated packages on either side of rename, refuses partials, and completes interrupted retention',async()=>{
 const at=new Date().toISOString();
 db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run('host','Fixture','localhost',22,'root','encrypted','0'.repeat(64),at);
 db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run('site','host','Fixture','{}',at);
 for(const scenario of ['partial','before-rename','after-rename','corrupt']){
  const temporary=join(root,scenario+'.partial'),published=join(root,scenario+'.enc');
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,'site','backup','recovery_required','recovery_required',?)").run(scenario,at);
  await encryptStream(Readable.from(['snapshot']),createWriteStream(temporary));
  preparePublication({backupId:scenario,jobId:scenario,siteId:'site',temporary,published,manifest:{consistency:{status:'declared'}},capturedAt:at});
  if(scenario!=='partial')authenticatePublication(scenario,await verifyEncrypted(temporary),(await stat(temporary)).size);
  if(scenario==='after-rename')await rename(temporary,published);
  if(scenario==='corrupt'){const bytes=await readFile(temporary);bytes[20]^=1;await writeFile(temporary,bytes);}
 }
 const result=await reconcileArtifacts(verifyEncrypted);assert.equal(result.published,2);assert.equal(result.pending,1);
 assert.equal(db.prepare("SELECT 1 FROM backups WHERE id='partial'").get(),undefined);await assert.rejects(stat(join(root,'partial.partial')));
 assert.equal(db.prepare("SELECT 1 FROM backups WHERE id='corrupt'").get(),undefined);assert.ok(await stat(join(root,'corrupt.partial')));
 assert.equal(backupVerification('after-rename').consistency.status,'declared');
 assert.equal((await reconcileArtifacts(verifyEncrypted)).published,0,'Adoption is idempotent');
 recordVerification('after-rename','application',{status:'passed',scope:'configured fixture check'});
 assert.equal(claimDeletion('after-rename'),false,'Latest recovery-tested point is protected');
 assert.equal(claimDeletion('before-rename'),true);await rm(join(root,'before-rename.enc'));
 await finishDeletion('before-rename');assert.equal(db.prepare("SELECT 1 FROM backups WHERE id='before-rename'").get(),undefined);
});

test('startup checks invalidate missing or resized completed packages without repairing them',async()=>{
 const at=new Date().toISOString();
 for(const scenario of ['completed-missing','completed-size']){
  const temporary=join(root,scenario+'.partial'),published=join(root,scenario+'.enc');
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,'site','backup','running','verifying',?)").run(scenario,at);
  await encryptStream(Readable.from(['completed snapshot']),createWriteStream(temporary));await syncFile(temporary);
  preparePublication({backupId:scenario,jobId:scenario,siteId:'site',temporary,published,manifest:{consistency:{status:'declared'}},capturedAt:at});
  authenticatePublication(scenario,await verifyEncrypted(temporary),(await stat(temporary)).size);
 }
 assert.equal((await reconcileArtifacts(verifyEncrypted)).published,2);
 await rm(join(root,'completed-missing.enc'));await writeFile(join(root,'completed-size.enc'),'truncated');
 await reconcileArtifacts(verifyEncrypted);
 assert.equal(db.prepare("SELECT verified FROM backups WHERE id='completed-missing'").get().verified,1,'Periodic reconciliation does not silently claim a completed-package audit');
 const result=await reconcileArtifacts(verifyEncrypted,{checkCompleted:true});
 assert.equal(result.pending,3,'Two unavailable completed packages and the earlier corrupt pending package require review');
 for(const scenario of ['completed-missing','completed-size']){
  assert.equal(db.prepare('SELECT verified FROM backups WHERE id=?').get(scenario).verified,0);
  assert.equal(backupVerification(scenario).integrity.status,'failed');
  assert.equal(db.prepare('SELECT state FROM artifact_operations WHERE backup_id=?').get(scenario).state,'completed','No publication repair or new completion is invented');
 }
 await assert.rejects(stat(join(root,'completed-missing.enc')));
 assert.equal(await readFile(join(root,'completed-size.enc'),'utf8'),'truncated');
});

test('retention preserves historical latest and currently passing recovery points after a later failure',()=>{
 const site='retention-site';db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(site,'host','Retention fixture','{}',new Date().toISOString());
 for(const [backupId,capturedAt] of [['old-pass','2026-10-01T00:00:00.000Z'],['new-pass','2026-10-02T00:00:00.000Z'],['untested','2026-10-03T00:00:00.000Z']]){
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','completed','completed',?)").run(backupId,site,capturedAt);
  db.prepare('INSERT INTO backups(id,site_id,job_id,captured_at,path,size,checksum,manifest,pinned,verified,created_at) VALUES(?,?,?,?,?,40,?,\'{}\',0,1,?)').run(backupId,site,backupId,capturedAt,join(root,backupId+'.enc'),'a'.repeat(64),capturedAt);
 }
 for(const backupId of ['old-pass','new-pass'])recordVerification(backupId,'application',{status:'passed',scope:'successful configured recovery'});
 recordVerification('new-pass','application',{status:'failed',scope:'later recovery attempt'});
 assert.equal(claimDeletion('new-pass'),false,'The latest historical successful recovery remains protected');
 assert.equal(claimDeletion('old-pass'),false,'The older currently passing recovery remains protected too');
 assert.equal(claimDeletion('untested'),true,'An untested package gains no recovery protection');
 assert.equal(backupVerification('new-pass').application.status,'failed','Protection does not relabel the failed attempt');
});
