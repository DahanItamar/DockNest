import React from 'react';
import {IconLink,IconNetwork,IconAlertTriangle,IconInfoCircle} from '@tabler/icons-react';
import {linksOf,appLinksOf,scanState,reasonOf,hubLine,unownedLine} from './linked.js';
import './linked.css';

const HINT={
 unknown:'Links show after the next server scan.',
 never:'Not scanned yet. Scan this server again to see which apps depend on each other.',
 damaged:'The saved link data could not be read. Scan this server again to rebuild it.',
 partial:'Some containers could not be read, so this list may be incomplete.',
};
// "Linked apps" in an app's details panel, from the last scan of its server. Every state says plainly what is known.
export function LinkedSection({site,servers,nameOf,onOpen}){
 const {links,unowned,hubs}=linksOf(servers,site),state=scanState(appLinksOf(servers,site));
 const known=links.length+unowned.length+hubs.length>0;
 return <section className="lk-section" aria-labelledby="lk-title">
  <h3 id="lk-title" className="map-group-title">Linked apps</h3>
  {known&&<ul className="lk-list">
   {links.map(link=><li key={link.otherAppId}><button type="button" className="lk-row" onClick={e=>onOpen(link.otherAppId,e.currentTarget)}><IconLink size={18} stroke={1.75} aria-hidden="true"/><span><span className="map-name">{nameOf(link.otherAppId)}</span><span className="map-caption">{reasonOf(link,nameOf(link.otherAppId))}</span></span></button></li>)}
   {hubs.map(hub=><li key={hub.network} className="lk-note"><IconNetwork size={18} stroke={1.75} aria-hidden="true"/><span>{hubLine(hub)}</span></li>)}
   {unowned.map(entry=><li key={entry.container} className="lk-note lk-warn"><IconAlertTriangle size={18} stroke={1.75} aria-hidden="true"/><span>{unownedLine(entry)}</span></li>)}
  </ul>}
  {state==='ok'&&!known&&<p className="map-caption">No linked apps found in the last scan.</p>}
  {state!=='ok'&&<p className="lk-hint"><IconInfoCircle size={18} stroke={1.75} aria-hidden="true"/><span>{HINT[state]}</span></p>}
 </section>;
}
