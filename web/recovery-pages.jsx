import React from 'react';
import {Paginated} from './pagination.jsx';
import {ChevronDown} from './icons.jsx';
import {BrandIcon} from './brand.jsx';
import {describeSchedule} from './schedule.js';

const SiteIcon=props=><BrandIcon name="sites" {...props}/>;
const BackupIcon=props=><BrandIcon name="backups" {...props}/>;
function Control({label,icon,className='',...props}){return <button type="button" className={`recovery-action ${className}`} aria-label={label} title={label} {...props}><BrandIcon name={icon} size={22}/></button>;}

export function Sites({sites,allSites,policies,user,busy,name,Empty,onClearFilter,onEdit,onReady,onSchedule,onRemove,onBackup,query}){
 if(!allSites.length)return <section className="panel"><Empty icon={SiteIcon} title="Choose the sites to protect">Connect a server, discover Docker containers, and group the containers that make up each site.</Empty></section>;
 if(!sites.length)return <section className="panel"><Empty icon={SiteIcon} title="No matching sites" action={<button onClick={onClearFilter}>Clear filter</button>}>Try another site name, server or container.</Empty></section>;
 return <Paginated rows={sites} label="Sites" pageSize={4} stableHeight resetKey={query}>{visible=><div className="site-grid" aria-label="Sites and schedules">{visible.map(site=>{
  const policy=policies.find(p=>p.siteId===site.id)||{};
  return <article className="site-card" key={site.id} aria-labelledby={`site-title-${site.id}`}>
   <div className="site-card-body">
    <header className="site-card-head"><BrandIcon name="sites" size={36}/><h2 id={`site-title-${site.id}`} title={site.name}>{site.name}</h2><span className={`schedule-badge ${policy.enabled?'enabled':''}`}>{policy.enabled?'Enabled':policy.schedule?'Paused':'Not scheduled'}</span></header>
    <dl className="site-metadata">
     <div><dt>Server</dt><dd><BrandIcon name="server" size={18}/><span>{name(site.serverId,'servers')}</span></dd></div>
     <div><dt>{site.config?.kind==='static'?'Website files':'Containers'}</dt><dd className="container-labels">{site.config?.kind==='static'?<code>{site.config.documentRoot}</code>:site.config?.containers?.length?site.config.containers.map(container=><code key={container}>{container}</code>):<span>No containers configured</span>}</dd></div>
     <div><dt>Schedule</dt><dd><BrandIcon name="schedule" size={18}/><span>{describeSchedule(policy.schedule)}<small>{policy.timezone||'Time zone not set'}</small></span></dd></div>
     <div><dt>Retention</dt><dd>{policy.retention!=null?`${policy.retention} successful backups`:'Not configured'}</dd></div>
    </dl>
   </div>
   <div className="site-card-actions">
    <Control label="Edit configuration" icon="edit" onClick={()=>onEdit(site)}/>
    <Control label="Check readiness" icon="readiness" disabled={busy} onClick={()=>onReady(site)}/>
    <Control label="Schedule" icon="schedule" onClick={()=>onSchedule(site,policy)}/>
    {user?.role==='admin'&&<Control label="Remove site" icon="remove" className="site-remove" onClick={()=>onRemove(site)}/>}
    <button className="primary" disabled={busy} onClick={()=>onBackup(site)}><BrandIcon inverse name="backups" size={20}/> Back up now</button>
   </div>
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
    <div className="recovery-status"><Badge value={backup.status||(backup.verified?'Verified':'Unverified')}/><small>{backup.verification?.application?.status==='passed'?'Recovery checks passed':backup.verification?.isolatedRestore?.status==='passed'?'Isolated copy checked':backup.verified?'Integrity checked · recovery untested':'Integrity unverified'}{backup.pinned?' · Pinned':''}</small></div>
    <div className="recovery-size"><b>{bytes(backup.size||backup.sizeBytes)}</b><small>{backup.downtimeMs!=null?(backup.downtimeMs/1000).toFixed(1)+' s offline':'Downtime not reported'}</small></div>
    <div className="recovery-actions">
     <a className="recovery-action" href={`/api/backups/${backup.id}/download?format=zip`} aria-label={`Download full ZIP ${backup.id}`} title="Full ZIP - site files, database data, configuration and Docker images"><BrandIcon name="download" size={22}/></a>
     <a className="recovery-action" href={`/api/backups/${backup.id}/download`} aria-label={`Download encrypted backup ${backup.id}`} title="Download encrypted original"><BrandIcon name="encrypted-download" size={22}/></a>
     <Control label={`${backup.pinned?'Unpin':'Pin'} backup ${backup.id}`} icon="pin" aria-pressed={!!backup.pinned} disabled={busy} onClick={()=>onPin(backup)}/>
     <Control label={`Restore backup ${backup.id}`} icon="restore" onClick={()=>onRestore(backup)}/>
     <Control label={`Backup details ${backup.id}`} icon="details" onClick={()=>onDetails(backup)}/>
    </div>
   </div>)}</Paginated></div>
  </details>;
 })}</section>}</Paginated>;
}
