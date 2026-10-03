import path from 'node:path';

export function backupRoot(root){
 const normalized=path.posix.normalize(root);
 return path.posix.basename(normalized)==='BACKUP'?normalized.replace(/\/+$/,''):path.posix.join(normalized,'BACKUP');
}
export function backupLayout(server,site) {
 const folder=(item,fallback)=>{
  const id=typeof item==='string'?item:item.id;
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new Error('Invalid backup folder identifier');
  const name=typeof item==='string'?item:item.name;
  const label=(name||fallback).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,48).replace(/-$/,'')||fallback;
  return label+'--'+id;
 };
 return [folder(server,'server'),folder(site,'site')];
}
const timestamp=at=>at.toISOString().slice(0,19).replace('T','_').replaceAll(':','-')+'Z';
export function backupFilename(backupId,at=new Date()){
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(backupId))throw new Error('Invalid backup identifier');
 return 'backup_'+timestamp(at)+'--'+backupId+'.tar.gz.enc';
}
export function managerBackupFilename(keyId,backupId,at=new Date()){
 if(!/^[a-f0-9]{16}$/.test(keyId))throw new Error('Invalid manager key identifier');
 // Use the same identifier validation for site archives and manager kits.
 backupFilename(backupId,at);
 return 'docknest_'+keyId+'_'+timestamp(at)+'--'+backupId+'.dkit';
}
