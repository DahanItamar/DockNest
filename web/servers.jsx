import React from 'react';
import {Paginated} from './pagination.jsx';
import {ArrowRight} from './icons.jsx';
import {BrandIcon} from './brand.jsx';
import {StatusLabel,RowOpen,AlertPanel} from './system.jsx';
import {ReportProblem} from './report/ReportProblem.jsx';
import {ServerEngines} from './runtime-ui.jsx';
import {buildServerReport} from './report/builders.js';
import {catalogued,EXPLAIN} from './report/catalogue.js';
import './servers.css';

const ServerIcon=props=><BrandIcon name="server" {...props}/>;

export function Servers({servers,allServers,sites,user,busy,onTest,onDiscover,onEdit,onAdd,onClearFilter,Empty,query,failure}) {
 if(!allServers.length)return <section className="server-empty-panel"><Empty icon={ServerIcon} title="Connect your first Docker host" action={user?.role==='admin'?<button className="primary" onClick={onAdd}>Add server <ArrowRight size={16}/></button>:null}>{user?.role==='admin'?'Connect a host with an SSH key and its independently verified host fingerprint.':'Ask your administrator to connect a Docker host with a verified SSH host key.'}</Empty></section>;
 if(!servers.length)return <section className="server-empty-panel"><Empty icon={ServerIcon} title="No matching servers" action={<button onClick={onClearFilter}>Clear filter</button>}>Try another server name, address or note.</Empty></section>;
 return <Paginated rows={servers} label="Servers" pageSize={4} stableHeight resetKey={query}>{visible=><div className="card-grid server-grid" aria-label="Docker servers">{visible.map(server=>{
  const count=sites.filter(site=>site.serverId===server.id).length;
  return <article className="card server-card" key={server.id} aria-labelledby={`server-title-${server.id}`}>
   <div className="card-body server-card-body">
    <header className="server-card-head"><h2 className="card-title" title={server.name}>{user?.role==='admin'?<RowOpen chip icon={ServerIcon} label={'Edit details for '+server.name} onClick={()=>onEdit(server)}><span className="row-title" id={`server-title-${server.id}`}>{server.name}</span></RowOpen>:<><span className="icon-chip"><ServerIcon size={20}/></span><span className="row-title" id={`server-title-${server.id}`}>{server.name}</span></>}</h2></header>
    <StatusLabel value={server.status||'unchecked'}/>
    <p className="t-caption server-card-note" title={server.note||undefined}>{server.note}</p>
    <dl className="def-list server-metadata">
     <div className="def-row"><dt>Connection</dt><dd><code>{server.username}@{server.host}:{server.port}</code></dd></div>
     <div className="def-row"><dt>SSH host fingerprint</dt><dd><code>{server.hostKey}</code></dd></div>
     <div className="def-row"><dt>Server ID</dt><dd><code>{server.id}</code></dd></div>
     <ServerEngines server={server}/>
     <div className="def-row"><dt>Apps</dt><dd><span aria-label={`${count} configured ${count===1?'app':'apps'}`}>{count}</span></dd></div>
    </dl>
    {failure?.id===server.id&&<AlertPanel variant="error" title="The connection test failed" action={<div className="rp-actions"><button type="button" className="primary" disabled={busy} onClick={()=>onTest(server)}>Test again</button><ReportProblem summary="Server connection test" excerptSource={catalogued(failure.message)||!failure.message?null:{error:failure.message}} excerptLabel="Include the error message" build={(facts,opts)=>buildServerReport({...facts,...opts,check:failure.check,errorClass:failure.errorClass,message:failure.message,explanation:EXPLAIN.server})}/></div>}>{failure.message}</AlertPanel>}
   </div>
   <footer className="card-footer server-card-actions">
    <button type="button" className="link-action" disabled={busy} onClick={()=>onTest(server)}>Test connection</button>
    <button type="button" className="text-link" onClick={()=>onDiscover(server)}>Discover apps</button>
   </footer>
  </article>;
 })}</div>}</Paginated>;
}
