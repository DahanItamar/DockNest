import React, { useCallback, useEffect, useRef, useState } from 'react';
import { IconCheck, IconChecks, IconArchive, IconArchiveOff, IconArrowRight, IconBellOff, IconChevronDown, IconFilter } from '@tabler/icons-react';
import { Sheet, Choices } from './Sheet.jsx';
import { SeverityIcon, SeverityLabel } from './SeverityMark.jsx';
import { age } from '../age.js';
import { formatDate } from '../date-format.js';
import { SEVERITIES, SEVERITY_LABEL, TABS, tabCount, linkTarget, signature } from './model.js';
import './notifications.css';

const PAGE = 25;
// Below 640 px the folders become one selector and the filters one sheet, so nothing wraps or is cut off.
const useNarrow = () => {
  const query = '(max-width: 639px)', [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => { const list = matchMedia(query), change = () => setNarrow(list.matches); list.addEventListener('change', change); return () => list.removeEventListener('change', change); }, []);
  return narrow;
};
const UnreadSwitch = ({ on, onChange }) => <span className="nc-switch"><span id="nc-unread-label">Unread only</span><button type="button" role="switch" className="switch" aria-checked={on} aria-labelledby="nc-unread-label" onClick={() => onChange(!on)}><span /></button></span>;
const EMPTY = { all: 'No notifications yet. Backups, restores and problems will show up here.', needs_action: 'Nothing needs your attention.', backups: 'No backup or restore notifications.', storage: 'No storage notifications.', system: 'No system notifications.', archived: 'Nothing archived.' };

// The notification centre (Operations). Reads its own list when the tab, a filter or the app's existing 5 s state changes
// (`summary`); it has no timer of its own.
export function NotificationCenter({ api, summary, onOpenItem, onChanged, onSessionExpired }) {
  const [tab, setTab] = useState('all'), [severity, setSeverity] = useState(''), [unreadOnly, setUnreadOnly] = useState(false), [limit, setLimit] = useState(PAGE);
  const narrow = useNarrow(), [sheet, setSheet] = useState(null), [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), tabs = useRef({});
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
  const items = data?.items ?? [], counts = data?.counts, anyUnread = items.some(item => !item.read), canMarkAll = summary?.unread > 0 || anyUnread, filtered = Boolean(severity) || unreadOnly;
  function onKey(event) {
    const index = TABS.findIndex(([id]) => id === tab), next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); const id = TABS[(next + TABS.length) % TABS.length][0]; setTab(id); tabs.current[id]?.focus();
  }
  return <section className="panel nc-page" aria-label="Notification center">
    {narrow ? <div className="nc-toolbar nc-toolbar-narrow">
      <button type="button" className="nc-folder" aria-haspopup="dialog" onClick={() => setSheet('folder')}><b>{TABS.find(([id]) => id === tab)[1]}</b>{tab !== 'archived' && tabCount(counts, tab) > 0 && <span className="nc-muted">· {tabCount(counts, tab)}</span>}<IconChevronDown size={16} aria-hidden="true" /></button>
      <span className="nc-spacer" />
      <button type="button" className="nc-iconbtn nc-filterbtn" aria-label={filtered ? 'Filter, active' : 'Filter'} title="Filter" onClick={() => setSheet('filter')}><IconFilter size={20} aria-hidden="true" />{filtered && <span className="nc-dot" />}</button>
      {tab !== 'archived' && <button type="button" className="nc-iconbtn" aria-label="Mark all read" title="Mark all read" disabled={busy || !canMarkAll} onClick={() => act('/notifications/read-all')}><IconChecks size={20} aria-hidden="true" /></button>}
    </div> : <>
      <div className="tabs nc-tabs" role="tablist" aria-label="Notification folders" onKeyDown={onKey}>
        {TABS.map(([id, label]) => { const count = tabCount(counts, id); return <button key={id} ref={element => { tabs.current[id] = element; }} type="button" role="tab" id={'nc-tab-' + id} aria-selected={tab === id} aria-controls="nc-list" tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>{label}{count > 0 && id !== 'archived' && <span className="nc-tab-count" aria-label={`${count} unread`}>{count}</span>}</button>; })}
      </div>
      <div className="nc-toolbar">
        <label className="nc-filter"><span>Severity</span><select value={severity} onChange={event => setSeverity(event.target.value)}><option value="">All severities</option>{SEVERITIES.map(item => <option key={item} value={item}>{SEVERITY_LABEL[item]}</option>)}</select></label>
        <UnreadSwitch on={unreadOnly} onChange={setUnreadOnly} />
        <span className="nc-spacer" />
        {tab !== 'archived' && <button type="button" className="nc-link" disabled={busy || !canMarkAll} onClick={() => act('/notifications/read-all')}><IconChecks size={16} aria-hidden="true" /> Mark all read</button>}
      </div>
    </>}
    {sheet === 'folder' && <Sheet title="Folder" onClose={() => setSheet(null)}><Choices label="Folder" value={tab} options={TABS.map(([id, label]) => [id, label, id !== 'archived' && tabCount(counts, id) > 0 ? String(tabCount(counts, id)) : ''])} onChange={id => { setTab(id); setSheet(null); }} /></Sheet>}
    {sheet === 'filter' && <Sheet title="Filter" onClose={() => setSheet(null)}>
      <Choices label="Severity" value={severity} options={[['', 'All severities'], ...SEVERITIES.map(item => [item, SEVERITY_LABEL[item]])]} onChange={setSeverity} />
      <UnreadSwitch on={unreadOnly} onChange={setUnreadOnly} />
      <button type="button" className="nc-link strong nc-sheet-done" onClick={() => setSheet(null)}>Done</button>
    </Sheet>}
    {error && <p className="nc-error" role="alert"><SeverityIcon severity="error" size={16} /> {error}</p>}
    <div id="nc-list" role="tabpanel" aria-labelledby={'nc-tab-' + tab}>
      {!data && !error ? <p className="nc-empty" role="status">Loading notifications</p> : items.length === 0 ? <div className="nc-empty"><IconBellOff size={24} aria-hidden="true" /><p>{severity || unreadOnly ? 'Nothing matches these filters.' : EMPTY[tab]}</p></div> : <ul className="nc-list">
        {items.map(item => { const target = linkTarget(item.link); return <li key={item.id} className={'nc-row' + (item.read ? '' : ' unread')}>
          <SeverityIcon severity={item.severity} />
          <div className="nc-row-main">
            <div className="nc-row-head"><b>{item.title}</b>{item.count > 1 && <span className="nc-times">{item.count} times</span>}{!item.read && <span className="nc-dot" role="img" aria-label="Unread" />}</div>
            <p>{item.body}</p>
            <div className="nc-row-meta"><SeverityLabel severity={item.severity} /><time dateTime={item.lastAt} title={age(item.lastAt)}>{formatDate(item.lastAt, { shortTime: true })}</time></div>
          </div>
          <div className="nc-row-actions">
            {target && <button type="button" className="nc-link strong" aria-label={target.label} title={target.label} onClick={() => { if (!item.read) act('/notifications/read', [item.id]); onOpenItem?.(item, true); }}><span className="nc-label">{target.label}</span><IconArrowRight size={16} aria-hidden="true" /></button>}
            {!item.read && tab !== 'archived' && <button type="button" className="nc-link" aria-label="Mark read" title="Mark read" disabled={busy} onClick={() => act('/notifications/read', [item.id])}><IconCheck size={16} aria-hidden="true" /><span className="nc-label">Mark read</span></button>}
            {item.archived ? <button type="button" className="nc-link" aria-label="Unarchive" title="Unarchive" disabled={busy} onClick={() => act('/notifications/unarchive', [item.id])}><IconArchiveOff size={16} aria-hidden="true" /><span className="nc-label">Unarchive</span></button> : <button type="button" className="nc-link" aria-label="Archive" title="Archive" disabled={busy} onClick={() => act('/notifications/archive', [item.id])}><IconArchive size={16} aria-hidden="true" /><span className="nc-label">Archive</span></button>}
          </div>
        </li>; })}
      </ul>}
      {data && items.length < data.total && <div className="nc-more-row"><button type="button" className="nc-link strong" onClick={() => setLimit(limit + PAGE)}>Show more ({data.total - items.length} left)</button></div>}
    </div>
  </section>;
}
