import React,{useEffect,useId,useRef,useState} from 'react';
import {IconDots} from '@tabler/icons-react';
import {statusState} from './status-state.js';
import {CheckCircle2,Loader,Clock,Hourglass,CircleX,TriangleAlert,InfoCircle} from './icons.jsx';

// 2.3.0 shared primitives. Styles live in system.css (.status, .alert-panel, .icon-button).
const STATES={
 success:{Icon:CheckCircle2,label:'Succeeded'},
 running:{Icon:Loader,label:'Running'},
 queued:{Icon:Clock,label:'Queued'},
 pending:{Icon:Hourglass,label:'Pending'},
 failed:{Icon:CircleX,label:'Failed'},
 'needs-review':{Icon:TriangleAlert,label:'Needs review'}
};
export {statusState};
const humanise=v=>{const t=String(v).replace(/[_-]+/g,' ').trim();return t.charAt(0).toUpperCase()+t.slice(1)};
// value: any status string (shown humanised); state: force one of success|running|queued|pending|failed|needs-review.
export function StatusLabel({value,state,children}){
 const s=state||statusState(value),{Icon}=STATES[s]||STATES.queued;
 const text=children||(value?humanise(value):'Unknown');
 return <span className={'status status-'+s}><Icon className="status-icon" size={16} stroke={2} aria-hidden="true"/>{text}</span>;
}

const ALERT_ICON={error:CircleX,warning:TriangleAlert,info:InfoCircle};
// variant: error|warning|info. action: optional node, e.g. <a href="#">Open job</a>.
export function AlertPanel({variant='error',title,children,action}){
 const Icon=ALERT_ICON[variant]||CircleX;
 return <div className={'alert-panel alert-'+variant} role={variant==='info'?'status':'alert'}><Icon className="alert-panel-icon" size={20} stroke={2} aria-hidden="true"/><div className="alert-panel-body">{title&&<b>{title}</b>}{children&&<span>{children}</span>}{action}</div></div>;
}

// Frameless 40x40 icon button. label is required (aria-label and tooltip).
export function IconButton({label,icon:Icon,size=20,className='',...rest}){
 return <button type="button" className={('icon-button '+className).trim()} aria-label={label} title={label} {...rest}><Icon size={size} stroke={1.75} aria-hidden="true"/></button>;
}

// Overflow menu for the secondary actions of a row. items: [{label, icon, onSelect, disabled}]. Arrow keys, Home and End
// move, Escape and a press outside close it, and focus returns to the trigger. Uncontrolled by default; pass open and
// onOpenChange when a row opens it from elsewhere. The list opens upward when it would be clipped below (last row of a
// dialog or table). A press inside the parent row is left to the row, so its click can toggle the menu.
export function OverflowMenu({label,items,disabled,open:controlled,onOpenChange}){
 const [inner,setInner]=useState(false),open=controlled??inner,setOpen=value=>{setInner(value);onOpenChange?.(value)};
 const root=useRef(null),trigger=useRef(null),list=useRef(null),id=useId(),[up,setUp]=useState(false);
 const enabled=()=>[...(list.current?.querySelectorAll('[role=menuitem]:not(:disabled)')||[])];
 useEffect(()=>{
  if(!open)return;
  const away=e=>{if(!(root.current?.parentElement||root.current)?.contains(e.target))setOpen(false)};
  document.addEventListener('pointerdown',away);
  const box=list.current.getBoundingClientRect(),clip=root.current.closest('dialog,.table-wrap')?.getBoundingClientRect(),limit=Math.min(innerHeight,clip?clip.bottom:innerHeight);
  setUp(box.bottom>limit&&root.current.getBoundingClientRect().top-box.height>(clip?clip.top:0));
  enabled()[0]?.focus();
  return()=>document.removeEventListener('pointerdown',away);
 },[open]);
 const key=e=>{
  const all=enabled(),at=all.indexOf(document.activeElement);
  if(e.key==='Escape'){e.stopPropagation();e.preventDefault();setOpen(false);trigger.current?.focus();}
  else if(e.key==='ArrowDown'){e.preventDefault();all[(at+1)%all.length]?.focus();}
  else if(e.key==='ArrowUp'){e.preventDefault();all[(at-1+all.length)%all.length]?.focus();}
  else if(e.key==='Home'){e.preventDefault();all[0]?.focus();}
  else if(e.key==='End'){e.preventDefault();all.at(-1)?.focus();}
  else if(e.key==='Tab')setOpen(false);
 };
 return <span className="overflow-menu" ref={root} onKeyDown={open?key:undefined}>
  <button type="button" ref={trigger} className="icon-button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open?id:undefined} disabled={disabled} onClick={()=>setOpen(!open)} onKeyDown={e=>{if(e.key==='ArrowDown'&&!open){e.preventDefault();setOpen(true)}}}><IconDots size={20} stroke={1.75} aria-hidden="true"/></button>
  {open&&<div className={'overflow-menu-list'+(up?' up':'')} role="menu" id={id} aria-label={label} ref={list}>{items.map(({label:text,icon:Icon,onSelect,disabled:off})=><button type="button" role="menuitem" key={text} disabled={off} onClick={()=>{setOpen(false);trigger.current?.focus();onSelect();}}>{Icon&&<Icon size={18} stroke={1.75} aria-hidden="true"/>}{text}</button>)}</div>}
 </span>;
}
