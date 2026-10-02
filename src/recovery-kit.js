import { DatabaseSync,backup } from 'node:sqlite';
import { createCipheriv,createDecipheriv,scryptSync,randomBytes,createHash } from 'node:crypto';
import { mkdtemp,readFile,writeFile,mkdir,rm,open,rename,chmod,lstat } from 'node:fs/promises';
import { join,resolve,dirname } from 'node:path';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const names=['state.sqlite','master.key','recovery/decrypt-backup.js','recovery/helper.py','recovery/boot_recovery.py','recovery/export_zip.py','recovery/README.md'];
const maximum=128*1024*1024;
function derive(passphrase,salt){if(typeof passphrase!=='string'||passphrase.length<24||passphrase.length>4096)throw new Error('Use a separate recovery passphrase of at least 24 characters');return scryptSync(passphrase,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});}
async function durableWrite(file,bytes){const handle=await open(file,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}
export async function exportRecoveryKit({database,masterKey,output,passphrase,release='unknown'}){
 const parent=dirname(resolve(output)),temporary=await mkdtemp(join(parent,'.docknest-kit-'));await chmod(temporary,0o700);
 try{
  const snapshot=join(temporary,'snapshot.sqlite');await backup(database,snapshot);await chmod(snapshot,0o600);
  const files={'state.sqlite':await readFile(snapshot),'master.key':await readFile(masterKey)};
  if(Buffer.from(files['master.key'].toString().trim(),'base64').length!==32)throw new Error('Invalid manager key');
  for(const [name,url] of [['recovery/decrypt-backup.js','../scripts/decrypt-backup.js'],['recovery/helper.py','../remote/helper.py'],['recovery/boot_recovery.py','../remote/boot_recovery.py'],['recovery/export_zip.py','../remote/export_zip.py']])files[name]=await readFile(new URL(url,import.meta.url));
  files['recovery/README.md']=Buffer.from('Private recovery kit. Keep the recovery passphrase separately and a copy of the matching DockNest release image/source and environment configuration offline. Restore into a new private DATA_DIR; do not overwrite a live manager. Sessions and schedules are disabled during import. Reconnect storage with independently verified host keys; environment-mounted credentials are not embedded. Decrypt packages using node decrypt-backup.js PACKAGE MASTER_KEY NEW_TAR, then use the bundled helper and manifest for reviewed isolated restore. No production replacement is automatic.\n');
  const payload=Buffer.from(JSON.stringify({version:1,createdAt:new Date().toISOString(),release,node:process.version,keyId:hash(files['master.key']).slice(0,16),files:Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,{sha256:hash(bytes),body:bytes.toString('base64')}]))}));
  if(payload.length>maximum)throw new Error('Manager state exceeds recovery kit size limit');
  const header=Buffer.concat([Buffer.from('DKN1'),randomBytes(16),randomBytes(12)]),cipher=createCipheriv('aes-256-gcm',derive(passphrase,header.subarray(4,20)),header.subarray(20));cipher.setAAD(header);
  const envelope=Buffer.concat([header,cipher.update(payload),cipher.final(),cipher.getAuthTag()]);
  await durableWrite(output,envelope);
  return {formatVersion:1,sha256:hash(envelope),release,keyId:hash(files['master.key']).slice(0,16)};
 }finally{await rm(temporary,{recursive:true,force:true});}
}
export async function restoreRecoveryKit({input,directory,passphrase}){
 const info=await lstat(input);if(!info.isFile()||info.size>maximum+1024||info.size<48)throw new Error('Invalid recovery kit size/type');
 const envelope=await readFile(input),header=envelope.subarray(0,32);
 if(header.subarray(0,4).toString()!=='DKN1')throw new Error('Unsupported recovery kit');
 const decipher=createDecipheriv('aes-256-gcm',derive(passphrase,header.subarray(4,20)),header.subarray(20));decipher.setAAD(header);decipher.setAuthTag(envelope.subarray(-16));
 let decoded;try{decoded=JSON.parse(Buffer.concat([decipher.update(envelope.subarray(32,-16)),decipher.final()]).toString());}catch{throw new Error('Recovery kit authentication failed');}
 if(decoded.version!==1||JSON.stringify(Object.keys(decoded.files||{}).sort())!==JSON.stringify([...names].sort()))throw new Error('Unexpected recovery kit contents');
 const files={};for(const name of names){const entry=decoded.files[name],bytes=Buffer.from(entry.body,'base64');if(hash(bytes)!==entry.sha256)throw new Error('Recovery kit file integrity failed');files[name]=bytes;}
 if(Buffer.from(files['master.key'].toString().trim(),'base64').length!==32)throw new Error('Recovery kit key is invalid');
 const target=resolve(directory);await mkdir(target,{mode:0o700});let state;
 try{
  for(const [name,bytes] of Object.entries(files)){await mkdir(dirname(join(target,name)),{recursive:true,mode:0o700});await durableWrite(join(target,name),bytes);}
  state=new DatabaseSync(join(target,'state.sqlite'));state.exec('PRAGMA foreign_keys=ON');
  if(state.prepare('PRAGMA quick_check').get().quick_check!=='ok'||state.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Manager snapshot validation failed');
  state.exec('BEGIN IMMEDIATE');
  for(const table of ['sessions','challenges','login_challenges','enrollment_challenges','downloads','leases'])if(state.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))state.exec('DELETE FROM '+table);
  state.exec("UPDATE policies SET enabled=0,next_run=NULL; UPDATE jobs SET status='failed',stage='failed',error='Queued work cancelled during independent manager recovery' WHERE status='queued'; UPDATE jobs SET status='recovery_required',stage='recovery_required',error='Independent manager recovery: review source state before unlocking' WHERE status='running'; UPDATE restores SET status='failed' WHERE status='queued'; UPDATE restores SET status='recovery_required' WHERE status='running'; DELETE FROM settings WHERE key IN ('worker_heartbeat','artifact_reconciliation');");
  state.exec('COMMIT');state.close();state=null;
  return {restored:true,release:decoded.release,keyId:decoded.keyId,schedulesPaused:true,sessionsRevoked:true,sourceRecoveryReviewRequired:true};
 }catch(error){state?.close();await rm(target,{recursive:true,force:true});throw error;}
}
