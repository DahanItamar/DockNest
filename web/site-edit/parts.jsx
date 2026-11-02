import React,{useEffect,useState} from 'react';
import {DataTable} from '../data-table.jsx';
import {STEP_ICON} from '../restore-tests/parts.jsx';
import {clockOf,stepDuration} from '../restore-tests/model.js';
import {STEP_TEXT,visibleSteps} from './safe-edit-client.js';

export function useNarrow(){
 const q='(max-width:767px)',[narrow,setNarrow]=useState(()=>matchMedia(q).matches);
 useEffect(()=>{const m=matchMedia(q),on=()=>setNarrow(m.matches);m.addEventListener('change',on);return()=>m.removeEventListener('change',on)},[]);
 return narrow;
}

// A table on a wide screen (the product DataTable); on a phone the same rows as a list in the same bordered box.
// rows: [{key, cells:[node], label, value, wrap}]
export function Rows({headers,columns,numeric,rows,narrow}){
 if(!narrow)return <DataTable headers={headers} columns={columns} numeric={numeric}>{rows.map(r=><tr key={r.key}>{r.cells.map((c,i)=><td key={i}>{c}</td>)}</tr>)}</DataTable>;
 return <div className="data-table-wrap se-list"><dl className="def-list">{rows.map(r=><div key={r.key} className={'def-row'+(r.wrap?' wrap':'')}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}</dl></div>;
}

export function Timeline({edit}){
 return <div className="dn-tl"><ol className="dn-tl-list">{visibleSteps(edit).map(step=>{
  const [Icon,tone]=STEP_ICON[step.state]||STEP_ICON.pending;
  return <li key={step.step} className={'dn-tl-item'+(step.state==='failed'?' is-bad':'')}>
   <span className={'rt-tl-ic '+tone}><Icon size={16} stroke={2} aria-hidden="true"/></span>
   <span className="dn-tl-name">{STEP_TEXT[step.step]||step.step}{step.detail&&<small>{step.detail}</small>}</span>
   <time className="dn-tl-time">{step.startedAt?clockOf(step.startedAt):''}</time>
   <span className="dn-tl-dur">{stepDuration(step)}</span>
  </li>;})}</ol></div>;
}

export function Diff({diff}){
 const files=Array.isArray(diff)?diff:[];
 return <div className="se-diff mono" role="group" aria-label="Changes">{files.map(f=><React.Fragment key={f.path}>
  {files.length>1&&<div className="se-diff-file">{f.path}</div>}
  {(f.lines||[]).map((l,i)=><div key={i} className={'se-diff-line '+(l.type||'ctx')}><span className="se-diff-n">{l.n}</span><code>{l.text}</code></div>)}
 </React.Fragment>)}</div>;
}
