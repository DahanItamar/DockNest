import React from 'react';
import {CoverageSection} from './CoverageSection.jsx';
import {nodeLine} from './model.js';
import './backup-coverage.css';

// Map server panel: the same list the Apps page shows, for the server that was opened.
export function MapCoverage({api,server,coverage,onAddApp,onOpenApp,onSessionExpired}){
 return <section className="bc-map" aria-label="Backup coverage">
  <h3 className="map-group-title">Backup coverage</h3>
  <CoverageSection api={api} serverId={server.id} serverName={server.name} entry={coverage.byServer[server.id]} onScan={coverage.scan} patch={coverage.patch} onAddApp={onAddApp} onOpenApp={onOpenApp} onSessionExpired={onSessionExpired}/>
 </section>;
}

// The one caption line a Map server node (or phone card) shows for its coverage, in the Map's own caption styles.
export function CoverageLine({entry}){
 const line=nodeLine(entry);
 return <span className={'map-caption '+line.tone}>{line.text}</span>;
}
