import React,{createContext,useContext,useEffect,useMemo,useRef,useState} from 'react';
import {IconBrandGithub,IconExternalLink,IconCircleCheck,IconShieldCheck,IconMinus,IconAlertCircle,IconX,IconCopy,IconCheck} from '@tabler/icons-react';
import {createPortal} from 'react-dom';
import {excerptFrom} from './redact.js';
import {createFactsLoader,reportAllowed} from './access.js';
import './report.css';

// Who is signed in and the coarse install facts every report adds (docs/update-center.md section 13). The values are
// read when a review dialog opens: /api/version for everyone, the Update Center state (install mode, coarse
// environment) for administrators. Nothing about a report itself is ever sent to DockNest's server.
const ReportContext=createContext({role:null,load:async()=>({})});
export function ReportProvider({api,user,children}){
 const role=user?.role||null,userId=user?.id??null;
 // A new cache per signed-in user and role: facts loaded for one session are never reused by another.
 const value=useMemo(()=>({role,load:createFactsLoader({api,role})}),[api,role,userId]);
 return <ReportContext.Provider value={value}>{children}</ReportContext.Provider>;
}
export const useReportContext=()=>useContext(ReportContext);

const NEVER=['Server and site names','Addresses, domains and ports','Paths, buckets and file names','User names and emails','Error text, logs and keys','Backup contents'];
export const PUBLIC_WARNING='Issues on the DockNest repository are public and linked to your GitHub account. Anyone can read what you share.';

// The review dialog: the exact title and values that will be sent, then GitHub in a new tab (no opener, no referrer).
export function ReviewDialog({build,facts,summary,excerptSource,excerptLabel='Include the last error lines',onClose}){
 const ref=useRef(null),opener=useRef(null),titleId=useRef('rp-'+Math.random().toString(36).slice(2,8)).current;
 const [includeEnvironment,setIncludeEnvironment]=useState(true),[withExcerpt,setWithExcerpt]=useState(false);
 const initialExcerpt=useMemo(()=>excerptSource?excerptFrom(excerptSource):'',[excerptSource]);
 const [excerpt,setExcerpt]=useState(initialExcerpt),[copied,setCopied]=useState('');
 useEffect(()=>{opener.current=document.activeElement;const d=ref.current;try{d.showModal()}catch{d.setAttribute('open','')}return()=>{try{d.close()}catch{}const el=opener.current;if(el&&document.contains(el))el.focus()}},[]);
 const report=useMemo(()=>{try{return build(facts,{includeEnvironment,excerpt:withExcerpt?excerpt:undefined})}catch{return null}},[build,facts,includeEnvironment,withExcerpt,excerpt]);
 async function copyExcerpt(){try{await navigator.clipboard.writeText(report?.excerpt||'');setCopied('Excerpt copied. Paste it into the issue on GitHub.')}catch{setCopied('Could not copy. Select the text and copy it by hand.')}}
 const hasEnvironment=report?.environment?.length>0;
 return <dialog ref={ref} className="rp-dialog" aria-labelledby={titleId} onCancel={e=>{e.preventDefault();onClose()}} onClick={e=>{if(e.target===ref.current)onClose()}}>
  <div className="rp-grabber" aria-hidden="true"/>
  <header className="rp-head">
   <div className="rp-head-row"><div className="rp-head-text"><h2 id={titleId}>Review what will be shared</h2><p>{summary?summary+' · ':''}The report opens on GitHub, where you add your own words.</p></div>
    <button type="button" className="icon-button rp-close" aria-label="Close review" title="Close review" onClick={onClose}><IconX size={20} stroke={1.75} aria-hidden="true"/></button></div>
   <ol className="rp-steps" aria-label="Steps"><li aria-current="step"><span className="rp-step-bar"/><span><span className="rp-wide">1  Review here</span><span className="rp-narrow">Review</span></span></li><li><span className="rp-step-bar"/><span><span className="rp-wide">2  Open GitHub</span><span className="rp-narrow">Open GitHub</span></span></li><li><span className="rp-step-bar"/><span><span className="rp-wide">3  Describe and submit there</span><span className="rp-narrow">Submit there</span></span></li></ol>
  </header>
  <div className="rp-main"><div className="rp-body">
   <section className="rp-shared" aria-labelledby={titleId+'-shared'}>
    <h3 id={titleId+'-shared'}><IconCircleCheck size={18} stroke={2} className="rp-ok" aria-hidden="true"/>Shared</h3>
    {report?<dl className="def-list rp-list">{report.shared.map(([k,v])=><div className="def-row" key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>:<p role="alert">This report could not be prepared.</p>}
    {report?.timeline?.length>0&&<div className="rp-timeline"><span className="t-caption">Timeline: phase, seconds from start, seconds taken</span><span className="rp-timeline-line">{report.timeline.join(' · ')}</span></div>}
    {hasEnvironment&&<label className="rp-check"><input type="checkbox" checked={includeEnvironment} onChange={e=>setIncludeEnvironment(e.target.checked)}/><span><span className="rp-check-title">Include environment</span><span className="t-caption">{report.environment.map(([k,v])=>k+' '+v).join(' · ')}</span></span></label>}
    {excerptSource&&initialExcerpt&&<><label className="rp-check"><input type="checkbox" checked={withExcerpt} onChange={e=>{setWithExcerpt(e.target.checked);setCopied('')}}/><span><span className="rp-check-title">{excerptLabel}</span><span className="t-caption">Off by default. Addresses, paths, names and keys are replaced with [redacted]; you can edit the text before sharing.</span></span></label>
     {withExcerpt&&<div className="rp-excerpt"><label htmlFor={titleId+'-excerpt'} className="t-caption">Error lines (at most 40 lines, 2 KiB)</label><textarea id={titleId+'-excerpt'} rows={6} value={excerpt} onChange={e=>setExcerpt(e.target.value)} spellCheck={false}/><p className="t-caption rp-warn-text">This may still contain private text. Read it before sharing.</p>
      {report?.excerptTooLong&&<div className="rp-copy"><p className="t-caption">The excerpt does not fit in the GitHub link. Copy it and paste it into the issue by hand.</p><button type="button" onClick={copyExcerpt}>{copied.startsWith('Excerpt')?<IconCheck size={18} aria-hidden="true"/>:<IconCopy size={18} aria-hidden="true"/>}Copy excerpt</button>{copied&&<span className="t-caption" role="status">{copied}</span>}</div>}</div>}</>}
   </section>
   <section className="rp-never" aria-labelledby={titleId+'-never'}>
    <h3 id={titleId+'-never'}><IconShieldCheck size={18} stroke={2} aria-hidden="true"/>Never shared</h3>
    <ul className="rp-never-list">{NEVER.map(t=><li key={t}><IconMinus size={16} stroke={2} aria-hidden="true"/>{t}</li>)}</ul>
    <p className="rp-never-line"><IconShieldCheck size={16} stroke={2} aria-hidden="true"/><span>Never shared: names, addresses, paths, user names, error text, logs, keys or backup contents.</span></p>
    <p className="t-caption rp-server-note">DockNest{'’'}s server sends nothing. Your browser opens a pre-filled GitHub form; nothing is posted until you submit it there.</p>
   </section>
  </div>
  <div className="rp-note" role="note"><IconAlertCircle size={20} stroke={2} aria-hidden="true"/><span>{PUBLIC_WARNING}</span></div></div>
  <footer className="rp-foot">
   <button type="button" onClick={onClose}>Cancel</button>
   {report?<a className="button primary rp-open" href={report.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={()=>setTimeout(onClose,0)}><IconBrandGithub size={18} stroke={1.75} aria-hidden="true"/>Open GitHub<IconExternalLink size={16} stroke={2} aria-hidden="true"/><span className="sr-only"> (opens a new tab)</span></a>:<button type="button" className="primary" disabled><IconBrandGithub size={18} stroke={1.75} aria-hidden="true"/>Open GitHub</button>}
  </footer>
 </dialog>;
}

// The report button. audience "all" is only for Report a bug in About; every other report is admin-only.
export function ReportProblem({build,label='Open GitHub',summary,audience='admin',role,excerptSource,excerptLabel,className=''}){
 const ctx=useReportContext();
 const [open,setOpen]=useState(false),[facts,setFacts]=useState(null);
 if(!reportAllowed(role,ctx.role,audience))return null;
 async function start(){const f=await ctx.load().catch(()=>({}));setFacts(f||{});setOpen(true)}
 return <>
  <button type="button" className={('rp-button '+className).trim()} onClick={start} aria-haspopup="dialog">{label==='Open GitHub'&&<IconBrandGithub size={18} stroke={1.75} aria-hidden="true"/>}{label}</button>
  {open&&facts&&createPortal(<ReviewDialog build={build} facts={facts} summary={summary} excerptSource={excerptSource} excerptLabel={excerptLabel} onClose={()=>setOpen(false)}/>,document.body)}
 </>;
}
