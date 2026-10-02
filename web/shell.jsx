import React,{useEffect,useRef,useState} from 'react';
import {IconMenu2,IconX,IconAdjustments,IconSearch,IconSettings,IconBell,IconLogout,IconDatabase,IconChevronRight} from '@tabler/icons-react';
import {Brand,BrandIcon} from './brand.jsx';
import './shell.css';

export function BerryShell({route,navigate,routes,user,active,storage,bytes,onLogout,onRefresh,children}){
 const [collapsed,setCollapsed]=useState(()=>localStorage.getItem('docknest-sidebar')==='collapsed'),[mobile,setMobile]=useState(false),[customizer,setCustomizer]=useState(false),[notifications,setNotifications]=useState(false),[search,setSearch]=useState('');
 const drawer=useRef(null),label=user?.name||user?.email||'Administrator';
 useEffect(()=>{localStorage.setItem('docknest-sidebar',collapsed?'collapsed':'expanded')},[collapsed]);
 useEffect(()=>{if(customizer)drawer.current?.showModal();else drawer.current?.close()},[customizer]);
 useEffect(()=>{const close=e=>{if(e.key==='Escape'){setMobile(false);setNotifications(false)}};addEventListener('keydown',close);return()=>removeEventListener('keydown',close)},[]);
 function go(next){navigate(next);setMobile(false);setSearch('')}
 const matches=routes.filter(([name])=>name.toLowerCase().includes(search.toLowerCase()));
 const percent=storage?.total?Math.min(100,Math.round((storage.used||0)/storage.total*100)):0;
 return <div className={'berry-shell '+(collapsed?'collapsed ':'')+(mobile?'mobile-open':'')}>
  <header className="berry-header">
   <button className="brand brand-button" aria-label="DockNest home" onClick={()=>go('Overview')}><Brand/></button>
   <button className="berry-menu" aria-label="Toggle navigation" aria-expanded={innerWidth<900?mobile:!collapsed} onClick={()=>{if(innerWidth<900)setMobile(!mobile);else setCollapsed(!collapsed)}}><IconMenu2 size={20}/></button>
   <div className="berry-global-search"><IconSearch size={18}/><input aria-label="Search pages" placeholder="Search" value={search} onChange={e=>setSearch(e.target.value)}/><button aria-label="Open design preferences" onClick={()=>setCustomizer(true)}><IconAdjustments size={18}/></button>{search&&<div className="berry-search-results" role="listbox" aria-label="Matching pages">{matches.length?matches.map(([name])=><button key={name} onClick={()=>go(name)}>{name}<IconChevronRight size={16}/></button>):<span>No matching pages</span>}</div>}</div>
   <div className="berry-header-tools"><button className="icon" aria-label="Refresh dashboard" onClick={onRefresh}><BrandIcon name="refresh" size={20}/></button><div className="berry-notifications"><button className="berry-bell" aria-label="Active job notifications" aria-expanded={notifications} onClick={()=>setNotifications(!notifications)}><IconBell size={20}/>{active.length>0&&<i/>}</button>{notifications&&<section className="berry-popover"><header><h2>Active jobs</h2><button className="icon" aria-label="Close notifications" onClick={()=>setNotifications(false)}><IconX size={16}/></button></header>{active.length?active.slice(0,5).map(job=><p key={job.id}>{job.type==='restore'?'Restore':'Backup'} <b>{job.status}</b></p>):<p>No jobs running right now.</p>}<button className="text" onClick={()=>{go('Jobs');setNotifications(false)}}>View job activity <IconChevronRight size={16}/></button></section>}</div><button className="berry-profile" aria-label="Open account preferences" title={label} onClick={()=>setCustomizer(true)}><span className="avatar">{label[0].toUpperCase()}</span><IconSettings size={22}/></button><button className="icon berry-logout" aria-label="Sign out" onClick={onLogout}><IconLogout size={20}/></button></div>
  </header>
  {mobile&&<button className="berry-nav-backdrop" aria-label="Close navigation" onClick={()=>setMobile(false)}/>}
  <aside className="berry-sidebar" aria-label="Primary navigation">
   <nav aria-label="Main navigation">{[['Dashboard',['Overview']],['Infrastructure',['Servers','Sites & schedules','Backups']],['Operations',['Jobs','Maintenance','Audit']],['Administration',['Storage','Access']]].map(([group,names])=>{
    const items=routes.filter(([name])=>names.includes(name));return items.length?<div className="berry-nav-group" key={group}><h2>{group}</h2>{items.map(([name])=><button key={name} aria-label={name} title={collapsed?name:undefined} aria-current={route===name?'page':undefined} className={route===name?'selected':''} onClick={()=>go(name)}><BrandIcon name={{Overview:'overview',Servers:'server','Sites & schedules':'sites',Backups:'backups',Jobs:'jobs',Maintenance:'maintenance',Audit:'audit',Storage:'storage',Access:'access'}[name]} size={20}/><span>{name==='Overview'?'Dashboard':name==='Sites & schedules'?'Sites & schedules':name}</span>{name==='Jobs'&&active.length>0&&<span className="count">{active.length}</span>}</button>)}</div>:null;
   })}</nav>
   <div className="berry-sidebar-storage"><div><span className="berry-storage-icon"><IconDatabase size={24}/></span><span><b>Backup storage</b><small>{bytes(storage?.used)}{storage?.total?' / '+bytes(storage.total):''}</small></span></div><p><span>{storage?.total?'Capacity used':'Capacity not reported'}</span><b>{storage?.total?percent+'%':'\u2014'}</b></p><progress aria-label="Sidebar storage used" value={percent} max={100}/></div>
   <span className="berry-version">DockNest</span>
  </aside>
  <div className="workspace">{children}</div>
  <button className="berry-customize" aria-label="Customize appearance" onClick={()=>setCustomizer(true)}><IconSettings size={24}/></button>
  <dialog className="berry-customizer" ref={drawer} aria-labelledby="customizer-title" onCancel={()=>setCustomizer(false)} onClick={e=>{if(e.target===drawer.current)setCustomizer(false)}}><header><h2 id="customizer-title">Design preferences</h2><button className="icon" aria-label="Close preferences" onClick={()=>setCustomizer(false)}><IconX size={20}/></button></header><section><h3>NAVIGATION</h3><button onClick={()=>setCollapsed(!collapsed)}>{collapsed?'Expand sidebar':'Collapse sidebar'}</button></section><section><h3>DESIGN SYSTEM</h3><p>Light presentation, Roboto typography, 8 px surfaces, purple and blue accents. Motion follows your device's reduced motion setting.</p></section><section><h3>ACCOUNT</h3><p>{label}</p><small>{user?.role==='admin'?'Administrator':'Operator'}</small><button onClick={onLogout}><IconLogout size={18}/> End session</button></section></dialog>
 </div>;
}
