import React,{useState} from 'react';
import {ActivityChart,Sparkline,bucketActivity} from './charts.jsx';
import {ArrowRight,Check,ChevronDown,TriangleAlert} from './icons.jsx';
import {BrandIcon} from './brand.jsx';
import {describeSchedule} from './schedule.js';
import './dashboard.css';
import {Paginated} from './pagination.jsx';
import {formatDate} from './date-format.js';
import {integrityText,isIntegrityChecked,verificationSummary} from './verification.jsx';

const Layers=props=><BrandIcon name="sites" {...props}/>;
const Archive=props=><BrandIcon name="backups" {...props}/>;
const Activity=props=><BrandIcon name="jobs" {...props}/>;
const Clock=props=><BrandIcon name="schedule" {...props}/>;
const Server=props=><BrandIcon name="server" {...props}/>;

const newest = rows => [...rows].sort((a,b)=>new Date(b.capturedAt||b.createdAt)-new Date(a.capturedAt||a.createdAt));
const shortDate = value => value ? formatDate(value,{shortTime:true}) : 'No backup yet';

function IconButton({label,children,...props}) {
  return <button type="button" className="dash-icon" aria-label={label} title={label} {...props}>{children}</button>;
}

export function Dashboard({s,active,busy,user,name,bytes,date,open,action,navigate,Empty}) {
  const [period,setPeriod]=useState('week'),[metricPeriod,setMetricPeriod]=useState('year');
  const activity=bucketActivity(s,period),metricData=bucketActivity(s,metricPeriod);
  const backups=newest(s.backups),jobs=newest(s.jobs);
  const week=backups.filter(b=>new Date(b.capturedAt||b.createdAt)>new Date(Date.now()-7*86400000));
  const latestJob=id=>jobs.find(j=>j.siteId===id);
  const attention=s.sites.filter(site=>['failed','recovery_required'].includes(latestJob(site.id)?.status));
  const covered=s.sites.filter(site=>backups.some(b=>b.siteId===site.id&&isIntegrityChecked(b)));
  const storagePercent=s.storage?.total?Math.min(100,Math.round((s.storage.used||0)/s.storage.total*100)):null;
  const downtime=week.filter(b=>Number.isFinite(b.downtimeMs));

  return <div className="dash">
    <div className="dash-metrics" aria-label="Backup overview">
     <section className="dash-metric berry-metric-purple"><span className="metric-tile"><Layers size={24}/></span><strong>{covered.length} / {s.sites.length}</strong><span className="metric-label">Sites with recovery points</span><small>{s.servers.length} connected {s.servers.length===1?'server':'servers'}</small></section>
     <section className="dash-metric berry-metric-blue"><div className="metric-heading"><span className="metric-tile"><Archive size={24}/></span><div className="metric-period" role="group" aria-label="Capture metric period"><button aria-pressed={metricPeriod==='month'} onClick={()=>setMetricPeriod('month')}>Month</button><button aria-pressed={metricPeriod==='year'} onClick={()=>setMetricPeriod('year')}>Year</button></div></div><div className="metric-data"><div><strong>{metricData.series.slice(0,2).reduce((sum,x)=>sum+x.values.reduce((a,b)=>a+b,0),0)}</strong><span className="metric-label">Recovery points</span></div><Sparkline values={metricData.labels.map((_,i)=>metricData.series[0].values[i]+metricData.series[1].values[i])} labels={metricData.labels} label="Captures in selected period"/></div></section>
     <div className="metric-stack"><section className="dash-metric berry-metric-compact blue"><span className="metric-tile"><Activity size={24}/></span><div><strong>{active.length}</strong><span className="metric-label">Active jobs</span></div></section><section className="dash-metric berry-metric-compact"><span className="metric-tile"><Clock size={24}/></span><div><strong>{downtime.length?`${(downtime.reduce((sum,b)=>sum+b.downtimeMs,0)/downtime.length/1000).toFixed(1)} s`:'\u2014'}</strong><span className="metric-label">Average capture downtime</span></div></section></div>
    </div>
    <div className="dash-layout">
        <section className="dash-panel dash-growth" aria-labelledby="growth-title"><header className="dash-panel-head"><div><span className="growth-subtitle">Capture activity</span><h2 id="growth-title">{activity.series.slice(0,2).reduce((sum,x)=>sum+x.values.reduce((a,b)=>a+b,0),0)} recovery points</h2></div><label className="chart-period"><span className="sr-only">Activity period</span><select aria-label="Activity period" value={period} onChange={event=>setPeriod(event.target.value)}><option value="week">Last 7 days</option><option value="month">Last 30 days</option><option value="year">Last 12 months</option></select></label></header><ActivityChart s={s} period={period}/></section>
        <section className="dash-panel dash-activity" aria-labelledby="dash-activity-title"><header className="dash-panel-head"><div><span className="dash-eyebrow">OPERATIONS</span><h2 id="dash-activity-title">Recent activity</h2></div><IconButton label="View all jobs" onClick={()=>navigate('Jobs')}><ArrowRight size={17}/></IconButton></header>
          <div className="activity-feature"><div><span>Integrity-checked captures<small>Last 7 days</small></span><b>{week.filter(isIntegrityChecked).length}</b></div><Sparkline values={bucketActivity(s,'week').series[0].values} color="#4527A0" area label="Integrity-checked captures in the last seven days"/></div>
          {jobs.length?<div className="dash-job-list">{jobs.slice(0,5).map(job=>{
            const failed=['failed','recovery_required'].includes(job.status),running=['running','queued'].includes(job.status);
            return <div className="dash-job" key={job.id}><span className={`dash-job-icon ${failed?'warning':running?'neutral':'stored'}`}>{failed?<TriangleAlert size={16}/>:running?<BrandIcon name="jobs" size={16}/>:<Check size={16}/>}</span><div><b>{name(job.siteId)}</b><span>{job.type==='restore'?'Restore':'Backup'} · {job.status.replaceAll('_',' ')}</span><small title={date(job.createdAt||job.startedAt)}>{shortDate(job.createdAt||job.startedAt)}</small>{job.status==='recovery_required'&&<button className="dash-link" onClick={()=>open({type:'recovery',item:job})}>Review recovery <ArrowRight size={12}/></button>}</div><IconButton label={`View job ${job.id}`} onClick={()=>open({type:'job',item:job})}><ArrowRight size={16}/></IconButton></div>;
          })}</div>:<Empty icon={Activity} title="No jobs yet">Your backup and restore activity will appear here.</Empty>}
        </section>


        <section className="dash-panel dash-sites" aria-labelledby="dash-sites-title">
          <header className="dash-panel-head"><div><span className="dash-eyebrow">YOUR INFRASTRUCTURE</span><h2 id="dash-sites-title">Sites at a glance <span className="dash-count">{s.sites.length}</span></h2></div><button className="dash-link" onClick={()=>navigate('Sites & schedules')}>Manage sites <ArrowRight size={16}/></button></header>
          <div className={`dash-summary ${attention.length?'has-attention':''}`}>
            <span className="dash-summary-icon">{attention.length?<TriangleAlert size={20}/>:<BrandIcon name="sites" size={20}/>}</span>
            <div><strong>{attention.length?`${attention.length} ${attention.length===1?'site needs':'sites need'} attention`:s.sites.length?'Your sites, in one place':s.servers.length?'Choose your first site':'Start with your first Docker host'}</strong><p>{attention.length?'Review the latest failed or recovery job before your next capture.':s.sites.length?'Expand a site to browse its recovery points.':s.servers.length?'Select the containers that make up the site you want to protect.':'Connect a server, then choose the sites you want to back up.'}</p></div>
            {attention.length>0&&<IconButton label="Review job activity" onClick={()=>navigate('Jobs')}><ArrowRight size={18}/></IconButton>}
          </div>
          {s.sites.length?<>
            <div className="dash-site-columns" aria-hidden="true"><span>Site / server</span><span>Latest recovery point</span><span>Schedule</span><span/></div>
            <Paginated rows={s.sites} label="Dashboard sites" pageSize={5}>{visible=>visible.map(site=>{
              const history=backups.filter(b=>b.siteId===site.id),latest=history[0],job=latestJob(site.id),policy=s.policies.find(p=>p.siteId===site.id);
              const state=job?.status==='recovery_required'?'Recovery required':job?.status==='failed'?'Last job failed':['running','queued'].includes(job?.status)?'In progress':isIntegrityChecked(latest)?'Recovery point stored':'No integrity-checked backup';
              const tone=['failed','recovery_required'].includes(job?.status)?'warning':['running','queued'].includes(job?.status)?'neutral':isIntegrityChecked(latest)?'stored':'neutral';
              return <details className="dash-site" key={site.id}>
                <summary><span className="dash-site-identity"><span className="dash-site-icon"><BrandIcon name="sites" size={18}/></span><span><b>{site.name}</b><small><BrandIcon name="server" size={12}/>{name(site.serverId,'servers')}</small></span></span>
                  <span className="dash-site-latest"><b>{shortDate(latest?.capturedAt||latest?.createdAt)}</b><small className={`dash-state ${tone}`}><span/>{state}</small></span>
                  <span className="dash-site-schedule"><b>{!policy?'Not scheduled':policy.enabled?describeSchedule(policy.schedule):'Paused'}</b><small>{history.length} recovery {history.length===1?'point':'points'}</small></span>
                  <ChevronDown size={18} className="dash-chevron"/>
                </summary>
                <div className="dash-site-history"><div className="dash-history-heading"><span>Recovery history</span><button className="dash-link" onClick={()=>navigate('Backups')}>Open library <ArrowRight size={14}/></button></div>
                  {history.length?<Paginated rows={history} label={"Dashboard recovery points for "+site.name} pageSize={3}>{points=>points.map(backup=><div className="dash-backup" key={backup.id}>
                    <BrandIcon name="backups" size={16}/><div className="dash-backup-date"><b>{shortDate(backup.capturedAt||backup.createdAt)}</b><small>{bytes(backup.size||backup.sizeBytes)}{backup.pinned?' · Pinned':''}{' · '+integrityText(backup)}{(summary=>summary.kind&&summary.kind!=='integrity'?' · '+summary.text:'')(verificationSummary(backup))}</small></div>
                    <div className="dash-backup-actions">
                      <a className="dash-icon" href={`/api/backups/${backup.id}/download?format=zip`} aria-label={`Download full ZIP ${backup.id}`} title="Download full ZIP"><BrandIcon name="download" size={22}/></a>
                      <a className="dash-icon" href={`/api/backups/${backup.id}/download`} aria-label={`Download encrypted backup ${backup.id}`} title="Download encrypted backup"><BrandIcon name="encrypted-download" size={22}/></a>
                      <IconButton label={`${backup.pinned?'Unpin':'Pin'} backup ${backup.id}`} aria-pressed={!!backup.pinned} disabled={busy} onClick={()=>action(`/backups/${backup.id}/pin`,{pinned:!backup.pinned},backup.pinned?'Backup unpinned.':'Backup pinned.')}><BrandIcon name="pin" size={22}/></IconButton>
                      <IconButton label={`Restore backup ${backup.id}`} onClick={()=>open({type:'restore',item:backup})}><BrandIcon name="restore" size={22}/></IconButton>
                      <IconButton label={`Backup details ${backup.id}`} onClick={()=>open({type:'result',title:'Backup details',item:backup})}><BrandIcon name="details" size={22}/></IconButton>
                    </div>
                  </div>)}</Paginated>:<p className="dash-history-empty">No recovery points yet. Run your first backup from Sites & schedules.</p>}
                </div>
              </details>;
            })}</Paginated>
          </>:<Empty icon={s.servers.length?Layers:Server} title={s.servers.length?'Choose a site to protect':user?.role==='admin'?'Your first server starts here':'No sites configured yet'} action={s.servers.length?<button className="primary" onClick={()=>navigate('Sites & schedules')}>Choose a site <ArrowRight size={16}/></button>:user?.role==='admin'?<button className="primary" onClick={()=>open({type:'server'})}>Connect a server <ArrowRight size={16}/></button>:null}>{s.servers.length?'Your server is connected. Group the containers for your first site and set its schedule.':user?.role==='admin'?'Add a Docker host to discover its containers and configure your first site.':'Ask your administrator to connect a Docker host.'}</Empty>}
          
        </section>



    </div>
  </div>;
}
