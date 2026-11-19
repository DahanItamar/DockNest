import React,{useEffect,useRef} from 'react';
import {IconDots} from '@tabler/icons-react';
import {statusState} from './status-state.js';
import {CheckCircle2,Loader,Clock,CircleX,TriangleAlert,InfoCircle} from './icons.jsx';

// 2.3.0 shared primitives. Styles live in system.css (.status, .alert-panel, .icon-button).
const STATES={
 success:{Icon:CheckCircle2,label:'Succeeded'},
 running:{Icon:Loader,label:'Running'},
 queued:{Icon:Clock,label:'Queued'},
 failed:{Icon:CircleX,label:'Failed'},
 'needs-review':{Icon:TriangleAlert,label:'Needs review'}
};
export {statusState};
const humanise=v=>{const t=String(v).replace(/[_-]+/g,' ').trim();return t.charAt(0).toUpperCase()+t.slice(1)};
// value: any status string (shown humanised); state: force one of success|running|queued|failed|needs-review.
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

// One overflow ("more actions") menu. items: [{label, onSelect}]. Controlled with open/onOpenChange so a row can open it
// from elsewhere. Arrow keys, Home/End and Escape work; Escape and picking an item return focus to the button.
export function OverflowMenu({label,items,open,onOpenChange}){
 const root=useRef(null),button=useRef(null),list=useRef(null);
 const focusItem=index=>{const nodes=list.current?.querySelectorAll('[role=menuitem]');if(nodes?.length)nodes[(index+nodes.length)%nodes.length].focus()};
 useEffect(()=>{
  if(!open)return;
  focusItem(0);
  const away=event=>{if(!root.current?.contains(event.target))onOpenChange(false)};
  document.addEventListener('pointerdown',away);
  return()=>document.removeEventListener('pointerdown',away);
 },[open]);
 const close=()=>{onOpenChange(false);button.current?.focus()};
 function keys(event){
  const nodes=[...list.current.querySelectorAll('[role=menuitem]')],at=nodes.indexOf(document.activeElement);
  if(event.key==='Escape'){event.preventDefault();close()}
  else if(event.key==='Tab')onOpenChange(false);
  else if(event.key==='ArrowDown'){event.preventDefault();focusItem(at+1)}
  else if(event.key==='ArrowUp'){event.preventDefault();focusItem(at-1)}
  else if(event.key==='Home'){event.preventDefault();focusItem(0)}
  else if(event.key==='End'){event.preventDefault();focusItem(-1)}
 }
 return <div className="overflow-menu" ref={root}>
  <button type="button" ref={button} className="icon-button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={()=>onOpenChange(!open)} onKeyDown={event=>{if(event.key==='ArrowDown'&&!open){event.preventDefault();onOpenChange(true)}}}><IconDots size={20} stroke={1.75} aria-hidden="true"/></button>
  {open&&<div className="overflow-list" role="menu" aria-label={label} ref={list} onKeyDown={keys}>{items.map(item=><button type="button" role="menuitem" key={item.label} onClick={()=>{onOpenChange(false);item.onSelect()}}>{item.label}</button>)}</div>}
 </div>;
}
