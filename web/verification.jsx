import React from 'react';
import {formatDate} from './date-format.js';
import {Check,X,TriangleAlert,Minus} from './icons.jsx';
import {DESCRIPTIONS,LEVELS,isIncompleteAttempt,levelEvidence,levelText,levelTone} from './verification-core.js';
export {DESCRIPTIONS,LEVELS,isIncompleteAttempt,levelEvidence,levelText,levelTone,isIntegrityChecked,integrityText,recoveryStatus,restoreFact,verificationSummary} from './verification-core.js';

// Shared Tabler icons, never text symbols; the level text carries the meaning for assistive technology.
const MARKS={ok:Check,bad:X,warn:TriangleAlert,none:Minus};
// `format` lets a dialog keep one date style for every timestamp it shows.
export function VerificationLevels({backup,format=value=>formatDate(value,{shortTime:true})}){
 return <ul className="dn-levels" role="list" aria-label="Verification levels">{LEVELS.map(([kind])=>{const e=levelEvidence(backup,kind),tone=levelTone(e);return <li key={kind} className={'dn-level is-'+tone}>
  <span className="dn-level-mark" aria-hidden="true">{React.createElement(MARKS[tone]||Minus,{size:14,stroke:2.25})}</span>
  <span className="dn-level-text"><b>{levelText(kind,e)}</b><span className="dn-level-desc">{DESCRIPTIONS[kind]}</span><small>{e.checkedAt?<>Last checked <time dateTime={e.checkedAt}>{format(e.checkedAt)}</time></>:e.status==='not-tested'?'No record yet':'Check time not recorded'}{isIncompleteAttempt(e)?' · See the restore job for the reason':''}</small></span>
 </li>;})}</ul>;
}
