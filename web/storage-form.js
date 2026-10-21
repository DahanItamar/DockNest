// Pure helpers for the storage connection form (unit-tested in tests/storage-form.test.js).
import { readSchedule } from './schedule.js';

// Server validation paths mapped to form field names and readable labels.
const fieldNames={'objectLock.days':'lockDays','objectLock.mode':'lockMode',objectLock:'lockMode',capacityBytes:'capacityTB'};
const labels={name:'Destination name',endpoint:'Endpoint URL',region:'Region',bucket:'Bucket',prefix:'Folder prefix',accessKeyId:'Access key ID',secretAccessKey:'Secret access key',lockDays:'Lock days',lockMode:'Object Lock mode',host:'Storage hostname',port:'SFTP port',username:'Storage username',hostKey:'SSH host fingerprint',password:'Storage password',privateKey:'SSH private key',root:'Backup directory',capacityTB:'Capacity',authType:'Authentication method'};
// Splits 'path: message; path: message' (the API's validation format) into per-field errors.
export function splitFieldErrors(text=''){
 const parts=String(text).split(/;\s+(?=[A-Za-z][\w.]*:\s)/),fields={},lines=[];
 for(const part of parts){
  const match=part.match(/^([A-Za-z][\w.]*):\s+([\s\S]*)$/);
  if(!match){lines.push(part.replace(/^:\s*/,''));continue;}
  const name=fieldNames[match[1]]||match[1].split('.')[0];
  if(labels[name]){fields[name]??=match[2];lines.push(labels[name]+': '+match[2]);}
  else lines.push(match[2]);
 }
 return {fields,first:Object.keys(fields)[0]||null,message:lines.join(' ')};
}
// Region implied by well-known endpoints; null when the endpoint does not name one.
export function regionFromEndpoint(value){
 let host;try{host=new URL(String(value).trim()).hostname.toLowerCase();}catch{return null;}
 if(host.endsWith('.r2.cloudflarestorage.com'))return 'auto';
 let match=host.match(/^s3\.([a-z0-9-]+)\.backblazeb2\.com$/);if(match)return match[1];
 if(host==='s3.amazonaws.com'||host==='s3.dualstack.amazonaws.com'||host==='s3.wasabisys.com')return 'us-east-1';
 match=host.match(/^s3[.-](?:dualstack\.)?([a-z]{2}(?:-gov)?-[a-z]+-\d)\.amazonaws\.com$/)||host.match(/^s3\.([a-z0-9-]+)\.wasabisys\.com$/);
 return match?match[1]:null;
}
// Days of history a policy keeps: retention points times the schedule interval, or null for custom schedules.
export function retentionWindowDays(schedule,retention){
 const interval={hourly:1/24,daily:1,weekly:7}[readSchedule(schedule||'').frequency];
 return interval&&retention>0?retention*interval:null;
}
// Non-blocking warnings when Object Lock outlives the shortest enabled retention window.
export function lockWarnings(days,sites=[],policies=[]){
 const warnings=[],lockDays=Number(days);
 if(!Number.isFinite(lockDays)||lockDays<1)return warnings;
 const windows=policies.filter(policy=>policy.enabled).map(policy=>({site:sites.find(site=>site.id===policy.site_id)?.name||'a site',days:retentionWindowDays(policy.schedule,policy.retention)}));
 const known=windows.filter(item=>item.days!==null).sort((a,b)=>a.days-b.days)[0];
 if(known&&lockDays>known.days){const kept=Math.max(1,Math.round(known.days));warnings.push('Backups will be locked longer than your retention setting keeps them ('+known.site+' keeps about '+kept+' day'+(kept===1?'':'s')+'). They stay usable and will be removed after the lock ends.');}
 else if(!known&&windows.length)warnings.push('Some schedules could not be read. Backups that retention would remove sooner stay usable and are removed after the lock ends.');
 if(lockDays>365)warnings.push('Locks longer than a year keep every backup, and its storage cost, for more than a year.');
 return warnings;
}
