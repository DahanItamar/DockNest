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
 const files=diff?.files||[],env=diff?.env||[];
 const multi=files.length+(env.length?1:0)>1;
 return <div className="se-diff mono" role="group" aria-label="Changes">
  {files.map(f=><React.Fragment key={f.path}>
   {multi&&<div className="se-diff-file">{f.path}</div>}
   {(f.hunks||[]).map((h,hi)=>{
    let oldN=h.oldStart,newN=h.newStart;
    return <React.Fragment key={hi}>{(h.lines||[]).map((l,i)=>{
     const n=l.type==='remove'?oldN++:l.type==='add'?newN++:(oldN++,newN++);
     return <div key={i} className={'se-diff-line '+(l.type==='remove'?'del':l.type==='add'?'add':'ctx')}><span className="se-diff-n">{n}</span><code>{l.text}</code></div>;
    })}</React.Fragment>;
   })}
  </React.Fragment>)}
  {env.length>0&&<>
   {multi&&<div className="se-diff-file">Environment</div>}
   {env.map(e=><div key={e.file+e.key} className={'se-diff-line '+(e.change==='removed'?'del':'add')}><span className="se-diff-n"/><code>{e.change==='removed'?e.key:e.key+'='+e.value}</code></div>)}
  </>}
 </div>;
}
