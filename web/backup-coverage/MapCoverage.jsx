import React from 'react';
import {CoverageSection} from './CoverageSection.jsx';
import './backup-coverage.css';

// Map server panel: the same list the Apps page shows, for the server that was opened.
export function MapCoverage({api,server,coverage,canChange,onAddApp,onOpenApp,onSessionExpired}){
 return <section className="bc-map" aria-label="Backup coverage">
  <h3 className="map-group-title">Backup coverage</h3>
  <CoverageSection api={api} serverId={server.id} serverName={server.name} entry={coverage.byServer[server.id]} canChange={canChange} onScan={coverage.scan} patch={coverage.patch} onAddApp={onAddApp} onOpenApp={onOpenApp} onSessionExpired={onSessionExpired}/>
 </section>;
}
