import {timeZoneOptions} from './time-zones.js';
import {formatBytes} from '../shared/format-bytes.js';
import React,{useEffect,useState} from 'react';
import {IconMinus,IconPlus} from '@tabler/icons-react';
import { StatusLabel, AlertPanel } from './system.jsx';
import { ScheduleFields } from './schedule-fields.jsx';
import { formatDate } from './date-format.js';
import './self-backup.css';
import { ReportProblem } from './report/ReportProblem.jsx';
import { buildSelfBackupReport } from './report/builders.js';
import {catalogued,EXPLAIN} from './report/catalogue.js';

// The server records one of three fixed messages (src/self-backup.js); only which one it was is reported, never the text.
export function selfBackupFailureFacts(run){
 const text=typeof run?.error==='string'?run.error:'';
 return {destination:run?.storage?.mode,ended:text.startsWith('Worker interrupted.')?'worker-interrupted':/deployment/i.test(text)&&!text.startsWith('DockNest backup failed.')?'deployment-hold':'failed'};
}

function RecoverySettings({settings,Field,busy,onSave}){
 const [enabled,setEnabled]=useState(settings?.enabled||false),[error,setError]=useState('');
 async function submit(event){
  event.preventDefault();setError('');const fields=Object.fromEntries(new FormData(event.currentTarget));
  if(fields.passphrase!==fields.confirmPassphrase){setError('Recovery passphrases do not match.');return;}
  if(await onSave({enabled,schedule:fields.schedule||settings?.schedule||'0 3 * * *',timezone:fields.timezone||settings?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',recoverySecretSaved:fields.recoverySecretSaved==='on',...(fields.passphrase?{passphrase:fields.passphrase}:{})}))event.target.reset();
 }
 return <form className="card backup-settings" onSubmit={submit} aria-labelledby="sb-settings-title"><div className="card-body sb-stack"><h2 className="card-title" id="sb-settings-title">Recovery settings</h2><p className="t-body sb-quiet">Save a separate passphrase in your password manager. You’ll need it to open your recovery kit.</p>
  <fieldset disabled={busy} className="sb-fields">
  <div className="backup-passphrases"><Field label={settings?.hasPassphrase?'New recovery passphrase (optional)':'Recovery passphrase'} name="passphrase" type="password" autoComplete="new-password" minLength={24} maxLength={4096} required={!settings?.hasPassphrase} help={settings?.hasPassphrase?'At least 24 characters. Leave blank to keep your current passphrase.':'At least 24 characters.'}/><Field label="Confirm recovery passphrase" name="confirmPassphrase" type="password" autoComplete="new-password" maxLength={4096} required={!settings?.hasPassphrase}/></div>
  <label className="check sb-saved"><input name="recoverySecretSaved" type="checkbox" required/> I saved my recovery passphrase separately from DockNest.</label>
  <div className="sb-switch-row"><span className="sb-switch-text"><span id="sb-auto-label" className="sb-switch-label">Back up DockNest automatically</span><span id="sb-auto-help" className="t-caption">{enabled?'Upload a fresh kit to the destination selected for your site backups.':'Manual backups only. You can add a schedule anytime.'}</span></span><button type="button" role="switch" className="switch" aria-checked={enabled} aria-labelledby="sb-auto-label" aria-describedby="sb-auto-help" onClick={()=>setEnabled(value=>!value)}></button></div>
  {enabled&&<><ScheduleFields Field={Field} initialSchedule={settings?.schedule||'0 3 * * *'}/><Field label="Time zone" name="timezone" defaultValue={settings?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'} required className="dn-zone-select" options={timeZoneOptions(settings?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC')}/></>}
  {error&&<AlertPanel variant="error">{error}</AlertPanel>}
  </fieldset></div><div className="card-footer sb-footer"><button className="primary" disabled={busy}>{busy?'Working…':'Save recovery settings'}</button></div></form>;
}
export function SelfBackup({api,Field,onSessionExpired}){
 const [data,setData]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 function failure(error){if(error.status===401)onSessionExpired();else setError(error.message);}
 useEffect(()=>{let mounted=true;const load=async()=>{try{const result=await api('/self-backup');if(mounted)setData(result);}catch(error){if(mounted)failure(error);}};load();const timer=setInterval(load,5000);return()=>{mounted=false;clearInterval(timer);};},[]);
 async function run(path,body,message){setBusy(true);setError('');setNotice('');try{await api(path,body);setNotice(message);setData(await api('/self-backup'));return true;}catch(error){failure(error);return false;}finally{setBusy(false);}}
 async function download(){
  setBusy(true);setError('');try{
   const response=await fetch('/api/self-backup/download',{credentials:'same-origin'});
   if(!response.ok){const body=await response.json();const error=new Error(body.error||'Download failed.');error.status=response.status;throw error;}
   const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download='docknest-recovery.dkit';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
   setNotice('Recovery kit downloaded. Keep its recovery passphrase separately.');
  }catch(error){failure(error);}finally{setBusy(false);}
 }
 const working=busy||!!data?.active,latest=data?.latest;
 return <div className="self-backup">
  <div className="sb-head"><p className="t-body sb-quiet">Connections, accounts, schedules and your master key, encrypted together. A failed replacement keeps your last successful copy.</p><span className="t-body sb-quiet sb-count">1 successful copy</span></div>
  {error&&<AlertPanel variant="error">{error}</AlertPanel>}{notice&&<div className="backup-feedback" role="status"><StatusLabel state="success">{notice}</StatusLabel></div>}
  {!data?<p role="status">Loading DockNest backup settings…</p>:<>
   <div className="card-grid sb-grid"><section className="card backup-summary" aria-labelledby="sb-latest-title"><div className="card-body sb-stack"><h2 className="card-title" id="sb-latest-title">Latest recovery kit</h2>
    <span className="sb-state">{data.active?<StatusLabel state="running">{data.active.status==='queued'?'Queued for backup':'Creating recovery kit'}</StatusLabel>:latest?<StatusLabel state="success">Ready to download</StatusLabel>:<StatusLabel state="queued">No backup yet</StatusLabel>}</span>
    {data.active&&<p className="t-body sb-quiet" role="status">{data.active.status==='queued'?'The worker will create your encrypted kit.':'Creating your encrypted DockNest recovery kit…'}</p>}{data.lastAttempt?.status==='failed'&&<AlertPanel variant="error" title="The last backup failed" action={<div className="rp-actions"><ReportProblem summary="DockNest backup" excerptSource={catalogued(data.lastAttempt?.error)||typeof data.lastAttempt?.error!=='string'?null:{error:data.lastAttempt.error}} excerptLabel="Include the error message" build={(facts,opts)=>buildSelfBackupReport({...facts,...opts,...selfBackupFailureFacts(data.lastAttempt),message:data.lastAttempt?.error,explanation:EXPLAIN.selfBackup})}/></div>}>{data.lastAttempt.error}</AlertPanel>}
    {latest?<dl className="def-list backup-facts"><div className="def-row"><dt>Last saved</dt><dd>{formatDate(latest.finishedAt)}</dd></div><div className="def-row"><dt>File size</dt><dd>{formatBytes(latest.size)}</dd></div><div className="def-row"><dt>App version</dt><dd>{latest.release}</dd></div><div className="def-row"><dt>Integrity</dt><dd>Checksum checked</dd></div>
     <div className="def-row backup-location"><dt>Stored on</dt><dd>{latest?.storage?.mode==='local'?'Previous local copy':latest?.storage?.name||data.destination?.name||'Connect storage first'}</dd></div></dl>:<><p className="t-body sb-quiet backup-empty-copy">Set your recovery passphrase, then create your first DockNest backup.</p>
     <dl className="def-list"><div className="def-row backup-location"><dt>Stored on</dt><dd>{data.destination?.name||'Connect storage first'}</dd></div></dl></>}
    <p className="t-caption">{latest?.storage?.mode==='local'?'Create a new backup to upload your kit to connected storage.':data.destination?.available?'Encrypted kit stored with your site backups, in a separate folder.':'Select a connected SFTP or S3 destination on the Storage page.'}{latest?.storage?.mode&&latest.storage.mode!=='local'&&data.destination?.available&&latest.storage.name!==data.destination.name?` New backups use ${data.destination.name}.`:''}{data.settings?.enabled?` Next backup: ${formatDate(data.settings.nextRun)}.`:''}</p>
    {latest&&<details className="backup-checksum"><summary>File checksum</summary><code>{latest.checksum}</code></details>}
   </div><div className="card-footer sb-footer"><button disabled={busy||!latest} onClick={download}>Download recovery kit</button><button className="primary" disabled={working||!data.settings?.hasPassphrase||!data.destination?.available} onClick={()=>run('/self-backup/run',{},'DockNest backup queued. Progress appears here.')}>Back up DockNest now</button></div>
   </section>
   <RecoverySettings key={JSON.stringify([data.settings?.enabled,data.settings?.schedule,data.settings?.timezone,data.settings?.hasPassphrase])} settings={data.settings} Field={Field} busy={working} onSave={body=>run('/self-backup/settings',body,'Recovery settings saved.')}/></div>
   <section className="card backup-guide"><details><summary><span>Recovery guide and what’s included</span><IconPlus className="backup-guide-plus" size={20} aria-hidden="true"/><IconMinus className="backup-guide-minus" size={20} aria-hidden="true"/></summary><div className="backup-guide-body"><h3>What you’re saving</h3><p>Server and storage connections, accounts, schedules, backup catalog, history, master key and recovery helpers. Website backup files stay in their existing storage destinations.</p>{data.destination?.available&&<p>New recovery kits go to {data.destination.name} under <code>{data.destination.recoveryDirectory}/</code>. Each filename identifies this DockNest installation.</p>}<h3>Recover after losing the server</h3><p>Keep your storage sign-in details, recovery passphrase, matching DockNest image or source and private deployment configuration separately. Download the saved kit from SFTP and use it on a new Linux Docker server. Import into a new private data directory using the recovery-kit command. Sessions are revoked and schedules are paused for review.</p><p>File integrity is checked; fresh-server Linux Docker recovery has not been validated. A single copy cannot undo an older configuration mistake after a replacement.</p><p>Changing the passphrase affects future kits. The existing kit needs its original passphrase until a replacement succeeds.</p></div></details></section>
  </>}
 </div>;
}
