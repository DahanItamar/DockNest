// The only place that knows the move API (docs/moving-sites.md, "API for the UI"). `api` is the app's fetch helper: api(path, body, method).
export function createMovesClient(api){
 const id=x=>encodeURIComponent(x);
 return {
  // Stores a draft move and returns the verdict. options: {envRewrite:[key], askBeforeSwitch, dnsMode:'manual'}
  preview:(siteId,targetServerId,options)=>api('/moves',{siteId,targetServerId,...(options?{options}:{})}),
  start:(moveId,{preflightHash,moveAnyway})=>api('/moves/'+id(moveId)+'/start',{preflightHash,...(moveAnyway?{moveAnyway:true}:{})}),
  cancel:moveId=>api('/moves/'+id(moveId)+'/cancel',{}),
  // gate: 'owner-switch' (Switch now) or 'dns' (Check DNS now)
  proceed:(moveId,gate)=>api('/moves/'+id(moveId)+'/continue',{gate}),
  get:moveId=>api('/moves/'+id(moveId)),
  list:()=>api('/moves'),
  switchBack:moveId=>api('/moves/'+id(moveId)+'/switch-back',{}),
  removeOldCopy:(moveId,{confirmation,deleteData})=>api('/moves/'+id(moveId)+'/remove-old-copy',{confirmation,deleteData:!!deleteData}),
  resolve:(moveId,action)=>api('/moves/'+id(moveId)+'/resolve',{action}),
  // Never returns the token: {configured, zones, savedAt}
  cloudflareStatus:()=>api('/settings/cloudflare-dns'),
  saveCloudflareToken:token=>api('/settings/cloudflare-dns',{token},'PUT')
 };
}
export const FINISHED=new Set(['switched_back','cleaned','done','failed','cancelled','rolled_back','needs_attention']);
// Polling stops here. done is final; waiting_dns keeps polling until the domain points to the new server.
export const STOP_POLLING=new Set(['switched_back','cleaned','done','failed','cancelled','rolled_back']);
export const BUSY_WORD=new Set(['cancelling','rolling_back','switching_back']);
export const why=p=>p?.blockers?.[0]||p?.sentence||'This move is not possible right now.';
export const blocked=p=>!p.ok||p.verdict==='blocked';
export const warningText=w=>typeof w==='string'?w:w?.text||'';
export const duration=s=>{if(s==null)return null;s=Math.max(0,Math.round(s));if(s<60)return s+' s';const m=Math.round(s/60);return m===1?'1 minute':m+' minutes'};
