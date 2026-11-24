import React from 'react';
import {IconClock,IconAlertTriangle,IconInfoCircle} from '@tabler/icons-react';
import {phaseRows,recoveryText} from './model.js';
import './recovery.css';

// "Back in about 12 min · proven 3 days ago". A stale number (older than twice the test cadence) is muted, with the warning
// icon and "not recent" so it is never read as current.
export function RecoveryLine({recovery,className=''}){
 const text=recoveryText(recovery);
 if(!text)return null;
 const Icon=text.stale?IconAlertTriangle:IconClock;
 return <span className={'rec-line'+(text.stale?' is-stale':'')+(className?' '+className:'')}><Icon size={16} stroke={1.75} className="rec-ic" aria-hidden="true"/><span>{text.line}{text.stale?', not recent':''}</span></span>;
}

// The three phases as one bar and a legend with text values; the colours are never the only carrier of the numbers.
export function RecoveryBar({phases}){
 const rows=phaseRows(phases);
 if(!rows.length)return null;
 return <div className="rec-phases">
  <div className="rec-bar" role="img" aria-label={rows.map(row=>row.label+' '+row.text).join(', ')}>{rows.map(row=><span key={row.key} className={'rec-seg rec-'+row.tone} style={{flexGrow:row.share}}/>)}</div>
  <ul className="rec-legend">{rows.map(row=><li key={row.key}><span className={'rec-dot rec-'+row.tone} aria-hidden="true"/><span>{row.label}</span><b>{row.text}</b></li>)}</ul>
 </div>;
}

export const MayBeLow=()=><div className="rec-note" role="note"><IconInfoCircle size={20} stroke={1.75} aria-hidden="true"/><div><b>This number may be low</b><p>Backups grew since the last test. Run a test for a fresh number.</p></div></div>;
