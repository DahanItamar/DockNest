import {count} from '../plural.js';

export const MIN_BACKUPS=2,MAX_BACKUPS=31,DEFAULT_BACKUPS=7;
// The API stores increments between two full backups (1 to 30, default 6). The page speaks in backups: 1 full + N increments.
export const toBackups=increments=>Number(increments)+1;
export const toIncrements=backups=>Number(backups)-1;
export const validBackups=value=>/^\d+$/.test(String(value).trim())&&Number(value)>=MIN_BACKUPS&&Number(value)<=MAX_BACKUPS;
export const intervalLine=backups=>'1 full, then '+count(backups-1,'increment');

// Why the helper made a full backup when an increment was planned (stable codes from the capture request).
export const FALLBACK_REASONS={
 'snapshot-missing':'The saved file list for this site was missing on the server.',
 'snapshot-mismatch':'The saved file list on the server no longer matched the last backup.',
 'mount-set-changed':'The containers or mounted folders changed since the last backup.'
};
export const fallbackText=reason=>FALLBACK_REASONS[reason]||'The chain could not continue safely.';

export const isIncremental=backup=>backup?.backupKind==='incremental';
// A row shows chain details for increments and for full backups that start a chain.
export const inChain=backup=>!!backup&&(isIncremental(backup)||(backup.backupKind==='full'&&(backup.dependents>0||backup.chainLength>1)));
export const kindLabel=backup=>isIncremental(backup)?'Increment '+backup.chainPosition+(backup.chainLength?' of '+(backup.chainLength-1):''):'Full';
export const dependentsLine=backup=>backup.dependents>0?count(backup.dependents,'backup')+(backup.dependents===1?' depends':' depend')+' on this':'';
export const chainOf=(backup,all)=>all.filter(item=>item.chainId&&item.chainId===backup.chainId).sort((a,b)=>a.chainPosition-b.chainPosition);

// Everything that goes when one backup is deleted: itself and its dependents (the ones after it in the same chain).
export const doomedWith=(backup,all)=>chainOf(backup,all).filter(item=>item.chainPosition>=backup.chainPosition);
export const deleteTitle=backup=>backup.dependents>0?'Delete this backup and the '+backup.dependents+' '+(backup.dependents===1?'backup':'backups')+' that '+(backup.dependents===1?'depends':'depend')+' on it':'Delete this backup';

export const SAVE_ERRORS={
 invalid_interval:{reason:'Full backup interval must be a whole number from 2 to 31.',action:'Enter a number in that range.'},
 static_site:{reason:'Static sites cannot use incremental backups.',action:'Turn it off, or use a Docker site.'},
 site_removed:{reason:'This site was removed.',action:'Close this dialog and reload the page.'},
 chain_busy:{reason:'A backup is running for this site.',action:'Wait for it to finish, then try again.'}
};
export const saveError=error=>SAVE_ERRORS[error?.code]||{reason:error?.message||'Incremental settings could not be saved.',action:'Check the choices and try again.'};
export const DELETE_ERRORS={
 chain_in_use:{reason:'A restore, restore test or move is using this chain.',action:'Wait for it to finish, then delete again.'},
 pinned:{reason:'A backup in this chain is pinned.',action:'Unpin it first, then delete again.'}
};
export const deleteError=error=>DELETE_ERRORS[error?.code]||{reason:error?.message||'The backup could not be deleted.',action:'Try again in a moment.'};

// Storage report card (incrementalSaving).
export const savingPercent=saving=>saving&&saving.fullEquivalentBytes>0?Math.round(saving.bytesSaved/saving.fullEquivalentBytes*100):0;
