import { createDecipheriv,createHash } from 'node:crypto';
import { mkdir,readdir,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Transform,Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { key } from './crypto.js';
import { db,id } from './db.js';
import { openRead,statFile } from './storage.js';

// A full ZIP never touches the server's disk. "Preparing" reads and authenticates the whole encrypted backup and
// discards the plaintext; the download reads it again and streams the ZIP straight to the browser, re-verifying
// everything (GCM tag and stored checksum) before the response is allowed to finish.
export const LEGACY_ZIP_LIMIT=500*1024**2;
const READY_MS=60*60*1000,KEEP_MS=10*60*1000,MAX_MANIFEST=16*1024*1024;
const MESSAGES={
 busy:'Another full ZIP is being prepared or downloaded. Try again after it finishes.',
 verify:'The backup could not be verified, so no ZIP was prepared. The encrypted download remains available.',
 layout:'The backup is not a complete DockNest package, so no ZIP was prepared. The encrypted download remains available.',
 failed:'The full ZIP could not be prepared. The encrypted download remains available.',
 canceled:'The ZIP preparation was canceled.',
 changed:'The backup changed after it was checked. Prepare the ZIP again.',
 gone:'This ZIP is no longer available. Prepare it again.',
 tooLarge:'This backup is too large for a direct ZIP download. Use Download ZIP in the dashboard: DockNest checks the backup first, then you download it.'
};
const httpError=(message,status)=>Object.assign(new Error(message),{status});
const exportsById=new Map();let busy=false;
const script=fileURLToPath(new URL('../remote/export_zip.py',import.meta.url));
// Older versions staged decrypted payloads here. Remove anything left behind; nothing is written here any more.
export async function clearInterruptedExports(){
 const root=join(config.dataDir,'private-exports');await mkdir(root,{recursive:true,mode:0o700});
 for(const entry of await readdir(root,{withFileTypes:true}))if(/^export-[a-zA-Z0-9]+$/.test(entry.name))await rm(join(root,entry.name),{recursive:true,force:true});
}
const fingerprint=a=>JSON.stringify([a.size,a.mtimeMs??(a.mtime instanceof Date?a.mtime.getTime():a.mtime??null),a.etag??null,a.versionId??null]);
const lease=backupId=>{
 const leaseId=id();db.prepare('INSERT INTO downloads VALUES (?,?,?)').run(leaseId,backupId,Date.now()+120000);
 const timer=setInterval(()=>db.prepare('UPDATE downloads SET expires_at=? WHERE id=?').run(Date.now()+120000,leaseId),30000);
 return ()=>{clearInterval(timer);db.prepare('DELETE FROM downloads WHERE id=?').run(leaseId);};
};
function zipProcess(mode){
 const child=spawn(process.platform==='win32'?'python':'python3',[script,mode],{stdio:['pipe','pipe','ignore'],windowsHide:true});
 child.stdin.on('error',()=>{});
 child.completed=new Promise((resolve,reject)=>{child.once('error',()=>reject(new Error('ZIP export could not start')));child.once('close',code=>code===0?resolve():reject(new Error('ZIP export did not complete')));});
 child.completed.catch(()=>{});
 return child;
}
// One full read of the encrypted backup: AES-256-GCM decrypt into `sink`, then compare the stored checksum.
// The checksum and tag are checked when the read ends; the caller must not trust the output before this resolves.
async function decryptInto(backup,size,sink,{signal,onBytes,end=true}){
 const range=async(start,end)=>{const chunks=[];for await(const chunk of await openRead(backup.path,{start,end}))chunks.push(chunk);return Buffer.concat(chunks);};
 if(size<32)throw new Error('Truncated backup');
 const header=await range(0,15),tag=await range(size-16,size-1);
 if(header.subarray(0,4).toString()!=='DBM1')throw new Error('Unsupported backup format');
 const decipher=createDecipheriv('aes-256-gcm',key(),header.subarray(4));decipher.setAAD(header);decipher.setAuthTag(tag);
 const hash=createHash('sha256');hash.update(header);
 const digest=new Transform({transform(chunk,_encoding,callback){hash.update(chunk);onBytes?.(chunk.length);callback(null,chunk);}});
 await pipeline(await openRead(backup.path,{start:16,end:size-17}),digest,decipher,sink,{signal,end});
 hash.update(tag);if(hash.digest('hex')!==backup.checksum)throw new Error('Backup checksum verification failed');
}
const authFailure=error=>/checksum|authenticate|Truncated|Unsupported/i.test(error?.message||'');

// Pass 1: authenticate everything, let the helper check the package layout, keep only the small manifest.
async function verifyPass(backup,item,onBytes){
 const before=await statFile(backup.path),size=before.size;
 item.bytesTotal=Math.max(size-32,0);
 const child=zipProcess('--scan'),output=[];let received=0;
 child.stdout.on('data',chunk=>{received+=chunk.length;if(received>MAX_MANIFEST)child.kill('SIGTERM');else output.push(chunk);});
 try{
  // Keep authenticating even if the helper stops early, so a tampered backup is reported as such.
  const sink=new Writable({write(chunk,_encoding,callback){if(!child.stdin.writable)return callback();child.stdin.write(chunk,()=>callback());},final(callback){child.stdin.end();callback();}});
  try{await decryptInto(backup,size,sink,{signal:item.abort.signal,onBytes});}
  catch(error){if(item.abort.signal.aborted)throw error;if(!authFailure(error)&&await child.completed.then(()=>false,()=>true))throw new Error(MESSAGES.layout);throw error;}
  try{await child.completed;}catch{throw new Error(MESSAGES.layout);}
 }finally{child.kill('SIGTERM');}
 if(fingerprint(await statFile(backup.path))!==fingerprint(before))throw new Error(MESSAGES.changed);
 const manifest=Buffer.concat(output);if(!manifest.length||received>MAX_MANIFEST)throw new Error(MESSAGES.layout);
 return {manifest,pin:fingerprint(before),size};
}

// Pass 2: two authenticated reads of the same ciphertext feed one helper process that writes the ZIP to the response.
// The first read produces recovery-originals/, the second the browsable site-files/ and configuration/ copies (a ZIP can
// only write one entry at a time). The response is only ended after both reads verified and the helper succeeded;
// otherwise the connection is destroyed so the browser shows a failed download.
async function streamPass(token,backup,response,signal){
 const attrs=await statFile(backup.path);
 if(fingerprint(attrs)!==token.pin)throw httpError(MESSAGES.changed,409);
 const size=attrs.size,plain=Buffer.alloc(16);plain.writeBigUInt64BE(BigInt(size-32),0);plain.writeBigUInt64BE(BigInt(token.manifest.length),8);
 const child=zipProcess('--stream');
 const cancel=()=>{if(response.writableFinished)return;child.kill('SIGTERM');};
 response.once('close',cancel);
 try{
  child.stdin.write(Buffer.concat([plain,token.manifest]));
  response.attachment(backup.site_id+'_'+backup.id+'_full-site.zip');response.set({'Content-Type':'application/zip','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  response.flushHeaders?.();
  const piped=pipeline(child.stdout,response,{signal,end:false});piped.catch(()=>{});
  await decryptInto(backup,size,child.stdin,{signal,end:false});
  await decryptInto(backup,size,child.stdin,{signal,end:true});
  await child.completed;await piped;
  if(fingerprint(await statFile(backup.path))!==token.pin)throw new Error(MESSAGES.changed);
  response.end();
 }catch(error){response.destroy();throw error;}
 finally{response.removeListener('close',cancel);child.kill('SIGTERM');}
}
const acquire=()=>{if(busy)throw httpError(MESSAGES.busy,409);busy=true;};

// Small backups only: the single-request flow (verify, then stream) for links that predate the prepare step.
export async function exportFullZip(backup,response){
 acquire();
 try{
  const size=(await statFile(backup.path)).size;if(size>LEGACY_ZIP_LIMIT)throw httpError(MESSAGES.tooLarge,413);
  const abort=new AbortController(),cancel=()=>{if(!response.writableFinished)abort.abort();};response.once('close',cancel);
  try{const checked=await verifyPass(backup,{abort,bytesTotal:0});await streamPass({...checked},backup,response,abort.signal);}
  finally{response.removeListener('close',cancel);}
 }finally{busy=false;}
}

function publicState(item){
 if(item.status==='ready'&&Date.now()>=item.expiresAt)expire(item);
 const elapsed=(Date.now()-item.startedAt)/1000;
 const etaSeconds=item.status==='preparing'&&elapsed>=2&&item.bytesDone>0?Math.max(1,Math.ceil((item.bytesTotal-item.bytesDone)/(item.bytesDone/elapsed))):null;
 return {id:item.id,backupId:item.backupId,status:item.status,bytesDone:item.bytesDone,bytesTotal:item.bytesTotal,etaSeconds,expiresAt:item.status==='ready'?new Date(item.expiresAt).toISOString():null,error:item.error};
}
function expire(item){
 if(item.status==='expired')return;
 item.status='expired';clearTimeout(item.timer);item.manifest=undefined;item.abort.abort();item.streamAbort?.abort();
 setTimeout(()=>exportsById.delete(item.id),KEEP_MS).unref();
}

export function startZipExport(backup){
 const existing=[...exportsById.values()].find(item=>item.backupId===backup.id&&(item.status==='preparing'||item.status==='ready')&&publicState(item).status!=='expired');
 if(existing)return {item:publicState(existing),created:false};
 acquire();
 const item={id:id(),backupId:backup.id,status:'preparing',bytesDone:0,bytesTotal:0,startedAt:Date.now(),expiresAt:0,error:null,abort:new AbortController()};
 exportsById.set(item.id,item);
 const release=lease(backup.id);
 verifyPass(backup,item,n=>{item.bytesDone=Math.min(item.bytesTotal,item.bytesDone+n);}).then(checked=>{
  if(item.status!=='preparing')return;
  Object.assign(item,checked);item.bytesDone=item.bytesTotal;item.expiresAt=Date.now()+READY_MS;item.status='ready';
  item.timer=setTimeout(()=>expire(item),READY_MS);item.timer.unref();
 }).catch(error=>{
  if(item.status!=='preparing')return;
  const message=item.abort.signal.aborted?MESSAGES.canceled:error.message===MESSAGES.changed||error.message===MESSAGES.layout?error.message:authFailure(error)?MESSAGES.verify:MESSAGES.failed;
  item.status='failed';item.error=message;item.manifest=undefined;
  setTimeout(()=>exportsById.delete(item.id),KEEP_MS).unref();
 }).finally(()=>{release();busy=false;});
 return {item:publicState(item),created:true};
}
export function findZipExport(backupId,exportId){const item=exportsById.get(exportId);return item&&item.backupId===backupId?item:null;}
export const zipExportState=publicState;
export function activeZipExportFor(backupId){const item=[...exportsById.values()].find(entry=>entry.backupId===backupId&&(entry.status==='preparing'||entry.status==='ready'));return item&&publicState(item).status!=='expired'?publicState(item):null;}
export function cancelZipExport(item){
 if(item.status==='preparing'){item.abort.abort();item.status='expired';item.error=MESSAGES.canceled;}
 else expire(item);
 exportsById.delete(item.id);
}
// A complete, verified download ends the token. An interrupted one keeps it so the same link can be tried again.
export async function streamZipExport(item,backup,response){
 if(publicState(item).status!=='ready')throw httpError(MESSAGES.gone,410);
 acquire();const release=lease(backup.id);item.streamAbort=new AbortController();
 const cancel=()=>{if(!response.writableFinished)item.streamAbort.abort();};response.once('close',cancel);
 try{await streamPass(item,backup,response,item.streamAbort.signal);expire(item);}
 catch(error){if(error.status===409&&error.message===MESSAGES.changed)expire(item);throw error;}
 finally{response.removeListener('close',cancel);release();busy=false;}
}
