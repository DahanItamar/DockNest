import {formatRecoveryTime} from '../../shared/recovery-time.js';
import {age} from '../age.js';

// Recovery time on the screens (docs/recovery-time-adr.md). The numbers are measured by the newest passed restore test and
// computed by the API; this file only words them. One age formatter (web/age.js) serves "Passed 3 days ago" and "proven 3 days ago".
// recovery: { seconds, phases?, provenAt, stale, mayBeLow } or null.
export const aboutTime=seconds=>{const text=formatRecoveryTime(seconds);return text?(text.startsWith('under')?text:'about '+text):null};
export function recoveryText(recovery,now=Date.now()){
 const time=recovery&&aboutTime(recovery.seconds);
 if(!time)return null;
 const proven=age(recovery.provenAt,now);
 return {time,line:'Back in '+time+(proven?' · proven '+proven:''),stale:!!recovery.stale,mayBeLow:!!recovery.mayBeLow};
}
// Short value used in tables ("About 12 min"); null when nothing is measured.
export const recoveryValue=recovery=>{const time=recovery&&aboutTime(recovery.seconds);return time?time.charAt(0).toUpperCase()+time.slice(1):null};
export const PHASES=[['copy','Get the backup','one'],['restore','Restore data','two'],['start','Start and check','three']];
// One phase: whole minutes (the same rounding as the total), hours past 90 minutes.
const phaseText=seconds=>seconds<60?'under 1 min':seconds>5400?formatRecoveryTime(seconds):Math.ceil(seconds/60)+' min';
export function phaseRows(phases){
 const total=PHASES.reduce((sum,[key])=>sum+(Number(phases?.[key])||0),0);
 if(!(total>0))return [];
 return PHASES.map(([key,label,tone])=>{const seconds=Number(phases[key])||0;return {key,label,tone,seconds,share:seconds/total,text:phaseText(seconds)}}).filter(row=>row.seconds>0);
}
// "20 Nov 2026" and "02:14", in the viewer's own zone, English month names.
export const shortDay=iso=>{const date=new Date(iso);return Number.isNaN(date.getTime())?'':date.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})};
export const clock=iso=>{const date=new Date(iso);return Number.isNaN(date.getTime())?'':date.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hourCycle:'h23'})};
export const RESULT_TEXT={passed:'Passed',failed:'Failed',couldnt_run:'Couldn’t run',cancelled:'Cancelled'};
