// Storage per site (docs/backup-copies.md). A site writes its backups to its own main destination or, when it has none
// (no row, or main_target_id NULL), to the default destination exactly as before. A site may also keep up to three
// extra copies on other destinations. This module resolves destinations and validates site settings; it reads names and
// public connection settings only and never returns or logs a credential.
import path from 'node:path';
import { db,audit,transaction } from './db.js';
import { config } from './config.js';
import { activeStorage,targetOptions,targetMode,targetPrefix } from './storage.js';
import { backupRoot,backupLayout } from './backup-layout.js';

export const MAX_COPIES=3,MIN_RETENTION=1,MAX_RETENTION=365;
const fail=(status,code,message)=>Object.assign(new Error(message),{status,code});
const envConfigured=()=>config.storage.mode!=='unconfigured';
// { id, name, mode } of a destination, or null when it does not exist (removed, or the environment one is unconfigured).
export function targetSummary(targetId){
 if(targetId==='env')return envConfigured()?{id:'env',name:config.storage.mode==='local'?'Local disk':'Configured storage',mode:config.storage.mode}:null;
 const row=db.prepare('SELECT id,name,auth_type FROM storage_targets WHERE id=?').get(String(targetId??''));
 return row?{id:row.id,name:row.name,mode:targetMode(row)}:null;
}
export const defaultTargetId=()=>db.prepare("SELECT value FROM settings WHERE key='backup_storage_target'").get()?.value??'env';
export const defaultSummary=()=>targetSummary(defaultTargetId());
export const siteMainTargetId=siteId=>db.prepare('SELECT main_target_id FROM site_storage WHERE site_id=?').get(siteId)?.main_target_id??null;
export const effectiveMainTargetId=siteId=>siteMainTargetId(siteId)??defaultTargetId();
export const siteCopyTargets=siteId=>db.prepare('SELECT target_id,retention,created_at FROM site_storage_copies WHERE site_id=? ORDER BY rowid').all(siteId); // the order the owner gave
// The destination new backups of the site are written to. A chosen destination that no longer exists fails closed:
// DockNest never falls back to another destination the owner did not pick.
export function siteMainStorage(siteId){
 const chosen=siteMainTargetId(siteId);
 if(chosen===null)return activeStorage();
 if(!targetSummary(chosen))throw fail(409,'destination_missing','The main destination chosen for this site was removed. Choose another main destination in the site storage settings.');
 return targetOptions(chosen);
}
// The destination id a stored path belongs to: "sftp:<id>:/path", "s3:<id>:/key", legacy "sftp:/path" (env) or local.
export function targetIdOfPath(file){
 const match=/^(sftp|s3):([^:/]*):/.exec(String(file??''));
 return match&&match[2]!==''?match[2]:'env';
}
// Where a destination physically stores files. Two destination rows with the same server (or bucket) and the same or a
// nested folder would hold one file twice under two names, so a "copy" there would not be a copy at all.
export function locationOf(targetId){
 if(targetId==='env'){
  if(config.storage.mode==='local')return {kind:'local',place:config.backupDir.toLowerCase(),root:'/'};
  return {kind:'sftp',place:`${config.storage.host.toLowerCase()}:${config.storage.port}`,root:config.storage.root.replace(/\/+$/,'')||'/'};
 }
 const row=db.prepare('SELECT * FROM storage_targets WHERE id=?').get(targetId);if(!row)return null;
 if(targetMode(row)==='s3'){
  let settings={};try{settings=JSON.parse(db.prepare('SELECT settings FROM storage_target_settings WHERE target_id=?').get(row.id)?.settings||'{}');}catch{/* unknown */}
  return {kind:'s3',place:`${String(settings.endpoint||'').toLowerCase()}|${String(settings.bucket||row.username).toLowerCase()}`,root:(row.root||'/').replace(/\/+$/,'')||'/'};
 }
 return {kind:'sftp',place:`${row.host.toLowerCase()}:${row.port}`,root:row.root.replace(/\/+$/,'')||'/'};
}
const nested=(a,b)=>a==='/'||b==='/'||a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
export function sameLocation(first,second){
 if(first===second)return true;
 const a=locationOf(first),b=locationOf(second);
 return Boolean(a&&b&&a.kind===b.kind&&a.place===b.place&&nested(a.root,b.root));
}
// The copy of a backup keeps the main copy's folder layout and file name under the copy destination's own root.
export function copyPathFor(targetId,server,site,mainPath){
 const summary=targetSummary(targetId);if(!summary||!['sftp','s3'].includes(summary.mode))throw fail(409,'unknown_destination','Copy destinations must be connected SFTP or S3 destinations.');
 const root=targetId==='env'?config.storage.root:db.prepare('SELECT root FROM storage_targets WHERE id=?').get(targetId).root;
 // Local main copies (development and tests) may use either separator.
 const filename=String(mainPath).split(/[\\/]/).pop();
 return targetPrefix({mode:summary.mode,id:targetId})+path.posix.join(backupRoot(root),...backupLayout(server,site),filename);
}
const policyRetention=siteId=>db.prepare('SELECT retention FROM policies WHERE site_id=?').get(siteId)?.retention||7;
export const effectiveRetention=(siteId,retention)=>retention??policyRetention(siteId);

// "Copy missing": the newest verified backup lacks a verified copy on a configured copy destination. A first attempt
// still in flight (pending or copying, never failed) is not missing yet.
export function copyMissing(siteId){
 const targets=siteCopyTargets(siteId);if(!targets.length)return false;
 const newest=db.prepare('SELECT id FROM backups WHERE site_id=? AND verified=1 ORDER BY captured_at DESC,id DESC LIMIT 1').get(siteId);if(!newest)return false;
 for(const {target_id:targetId} of targets){
  const copy=db.prepare('SELECT status,attempts FROM backup_copies WHERE backup_id=? AND target_id=?').get(newest.id,targetId);
  if(copy?.status==='verified')continue;
  if(copy&&['pending','copying'].includes(copy.status)&&copy.attempts===0)continue;
  return true;
 }
 return false;
}
const summaryOrRemoved=targetId=>targetSummary(targetId)??{id:targetId,name:'Removed destination',mode:null};
export function siteStorageView(siteId){
 const chosen=siteMainTargetId(siteId),effectiveId=chosen??defaultTargetId();
 return {siteId,main:{targetId:chosen,effective:summaryOrRemoved(effectiveId)},default:defaultSummary(),
  copies:siteCopyTargets(siteId).map(row=>{const summary=summaryOrRemoved(row.target_id);return {targetId:row.target_id,name:summary.name,mode:summary.mode,retention:row.retention,effectiveRetention:effectiveRetention(siteId,row.retention)};}),
  maxCopies:MAX_COPIES,copyMissing:copyMissing(siteId)};
}
// The `storage` object each site carries in /api/state.
export const siteStorageSummary=siteId=>({mainTargetId:siteMainTargetId(siteId),copyTargetIds:siteCopyTargets(siteId).map(row=>row.target_id),copyMissing:copyMissing(siteId)});

const remoteTarget=targetId=>{const summary=targetSummary(targetId);return summary&&['sftp','s3'].includes(summary.mode)?summary:null;};
// Validates and saves PUT /api/sites/:id/storage. Existing backups never move: a new main destination applies to the next
// backup, and a removed copy destination only stops new copies (the copies already made stay until their backup goes).
export function updateSiteStorage(siteId,body,actor){
 if(!body||typeof body!=='object'||Array.isArray(body))throw fail(400,'invalid_request','Send mainTargetId and copies.');
 const mainTargetId=body.mainTargetId===undefined?null:body.mainTargetId;
 if(mainTargetId!==null&&(typeof mainTargetId!=='string'||!targetSummary(mainTargetId)))throw fail(400,'unknown_destination','The chosen main destination does not exist.');
 if(mainTargetId!==null&&mainTargetId!=='env'&&!remoteTarget(mainTargetId))throw fail(400,'unknown_destination','The chosen main destination does not exist.');
 const copies=body.copies===undefined?[]:body.copies;
 if(!Array.isArray(copies))throw fail(400,'invalid_request','copies must be a list.');
 if(copies.length>MAX_COPIES)throw fail(400,'too_many_copies',`A site can keep at most ${MAX_COPIES} extra copies.`);
 const effectiveMain=mainTargetId??defaultTargetId(),seen=[];
 for(const copy of copies){
  if(!copy||typeof copy!=='object'||typeof copy.targetId!=='string'||!remoteTarget(copy.targetId))throw fail(400,'unknown_destination','A copy destination does not exist.');
  const retention=copy.retention===undefined?null:copy.retention;
  if(retention!==null&&!(Number.isInteger(retention)&&retention>=MIN_RETENTION&&retention<=MAX_RETENTION))throw fail(400,'invalid_retention',`Keep between ${MIN_RETENTION} and ${MAX_RETENTION} copies, or use the site's count.`);
  if(sameLocation(copy.targetId,effectiveMain))throw fail(400,'copy_equals_main','A copy must go to a different destination than the main one.');
  if(seen.some(other=>sameLocation(other,copy.targetId)))throw fail(400,'duplicate_copy','Each copy needs its own destination.');
  seen.push(copy.targetId);
 }
 const at=new Date().toISOString();
 transaction(()=>{
  if(!db.prepare('SELECT 1 FROM sites WHERE id=?').get(siteId))throw fail(404,'not_found','Site not found.');
  db.prepare('INSERT INTO site_storage(site_id,main_target_id,updated_at) VALUES(?,?,?) ON CONFLICT(site_id) DO UPDATE SET main_target_id=excluded.main_target_id,updated_at=excluded.updated_at').run(siteId,mainTargetId,at);
  const previous=new Map(siteCopyTargets(siteId).map(row=>[row.target_id,row]));
  db.prepare('DELETE FROM site_storage_copies WHERE site_id=?').run(siteId);
  for(const copy of copies)db.prepare('INSERT INTO site_storage_copies(site_id,target_id,retention,created_at) VALUES(?,?,?,?)').run(siteId,copy.targetId,copy.retention??null,previous.get(copy.targetId)?.created_at??at);
  // Copies not made yet to a destination the site no longer copies to are cancelled. Made copies stay, under the site's count.
  const listed=new Set(copies.map(copy=>copy.targetId));
  for(const targetId of previous.keys())if(!listed.has(targetId))db.prepare("UPDATE backup_copies SET status='deleted',next_attempt_at=NULL,updated_at=? WHERE target_id=? AND status IN ('pending','failed','gave_up') AND backup_id IN (SELECT id FROM backups WHERE site_id=?)").run(at,targetId,siteId);
  // Names only: the audit trail never holds a credential or connection detail.
  audit(actor,'site.storage_update',siteId,{mainTargetId,copies:copies.map(copy=>({targetId:copy.targetId,retention:copy.retention??null}))});
 });
 return siteStorageView(siteId);
}
