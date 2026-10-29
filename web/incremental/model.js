import {count} from '../plural.js';

export const MIN_BACKUPS=2,MAX_BACKUPS=31,DEFAULT_BACKUPS=7;
// The API stores increments between two full backups (1 to 30, default 6). The page speaks in backups: 1 full + N increments.
export const toBackups=increments=>Number(increments)+1;
export const toIncrements=backups=>Number(backups)-1;
export const validBackups=value=>/^\d+$/.test(String(value).trim())&&Number(value)>=MIN_BACKUPS&&Number(value)<=MAX_BACKUPS;
export const intervalLine=backups=>'1 full, then '+count(backups-1,'increment');

export const isIncremental=backup=>backup?.backupKind==='incremental';
// A row shows chain details for increments and for full backups that start a chain.
export const inChain=backup=>!!backup&&(isIncremental(backup)||(backup.backupKind==='full'&&(backup.dependents>0||backup.chainLength>1)));
export const kindLabel=backup=>isIncremental(backup)?'Increment '+backup.chainPosition:'Full';
export const dependentsLine=backup=>backup.dependents>0?count(backup.dependents,'backup')+(backup.dependents===1?' depends':' depend')+' on this':'';
export const chainOf=(backup,all)=>all.filter(item=>item.chainId&&item.chainId===backup.chainId).sort((a,b)=>a.chainPosition-b.chainPosition);

export const SAVE_ERRORS={
 invalid_interval:{reason:'Full backup interval must be a whole number from 2 to 31.',action:'Enter a number in that range.'},
 static_site:{reason:'Static sites cannot use incremental backups.',action:'Use a Docker site.'},
 site_removed:{reason:'This site was removed.',action:'Close this dialog and reload the page.'},
 incremental_off:{reason:'Incremental backups are off for this site.',action:'Turn them on and save, then start a full backup.'}
};
export const saveError=error=>SAVE_ERRORS[error?.code]||{reason:error?.message||'Incremental settings could not be saved.',action:'Check the choices and try again.'};
