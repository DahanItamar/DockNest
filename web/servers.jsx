import React from 'react';
import {Paginated} from './pagination.jsx';
import {ArrowRight} from './icons.jsx';
import {BrandIcon} from './brand.jsx';
import {StatusLabel,IconButton} from './system.jsx';
import './servers.css';

const ServerIcon=props=><BrandIcon name="server" {...props}/>;
const EditIcon=({size})=><BrandIcon name="edit" size={size}/>;

export function Servers({servers,allServers,sites,user,busy,onTest,onDiscover,onEdit,onAdd,onClearFilter,Empty,query}) {
 if(!allServers.length)return <section className="server-empty-panel"><Empty icon={ServerIcon} title="Connect your first Docker host" action={user?.role==='admin'?<button className="primary" onClick={onAdd}>Add server <ArrowRight size={16}/></button>:null}>{user?.role==='admin'?'Connect a host with an SSH key and its independently verified host fingerprint.':'Ask your administrator to connect a Docker host with a verified SSH host key.'}</Empty></section>;
 if(!servers.length)return <section className="server-empty-panel"><Empty icon={ServerIcon} title="No matching servers" action={<button onClick={onClearFilter}>Clear filter</button>}>Try another server name, address or note.</Empty></section>;
 return <Paginated rows={servers} label="Servers" pageSize={4} stableHeight resetKey={query}>{visible=><div className="card-grid server-grid" aria-label="Docker servers">{visible.map(server=>{
  const count=sites.filter(site=>site.serverId===server.id).length;
  return <article className="card server-card" key={server.id} aria-labelledby={`server-title-${server.id}`}>
   <div className="card-body server-card-body">
    <header className="server-card-head"><ServerIcon size={24}/><h2 className="card-title" id={`server-title-${server.id}`} title={server.name}>{server.name}</h2></header>
    <StatusLabel value={server.status||'unchecked'}/>
    <p className="t-caption server-card-note" title={server.note||undefined}>{server.note}</p>
    <dl className="def-list server-metadata">
     <div className="def-row"><dt>Connection</dt><dd><code>{server.username}@{server.host}:{server.port}</code></dd></div>
     <div className="def-row"><dt>SSH host fingerprint</dt><dd><code>{server.hostKey}</code></dd></div>
     <div className="def-row"><dt>Server ID</dt><dd><code>{server.id}</code></dd></div>
     <div className="def-row"><dt>Sites</dt><dd><span aria-label={`${count} configured ${count===1?'site':'sites'}`}>{count}</span></dd></div>
    </dl>
   </div>
   <footer className="card-footer server-card-actions">
    <button disabled={busy} onClick={()=>onTest(server)}>Test connection</button>
    <button onClick={()=>onDiscover(server)}>Discover sites</button>
    {user?.role==='admin'&&<IconButton className="server-edit" label="Edit details" icon={EditIcon} onClick={()=>onEdit(server)}/>}
   </footer>
  </article>;
 })}</div>}</Paginated>;
}
