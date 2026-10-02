import test from 'node:test';
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
 db.close();await rm(root,{recursive:true,force:true});
});
