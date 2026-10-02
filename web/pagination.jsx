import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ChevronLeft,ChevronRight} from './icons.jsx';

export function Paginated({rows,label,pageSize=5,resetKey='',children,className='',stableHeight=false}) {
 const [page,setPage]=useState(1),[reservedHeight,setReservedHeight]=useState(0),measure=useRef(null),last=useRef({width:0,height:0});
 // Reserve real collection geometry so partial pages cannot pull the controls upward.
 useLayoutEffect(()=>{
  if(!stableHeight)return;
  last.current={width:0,height:0};
  const update=()=>{
   const element=measure.current;if(!element)return;
   const rect=element.getBoundingClientRect(),table=element.querySelector('table');
   if(!rect.width||!rect.height)return; // A closed backup history is measured when opened.
   let capacity=rect.height;
   if(table){
    const rowHeight=Number.parseFloat(getComputedStyle(element).getPropertyValue('--table-row-height'))||76;
    capacity=(table.tHead?.getBoundingClientRect().height||0)+rowHeight*pageSize;
   }else{
    const only=element.children.length===1?element.firstElementChild:null;
    const collection=only&&[...only.children].some(item=>['ARTICLE','DETAILS'].includes(item.tagName))?only:element;
    const items=[...collection.children],style=getComputedStyle(collection),gap=Number.parseFloat(style.rowGap)||0;
    if(items.length){
     const heights=items.map(item=>item.getBoundingClientRect().height);
     if(items.every(item=>item.tagName==='ARTICLE')){
      const columns=style.display==='grid'?style.gridTemplateColumns.split(' ').length:1;
      const rowCount=Math.ceil(pageSize/columns);
      capacity=Math.max(...heights)*rowCount+gap*(rowCount-1);
     }else{
      // Open groups keep their actual height; missing groups reserve only a summary slot.
      const slot=Math.max(...items.map((item,index)=>item.tagName==='DETAILS'?item.querySelector('summary').getBoundingClientRect().height:heights[index]));
      capacity=heights.reduce((sum,height)=>sum+height,0)+(pageSize-items.length)*slot+gap*(pageSize-1);
     }
    }
   }
   const changedWidth=Math.abs(rect.width-last.current.width)>1;
   const height=Math.ceil(Math.max(rect.height,capacity,changedWidth?0:last.current.height));
   last.current={width:rect.width,height};setReservedHeight(height);
  };
  const observer=new ResizeObserver(update);observer.observe(measure.current);update();return()=>observer.disconnect();
 },[stableHeight,pageSize,label,resetKey]);
 useEffect(()=>setPage(1),[resetKey,label]);
 const pages=Math.max(1,Math.ceil(rows.length/pageSize)),current=Math.min(page,pages),start=(current-1)*pageSize;
 useEffect(()=>{if(page>pages)setPage(pages);},[page,pages]);
 const change=next=>setPage(Math.max(1,Math.min(pages,next)));
 return <div className={'paginated-list '+(stableHeight?'stable-page ':'')+className}>
  <div className="paged-content" style={stableHeight&&pages>1?{'--page-height':reservedHeight+'px'}:undefined}><div className="paged-measure" ref={measure}>{children(rows.slice(start,start+pageSize))}</div></div>
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
