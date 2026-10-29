import { DatabaseSync,backup } from 'node:sqlite';
import { createCipheriv,createDecipheriv,scryptSync,randomBytes,createHash } from 'node:crypto';
import { mkdtemp,readFile,mkdir,rm,open,chmod,lstat,realpath } from 'node:fs/promises';
import { join,resolve,dirname } from 'node:path';
import { requireNoDeploymentHold } from './deployment-hold.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const names=['state.sqlite','master.key','recovery/decrypt-backup.js','recovery/helper.py','recovery/boot_recovery.py','recovery/export_zip.py','recovery/README.md'];
const maximum=128*1024*1024;
function derive(passphrase,salt){if(typeof passphrase!=='string'||passphrase.length<24||passphrase.length>4096)throw new Error('Use a separate recovery passphrase of at least 24 characters');return scryptSync(passphrase,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});}
const hasTable=(database,name)=>!!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
// True while the host updater's current.json shows an unfinished run. The status volume is mounted read-only at
// /run/docknest-updater only inside the api container, so the guard applies only there (or where DOCKNEST_UPDATER_STATUS
// points the command line); elsewhere the directory is absent and nothing is refused. No mount, no status directory
// or no current.json means no run. A recent file that cannot be read or validated fails closed. The refusal is
// bounded so it never blocks disaster recovery: the broker hard-stops every run after 2 h plus 15 min grace, so a
// current.json untouched for that plus 5 min belongs to a dead run.
export const updaterStatusDirectory='/run/docknest-updater/status',updaterRunLimitMs=(2*60+20)*60*1000;
export async function updaterRunActive(directory=updaterStatusDirectory,now=Date.now()){
 const read=async name=>{const file=join(directory,name),info=await lstat(file);if(!info.isFile()||info.size>16384)throw new Error('Invalid updater status');return JSON.parse(await readFile(file,'utf8'));};
 try{if(now-(await lstat(join(directory,'current.json'))).mtimeMs>updaterRunLimitMs)return false;}catch(error){return !['ENOENT','ENOTDIR'].includes(error.code);}
 let current;
 try{current=await read('current.json');}catch{return true;}
 if(typeof current?.requestId!=='string'||!Array.isArray(current.events))return true;
 if(['done','failed'].includes(current.events.at(-1)?.phase))return false;
 // An interrupted broker publishes ok:false for the request without adding a final event.
 try{const status=await read('status.json');if(status?.requestId===current.requestId&&typeof status.ok==='boolean')return false;}catch{/* No final status for this request. */}
 return true;
}
async function durableWrite(file,bytes){const handle=await open(file,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}
function validateKey(database,secret){
 for(const [table,field] of [['servers','private_key'],['storage_targets','credential'],['users','totp_secret']]){
  if(!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
  for(const row of database.prepare(`SELECT ${field} AS sealed FROM ${table} WHERE ${field}<>''`).all()){
   const bytes=Buffer.from(row.sealed,'base64');if(bytes.length<28)throw new Error('Manager key does not match encrypted snapshot');
   try{const decipher=createDecipheriv('aes-256-gcm',secret,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));decipher.update(bytes.subarray(28));decipher.final();}catch{throw new Error('Manager key does not match encrypted snapshot');}
  }
 }
}
export async function exportRecoveryKit({database,masterKey,output,passphrase,release='unknown'}){
 requireNoDeploymentHold(database);
 const parent=dirname(resolve(output));if(await realpath(parent)!==parent)throw new Error('Kit output parent cannot contain a symlink');
 const temporary=await mkdtemp(join(parent,'.docknest-kit-'));await chmod(temporary,0o700);
 try{
  const snapshot=join(temporary,'snapshot.sqlite');await backup(database,snapshot);await chmod(snapshot,0o600);
  const files={'state.sqlite':await readFile(snapshot),'master.key':await readFile(masterKey)};
  if(Buffer.from(files['master.key'].toString().trim(),'base64').length!==32)throw new Error('Invalid manager key');
  // Checked again on the consistent snapshot, so a hold set while the export was starting never lands in a new kit.
  const snapshotDb=new DatabaseSync(snapshot,{readOnly:true});try{requireNoDeploymentHold(snapshotDb);validateKey(snapshotDb,Buffer.from(files['master.key'].toString().trim(),'base64'));if(snapshotDb.prepare('PRAGMA quick_check').get().quick_check!=='ok'||snapshotDb.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Manager snapshot validation failed');}finally{snapshotDb.close();}
  for(const [name,url] of [['recovery/decrypt-backup.js','../scripts/decrypt-backup.js'],['recovery/helper.py','../remote/helper.py'],['recovery/boot_recovery.py','../remote/boot_recovery.py'],['recovery/export_zip.py','../remote/export_zip.py']])files[name]=await readFile(new URL(url,import.meta.url));
  files['recovery/README.md']=Buffer.from('Private recovery kit. Keep the recovery passphrase separately and a copy of the matching DockNest release image/source and environment configuration offline. Restore into a new private DATA_DIR; do not overwrite a live manager. Sessions and schedules are disabled during import. Reconnect storage with independently verified host keys; environment-mounted credentials are not embedded. Decrypt packages using node decrypt-backup.js PACKAGE MASTER_KEY NEW_TAR, then use the bundled helper and manifest for reviewed isolated restore. If the backup is incremental, copy the storage folder of the site (or use a chain download with ORDER.txt) and run node decrypt-backup.js --chain PACKAGE_OR_CHAIN_FOLDER MASTER_KEY NEW_FOLDER, where PACKAGE is the backup_...--ID.tar.gz.enc you want to restore: it finds the chain from the sealed manifests, checks every package and chain link, then writes them in restore order with CHAIN.json. Then, as root on Linux with GNU tar, run python3 helper.py restore-chain NEW_FOLDER ANOTHER_NEW_FOLDER: it rebuilds each mount (full backup first, then each increment, applying deletions and renames) with the same checks as DockNest and lists the images.tar files to load in order. No production replacement is automatic.\n');
  const payload=Buffer.from(JSON.stringify({version:1,createdAt:new Date().toISOString(),release,node:process.version,keyId:hash(files['master.key']).slice(0,16),files:Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,{sha256:hash(bytes),body:bytes.toString('base64')}]))}));
  if(payload.length>maximum)throw new Error('Manager state exceeds recovery kit size limit');
  const header=Buffer.concat([Buffer.from('DKN1'),randomBytes(16),randomBytes(12)]),cipher=createCipheriv('aes-256-gcm',derive(passphrase,header.subarray(4,20)),header.subarray(20));cipher.setAAD(header);
  const envelope=Buffer.concat([header,cipher.update(payload),cipher.final(),cipher.getAuthTag()]);
  await durableWrite(output,envelope);
  if(process.platform!=='win32'){const parentHandle=await open(parent,'r');try{await parentHandle.sync();}finally{await parentHandle.close();}}
  return {formatVersion:1,sha256:hash(envelope),release,keyId:hash(files['master.key']).slice(0,16)};
 }finally{await rm(temporary,{recursive:true,force:true});}
}
export const updateRunningMessage='A DockNest update is running on this host. Restore the recovery kit after it finishes.';
export async function restoreRecoveryKit({input,directory,passphrase,updaterStatus=updaterStatusDirectory,ignoreUpdater=false}){
 // The restored state has its deployment hold cleared, so never prepare one underneath a running upgrade.
 // ignoreUpdater (the CLI's --ignore-updater) is the operator's explicit override for disaster recovery.
 if(!ignoreUpdater&&await updaterRunActive(updaterStatus))throw Object.assign(new Error(updateRunningMessage),{status:409});
 const info=await lstat(input);if(!info.isFile()||info.size>maximum+1024||info.size<48)throw new Error('Invalid recovery kit size/type');
 const envelope=await readFile(input),header=envelope.subarray(0,32);
 if(header.subarray(0,4).toString()!=='DKN1')throw new Error('Unsupported recovery kit');
 const decipher=createDecipheriv('aes-256-gcm',derive(passphrase,header.subarray(4,20)),header.subarray(20));decipher.setAAD(header);decipher.setAuthTag(envelope.subarray(-16));
 let decoded;try{decoded=JSON.parse(Buffer.concat([decipher.update(envelope.subarray(32,-16)),decipher.final()]).toString());}catch{throw new Error('Recovery kit authentication failed');}
 if(decoded.version!==1||JSON.stringify(Object.keys(decoded.files||{}).sort())!==JSON.stringify([...names].sort()))throw new Error('Unexpected recovery kit contents');
 const files={};for(const name of names){const entry=decoded.files[name],bytes=Buffer.from(entry.body,'base64');if(hash(bytes)!==entry.sha256)throw new Error('Recovery kit file integrity failed');files[name]=bytes;}
 if(Buffer.from(files['master.key'].toString().trim(),'base64').length!==32)throw new Error('Recovery kit key is invalid');
 const target=resolve(directory);if(await realpath(dirname(target))!==dirname(target))throw new Error('Recovery parent cannot contain a symlink');await mkdir(target,{mode:0o700});let state;
 try{
  for(const [name,bytes] of Object.entries(files)){await mkdir(dirname(join(target,name)),{recursive:true,mode:0o700});await durableWrite(join(target,name),bytes);}
  state=new DatabaseSync(join(target,'state.sqlite'));state.exec('PRAGMA foreign_keys=ON');
  validateKey(state,Buffer.from(files['master.key'].toString().trim(),'base64'));
  if(state.prepare('PRAGMA quick_check').get().quick_check!=='ok'||state.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Manager snapshot validation failed');
  state.exec('BEGIN IMMEDIATE');
  if(state.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='manager_backups'").get()){
   if(state.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='manager_backup_downloads'").get())state.exec('DELETE FROM manager_backup_downloads;');
   state.exec('DELETE FROM manager_backups;');
   const saved=state.prepare("SELECT value FROM settings WHERE key='manager_backup_config'").get();
   if(saved){const settings=JSON.parse(saved.value);settings.enabled=false;settings.nextRun=null;state.prepare("UPDATE settings SET value=? WHERE key='manager_backup_config'").run(JSON.stringify(settings));}
  }
  for(const table of ['sessions','challenges','login_challenges','enrollment_challenges','downloads','leases'])if(hasTable(state,table))state.exec('DELETE FROM '+table);
  // Open enrollment links belong to the old manager; an administrator issues new ones after recovery.
  if(hasTable(state,'invitations'))state.prepare('UPDATE invitations SET revoked_at=? WHERE consumed_at IS NULL AND revoked_at IS NULL').run(Date.now());
  // A kit taken during a deployment hold would otherwise restore a manager that refuses all new work (the hold is
  // cleared below), and in-app update requests belong to the old host's updater (update_requests from schema 5).
  if(hasTable(state,'update_requests'))state.prepare("UPDATE update_requests SET state='lost',finished_at=COALESCE(finished_at,?) WHERE state IN ('submitted','running','needs_action')").run(new Date().toISOString());
  // Restore tests (schema 9) on the old manager's test servers stop: each one cleans up when the worker runs again, and
  // its reaper removes what is left on a server the new manager never reaches.
  if(hasTable(state,'restore_tests'))state.prepare('UPDATE restore_tests SET cancel_requested=1 WHERE result IS NULL').run();
  state.exec("UPDATE policies SET enabled=0,next_run=NULL; UPDATE jobs SET status='failed',stage='failed',error='Queued work cancelled during independent manager recovery' WHERE status='queued'; UPDATE jobs SET status='recovery_required',stage='recovery_required',error='Independent manager recovery: review source state before unlocking' WHERE status='running'; UPDATE restores SET status='failed' WHERE status='queued'; UPDATE restores SET status='recovery_required' WHERE status='running'; DELETE FROM settings WHERE key IN ('worker_heartbeat','artifact_reconciliation','deployment_hold');");
  state.exec('COMMIT');state.close();state=null;
  return {restored:true,release:decoded.release,keyId:decoded.keyId,schedulesPaused:true,sessionsRevoked:true,sourceRecoveryReviewRequired:true};
 }catch(error){state?.close();await rm(target,{recursive:true,force:true});throw error;}
}
