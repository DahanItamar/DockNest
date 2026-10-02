import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {IconDatabase} from '@tabler/icons-react';

export function CompactStorage({storage,bytes,active}){
 const [open,setOpen]=useState(false),[position,setPosition]=useState(0),anchor=useRef(null),timer=useRef(null);
 const known=storage?.total>0,used=storage?.used||0,percent=known?Math.min(100,Math.round(used/storage.total*100)):null;
 function show(){clearTimeout(timer.current);setPosition(Math.max(96,Math.min(innerHeight-180,anchor.current.getBoundingClientRect().top-32)));setOpen(true)}
 function hide(){timer.current=setTimeout(()=>setOpen(false),120)}
 useEffect(()=>{const dismiss=e=>{if(e.key==='Escape')setOpen(false)},close=()=>setOpen(false);addEventListener('keydown',dismiss);addEventListener('resize',close);return()=>{clearTimeout(timer.current);removeEventListener('keydown',dismiss);removeEventListener('resize',close)}},[]);
 useEffect(()=>{if(!active)setOpen(false)},[active]);
 return <div className="compact-storage" onMouseEnter={show} onMouseLeave={hide}>
  <button ref={anchor} type="button" className="compact-storage-button" aria-label={`Backup storage: ${bytes(used)} stored${known?`, ${percent}% of ${bytes(storage.total)}`:', capacity not reported'}`} aria-expanded={open} aria-controls="compact-storage-details" onFocus={show} onBlur={hide} onClick={()=>open?setOpen(false):show()}>
   <span className="storage-orbit"><svg viewBox="0 0 44 44" aria-hidden="true"><circle className="storage-orbit-track" cx="22" cy="22" r="19"/><circle className="storage-orbit-used" cx="22" cy="22" r="19" pathLength="100" strokeDasharray={`${percent??0} 100`}/></svg><IconDatabase size={20}/></span>
   <b>{bytes(used)}</b><small>{known?'/ '+bytes(storage.total):'Stored'}</small>
  </button>
  {open&&createPortal(<section id="compact-storage-details" className="compact-storage-details" style={{top:position}} onMouseEnter={()=>clearTimeout(timer.current)} onMouseLeave={hide} aria-label="Backup storage details"><h2>Backup storage</h2><p><strong>{bytes(used)}</strong> stored</p><dl><div><dt>Total capacity</dt><dd>{known?bytes(storage.total):'Not reported'}</dd></div><div><dt>Available</dt><dd>{known?bytes(Math.max(0,storage.total-used)):'Not reported'}</dd></div></dl>{known&&<progress aria-label="Storage capacity used" value={percent} max={100}/>}</section>,document.body)}
 </div>;
}
