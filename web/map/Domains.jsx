import React from 'react';
import {IconWorld,IconNetwork,IconArrowsSplit,IconBox,IconCertificate,IconRefresh,IconClock,IconChevronRight,IconCircleX} from '@tabler/icons-react';
import {StatusLabel} from '../system.jsx';
import {Note} from './MoveFlow.jsx';
import {SidePanel} from './Panels.jsx';
import {HOP_NAME,WORD,pathRows,checkedText} from './domains-model.js';
import './domains.css';

const HOP_ICON={domain:IconWorld,dns:IconNetwork,proxy:IconArrowsSplit,app:IconBox,certificate:IconCertificate};
export const Status=({state,children})=><StatusLabel state={state}>{children||WORD[state]}</StatusLabel>;

// The five steps of one domain: domain, DNS, proxy, app, certificate. Read-only; a step that is not green says why and what to do.
export function PathStepper({row,ctx,checking,error,onLink,onAddApp,now}){
 const rows=pathRows(row,ctx);
 return <ol className="map-path" aria-label={'Path of '+row.domain}>
  {rows.map(h=>{const st=checking?'running':h.state,stale=!checking&&error&&h.k!=='domain';
   return <li key={h.k} className={'map-hop hop-'+(checking?'queued':h.state)}>
    <span className="map-hop-icon">{React.createElement(HOP_ICON[h.k],{size:24,stroke:1.5,'aria-hidden':'true'})}</span>
    <div className="map-hop-body">
     <div className="map-hop-head"><b>{HOP_NAME[h.k]}</b><Status state={st}/></div>
     <p className="map-hop-detail">{checking?'Looking…':h.detail}</p>
     {stale&&<p className="map-caption">Last known result, {checkedText(row,now).replace(/^Checked /,'checked ')}</p>}
     {!checking&&h.reason&&<p className="map-hop-reason">{h.reason}</p>}
     {!checking&&(h.next||h.link)&&<p className="map-hop-next">{h.next&&<><b>Next step</b> {h.next} </>}{h.link==='connections'&&onLink&&<button type="button" className="map-hoplink" onClick={onLink}>Open Connections</button>}{h.link==='add-static'&&onAddApp&&<button type="button" className="link-action" onClick={()=>onAddApp(row)}>Add as app</button>}</p>}
    </div>
   </li>})}
 </ol>;
}

// The path panel for one domain (a node on the Map, or a row in an app's panel).
export function DomainPanel({row,onAddApp,others=[],checkingOf=()=>false,errorOf=()=>'',narrow,ctx,checking,error,canCheck,onCheck,onClose,onOpenApp,onConnections,now}){
 const never=!row.hops,busy=!!checking;
 const check=canCheck&&<button type="button" className={never&&!busy?'primary':'link-action'} disabled={busy} onClick={()=>onCheck(row.domain)}><IconRefresh size={18} stroke={1.75} aria-hidden="true"/>{never?'Check now':'Check again'}</button>;
 const open=row.siteId&&onOpenApp&&<button type="button" className={never&&canCheck?'link-action':'primary'} onClick={()=>onOpenApp(row.siteId)}>Open app</button>;
 return <SidePanel narrow={narrow} labelId="map-panel-title" title={row.domain} onClose={onClose} icon={<IconWorld size={24} stroke={1.5} aria-hidden="true"/>}
  footer={<>{never&&canCheck?<>{open}{check}</>:<>{check}{open}</>}</>}>
  <div role="status" aria-live="polite" className="map-domain-live">
   {error&&!busy&&<Note kind="error" icon={IconCircleX} role="alert">{error}{' '}The last results are kept below.</Note>}
   {busy&&<span className="sr-only">Checking {row.domain}</span>}
  </div>
  {never&&!busy?<>
   <p className="map-hop-detail"><b>Not checked yet</b></p>
   <p className="map-caption">DockNest has not looked at {row.domain} yet. A check reads its DNS record, the proxy, the app and the certificate. It changes nothing.</p>
  </>:<>
   <PathStepper row={row} ctx={ctx} checking={busy} error={error} onLink={onConnections} onAddApp={onAddApp} now={now}/>
   {!busy&&row.checkedAt&&<p className="map-caption map-checked"><IconClock size={16} stroke={1.75} aria-hidden="true"/>{checkedText(row,now)}</p>}
  </>}
  {others.map(o=><section key={o.domain} className="map-alias" aria-label={'Also served as '+o.domain}>
   <h3 className="map-group-title">Also served as {o.domain}</h3>
   {o.hops?<PathStepper row={o} ctx={ctx} checking={!!checkingOf(o.domain)} error={errorOf(o.domain)} onLink={onConnections} onAddApp={onAddApp} now={now}/>:<p className="map-caption">Not checked yet.</p>}
  </section>)}
 </SidePanel>;
}

// A row in an app's panel: one per domain with the status of its worst step. A row opens the path panel.
export function AppDomains({list,statusOf,onOpen}){
 if(!list.length)return null;
 return <section className="map-sec"><h3 className="map-group-title">Domains</h3>
  <ul className="map-rows map-drows">{list.map(d=><li key={d.domain}><button type="button" className="map-row" onClick={e=>onOpen(d,e.currentTarget)}><IconWorld size={24} stroke={1.5} aria-hidden="true"/><span><b className="map-name">{d.domain}</b><Status state={statusOf(d)}/></span><IconChevronRight size={18} stroke={1.75} aria-hidden="true"/></button></li>)}</ul>
 </section>;
}

// Phone list: the domains of one app (or the loose ones) as rows under it.
export function DomainRows({list,statusOf,onOpen,title}){
 if(!list.length)return null;
 return <div className="map-list-doms"><span className="map-caption">{title||'Domains'}</span><ul className="map-list-domains" aria-label={title||'Domains'}>{list.map(d=><li key={d.domain}><button type="button" className="map-drow" onClick={e=>onOpen(d,e.currentTarget)}><IconWorld size={16} stroke={1.75} aria-hidden="true"/><span className="map-name">{d.domain}</span><Status state={statusOf(d)}/></button></li>)}</ul></div>;
}
