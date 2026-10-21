// Local filesystem adapter (tests and explicitly allowed deployments only).
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, mkdir, rename, rm, realpath, statfs, open as openFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { filesystemCapacity } from '../storage-capacity.js';

export async function localPath(file){
 const root=await realpath(config.backupDir),value=await realpath(file),relative=path.relative(root,value);
 if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Backup path is outside managed storage');
 return value;
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
export async function readiness(){const attrs=await stat(config.backupDir);if(!attrs.isDirectory())throw new Error('Storage directory missing');}
export const backupDirectory=folders=>path.join(config.backupDir,...folders);
export const join=(directory,name)=>path.join(directory,name);
export const makeDirectory=directory=>mkdir(directory,{recursive:true,mode:0o700});
export async function statFile(file){const value=await localPath(file),attrs=await stat(value);if(!attrs.isFile())throw new Error('Backup path is not a file');return attrs;}
export async function openRead(file,options={}){return createReadStream(await localPath(file),options);}
export async function openWrite(file){return createWriteStream(file,{flags:'wx',mode:0o600});}
export async function syncFile(file){
 // Windows FlushFileBuffers requires a writable handle; POSIX fsync can use r.
 const value=await localPath(file),handle=await openFile(value,process.platform==='win32'?'r+':'r');
 try{await handle.sync();}finally{await handle.close();}
 await syncLocalDirectories(path.dirname(value));
}
export async function renameFile(from,to){await rename(from,to);await syncLocalDirectories(path.dirname(from),path.dirname(to));}
export async function removeFile(file){const value=await localPath(file);await rm(value,{force:true});await syncLocalDirectories(path.dirname(value));}
export async function removeDirectory(directory){const root=await realpath(config.backupDir),value=await realpath(directory),relative=path.relative(root,value);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Cleanup path escapes storage');return rm(value,{recursive:true,force:true});}
export async function capacity(){const value=await statfs(config.backupDir);return {...filesystemCapacity({blockSize:value.bsize,blocks:value.blocks,free:value.bfree,available:value.bavail}),backend:'local',capacitySource:'filesystem',estimated:false};}
