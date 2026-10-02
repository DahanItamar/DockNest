import React from 'react';
import {ArrowRight} from 'lucide-react';
import {BrandIcon} from './brand.jsx';
import './servers.css';

const ServerIcon=props=><BrandIcon name="server" {...props}/>;

export function Servers({servers,allServers,sites,user,busy,onTest,onDiscover,onEdit,onAdd,onClearFilter,Empty}) {
 if(!allServers.length)return <section className="server-empty-panel"><Empty icon={ServerIcon} title="Connect your first Docker host" action={user?.role==='admin'?<button className="primary" onClick={onAdd}>Add server <ArrowRight size={16}/></button>:null}>{user?.role==='admin'?'Connect a host with an SSH key and its independently verified host fingerprint.':'Ask your administrator to connect a Docker host with a verified SSH host key.'}</Empty></section>;
 if(!servers.length)return <section className="server-empty-panel"><Empty icon={ServerIcon} title="No matching servers" action={<button onClick={onClearFilter}>Clear filter</button>}>Try another server name, address or note.</Empty></section>;
 return <div className="server-grid" aria-label="Docker servers">{servers.map(server=>{
  const count=sites.filter(site=>site.serverId===server.id).length;
  return <article className="server-card" key={server.id} aria-labelledby={`server-title-${server.id}`}>
   <div className="server-card-body">
    <header className="server-card-head"><span className="server-card-icon"><BrandIcon name="server" size={44}/></span><h2 id={`server-title-${server.id}`} title={server.name}>{server.name}</h2><span className="server-site-count" aria-label={`${count} configured ${count===1?'site':'sites'}`}>{count} {count===1?'site':'sites'}</span></header>
    <p className="server-card-note" title={server.note||undefined}>{server.note}</p>
    <dl className="server-metadata">
     <div><dt>Connection</dt><dd><code>{server.username}@{server.host}:{server.port}</code></dd></div>
     <div><dt>SSH host fingerprint</dt><dd><code>{server.hostKey}</code></dd></div>
     <div><dt>Server ID</dt><dd><code>{server.id}</code></dd></div>
    </dl>
   </div>
   <footer className="server-card-actions">
    <button disabled={busy} onClick={()=>onTest(server)}><BrandIcon name="refresh" size={20}/><span>Test connection</span></button>
    <button onClick={()=>onDiscover(server)}><BrandIcon name="sites" size={20}/><span>Discover sites</span></button>
    {user?.role==='admin'&&<button className="server-edit" onClick={()=>onEdit(server)} aria-label="Edit details" title="Edit server details"><BrandIcon name="details" size={22}/></button>}
   </footer>
  </article>;
 })}</div>;
}
