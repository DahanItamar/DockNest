import React,{useEffect,useId,useRef,useState} from 'react';
import {IconDots,IconChevronRight} from '@tabler/icons-react';
import {statusState} from './status-state.js';
import {CheckCircle2,Loader,Clock,Hourglass,CircleX,TriangleAlert,InfoCircle} from './icons.jsx';
import {IconCheck,IconX} from '@tabler/icons-react';

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
export function StatusLabel({value,state,children,icon}){
 const s=state||statusState(value),Icon=icon||(STATES[s]||STATES.queued).Icon;
 const text=children||(value?humanise(value):'Unknown');
 return <span className={'status status-'+s}><Icon className="status-icon" size={16} stroke={2} aria-hidden="true"/>{text}</span>;
}

const ALERT_ICON={error:CircleX,warning:TriangleAlert,info:InfoCircle,success:CheckCircle2};
// variant: error|warning|info|success. action: optional node, e.g. <a href="#">Open job</a>.
export function AlertPanel({variant='error',title,children,action,onDismiss,dismissLabel='Dismiss message'}){
 const Icon=ALERT_ICON[variant]||CircleX;
 return <div className={'alert-panel alert-'+variant} role={variant==='info'||variant==='success'?'status':'alert'}><Icon className="alert-panel-icon" size={20} stroke={2} aria-hidden="true"/><div className="alert-panel-body">{title&&<b>{title}</b>}{children&&<span>{children}</span>}{action}</div>{onDismiss&&<button type="button" className="icon alert-panel-close" onClick={onDismiss} aria-label={dismissLabel}><IconX size={16} aria-hidden="true"/></button>}</div>;
}

// One step indicator for wizards. Desktop: numbered steps, completed ones show the check icon. Phones: "Step 2 of 4 - Name".
export function Stepper({steps,current,label}){
 return <nav className="stepper" aria-label={label}>
  <ol className="stepper-list">{steps.map((name,i)=><li key={name} className="stepper-step" data-state={i<current?'done':i===current?'current':'todo'} aria-current={i===current?'step':undefined}><span className="stepper-mark" aria-hidden="true">{i<current?<IconCheck size={14} stroke={2.5}/>:i+1}</span><span className="stepper-name">{name}{i<current&&<span className="sr-only"> (done)</span>}</span></li>)}</ol>
  <p className="stepper-compact" aria-hidden="true">Step {current+1} of {steps.length} - {steps[current]}</p>
 </nav>;
}

// Frameless 40x40 icon button. label is required (aria-label and tooltip).
export function IconButton({label,icon:Icon,size=20,className='',...rest}){
 return <button type="button" className={('icon-button '+className).trim()} aria-label={label} title={label} {...rest}><Icon size={size} stroke={1.75} aria-hidden="true"/></button>;
}

// Overflow menu for the secondary actions of a row. items: [{label, name (optional accessible name), icon, onSelect, disabled}]. Arrow keys, Home and End
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
  <button type="button" ref={trigger} className="icon-button small" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open?id:undefined} disabled={disabled} onClick={()=>setOpen(!open)} onKeyDown={e=>{if(e.key==='ArrowDown'&&!open){e.preventDefault();setOpen(true)}}}><IconDots size={20} stroke={2} aria-hidden="true"/></button>
  {open&&<div className={'overflow-menu-list'+(up?' up':'')} role="menu" id={id} aria-label={label} ref={list}>{items.map(({label:text,name,icon:Icon,onSelect,disabled:off})=><button type="button" role="menuitem" key={text} aria-label={name} disabled={off} onClick={()=>{setOpen(false);trigger.current?.focus();onSelect();}}>{Icon&&<Icon size={18} stroke={1.75} aria-hidden="true"/>}{text}</button>)}</div>}
 </span>;
}

// List row head (design system v2, section 4): the whole head is one button that opens details, with a trailing chevron.
// Put the status, caption or any other plain content inside as children; actions live beside it, never inside it.
export function RowOpen({label,onClick,icon:Icon,chip=false,className='',children,...rest}){
 return <button type="button" className={('row-open '+className).trim()} aria-label={label} onClick={onClick} {...rest}>{Icon&&<span className={chip?'icon-chip':'row-open-icon'}><Icon size={chip?20:18} stroke={1.75} aria-hidden="true"/></span>}<span className="row-open-text">{children}</span><IconChevronRight className="row-open-chevron" size={18} stroke={1.75} aria-hidden="true"/></button>;
}

// One empty, loading or error state for every list and page: icon, title, one sentence, one primary action.
// tone: 'empty' (default) | 'error' | 'loading' (the icon becomes the spinner).
export function EmptyState({icon:Icon,title,children,action,tone='empty',className=''}){
 const Glyph=tone==='loading'?Loader:Icon;
 return <div className={('empty-state '+(tone!=='empty'?'is-'+tone+' ':'')+className).trim()} role={tone==='error'?'alert':tone==='loading'?'status':undefined}><span className="empty-state-icon">{Glyph&&<Glyph size={24} stroke={1.75} aria-hidden="true"/>}</span><h3>{title}</h3>{children&&<p>{children}</p>}{action}</div>;
}
