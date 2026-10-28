import React,{useState} from 'react';
import {AlertPanel} from '../system.jsx';
import {DataTable} from '../data-table.jsx';
import {doomedWith,deleteTitle,deleteError,kindLabel} from './model.js';
import './incremental.css';

// Deleting a backup that others depend on removes them too; the dialog lists every one before anything happens.
export function DeleteBackupDialog({client,backup,backups,date,bytes,onClose,onDeleted,onSessionExpired}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(null);
 const doomed=backup.dependents>0?doomedWith(backup,backups):[backup],freed=doomed.reduce((sum,item)=>sum+(item.size||item.sizeBytes||0),0);
 async function confirm(){
  if(busy)return;setBusy(true);setError(null);
  try{await client.remove(backup.id);onDeleted(doomed.length)}catch(failure){if(failure.status===401)onSessionExpired?.();else setError(deleteError(failure))}finally{setBusy(false)}
 }
 return <div className="modal-body site-wizard inc-delete">
  {backup.dependents>0?<AlertPanel variant="warning" title={deleteTitle(backup)}>Later backups need this one to be restored, so they go too. This frees {bytes(freed)}.</AlertPanel>:<p>This frees {bytes(freed)}. It cannot be undone.</p>}
  {doomed.length>1&&<DataTable caption="Backups that will be deleted" headers={['Backup','Kind','Size']} columns={[null,'30%','20%']} numeric={[2]}>{doomed.map(item=><tr key={item.id}><td><b>{date(item.capturedAt||item.createdAt)}</b></td><td>{kindLabel(item)}</td><td>{bytes(item.size||item.sizeBytes)}</td></tr>)}</DataTable>}
  {error&&<AlertPanel variant="error" title={error.reason}>{error.action}</AlertPanel>}
  <div className="modal-foot"><button type="button" onClick={onClose}>Cancel</button><button type="button" className="danger" disabled={busy} onClick={confirm}>{busy?'Deleting…':doomed.length>1?'Delete '+doomed.length:'Delete'}</button></div>
 </div>;
}
