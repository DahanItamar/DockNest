import React,{useEffect,useRef} from 'react';
import {Brand} from './brand.jsx';
import './status-page.css';

// Status page (404, 403, 401, 500): a standalone full-screen page with a large decorative code that fades out, one
// sentence and up to two actions. The code is aria-hidden; title is the real heading (visually hidden) and the
// document title. level: 1 for a page, 2 when shown over an existing page (the error screen).
export function StatusPage({code,title,children,actions,level=1,footnote,className='',...rest}){
 const H=level===2?'h2':'h1',id='status-title-'+code,ref=useRef(null);
 useEffect(()=>{
  const previous=document.title;document.title=title+' · DockNest';
  // Focus lands on the page itself (never on a button), so a screen reader starts at the heading.
  ref.current?.focus({preventScroll:true});
  return()=>{document.title=previous};
 },[title]);
 return <div className={('status-screen '+className).trim()}>
  <div className="status-brand" aria-hidden="true"><Brand/></div>
  <section ref={ref} tabIndex={-1} className="status-page" aria-labelledby={id} data-status={code} {...rest}>
   <p className="status-code" aria-hidden="true">{code}</p>
   <H id={id} className="status-title">{title}</H>
   <p className="status-text">{children}</p>
   {actions&&<div className="status-actions">{actions}</div>}
   {footnote&&<p className="t-caption status-note">{footnote}</p>}
  </section>
 </div>;
}
