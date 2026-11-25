import React, { useEffect, useRef, useState } from 'react';
import { IconX } from '@tabler/icons-react';
import { SeverityIcon } from './SeverityMark.jsx';
import { useToasts, toasts } from './toast-store.js';
import { visibleToasts, ttlFor } from './model.js';
import './notifications.css';

// One toast. It clears itself after its time (none for errors) and the clock stops while the pointer or the keyboard is
// on the stack, then continues with the time that was left.
function Toast({ toast, paused, onClose }) {
  const ttl = ttlFor(toast.severity), left = useRef(ttl), started = useRef(0);
  useEffect(() => {
    if (ttl === null || paused) return undefined;
    started.current = Date.now();
    const timer = setTimeout(onClose, Math.max(300, left.current));
    return () => { clearTimeout(timer); left.current = Math.max(300, left.current - (Date.now() - started.current)); };
  }, [paused, toast]);
  return <div className={'nc-toast nc-toast-' + toast.severity} role={toast.severity === 'error' ? 'alert' : 'status'}>
    <SeverityIcon severity={toast.severity} />
    <div className="nc-toast-text"><b>{toast.title}</b>{toast.body && <span>{toast.body}</span>}</div>
    {toast.actions?.map(action => <button key={action.label} type="button" className="nc-link" onClick={() => { action.onClick?.(); onClose(); }}>{action.label}</button>)}
    <button type="button" className="nc-iconbtn" aria-label={'Dismiss ' + toast.title} onClick={onClose}><IconX size={18} aria-hidden="true" /></button>
  </div>;
}

// Max three toasts, the newest at the bottom; older ones are counted in "+N more", which opens the notification centre.
export function ToastStack({ onOpenCenter }) {
  const list = useToasts(), [paused, setPaused] = useState(false), { shown, hidden } = visibleToasts(list);
  if (!list.length) return null;
  return <div className="toast-wrap nc-toasts" role="region" aria-label="Notifications" aria-live="polite" aria-relevant="additions" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
    {hidden > 0 && <button type="button" className="nc-more" onClick={() => { for (const toast of list) if (toast.notificationId) toasts.dismiss(toast.key); onOpenCenter?.(); }}>+{hidden} more</button>}
    {shown.map(toast => <Toast key={toast.key} toast={toast} paused={paused} onClose={() => toasts.dismiss(toast.key)} />)}
  </div>;
}
