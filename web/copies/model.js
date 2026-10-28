import {count} from '../plural.js';
export const MAX_COPIES=3;

// API 400 codes for PUT /api/sites/:id/storage: what happened and what to do next.
export const STORAGE_ERRORS={
 too_many_copies:{reason:'A site can keep up to 3 extra copies.',action:'Remove one copy, then save.'},
 duplicate_copy:{reason:'The same destination is listed twice.',action:'Keep each destination once.'},
 copy_equals_main:{reason:'A copy cannot use the main destination.',action:'Pick a different destination for the copy.'},
 unknown_destination:{reason:'A chosen destination no longer exists.',action:'Choose another destination.'},
 invalid_retention:{reason:'Keep must be a whole number from 1 to 365.',action:'Enter a number in that range.'}
};
export function storageError(error){
 const known=STORAGE_ERRORS[error?.code];
 return known||{reason:error?.message||'Storage could not be saved.',action:'Check the choices and try again.'};
}

// Copy status from the API -> the label shown in the backup list.
const COPY_STATES={
 verified:{state:'success',word:'Verified'},
 copying:{state:'running',word:'Copying'},
 pending:{state:'queued',word:'Waiting'},
 failed:{state:'needs-review',word:'Missing, retrying'},
 gave_up:{state:'failed',word:'Missing, gave up'}
};
export const copyLabel=copy=>COPY_STATES[copy.status]||{state:'queued',word:'Waiting'};
export const canRetry=copy=>copy.status==='failed'||copy.status==='gave_up';

// Copy lines for a backup row. Nothing for a backup without copies (every backup made before 2.11).
export function copyLines(backup){
 const copies=Array.isArray(backup.copies)?backup.copies:[];
 if(!copies.length)return [];
 const lines=[];
 if(backup.mainTarget)lines.push({key:'main:'+backup.mainTarget.id,name:backup.mainTarget.name,state:'success',word:'Main'});
 for(const copy of copies)lines.push({key:copy.targetId,name:copy.name,copy,...copyLabel(copy)});
 return lines;
}

export function siteStorageSummary(site){
 const storage=site.storage;
 if(!storage)return null;
 const extra=Array.isArray(storage.copyTargetIds)?storage.copyTargetIds.length:0;
 return {main:storage.mainTargetId?'Own destination':'Default destination',copies:extra?count(extra,'extra copy','extra copies'):'No extra copies',missing:!!storage.copyMissing};
}

// 409 destination_in_use body -> readable lines.
export function usageLines(usage,size){
 const lines=[];
 if(usage.copies>0)lines.push(count(usage.copies,'copy','copies')+' of '+count(usage.copyBackups,'backup')+' ('+size(usage.bytes)+')');
 const names=list=>(list||[]).map(site=>site.name).join(', ');
 if(usage.copyForSites?.length)lines.push('Extra copy destination for '+count(usage.copyForSites.length,'site')+': '+names(usage.copyForSites));
 if(usage.mainForSites?.length)lines.push('Main destination for '+count(usage.mainForSites.length,'site')+': '+names(usage.mainForSites));
 return lines;
}

// Restore sources: main first. A copy is only offered when it is verified.
export const sourceText=source=>source.name+(source.role==='main'?' (main)':' (copy)')+(source.status&&source.status!=='verified'?', '+String(source.status).replace(/_/g,' '):'');
export const sourceUsable=source=>source.status==='verified'||source.role==='main';
