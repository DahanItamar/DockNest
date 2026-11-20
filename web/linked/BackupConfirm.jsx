import React from 'react';
import {LinkedWarning} from './LinkedWarning.jsx';
import './linked.css';

// Opens only when the app has warning links or unbacked dependencies; the backup always covers just this app.
export function BackupConfirm({site,items,busy,onCancel,onConfirm,onOpenApp}){
 return <div className="modal-body lw-confirm">
  <p>DockNest backs up the files and databases of <b>{site.name}</b>. The app stays online.</p>
  <LinkedWarning items={items} onOpenApp={onOpenApp}/>
  <div className="modal-foot"><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="primary" disabled={busy} onClick={onConfirm}>Back up now</button></div>
 </div>;
}
