import { createDecipheriv,createHash } from 'node:crypto';
import { mkdtemp,rm,statfs,mkdir,readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { key } from './crypto.js';
import { openRead,statFile } from './storage.js';

let exporting=false;
export async function clearInterruptedExports(){
 const root=join(config.dataDir,'private-exports');await mkdir(root,{recursive:true,mode:0o700});
 for(const entry of await readdir(root,{withFileTypes:true}))if(/^export-[a-zA-Z0-9]+$/.test(entry.name))await rm(join(root,entry.name),{recursive:true,force:true});
}
const RESERVE=2*1024**3;
export async function exportFullZip(backup,response){
 if(exporting)throw Object.assign(new Error('Another full ZIP download is being prepared. Try again after it finishes.'),{status:409});
 exporting=true;let directory,child;
 const abort=new AbortController();const cancel=()=>{if(response.writableFinished)return;abort.abort();child?.kill('SIGTERM');};
 response.once('close',cancel);
 try{
  const root=join(config.dataDir,'private-exports');await mkdir(root,{recursive:true,mode:0o700});
  const capacity=await statfs(root),size=(await statFile(backup.path)).size;
  // Only the authenticated, decrypted payload is written here (about the backup's size); the ZIP itself is streamed.
  if(capacity.bavail*capacity.bsize<size+RESERVE)throw new Error('Not enough temporary space to prepare the full ZIP. The encrypted download remains available.');
  directory=await mkdtemp(join(root,'export-'));const payload=join(directory,'payload.tar.gz');
  const range=async(start,end)=>{const chunks=[];for await(const chunk of await openRead(backup.path,{start,end}))chunks.push(chunk);return Buffer.concat(chunks);};
  if(size<32)throw new Error('Truncated backup');
  const header=await range(0,15),tag=await range(size-16,size-1);
  if(header.subarray(0,4).toString()!=='DBM1')throw new Error('Unsupported backup format');
  const decipher=createDecipheriv('aes-256-gcm',key(),header.subarray(4));decipher.setAAD(header);decipher.setAuthTag(tag);
  const hash=createHash('sha256');hash.update(header);
  const digest=new Transform({transform(chunk,_encoding,callback){hash.update(chunk);callback(null,chunk);}});
  // No decrypted bytes reach the browser until complete GCM authentication and checksum verification succeed.
  // Stop cleanly before the disk fills if something else uses the space meanwhile.
  let lowDisk=false,stopped=false;const watch=setInterval(async()=>{try{const now=await statfs(root);if(!stopped&&now.bavail*now.bsize<RESERVE/2){lowDisk=true;abort.abort();}}catch{}},2000);
  try{await pipeline(await openRead(backup.path,{start:16,end:size-17}),digest,decipher,createWriteStream(payload,{flags:'wx',mode:0o600}),{signal:abort.signal});}
  catch(error){if(lowDisk)throw new Error('The server ran low on disk space while preparing the full ZIP. The encrypted download remains available.');throw error;}
  finally{stopped=true;clearInterval(watch);}
  hash.update(tag);if(hash.digest('hex')!==backup.checksum)throw new Error('Backup checksum verification failed');
  if(abort.signal.aborted)throw new Error('Download canceled');
  // The ZIP is written straight to the response; no second copy on disk. A failure after the first byte ends the
  // download as incomplete (the browser reports a failed download), never as a silently short file.
  child=spawn(process.platform==='win32'?'python':'python3',[fileURLToPath(new URL('../remote/export_zip.py',import.meta.url)),payload],{stdio:['ignore','pipe','ignore'],windowsHide:true});
  const completed=new Promise((resolve,reject)=>{child.once('error',()=>reject(new Error('ZIP export could not start')));child.once('close',code=>code===0?resolve():reject(new Error('ZIP export did not complete')));});
  completed.catch(()=>{});
  response.attachment(backup.site_id+'_'+backup.id+'_full-site.zip');response.set({'Content-Type':'application/zip','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  try{await pipeline(child.stdout,response,{signal:abort.signal,end:false});await completed;await rm(directory,{recursive:true,force:true});directory=undefined;response.end();}
  catch(error){response.destroy();throw error;}
 }finally{
  response.removeListener('close',cancel);child?.kill('SIGTERM');
  try{if(directory)await rm(directory,{recursive:true,force:true});}finally{exporting=false;}
 }
}
