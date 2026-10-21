// Pure verification semantics shared by labels, dashboard aggregates and charts (no JSX).
// Four independent evidence levels from src/recovery-evidence.js; `verified` alone means package integrity only.
export const LEVELS=[['integrity','Integrity','Integrity checked'],['consistency','Consistency','Consistency verified'],['isolatedRestore','Isolated restore','Isolated restore tested'],['application','Application checks','Application checks passed']];
const STATUS={declared:'declared by operator',partial:'partially checked',failed:'failed','not-tested':'not tested'};

// Mirrors withLegacyIntegrity in src/recovery-evidence.js: a verified package without an integrity record was checked before per-kind evidence existed.
export function levelEvidence(backup,kind){
 const value=backup?.verification?.[kind],recorded=value&&typeof value==='object'&&value.status?value:{status:'not-tested'};
 return kind==='integrity'&&recorded.status==='not-tested'&&backup?.verified?{status:'passed',source:'legacy'}:recorded;
}
export const isIntegrityChecked=backup=>levelEvidence(backup,'integrity').status==='passed';
export function levelText(kind,evidence){
 const e=typeof evidence==='string'?{status:evidence}:evidence||{status:'not-tested'},[,name,passed]=LEVELS.find(([k])=>k===kind);
 if(e.status==='passed')return passed+(e.source==='legacy'?' (recorded before 2.1)':'');
 return kind==='integrity'&&e.status==='not-tested'?'Integrity not checked':name+' '+(STATUS[e.status]||'not tested');
}
export const integrityText=backup=>levelText('integrity',levelEvidence(backup,'integrity')).replace(' (recorded before 2.1)','');

// Strongest passed level, or the first failed one; never implies more than was recorded.
export function verificationSummary(backup){
 const levels=LEVELS.map(([kind])=>({kind,...levelEvidence(backup,kind)}));
 const failed=levels.find(x=>x.status==='failed');if(failed)return {...failed,text:levelText(failed.kind,failed),tone:'bad'};
 const passed=[...levels].reverse().find(x=>x.status==='passed');
 return passed?{...passed,text:levelText(passed.kind,{status:'passed'}),tone:'ok'}:{status:'not-tested',text:'Not tested',tone:'none'};
}
