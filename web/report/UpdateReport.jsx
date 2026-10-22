import React,{useEffect,useState} from 'react';
import {ReportProblem} from './ReportProblem.jsx';
import {buildUpdateReport} from './builders.js';
import {AlertPanel} from '../system.jsx';

// Update-failure report (docs/update-center.md section 7.1): rolled back, not changed, needs manual action, stale and
// lost results. Administrators only. Usable wherever an update outcome is shown (lock view result, Update Center):
// pass `status` (the admin GET /api/updates/status object of that run) or a `client` to read the latest one.
export const REPORT_VIEWS=['rolled_back','not_changed','needs_action','lost','stale'];
export function UpdateReportButton({client,status:given,view,version,progress,lastPhase,role}){
 const [status,setStatus]=useState(given||null);
 useEffect(()=>{if(given){setStatus(given);return}if(!client)return;let off=false;client.status().then(r=>{if(!off)setStatus(r||null)},()=>{});return()=>{off=true}},[client,given,view]);
 // Without the admin status (an older API) the public progress still gives the versions, outcome and events.
 const run=status||{to:progress?.to,state:view==='stale'?'running':view,stale:view==='stale',events:progress?.events,phase:progress?.phase};
 const excerptSource=status&&(status.error||status.rollbackHint||status.warning)?{error:status.error,rollbackHint:status.rollbackHint,warning:status.warning}:null;
 return <ReportProblem role={role} summary="Update failure" excerptSource={excerptSource}
  build={(facts,opts)=>buildUpdateReport({...facts,...opts,version:facts?.version||version,status:{...run,from:run.from||version},view,lastPhase})}/>;
}

const FAILED_STATES={rolled_back:'DockNest returned to the previous version automatically.',needs_action:'The update needs manual action on the DockNest host.',not_changed:'Nothing was changed.',refused:'Nothing was changed.',busy:'Nothing was changed.',lost:'The update record was closed without a result.'};
// Update Center: the most recent update request, when it failed, keeps its report after the lock view is gone.
export function LastUpdateFailure({client}){
 const [status,setStatus]=useState(null);
 useEffect(()=>{let off=false;client.status().then(r=>{if(!off)setStatus(r||null)},()=>{});return()=>{off=true}},[client]);
 if(!status||!FAILED_STATES[status.state])return null;
 const view=['refused','busy'].includes(status.state)?'not_changed':status.state;
 return <AlertPanel variant="error" title="The last update did not complete" action={<div className="rp-actions"><UpdateReportButton status={status} view={view} version={status.from}/></div>}>{FAILED_STATES[status.state]}</AlertPanel>;
}
