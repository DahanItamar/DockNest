// SFTP adapter: pinned host keys, fsync@openssh.com and atomic rename publication.
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
export async function test(options){
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
  const stream=sftpWriteStream(sftp,value);stream.once('close',()=>client.end());stream.once('error',()=>client.end());return stream;
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
