import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconUsers, IconPlus } from '@tabler/icons-react';
import { AlertPanel, EmptyState, StatusLabel } from '../system.jsx';
import { createClientsClient } from './client.js';
import { appNames, emailState, lastReportText } from './model.js';
import { ClientDialog } from './ClientDialog.jsx';
import { ReportPreview } from './ReportPreview.jsx';
import '../storage-targets.css';
import './clients.css';

// Operations, Clients (docs/client-reports.md): one card per client with its apps, its last report and the monthly email
// state. Administrators add, edit and delete clients; everyone can open a report and download its PDF. A viewer's API answer
// has no recipients and no schedule, so the card simply leaves the email line out. Loads once and after each change.
export function ClientsPage({ api, user, sites = [], openNew = 0, onOpenConnections, onSessionExpired, onPreview }) {
  const client = useMemo(() => createClientsClient(api), [api]);
  const [data, setData] = useState(null), [error, setError] = useState(null), [dialog, setDialog] = useState(null), [view, setView] = useState(null), [note, setNote] = useState('');
  const admin = user?.role === 'admin', opener = useRef(null);
  const load = useCallback(async () => {
    try { setData(await client.list()); setError(null); } catch (e) { if (e.status === 401) return onSessionExpired?.(); setError(e); }
  }, [client]);
  useEffect(() => { load(); }, [load]);
  // The header's Add client belongs to the list, so the page tells the shell when a report is open.
  useEffect(() => { onPreview?.(!!view); return () => onPreview?.(false); }, [!!view]);
  // A click on the header's Add client before the list has loaded is kept and opens the dialog once it has.
  const handled = useRef(openNew);
  useEffect(() => { if (openNew !== handled.current && data && admin) { handled.current = openNew; setDialog({ kind: 'new' }); } }, [openNew, data, admin]);
  const close = () => { setDialog(null); setTimeout(() => opener.current?.focus?.(), 0); };

  if (error && !data) return <div className="loading" role="alert">{error.message || 'Clients could not be loaded.'}<button type="button" onClick={load}>Retry</button></div>;
  if (!data) return <div className="loading" role="status">Loading clients…</div>;
  const clients = data.clients || [];
  if (view) {
    const current = clients.find(item => item.id === view.id);
    return current ? <ReportPreview key={current.id} client={client} item={current} admin={admin} onBack={() => setView(null)} onSessionExpired={onSessionExpired} /> : null;
  }
  return <div className="cl-page">
    {error && <AlertPanel variant="error" action={<button type="button" onClick={load}>Retry</button>}>{error.message || 'Clients could not be refreshed.'}</AlertPanel>}
    <div role="status" aria-live="polite">{note && <AlertPanel variant="success" onDismiss={() => setNote('')} dismissLabel="Dismiss">{note}</AlertPanel>}</div>
    {clients.length
      ? <div className="cl-grid">{clients.map(item => <ClientCard key={item.id} item={item} sites={sites} admin={admin}
        onEdit={event => { opener.current = event.currentTarget; setDialog({ kind: 'edit', item }); }} onReport={() => setView({ id: item.id })} />)}</div>
      : <section className="panel"><EmptyState icon={IconUsers} title="No clients yet" action={admin ? <button type="button" className="primary" onClick={event => { opener.current = event.currentTarget; setDialog({ kind: 'new' }); }}><IconPlus size={18} stroke={2} aria-hidden="true" />Add client</button> : undefined}>
        {admin ? 'A client is a person you look after apps for. Pick their apps and DockNest makes a monthly report you can send them.' : 'An administrator can add clients. You will see their reports here.'}</EmptyState></section>}
    {dialog && <ClientDialog key={dialog.item?.id || 'new'} client={client} item={dialog.item} sites={sites} onClose={close} onOpenConnections={onOpenConnections}
      onSaved={async (saved, created) => { close(); setNote(created ? `${saved.name} is added.` : `${saved.name} is saved.`); await load(); }}
      onDeleted={async name => { close(); setNote(`${name} is deleted. Their apps and backups are not changed.`); await load(); }} />}
  </div>;
}

function ClientCard({ item, sites, admin, onEdit, onReport }) {
  const mail = emailState(item), apps = appNames(item, sites);
  return <article className="card storage-card cl-card" aria-label={item.name}>
    <div className="storage-card-content">
      <h3 className="storage-card-head"><span className="icon-chip"><IconUsers size={20} stroke={1.5} aria-hidden="true" /></span><span className="storage-card-name cl-name" title={item.name} dir="auto">{item.name}</span></h3>
      {mail && <StatusLabel state={mail.state}>{mail.label}</StatusLabel>}
      <dl className="def-list">
        <div className="def-row"><dt>Apps ({item.apps.length})</dt><dd title={apps.names.join(', ')}>{apps.text}</dd></div>
        {mail && <div className="def-row"><dt>Last report</dt><dd>{lastReportText(item)}</dd></div>}
        {item.agency && <div className="def-row"><dt>Prepared by</dt><dd dir="auto">{item.agency}</dd></div>}
      </dl>
    </div>
    <div className="card-footer storage-card-actions">
      {admin && <button type="button" className="link-action" aria-label={'Edit ' + item.name} onClick={onEdit}>Edit</button>}
      <button type="button" className="link-action cl-strong" aria-label={'Make report for ' + item.name} onClick={onReport}>Make report</button>
    </div>
  </article>;
}
