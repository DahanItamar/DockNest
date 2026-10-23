// The only place that knows the move API. `api` is the app's fetch helper: api(path, body, method).
export const LONG_DOWNTIME_SECONDS=300;
export function createMovesClient(api){
 return {
  // Creates a draft move and returns the verdict: {id, verdict, ok, estimateSeconds, downtimeSeconds, undoDays, warnings[], advanced}.
  preview:(siteId,targetServerId)=>api('/moves',{siteId,targetServerId}),
  start:(id,options)=>api('/moves/'+encodeURIComponent(id)+'/start',{options}),
  cancel:id=>api('/moves/'+encodeURIComponent(id)+'/cancel',{}),
  // {state, steps:[{id,title,status}], progress 0..1, statusLine, cancelable?, dns?:{type,name,value}}
  get:id=>api('/moves/'+encodeURIComponent(id)),
  list:()=>api('/moves')
 };
}
export const FINISHED=new Set(['done','failed','cancelled']);
export const duration=s=>{s=Math.max(0,Math.round(s||0));if(s<60)return s+' s';const m=Math.round(s/60);return m===1?'1 minute':m+' minutes'};
