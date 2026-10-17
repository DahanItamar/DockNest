import { Client } from 'ssh2';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat, mkdir, rename, rm, realpath, statfs, open as openFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';
import { open } from './crypto.js';
import { backupLayout,backupRoot } from './backup-layout.js';
import { sftpWriteStream } from './sftp-streams.js';
import { sftpReadStream } from './sftp-read-stream.js';
import { storageConnectionError } from './storage-errors.js';
import { filesystemCapacity } from './storage-capacity.js';

const prefix='sftp:';
export const isRemoteFile=file=>file.startsWith(prefix);
export function targetOptions(id){
 if(id==='env')return {...config.storage,id:'env'};
 const row=db.prepare('SELECT * FROM storage_targets WHERE id=?').get(id);
 if(!row)throw new Error('Storage destination is missing; restore its connection configuration before accessing its backups');
 return {id:row.id,mode:'sftp',name:row.name,host:row.host,port:row.port,username:row.username,hostKey:row.host_key,root:row.root,capacity:row.capacity_bytes,...(row.auth_type==='password'?{password:open(row.credential)}:{privateKey:open(row.credential)})};
}
export function activeStorage(){
 const selected=db.prepare("SELECT value FROM settings WHERE key='backup_storage_target'").get();
 return selected?targetOptions(selected.value):{...config.storage,id:'env'};
}
export async function checkStorageReadiness(){
 const options=activeStorage();
 if(options.mode==='unconfigured')throw new Error('Storage is not configured');
 if(options.mode==='local'){const attrs=await stat(config.backupDir);if(!attrs.isDirectory())throw new Error('Storage directory missing');}
 else await withSession(options,async sftp=>{const attrs=await call(sftp,'stat',options.root);if(!attrs.isDirectory())throw new Error('Storage directory missing');});
 const capacity=await storageCapacity();
 if(capacity.available===null)throw new Error('Storage available space could not be verified. Check the connection and filesystem capacity support.');
 if(capacity.available<1024**3)throw new Error('Insufficient storage capacity');
 return {reachable:true,writeTested:false};
}
function fileOptions(file){
 const value=file.slice(prefix.length),separator=value.indexOf(':');
 if(!isRemoteFile(file))throw new Error('Expected an SFTP storage path');
 const id=value.startsWith('/')?'env':value.slice(0,separator);
 const options=targetOptions(id),remote=value.startsWith('/')?value:value.slice(separator+1);
 const normalized=path.posix.resolve(remote);
 if(!normalized.startsWith(options.root+'/'))throw new Error('Backup path is outside managed SFTP storage');
 return {options,value:normalized};
}
async function localPath(file){
 const root=await realpath(config.backupDir),value=await realpath(file),relative=path.relative(root,value);
 if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Backup path is outside managed storage');
 return value;
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
   client.connect({host:options.host,port:options.port,username:options.username,privateKey,password,hostHash:'sha256',hostVerifier:hash=>{const matches=hash.toLowerCase()===options.hostKey.toLowerCase();hostRejected=!matches;return matches;},readyTimeout:15000,keepaliveInterval:10000});
  });
  phase='sftp';
  const sftp=await new Promise((resolve,reject)=>client.sftp((error,value)=>error?reject(error):resolve(value)));
  return {client,sftp};
 }catch(error){client.end();throw new Error(storageConnectionError(error,{hostRejected,phase}));}
}
const call=(sftp,name,...args)=>new Promise((resolve,reject)=>sftp[name](...args,(error,result)=>error?reject(error):resolve(result)));
async function withSession(options,fn){const {client,sftp}=await session(options);try{return await fn(sftp);}finally{client.end();}}
async function ownedRemote(sftp,file){
 const {options,value}=fileOptions(file),root=(await call(sftp,'realpath',options.root)).replace(/\/$/,''),canonical=await call(sftp,'realpath',value);
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
export async function testStorageTarget(options){
 return withSession(options,async sftp=>{
  await makeRemoteDirectory(sftp,options.root);
  const temporary=options.root+'/.docknest-probe-'+randomUUID(),published=temporary+'.verified';
  try{
   const handle=await call(sftp,'open',temporary,'wx',0o600);
   try{await call(sftp,'write',handle,Buffer.from('DockNest storage probe'),0,22,0);try{await call(sftp,'ext_openssh_fsync',handle);}catch{throw new Error('Storage requires working fsync@openssh.com support for durable backup files');}}finally{await call(sftp,'close',handle);}
   await call(sftp,'rename',temporary,published);
   const attrs=await call(sftp,'stat',published);if(attrs.size!==22)throw new Error('Storage write verification failed');
   const readHandle=await call(sftp,'open',published,'r');
   const buffer=Buffer.alloc(22);
   try{await call(sftp,'read',readHandle,buffer,0,22,0);}finally{await call(sftp,'close',readHandle);}
   if(buffer.toString()!=='DockNest storage probe')throw new Error('Storage read verification failed');
   return {connected:true,writeVerified:true,readVerified:true,renameVerified:true,fileFsyncVerified:true};
  }finally{for(const file of [temporary,published]){try{await call(sftp,'unlink',file);}catch(error){if(error.code!==2)throw error;}}}
 });
}
export function backupDirectory(server,site){
 const options=activeStorage();
 if(options.mode==='unconfigured')throw new Error('Connect a remote storage destination before backing up');
 const folders=backupLayout(server,site);
 return options.mode==='sftp'?prefix+options.id+':'+path.posix.join(backupRoot(options.root),...folders):path.join(config.backupDir,...folders);
}
export function storageJoin(directory,name){
 if(!isRemoteFile(directory))return path.join(directory,name);
 const {options,value}=fileOptions(directory);return prefix+options.id+':'+path.posix.join(value,name);
}
export function managerBackupDirectory(targetId,keyId){
 const options=targetOptions(targetId);
 if(options.mode!=='sftp')throw new Error('DockNest backup requires the selected SFTP destination');
 if(!/^[a-f0-9]{16}$/.test(keyId))throw new Error('Invalid manager key identifier');
 return prefix+options.id+':'+path.posix.join(backupRoot(options.root),'docknest-recovery');
}
export async function makeDirectory(directory){
 if(!isRemoteFile(directory))return mkdir(directory,{recursive:true,mode:0o700});
 const {options,value}=fileOptions(directory);return withSession(options,sftp=>makeRemoteDirectory(sftp,value));
}
export async function statFile(file){
 if(!isRemoteFile(file)){const value=await localPath(file),attrs=await stat(value);if(!attrs.isFile())throw new Error('Backup path is not a file');return attrs;}
 const {options}=fileOptions(file);
 return withSession(options,async sftp=>{const value=await ownedRemote(sftp,file),attrs=await call(sftp,'stat',value);if(!attrs.isFile())throw new Error('Backup path is not a file');return attrs;});
}
export async function openRead(file,options={}){
 if(!isRemoteFile(file))return createReadStream(await localPath(file),options);
 const {options:connection}=fileOptions(file),{client,sftp}=await session(connection);
 try{const value=await ownedRemote(sftp,file),stream=sftpReadStream(sftp,value,options);stream.once('close',()=>client.end());return stream;}
 catch(error){client.end();throw error;}
}
export async function openWrite(file){
 if(!isRemoteFile(file))return createWriteStream(file,{flags:'wx',mode:0o600});
 const {options,value}=fileOptions(file),{client,sftp}=await session(options);
 try{
  const root=(await call(sftp,'realpath',options.root)).replace(/\/$/,''),parent=await call(sftp,'realpath',path.posix.dirname(value));
  if(parent!==root&&!parent.startsWith(root+'/'))throw new Error('Storage output path escapes the configured root');
  const stream=sftpWriteStream(sftp,value);stream.once('close',()=>client.end());stream.once('error',()=>client.end());return stream;
 }catch(error){client.end();throw error;}
}
async function syncLocalDirectories(...directories){
 // Windows does not support opening directory handles for fsync through this API.
 if(process.platform==='win32')return;
 const pending=new Set();
 for(let directory of directories){
  directory=path.resolve(directory);
  while(!pending.has(directory)){pending.add(directory);const parent=path.dirname(directory);if(parent===directory)break;directory=parent;}
 }
 // Sync descendants before ancestors so newly created backup directories survive too.
 for(const directory of [...pending].sort((a,b)=>b.length-a.length)){
  const handle=await openFile(directory,'r');try{await handle.sync();}finally{await handle.close();}
 }
}
export async function syncFile(file){
 if(!isRemoteFile(file)){
  // Windows FlushFileBuffers requires a writable handle; POSIX fsync can use r.
  const value=await localPath(file),handle=await openFile(value,process.platform==='win32'?'r+':'r');
  try{await handle.sync();}finally{await handle.close();}
  await syncLocalDirectories(path.dirname(value));return;
 }
 return withSession(fileOptions(file).options,async sftp=>{
  const value=await ownedRemote(sftp,file),handle=await call(sftp,'open',value,'r');
  try{
   if(typeof sftp.ext_openssh_fsync!=='function')throw new Error('SFTP file fsync is unavailable');
   await call(sftp,'ext_openssh_fsync',handle);
  }catch{throw new Error('Durable SFTP publication requires working fsync@openssh.com support');}
  finally{await call(sftp,'close',handle);}
  // SFTP provides no portable directory fsync: file bytes are synced, but rename
  // durability still depends on the independently managed storage server.
 });
}
export async function renameFile(from,to){
 if(!isRemoteFile(from)&&!isRemoteFile(to)){await rename(from,to);await syncLocalDirectories(path.dirname(from),path.dirname(to));return;}
 const a=fileOptions(from),b=fileOptions(to);if(a.options.id!==b.options.id)throw new Error('Cannot publish across storage destinations');
 return withSession(a.options,async sftp=>call(sftp,'rename',await ownedRemote(sftp,from),b.value));
}
export async function removeFile(file){
 if(!isRemoteFile(file)){const value=await localPath(file);await rm(value,{force:true});await syncLocalDirectories(path.dirname(value));return;}
 return withSession(fileOptions(file).options,async sftp=>call(sftp,'unlink',await ownedRemote(sftp,file)));
}
export async function removeDirectory(directory){
 if(!isRemoteFile(directory)){const root=await realpath(config.backupDir),value=await realpath(directory),relative=path.relative(root,value);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Cleanup path escapes storage');return rm(value,{recursive:true,force:true});}
 const {options,value}=fileOptions(directory);
 return withSession(options,async sftp=>{
  const canonical=await call(sftp,'realpath',value),root=(await call(sftp,'realpath',options.root)).replace(/\/$/,'');
  if(!canonical.startsWith(root+'/'))throw new Error('Cleanup path escapes storage');
  for(const name of ['payload.enc.partial','payload.enc']){try{await call(sftp,'unlink',value+'/'+name);}catch(error){if(error.code!==2)throw error;}}
  await call(sftp,'rmdir',value);
 });
}
let capacityReading;
async function remoteCapacity(options){
 return withSession(options,async sftp=>{
  let timer;
  try{
   const value=await Promise.race([call(sftp,'ext_openssh_statvfs',options.root),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Storage capacity request timed out')),5000);})]);
   return filesystemCapacity({blockSize:value.f_frsize||value.f_bsize,blocks:value.f_blocks,free:value.f_bfree,available:value.f_bavail});
  }finally{clearTimeout(timer);}
 });
}
export async function storageCapacity({maxAgeMs=0}={}){
 const options=activeStorage();
 if(options.mode==='unconfigured')return {used:null,total:0,available:null,managedBytes:0,backend:'unconfigured',capacitySource:'none',name:'Connect a storage destination'};
 if(options.mode==='local'){
  const value=await statfs(config.backupDir),managedBytes=db.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM backups WHERE path NOT LIKE 'sftp:%'").get().bytes;
  return {...filesystemCapacity({blockSize:value.bsize,blocks:value.blocks,free:value.bfree,available:value.bavail}),managedBytes,backend:'local',capacitySource:'filesystem',estimated:false};
 }
 let managedBytes=db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM backups WHERE path LIKE ?').get('sftp:'+options.id+':%').bytes;
 managedBytes+=db.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM manager_backups WHERE status='completed' AND target_id=?").get(options.id).bytes;
 if(options.id==='env')managedBytes+=db.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM backups WHERE path LIKE 'sftp:/%'").get().bytes;
 const identity=JSON.stringify([options.id,options.host,options.port,options.username,options.hostKey,options.root]);
 if(capacityReading?.identity!==identity)capacityReading={identity};
 const reading=capacityReading;
 if(!reading.result||Date.now()-reading.readAt>=maxAgeMs){
  if(!reading.pending)reading.pending=remoteCapacity(options).then(value=>({...value,capacitySource:'filesystem',estimated:false})).catch(()=>({used:null,total:null,available:null,capacitySource:'unavailable',estimated:false})).then(result=>{reading.result=result;reading.readAt=Date.now();reading.pending=null;return result;});
  await reading.pending;
 }
 return {...reading.result,managedBytes,backend:'sftp',targetId:options.id,name:options.name||'Storage Box'};
}
