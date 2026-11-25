// SFTP adapter: pinned host keys, fsync@openssh.com and atomic rename publication. On an append-only destination
// (options.writeMode) new files are created read-only (0400); deletes never reach this adapter (src/storage/index.js).
import { Client } from 'ssh2';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sftpWriteStream } from '../sftp-streams.js';
import { sftpReadStream } from '../sftp-read-stream.js';
import { storageConnectionError, storageErrorClass } from '../storage-errors.js';
import { filesystemCapacity } from '../storage-capacity.js';

export const scheme='sftp',label='SFTP';
export function resolve(options,remote){
 const normalized=path.posix.resolve(remote);
 if(!normalized.startsWith(options.root+'/'))throw new Error('Backup path is outside managed SFTP storage');
 return normalized;
}
async function session(options){
 if(!options.host||!options.username||!options.hostKey||(!options.keyFile&&!options.passwordFile&&!options.privateKey&&!options.password))throw new Error('Configure the storage connection and verified host key first');
 const client=new Client();
 let hostRejected=false,phase='ssh';
 try{
  const privateKey=options.privateKey||(options.keyFile?await readFile(options.keyFile):undefined);
  const password=options.password||(options.passwordFile?(await readFile(options.passwordFile,'utf8')).trimEnd():undefined);
  await new Promise((resolve,reject)=>{
   client.on('error',reject).once('ready',resolve);
   client.connect({host:options.host,port:options.port,username:options.username,privateKey,password,hostHash:'sha256',hostVerifier:hash=>{const matches=hash.toLowerCase()===options.hostKey.toLowerCase();hostRejected=!matches;return matches;},readyTimeout:15000,keepaliveInterval:10000,keepaliveCountMax:10});
  });
  phase='sftp';
  const sftp=await new Promise((resolve,reject)=>client.sftp((error,value)=>error?reject(error):resolve(value)));
  return {client,sftp};
 }catch(error){client.end();throw Object.assign(new Error(storageConnectionError(error,{hostRejected,phase})),{errorClass:storageErrorClass(error,{hostRejected,phase})});}
}
const call=(sftp,name,...args)=>new Promise((resolve,reject)=>sftp[name](...args,(error,result)=>error?reject(error):resolve(result)));
async function withSession(options,fn){const {client,sftp}=await session(options);try{return await fn(sftp);}finally{client.end();}}
async function ownedRemote(sftp,options,value){
 const root=(await call(sftp,'realpath',options.root)).replace(/\/$/,''),canonical=await call(sftp,'realpath',value);
 if(!canonical.startsWith(root+'/'))throw new Error('Backup path escapes managed SFTP storage');
 const attrs=await call(sftp,'lstat',value);
 if(attrs.isSymbolicLink())throw new Error('Backup file cannot be a symlink');
 return value;
}
async function makeRemoteDirectory(sftp,value){
 let current='';
 for(const part of value.split('/').filter(Boolean)){
  current+='/'+part;
  try{await call(sftp,'mkdir',current,{mode:0o700});}catch(error){if(error.code!==4&&error.code!==11)throw error;}
  const attrs=await call(sftp,'lstat',current);
  if(!attrs.isDirectory()||attrs.isSymbolicLink())throw new Error('Storage path must contain only directories without symlinks');
 }
}
// Connection test and write-mode detection (docs/storage-backends.md, "Append-only SFTP"). The probe files live in the
// DockNest-owned .docknest-probe folder under fresh random names; nothing else on the destination is opened, renamed or
// removed. normal: the probe can be deleted. append-only: deletes are refused and so is every way to change a finished
// file (open it for writing, change its permissions, rename or posix-rename another file over it). Anything in between
// fails the test. Probe files the storage keeps are returned (probeLeftovers) for the caller to record; they are never
// retried here.
export const PROBE_FOLDER='.docknest-probe';
const PROBE=Buffer.from('DockNest storage probe');
// A request counts as refused only on an explicit SSH_FX_PERMISSION_DENIED or SSH_FX_OP_UNSUPPORTED: a generic failure
// could be a passing fault, and calling such a destination append-only would promise a protection nobody verified, so it
// fails the test instead. The one exception is a rename over an existing file, which OpenSSH answers with SSH_FX_FAILURE
// (link() gives EEXIST). Anything else (a dropped connection, a missing file) is not an answer and fails the test.
const EXPLICITLY_REFUSED=new Set([3,8]),RENAME_OVER_REFUSED=new Set([3,4,8]);
const CHANGE_NAMES={reopen:'open for writing',permissions:'permission changes',rename:'rename over a file',posixRename:'posix-rename over a file'};
async function allowed(operation,refused=EXPLICITLY_REFUSED){try{await operation();return true;}catch(error){if(refused.has(error?.code))return false;throw error;}}
async function writeProbe(sftp,file){
 const handle=await call(sftp,'open',file,'wx',0o400);
 try{await call(sftp,'write',handle,PROBE,0,PROBE.length,0);try{await call(sftp,'ext_openssh_fsync',handle);}catch{throw new Error('Storage requires working fsync@openssh.com support for durable backup files');}}
 finally{await call(sftp,'close',handle);}
}
async function probeMatches(sftp,file){
 if((await call(sftp,'stat',file)).size!==PROBE.length)return false;
 const handle=await call(sftp,'open',file,'r'),buffer=Buffer.alloc(PROBE.length);
 try{await call(sftp,'read',handle,buffer,0,PROBE.length,0);}finally{await call(sftp,'close',handle);}
 return buffer.equals(PROBE);
}
const exists=async(sftp,file)=>{try{await call(sftp,'lstat',file);return true;}catch(error){if(error.code===2)return false;throw error;}};
// posix-rename@openssh.com replaces an existing file; a server that does not offer it cannot be asked.
async function posixRenameAllowed(sftp,from,to){
 if(sftp._extensions?.['posix-rename@openssh.com']!=='1')return false;
 return allowed(()=>call(sftp,'ext_openssh_rename',from,to));
}
export async function test(options){
 return withSession(options,async sftp=>{
  await makeRemoteDirectory(sftp,options.root);
  const folder=options.root+'/'+PROBE_FOLDER;await makeRemoteDirectory(sftp,folder);
  const token=randomUUID(),written=folder+'/'+token,published=written+'.verified',other=written+'.other';
  let classified=false;
  try{
   await writeProbe(sftp,written);
   try{await call(sftp,'rename',written,published);}
   catch(error){if(EXPLICITLY_REFUSED.has(error?.code))throw Object.assign(new Error('This storage refuses to rename files. DockNest publishes each backup by renaming a checked file into place, so rename must be allowed (it never replaces an existing file). See docs/storage-backends.md.'),{status:400});throw error;}
   if(!await probeMatches(sftp,published))throw new Error('Storage read verification failed');
   await writeProbe(sftp,other);
   // Each attempt targets the published probe only. A refused attempt changes nothing; an allowed one is recorded.
   const overwrite={reopen:await allowed(async()=>{const handle=await call(sftp,'open',published,'r+');await call(sftp,'close',handle);}),
    permissions:await allowed(()=>call(sftp,'setstat',published,{mode:0o600})),
    rename:await allowed(()=>call(sftp,'rename',other,published),RENAME_OVER_REFUSED)};
   overwrite.posixRename=!overwrite.rename&&await posixRenameAllowed(sftp,other,published);
   if(!await probeMatches(sftp,published))throw new Error('Storage read verification failed');
   const checks={connected:true,writeVerified:true,readVerified:true,renameVerified:true,fileFsyncVerified:true};
   if(await allowed(()=>call(sftp,'unlink',published))){
    if(await exists(sftp,other))await call(sftp,'unlink',other);
    try{await call(sftp,'rmdir',folder);}catch{/* Another probe may be running, or the folder is kept: harmless. */}
    classified=true;return {...checks,writeMode:'normal'};
   }
   classified=true;
   const probeLeftovers=[];for(const file of [published,other])if(await exists(sftp,file))probeLeftovers.push(file);
   const changeable=Object.entries(overwrite).filter(([,value])=>value).map(([name])=>CHANGE_NAMES[name]);
   if(changeable.length)throw Object.assign(new Error('This storage refuses deletes but still lets DockNest change files it has written ('+changeable.join(', ')+'), so it is not safely append-only. Deny setstat, fsetstat, lsetstat and posix-rename on the server too (docs/storage-backends.md), then test again.'),{status:400,probeLeftovers,writeMode:'broken'});
   return {...checks,writeMode:'append-only',deleteRefused:true,overwriteRefused:true,probeLeftovers};
  }catch(error){
   // A test that stopped before it could classify the storage: one removal attempt each, then report what stayed.
   if(!classified&&error&&typeof error==='object'){
    const kept=[];
    for(const file of [written,published,other]){try{await call(sftp,'unlink',file);}catch(failure){if(failure?.code!==2&&await exists(sftp,file).catch(()=>false))kept.push(file);}}
    if(kept.length)error.probeLeftovers=kept;
   }
   throw error;
  }
 });
}
export const readiness=options=>withSession(options,async sftp=>{const attrs=await call(sftp,'stat',options.root);if(!attrs.isDirectory())throw new Error('Storage directory missing');});
export const makeDirectory=(options,value)=>withSession(options,sftp=>makeRemoteDirectory(sftp,value));
export const statFile=(options,value)=>withSession(options,async sftp=>{const attrs=await call(sftp,'stat',await ownedRemote(sftp,options,value));if(!attrs.isFile())throw new Error('Backup path is not a file');return attrs;});
export async function openRead(options,value,range={}){
 const {client,sftp}=await session(options);
 try{const stream=sftpReadStream(sftp,await ownedRemote(sftp,options,value),range);stream.once('close',()=>client.end());return stream;}
 catch(error){client.end();throw error;}
}
export async function openWrite(options,value){
 const {client,sftp}=await session(options);
 try{
  const root=(await call(sftp,'realpath',options.root)).replace(/\/$/,''),parent=await call(sftp,'realpath',path.posix.dirname(value));
  if(parent!==root&&!parent.startsWith(root+'/'))throw new Error('Storage output path escapes the configured root');
  const stream=sftpWriteStream(sftp,value,{mode:options.writeMode==='append-only'?0o400:0o600});stream.once('close',()=>client.end());stream.once('error',()=>client.end());return stream;
 }catch(error){client.end();throw error;}
}
export function syncFile(options,value){
 return withSession(options,async sftp=>{
  const handle=await call(sftp,'open',await ownedRemote(sftp,options,value),'r');
  try{
   if(typeof sftp.ext_openssh_fsync!=='function')throw new Error('SFTP file fsync is unavailable');
   await call(sftp,'ext_openssh_fsync',handle);
  }catch{throw new Error('Durable SFTP publication requires working fsync@openssh.com support');}
  finally{await call(sftp,'close',handle);}
  // SFTP provides no portable directory fsync: file bytes are synced, but rename
  // durability still depends on the independently managed storage server.
 });
}
export const renameFile=(options,from,to)=>withSession(options,async sftp=>call(sftp,'rename',await ownedRemote(sftp,options,from),to));
export const removeFile=(options,value)=>withSession(options,async sftp=>call(sftp,'unlink',await ownedRemote(sftp,options,value)));
export function removeDirectory(options,value){
 return withSession(options,async sftp=>{
  const canonical=await call(sftp,'realpath',value),root=(await call(sftp,'realpath',options.root)).replace(/\/$/,'');
  if(!canonical.startsWith(root+'/'))throw new Error('Cleanup path escapes storage');
  for(const name of ['payload.enc.partial','payload.enc']){try{await call(sftp,'unlink',value+'/'+name);}catch(error){if(error.code!==2)throw error;}}
  await call(sftp,'rmdir',value);
 });
}
async function remoteCapacity(options){
 return withSession(options,async sftp=>{
  let timer;
  try{
   const value=await Promise.race([call(sftp,'ext_openssh_statvfs',options.root),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Storage capacity request timed out')),5000);})]);
   return filesystemCapacity({blockSize:value.f_frsize||value.f_bsize,blocks:value.f_blocks,free:value.f_bfree,available:value.f_bavail});
  }finally{clearTimeout(timer);}
 });
}
// One uncached reading for a destination that is not saved yet; null when the server reports nothing usable.
export async function probeCapacity(options){
 try{return (await remoteCapacity(options)).total;}catch{return null;}
}
let capacityReading;
export async function capacity(options,{maxAgeMs=0}={}){
 const identity=JSON.stringify([options.id,options.host,options.port,options.username,options.hostKey,options.root]);
 if(capacityReading?.identity!==identity)capacityReading={identity};
 const reading=capacityReading;
 if(!reading.result||Date.now()-reading.readAt>=maxAgeMs){
  if(!reading.pending)reading.pending=remoteCapacity(options).then(value=>({...value,capacitySource:'filesystem',estimated:false})).catch(()=>({used:null,total:null,available:null,capacitySource:'unavailable',estimated:false})).then(result=>{reading.result=result;reading.readAt=Date.now();reading.pending=null;return result;});
  await reading.pending;
 }
 return {...reading.result,backend:'sftp',targetId:options.id,name:options.name||'Storage Box'};
}
