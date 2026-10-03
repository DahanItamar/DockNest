import { mkdtemp,readFile,rm,mkdir,realpath,readdir } from 'node:fs/promises';
import { openSync,closeSync,readFileSync,lstatSync,createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { db,id,audit,transaction } from './db.js';
import { config } from './config.js';
import { seal,open,digest } from './crypto.js';
import { exportRecoveryKit } from './recovery-kit.js';
import { backupRoot,managerBackupFilename } from './backup-layout.js';
import { activeStorage,targetOptions,managerBackupDirectory,storageJoin,makeDirectory,openWrite,openRead,syncFile,renameFile,removeFile } from './storage.js';

const now=()=>new Date().toISOString(),settingsKey='manager_backup_config';
const packageInfo=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const release=process.env.DOCKNEST_RELEASE||packageInfo.version;
const schema=z.object({enabled:z.boolean(),schedule:z.string().trim().max(100).default('0 3 * * *'),timezone:z.string().max(100).default('UTC'),passphrase:z.string().min(24).max(4096).optional(),recoverySecretSaved:z.literal(true)});
export const selfBackupConfig=()=>JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(settingsKey)?.value||'null');
const active=()=>db.prepare("SELECT * FROM manager_backups WHERE status IN ('queued','running')").get();
function destination(){try{const selected=activeStorage();return selected.mode==='sftp'?{id:selected.id,name:selected.name||'Deployment SFTP destination',root:selected.root,recoveryDirectory:backupRoot(selected.root)+'/docknest-recovery',available:true}:{available:false};}catch{return {available:false};}}
function runStorage(row){
 if(!row?.path)return {mode:'local',name:'Local copy from before remote storage was enabled'};
 try{return {mode:'sftp',name:targetOptions(row.target_id).name||'Deployment SFTP destination'};}catch{return {mode:'sftp',name:'Original SFTP destination unavailable'};}
}
export function selfBackupStatus(){
 const saved=selfBackupConfig();
 const publicRun=row=>row?{id:row.id,status:row.status,createdAt:row.created_at,finishedAt:row.finished_at,size:row.size,checksum:row.checksum,release:row.release,error:row.error,storage:runStorage(row)}:null;
 return {destination:destination(),settings:saved?{enabled:saved.enabled,schedule:saved.schedule,timezone:saved.timezone,nextRun:saved.nextRun,hasPassphrase:!!saved.passphrase}:null,latest:publicRun(db.prepare("SELECT * FROM manager_backups WHERE status='completed' ORDER BY rowid DESC LIMIT 1").get()),active:publicRun(active()),lastAttempt:publicRun(db.prepare('SELECT * FROM manager_backups ORDER BY rowid DESC LIMIT 1').get()),retention:1};
}
export function saveSelfBackupSettings(input,actor){
 const data=schema.parse(input);
 let nextRun;try{nextRun=CronExpressionParser.parse(data.schedule,{tz:data.timezone}).next().toISOString();}catch{throw Object.assign(new Error('Use a valid schedule and IANA time zone.'),{status:400});}
 return transaction(()=>{
  if(active())throw Object.assign(new Error('Wait for the current DockNest backup before changing its settings.'),{status:409});
  const previous=selfBackupConfig();
  if(!data.passphrase&&!previous?.passphrase)throw Object.assign(new Error('Enter a separate recovery passphrase of at least 24 characters.'),{status:400});
  const saved={enabled:data.enabled,schedule:data.schedule,timezone:data.timezone,nextRun:data.enabled?nextRun:null,passphrase:data.passphrase?seal(data.passphrase):previous.passphrase};
  db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(settingsKey,JSON.stringify(saved));
  audit(actor,'manager-backup.settings',null,{enabled:data.enabled,passphraseChanged:!!data.passphrase});return {saved:true};
 });
}
function queue(actor){
 if(!selfBackupConfig()?.passphrase)throw Object.assign(new Error('Set up DockNest self-backup first.'),{status:409});
 if(active())throw Object.assign(new Error('A DockNest backup is already queued or running.'),{status:409});
 const selected=destination();if(!selected.available)throw Object.assign(new Error('Select a connected SFTP destination in Storage before backing up DockNest.'),{status:409});
 const runId=id();db.prepare("INSERT INTO manager_backups(id,status,created_at,release,target_id) VALUES(?,'queued',?,?,?)").run(runId,now(),release,selected.id);
 audit(actor,'manager-backup.queued',runId,{targetId:selected.id});return {id:runId,status:'queued'};
}
export const enqueueSelfBackup=actor=>transaction(()=>queue(actor));
export function tickSelfBackup(currentDate=new Date()){
 transaction(()=>{
  const saved=selfBackupConfig();if(!saved?.enabled||active())return;
  if(saved.nextRun&&new Date(saved.nextRun)>currentDate)return;
  if(!destination().available)return;
  queue('scheduler');saved.nextRun=CronExpressionParser.parse(saved.schedule,{tz:saved.timezone,currentDate}).next().toISOString();
  db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(saved),settingsKey);
 });
}
export function claimSelfBackup(){
 return transaction(()=>{const run=db.prepare("SELECT * FROM manager_backups WHERE status='queued'").get();if(!run)return null;db.prepare("UPDATE manager_backups SET status='running' WHERE id=?").run(run.id);return run;});
}
async function directory(){
 const root=join(config.dataDir,'manager-backups');await mkdir(root,{recursive:true,mode:0o700});
 if(await realpath(root)!==join(await realpath(config.dataDir),'manager-backups'))throw new Error('Manager backup directory cannot be a symlink');
 return root;
}
function filename(root,runId){return join(root,z.uuid().parse(runId)+'.dkit');}
export async function pruneSelfBackups(){
 db.prepare('DELETE FROM manager_backup_downloads WHERE expires_at<=?').run(Date.now());
 const latest=db.prepare("SELECT id FROM manager_backups WHERE status='completed' ORDER BY rowid DESC LIMIT 1").get();
 const lastAttempt=db.prepare('SELECT id FROM manager_backups ORDER BY rowid DESC LIMIT 1').get();
 for(const row of db.prepare("SELECT * FROM manager_backups WHERE status IN ('completed','failed') AND id<>? AND NOT EXISTS(SELECT 1 FROM manager_backup_downloads d WHERE d.backup_id=manager_backups.id)").all(latest?.id||'')){
  try{
   if(row.path){validateRemotePath(row);for(const file of [row.path+'.partial',row.path])try{await removeFile(file);}catch(error){if(error.code!==2&&error.code!=='ENOENT')throw error;}}
   else await rm(filename(await directory(),row.id),{force:true});
   if(row.id!==lastAttempt?.id)db.prepare('DELETE FROM manager_backups WHERE id=?').run(row.id);
  }catch{/* Keep the previous copy and retry cleanup later. */}
 }
}
function validateRemotePath(row){
 const selected=targetOptions(row.target_id),prefix='sftp:'+selected.id+':',runId=z.uuid().parse(row.id);
 const recovery=prefix+backupRoot(selected.root)+'/docknest-recovery/',legacy=prefix+selected.root.replace(/\/+$/,'')+'/docknest-manager/';
 const current=row.path.startsWith(recovery)&&new RegExp('^docknest_[a-f0-9]{16}_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}Z--'+runId+'\\.dkit$').test(row.path.slice(recovery.length));
 const previous=row.path.startsWith(legacy)&&new RegExp('^[a-f0-9]{16}/'+runId+'\\.dkit$').test(row.path.slice(legacy.length));
 if(selected.mode!=='sftp'||!(current||previous))throw new Error('Invalid manager backup path');
}
async function remoteHash(file){const hash=createHash('sha256');for await(const chunk of await openRead(file))hash.update(chunk);return hash.digest('hex');}
export async function executeSelfBackup(run){
 let temporary;
 try{
  const targetId=run.target_id||destination().id;
  if(!targetId)throw new Error('Select a connected SFTP destination');
  const root=await directory(),saved=selfBackupConfig();temporary=await mkdtemp(join(root,'.pending-'));
  const file=join(temporary,'manager.dkit');
  const evidence=await exportRecoveryKit({database:db,masterKey:config.masterKey,output:file,passphrase:open(saved.passphrase),release});
  const bytes=await readFile(file);if(digest(bytes)!==evidence.sha256)throw new Error('Recovery kit checksum mismatch');
  const remoteDirectory=managerBackupDirectory(targetId,evidence.keyId),published=storageJoin(remoteDirectory,managerBackupFilename(evidence.keyId,run.id,new Date(run.created_at)));
  db.prepare('UPDATE manager_backups SET target_id=?,path=? WHERE id=?').run(targetId,published,run.id);
  await makeDirectory(remoteDirectory);await pipeline(createReadStream(file),await openWrite(published+'.partial'));await syncFile(published+'.partial');
  if(await remoteHash(published+'.partial')!==evidence.sha256)throw new Error('Uploaded recovery kit checksum mismatch');
  await renameFile(published+'.partial',published);
  if(await remoteHash(published)!==evidence.sha256)throw new Error('Published recovery kit checksum mismatch');
  transaction(()=>{db.prepare("UPDATE manager_backups SET status='completed',finished_at=?,checksum=?,size=?,error=NULL WHERE id=?").run(now(),evidence.sha256,bytes.length,run.id);audit('worker','manager-backup.completed',run.id,{size:bytes.length,release});});
 }catch{
  // Exception text may contain credential or archive contents; never persist it.
  db.prepare("UPDATE manager_backups SET status='failed',finished_at=?,error=? WHERE id=?").run(now(),'DockNest backup failed. Check storage access, free space and the recovery configuration. Your previous successful copy is kept.',run.id);
  audit('worker','manager-backup.failed',run.id);
 }finally{if(temporary)try{await rm(temporary,{recursive:true,force:true});}catch{/* Retry interrupted staging cleanup at worker startup. */}}
 try{await pruneSelfBackups();}catch{/* Cleanup failure must not prevent ordinary site jobs. */}
}
export async function recoverInterruptedSelfBackups(){
 if(!db.prepare('SELECT 1 FROM manager_backups LIMIT 1').get())return;
 db.prepare("UPDATE manager_backups SET status='failed',finished_at=?,error='Worker interrupted. Previous successful DockNest backup is kept.' WHERE status='running'").run(now());
 try{const root=await directory();
  for(const name of await readdir(root))if(/^\.pending-[a-zA-Z0-9]+$/.test(name))await rm(join(root,name),{recursive:true,force:true});
  await pruneSelfBackups();
 }catch{/* Optional kit cleanup must not prevent ordinary site jobs. */}
}
export async function readLatestSelfBackup(){
 const lease=id(),row=transaction(()=>{
  const row=db.prepare("SELECT * FROM manager_backups WHERE status='completed' ORDER BY rowid DESC LIMIT 1").get();
  if(!row)throw Object.assign(new Error('No successful DockNest backup is available yet.'),{status:404});
  db.prepare('INSERT INTO manager_backup_downloads VALUES(?,?,?)').run(lease,row.id,Date.now()+3600000);return row;
 });
 try{
  if(row.path){
   validateRemotePath(row);const chunks=[];let size=0;
   for await(const chunk of await openRead(row.path)){size+=chunk.length;if(size>128*1024*1024+1024)throw new Error('Recovery kit exceeds size limit');chunks.push(chunk);}
   const bytes=Buffer.concat(chunks);if(digest(bytes)!==row.checksum)throw new Error('Recovery kit checksum mismatch');return {bytes,checksum:row.checksum};
  }
  const root=await directory();
  let handle;
  try{
   const file=filename(root,row.id),info=lstatSync(file);
   if(!info.isFile()||info.isSymbolicLink()||info.size>128*1024*1024+1024)throw new Error('Invalid kit file');
   handle=openSync(file,'r');const bytes=readFileSync(handle);
   if(digest(bytes)!==row.checksum)throw new Error('Recovery kit checksum mismatch');return {bytes,checksum:row.checksum};
  }finally{if(handle!==undefined)closeSync(handle);}
 }catch{throw Object.assign(new Error('Unable to read the saved DockNest backup. Check storage access and file integrity.'),{status:503});}
 finally{db.prepare('DELETE FROM manager_backup_downloads WHERE id=?').run(lease);}
}
