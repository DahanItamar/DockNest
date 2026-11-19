import {useCallback,useEffect,useState} from 'react';

// Reads coverage of the given servers when enabled and again on scan(). No timer, nothing stored: every scan is asked for.
// byServer[id] is {status:'loading'} | {status:'ready',data} | {status:'error',error}.
export function useCoverage(api,serverIds,enabled,onSessionExpired){
 const [byServer,setBy]=useState({}),[run,setRun]=useState(0),key=serverIds.join(',');
 useEffect(()=>{
  if(!enabled||!api||!key)return;
  let live=true;
  const ids=key.split(',');
  setBy(Object.fromEntries(ids.map(id=>[id,{status:'loading'}])));
  for(const id of ids)api('/servers/'+encodeURIComponent(id)+'/coverage')
   .then(data=>{if(live)setBy(map=>({...map,[id]:{status:'ready',data}}))})
   .catch(error=>{if(!live)return;if(error.status===401)onSessionExpired?.();else setBy(map=>({...map,[id]:{status:'error',error:error.message||'Could not reach the server.'}}))});
  return()=>{live=false};
 },[api,enabled,key,run]);
 const scan=useCallback(()=>setRun(n=>n+1),[]);
 // A skip or unskip changes one row in place, so it does not cost another scan of the server.
 const patch=useCallback((serverId,item,changes)=>setBy(map=>{
  const entry=map[serverId];if(entry?.status!=='ready')return map;
  return {...map,[serverId]:{...entry,data:{...entry.data,items:entry.data.items.map(row=>row.kind===item.kind&&row.name===item.name?{...row,...changes}:row)}}};
 }),[]);
 return {byServer,scan,patch};
}
