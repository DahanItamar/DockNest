// Storage facade: resolves 'scheme:<targetId>:/path' references to a backend adapter.
// Local paths are plain filesystem paths. Every remote adapter implements:
// resolve(options,remote) test readiness makeDirectory statFile openRead openWrite
// syncFile renameFile removeFile removeDirectory capacity — all taking (options,value).
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db.js';
import { open } from '../crypto.js';
import { backupLayout,backupRoot } from '../backup-layout.js';
import * as local from './local.js';
import * as sftp from './sftp.js';
import * as s3 from './s3.js';

export const adapters={sftp,s3};
const schemes=Object.keys(adapters);
export const remoteModes=schemes;
export const targetPrefix=options=>options.mode+':'+options.id+':';
// Rows store S3 settings beside the shared columns; the credential is sealed like SFTP secrets.
export const targetMode=row=>row.auth_type==='s3-access-key'?'s3':'sftp';
export const isRemoteFile=file=>schemes.some(scheme=>file.startsWith(scheme+':'));
export function targetOptions(id){
 if(id==='env')return {...config.storage,id:'env'};
 const row=db.prepare('SELECT * FROM storage_targets WHERE id=?').get(id);
 if(!row)throw new Error('Storage destination is missing; restore its connection configuration before accessing its backups');
 if(targetMode(row)==='s3'){
  const settings=JSON.parse(db.prepare('SELECT settings FROM storage_target_settings WHERE target_id=?').get(row.id)?.settings||'null');
  if(!settings)throw new Error('S3 destination settings are missing; reconnect the destination');
  const {accessKeyId,secretAccessKey}=JSON.parse(open(row.credential));
  return {id:row.id,mode:'s3',name:row.name,endpoint:settings.endpoint,region:settings.region,bucket:settings.bucket,pathStyle:Boolean(settings.pathStyle),objectLock:settings.objectLock||null,root:row.root,capacity:null,accessKeyId,secretAccessKey};
 }
 return {id:row.id,mode:'sftp',name:row.name,host:row.host,port:row.port,username:row.username,hostKey:row.host_key,root:row.root,capacity:row.capacity_bytes,...(row.auth_type==='password'?{password:open(row.credential)}:{privateKey:open(row.credential)})};
}
export function activeStorage(){
 const selected=db.prepare("SELECT value FROM settings WHERE key='backup_storage_target'").get();
 return selected?targetOptions(selected.value):{...config.storage,id:'env'};
}
// Parse a remote reference into its adapter, target options and normalized in-root value.
export function parseRemote(file){
 const scheme=schemes.find(name=>file.startsWith(name+':'));
 if(!scheme)throw new Error('Expected an SFTP storage path');
 const value=file.slice(scheme.length+1),separator=value.indexOf(':');
 // Legacy environment destinations use 'sftp:/absolute/path' without an identifier.
 const id=value.startsWith('/')?'env':value.slice(0,separator);
 const options=targetOptions(id),remote=value.startsWith('/')?value:value.slice(separator+1);
 if(options.mode!==scheme)throw new Error('Storage reference does not match its destination type');
 const adapter=adapters[scheme];
 return {adapter,options,value:adapter.resolve(options,remote)};
}
const remoteOf=options=>{const adapter=adapters[options.mode];if(!adapter)throw new Error('Unsupported storage destination type');return adapter;};
// `options`: the destination to check (a site's main destination); the default destination when omitted.
export async function checkStorageReadiness(options=activeStorage()){
 if(options.mode==='unconfigured')throw new Error('Storage is not configured');
 if(options.mode==='local')await local.readiness();else await remoteOf(options).readiness(options);
 const capacity=await storageCapacity({options});
 if(capacity.available===null&&!capacity.unbounded)throw new Error('Storage available space could not be verified. Check the connection and filesystem capacity support.');
 if(capacity.available!==null&&capacity.available<1024**3)throw new Error('Insufficient storage capacity');
 return {reachable:true,writeTested:false};
}
export const testStorageTarget=options=>remoteOf({mode:'sftp',...options}).test(options);
// `options`: the site's main destination (src/site-storage.js); the default destination when omitted.
export function backupDirectory(server,site,options=activeStorage()){
 if(!options||typeof options!=='object')throw new TypeError('backupDirectory needs storage destination options');
 if(options.mode==='unconfigured')throw new Error('Connect a remote storage destination before backing up');
 const folders=backupLayout(server,site);
 return options.mode==='local'?local.backupDirectory(folders):targetPrefix(options)+path.posix.join(backupRoot(options.root),...folders);
}
export function storageJoin(directory,name){
 if(!isRemoteFile(directory))return local.join(directory,name);
 const {options,value}=parseRemote(directory);return targetPrefix(options)+path.posix.join(value,name);
}
export function managerBackupDirectory(targetId,keyId){
 const options=targetOptions(targetId);
 if(!adapters[options.mode])throw new Error('DockNest backup requires the selected SFTP destination');
 if(!/^[a-f0-9]{16}$/.test(keyId))throw new Error('Invalid manager key identifier');
 return targetPrefix(options)+path.posix.join(backupRoot(options.root),'docknest-recovery');
}
const route=(method,localMethod=method)=>async(file,...args)=>{
 if(!isRemoteFile(file))return local[localMethod](file,...args);
 const {adapter,options,value}=parseRemote(file);return adapter[method](options,value,...args);
};
export const makeDirectory=route('makeDirectory');
export const statFile=route('statFile');
export const openRead=route('openRead');
export const openWrite=route('openWrite');
export const syncFile=route('syncFile');
export const removeFile=route('removeFile');
export const removeDirectory=route('removeDirectory');
export async function renameFile(from,to){
 if(!isRemoteFile(from)&&!isRemoteFile(to))return local.renameFile(from,to);
 const a=parseRemote(from),b=parseRemote(to);if(a.options.id!==b.options.id)throw new Error('Cannot publish across storage destinations');
 return a.adapter.renameFile(a.options,a.value,b.value);
}
// A backup whose main package aged out while a copy is kept points backups.path at that copy; its bytes are counted once,
// as a copy. Copies count on the destination that holds them (docs/backup-copies.md).
const mainOnly=' AND id NOT IN (SELECT backup_id FROM backup_main_removed)';
export const copyBytesOn=targetId=>db.prepare("SELECT COALESCE(SUM(b.size),0) AS bytes FROM backup_copies c JOIN backups b ON b.id=c.backup_id WHERE c.target_id=? AND c.status='verified'").get(targetId).bytes;
function managedBytes(options){
 if(options.mode==='local')return db.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM backups WHERE "+schemes.map(()=>'path NOT LIKE ?').join(' AND ')+mainOnly).get(...schemes.map(scheme=>scheme+':%')).bytes;
 let bytes=db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM backups WHERE path LIKE ?'+mainOnly).get(targetPrefix(options)+'%').bytes+copyBytesOn(options.id);
 bytes+=db.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM manager_backups WHERE status='completed' AND target_id=?").get(options.id).bytes;
 if(options.id==='env')bytes+=db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM backups WHERE path LIKE ?'+mainOnly).get(options.mode+':/%').bytes;
 return bytes;
}
export async function storageCapacity({maxAgeMs=0,options=activeStorage()}={}){
 if(options.mode==='unconfigured')return {used:null,total:0,available:null,managedBytes:0,backend:'unconfigured',capacitySource:'none',name:'Connect a storage destination'};
 if(options.mode==='local')return {...await local.capacity(),managedBytes:managedBytes(options)};
 const bytes=managedBytes(options);
 return {...await remoteOf(options).capacity(options,{maxAgeMs,managedBytes:bytes}),managedBytes:bytes};
}
