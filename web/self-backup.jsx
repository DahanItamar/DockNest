import {timeZoneOptions} from './time-zones.js';
import React,{useEffect,useState} from 'react';
import { BrandIcon } from './brand.jsx';
import { ScheduleFields } from './schedule-fields.jsx';
import { formatDate } from './date-format.js';
import './self-backup.css';

function RecoverySettings({settings,Field,busy,onSave}){
 const [enabled,setEnabled]=useState(settings?.enabled||false),[error,setError]=useState('');
 async function submit(event){
  event.preventDefault();setError('');const fields=Object.fromEntries(new FormData(event.currentTarget));
  if(fields.passphrase!==fields.confirmPassphrase){setError('Recovery passphrases do not match.');return;}
  if(await onSave({enabled,schedule:fields.schedule||settings?.schedule||'0 3 * * *',timezone:fields.timezone||settings?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',recoverySecretSaved:fields.recoverySecretSaved==='on',...(fields.passphrase?{passphrase:fields.passphrase}:{})}))event.target.reset();
 }
 return <section className="panel backup-settings"><div className="backup-card-head"><span className="backup-card-icon"><BrandIcon name="access" size={20}/></span><h2>Recovery settings</h2></div><p>Save a separate passphrase in your password manager. You’ll need it to open your recovery kit.</p><form onSubmit={submit}><fieldset disabled={busy}>
  <div className="backup-passphrases"><Field label={settings?.hasPassphrase?'New recovery passphrase (optional)':'Recovery passphrase'} name="passphrase" type="password" autoComplete="new-password" minLength={24} maxLength={4096} required={!settings?.hasPassphrase} help={settings?.hasPassphrase?'At least 24 characters. Leave blank to keep your current passphrase.':'At least 24 characters.'}/><Field label="Confirm recovery passphrase" name="confirmPassphrase" type="password" autoComplete="new-password" maxLength={4096} required={!settings?.hasPassphrase}/></div>
  <label className="check"><input name="recoverySecretSaved" type="checkbox" required/> I saved my recovery passphrase separately from DockNest.</label>
  <div className="backup-schedule-control"><label className="check"><input type="checkbox" checked={enabled} onChange={event=>setEnabled(event.target.checked)}/> Back up DockNest automatically</label><small>{enabled?'Upload a fresh kit to the destination selected for your site backups.':'Manual backups only. You can add a schedule anytime.'}</small></div>
  {enabled&&<><ScheduleFields Field={Field} initialSchedule={settings?.schedule||'0 3 * * *'}/><Field label="Time zone" name="timezone" defaultValue={settings?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'} required className="dn-zone-select" options={timeZoneOptions(settings?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC')}/></>}
  {error&&<div className="alert" role="alert">{error}</div>}<div className="form-actions"><button className="primary" disabled={busy}>{busy?'Working…':'Save recovery settings'}</button></div>
 </fieldset></form></section>;
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
  <section className="panel backup-intro"><span className="backup-intro-icon"><BrandIcon name="backups" size={26}/></span><div><h2>One recovery kit for DockNest</h2><p>Connections, accounts, schedules and your master key, encrypted together. A failed replacement keeps your last successful copy.</p></div><span className="backup-retention">1 successful copy</span></section>
  {error&&<div className="alert" role="alert">{error}</div>}{notice&&<div className="backup-feedback notice" role="status"><BrandIcon name="readiness" size={18}/>{notice}</div>}
  {!data?<p role="status">Loading DockNest backup settings…</p>:<>
   <div className="self-backup-grid"><section className="panel backup-summary"><div className="backup-card-head"><span className="backup-card-icon"><BrandIcon name="backups" size={20}/></span><h2>Latest recovery kit</h2></div>
    <span className={'backup-state '+(data.active?'pending':latest?'ready':'empty-state')}><i aria-hidden="true"/>{data.active?(data.active.status==='queued'?'Queued for backup':'Creating recovery kit'):latest?'Ready to download':'No backup yet'}</span>
    {data.active&&<p role="status">{data.active.status==='queued'?'The worker will create your encrypted kit.':'Creating your encrypted DockNest recovery kit…'}</p>}{data.lastAttempt?.status==='failed'&&<div className="alert" role="alert">{data.lastAttempt.error}</div>}
    {latest?<dl className="backup-facts"><div><dt>Last saved</dt><dd>{formatDate(latest.finishedAt)}</dd></div><div><dt>File size</dt><dd>{(latest.size/1024).toFixed(1)} KB</dd></div><div><dt>App version</dt><dd>{latest.release}</dd></div><div><dt>Integrity</dt><dd>Checksum checked</dd></div></dl>:<p className="backup-empty-copy">Set your recovery passphrase, then create your first DockNest backup.</p>}
    <div className="backup-location"><BrandIcon name="storage" size={20}/><div><b>{latest?.storage?.mode==='local'?'Previous local copy':latest?.storage?.name||data.destination?.name||'Connect storage first'}</b><p>{latest?.storage?.mode==='local'?'Create a new backup to upload your kit to connected storage.':data.destination?.available?'Encrypted kit stored with your site backups, in a separate folder.':'Select a connected SFTP destination on the Storage page.'}</p></div></div>
    {latest?.storage?.mode==='sftp'&&data.destination?.available&&latest.storage.name!==data.destination.name&&<p className="backup-next">New backups use {data.destination.name}.</p>}
    {data.settings?.enabled&&<p className="backup-next">Next backup: {formatDate(data.settings.nextRun)}.</p>}
    <div className="backup-actions"><button className="primary" disabled={working||!data.settings?.hasPassphrase||!data.destination?.available} onClick={()=>run('/self-backup/run',{},'DockNest backup queued. Progress appears here.')}><BrandIcon name="backups" size={18}/>Back up DockNest now</button><button disabled={busy||!latest} onClick={download}><BrandIcon name="download" size={18}/>Download recovery kit</button></div>
    {latest&&<details className="backup-checksum"><summary>File checksum</summary><code>{latest.checksum}</code></details>}
   </section>
   <RecoverySettings key={JSON.stringify([data.settings?.enabled,data.settings?.schedule,data.settings?.timezone,data.settings?.hasPassphrase])} settings={data.settings} Field={Field} busy={working} onSave={body=>run('/self-backup/settings',body,'Recovery settings saved.')}/></div>
   <section className="panel backup-guide"><details><summary><BrandIcon name="restore" size={20}/><span>Recovery guide and what’s included</span></summary><div className="backup-guide-body"><h3>What you’re saving</h3><p>Server and storage connections, accounts, schedules, backup catalog, history, master key and recovery helpers. Website backup files stay in their existing storage destinations.</p>{data.destination?.available&&<p>New recovery kits go to {data.destination.name} under <code>{data.destination.recoveryDirectory}/</code>. Each filename identifies this DockNest installation.</p>}<h3>Recover after losing the server</h3><p>Keep your storage sign-in details, recovery passphrase, matching DockNest image or source and private deployment configuration separately. Download the saved kit from SFTP and use it on a new Linux Docker server. Import into a new private data directory using the recovery-kit command. Sessions are revoked and schedules are paused for review.</p><p>File integrity is checked; fresh-server Linux Docker recovery has not been validated. A single copy cannot undo an older configuration mistake after a replacement.</p><p>Changing the passphrase affects future kits. The existing kit needs its original passphrase until a replacement succeeds.</p></div></details></section>
  </>}
 </div>;
}
