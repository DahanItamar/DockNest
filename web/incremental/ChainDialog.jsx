import React from 'react';
import {DataTable} from '../data-table.jsx';
import {StatusLabel,AlertPanel} from '../system.jsx';
import {Download} from '../icons.jsx';
import {chainOf,isIncremental,kindLabel} from './model.js';
import {chainDownloadUrl} from './incremental-client.js';
import './incremental.css';

// One chain, full backup first: position, kind, parent, size. Opened from a backup row.
export function ChainDialog({backup,backups,date,bytes,onClose}){
 const rows=chainOf(backup,backups),total=rows.reduce((sum,item)=>sum+(item.size||item.sizeBytes||0),0);
 const parentOf=item=>item.parentId?rows.find(row=>row.id===item.parentId):null;
 return <div className="modal-body site-wizard inc-chain">
  <p className="t-caption inc-chain-sum">{rows.length} {rows.length===1?'backup':'backups'} in this chain, {bytes(total)} stored.</p>
  {rows.length<2&&<AlertPanel variant="info" title="Chain not complete">Only this backup of the chain is listed.</AlertPanel>}
  <DataTable caption="Backups in this chain" headers={['Backup','Kind','Depends on','Size']} columns={[null,'22%','28%','16%']} numeric={[3]}>{rows.map(item=>{
   const parent=parentOf(item);
   return <tr key={item.id} aria-current={item.id===backup.id?'true':undefined} className={item.id===backup.id?'inc-current':undefined}>
    <td><b>{date(item.capturedAt||item.createdAt)}</b></td>
    <td><span className={'status inc-kind '+(isIncremental(item)?'status-running':'status-success')}>{kindLabel(item)}</span></td>
    <td className="inc-parent">{parent?date(parent.capturedAt||parent.createdAt):item.parentId?'Missing':'Start of chain'}</td>
    <td>{bytes(item.size||item.sizeBytes)}</td>
   </tr>;
  })}</DataTable>
  <div className="modal-foot"><button type="button" onClick={onClose}>Close</button><a className="button primary inc-download" href={chainDownloadUrl(backup.id)}><Download size={18} stroke={1.75} aria-hidden="true"/>Download chain</a></div>
 </div>;
}
