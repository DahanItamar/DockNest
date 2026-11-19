import React,{useEffect,useState} from 'react';
import {AlertPanel,StatusLabel} from '../system.jsx';
import {count} from '../plural.js';
import './backup-coverage.css';

// A helper that predates describe-containers answers "unsupported operation".
const oldHelper=error=>error.code==='helper_too_old'||/unsupported helper operation|unknown operation/i.test(error.message||'');

// Add app, step "How DockNest will recreate it": the read-only Compose a plain `docker run` container maps to.
// GET /servers/:id/describe-containers?containers=a,b -> {compose, containers:[{name, environment:[names], unsupported:[text]}]}.
// Environment values never reach this screen; only the variable names do.
export function RunDefinition({api,serverId,containers,onSessionExpired}){
 const [state,setState]=useState({status:'loading'}),key=containers.join(',');
 useEffect(()=>{
  let live=true;setState({status:'loading'});
  api('/servers/'+encodeURIComponent(serverId)+'/describe-containers?containers='+containers.map(encodeURIComponent).join(','))
   .then(result=>{if(live)setState({status:'ready',compose:result.compose||'',containers:result.containers||[]})})
   .catch(error=>{if(!live)return;if(error.status===401)onSessionExpired?.();else setState({status:'error',old:oldHelper(error),message:error.message})});
  return()=>{live=false};
 },[api,serverId,key]);
 const many=containers.length>1,names=state.status==='ready'?[...new Set(state.containers.flatMap(item=>item.environment||[]))]:[];
 const blocked=state.status==='ready'?state.containers.filter(item=>item.unsupported?.length):[];
 return <section className="bc-recreate" aria-labelledby="bc-recreate-title">
  <h3 id="bc-recreate-title">How DockNest will recreate {many?'these containers':containers[0]}</h3>
  <p>{many?'They were':'It was'} started with plain Docker commands. DockNest keeps a readable Compose version in every backup so {many?'they':'it'} can be started again. Nothing is changed on the server.</p>
  <div aria-live="polite" className="bc-recreate-body">
   {state.status==='loading'&&<div className="bc-state" role="status"><StatusLabel state="running">Reading how {many?'they were':'it was'} started…</StatusLabel></div>}
   {state.status==='error'&&<AlertPanel variant="warning" title={state.old?'Update the helper on this server to preview':'Could not read how this was started'}>{state.old?'This server runs an older DockNest helper that cannot describe containers yet. You can still continue and add the app.':state.message+' You can still continue and add the app.'}</AlertPanel>}
   {state.status==='ready'&&<>
    <pre className="bc-yaml" tabIndex={0} aria-label="Compose version, read only"><code>{state.compose}</code></pre>
    {names.length>0&&<p className="t-caption">Environment values are never shown. {count(names.length,'variable')} listed by name: {names.join(', ')}.</p>}
    {blocked.length>0&&<AlertPanel variant="warning" title="Cannot be recreated automatically"><span className="bc-problems">{blocked.map(item=><span className="bc-problem" key={item.name}><b>{item.name}</b>{item.unsupported.map(reason=><span key={reason}>{reason}</span>)}</span>)}</span></AlertPanel>}
   </>}
  </div>
 </section>;
}
