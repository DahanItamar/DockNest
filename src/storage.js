import { Client } from 'ssh2';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat, mkdir, rename, rm, realpath, statfs } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';
import { open } from './crypto.js';
import { backupLayout } from './backup-layout.js';
import { sftpWriteStream } from './sftp-streams.js';

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
 try{
  const privateKey=options.privateKey||(options.keyFile?await readFile(options.keyFile):undefined);
  const password=options.password||(options.passwordFile?(await readFile(options.passwordFile,'utf8')).trimEnd():undefined);
  await new Promise((resolve,reject)=>{
   client.once('error',reject).once('ready',resolve);
   client.connect({host:options.host,port:options.port,username:options.username,privateKey,password,hostHash:'sha256',hostVerifier:hash=>hash.toLowerCase()===options.hostKey.toLowerCase(),readyTimeout:15000,keepaliveInterval:10000});
  });
  const sftp=await new Promise((resolve,reject)=>client.sftp((error,value)=>error?reject(error):resolve(value)));
  return {client,sftp};
 }catch{client.end();throw new Error('Storage connection failed. Check access, authentication and the independently verified host key.');}
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
   try{await call(sftp,'write',handle,Buffer.from('DockNest storage probe'),0,22,0);}finally{await call(sftp,'close',handle);}
   await call(sftp,'rename',temporary,published);
   const attrs=await call(sftp,'stat',published);if(attrs.size!==22)throw new Error('Storage write verification failed');
   const readHandle=await call(sftp,'open',published,'r');
   const buffer=Buffer.alloc(22);
   try{await call(sftp,'read',readHandle,buffer,0,22,0);}finally{await call(sftp,'close',readHandle);}
   if(buffer.toString()!=='DockNest storage probe')throw new Error('Storage read verification failed');
   return {connected:true,writeVerified:true,readVerified:true,renameVerified:true};
  }finally{for(const file of [temporary,published]){try{await call(sftp,'unlink',file);}catch(error){if(error.code!==2)throw error;}}}
 });
}
export function backupDirectory(server,site,id){
 const options=activeStorage();
 if(options.mode==='unconfigured')throw new Error('Connect a remote storage destination before backing up');
 const folders=backupLayout(server,site,id);
 return options.mode==='sftp'?prefix+options.id+':'+path.posix.join(options.root,...folders):path.join(config.backupDir,...folders);
}
export function storageJoin(directory,name){
 if(!isRemoteFile(directory))return path.join(directory,name);
 const {options,value}=fileOptions(directory);return prefix+options.id+':'+path.posix.join(value,name);
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
 try{const value=await ownedRemote(sftp,file),stream=sftp.createReadStream(value,options);stream.once('close',()=>client.end());stream.once('error',()=>client.end());return stream;}
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
export async function renameFile(from,to){
 if(!isRemoteFile(from)&&!isRemoteFile(to))return rename(from,to);
 const a=fileOptions(from),b=fileOptions(to);if(a.options.id!==b.options.id)throw new Error('Cannot publish across storage destinations');
 return withSession(a.options,async sftp=>call(sftp,'rename',await ownedRemote(sftp,from),b.value));
}
export async function removeFile(file){
 if(!isRemoteFile(file))return rm(await localPath(file),{force:true});
 return withSession(fileOptions(file).options,async sftp=>call(sftp,'unlink',await ownedRemote(sftp,file)));
}
export async function removeDirectory(directory){
 if(!isRemoteFile(directory))return rm(directory,{recursive:true,force:true});
 const {options,value}=fileOptions(directory);
 return withSession(options,async sftp=>{
  const canonical=await call(sftp,'realpath',value),root=(await call(sftp,'realpath',options.root)).replace(/\/$/,'');
  if(!canonical.startsWith(root+'/'))throw new Error('Cleanup path escapes storage');
  for(const name of ['payload.enc.partial','payload.enc']){try{await call(sftp,'unlink',value+'/'+name);}catch(error){if(error.code!==2)throw error;}}
  await call(sftp,'rmdir',value);
 });
}
export async function storageCapacity(used=0){
 const options=activeStorage();
 if(options.mode==='unconfigured')return {total:0,available:0,backend:'unconfigured',capacitySource:'none',name:'Connect a storage destination'};
 if(options.mode==='local'){const value=await statfs(config.backupDir);return {total:Number(value.blocks)*Number(value.bsize),available:Number(value.bavail)*Number(value.bsize),backend:'local',capacitySource:'filesystem'};}
 used=db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM backups WHERE path LIKE ?').get('sftp:'+options.id+':%').bytes;
 if(options.id==='env')used+=db.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM backups WHERE path LIKE 'sftp:/%'").get().bytes;
 return {used,total:options.capacity,available:Math.max(0,options.capacity-used),backend:'sftp',targetId:options.id,name:options.name||'Storage Box',capacitySource:'configured',estimated:true};
}
