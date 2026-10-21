import React from 'react';
import {formatDate} from './date-format.js';

// Four independent evidence levels from src/recovery-evidence.js. `verified` alone means package integrity only.
export const LEVELS=[['integrity','Integrity','Integrity checked'],['consistency','Consistency','Consistency verified'],['isolatedRestore','Isolated restore','Isolated restore tested'],['application','Application checks','Application checks passed']];
const STATUS={declared:'declared by operator',partial:'partially checked',failed:'failed','not-tested':'not tested'};

export function levelEvidence(backup,kind){const value=backup?.verification?.[kind];if(value&&typeof value==='object'&&value.status)return value;return kind==='integrity'&&backup?.verified?{status:'passed'}:{status:'not-tested'};}
export function levelText(kind,status){const [,name,passed]=LEVELS.find(([k])=>k===kind);return status==='passed'?passed:name+' '+(STATUS[status]||'not tested');}
export const integrityText=backup=>({passed:'Integrity checked',failed:'Integrity failed'})[levelEvidence(backup,'integrity').status]||'Integrity not checked';

// Strongest passed level, or the first failed one; never implies more than was recorded.
export function verificationSummary(backup){
 const levels=LEVELS.map(([kind])=>({kind,...levelEvidence(backup,kind)}));
 const failed=levels.find(x=>x.status==='failed');if(failed)return {...failed,text:levelText(failed.kind,'failed'),tone:'bad'};
 const passed=[...levels].reverse().find(x=>x.status==='passed');
 return passed?{...passed,text:levelText(passed.kind,'passed'),tone:'ok'}:{status:'not-tested',text:'Not tested',tone:'none'};
}

export function VerificationLevels({backup}){
 return <ul className="dn-levels" aria-label="Verification levels">{LEVELS.map(([kind])=>{const e=levelEvidence(backup,kind);return <li key={kind} className={'dn-level is-'+e.status}>
  <span className="dn-level-mark" aria-hidden="true">{e.status==='passed'?'✓':e.status==='failed'?'✕':e.status==='not-tested'?'–':'!'}</span>
  <span className="dn-level-text"><b>{levelText(kind,e.status)}</b><small>{e.checkedAt?'Last checked '+formatDate(e.checkedAt,{shortTime:true}):e.status==='not-tested'?'Never checked':'Check time not recorded'}</small></span>
 </li>;})}</ul>;
}
