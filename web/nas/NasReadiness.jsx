import './nas.css';
import React,{useEffect,useState} from 'react';
import {IconCircleCheck,IconAlertTriangle,IconCircleX,IconCopy,IconRefresh} from '@tabler/icons-react';
import {formatBytes} from '../../shared/format-bytes.js';
import {nasName,sortChecks,runtimeTitle,identityText} from './nas.js';

// The NAS label next to a server's status. Text and an icon, never colour alone.
export function NasLabel({kind}){
 const name=nasName(kind);
 return name?<span className="nas-label">{name}</span>:null;
}

const ICON={ok:IconCircleCheck,warn:IconAlertTriangle,fail:IconCircleX};
const WORD={ok:'Ready',warn:'Needs attention',fail:'Not ready'};
const FIX_COMMAND={'key-persistence':"cp /root/.ssh/authorized_keys /boot/config/ssh/root/authorized_keys"};

// Readiness of one NAS server: what DockNest checks on the system itself (identity, helper runtime, staging folder, Docker, key
// persistence), each with its one fix. Loaded when the panel opens; "Check again" reads it again. Nothing is changed.
export function NasReadiness({api,server,onSessionExpired}){
 const [state,setState]=useState({loading:true,error:'',result:null}),[run,setRun]=useState(0),[copied,setCopied]=useState('');
 useEffect(()=>{
  let live=true;setState(s=>({...s,loading:true,error:''}));
  api('/servers/'+encodeURIComponent(server.id)+'/nas').then(result=>{if(live)setState({loading:false,error:'',result})})
   .catch(error=>{if(!live)return;if(error.status===401){onSessionExpired?.();return;}setState(s=>({...s,loading:false,error:error.message||'Readiness could not be checked.'}));});
  return()=>{live=false};
 },[api,server.id,run]);
 async function copy(id,text){try{await navigator.clipboard.writeText(text);setCopied(id);}catch{setCopied('');}}
 const {loading,error,result}=state,checks=sortChecks(result?.checks);
 return <section className="map-sec nas-readiness" aria-label="NAS readiness">
  <h3 className="map-group-title">Readiness</h3>
  <div role="status" aria-live="polite">{loading&&<p className="map-caption">Checking this NAS{'…'}</p>}</div>
  {error&&<p className="map-caption bad" role="alert">{error}</p>}
  {!loading&&!error&&result&&!result.nas&&<p className="map-caption">This server is not a Unraid, Synology or TrueNAS system.</p>}
  {!loading&&!error&&result?.nas&&<>
   {identityText(result.identity)&&<p className="map-caption">{identityText(result.identity)}</p>}
   <ul className="nas-checks">{checks.filter(check=>!(check.status==='ok'&&['nas-version','identity'].includes(check.id))).map(check=>{const Icon=ICON[check.status],good=check.status==='ok',[title,detail]=good&&check.id==='runtime'?[runtimeTitle(result),check.message]:good&&check.id==='staging'?['Staging folder on the pool',`${result.stagingBase}${Number.isFinite(check.freeBytes)?' · '+formatBytes(check.freeBytes)+' free':''}`]:[check.message,check.fix?`Fix: ${check.fix}`:''];
    const command=check.status!=='ok'?FIX_COMMAND[check.id]:null;
    return <li key={check.id} className={'nas-check nas-'+check.status}>
     <Icon size={18} stroke={1.75} aria-hidden="true"/>
     <div><b>{title}<span className="sr-only">. {WORD[check.status]}</span></b>{detail&&<p className="map-caption">{detail}</p>}
      {command&&<button type="button" className="link-action nas-copy" onClick={()=>copy(check.id,command)}><IconCopy size={16} stroke={1.75} aria-hidden="true"/>{copied===check.id?'Copied fix command':'Copy fix command'}</button>}
     </div></li>;})}</ul>
  </>}
  {!loading&&<button type="button" className="link-action nas-again" onClick={()=>setRun(n=>n+1)}><IconRefresh size={16} stroke={1.75} aria-hidden="true"/>Check again</button>}
 </section>;
}
