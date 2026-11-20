import React,{useRef,useState} from 'react';
import {Paginated} from './pagination.jsx';
import {ZipDialog} from './zip-export.jsx';
import {count} from './plural.js';
import {ChevronDown} from './icons.jsx';
import {BrandIcon} from './brand.jsx';
import {StatusLabel,RowOpen,OverflowMenu} from './system.jsx';
import {IconPin,IconPinnedOff,IconDownload} from '@tabler/icons-react';
import './sites.css';
import {describeSchedule} from './schedule.js';
import {recoveryStatus} from './verification.jsx';
import {CopyLines} from './copies/CopyLines.jsx';
import {siteStorageSummary} from './copies/model.js';
import {ChainLine} from './incremental/ChainLine.jsx';
import {isIncremental,toBackups} from './incremental/model.js';
import {chainDownloadUrl} from './incremental/incremental-client.js';
import {Download} from './icons.jsx';
import {HardeningRow} from './hardening.jsx';

const SiteIcon=props=><BrandIcon name="sites" {...props}/>;
const BackupIcon=props=><BrandIcon name="backups" {...props}/>;
const BackupRowIcon=props=><BrandIcon name="backups" {...props}/>;
const SiteHeadIcon=props=><BrandIcon name="sites" {...props}/>;
const SiteIcons=Object.fromEntries(['edit','readiness','schedule','restore','remove'].map(n=>[n,({size})=><BrandIcon name={n} size={size}/>]));
const download=url=>{const link=document.createElement('a');link.href=url;link.rel='noopener';document.body.append(link);link.click();link.remove();};
// Restore stays visible; pin and the downloads sit in one menu. The ZIP dialog is owned here so it survives the menu closing.
function RecoveryActions({backup,busy,onPin,onRestore}){
 const [zip,setZip]=useState(false),box=useRef(null),id=backup.id,incremental=isIncremental(backup);
 const items=[
  ...(incremental?[{label:'Download chain',name:`Download chain ${id}`,icon:IconDownload,onSelect:()=>download(chainDownloadUrl(id))}]
   :[{label:'Download full ZIP',name:`Download full ZIP ${id}`,icon:IconDownload,onSelect:()=>setZip(true)},{label:'Download encrypted original',name:`Download encrypted backup ${id}`,icon:IconDownload,onSelect:()=>download(`/api/backups/${id}/download`)}]),
  {label:backup.pinned?'Unpin':'Pin',name:`${backup.pinned?'Unpin':'Pin'} backup ${id}`,icon:backup.pinned?IconPinnedOff:IconPin,disabled:busy,onSelect:()=>onPin(backup)}];
 return <div className="recovery-actions" ref={box}><button type="button" className="small" aria-label={`Restore backup ${id}`} onClick={()=>onRestore(backup)}>Restore</button><OverflowMenu label={'More actions for backup '+id} items={items}/>{zip&&<ZipDialog backupId={id} onClose={()=>{setZip(false);requestAnimationFrame(()=>box.current?.querySelector('[aria-haspopup=menu]')?.focus())}}/>}</div>;
}

export function Sites({sites,allSites,policies,user,busy,name,Empty,onClearFilter,onEdit,onTests,onReady,onSchedule,onStorage,onIncremental,onSafeEdit,onEditHistory,onRemove,onBackup,query,checking}){
 if(!allSites.length)return <section className="panel"><Empty icon={SiteIcon} title="Choose the apps to protect">Connect a server, discover Docker containers, and group the containers that make up each app.</Empty></section>;
 if(!sites.length)return <section className="panel"><Empty icon={SiteIcon} title="No matching apps" action={<button onClick={onClearFilter}>Clear filter</button>}>Try another app name, server or container.</Empty></section>;
 return <Paginated rows={sites} label="Apps" pageSize={4} stableHeight resetKey={query}>{visible=><div className="card-grid site-grid" aria-label="Apps and schedules">{visible.map(site=>{
  const policy=policies.find(p=>p.siteId===site.id)||{};
  return <article className="card site-card" key={site.id} aria-labelledby={`site-title-${site.id}`}>
   <div className="card-body site-card-body">
    <header className="site-card-head"><h2 className="card-title" title={site.name}><RowOpen chip icon={SiteHeadIcon} label={'Edit configuration for '+site.name} onClick={()=>onEdit(site)}><span className="row-title" id={`site-title-${site.id}`}>{site.name}</span></RowOpen></h2></header>
    {policy.enabled?<StatusLabel state="success">Enabled</StatusLabel>:<StatusLabel state="queued">{policy.schedule?'Paused':'Not scheduled'}</StatusLabel>}
    <dl className="def-list site-metadata">
     <div className="def-row"><dt>Server</dt><dd>{name(site.serverId,'servers')}</dd></div>
     <div className="def-row"><dt>{site.config?.kind==='static'?'Website files':'Containers'}</dt><dd className="container-labels">{site.config?.kind==='static'?<code>{site.config.documentRoot}</code>:site.config?.containers?.length?site.config.containers.map(container=><code key={container}>{container}</code>):<span>No containers configured</span>}</dd></div>
     <div className="def-row"><dt>Schedule</dt><dd>{describeSchedule(policy.schedule)}<span className="t-caption">{policy.timezone||'Time zone not set'}</span></dd></div>
     <div className="def-row"><dt>Retention</dt><dd>{policy.retention!=null?`${count(policy.retention,'successful backup')}`:'Not configured'}</dd></div>
     {(summary=>summary&&<div className="def-row"><dt>Storage</dt><dd>{summary.main}<span className="t-caption">{summary.copies}</span>{summary.missing&&<StatusLabel state="needs-review">Copy missing</StatusLabel>}{user?.role==='admin'&&onStorage&&<button type="button" className="cp-link" aria-label={`Change storage for ${site.name}`} onClick={()=>onStorage(site)}>Change</button>}</dd></div>)(siteStorageSummary(site))}
     <HardeningRow site={site} checking={checking?.has(site.id)}/>
     {site.config?.kind!=='static'&&site.incremental&&<div className="def-row"><dt>Incremental</dt><dd>{site.incremental.enabled?'Full every '+toBackups(site.incremental.interval)+' backups':'Off'}{!site.incremental.enabled&&<span className="t-caption">Every backup is complete</span>}{onIncremental&&<button type="button" className="cp-link" aria-label={`Change incremental backups for ${site.name}`} onClick={()=>onIncremental(site)}>Change</button>}</dd></div>}
     {onEditHistory&&<div className="def-row"><dt>Changes</dt><dd>{user?.role==='admin'&&site.config?.kind!=='static'&&onSafeEdit?'Safe Edit':'History'}<span className="t-caption">{site.config?.kind==='static'?'Static sites have nothing to edit':'Backup first, rollback if unhealthy'}</span>{user?.role==='admin'&&site.config?.kind!=='static'&&onSafeEdit&&<button type="button" className="cp-link" aria-label={`Edit ${site.name} with Safe Edit`} onClick={()=>onSafeEdit(site)}>Edit</button>}<button type="button" className="cp-link" aria-label={`Edit history for ${site.name}`} onClick={()=>onEditHistory(site)}>History</button></dd></div>}
    </dl>
   </div>
   <footer className="card-footer site-card-actions">
    <OverflowMenu label={'More actions for '+site.name} items={[
     {label:'Check readiness',icon:SiteIcons.readiness,disabled:busy,onSelect:()=>onReady(site)},
     {label:'Schedule',icon:SiteIcons.schedule,onSelect:()=>onSchedule(site,policy)},
     {label:'Restore tests',icon:SiteIcons.restore,onSelect:()=>onTests(site)},
     ...(user?.role==='admin'?[{label:'Remove app',icon:SiteIcons.remove,onSelect:()=>onRemove(site)}]:[])]}/>
    <button className="primary" disabled={busy} onClick={()=>onBackup(site)}>Back up now</button>
   </footer>
  </article>;
 })}</div>}</Paginated>;
}

export function Backups({backups,allBackups,busy,name,date,bytes,Badge,Empty,onClearFilter,onPin,onRestore,onDetails,onRetryCopy,retrying,onChain,query}){
 if(!allBackups.length)return <section className="panel"><Empty icon={BackupIcon} title="No recovery points yet">Run a backup from Apps &amp; Schedules. A recovery point appears only after the job is verified.</Empty></section>;
 if(!backups.length)return <section className="panel"><Empty icon={BackupIcon} title="No matching recovery points" action={<button onClick={onClearFilter}>Clear filter</button>}>Try another recovery point, timestamp or app identifier.</Empty></section>;
 const groups=new Map();
 for(const backup of backups){const group=groups.get(backup.siteId)||[];group.push(backup);groups.set(backup.siteId,group);}
 return <Paginated rows={[...groups]} label="Backup apps" fitViewport stableHeight resetKey={query}>{visible=><section className="backup-library" aria-label="Recovery points by app">{visible.map(([siteId,rows])=>{
  const history=[...rows].sort((a,b)=>new Date(b.capturedAt||b.createdAt)-new Date(a.capturedAt||a.createdAt));
  return <details className="backup-group" key={siteId}>
   <summary><span className="backup-site-name"><BrandIcon name="sites" size={28}/><span><b>{name(siteId)}</b><small>Recovery history</small></span></span><span className="backup-group-count"><b>{history.length} recovery {history.length===1?'point':'points'}</b><small>{bytes(history.reduce((sum,b)=>sum+(b.size||b.sizeBytes||0),0))} stored</small></span><span className="backup-latest"><small>Latest capture</small><b>{date(history[0].capturedAt||history[0].createdAt)}</b></span><ChevronDown size={20}/></summary>
   <div className="backup-group-content"><Paginated rows={history} label={"Recovery points for "+name(siteId)} pageSize={3} stableHeight resetKey={query}>{points=>points.map(backup=><div className="recovery-row" key={backup.id}>
    <RowOpen className="recovery-point" icon={BackupRowIcon} label={`Backup details ${backup.id}`} onClick={()=>onDetails(backup)}><b>{date(backup.capturedAt||backup.createdAt)}</b><code>{backup.id}</code></RowOpen>
    <div className="recovery-status">{(s=>[<Badge key="badge" value={s.badge}/>,<small key="level" title={s.title}>{s.line}{backup.pinned?', pinned':''}</small>])(recoveryStatus(backup))}</div>
    <div className="recovery-size"><b>{bytes(backup.size||backup.sizeBytes)}</b><small>{backup.downtimeMs!=null?(backup.downtimeMs/1000).toFixed(1)+' s offline':'Downtime not reported'}</small></div>
    <RecoveryActions backup={backup} busy={busy} onPin={onPin} onRestore={onRestore}/>
    <ChainLine backup={backup} backups={allBackups} date={date} onChain={onChain}/>
    <CopyLines backup={backup} busy={busy} retrying={retrying} onRetry={onRetryCopy}/>
   </div>)}</Paginated></div>
  </details>;
 })}</section>}</Paginated>;
}
