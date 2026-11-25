import React, { useEffect, useRef, useState } from 'react';
import { IconX } from '@tabler/icons-react';
import { AlertPanel } from '../system.jsx';
import { useReauth } from '../connections/ConnectionDialog.jsx';
import { OAuthSignIn } from './OAuthSignIn.jsx';
import { labelOf } from './drive-model.js';

// Reconnect (docs/cloud-drives.md, "Reconnect"): the same sign-in as connecting, but it replaces only the token. The folder,
// the history and the settings stay, and backups resume after the test passes. Escape and Close cancel unless it is working.
export function ReconnectDialog({ api, target, onClose, onDone, onSessionExpired }) {
  const ref = useRef(null), sign = useRef(null), guard = useReauth({ reauth: (password, code) => api('/auth/reauth', { password, code }) });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [hidden, setHidden] = useState(''), [sure, setSure] = useState(false), kept = useRef(null);
  const label = labelOf(target.backend);
  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal(); return () => { if (d?.open) d.close(); }; }, []);
  async function reconnect(event) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try {
      const session = kept.current ?? await sign.current.complete();
      kept.current = session;
      await new Promise((resolve, reject) => guard.run(async () => resolve(await api(`/storage-targets/${encodeURIComponent(target.id)}/reconnect`, { sessionId: session.sessionId, ...(sure ? { confirmHidden: true } : {}) })), reject));
      await onDone(`${target.name} is connected again. Backups resume at the next run.`);
    } catch (e) {
      if (e.code === 'client_changed') setHidden(e.message);
      else kept.current = null;
      if (e.code === 'client_changed') { /* the owner confirms below; the sign-in stays open */ }
      else if (e.status === 401) onSessionExpired?.();
      else if (!e.handled) setError(e.message || 'The sign-in did not work. Try again.');
    }
    setBusy(false);
  }
  return <dialog ref={ref} className="site-wizard storage-dialog" aria-labelledby="dr-reconnect-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <div className="modal-head"><h2 id="dr-reconnect-title">Reconnect {label}</h2><button type="button" className="icon" aria-label="Close dialog" aria-disabled={busy || undefined} onClick={() => { if (!busy) onClose(); }}><IconX size={20} /></button></div>
    <form className="storage-form" onSubmit={reconnect}>
      <div className="modal-body storage-scroll">
        <p className="t-caption">Sign in to {label} again for <b dir="auto">{target.name}</b>. Only the sign-in is replaced. The folder and the backups already there stay as they are.</p>
        <OAuthSignIn ref={sign} api={api} backend={target.backend} guard={guard} disabled={busy} />
        {hidden && <AlertPanel variant="warning" title="Earlier backups will be hidden.">{hidden} Google only shows DockNest the files that the same Google app created. Go back and use the same app ID, or confirm to continue.<label className="field"><input type="checkbox" checked={sure} onChange={e => setSure(e.target.checked)} /> <span>I understand, continue with this app</span></label></AlertPanel>}
        {error && <AlertPanel variant="error" title="Could not reconnect.">{error}</AlertPanel>}
        {guard.box}
      </div>
      <div className="modal-foot storage-foot"><button className="link-action" type="button" aria-disabled={busy || undefined} onClick={() => { if (!busy) onClose(); }}>Cancel</button><button className="primary" aria-disabled={busy || undefined}>{busy ? 'Testing…' : 'Test & reconnect'}</button></div>
    </form>
  </dialog>;
}
