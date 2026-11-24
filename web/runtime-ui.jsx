import './runtime-ui.css';
import React from 'react';
import {Box} from './icons.jsx';
import {engineLabel,engineList,podmanOnly} from './runtime-ui.js';

// A small pill naming the engine of an app or container: icon plus text, never colour alone.
export function RuntimeBadge({runtime,label}){
 const text=label||engineLabel(runtime);
 return <span className="runtime-badge"><Box size={16} stroke={1.75} aria-hidden="true"/>{text}</span>;
}
// What a server runs, one pill per engine; a server with Podman but no Docker says so in words.
export function ServerEngines({server}){
 const engines=engineList(server);
 if(!engines.length)return null;
 return <div className="def-row"><dt>Engines</dt><dd className="runtime-list"><span className="runtime-badges">{engines.map(engine=><RuntimeBadge key={engineLabel(engine)} runtime={engine}/>)}</span>
  {podmanOnly(server)&&<span className="t-caption">No Docker daemon on this server. DockNest works with the engines listed here.</span>}</dd></div>;
}
