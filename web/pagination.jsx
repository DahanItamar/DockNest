import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ChevronLeft,ChevronRight} from './icons.jsx';

// Phones scroll naturally: no reserved empty height and more groups per page (2.3.1).
const PHONE='(max-width:767px)',PHONE_GROUPS=6;
function usePhone(){
 const [phone,setPhone]=useState(()=>typeof matchMedia==='function'&&matchMedia(PHONE).matches);
 useEffect(()=>{if(typeof matchMedia!=='function')return;const query=matchMedia(PHONE),sync=()=>setPhone(query.matches);sync();query.addEventListener('change',sync);return()=>query.removeEventListener('change',sync);},[]);
 return phone;
}
export function Paginated({rows,label,pageSize=5,resetKey='',children,className='',stableHeight:stableRequested=false,gapped:gappedRequested=false,fitViewport:fitRequested=false}) {
 const table=className.includes('stable-table'),phone=usePhone(),stableHeight=stableRequested&&!phone,fitViewport=fitRequested&&!phone;
 const [page,setPage]=useState(1),[reservedHeight,setReservedHeight]=useState(0),measure=useRef(null),last=useRef({width:0,height:0});
 const pager=useRef(null),[viewport,setViewport]=useState({size:1,height:0});
 const size=fitViewport?viewport.size:(fitRequested&&phone&&!table?PHONE_GROUPS:pageSize);
 // Measure collapsed site summaries and the actual surrounding chrome, rather than
 // assigning a desktop row count. Open histories retain their normal document flow.
 useLayoutEffect(()=>{
  if(!fitViewport)return;
  const element=measure.current,main=element.closest('main'),footer=main?.parentElement.querySelector(':scope > footer');
  const update=()=>{
   const top=element.getBoundingClientRect().top+window.scrollY;
   const bottom=Number.parseFloat(getComputedStyle(main||element).paddingBottom)||0;
   // The pager sits one section gap below card content, or inside the panel for tables; both are subtracted here.
   const panel=table?element.closest('.panel'):null,panelStyle=panel&&getComputedStyle(panel);
   const inside=panelStyle?['paddingBottom','borderBottomWidth','paddingTop','borderTopWidth'].reduce((sum,key)=>sum+(Number.parseFloat(panelStyle[key])||0),0):0;
   const spacing=table?0:Number.parseFloat(getComputedStyle(element.parentElement).marginBottom)||0;
   const available=window.innerHeight-top-bottom-inside-spacing-(footer?.getBoundingClientRect().height||0)-(pager.current?.getBoundingClientRect().height||0);
   let next;
   if(table){
    // Tables fill the viewport with whole rows, never fewer than the page size.
    const rowHeight=Number.parseFloat(getComputedStyle(element).getPropertyValue('--table-row-height'))||56,head=element.querySelector('thead')?.getBoundingClientRect().height||40,frame=2;
    const fitted=Math.max(pageSize,Math.floor((available-head-frame)/rowHeight));
    next={size:fitted,height:head+frame+fitted*rowHeight};
   }else{
    const collection=element.firstElementChild,items=[...(collection?.children||[])];
    if(!items.length)return;
    const slot=Math.max(...items.map(item=>(item.querySelector('summary')||item).getBoundingClientRect().height));
    if(!slot)return;
    const gap=Number.parseFloat(getComputedStyle(collection).rowGap)||0;
    next={size:Math.max(1,Math.floor((available+gap)/(slot+gap))),height:Math.max(slot,available)};
   }
   setViewport(previous=>previous.size===next.size&&Math.abs(previous.height-next.height)<.5?previous:next);
  };
  const observer=new ResizeObserver(update);
  for(const target of [element,main,footer,pager.current].filter(Boolean))observer.observe(target);
  window.addEventListener('resize',update);update();
  return()=>{observer.disconnect();window.removeEventListener('resize',update);};
 },[fitViewport,table,pageSize,label,resetKey,rows.length]);
 // On resize, keep the first visible site within the newly sized page.
 const previousSize=useRef(size);
 useLayoutEffect(()=>{if(previousSize.current!==size){const oldSize=previousSize.current;setPage(current=>Math.floor((current-1)*oldSize/size)+1);previousSize.current=size;}},[size]);
 // Reserve real collection geometry so partial pages cannot pull the controls upward.
 useLayoutEffect(()=>{
  if(!stableHeight||fitViewport)return;
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
 },[stableHeight,pageSize,label,resetKey,fitViewport]);
 useEffect(()=>setPage(1),[resetKey,label]);
 const pages=Math.max(1,Math.ceil(rows.length/size)),current=Math.min(page,pages),start=(current-1)*size;
 useEffect(()=>{if(page>pages)setPage(pages);},[page,pages]);
 const change=next=>setPage(Math.max(1,Math.min(pages,next)));
 return <div className={'paginated-list '+(stableHeight?'stable-page ':'')+((stableRequested&&!table)||gappedRequested?'gapped ':'')+(fitViewport?'viewport-page ':'')+className}>
  <div className="paged-content" style={stableHeight&&pages>1?{'--page-height':(fitViewport?viewport.height:reservedHeight)+'px'}:undefined}><div className="paged-measure" ref={measure}>{children(rows.slice(start,start+size))}</div></div>
  {(pages>1||fitViewport)&&<div ref={pager} className={'pagination'+(pages===1?' pagination-probe':'')} role={pages>1?'group':undefined} aria-hidden={pages===1?true:undefined} inert={pages===1?true:undefined} aria-label={label+' pagination'}>
   <span className="pagination-count" role="status" aria-live="polite">{start+1}-{Math.min(start+size,rows.length)} of {rows.length}</span>
   <div className="pagination-controls">
    <button type="button" aria-label={label+' previous page'} disabled={current===1} onClick={()=>change(current-1)}><ChevronLeft size={18}/><span>Previous</span></button>
    <span className="pagination-page" aria-label={label+' page'}>Page {current} of {pages}</span>
    <button type="button" aria-label={label+' next page'} disabled={current===pages} onClick={()=>change(current+1)}><span>Next</span><ChevronRight size={18}/></button>
   </div>
  </div>}
 </div>;
}
