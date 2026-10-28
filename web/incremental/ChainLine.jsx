import React from 'react';
import {Layers,Link} from '../icons.jsx';
import {inChain,isIncremental,kindLabel,dependentsLine} from './model.js';
import './incremental.css';

// One quiet line under a recovery point that belongs to a chain: Full / Increment 3 of 6, what it depends on, chain actions.
export function ChainLine({backup,backups,date,onChain}){
 if(!inChain(backup))return null;
 const parent=backup.parentId?backups.find(item=>item.id===backup.parentId):null,incremental=isIncremental(backup);
 const text=incremental?(parent?'Depends on '+date(parent.capturedAt||parent.createdAt):'Depends on a missing backup'):dependentsLine(backup);
 return <div className="inc-line" aria-label={'Chain of backup '+backup.id}>
  <span className={'status inc-kind '+(incremental?'status-running':'status-success')}>{incremental?<Link className="status-icon" size={16} stroke={2} aria-hidden="true"/>:<Layers className="status-icon" size={16} stroke={2} aria-hidden="true"/>}{kindLabel(backup)}</span>
  {text&&<span className="inc-text" title={text}>{text}</span>}
  {incremental&&backup.dependents>0&&<span className="inc-text">{dependentsLine(backup)}</span>}
  {backup.pinnedByChain&&<span className="inc-text">Kept for a chain</span>}
  <span className="inc-spacer"/>
  <button type="button" className="inc-link" aria-label={'Show chain of backup '+backup.id} onClick={()=>onChain(backup)}>Chain</button>
 </div>;
}
