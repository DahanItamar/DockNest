import React from 'react';
import { AlertPanel, StatusLabel } from '../system.jsx';
import { formatBytes } from '../../shared/format-bytes.js';
import { driveFacts, labelOf, maskAccount, SENTENCE_LABELS } from './drive-model.js';

export const isDriveTarget = target => target.kind === 'rclone' || target.kind === 'local';
export const driveKindText = target => (target.kind === 'local' ? 'Local folder' : labelOf(target.backend));

// Capacity bar, same look as the other destination cards.
function Usage({ used, capacity }) {
  if (used == null) return null;
  const percent = capacity > 0 ? Math.min(100, Math.max(used ? 1 : 0, Math.round((used / capacity) * 100))) : null;
  return <div className="storage-usage"><div className="storage-usage-text"><span>{percent == null ? 'Used by DockNest backups' : 'Capacity used'}</span><b>{percent == null ? formatBytes(used) : `${percent}% · ${formatBytes(used)} of ${formatBytes(capacity)}`}</b></div>
    {percent != null && <progress value={percent} max="100" aria-label="Capacity used" />}</div>;
}

// Body of a cloud drive, network share or local folder card (docs/cloud-drives.md): masked account, folder, the honest
// "not append-only" line, the trash note and, when the token stopped working, the red Reconnect panel. The API never sends a
// token, a password or an unmasked account, so there is nothing here to hide.
export function DriveCardBody({ target, used }) {
  const facts = driveFacts(target), label = SENTENCE_LABELS[target.backend] || 'The destination', local = target.kind === 'local';
  return <>
    <dl className="def-list">
      {local ? <div className="def-row"><dt>Folder</dt><dd><code>{target.path}</code></dd></div> : <>
        {target.account && <div className="def-row"><dt>Account</dt><dd>{maskAccount(target.account)}</dd></div>}
        {target.backend === 'webdav' && target.endpoint && <div className="def-row"><dt>Server</dt><dd><code>{target.endpoint}</code></dd></div>}
        <div className="def-row"><dt>Folder</dt><dd><code>{String(target.root || '/').replace(/^\//, '') || '/'}</code></dd></div></>}
      <div className="def-row"><dt>Append-only</dt><dd>{facts.appendOnly}</dd></div>
      {target.capacity_bytes > 0 ? <div className="def-row"><dt>Capacity</dt><dd>{formatBytes(target.capacity_bytes)} configured</dd></div> : <div className="def-row"><dt>Capacity</dt><dd>{facts.capacity}</dd></div>}
    </dl>
    {target.needsReconnect && <AlertPanel variant="error" title={`${label} needs you to sign in again`}>Backups to this destination are paused until you reconnect. Nothing stored here was changed.</AlertPanel>}
    {local && target.sameDisk && <AlertPanel variant="warning" title="Same disk as DockNest">A disk failure would lose these backups together with DockNest.</AlertPanel>}
    {facts.trashNote && <p className="dr-trash t-caption">{facts.trashNote}</p>}
    <Usage used={used} capacity={target.capacity_bytes} />
  </>;
}

// "Needs sign-in" replaces "Used for new backups" while the token is dead.
export const NeedsSignIn = () => <StatusLabel state="failed">Needs sign-in</StatusLabel>;
