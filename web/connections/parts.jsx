import React,{useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {IconBrandTelegram,IconMail,IconBrandWhatsapp,IconBrandDiscord,IconBrandSlack,IconBrandTeams,IconBrandGoogle,IconMessage,IconBell,IconBellRinging,IconDeviceMobile,IconBrandMatrix,IconWebhook,IconPlugConnected,IconChevronDown,IconCheck,IconSearch,IconPlus} from '@tabler/icons-react';

// Brand marks only as the provider's own mark; everything else is a plain Tabler icon (docs/design/DESIGN.md).
const ICONS={'brand-telegram':IconBrandTelegram,mail:IconMail,'brand-whatsapp':IconBrandWhatsapp,'brand-discord':IconBrandDiscord,'brand-slack':IconBrandSlack,'brand-teams':IconBrandTeams,'brand-google':IconBrandGoogle,message:IconMessage,bell:IconBell,'bell-ringing':IconBellRinging,'device-mobile':IconDeviceMobile,'brand-matrix':IconBrandMatrix,webhook:IconWebhook};
export function ProviderIcon({icon,size=20,stroke=1.5,className='cx-ic'}){const I=ICONS[icon]||IconPlugConnected;return <I size={size} stroke={stroke} className={className} aria-hidden="true"/>}

// A dropdown that always opens downward, below its button, with an optional search and grouped options, and one action
// row at the end ("+ New connection", "+ Add custom"). The list is fixed to the viewport (so a scrolling panel never
// clips it) and only as tall as the space below; it closes on Escape, Tab, a click outside or a choice. Keyboard: Down
// opens; Up and Down move; Home and End jump; Enter chooses. No scrollbar unless the list is taller than the space.
// items: [{value,label,icon?,group?,caption?}]
export function Combo({items,value,onChange,labelledBy,disabled,placeholder='Choose…',search=false,searchLabel='Search',action,renderValue,invalid,id}){
 const own=useId(),base=id||('dn'+own.replace(/:/g,'')),[open,setOpen]=useState(false),[q,setQ]=useState(''),[box,setBox]=useState(null);
 const button=useRef(null),pop=useRef(null),input=useRef(null);
 const shown=items.filter(i=>!q.trim()||(i.label+' '+(i.caption||'')).toLowerCase().includes(q.trim().toLowerCase()));
 const current=items.find(i=>i.value===value);
 const place=()=>{const r=button.current?.getBoundingClientRect();if(!r)return;const below=innerHeight-r.bottom-16;setBox({left:r.left,top:r.bottom+8,width:r.width,maxHeight:Math.max(160,Math.min(320,below))})};
 useLayoutEffect(()=>{if(!open)return;place();const h=()=>place();addEventListener('resize',h);addEventListener('scroll',h,true);return()=>{removeEventListener('resize',h);removeEventListener('scroll',h,true)}},[open]);
 useEffect(()=>{if(!open)return;const h=e=>{if(!pop.current?.contains(e.target)&&!button.current?.contains(e.target))setOpen(false)};document.addEventListener('pointerdown',h,true);return()=>document.removeEventListener('pointerdown',h,true)},[open]);
 useEffect(()=>{if(!open){setQ('');return}setTimeout(()=>{if(search)input.current?.focus({preventScroll:true});else (pop.current?.querySelector('[aria-selected=true]')||pop.current?.querySelector('[role=option],.cx-action'))?.focus({preventScroll:true})},0)},[open]);
 const close=(back=true)=>{setOpen(false);if(back)setTimeout(()=>button.current?.focus(),0)};
 const choose=v=>{onChange(v);close()};
 const opts=()=>[...(pop.current?.querySelectorAll('[role=option],.cx-action')||[])];
 function keys(e){
  const list=opts(),at=list.indexOf(document.activeElement);
  if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close()}
  else if(e.key==='Tab'){close(false)}
  else if(e.key==='ArrowDown'){e.preventDefault();list[Math.min(list.length-1,at+1)]?.focus()}
  else if(e.key==='ArrowUp'){e.preventDefault();if(at<=0&&search)input.current?.focus();else list[Math.max(0,at-1)]?.focus()}
  else if(e.key==='Home'&&document.activeElement!==input.current){e.preventDefault();list[0]?.focus()}
  else if(e.key==='End'&&document.activeElement!==input.current){e.preventDefault();list.at(-1)?.focus()}
  else if(e.key==='Enter'&&document.activeElement===input.current){e.preventDefault();list[0]?.click()}
 }
 let group=null;
 return <div className="cx-cw">
  <button ref={button} id={base+'-b'} type="button" className={'cx-combo'+(invalid?' cx-invalid':'')} aria-haspopup="listbox" aria-expanded={open} aria-controls={open?base+'-l':undefined} aria-labelledby={(labelledBy?labelledBy+' ':'')+base+'-b'} disabled={disabled} onClick={()=>setOpen(o=>!o)} onKeyDown={e=>{if((e.key==='ArrowDown'||e.key==='Enter'||e.key===' ')&&!open){e.preventDefault();setOpen(true)}}}>
   <span className="cx-val">{renderValue?renderValue(current):current?<>{current.icon&&<ProviderIcon icon={current.icon}/>}<span>{current.label}</span></>:<span className="cx-placeholder">{placeholder}</span>}</span>
   <IconChevronDown size={18} stroke={1.5} className="cx-chev" aria-hidden="true"/>
  </button>
  {open&&box&&<div ref={pop} className="cx-pop" style={box} onKeyDown={keys}>
   {search&&<label className="cx-search"><IconSearch size={18} stroke={1.75} aria-hidden="true"/><input ref={input} type="search" autoFocus autoComplete="off" aria-label={searchLabel} aria-controls={base+'-l'} value={q} onChange={e=>setQ(e.target.value)}/></label>}
   <div id={base+'-l'} className="cx-list" role="listbox" aria-labelledby={labelledBy}>
    {shown.map(i=>{const head=i.group&&i.group!==group?(group=i.group):null;return <React.Fragment key={i.value}>
     {head&&<p className="cx-group" role="presentation">{head}</p>}
     <button type="button" role="option" tabIndex={-1} className="cx-opt" aria-selected={i.value===value} onClick={()=>choose(i.value)}>{i.icon&&<ProviderIcon icon={i.icon}/>}<span>{i.label}{i.caption&&<small className="cx-opt-cap">{i.caption}</small>}</span><IconCheck size={18} stroke={2} className="cx-tick" aria-hidden="true"/></button>
    </React.Fragment>})}
   </div>
   {!shown.length&&<p className="cx-empty" role="status">Nothing matches this search.</p>}
   {action&&<button type="button" tabIndex={-1} className="cx-opt cx-action" onClick={()=>{close(false);action.onSelect()}}><IconPlus size={18} stroke={2} aria-hidden="true"/><span>{action.label}</span></button>}
  </div>}
 </div>;
}

// The app's slim pill switch (style.css draws every role=switch): one row with its label and a short help line.
export function SwitchRow({id,label,help,checked,disabled,onChange}){
 return <div className="sb-switch-row cx-switch-row"><span className="sb-switch-text"><span id={id} className="sb-switch-label">{label}</span><span id={id+'-help'} className="t-caption">{help}</span></span><button type="button" role="switch" aria-checked={checked} aria-labelledby={id} aria-describedby={id+'-help'} disabled={disabled} onPointerDown={e=>e.preventDefault()} onClick={()=>onChange(!checked)}/></div>;
}
