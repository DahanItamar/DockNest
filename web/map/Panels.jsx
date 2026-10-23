import React,{useEffect,useMemo,useRef,useState} from 'react';
import {IconX,IconSearch,IconChevronRight,IconRefresh,IconServer,IconDatabaseExport,IconBox,IconAppWindow,IconInfoCircle,IconBrandTelegram,IconMail} from '@tabler/icons-react';
import {IconButton} from '../system.jsx';
import {count} from '../plural.js';
import {containerName,containerGroups} from '../container-groups.js';
import {Sheet,Note} from './MoveFlow.jsx';

// One panel at a time, on the right. Same size every time, footer pinned, content scrolls. Escape or Close closes it and
// focus goes back to what opened it (the page does that). On a phone the same panel is a full-screen sheet.
export function SidePanel({title,labelId,narrow,onClose,footer,children}){
 const head=useRef(null);
 useEffect(()=>{if(!narrow)head.current?.focus()},[narrow,title]);
 if(narrow)return <Sheet title={title} labelId={labelId} onClose={onClose} actions={<div className="map-panel-foot">{footer||<span/>}</div>}>
  <span className="map-sheet-close"><IconButton label="Close" icon={IconX} onClick={onClose}/></span>{children}</Sheet>;
 return <aside className="map-panel" aria-labelledby={labelId} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();onClose()}}}>
  <div className="map-panel-head"><h2 id={labelId} ref={head} tabIndex={-1}>{title}</h2><IconButton label="Close" icon={IconX} onClick={onClose}/></div>
  <div className="map-panel-body">{children}</div>
  <div className="map-panel-foot">{footer||<span/>}</div>
 </aside>;
}

export const Search=({value,onChange,label='Search'})=><label className="map-search"><IconSearch size={18} stroke={1.75} aria-hidden="true"/><input type="search" aria-label={label} placeholder="Search" value={value} onChange={e=>onChange(e.target.value)}/></label>;
const Row=({icon:Icon,title,caption,onClick})=><li><button type="button" className="map-row" onClick={onClick}><Icon size={24} stroke={1.5} aria-hidden="true"/><span><b className="map-name">{title}</b><span className="map-caption">{caption}</span></span><IconChevronRight size={18} stroke={1.75} aria-hidden="true"/></button></li>;

// "+" at the top right: adds a server or backup storage with the existing screens.
export function AddToMap({onAddServer,onAddStorage,onAddAlert}){
 const [q,setQ]=useState('');
 const rows=[{id:'server',icon:IconServer,title:'Server',caption:'Connect another server by SSH',go:onAddServer},{id:'storage',icon:IconDatabaseExport,title:'Backup storage',caption:'A place to keep backups',go:onAddStorage},
  ...(onAddAlert?[{id:'telegram',icon:IconBrandTelegram,title:'Telegram alerts',caption:'Messages in a Telegram chat',go:()=>onAddAlert('telegram')},{id:'email',icon:IconMail,title:'Email alerts',caption:'Messages by email',go:()=>onAddAlert('email')}]:[])].filter(r=>(r.title+' '+r.caption).toLowerCase().includes(q.trim().toLowerCase()));
 return <>
  <Search value={q} onChange={setQ}/>
  <h3 className="map-group-title">Add</h3>
  {rows.length?<ul className="map-rows">{rows.map(r=><Row key={r.id} icon={r.icon} title={r.title} caption={r.caption} onClick={r.go}/>)}</ul>:<p className="map-caption" role="status">Nothing matches this search.</p>}
 </>;
}

// Sites found on a server by the existing discovery, minus the ones already added.
export function useDiscovery(api,server,sites){
 const [state,setState]=useState({loading:true,error:'',containers:[],statics:[]}),[run,setRun]=useState(0);
 useEffect(()=>{
  let live=true;setState(s=>({...s,loading:true,error:''}));
  api('/servers/'+encodeURIComponent(server.id)+'/discover').then(r=>{if(live)setState({loading:false,error:'',containers:(r.containers||[]).filter(c=>containerName(c)),statics:r.staticSites||[]})})
   .catch(e=>{if(live)setState(s=>({...s,loading:false,error:e.message||'Could not look for sites on this server.'}))});
  return()=>{live=false};
 },[api,server.id,run]);
 const choices=useMemo(()=>{
  const have=new Set(sites.filter(s=>s.serverId===server.id).flatMap(s=>s.config?.containers||[])),roots=new Set(sites.filter(s=>s.serverId===server.id).map(s=>s.config?.documentRoot).filter(Boolean));
  const all=[...state.statics.map(s=>({id:'static:'+s.documentRoot,name:s.name||s.documentRoot,kind:'static',containers:[]})),
   ...containerGroups(state.containers).flatMap(g=>g.kind==='standalone'?g.containers.map(c=>({id:'container:'+containerName(c),name:containerName(c),kind:'container',containers:[c]})):[g])];
  return all.filter(c=>c.kind==='static'?!roots.has(c.id.slice(7)):!c.containers.every(x=>have.has(containerName(x))));
 },[state,sites,server.id]);
 return {...state,choices,again:()=>setRun(n=>n+1)};
}
export function AddToServer({found,onPick}){
 const [q,setQ]=useState('');
 const rows=found.choices.filter(c=>c.name.toLowerCase().includes(q.trim().toLowerCase()));
 return <>
  <Search value={q} onChange={setQ}/>
  <h3 className="map-group-title">Found on this server ({found.choices.length})</h3>
  <div role="status" aria-live="polite">{found.loading&&<p className="map-caption">Looking for sites{'…'}</p>}{found.error&&<Note kind="error" icon={IconInfoCircle}>{found.error}</Note>}
   {!found.loading&&!found.error&&!found.choices.length&&<p className="map-caption">No sites left to add on this server.</p>}
   {!found.loading&&found.choices.length>0&&!rows.length&&<p className="map-caption">Nothing matches this search.</p>}</div>
  {rows.length>0&&<ul className="map-rows">{rows.map(c=><Row key={c.id} icon={c.kind==='static'?IconAppWindow:IconBox} title={c.name} caption={c.kind==='static'?'nginx site · static files':'Docker · '+count(c.containers.length,'container')} onClick={()=>onPick(c)}/>)}</ul>}
 </>;
}
export const DiscoverFooter=({found})=><><span className="map-caption">Not listed?</span><button type="button" className="map-link" disabled={found.loading} onClick={found.again}><IconRefresh size={18} stroke={1.75} aria-hidden="true"/>Discover again</button></>;

export const Defs=({rows})=><dl className="map-defs">{rows.filter(Boolean).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
