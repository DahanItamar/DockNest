import React from 'react';
import {formatDate} from './date-format.js';
import {DESCRIPTIONS,LEVELS,isIncompleteAttempt,levelEvidence,levelText,levelTone} from './verification-core.js';
export {DESCRIPTIONS,LEVELS,isIncompleteAttempt,levelEvidence,levelText,levelTone,isIntegrityChecked,integrityText,recoveryStatus,restoreFact,verificationSummary} from './verification-core.js';

const MARKS={ok:'✓',bad:'✕',warn:'!',none:'–'};
// `format` lets a dialog keep one date style for every timestamp it shows.
export function VerificationLevels({backup,format=value=>formatDate(value,{shortTime:true})}){
 return <ul className="dn-levels" role="list" aria-label="Verification levels">{LEVELS.map(([kind])=>{const e=levelEvidence(backup,kind),tone=levelTone(e);return <li key={kind} className={'dn-level is-'+tone}>
  <span className="dn-level-mark" aria-hidden="true">{MARKS[tone]}</span>
  <span className="dn-level-text"><b>{levelText(kind,e)}</b><span className="dn-level-desc">{DESCRIPTIONS[kind]}</span><small>{e.checkedAt?<>Last checked <time dateTime={e.checkedAt}>{format(e.checkedAt)}</time></>:e.status==='not-tested'?'No record yet':'Check time not recorded'}{isIncompleteAttempt(e)?' · See the restore job for the reason':''}</small></span>
 </li>;})}</ul>;
}
