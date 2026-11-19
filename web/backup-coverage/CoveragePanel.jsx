import React,{useState} from 'react';
import {IconShieldCheck} from '@tabler/icons-react';
import {useCoverage} from './use-coverage.js';
import {CoverageSection} from './CoverageSection.jsx';
import './backup-coverage.css';

// Apps page: which containers and volumes on a server no app backs up. Closed until opened, so the Apps page never scans
// a server by itself. Opening it, switching server and "Scan again" are the only reads.
export function CoveragePanel({api,servers,canChange,onAddApp,onOpenApp,onSessionExpired}){
 const [open,setOpen]=useState(false),[chosen,setChosen]=useState(''),server=servers.find(item=>item.id===chosen)||servers[0];
 const coverage=useCoverage(api,server?[server.id]:[],open,onSessionExpired);
 if(!server)return null;
 return <section className="panel padded bc-panel" aria-labelledby="bc-title">
  <div className="bc-head">
   <div><h2 id="bc-title"><IconShieldCheck size={24} stroke={1.5} aria-hidden="true"/>Backup coverage</h2><p className="bc-lede">See which containers and volumes no app backs up. This only reads Docker and changes nothing on the server.</p></div>
   <button type="button" aria-expanded={open} aria-controls="bc-body" onClick={()=>setOpen(value=>!value)}>{open?'Hide coverage':'Check coverage'}</button>
  </div>
  {open&&<div id="bc-body" className="bc-body">
   {servers.length>1&&<label className="bc-server"><span className="sr-only">Server</span><select value={server.id} onChange={event=>setChosen(event.target.value)} aria-label="Server">{servers.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
   <CoverageSection api={api} serverId={server.id} serverName={server.name} entry={coverage.byServer[server.id]} canChange={canChange} onScan={coverage.scan} patch={coverage.patch} onAddApp={onAddApp} onOpenApp={onOpenApp} onSessionExpired={onSessionExpired}/>
  </div>}
 </section>;
}
