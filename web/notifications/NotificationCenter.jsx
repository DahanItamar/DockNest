import React, { useCallback, useEffect, useRef, useState } from 'react';
import { IconCheck, IconArchive, IconArchiveOff, IconArrowRight, IconBellOff } from '@tabler/icons-react';
import { SeverityIcon, SeverityLabel } from './SeverityMark.jsx';
import { age } from '../age.js';
import { SEVERITIES, SEVERITY_LABEL, TABS, tabCount, linkTarget, signature } from './model.js';
import './notifications.css';

const PAGE = 25;
const EMPTY = { all: 'No notifications yet. Backups, restores and problems will show up here.', needs_action: 'Nothing needs your attention.', backups: 'No backup or restore notifications.', storage: 'No storage notifications.', system: 'No system notifications.', archived: 'Nothing archived.' };

// The notification centre (Operations). Reads its own list when the tab, a filter or the app's existing 5 s state changes
// (`summary`); it has no timer of its own.
export function NotificationCenter({ api, summary, onOpenItem, onChanged, onSessionExpired }) {
  const [tab, setTab] = useState('all'), [severity, setSeverity] = useState(''), [unreadOnly, setUnreadOnly] = useState(false), [limit, setLimit] = useState(PAGE);
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), tabs = useRef({});
  const query = `?tab=${tab}&limit=${limit}${severity ? '&severity=' + severity : ''}${unreadOnly ? '&unread=1' : ''}`;
  const load = useCallback(async () => {
    try { setData(await api('/notifications' + query)); setError(''); }
    catch (e) { if (e.status === 401) onSessionExpired?.(); else setError(e.message || 'Notifications could not be loaded.'); }
  }, [api, query]);
  useEffect(() => { load(); }, [load, signature(summary)]);
  useEffect(() => { setLimit(PAGE); }, [tab, severity, unreadOnly]);
  async function act(path, ids) {
    setBusy(true);
    try { await api(path, ids ? { ids } : {}); await load(); onChanged?.(); }
    catch (e) { if (e.status === 401) onSessionExpired?.(); else setError(e.message || 'That did not work. Try again.'); }
    finally { setBusy(false); }
  }
  const items = data?.items ?? [], counts = data?.counts, anyUnread = items.some(item => !item.read);
  function onKey(event) {
    const index = TABS.findIndex(([id]) => id === tab), next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); const id = TABS[(next + TABS.length) % TABS.length][0]; setTab(id); tabs.current[id]?.focus();
  }
  return <section className="panel nc-page" aria-label="Notification center">
    <div className="tabs nc-tabs" role="tablist" aria-label="Notification folders" onKeyDown={onKey}>
      {TABS.map(([id, label]) => { const count = tabCount(counts, id); return <button key={id} ref={element => { tabs.current[id] = element; }} type="button" role="tab" id={'nc-tab-' + id} aria-selected={tab === id} aria-controls="nc-list" tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>{label}{count > 0 && id !== 'archived' && <span className="nc-tab-count" aria-label={`${count} unread`}>{count}</span>}</button>; })}
    </div>
    <div className="nc-toolbar">
      <label className="nc-filter"><span>Severity</span><select value={severity} onChange={event => setSeverity(event.target.value)}><option value="">All severities</option>{SEVERITIES.map(item => <option key={item} value={item}>{SEVERITY_LABEL[item]}</option>)}</select></label>
      <label className="nc-check"><input type="checkbox" checked={unreadOnly} onChange={event => setUnreadOnly(event.target.checked)} /> Unread only</label>
      <span className="nc-spacer" />
      {tab !== 'archived' && <button type="button" className="nc-link" disabled={busy || !(summary?.unread > 0 || anyUnread)} onClick={() => act('/notifications/read-all')}><IconCheck size={16} aria-hidden="true" /> Mark all read</button>}
    </div>
    {error && <p className="nc-error" role="alert"><SeverityIcon severity="error" size={16} /> {error}</p>}
    <div id="nc-list" role="tabpanel" aria-labelledby={'nc-tab-' + tab}>
      {!data && !error ? <p className="nc-empty" role="status">Loading notifications</p> : items.length === 0 ? <div className="nc-empty"><IconBellOff size={24} aria-hidden="true" /><p>{severity || unreadOnly ? 'Nothing matches these filters.' : EMPTY[tab]}</p></div> : <ul className="nc-list">
        {items.map(item => { const target = linkTarget(item.link); return <li key={item.id} className={'nc-row' + (item.read ? '' : ' unread')}>
          <SeverityIcon severity={item.severity} />
          <div className="nc-row-main">
            <div className="nc-row-head"><b>{item.title}</b>{item.count > 1 && <span className="nc-times">{item.count} times</span>}{!item.read && <span className="nc-dot" role="img" aria-label="Unread" />}</div>
            <p>{item.body}</p>
            <div className="nc-row-meta"><SeverityLabel severity={item.severity} /><time dateTime={item.lastAt} title={new Date(item.lastAt).toLocaleString()}>{age(item.lastAt)}</time></div>
          </div>
          <div className="nc-row-actions">
            {target && <button type="button" className="nc-link strong" onClick={() => { if (!item.read) act('/notifications/read', [item.id]); onOpenItem?.(item, true); }}>{target.label}<IconArrowRight size={16} aria-hidden="true" /></button>}
            {!item.read && tab !== 'archived' && <button type="button" className="nc-link" disabled={busy} onClick={() => act('/notifications/read', [item.id])}><IconCheck size={16} aria-hidden="true" /> Mark read</button>}
            {item.archived ? <button type="button" className="nc-link" disabled={busy} onClick={() => act('/notifications/unarchive', [item.id])}><IconArchiveOff size={16} aria-hidden="true" /> Unarchive</button> : <button type="button" className="nc-link" disabled={busy} onClick={() => act('/notifications/archive', [item.id])}><IconArchive size={16} aria-hidden="true" /> Archive</button>}
          </div>
        </li>; })}
      </ul>}
      {data && items.length < data.total && <div className="nc-more-row"><button type="button" className="nc-link strong" onClick={() => setLimit(limit + PAGE)}>Show more ({data.total - items.length} left)</button></div>}
    </div>
  </section>;
}
