import React from 'react';
import {AlertPanel} from '../system.jsx';
import {Download,CheckCircle2,Clock} from '../icons.jsx';
import {isIntegrityChecked} from '../verification-core.js';
import {chainOf} from './model.js';
import {chainDownloadUrl} from './incremental-client.js';
import './incremental.css';

// One chain, full backup first. The same compact rows at every width: date, kind, size, status icon.
export function ChainDialog({backup,backups,date,bytes,onClose}){
 const rows=chainOf(backup,backups),total=rows.reduce((sum,item)=>sum+(item.size||item.sizeBytes||0),0);
 return <div className="modal-body site-wizard inc-chain">
  <p className="t-caption inc-chain-sum">{rows.length} {rows.length===1?'backup':'backups'} in this chain, {bytes(total)} stored.</p>
  {rows.length<2&&<AlertPanel variant="info" title="Chain not complete">Only this backup of the chain is listed.</AlertPanel>}
  <table className="inc-table"><caption className="inc-sr">Backups in this chain</caption>
   <thead><tr><th scope="col">Backup</th><th scope="col">Kind</th><th scope="col" className="num">Size</th><th scope="col" className="inc-status"><span className="inc-sr">Status</span></th></tr></thead>
   <tbody>{rows.map(item=>{const ok=isIntegrityChecked(item),Icon=ok?CheckCircle2:Clock;return <tr key={item.id} aria-current={item.id===backup.id?'true':undefined} className={item.id===backup.id?'inc-current':undefined}>
    <td className="inc-when">{(parts=>[<b key="d">{parts[0]}</b>,parts[1]&&<small key="t">{parts[1]}</small>])(String(date(item.capturedAt||item.createdAt)).split(' | '))}</td>
    <td>{item.backupKind==='incremental'?'Increment '+item.chainPosition:'Full'}</td>
    <td className="num">{bytes(item.size||item.sizeBytes)}</td>
    <td className="inc-status"><Icon className={'status-icon '+(ok?'status-success':'status-queued')} size={18} stroke={2} aria-hidden="true"/><span className="inc-sr">{ok?'Integrity checked':'Not checked yet'}</span></td>
   </tr>})}</tbody>
  </table>
  <div className="modal-foot"><button type="button" onClick={onClose}>Close</button><a className="button primary inc-download" href={chainDownloadUrl(backup.id)}><Download size={18} stroke={1.75} aria-hidden="true"/>Download chain</a></div>
 </div>;
}
