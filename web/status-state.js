// Maps any status string used by the API to one of the five states.
// 'active' is an account state, so it is success; only jobs in flight are running.
export function statusState(value){
 const v=String(value||'');
 if(/recovery|review/i.test(v))return 'needs-review';
 if(/fail|error|denied|invalid|revoked/i.test(v))return 'failed';
 if(/running|progress/i.test(v))return 'running';
 if(/^active$|complete|success|succeeded|ready|healthy|verified|online|connected/i.test(v))return 'success';
 return 'queued';
}
