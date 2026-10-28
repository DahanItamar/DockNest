import React from 'react';
import {AlertPanel} from '../system.jsx';
import {sourceText,sourceUsable} from './model.js';
import './copies.css';

// Restore dialog: choose which copy to restore from. Main is the default; a fallback is explained.
export function RestoreSource({sources,source,busy,onChange}){
 if(!Array.isArray(sources)||sources.length<2)return null;
 const chosen=source?.targetId||sources[0].targetId,main=sources.find(item=>item.role==='main');
 const fallback=source?.role==='copy'&&main&&main.status!=='verified';
 const name=sources.find(item=>item.targetId===chosen)?.name||'a copy';
 return <div className="cp-source">
  <div className="cp-row">
   <div className="cp-row-text"><label className="cp-row-label" htmlFor="cp-source">Restore from</label><span className="t-caption" id="cp-source-help">Main is used unless you pick a copy.</span></div>
   <div className="cp-row-control"><select id="cp-source" value={chosen} disabled={busy} aria-describedby="cp-source-help" onChange={event=>onChange(event.target.value)}>
    {sources.map(item=><option key={item.targetId} value={item.targetId} disabled={!sourceUsable(item)}>{sourceText(item)}</option>)}
   </select></div>
  </div>
  {fallback&&<AlertPanel variant="warning" title="Main copy is not available">This restore reads from {name} instead.</AlertPanel>}
 </div>;
}
