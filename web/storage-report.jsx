import React,{useEffect,useState} from 'react';
import {Sparkline} from './charts.jsx';
import {BrandIcon} from './brand.jsx';
import {REPO} from './updates/parts.jsx';
import './dashboard.css';
import './storage-report.css';

export const GUIDE=REPO+'/blob/main/docs/restore-tests-guide.md#storage-report';
import {formatBytes as size} from '../shared/format-bytes.js';
export const storageLine=storage=>storage.capacityBytes?`${size(storage.bytes)} of ${size(storage.capacityBytes)}`:`${size(storage.bytes)}, capacity unknown`;
export const estimateLine=report=>report.totals.packages<2||!report.totals.estimateUpToPercent?'Not enough backups yet to estimate savings from incremental backups.':`Incremental backups could save about ${report.totals.estimateUpToPercent}% (estimate).`;
export const usedPercent=(bytes,capacity)=>capacity>0?Math.min(100,Math.max(bytes?1:0,Math.round(bytes/capacity*100))):null;
// The history starts at the first day that holds data; earlier days are not drawn as a fake zero run.
export function historyOf(growth,generatedAt){
 const points=growth.points||[],first=points.findIndex(value=>value>0);
 if(first<0)return {values:[],since:null};
 const end=Date.parse(generatedAt),since=Number.isFinite(end)?new Date(end-(points.length-1-first)*86400000):null;
 return {values:points.slice(first),since,full:first===0};
}
const sinceLabel=date=>date?date.toLocaleDateString(undefined,{month:'short',day:'numeric'}):'';

export function useStorageReport(api,onSessionExpired=()=>{}) {
 const [state,setState]=useState({report:null,error:''});
 useEffect(()=>{let current=true;api('/storage-report').then(report=>{if(current)setState({report,error:''});}).catch(failure=>{if(!current)return;if(failure.status===401)onSessionExpired();else setState({report:null,error:'The storage report is not available right now.'});});return()=>{current=false;};},[]);
 return state;
}

// The Overview compact metric (dash-metric berry-metric-compact), with a secondary line and an optional slim bar in the text column.
function Metric({icon,label,value,hint,children,action}) {
 return <section className="dash-metric berry-metric-compact"><span className="metric-tile"><BrandIcon name={icon} size={24}/></span><div className="sr-metric-body"><strong>{value}</strong><span className="metric-label">{label}{action}</span>{children}<small title={typeof hint==='string'?hint:undefined}>{hint}</small></div></section>;
}

// Space per site, 30-day growth and the labelled best-case estimate (docs/restore-tests.md).
export function StorageReport({report,error,onOpenSites}) {
 if(error)return <p className="t-caption sr-status" role="status">{error}</p>;
 if(!report)return <p className="t-caption sr-status" role="status">Loading the storage report…</p>;
 if(!report.totals.packages)return <section className="card sr-empty"><div className="card-body"><h2 className="card-title">Space used by your backups</h2><p className="t-caption">No backups are stored yet.</p></div></section>;
 const growth=report.growth,history=historyOf(growth,report.generatedAt),change=history.values.length?growth.toBytes-history.values[0]:0,sign=change<0?'−':'+';
 const known=report.storages.filter(storage=>storage.capacityBytes>0),capacity=known.reduce((sum,storage)=>sum+storage.capacityBytes,0),used=known.reduce((sum,storage)=>sum+storage.bytes,0),percent=usedPercent(used,capacity);
 const enough=report.totals.packages>=2&&report.totals.estimateUpToPercent>0,top=report.sites[0]?.bytes||1;
 return <div className="sr-page" aria-label="Storage report">
  <div className="sr-metrics">
   <Metric icon="backups" label="Stored" value={size(report.totals.bytes)} hint={`${report.totals.packages} ${report.totals.packages===1?'backup':'backups'} across ${report.sites.length} ${report.sites.length===1?'site':'sites'}`}/>
   <Metric icon="storage" label="Capacity used" value={percent==null?'Not reported':percent+'%'} hint={percent==null?'This storage does not report its capacity.':`${size(used)} of ${size(capacity)}`}>{percent!=null&&<progress value={percent} max="100" aria-label="Capacity used"/>}</Metric>
   <Metric icon="jobs" label="Growth" value={history.values.length>1?sign+size(Math.abs(change)):'—'} hint={history.values.length>1?(history.full?'Last 30 days':'Since '+sinceLabel(history.since)):'Needs a few days of history'}/>
   <Metric icon="update" label="Incremental saving" value={enough?'About '+report.totals.estimateUpToPercent+'%':'—'} hint={enough?'Best-case estimate':'Not enough backups yet to estimate'} action={<a className="sr-info" href={GUIDE} target="_blank" rel="noopener noreferrer" aria-label="About this estimate" title="How this estimate is made"><BrandIcon name="details" size={18}/></a>}/>
  </div>
  <div className="sr-split">
   <section className="card"><div className="card-body"><h2 className="card-title">By site</h2><div className="sr-scroll" tabIndex={report.sites.length>8?0:undefined} aria-label={report.sites.length>8?'Sites by size, scrollable':undefined}><table className="sr-table"><thead className="sr-sr"><tr><th>Site</th><th>Share</th><th>Size</th></tr></thead><tbody>{report.sites.map(site=><tr key={site.siteId}><th scope="row" title={site.name}><span>{site.name}</span></th><td><span className="sr-bar" aria-hidden="true"><i style={{width:Math.max(2,Math.round(site.bytes/top*100))+'%'}}/></span></td><td className="num">{size(site.bytes)}</td></tr>)}</tbody></table></div></div>{onOpenSites&&<footer className="card-footer"><button type="button" onClick={onOpenSites}>Open sites</button></footer>}</section>
   <section className="card"><div className="card-body sr-growth"><h2 className="card-title">Growth</h2>{history.values.length>1?<><p className="t-caption sr-growth-range">{size(history.values[0])} to {size(growth.toBytes)}, {history.full?'last 30 days':'since '+sinceLabel(history.since)}</p><div className="sr-chart-wrap"><div className="sr-chart"><span className="sr-zero" aria-hidden="true">0 B</span><Sparkline values={history.values} area label={history.full?'Stored backup size over the last 30 days':'Stored backup size since '+sinceLabel(history.since)}/></div><div className="sr-axis t-caption" aria-hidden="true"><span>{history.full?'30 days ago':sinceLabel(history.since)} · {size(history.values[0])}</span><span>Today · {size(growth.toBytes)}</span></div></div></>:<p className="t-caption sr-chart-empty">{history.values.length?'History starts today. The chart appears after a second day of backups.':'No history yet. The chart appears once backups have been stored for a couple of days.'}</p>}</div></section>
  </div>
 </div>;
}
