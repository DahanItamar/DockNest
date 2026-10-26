import React,{useState} from 'react';
import {count} from './plural.js';
import {ActivityChart,Sparkline,bucketActivity} from './charts.jsx';
import {ArrowRight,Check,ChevronDown,Restore,TriangleAlert} from './icons.jsx';
import {BrandIcon} from './brand.jsx';
import {ZipButton} from './zip-export.jsx';
import {StatusLabel,AlertPanel} from './system.jsx';
import {describeSchedule} from './schedule.js';
import './dashboard.css';
import {Paginated} from './pagination.jsx';
import {formatDate} from './date-format.js';
import {isIntegrityChecked} from './verification.jsx';
import {LastTest,TestLabel} from './restore-tests/parts.jsx';
import {testIdOf} from './restore-tests/restore-tests-client.js';
import {backupTest,failedPlain,shortSchedule} from './restore-tests/model.js';

const Layers=props=><BrandIcon name="sites" {...props}/>;
const Archive=props=><BrandIcon name="backups" {...props}/>;
const Activity=props=><BrandIcon name="jobs" {...props}/>;
const Clock=props=><BrandIcon name="schedule" {...props}/>;
const Server=props=><BrandIcon name="server" {...props}/>;

const newest = rows => [...rows].sort((a,b)=>new Date(b.capturedAt||b.createdAt)-new Date(a.capturedAt||a.createdAt));
const shortDate = value => value ? formatDate(value,{shortTime:true}) : 'No backup yet';
const testJobFor = (jobs,testId) => jobs.find(j=>j.type==='restore-test'&&testIdOf(j)===testId);

function IconButton({label,children,...props}) {
  return <button type="button" className="dash-icon" aria-label={label} title={label} {...props}>{children}</button>;
}

export function Dashboard({s,active,busy,user,name,bytes,date,open,action,navigate,Empty,tests={},onRunTest=()=>{}}) {
  const [period,setPeriod]=useState('week'),[metricPeriod,setMetricPeriod]=useState('month');
  const activity=bucketActivity(s,period),metricData=bucketActivity(s,metricPeriod);
  const backups=newest(s.backups),jobs=newest(s.jobs);
  const week=backups.filter(b=>new Date(b.capturedAt||b.createdAt)>new Date(Date.now()-7*86400000));
  const latestJob=id=>jobs.find(j=>j.siteId===id&&j.type!=='restore-test');
  const attention=s.sites.filter(site=>['failed','recovery_required'].includes(latestJob(site.id)?.status));
  const attentionJobs=attention.map(x=>latestJob(x.id)),attentionFailed=attentionJobs.some(j=>j.status==='failed'),attentionJob=attentionJobs.find(j=>j.status==='failed')||attentionJobs[0];
  const covered=s.sites.filter(site=>backups.some(b=>b.siteId===site.id&&isIntegrityChecked(b)));
  const storagePercent=s.storage?.total?Math.min(100,Math.round((s.storage.used||0)/s.storage.total*100)):null;
  const downtime=week.filter(b=>Number.isFinite(b.downtimeMs));
  const failedTests=s.sites.map(site=>({site,card:tests[site.id]})).filter(x=>x.card?.last?.result==='failed'&&!x.card.active).sort((a,b)=>new Date(b.card.last.finishedAt)-new Date(a.card.last.finishedAt));
  const failedJob=failedTests.length?testJobFor(jobs,failedTests[0].card.last.id):null;

  return <div className="dash">
    <div className="dash-metrics" aria-label="Backup overview">
     <section className="dash-metric berry-metric-purple"><span className="metric-tile"><Layers size={24}/></span><strong>{covered.length} / {s.sites.length}</strong><span className="metric-label">Sites with recovery points</span><small>{s.servers.length} connected {s.servers.length===1?'server':'servers'}</small></section>
     <section className="dash-metric berry-metric-blue"><div className="metric-heading"><span className="metric-tile"><Archive size={24}/></span><div className="metric-period" role="group" aria-label="Capture metric period"><button aria-pressed={metricPeriod==='month'} onClick={()=>setMetricPeriod('month')}>Month</button><button aria-pressed={metricPeriod==='year'} onClick={()=>setMetricPeriod('year')}>Year</button></div></div><div className="metric-data"><div><strong>{metricData.series.slice(0,2).reduce((sum,x)=>sum+x.values.reduce((a,b)=>a+b,0),0)}</strong><span className="metric-label">Recovery points</span></div><Sparkline values={metricData.labels.map((_,i)=>metricData.series[0].values[i]+metricData.series[1].values[i])} labels={metricData.labels} label="Captures in selected period"/></div></section>
     <div className="metric-stack"><section className="dash-metric berry-metric-compact blue"><span className="metric-tile"><Activity size={24}/></span><div><strong>{active.length}</strong><span className="metric-label">Active jobs</span></div></section><section className="dash-metric berry-metric-compact"><span className="metric-tile"><Clock size={24}/></span><div><strong>{downtime.length?`${(downtime.reduce((sum,b)=>sum+b.downtimeMs,0)/downtime.length/1000).toFixed(1)} s`:'\u2014'}</strong><span className="metric-label">Average capture downtime</span></div></section></div>
    </div>
    <div className="dash-layout">
        <section className="dash-panel dash-growth" aria-labelledby="growth-title"><header className="dash-panel-head"><div><span className="growth-subtitle">Capture activity</span><h2 id="growth-title">{count(activity.series.slice(0,2).reduce((sum,x)=>sum+x.values.reduce((a,b)=>a+b,0),0),'recovery point')}</h2></div><label className="chart-period"><span className="sr-only">Activity period</span><select aria-label="Activity period" value={period} onChange={event=>setPeriod(event.target.value)}><option value="week">Last 7 days</option><option value="month">Last 30 days</option><option value="year">Last 12 months</option></select></label></header><ActivityChart s={s} period={period}/></section>
        <section className="dash-panel dash-activity" aria-labelledby="dash-activity-title"><header className="dash-panel-head"><div><span className="dash-eyebrow">OPERATIONS</span><h2 id="dash-activity-title">Recent activity</h2></div><IconButton label="View all jobs" onClick={()=>navigate('Jobs')}><ArrowRight size={17}/></IconButton></header>
          <div className="activity-feature"><div><span>Integrity-checked captures<small>Last 7 days</small></span><b>{week.filter(isIntegrityChecked).length}</b></div><Sparkline values={bucketActivity(s,'week').series[0].values} color="#4527A0" area label="Integrity-checked captures in the last seven days"/></div>
          {jobs.length?<div className="dash-job-list">{jobs.slice(0,5).map(job=>{
            return <div className="dash-job" key={job.id}><div><b>{name(job.siteId)}</b><span>{job.type==='restore'?'Restore':job.type==='restore-test'?'Restore test':'Backup'}</span><span><StatusLabel value={job.status}/></span><small title={date(job.createdAt||job.startedAt)}>{shortDate(job.createdAt||job.startedAt)}</small>{job.status==='recovery_required'&&<button className="dash-link" onClick={()=>open({type:'recovery',item:job})}>Review recovery <ArrowRight size={12}/></button>}</div><IconButton label={`View job ${job.id}`} onClick={()=>open({type:'job',item:job})}><ArrowRight size={16}/></IconButton></div>;
          })}</div>:<Empty icon={Activity} title="No jobs yet">Your backup and restore activity will appear here.</Empty>}
        </section>


        <section className="dash-panel dash-sites" aria-labelledby="dash-sites-title">
          <header className="dash-panel-head"><div><h2 id="dash-sites-title">Sites at a glance</h2></div><button className="dash-link" onClick={()=>navigate('Sites & schedules')}>Manage sites <ArrowRight size={16}/></button></header>
          {attention.length>0?<AlertPanel variant={attentionFailed?'error':'warning'} title={`${attention.length} ${attention.length===1?'site needs':'sites need'} attention`} action={<button type="button" className="text link-btn dash-alert-action" onClick={()=>attentionJob.status==='recovery_required'?open({type:'recovery',item:attentionJob}):open({type:'job',item:attentionJob})}>{attentionJob.status==='recovery_required'?'Review recovery':'Open job'}</button>}>{attentionJob.error?String(attentionJob.error).slice(0,160):attentionFailed?'The latest backup job failed.':'A job needs recovery review before your next capture.'}</AlertPanel>:null}
          {failedTests.length>0&&<AlertPanel variant="error" title={failedTests.length===1?'Restore test failed':`${failedTests.length} restore tests failed`} action={<div className="rp-actions"><button type="button" className="primary" disabled={busy} onClick={()=>onRunTest(failedTests[0].site)}>Run again</button><button type="button" onClick={()=>failedJob?open({type:'job',item:failedJob}):navigate('Jobs')}>Open job</button></div>}>{(failedTests.length>1?failedTests[0].site.name+': ':'')+failedPlain(failedTests[0].card.last)}</AlertPanel>}
          {s.sites.length?<>
            <div className="dash-site-columns" aria-hidden="true"><span>Site / server</span><span>Last test</span><span>Schedule</span><span/></div>
            <Paginated rows={s.sites} label="Dashboard sites" pageSize={5}>{visible=>visible.map(site=>{
              const history=backups.filter(b=>b.siteId===site.id),policy=s.policies.find(p=>p.siteId===site.id);
              return <details className="dash-site" key={site.id}>
                <summary><span className="dash-site-identity"><span className="dash-site-icon"><BrandIcon name="sites" size={18}/></span><span><b>{site.name}</b><small><BrandIcon name="server" size={12}/>{name(site.serverId,'servers')}</small></span></span>
                  <span className="dash-site-latest"><LastTest card={tests[site.id]}/></span>
                  <span className="dash-site-schedule"><b>{!policy?'Not scheduled':policy.enabled?shortSchedule(describeSchedule(policy.schedule)):'Paused'}</b></span>
                  <ChevronDown size={18} className="dash-chevron"/>
                </summary>
                <div className="dash-site-history"><div className="dash-history-heading"><span>Recovery history</span><span className="rt-links"><button className="dash-link" disabled={busy||!!tests[site.id]?.active} onClick={()=>onRunTest(site)}><Restore size={14}/> Run test</button><button className="dash-link" onClick={()=>navigate('Backups')}>Open library <ArrowRight size={14}/></button></span></div>
                  {history.length?<Paginated rows={history} label={"Dashboard recovery points for "+site.name} pageSize={3}>{points=>points.map(backup=><div className="dash-backup" key={backup.id}>
                    <BrandIcon name="backups" size={16}/><div className="dash-backup-date"><b>{shortDate(backup.capturedAt||backup.createdAt)}</b><small className="rt-meta"><span>{bytes(backup.size||backup.sizeBytes)}{backup.pinned?' · Pinned':''} · </span>{(t=><TestLabel state={t.state}>{t.label}</TestLabel>)(backupTest(backup))}</small></div>
                    <div className="dash-backup-actions">
                      <ZipButton backupId={backup.id} className="dash-icon" label={`Download full ZIP ${backup.id}`} title="Download full ZIP"><BrandIcon name="download" size={22}/></ZipButton>
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
