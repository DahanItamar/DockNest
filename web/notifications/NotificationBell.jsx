import React, { useEffect, useRef, useState } from 'react';
import { NotificationSymbol } from '../brand.jsx';
import { SeverityIcon } from './SeverityMark.jsx';
import { age } from '../age.js';
import { badgeText } from './model.js';
import './notifications.css';

// The bell: the unread count, the running jobs as one pinned row, the newest four notifications, Mark all read and the
// link to the notification centre. It closes on a click outside and on Escape (focus goes back to the bell).
export function NotificationBell({ summary, active = [], onOpenItem, onMarkAllRead, onOpenCenter, onOpenJobs }) {
  const [open, setOpen] = useState(false), root = useRef(null), button = useRef(null);
  const unread = summary?.unread ?? 0, recent = summary?.recent ?? [];
  useEffect(() => {
    if (!open) return undefined;
    const outside = event => { if (root.current && !root.current.contains(event.target)) setOpen(false); };
    const escape = event => { if (event.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const close = fn => (...args) => { setOpen(false); return fn?.(...args); };
  const label = unread > 0 ? `Notifications, ${unread} unread` : active.length ? `Notifications, ${active.length} running` : 'Notifications';
  return <div className="berry-notifications nc-bell" ref={root}>
    <button type="button" ref={button} className="berry-bell" aria-label={label} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
      <NotificationSymbol />{unread > 0 ? <span className="nc-count" aria-hidden="true">{badgeText(unread)}</span> : active.length > 0 && <i />}
    </button>
    {open && <section className="berry-popover nc-popover" role="dialog" aria-label="Notifications">
      <header><h2>Notifications</h2>{unread > 0 && <button type="button" className="nc-link" onClick={() => onMarkAllRead?.()}>Mark all read</button>}</header>
      {active.length > 0 && <button type="button" className="nc-pinned" onClick={close(onOpenJobs)}>
        <span className="nc-spinner" aria-hidden="true" /><span className="nc-pinned-text"><b>{active.length === 1 ? '1 job running' : `${active.length} jobs running`}</b><small>{active.slice(0, 2).map(job => (job.type === 'restore' ? 'Restore' : 'Backup') + ' ' + job.status).join(', ')}</small></span>
      </button>}
      {recent.length ? <ul className="nc-bell-list">{recent.map(item => <li key={item.id}>
        <button type="button" className={'nc-bell-item' + (item.read ? '' : ' unread')} onClick={close(() => onOpenItem?.(item))}>
          <SeverityIcon severity={item.severity} />
          <span className="nc-bell-text"><b>{item.title}</b><span>{item.body}</span><small>{age(item.lastAt)}{item.count > 1 ? ` · ${item.count} times` : ''}</small></span>
          {!item.read && <span className="nc-dot" role="img" aria-label="Unread" />}
        </button></li>)}</ul> : <p className="nc-bell-empty">{active.length ? 'Nothing else new.' : 'You are all caught up.'}</p>}
      <footer><button type="button" className="nc-link" onClick={close(onOpenCenter)}>Open notification center</button></footer>
    </section>}
  </div>;
}
