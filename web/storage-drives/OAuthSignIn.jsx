import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { IconExternalLink, IconCircleCheck } from '@tabler/icons-react';
import { AlertPanel } from '../system.jsx';
import { labelOf, maskAccount, pasteKind, PASTE_HELP, RCLONE_NAMES } from './drive-model.js';

// Sign in to Google Drive, OneDrive or Dropbox (docs/cloud-drives.md, "Signing in"). Three ways, one component:
//  A. address: open the provider's sign-in link, then paste the 127.0.0.1:53682 address the browser could not open;
//  B. token: paste the JSON that `rclone authorize` printed on the owner's own computer;
//  C. own app: the owner's client ID and secret, then A again with them.
// The session starts when this appears and is cancelled when it goes away; nothing polls. The parent calls `complete()` on
// Test & connect: it sends the paste and resolves with the session. `guard` is the app's re-verify step (useReauth).
const viaGuard = (guard, work) => new Promise((resolve, reject) => { guard.run(async () => resolve(await work()), reject); });
const STEP_SUB = { drive: 'Opens in a new tab. DockNest only sees the files it creates.', onedrive: 'Opens in a new tab. DockNest keeps its backups in one folder.', dropbox: 'Opens in a new tab. DockNest keeps its backups in one folder.' };
const PATH = '/storage-targets/rclone/authorize';

export const OAuthSignIn = forwardRef(function OAuthSignIn({ api, backend, guard, disabled }, ref) {
  const label = labelOf(backend);
  const [mode, setMode] = useState('address'), [own, setOwn] = useState({ open: false, id: '', secret: '', applied: null });
  const [session, setSession] = useState({ phase: 'starting' }), [pasted, setPasted] = useState(''), [done, setDone] = useState(null), [retry, setRetry] = useState(0), [error, setError] = useState('');
  const sessionId = useRef(null), keep = useRef(false), input = useRef(null);

  useEffect(() => {
    let live = true; keep.current = false; setSession({ phase: 'starting' }); setDone(null); setPasted(''); setError('');
    guard.run(async () => {
      const body = { backend, flow: mode, ...(own.applied ? { clientId: own.applied.id, clientSecret: own.applied.secret } : {}) };
      const result = await api(PATH, body);
      if (!live) { api(`${PATH}/${encodeURIComponent(result.sessionId)}`, undefined, 'DELETE').catch(() => {}); return; }
      sessionId.current = result.sessionId;
      setSession({ phase: 'ready', id: result.sessionId, url: result.url || null });
    }, e => { if (live) setSession({ phase: 'error', message: e.message || 'The sign-in could not start. Try again.' }); });
    return () => {
      live = false;
      const id = sessionId.current; sessionId.current = null;
      if (id && !keep.current) api(`${PATH}/${encodeURIComponent(id)}`, undefined, 'DELETE').catch(() => {});
    };
  }, [backend, mode, own.applied, retry]);

  useImperativeHandle(ref, () => ({
    // Sends the paste; resolves with what the connect call needs. Rejects with a sentence the parent shows.
    async complete() {
      if (done) return { sessionId: session.id, backend, account: done.account };
      if (session.phase !== 'ready') throw new Error(session.phase === 'error' ? session.message : 'The sign-in is still starting. Wait a moment, then try again.');
      const kind = pasteKind(pasted);
      if (kind === 'empty') { setError(mode === 'token' ? 'Paste the token first.' : 'Open the sign-in link, sign in, then paste the address here.'); input.current?.focus(); throw Object.assign(new Error(mode === 'token' ? 'Paste the token first.' : 'Paste the address from the sign-in step.'), { handled: true }); }
      try {
        const result = await viaGuard(guard, () => api(`${PATH}/${encodeURIComponent(session.id)}`, { pasted: pasted.trim() }));
        keep.current = true;
        setDone({ account: result.account || null }); setError('');
        return { sessionId: session.id, backend, account: result.account || null };
      } catch (e) { setError(e.message || 'That did not work. Try again.'); throw Object.assign(e, { handled: true }); }
    },
    ready: () => done || (session.phase === 'ready' && pasteKind(pasted) !== 'empty'),
  }), [api, backend, done, guard, mode, pasted, session]);

  const kind = pasteKind(pasted), hint = kind === 'other' ? PASTE_HELP.other : '';
  const applyOwn = () => setOwn(previous => ({ ...previous, applied: previous.id.trim() && previous.secret.trim() ? { id: previous.id.trim(), secret: previous.secret.trim() } : null }));
  const ownReady = own.id.trim() && own.secret.trim();
  const restart = () => setRetry(n => n + 1);

  if (done) return <div className="dr-signed" role="status"><IconCircleCheck size={20} stroke={1.75} aria-hidden="true" /><span>Signed in{done.account ? <> as <b>{maskAccount(done.account)}</b></> : null}. Press Test &amp; connect to finish.</span></div>;
  return <div className="dr-oauth">
    <ol className="dr-steps">
      {mode === 'address' ? <>
        <li><span className="dr-num" aria-hidden="true">1</span><div><b>Sign in to {label}</b><p className="t-caption">{STEP_SUB[backend]}</p>
          {session.phase === 'starting' && <p className="t-caption" role="status">Preparing the sign-in link…</p>}
          {session.phase === 'ready' && session.url && <a className="dr-link" href={session.url} target="_blank" rel="noopener noreferrer">Open the sign-in link<IconExternalLink size={16} stroke={1.75} aria-hidden="true" /></a>}
          {session.phase === 'error' && <AlertPanel variant="error" action={<button type="button" onClick={restart}>Try again</button>}>{session.message}</AlertPanel>}</div></li>
        <li><span className="dr-num" aria-hidden="true">2</span><div><b id="dr-paste-l">Paste the address that failed to load</b><p className="t-caption">After you sign in, your browser opens an address that starts with 127.0.0.1:53682 and shows an error. That is expected. Copy it from the address bar.</p>
          <input ref={input} className="dr-paste" type="text" inputMode="url" autoComplete="off" spellCheck={false} aria-labelledby="dr-paste-l" aria-describedby="dr-paste-help" aria-invalid={error ? 'true' : undefined} placeholder="" disabled={disabled || session.phase !== 'ready'} value={pasted} onChange={e => { setPasted(e.target.value); setError(''); }} />
          <p className={'t-caption' + (error || hint ? ' dr-bad' : '')} id="dr-paste-help" role={error ? 'alert' : undefined}>{error || hint || 'The link works for 10 minutes.'}</p></div></li>
      </> : <>
        <li><span className="dr-num" aria-hidden="true">1</span><div><b>Get a token on your computer</b><p className="t-caption">Run this where you can open a browser. It prints a block of JSON.</p><code className="dr-cmd">rclone authorize &quot;{RCLONE_NAMES[backend]}&quot;</code>
          {session.phase === 'starting' && <p className="t-caption" role="status">Getting ready…</p>}
          {session.phase === 'error' && <AlertPanel variant="error" action={<button type="button" onClick={restart}>Try again</button>}>{session.message}</AlertPanel>}</div></li>
        <li><span className="dr-num" aria-hidden="true">2</span><div><b id="dr-paste-l">Paste the token</b><p className="t-caption">Paste the whole block, including the braces. DockNest keeps only the token fields it needs.</p>
          <textarea ref={input} className="dr-paste" rows={4} autoComplete="off" spellCheck={false} aria-labelledby="dr-paste-l" aria-describedby="dr-paste-help" aria-invalid={error ? 'true' : undefined} disabled={disabled || session.phase !== 'ready'} value={pasted} onChange={e => { setPasted(e.target.value); setError(''); }} />
          <p className={'t-caption' + (error ? ' dr-bad' : '')} id="dr-paste-help" role={error ? 'alert' : undefined}>{error || 'The token is kept sealed with your DockNest key.'}</p></div></li>
      </>}
    </ol>
    <div className="dr-quiet">
      <button type="button" className="link-action" disabled={disabled} onClick={() => setMode(m => (m === 'address' ? 'token' : 'address'))}>{mode === 'address' ? 'Use a token from rclone instead' : 'Use the sign-in link instead'}</button>
      <button type="button" className="link-action" aria-expanded={own.open} aria-controls="dr-own" disabled={disabled} onClick={() => setOwn(previous => ({ ...previous, open: !previous.open }))}>Use your own app ID</button>
    </div>
    {own.open && <div id="dr-own" className="dr-own">
      <p className="t-caption">{backend === 'drive' ? 'Recommended for Google Drive: your own app has its own request limits.' : 'Your own app has its own request limits.'} Enter both, then use the sign-in link again.</p>
      <div className="form-grid">
        <label className="field"><span>Client ID</span><input value={own.id} autoComplete="off" spellCheck={false} maxLength={400} onChange={e => setOwn(previous => ({ ...previous, id: e.target.value }))} /></label>
        <label className="field"><span>Client secret</span><input type="password" value={own.secret} autoComplete="new-password" spellCheck={false} maxLength={400} onChange={e => setOwn(previous => ({ ...previous, secret: e.target.value }))} /></label>
      </div>
      <div className="dr-own-actions"><button type="button" className="link-action" disabled={!ownReady || disabled} onClick={applyOwn}>Use this app</button>{own.applied && <span className="t-caption" role="status">Using your own app.</span>}</div>
    </div>}
  </div>;
});
