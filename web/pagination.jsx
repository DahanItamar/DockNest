import React,{useEffect,useState} from 'react';
import {ChevronLeft,ChevronRight} from './icons.jsx';

export function Paginated({rows,label,pageSize=5,resetKey='',children,className=''}) {
 const [page,setPage]=useState(1);
 useEffect(()=>setPage(1),[resetKey]);
 const pages=Math.max(1,Math.ceil(rows.length/pageSize)),current=Math.min(page,pages),start=(current-1)*pageSize;
 useEffect(()=>{if(page>pages)setPage(pages);},[page,pages]);
 const change=next=>setPage(Math.max(1,Math.min(pages,next)));
 return <div className={'paginated-list '+className}>
  <div className="paged-content">{children(rows.slice(start,start+pageSize))}</div>
  {pages>1&&<div className="pagination" role="group" aria-label={label+' pagination'}>
   <span className="pagination-count" role="status" aria-live="polite">{start+1}-{Math.min(start+pageSize,rows.length)} of {rows.length}</span>
   <div className="pagination-controls">
    <button type="button" aria-label={label+' previous page'} disabled={current===1} onClick={()=>change(current-1)}><ChevronLeft size={18}/><span>Previous</span></button>
    <span className="pagination-page" aria-label={label+' page'}>Page {current} of {pages}</span>
    <button type="button" aria-label={label+' next page'} disabled={current===pages} onClick={()=>change(current+1)}><span>Next</span><ChevronRight size={18}/></button>
   </div>
  </div>}
 </div>;
}
