// Local encrypted recovery kits only. No third-party storage transfer.
import { mkdtemp,readFile,rm,mkdir,realpath,rename,readdir,open as openFile } from 'node:fs/promises';
import { openSync,closeSync,readFileSync,lstatSync } from 'node:fs';
import { join } from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { db,id,audit,transaction } from './db.js';
import { config } from './config.js';
import { seal,open,digest } from './crypto.js';
import { exportRecoveryKit } from './recovery-kit.js';

const now=()=>new Date().toISOString(),settingsKey='manager_backup_config';
const packageInfo=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const release=process.env.DOCKNEST_RELEASE||packageInfo.version;
const schema=z.object({enabled:z.boolean(),schedule:z.string().trim().max(100).default('0 3 * * *'),timezone:z.string().max(100).default('UTC'),passphrase:z.string().min(24).max(4096).optional(),recoverySecretSaved:z.literal(true)});
export const selfBackupConfig=()=>JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(settingsKey)?.value||'null');
const active=()=>db.prepare("SELECT * FROM manager_backups WHERE status IN ('queued','running')").get();
export function selfBackupStatus(){
 const saved=selfBackupConfig();
 const publicRun=row=>row?{id:row.id,status:row.status,createdAt:row.created_at,finishedAt:row.finished_at,size:row.size,checksum:row.checksum,release:row.release,error:row.error}:null;
 return {settings:saved?{enabled:saved.enabled,schedule:saved.schedule,timezone:saved.timezone,nextRun:saved.nextRun,hasPassphrase:!!saved.passphrase}:null,latest:publicRun(db.prepare("SELECT * FROM manager_backups WHERE status='completed' ORDER BY created_at DESC,id DESC LIMIT 1").get()),active:publicRun(active()),lastAttempt:publicRun(db.prepare('SELECT * FROM manager_backups ORDER BY created_at DESC,id DESC LIMIT 1').get()),retention:1};
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
 const runId=id();db.prepare("INSERT INTO manager_backups(id,status,created_at,release) VALUES(?,'queued',?,?)").run(runId,now(),release);
 audit(actor,'manager-backup.queued',runId);return {id:runId,status:'queued'};
}
export const enqueueSelfBackup=actor=>transaction(()=>queue(actor));
export function tickSelfBackup(currentDate=new Date()){
 transaction(()=>{
  const saved=selfBackupConfig();if(!saved?.enabled||active())return;
  if(saved.nextRun&&new Date(saved.nextRun)>currentDate)return;
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
 const root=await directory(),latest=db.prepare("SELECT id FROM manager_backups WHERE status='completed' ORDER BY created_at DESC,id DESC LIMIT 1").get();
 const lastAttempt=db.prepare('SELECT id FROM manager_backups ORDER BY rowid DESC LIMIT 1').get();
 for(const row of db.prepare("SELECT * FROM manager_backups WHERE status IN ('completed','failed') AND id<>?").all(latest?.id||'')){
  try{await rm(filename(root,row.id),{force:true});if(row.id!==lastAttempt?.id)db.prepare('DELETE FROM manager_backups WHERE id=?').run(row.id);}catch{/* Keep the previous copy and retry cleanup later. */}
 }
}
async function syncDirectory(root){if(process.platform!=='win32'){const handle=await openFile(root,'r');try{await handle.sync();}finally{await handle.close();}}}
export async function executeSelfBackup(run){
 let temporary;
 try{
  const root=await directory(),saved=selfBackupConfig();temporary=await mkdtemp(join(root,'.pending-'));
  const file=join(temporary,'manager.dkit');
  const evidence=await exportRecoveryKit({database:db,masterKey:config.masterKey,output:file,passphrase:open(saved.passphrase),release});
  const bytes=await readFile(file);if(digest(bytes)!==evidence.sha256)throw new Error('Recovery kit checksum mismatch');
  const destination=filename(root,run.id);await rename(file,destination);await syncDirectory(root);
  if(digest(await readFile(destination))!==evidence.sha256)throw new Error('Published recovery kit checksum mismatch');
  transaction(()=>{db.prepare("UPDATE manager_backups SET status='completed',finished_at=?,checksum=?,size=?,error=NULL WHERE id=?").run(now(),evidence.sha256,bytes.length,run.id);audit('worker','manager-backup.completed',run.id,{size:bytes.length,release});});
 }catch{
  // Exception text may contain credential or archive contents; never persist it.
  db.prepare("UPDATE manager_backups SET status='failed',finished_at=?,error=? WHERE id=?").run(now(),'DockNest backup failed. Check local free space and the recovery configuration. Your previous successful copy is kept.',run.id);
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
 // Open the local handle before yielding so retention cannot race this download.
 const root=await directory();
 return transaction(()=>{
  const row=db.prepare("SELECT * FROM manager_backups WHERE status='completed' ORDER BY created_at DESC,id DESC LIMIT 1").get();
  if(!row)throw Object.assign(new Error('No successful DockNest backup is available yet.'),{status:404});
  let handle;
  try{
   const file=filename(root,row.id),info=lstatSync(file);
   if(!info.isFile()||info.isSymbolicLink()||info.size>128*1024*1024+1024)throw new Error('Invalid kit file');
   handle=openSync(file,'r');const bytes=readFileSync(handle);
   if(digest(bytes)!==row.checksum)throw new Error('Recovery kit checksum mismatch');return {bytes,checksum:row.checksum};
  }catch{throw Object.assign(new Error('Unable to read the saved DockNest backup. Check file integrity and local access.'),{status:503});}
  finally{if(handle!==undefined)closeSync(handle);}
 });
}
