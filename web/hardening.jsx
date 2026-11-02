import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {AlertPanel,StatusLabel} from './system.jsx';
import {DataTable} from './data-table.jsx';
import {Paginated} from './pagination.jsx';
import {X} from './icons.jsx';
import {count} from './plural.js';
import './hardening.css';

// Read-only view of site.hardening (docs/hardening-score.md): {grade,checkedAt,passed,total,findings:[{id,severity,title,fix,container}]}.
const GRADE_STATE={A:'success',B:'success',C:'needs-review',D:'needs-review',E:'failed',F:'failed'};
const SEVERITY_STATE={high:'failed',medium:'needs-review',low:'queued'};
const toFix=n=>n+' to fix';
const isStatic=site=>site?.config?.kind==='static';
const findingsOf=h=>Array.isArray(h?.findings)?h.findings:[];
const ago=value=>{const t=Date.parse(value);if(!t)return '';const h=Math.max(0,Math.floor((Date.now()-t)/3600000));return h<1?'just now':h<24?count(h,'hour')+' ago':count(Math.floor(h/24),'day')+' ago'};
function summary(h){
 const list=findingsOf(h),high=list.filter(f=>f.severity==='high').length;
 return high?count(high,'serious risk')+' to fix first.':count(list.length,'risk')+' to fix.';
}

export function HardeningDialog({site,onClose}){
 const ref=useRef(),h=site.hardening||{},list=findingsOf(h);
 useEffect(()=>{ref.current?.showModal?.();return()=>ref.current?.close?.();},[]);
 const alert=h.grade==='F'?'error':h.grade==='D'?'warning':null,when=ago(h.checkedAt);
 return createPortal(<dialog ref={ref} className="hd-dialog" aria-labelledby="hd-dialog-title" onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===ref.current)onClose();}}>
  <div className="modal-head"><h2 id="hd-dialog-title">Hardening, {site.name}</h2><button type="button" className="icon" onClick={onClose} aria-label="Close dialog"><X size={20}/></button></div>
  <div className="modal-body">
   {alert&&<AlertPanel variant={alert} title={'Grade '+h.grade}>{summary(h)}</AlertPanel>}
   <p className="t-caption">{h.passed} of {h.total} checks passed{when?', '+when:''}.</p>
   <Paginated rows={list} label="Findings" pageSize={5}>{visible=><div className="hd-table"><DataTable headers={['Finding','Container','Fix']} columns={['30%','20%',null]}>{visible.map(f=><tr key={f.id}><td><StatusLabel state={SEVERITY_STATE[f.severity]||'queued'}>{f.title}</StatusLabel><span className="t-caption hd-fix-inline">{f.fix}</span></td><td title={f.container}><code>{f.container}</code></td><td>{f.fix}</td></tr>)}</DataTable></div>}</Paginated>
   <div className="modal-foot"><button type="button" onClick={onClose}>Close</button></div>
  </div>
 </dialog>,document.body);
}

function useDialog(site){
 const [open,setOpen]=useState(false);
 return [open&&<HardeningDialog site={site} onClose={()=>setOpen(false)}/>,()=>setOpen(true)];
}

function Notice({site,checking}){
 return checking?<StatusLabel state="running">Checking…</StatusLabel>
 :<span className="t-caption">{isStatic(site)?'Static site, nothing to check.':'Not checked yet. Next backup checks it.'}</span>;
}

// Sites page: one definition row in every site card. `checking` is true only while a backup of this site is running.
export function HardeningRow({site,checking=false}){
 const h=site.hardening,[dialog,show]=useDialog(site),list=findingsOf(h),graded=!isStatic(site)&&!!h?.grade;
 return <div className="def-row"><dt>Hardening</dt><dd>
  {!graded?<Notice site={site} checking={checking&&!isStatic(site)}/>
  :<><StatusLabel state={GRADE_STATE[h.grade]||'queued'}>Grade {h.grade}</StatusLabel><span className="t-caption">{list.length?toFix(list.length):'All passed'}</span>{list.length>0&&<button type="button" className="cp-link" aria-label={'Findings for '+site.name} onClick={show}>Findings</button>}</>}
  {dialog}
 </dd></div>;
}

// Map details panel: grade, the first three findings, See all.
export function HardeningSection({site,checking=false}){
 const h=site.hardening,[dialog,show]=useDialog(site),list=findingsOf(h),graded=!isStatic(site)&&!!h?.grade;
 return <section className="hd-section"><h3 className="map-group-title">Hardening</h3>
  {!graded?<div role="status"><Notice site={site} checking={checking&&!isStatic(site)}/></div>
  :<>
   <div className="hd-summary"><StatusLabel state={GRADE_STATE[h.grade]||'queued'}>Grade {h.grade}</StatusLabel><span className="map-caption">{list.length?toFix(list.length):'All passed'}</span></div>
   {list.length>0&&<ul className="hd-list">{list.slice(0,3).map(f=><li key={f.id}><StatusLabel state={SEVERITY_STATE[f.severity]||'queued'}>{f.title}</StatusLabel><span className="map-caption">{f.fix}</span></li>)}</ul>}
   {list.length>3&&<div><button type="button" onClick={show}>See all</button></div>}
  </>}
  {dialog}
 </section>;
}
