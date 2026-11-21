import {useCallback,useEffect,useRef,useState} from 'react';

// The only place that knows the domain API (docs/domains.md, "API"). `api` is the app's fetch helper: api(path, body, method).
// Domains are read when the Map opens and after a check, never on a timer. A check the person started is followed through its
// job (one short read every 1.5 seconds, at most two minutes) and stops as soon as it finishes.
export const createDomainsClient=api=>({
 list:()=>api('/domains'),
 check:domain=>api('/domains/check',{domain}),
 job:id=>api('/jobs/'+encodeURIComponent(id))
});
const FINISHED=new Set(['completed','failed','cancelled']);
const wait=ms=>new Promise(done=>setTimeout(done,ms));
const FAILED='DockNest could not check this domain. Check again in a minute.';

// enabled: operators and administrators (viewers get a 403 and see no domains). `key` re-reads the list when apps or their domains change.
export function useDomains(api,enabled,key=''){
 const client=useCallback(()=>createDomainsClient(api),[api]),[view,setView]=useState(null),[checking,setChecking]=useState({}),[errors,setErrors]=useState({}),live=useRef(true);
 useEffect(()=>{live.current=true;return()=>{live.current=false}},[]);
 const load=useCallback(()=>{
  if(!enabled||!api){setView(null);return Promise.resolve()}
  return client().list().then(r=>{if(live.current)setView(r&&Array.isArray(r.domains)?r:null)}).catch(()=>{if(live.current)setView(null)});
 },[client,enabled,api]);
 useEffect(()=>{load()},[load,key]);
 const mark=(set,domain,value)=>set(m=>{const next={...m};if(value)next[domain]=value;else delete next[domain];return next});
 async function check(domain){
  if(checking[domain])return;
  mark(setChecking,domain,true);mark(setErrors,domain,'');
  try{
   const c=client(),r=await c.check(domain);
   if(r?.jobId){
    for(let i=0;i<80&&live.current;i++){
     await wait(i?1500:600);
     const job=await c.job(r.jobId);
     if(FINISHED.has(job?.status)){if(job.status!=='completed')mark(setErrors,domain,job.error||FAILED);break}
    }
   }
  }catch(e){mark(setErrors,domain,e?.status===429?(e.message||'Too many checks. Try again in a few minutes.'):e?.message||FAILED)}
  await load();
  if(live.current)mark(setChecking,domain,false);
 }
 return {view,checking,errors,check,reload:load};
}
