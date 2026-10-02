import React,{useEffect,useState} from 'react';

export function SystemHealth({connection,worker,jobs=[]}){
 const [now,setNow]=useState(Date.now()),[started]=useState(Date.now),[online,setOnline]=useState(navigator.onLine);
 useEffect(()=>{const tick=()=>setNow(Date.now()),network=()=>{setOnline(navigator.onLine);tick();};const timer=setInterval(tick,5000);addEventListener('online',network);addEventListener('offline',network);return()=>{clearInterval(timer);removeEventListener('online',network);removeEventListener('offline',network);};},[]);
 const checking=!connection?.lastSuccess&&!connection?.failed&&now-started<15000;
 const connected=online&&!connection?.failed&&now-(connection?.lastSuccess||0)<15000;
 const workerFresh=worker?.online===true; // The API evaluates its own worker clock.
 // Old failed jobs do not keep the system in error after a later successful run.
 const latest=new Map();for(const job of jobs)if(!latest.has(job.siteId))latest.set(job.siteId,job);
 const needsReview=[...latest.values()].some(job=>['failed','recovery_required'].includes(job.status));
 const healthy=connected&&workerFresh&&!needsReview;
 const message=checking?'Checking connection':!connected?'Connection interrupted':!workerFresh?'Worker not responding':needsReview?'Job needs attention':'API & worker online';
 const title='System health: '+message+(needsReview?'. Review job activity.':'');
 const path='M0 16H46L55 10L64 24L76 3L88 29L99 13L108 16H188';
 return <div className={'system-health '+(checking?'checking':healthy?'healthy':'attention')+(!connected?' disconnected':'')} role="status" aria-live="polite" aria-label={title} title={title} tabIndex={0}>
  <div className="system-health-label"><b>System health</b><span>{message}</span></div>
  <svg className="health-wide" viewBox="0 0 188 32" aria-hidden="true"><path className="health-track" d={path} pathLength="100"/><path className="health-sweep" d={path} pathLength="100"/></svg>
  <svg className="health-compact" viewBox="0 0 40 32" aria-hidden="true"><path className="health-track" d="M2 16H9L14 9L19 26L25 4L30 16H38" pathLength="100"/><path className="health-sweep" d="M2 16H9L14 9L19 26L25 4L30 16H38" pathLength="100"/></svg>
  <span className="health-short">{checking?'Checking':healthy?'Online':!connected?'Offline':'Review'}</span>
 </div>;
}
