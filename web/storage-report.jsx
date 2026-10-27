import React,{useEffect,useState} from 'react';
import {Sparkline} from './charts.jsx';
import {BrandIcon} from './brand.jsx';
import {REPO} from './updates/parts.jsx';
import './storage-report.css';

export const GUIDE=REPO+'/blob/main/docs/restore-tests-guide.md#storage-report';
const size=value=>{if(!value)return '0 B';const i=Math.min(4,Math.floor(Math.log(value)/Math.log(1024)));return (value/1024**i).toFixed(i>1?1:0)+' '+['B','KB','MB','GB','TB'][i];};
export const storageLine=storage=>storage.capacityBytes?`${size(storage.bytes)} of ${size(storage.capacityBytes)}`:`${size(storage.bytes)}, capacity unknown`;
export const estimateLine=report=>report.totals.packages<2||!report.totals.estimateUpToPercent?'Not enough backups yet to estimate savings from incremental backups.':`Incremental backups could save about ${report.totals.estimateUpToPercent}% (estimate).`;

// Space per site and per storage, 30-day growth and the labelled best-case estimate (docs/restore-tests.md).
export function StorageReport({api,onOpenSites,onSessionExpired=()=>{}}) {
 const [report,setReport]=useState(null),[error,setError]=useState('');
 useEffect(()=>{let current=true;api('/storage-report').then(result=>{if(current)setReport(result);}).catch(failure=>{if(!current)return;if(failure.status===401)onSessionExpired();else setError('The storage report is not available right now.');});return()=>{current=false;};},[]);
 if(error)return <p className="t-caption" role="status">{error}</p>;
 if(!report)return <p className="t-caption" role="status">Loading the storage report…</p>;
 if(!report.totals.packages)return <section className="card sr-empty"><div className="card-body"><h2 className="card-title">Space used by your backups</h2><p className="t-caption">No backups are stored yet.</p></div></section>;
 const growth=report.growth,sign=growth.changeBytes<0?'−':'+';
 return <div className="card-grid sr-grid" aria-label="Storage report">
  <section className="card"><div className="card-body"><h2 className="card-title">By site</h2><dl className="def-list">{report.sites.slice(0,6).map(site=><div className="def-row" key={site.siteId}><dt>{site.name}</dt><dd>{size(site.bytes)}</dd></div>)}</dl>{report.sites.length>6&&<p className="t-caption">and {report.sites.length-6} more</p>}</div>{onOpenSites&&<footer className="card-footer"><button type="button" onClick={onOpenSites}>Open sites</button></footer>}</section>
  <section className="card"><div className="card-body"><h2 className="card-title">By storage</h2>{report.storages.map(storage=><div className="sr-store" key={storage.id}><div className="def-row"><dt>{storage.name}</dt><dd>{storageLine(storage)}</dd></div>{storage.capacityBytes>0&&<progress value={Math.min(100,Math.max(storage.bytes?1:0,Math.round(storage.bytes/storage.capacityBytes*100)))} max="100" aria-label={storage.name+' used'}/>}</div>)}</div></section>
  <section className="card sr-wide"><div className="card-body"><h2 className="card-title">Last 30 days</h2><div className="activity-feature sr-feature"><div><span>Growth<small>{size(growth.fromBytes)} to {size(growth.toBytes)}</small></span><b>{sign}{size(Math.abs(growth.changeBytes))}</b></div><Sparkline values={growth.points} area label="Stored backup size over the last 30 days"/></div></div><footer className="card-footer sr-estimate"><span className="t-caption">{estimateLine(report)}</span><a className="sr-info" href={GUIDE} target="_blank" rel="noopener noreferrer" aria-label="About this estimate"><BrandIcon name="info" size={18}/></a></footer></section>
 </div>;
}
