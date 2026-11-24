import React, { useEffect, useMemo, useState } from 'react';
import { IconArrowLeft, IconFileTypePdf, IconSend } from '@tabler/icons-react';
import { AlertPanel, StatusLabel } from '../system.jsx';
import { Combo } from '../connections/parts.jsx';
import { DataTable } from '../data-table.jsx';
import { dayText, monthChoices, previewRow, summaryText } from './model.js';
import { saveBlob } from './client.js';

// Report preview (docs/client-reports.md "What a report holds"): the period, one row per app with backups, restore test,
// recovery time and state, then Download PDF as the main button and Send test email as a quiet link. The numbers come from
// the API; nothing here is computed from other data. Sending is administrators only and asks first, because it goes to the
// client's own recipients.
export function ReportPreview({ client, item, admin, onBack, onSessionExpired }) {
  const choices = useMemo(() => monthChoices(item.timezone), [item.timezone]);
  const [period, setPeriod] = useState(choices[1]?.value || choices[0].value), [report, setReport] = useState(null), [error, setError] = useState(''), [run, setRun] = useState(0);
  const [busy, setBusy] = useState(false), [note, setNote] = useState(null), [confirm, setConfirm] = useState(false);
  const chosen = choices.find(choice => choice.value === period) || choices[0];
  useEffect(() => {
    let live = true; setReport(null); setError('');
    client.report(item.id, chosen.from, chosen.to).then(result => { if (live) setReport(result); })
      .catch(e => { if (!live) return; if (e.status === 401) return onSessionExpired?.(); setError(e.message || 'The report could not be loaded.'); });
    return () => { live = false; };
  }, [client, item.id, chosen.from, chosen.to, run]);

  async function download() {
    setBusy(true); setNote(null);
    try { const { blob, name } = await client.pdf(item.id, chosen.from, chosen.to); saveBlob(blob, name); setNote({ ok: true, text: 'The PDF is downloaded.' }); }
    catch (e) { if (e.status === 401) return onSessionExpired?.(); setNote({ ok: false, text: e.message }); }
    setBusy(false);
  }
  async function sendTest() {
    setBusy(true); setNote(null); setConfirm(false);
    try { const result = await client.sendTest(item.id); setNote({ ok: true, text: `Last month’s report (${result.period}) was sent to the recipients.` }); }
    catch (e) { if (e.status === 401) return onSessionExpired?.(); setNote({ ok: false, text: e.message || 'The test email could not be sent.' }); }
    setBusy(false);
  }
  const rows = report ? report.apps.map(previewRow) : [];
  const notes = rows.map(row => row.note).filter(Boolean);
  const canSend = admin && item.schedule?.connectionId && item.recipients?.length > 0;
  return <div className="cl-page">
    <div><button type="button" className="link-action cl-back" onClick={onBack}><IconArrowLeft size={18} stroke={1.75} aria-hidden="true" />All clients</button></div>
    <section className="panel cl-report" aria-labelledby="cl-report-title">
      <div className="cl-report-head">
        <div><h2 id="cl-report-title" className="t-section" dir="auto">{item.name} report</h2>
          {(item.agency || item.contact) && <p className="t-caption" dir="auto">{[item.agency && 'Prepared by ' + item.agency, item.contact].filter(Boolean).join(' · ')}</p>}</div>
        <div className="field cl-period" role="group" aria-labelledby="cl-period-l"><span id="cl-period-l">Period</span><Combo labelledBy="cl-period-l" items={choices.map(c => ({ value: c.value, label: c.label }))} value={period} onChange={value => { setPeriod(value); setNote(null); }} /></div>
      </div>
      <div className="cl-report-body" aria-live="polite" aria-busy={!report && !error}>
        {error && <AlertPanel variant="error" action={<button type="button" onClick={() => setRun(n => n + 1)}>Retry</button>}>{error}</AlertPanel>}
        {!report && !error && <p role="status" className="t-caption">Loading the report…</p>}
        {report && <>
          <p className="cl-summary">{item.apps.length === 0 ? 'This client has no apps yet. Edit the client to choose some.' : summaryText(report) + '. Certificates, hardening and domains are shown as of ' + dayText(report.madeAt) + '.'}</p>
          {rows.length > 0 && <DataTable headers={['App', 'Backups', 'Restore test', 'Recovery time', 'State']} columns={['22%', '16%', '24%', '20%', '18%']}>
            {rows.map(row => <tr key={row.name}><td><b dir="auto">{row.name}</b></td><td>{row.backups}</td><td><StatusLabel state={row.test.state}>{row.test.label}</StatusLabel></td><td>{row.recovery}</td><td><StatusLabel state={row.state}>{row.stateLabel}</StatusLabel></td></tr>)}
          </DataTable>}
          {report.removed?.length > 0 && <p className="t-caption">Removed from DockNest during this period: {report.removed.join(', ')}.</p>}
          {notes.map(text => <p key={text} className="t-caption" dir="auto">{text}</p>)}
        </>}
      </div>
      <div role="status" aria-live="polite" className="cl-notes">
        {note && <AlertPanel variant={note.ok ? 'success' : 'error'} onDismiss={() => setNote(null)} dismissLabel="Dismiss">{note.text}</AlertPanel>}
        {confirm && <AlertPanel variant="warning" title="Send last month’s report now?" action={<div className="cl-confirm"><button type="button" className="link-action" onClick={() => setConfirm(false)}>Cancel</button><button type="button" className="primary" disabled={busy} onClick={sendTest}>Send</button></div>}>It goes to {item.recipients.length} {item.recipients.length === 1 ? 'recipient' : 'recipients'} of this client: {item.recipients.join(', ')}.</AlertPanel>}
      </div>
      <div className="card-footer cl-foot">
        {admin && <button type="button" className="link-action" disabled={busy || !canSend} title={canSend ? undefined : 'Turn on the monthly email with a connection and recipients first.'} onClick={() => setConfirm(true)}><IconSend size={18} stroke={1.75} aria-hidden="true" />Send test email</button>}
        <button type="button" className="primary" disabled={busy || !report} onClick={download}><IconFileTypePdf size={18} stroke={1.75} aria-hidden="true" />{busy ? 'Working…' : 'Download PDF'}</button>
      </div>
    </section>
  </div>;
}
