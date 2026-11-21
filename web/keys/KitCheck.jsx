import React from 'react';
import {IconRefresh} from '@tabler/icons-react';
import {StatusLabel,AlertPanel} from '../system.jsx';
import {formatDate} from '../date-format.js';

// Self Backup: "Recovery kit check" (docs/emergency-kit.md, "Kit check"). The worker opens the newest kit with the passphrase
// DockNest keeps after every Self Backup and on Check now. Reason codes only come from the server; the words are here.
export const KIT_REASON={
 passphrase:'the passphrase DockNest keeps does not open it.',
 hashes:'its checksum differs.',
 key_mismatch:'it holds a different master key than this DockNest.',
 integrity:'its database did not pass the integrity check.',
 unreadable:'it could not be read from storage. Check the storage connection.',
 no_kit:'there is no kit in storage.',
 no_passphrase:'DockNest has no recovery passphrase saved.',
 size:'the file is not a recovery kit.',
 format:'it was made by a version DockNest cannot read.',
 contents:'its contents are not what a kit holds.'
};
export const kitReason=code=>KIT_REASON[code]||'DockNest could not finish the check.';

export function KitCheckCard({kit,busy,onCheck,onNewKit}){
 const last=kit?.last,running=Boolean(kit?.active),failed=last?.result==='failed',never=!last;
 return <section className="card kit-check" aria-labelledby="kc-title"><div className="card-body sb-stack">
  <h2 className="card-title" id="kc-title">Recovery kit check</h2>
  <span className="sb-state" role="status">{running?<StatusLabel state="running">Checking the newest kit</StatusLabel>
   :never?<StatusLabel state="queued">Not checked yet</StatusLabel>
   :failed?<StatusLabel state="failed">Did not open on {formatDate(last.checkedAt,{shortTime:true})}</StatusLabel>
   :<StatusLabel state="success">Opened on {formatDate(last.checkedAt,{shortTime:true})} with the saved passphrase</StatusLabel>}</span>
  {failed&&!running&&<AlertPanel variant="error" title="The newest kit did not open">The newest kit did not open: {kitReason(last.reason)}</AlertPanel>}
  {never&&!running&&<p className="t-body">No kit checked yet. It is checked after the next Self Backup.</p>}
  {last&&!failed&&<p className="t-body">This proves the kit file is whole and the passphrase DockNest keeps opens it. It cannot prove your own copy of the passphrase is right.</p>}
  <dl className="def-list backup-facts"><div className="def-row"><dt>Schedule</dt><dd>Checked after every Self Backup</dd></div></dl>
 </div><div className="card-footer sb-footer">
  <button type="button" disabled={busy||running} onClick={onCheck}><IconRefresh size={18} stroke={1.75} aria-hidden="true"/>Check now</button>
  {failed&&<button type="button" className="primary" disabled={busy||running} onClick={onNewKit}>Make a new kit</button>}
 </div></section>;
}
