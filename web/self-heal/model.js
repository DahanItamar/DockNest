export const MIN_RESTARTS=1,MAX_RESTARTS=10,DEFAULT_RESTARTS=3,DEFAULT_WINDOW=60;
export const WINDOWS=[[10,'10 minutes'],[30,'30 minutes'],[60,'1 hour'],[120,'2 hours'],[360,'6 hours'],[720,'12 hours'],[1440,'24 hours']];
export const validRestarts=v=>/^\d+$/.test(String(v).trim())&&Number(v)>=MIN_RESTARTS&&Number(v)<=MAX_RESTARTS;
// Result column: StatusLabel state and label per event kind. `unhealthy` is recorded by the backend but is not a restart, so it is not listed.
export const RESULTS={
 restarted:{state:'success',label:'Restarted'},
 recovered:{state:'success',label:'Recovered'},
 limit_reached:{state:'needs-review',label:'Limit reached'},
 skipped:{state:'queued',label:'Skipped'},
 restart_failed:{state:'failed',label:'Restart failed'}
};
export const rows=events=>(Array.isArray(events)?events:[]).filter(e=>RESULTS[e?.kind]);
export const timeOf=at=>{const d=new Date(at);if(isNaN(d))return '';const t=d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false});return d.toDateString()===new Date().toDateString()?t:d.toLocaleDateString([],{day:'2-digit',month:'2-digit'})+' '+t};
export const saveError=e=>e?.code==='NO_HEALTHCHECK'?{title:'No health check',text:'No container in this site has a health check. Add one in Compose.'}:e?.status===403?{title:'Not allowed',text:'Only administrators can change self-heal.'}:{title:'Could not save',text:e?.message||'Try again.'};
