import React from 'react';
import {formatDate} from './date-format.js';
import {LEVELS,levelEvidence,levelText} from './verification-core.js';
export {LEVELS,levelEvidence,levelText,isIntegrityChecked,integrityText,verificationSummary} from './verification-core.js';

export function VerificationLevels({backup}){
 return <ul className="dn-levels" aria-label="Verification levels">{LEVELS.map(([kind])=>{const e=levelEvidence(backup,kind);return <li key={kind} className={'dn-level is-'+e.status}>
  <span className="dn-level-mark" aria-hidden="true">{e.status==='passed'?'✓':e.status==='failed'?'✕':e.status==='not-tested'?'–':'!'}</span>
  <span className="dn-level-text"><b>{levelText(kind,e)}</b><small>{e.checkedAt?'Last checked '+formatDate(e.checkedAt,{shortTime:true}):e.status==='not-tested'?'Never checked':'Check time not recorded'}</small></span>
 </li>;})}</ul>;
}
