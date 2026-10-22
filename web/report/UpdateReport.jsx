import React,{useEffect,useState} from 'react';
import {ReportProblem} from './ReportProblem.jsx';
import {buildUpdateReport} from './builders.js';

// Update-failure report (docs/update-center.md section 7.1): rolled back, not changed, needs manual action, stale and
// lost results. Administrators only. The one implementation used by the lock view results and by the failed rows of
// Recent updates in the Update Center. Pass `status` (an admin status object), or a `client` with `requestId` (that
// run, GET /api/updates/requests/:id) or without it (the latest run, GET /api/updates/status).
export const REPORT_VIEWS=['rolled_back','not_changed','needs_action','lost','stale'];
export function UpdateReportButton({client,status:given,requestId,view,version,progress,lastPhase,role,className}){
 const [status,setStatus]=useState(given||null);
 useEffect(()=>{if(given){setStatus(given);return}if(!client)return;let off=false;(requestId?client.request(requestId):client.status()).then(r=>{if(!off)setStatus(r||null)},()=>{});return()=>{off=true}},[client,given,requestId,view]);
 // Without the admin status (an older API) the public progress still gives the versions, outcome and events.
 const run=status||{to:progress?.to,state:view==='stale'?'running':view,stale:view==='stale',events:progress?.events,phase:progress?.phase};
 const excerptSource=status&&(status.error||status.rollbackHint||status.warning)?{error:status.error,rollbackHint:status.rollbackHint,warning:status.warning}:null;
 return <ReportProblem role={role} className={className} summary="Update failure" excerptSource={excerptSource}
  build={(facts,opts)=>buildUpdateReport({...facts,...opts,version:facts?.version||version,status:{...run,from:run.from||version},view,lastPhase})}/>;
}
