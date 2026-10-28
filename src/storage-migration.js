import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { db,transaction } from './db.js';
import { backupRoot,backupLayout,backupFilename,managerBackupFilename } from './backup-layout.js';
import { targetOptions,parseRemote,isRemoteFile,targetPrefix,openRead,openWrite,makeDirectory,statFile,syncFile,renameFile,removeFile } from './storage.js';
import { fileExists } from './artifact-journal.js';

export function migrationPlan(){
 const entries=[];
 for(const row of db.prepare('SELECT b.*,s.name AS site_name,s.server_id,v.name AS server_name FROM backups b JOIN sites s ON s.id=b.site_id JOIN servers v ON v.id=s.server_id').all()){
  if(!isRemoteFile(row.path))throw new Error('Local archives need a separate import');
  const {options}=parseRemote(row.path);
  const folders=backupLayout({id:row.server_id,name:row.server_name},{id:row.site_id,name:row.site_name});
  const destination=targetPrefix(options)+path.posix.join(backupRoot(options.root),...folders,backupFilename(row.id,new Date(row.captured_at)));
  if(destination!==row.path)entries.push({kind:'site',id:row.id,source:row.path,destination,checksum:row.checksum,size:row.size});
 }
 for(const row of db.prepare("SELECT * FROM manager_backups WHERE status='completed'").all()){
  if(!row.path)throw new Error('Local recovery kits need a separate import');
  const options=targetOptions(row.target_id),key=row.path.match(/\/docknest-manager\/([a-f0-9]{16})\//)?.[1]||path.posix.basename(row.path).match(/^docknest_([a-f0-9]{16})_/)?.[1];
  if(!key)throw new Error('Unknown recovery kit layout');
  const destination=targetPrefix(options)+path.posix.join(backupRoot(options.root),'docknest-recovery',managerBackupFilename(key,row.id,new Date(row.created_at)));
  if(destination!==row.path)entries.push({kind:'manager',id:row.id,source:row.path,destination,checksum:row.checksum,size:row.size});
 }
 return entries;
}
async function verify(entry,file){
 if(!/^[a-f0-9]{64}$/.test(entry.checksum)||(await statFile(file)).size!==entry.size)throw new Error('Migration size mismatch');
 const hash=createHash('sha256');for await(const chunk of await openRead(file))hash.update(chunk);
 if(hash.digest('hex')!==entry.checksum)throw new Error('Migration checksum mismatch');
}
export async function migrateStorage(){
 // The CLI owns the same exclusive lock as the worker; API admission must also be stopped.
 if(db.prepare("SELECT value FROM settings WHERE key='deployment_hold'").get()?.value!=='true')throw new Error('Deployment hold required');
 if(db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued','running','recovery_required')").get()
  ||db.prepare("SELECT 1 FROM restores WHERE status IN ('queued','running','recovery_required')").get()
  ||db.prepare("SELECT 1 FROM manager_backups WHERE status IN ('queued','running')").get()
  ||db.prepare("SELECT 1 FROM artifact_operations WHERE state IN ('prepared','authenticated')").get()
  ||db.prepare('SELECT 1 FROM retention_operations').get()
  // A copy step or a copy deletion still running (docs/backup-copies.md): copies stay where they are and are not migrated.
  ||db.prepare("SELECT 1 FROM backup_copies WHERE status='copying' OR delete_state='pending'").get()
  ||db.prepare('SELECT 1 FROM downloads WHERE expires_at>?').get(Date.now())
  ||db.prepare('SELECT 1 FROM manager_backup_downloads WHERE expires_at>?').get(Date.now()))throw new Error('Active operations block migration');
 const reconciliation=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='artifact_reconciliation'").get()?.value||'{}');
 if(reconciliation.pending)throw new Error('Reconciliation blocks migration');
 const plan=migrationPlan();
 db.exec('CREATE TABLE IF NOT EXISTS storage_migrations(kind TEXT NOT NULL,id TEXT NOT NULL,source TEXT NOT NULL,destination TEXT NOT NULL,checksum TEXT NOT NULL,size INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(kind,id))');
 // Deferred Object-Locked backups are copied like any other point; the locked original stays until its lock ends.
 let migrated=0,lockedOriginals=0;
 for(const entry of plan){
  const saved=db.prepare('SELECT * FROM storage_migrations WHERE kind=? AND id=?').get(entry.kind,entry.id);
  if(saved&&['source','destination','checksum','size'].some(key=>saved[key]!==entry[key]))throw new Error('Migration journal changed');
  const temporary=entry.destination+'.migration-partial';
  if(!saved){
   if(await fileExists(entry.destination)||await fileExists(temporary))throw new Error('Migration destination collision');
   db.prepare("INSERT INTO storage_migrations VALUES(?,?,?,?,?,?,'copying')").run(entry.kind,entry.id,entry.source,entry.destination,entry.checksum,entry.size);
  }
  await verify(entry,entry.source);
  if(!await fileExists(entry.destination)){
   if(await fileExists(temporary))await removeFile(temporary);
   await makeDirectory(entry.destination.slice(0,entry.destination.lastIndexOf('/')));
   const input=await openRead(entry.source);let output;
   try{output=await openWrite(temporary);await pipeline(input,output);}finally{input.destroy();output?.destroy();}
   await syncFile(temporary);await verify(entry,temporary);await renameFile(temporary,entry.destination);
  }
  await syncFile(entry.destination);await verify(entry,entry.destination);
  transaction(()=>{
   const table=entry.kind==='site'?'backups':'manager_backups';
   if(db.prepare('UPDATE '+table+' SET path=? WHERE id=? AND path=?').run(entry.destination,entry.id,entry.source).changes!==1)throw new Error('Migration metadata changed');
   if(entry.kind==='site')db.prepare("UPDATE artifact_operations SET published=? WHERE backup_id=? AND state='completed'").run(entry.destination,entry.id);
   db.prepare("UPDATE storage_migrations SET state='completed' WHERE kind=? AND id=?").run(entry.kind,entry.id);
   if(entry.kind==='site'&&db.prepare('DELETE FROM retention_deferrals WHERE backup_id=?').run(entry.id).changes)lockedOriginals++;
  });
  migrated++;
 }
 return {migrated,originalsRetained:true,...(lockedOriginals?{lockedOriginals}:{})};
}
