import React from 'react';
import {Paginated} from './pagination.jsx';
import {count} from './plural.js';
import {ChevronDown} from './icons.jsx';
import {BrandIcon} from './brand.jsx';
import {StatusLabel,IconButton} from './system.jsx';
import './sites.css';
import {describeSchedule} from './schedule.js';
import {recoveryStatus} from './verification.jsx';

const SiteIcon=props=><BrandIcon name="sites" {...props}/>;
const BackupIcon=props=><BrandIcon name="backups" {...props}/>;
const SiteIcons=Object.fromEntries(['edit','readiness','schedule','remove'].map(n=>[n,({size})=><BrandIcon name={n} size={size}/>]));
function Control({label,icon,className='',...props}){return <button type="button" className={`icon-button recovery-action ${className}`} aria-label={label} title={label} {...props}><BrandIcon name={icon} size={20}/></button>;}

export function Sites({sites,allSites,policies,user,busy,name,Empty,onClearFilter,onEdit,onReady,onSchedule,onRemove,onBackup,query}){
 if(!allSites.length)return <section className="panel"><Empty icon={SiteIcon} title="Choose the sites to protect">Connect a server, discover Docker containers, and group the containers that make up each site.</Empty></section>;
 if(!sites.length)return <section className="panel"><Empty icon={SiteIcon} title="No matching sites" action={<button onClick={onClearFilter}>Clear filter</button>}>Try another site name, server or container.</Empty></section>;
 return <Paginated rows={sites} label="Sites" pageSize={4} stableHeight resetKey={query}>{visible=><div className="card-grid site-grid" aria-label="Sites and schedules">{visible.map(site=>{
  const policy=policies.find(p=>p.siteId===site.id)||{};
  return <article className="card site-card" key={site.id} aria-labelledby={`site-title-${site.id}`}>
   <div className="card-body site-card-body">
    <header className="site-card-head"><BrandIcon name="sites" size={24}/><h2 className="card-title" id={`site-title-${site.id}`} title={site.name}>{site.name}</h2></header>
    {policy.enabled?<StatusLabel state="success">Enabled</StatusLabel>:<StatusLabel state="queued">{policy.schedule?'Paused':'Not scheduled'}</StatusLabel>}
    <dl className="def-list site-metadata">
     <div className="def-row"><dt>Server</dt><dd>{name(site.serverId,'servers')}</dd></div>
     <div className="def-row"><dt>{site.config?.kind==='static'?'Website files':'Containers'}</dt><dd className="container-labels">{site.config?.kind==='static'?<code>{site.config.documentRoot}</code>:site.config?.containers?.length?site.config.containers.map(container=><code key={container}>{container}</code>):<span>No containers configured</span>}</dd></div>
     <div className="def-row"><dt>Schedule</dt><dd>{describeSchedule(policy.schedule)}<span className="t-caption">{policy.timezone||'Time zone not set'}</span></dd></div>
     <div className="def-row"><dt>Retention</dt><dd>{policy.retention!=null?`${count(policy.retention,'successful backup')}`:'Not configured'}</dd></div>
    </dl>
   </div>
   <footer className="card-footer site-card-actions">
    <div className="site-card-tools">
     <IconButton label="Edit configuration" icon={SiteIcons.edit} onClick={()=>onEdit(site)}/>
     <IconButton label="Check readiness" icon={SiteIcons.readiness} disabled={busy} onClick={()=>onReady(site)}/>
     <IconButton label="Schedule" icon={SiteIcons.schedule} onClick={()=>onSchedule(site,policy)}/>
     {user?.role==='admin'&&<IconButton className="site-remove" label="Remove site" icon={SiteIcons.remove} onClick={()=>onRemove(site)}/>}
    </div>
    <button className="primary" disabled={busy} onClick={()=>onBackup(site)}>Back up now</button>
   </footer>
  </article>;
 })}</div>}</Paginated>;
}

export function Backups({backups,allBackups,busy,name,date,bytes,Badge,Empty,onClearFilter,onPin,onRestore,onDetails,query}){
 if(!allBackups.length)return <section className="panel"><Empty icon={BackupIcon} title="No recovery points yet">Run a backup from Sites &amp; schedules. A recovery point appears only after the job is verified.</Empty></section>;
 if(!backups.length)return <section className="panel"><Empty icon={BackupIcon} title="No matching recovery points" action={<button onClick={onClearFilter}>Clear filter</button>}>Try another recovery point, timestamp or site identifier.</Empty></section>;
 const groups=new Map();
 for(const backup of backups){const group=groups.get(backup.siteId)||[];group.push(backup);groups.set(backup.siteId,group);}
 return <Paginated rows={[...groups]} label="Backup sites" fitViewport stableHeight resetKey={query}>{visible=><section className="backup-library" aria-label="Recovery points by site">{visible.map(([siteId,rows])=>{
  const history=[...rows].sort((a,b)=>new Date(b.capturedAt||b.createdAt)-new Date(a.capturedAt||a.createdAt));
  return <details className="backup-group" key={siteId}>
   <summary><span className="backup-site-name"><BrandIcon name="sites" size={28}/><span><b>{name(siteId)}</b><small>Recovery history</small></span></span><span className="backup-group-count"><b>{history.length} recovery {history.length===1?'point':'points'}</b><small>{bytes(history.reduce((sum,b)=>sum+(b.size||b.sizeBytes||0),0))} stored</small></span><span className="backup-latest"><small>Latest capture</small><b>{date(history[0].capturedAt||history[0].createdAt)}</b></span><ChevronDown size={20}/></summary>
   <div className="backup-group-content"><Paginated rows={history} label={"Recovery points for "+name(siteId)} pageSize={3} stableHeight resetKey={query}>{points=>points.map(backup=><div className="recovery-row" key={backup.id}>
    <div className="recovery-point"><BrandIcon name="backups" size={22}/><div><b>{date(backup.capturedAt||backup.createdAt)}</b><code>{backup.id}</code></div></div>
    <div className="recovery-status">{(s=>[<Badge key="badge" value={s.badge}/>,<small key="level" title={s.title}>{s.line}{backup.pinned?', pinned':''}</small>])(recoveryStatus(backup))}</div>
    <div className="recovery-size"><b>{bytes(backup.size||backup.sizeBytes)}</b><small>{backup.downtimeMs!=null?(backup.downtimeMs/1000).toFixed(1)+' s offline':'Downtime not reported'}</small></div>
    <div className="recovery-actions">
     <a className="icon-button recovery-action" href={`/api/backups/${backup.id}/download?format=zip`} aria-label={`Download full ZIP ${backup.id}`} title="Full ZIP - site files, database data, configuration and Docker images"><BrandIcon name="download" size={20}/></a>
     <a className="icon-button recovery-action" href={`/api/backups/${backup.id}/download`} aria-label={`Download encrypted backup ${backup.id}`} title="Download encrypted original"><BrandIcon name="encrypted-download" size={20}/></a>
     <Control label={`${backup.pinned?'Unpin':'Pin'} backup ${backup.id}`} icon="pin" aria-pressed={!!backup.pinned} disabled={busy} onClick={()=>onPin(backup)}/>
     <Control label={`Restore backup ${backup.id}`} icon="restore" onClick={()=>onRestore(backup)}/>
     <Control label={`Backup details ${backup.id}`} icon="details" onClick={()=>onDetails(backup)}/>
    </div>
   </div>)}</Paginated></div>
  </details>;
 })}</section>}</Paginated>;
}
