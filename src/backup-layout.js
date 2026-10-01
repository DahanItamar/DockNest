export function backupLayout(server,site,backupId,at=new Date()) {
 const folder=(item,fallback)=>{
  const id=typeof item==='string'?item:item.id;
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new Error('Invalid backup folder identifier');
  const name=typeof item==='string'?item:item.name;
  const label=(name||fallback).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,48).replace(/-$/,'')||fallback;
  return label+'--'+id;
 };
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(backupId))throw new Error('Invalid backup identifier');
 const stamp=at.toISOString();
 return [folder(server,'server'),folder(site,'site'),stamp.slice(0,10),stamp.slice(11,19).replaceAll(':','-')+'Z--'+backupId];
}
