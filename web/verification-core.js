import {formatDate} from './date-format.js';
// Pure verification semantics shared by labels, dashboard aggregates and charts (no JSX).
// Four independent evidence levels from src/recovery-evidence.js; `verified` alone means package integrity only.
export const LEVELS=[['integrity','Integrity','Integrity checked'],['consistency','Consistency','Consistency verified'],['isolatedRestore','Isolated restore','Isolated restore tested'],['application','Application checks','Application checks passed']];
export const DESCRIPTIONS={integrity:'The encrypted file is complete and unaltered.',consistency:'Data was captured in a consistent state.',isolatedRestore:'The site was restored to a separate copy and started.',application:'The restored app answered its own checks.'};
const STATUS={declared:'declared by operator',partial:'partially checked',failed:'failed','not-tested':'not tested'};

// Mirrors withLegacyIntegrity in src/recovery-evidence.js: a verified package without an integrity record was checked before per-kind evidence existed.
export function levelEvidence(backup,kind){
 const value=backup?.verification?.[kind],recorded=value&&typeof value==='object'&&value.status?value:{status:'not-tested'};
 return kind==='integrity'&&recorded.status==='not-tested'&&backup?.verified?{status:'passed',source:'legacy'}:recorded;
}
export const isIntegrityChecked=backup=>levelEvidence(backup,'integrity').status==='passed';
// The engine records any thrown restore error (SSH, storage, helper) as this shape; it did not disprove recovery.
export const isIncompleteAttempt=e=>e?.status==='failed'&&e.method==='isolated recovery attempt did not complete';
export const levelTone=e=>e.status==='passed'?'ok':isIncompleteAttempt(e)?'warn':e.status==='failed'?'bad':e.status==='not-tested'?'none':'warn';
export function levelText(kind,evidence){
 const e=typeof evidence==='string'?{status:evidence}:evidence||{status:'not-tested'},[,name,passed]=LEVELS.find(([k])=>k===kind);
 if(e.status==='passed')return passed+(e.source==='legacy'?' (recorded before 2.1)':'');
 if(isIncompleteAttempt(e))return kind==='application'?'Application checks not run':'Restore attempt did not complete';
 return kind==='integrity'&&e.status==='not-tested'?'Integrity not checked':name+' '+(STATUS[e.status]||'not tested');
}
export const integrityText=backup=>levelText('integrity',levelEvidence(backup,'integrity')).replace(' (recorded before 2.1)','');

// Order: real failure, strongest passed, partial, declared, incomplete attempt, nothing. Never worded as passed unless it passed.
export function verificationSummary(backup,{beyondIntegrity=false}={}){
 const all=LEVELS.map(([kind])=>({kind,...levelEvidence(backup,kind)})),levels=beyondIntegrity?all.slice(1):all;
 const pick=(test,tone,strongest=true)=>{const hit=(strongest?[...levels].reverse():levels).find(test);return hit&&{...hit,text:levelText(hit.kind,hit),tone};};
 return pick(x=>levelTone(x)==='bad','bad',false)||pick(x=>x.status==='passed'&&(beyondIntegrity||x.kind!=='integrity'),'ok')||pick(x=>x.status==='partial','warn')||pick(x=>x.status==='declared','warn')||pick(isIncompleteAttempt,'warn',false)
  ||(!beyondIntegrity&&all[0].status==='passed'?{...all[0],text:levelText('integrity',{status:'passed'}),tone:'ok'}:{status:'not-tested',text:beyondIntegrity?'Restore not tested':'Nothing tested yet',tone:'none'});
}
// Library row and dashboard history: a failed level takes the badge (error tone via its text); otherwise the badge is integrity and the line is the strongest further evidence. Dates stay in the title and details so rows keep one line.
export function recoveryStatus(backup){
 const summary=verificationSummary(backup),beyond=verificationSummary(backup,{beyondIntegrity:true}),failedLevel=summary.tone==='bad'&&summary.kind!=='integrity',shown=failedLevel?summary:beyond;
 return {badge:failedLevel?summary.text:integrityText(backup),line:failedLevel?integrityText(backup):beyond.text,failed:summary.tone==='bad',title:shown.checkedAt?shown.text+' · checked '+formatDate(shown.checkedAt,{shortTime:true}):undefined};
}
// Dashboard site state: the restore fact next to "Recovery point stored".
export function restoreFact(backup){
 const e=levelEvidence(backup,'isolatedRestore'),summary=verificationSummary(backup),failed=summary.tone==='bad';
 const text=failed&&summary.kind!=='isolatedRestore'?summary.text.replace(/^./,c=>c.toLowerCase()):e.status==='passed'?'restore tested':isIncompleteAttempt(e)?'restore attempt did not complete':e.status==='failed'?'restore test failed':e.status==='partial'?'restore partially checked':'restore not tested';
 return {text,tone:failed||levelTone(e)!=='ok'&&e.status!=='not-tested'?'warning':'stored'};
}
