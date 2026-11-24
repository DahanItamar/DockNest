import React, { useEffect, useMemo, useRef, useState } from 'react';
import { IconX, IconLock, IconPencil, IconTrash } from '@tabler/icons-react';
import { AlertPanel } from '../system.jsx';
import { Combo, SwitchRow } from '../connections/parts.jsx';
import { useReauth } from '../connections/ConnectionDialog.jsx';
import { timeZoneOptions } from '../time-zones.js';
import { ACCENTS, MAX_RECIPIENTS, accentVar, parseRecipients } from './model.js';

// New or edit client (docs/client-reports.md "Clients"). Name, apps, branding text, two privacy ticks (both off), the monthly
// email (Connection, time zone, up to 3 recipients) and Save as the one main button. Saved recipients are shown masked and
// replaced as a whole; changing them asks for a fresh sign-in check, which the shared re-verify step handles. A modal dialog
// on desktop, a bottom sheet on phones.
export function ClientDialog({ client, item, sites, onClose, onSaved, onDeleted, onOpenConnections }) {
  const edit = !!item, ref = useRef(null), nameRef = useRef(null), guard = useReauth(client);
  const [name, setName] = useState(item?.name || ''), [apps, setApps] = useState(() => new Set(item?.apps || [])), [filter, setFilter] = useState('');
  const [agency, setAgency] = useState(item?.agency || ''), [contact, setContact] = useState(item?.contact || ''), [accent, setAccent] = useState(item?.accent || 'default');
  const [serverNames, setServerNames] = useState(!!item?.include?.serverNames), [findingTitles, setFindingTitles] = useState(!!item?.include?.findingTitles);
  const [enabled, setEnabled] = useState(!!item?.schedule?.enabled), [connectionId, setConnectionId] = useState(item?.schedule?.connectionId || '');
  const [timezone, setTimezone] = useState(item?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const saved = item?.recipients || [], [replacing, setReplacing] = useState(!saved.length), [recipientText, setRecipientText] = useState('');
  const [connections, setConnections] = useState(null), [connectionsError, setConnectionsError] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(null), [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal(); nameRef.current?.focus(); return () => { if (d?.open) d.close(); }; }, []);
  useEffect(() => {
    let live = true;
    client.connections().then(result => { if (live) setConnections((result.connections || []).filter(c => c.provider === 'email')); }).catch(e => { if (live) { setConnections([]); setConnectionsError(e.code === 'ALERTS_ADMIN_REQUIRED' ? 'Email Connections are not available to you.' : e.message || 'Email connections could not be loaded.'); } });
    return () => { live = false; };
  }, [client]);

  const recipients = useMemo(() => parseRecipients(recipientText), [recipientText]);
  const zones = useMemo(() => timeZoneOptions(timezone).map(([value, label]) => ({ value, label })), [timezone]);
  const shownApps = sites.filter(site => site.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const emailItems = (connections || []).map(c => ({ value: c.id, label: c.name }));
  const typed = replacing && recipientText.trim().length > 0;
  const issues = [
    !name.trim() && 'Give the client a name.',
    enabled && !connectionId && 'Choose an email connection for the monthly report.',
    enabled && !typed && !saved.length && 'Add at least one recipient for the monthly report.',
    typed && recipients.error,
  ].filter(Boolean);
  const toggle = id => setApps(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const fail = e => { setError(e.message || 'This did not work. Try again.'); };

  async function save() {
    if (issues.length || busy) return;
    setBusy(true); setError(null);
    await guard.run(async () => {
      // Apps that were removed from DockNest stay out of the list; recipients go only when typed (saved ones are never sent back).
      const body = { name: name.trim(), agency: agency.trim() || null, contact: contact.trim() || null, accent, include: { serverNames, findingTitles }, apps: [...apps].filter(id => sites.some(site => site.id === id)), timezone, scheduleEnabled: enabled, connectionId: connectionId || null, ...(typed ? { recipients: recipients.list } : {}) };
      const result = edit ? await client.update(item.id, body) : await client.create(body);
      await onSaved(result, !edit);
    }, fail);
    setBusy(false);
  }
  async function remove() {
    setBusy(true); setError(null);
    try { await client.remove(item.id); await onDeleted(item.name); } catch (e) { fail(e); setConfirmDelete(false); }
    setBusy(false);
  }
  const why = busy ? '' : issues[0] || '';
  return <dialog ref={ref} className="site-wizard rt-dialog cx-dialog cl-dialog" aria-labelledby="cl-dialog-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <div className="modal-head"><h2 id="cl-dialog-title">{edit ? 'Edit client' : 'Add client'}</h2><button type="button" className="icon" aria-label="Close dialog" onClick={onClose}><IconX size={20} /></button></div>
    <form className="modal-body cx-form" onSubmit={e => { e.preventDefault(); save(); }} noValidate>
      <label className="field"><span>Client name</span><input ref={nameRef} value={name} maxLength={80} autoComplete="off" required dir="auto" aria-invalid={!name.trim() && error ? 'true' : undefined} onChange={e => setName(e.target.value)} /></label>

      <fieldset className="cl-group"><legend>Apps in the report</legend>
        {sites.length > 0 ? <>
          <input className="cl-search" type="search" aria-label="Search apps" placeholder="Search apps" autoComplete="off" value={filter} onChange={e => setFilter(e.target.value)} />
          <ul className="cl-apps">{shownApps.map(site => <li key={site.id}><label className="check"><input type="checkbox" checked={apps.has(site.id)} onChange={() => toggle(site.id)} /> <span dir="auto">{site.name}</span></label></li>)}</ul>
          {!shownApps.length && <p className="t-caption" role="status">Nothing matches this search.</p>}
          <p className="t-caption">{apps.size === 0 ? 'No apps chosen yet.' : apps.size + (apps.size === 1 ? ' app chosen.' : ' apps chosen.')} An app can be in more than one client.</p>
        </> : <p className="t-caption">Add an app first, then choose it here.</p>}
      </fieldset>

      <fieldset className="cl-group"><legend>Branding</legend>
        <label className="field"><span>Your agency name</span><input value={agency} maxLength={80} autoComplete="off" dir="auto" onChange={e => setAgency(e.target.value)} /><small>Shown as “Prepared by”. Text only.</small></label>
        <label className="field"><span>Contact line</span><input value={contact} maxLength={120} autoComplete="off" dir="auto" onChange={e => setContact(e.target.value)} /><small>One line of text, for example a website or phone number.</small></label>
        <div className="field" role="radiogroup" aria-labelledby="cl-accent-l"><span id="cl-accent-l">Accent</span>
          <div className="cl-swatches">{ACCENTS.map(([value, label]) => <label key={value} className={'cl-swatch' + (accent === value ? ' is-on' : '')}><input type="radio" name="cl-accent" value={value} checked={accent === value} onChange={() => setAccent(value)} /><span className="cl-dot" style={{ background: `var(${accentVar(value)})` }} aria-hidden="true" /><span>{label}</span></label>)}</div>
        </div>
      </fieldset>

      <fieldset className="cl-group cl-privacy"><legend>What the report may show</legend>
        <label className="check"><input type="checkbox" checked={serverNames} onChange={e => setServerNames(e.target.checked)} /> Server names</label>
        <label className="check"><input type="checkbox" checked={findingTitles} onChange={e => setFindingTitles(e.target.checked)} /> Hardening finding titles</label>
        <p className="t-caption">Addresses, logins, keys, storage paths and container names are never in a report.</p>
      </fieldset>

      <SwitchRow id="cl-monthly" label="Monthly email" help="Last month’s report, sent on day 1 at 08:00." checked={enabled} onChange={() => setEnabled(value => !value)} />
      {enabled && <>
        <div className="form-grid">
          <div className="field" role="group" aria-labelledby="cl-conn-l"><span id="cl-conn-l">Email connection</span>
            <Combo labelledBy="cl-conn-l" items={emailItems} value={connectionId} onChange={setConnectionId} placeholder={connections === null ? 'Loading…' : 'Choose a connection'} disabled={connections === null || !emailItems.length}
              invalid={enabled && !connectionId && !!error} />
            {connections && !emailItems.length && <small>{connectionsError || 'No email connection yet.'} {onOpenConnections && !connectionsError && <button type="button" className="link-action" onClick={onOpenConnections}>Add one in Connections</button>}</small>}
          </div>
          <div className="field" role="group" aria-labelledby="cl-zone-l"><span id="cl-zone-l">Time zone</span><Combo labelledBy="cl-zone-l" search searchLabel="Search time zones" items={zones} value={timezone} onChange={setTimezone} /></div>
        </div>
        <div className="field" role="group" aria-labelledby="cl-rcpt-l"><span id="cl-rcpt-l">Recipients</span>
          {saved.length > 0 && !replacing
            ? <div className="cx-saved cl-saved"><span><IconLock size={18} stroke={1.75} aria-hidden="true" />{saved.slice(0, MAX_RECIPIENTS).join(', ')}</span><button type="button" className="icon-button" aria-label="Replace recipients" title="Replace recipients" onClick={() => setReplacing(true)}><IconPencil size={18} stroke={1.75} aria-hidden="true" /></button></div>
            : <textarea rows={3} value={recipientText} autoComplete="off" spellCheck={false} aria-labelledby="cl-rcpt-l" aria-describedby="cl-rcpt-help" aria-invalid={typed && recipients.error ? 'true' : undefined} onChange={e => setRecipientText(e.target.value)} />}
          <small id="cl-rcpt-help" className={typed && recipients.error ? 'cl-bad' : undefined}>{typed && recipients.error ? recipients.error : `Up to ${MAX_RECIPIENTS}, one per line. Changing them asks you to confirm it is you.`}</small>
          {saved.length > 0 && replacing && <button type="button" className="link-action cl-keep" onClick={() => { setReplacing(false); setRecipientText(''); }}>Keep the saved recipients</button>}
        </div>
      </>}
      {error && <AlertPanel variant="error">{error}</AlertPanel>}
      {guard.box}
      {confirmDelete && <AlertPanel variant="warning" title={`Delete ${item.name}?`} action={<div className="cl-confirm"><button type="button" className="link-action" onClick={() => setConfirmDelete(false)}>Keep</button><button type="button" className="primary" disabled={busy} onClick={remove}>Delete client</button></div>}>The client and its report settings are removed. Their apps and backups are not changed.</AlertPanel>}
      <div className="modal-foot">
        {edit && !confirmDelete ? <button type="button" className="link-action cl-delete" onClick={() => setConfirmDelete(true)}><IconTrash size={18} stroke={1.75} aria-hidden="true" />Delete</button> : null}
        <span className="t-caption rt-why" role="status">{why}</span>
        <button className="link-action" type="button" onClick={onClose}>Cancel</button>
        <button className="primary" type="submit" aria-disabled={busy || guard.waiting || issues.length > 0 ? 'true' : undefined}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  </dialog>;
}
