import React from 'react';
import {formatDate} from './date-format.js';
import {LEVELS,isIncompleteAttempt,levelEvidence,levelText,levelTone} from './verification-core.js';
export {LEVELS,isIncompleteAttempt,levelEvidence,levelText,levelTone,isIntegrityChecked,integrityText,recoveryStatus,restoreFact,verificationSummary} from './verification-core.js';

const MARKS={ok:'✓',bad:'✕',warn:'!',none:'–'};
export function VerificationLevels({backup}){
 return <ul className="dn-levels" aria-label="Verification levels">{LEVELS.map(([kind])=>{const e=levelEvidence(backup,kind),tone=levelTone(e);return <li key={kind} className={'dn-level is-'+tone}>
  <span className="dn-level-mark" aria-hidden="true">{MARKS[tone]}</span>
  <span className="dn-level-text"><b>{levelText(kind,e)}</b><small>{e.checkedAt?'Last checked '+formatDate(e.checkedAt,{shortTime:true}):e.status==='not-tested'?'Never checked':'Check time not recorded'}{isIncompleteAttempt(e)?' · See the restore job for the reason':''}</small></span>
 </li>;})}</ul>;
}
