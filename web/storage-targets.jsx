import React,{useEffect,useRef,useState} from 'react';
import {BrandIcon} from './brand.jsx';
import {ZipButton} from './zip-export.jsx';
import {AlertPanel,StatusLabel} from './system.jsx';
import {ReportProblem} from './report/ReportProblem.jsx';
import {buildStorageReport} from './report/builders.js';
import {catalogued,EXPLAIN} from './report/catalogue.js';
import './storage-targets.css';
import {Paginated} from './pagination.jsx';
import {formatDate} from './date-format.js';
import {splitFieldErrors,regionFromEndpoint,lockWarnings} from './storage-form.js';

function StorageTree({api,target,refreshKey,onSessionExpired}) {
 const [tree,setTree]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reload,setReload]=useState(0);
 useEffect(()=>{let current=true;setTree(null);setError('');api('/storage-targets/'+target.id+'/tree').then(result=>{if(current)setTree(result);}).catch(error=>{if(current){if(error.status===401)onSessionExpired();else setError(error.message);}});return()=>{current=false;};},[target.id,reload,refreshKey]);
 async function pin(backup){setBusy(true);setError('');try{await api('/backups/'+backup.id+'/pin',{pinned:!backup.pinned});setReload(value=>value+1);}catch(error){if(error.status===401)onSessionExpired();else setError(error.message);}finally{setBusy(false);}}
 const filename=file=>file.filename||file.relativePath?.split('/').at(-1)||'Encrypted backup';
 return <section className="panel padded">
  <h2>{target.name} · Backup folders</h2><p>Site backups are organized by server and site. DockNest recovery kits have their own folder.</p>
  {error&&<AlertPanel variant="error" action={<button onClick={()=>setReload(value=>value+1)}>Retry</button>}>{error}</AlertPanel>}
  {!tree&&!error&&<p role="status">Loading backup folders…</p>}
  {tree&&<>
   <p>New backups go under <code>{tree.managedRoot||tree.root}/</code>. Existing files show their recorded paths. Other files on the destination are not listed.</p>
   {tree.limited&&<p>Showing the latest 1,000 site backups. Use the backup library for other recovery points.</p>}
   <div className="backup-tree">
    {!tree.servers.length?<p>No site backups stored here yet.</p>:<Paginated rows={tree.servers} label="Storage servers" pageSize={5}>{servers=>servers.map(server=><details key={server.id} open>
     <summary>Server: {server.name}</summary>
     <Paginated rows={server.sites} label={'Storage sites on '+server.name} pageSize={5}>{sites=>sites.map(site=><details key={site.id} open>
      <summary>Site: {site.name}</summary>
      <Paginated rows={site.days.flatMap(day=>day.backups)} label={'Stored backups for '+site.name} pageSize={5}>{points=>points.map(backup=><div className="backup-tree-file" key={backup.id}>
       <div><b>{filename(backup)}</b><small>{formatDate(backup.capturedAt)} · {(backup.size/1024/1024).toFixed(1)} MB · {backup.verified?'Integrity checked':'Integrity unchecked'}{backup.pinned?' · Pinned':''}</small>{backup.relativePath&&<code>{backup.relativePath}</code>}</div>
       <div className="actions"><ZipButton backupId={backup.id} className="button" label={'Download full ZIP '+backup.id}>Full ZIP</ZipButton><a className="button" href={'/api/backups/'+backup.id+'/download'}>Encrypted backup</a><button disabled={busy} onClick={()=>pin(backup)}>{backup.pinned?'Unpin':'Pin'}</button></div>
      </div>)}</Paginated>
     </details>)}</Paginated>
    </details>)}</Paginated>}
    <details open><summary>docknest-recovery</summary>
     {!tree.recovery?.files.length?<p>No DockNest recovery kit stored here yet.</p>:<Paginated rows={tree.recovery.files} label="DockNest recovery kits" pageSize={5}>{files=>files.map(file=><div className="backup-tree-file" key={file.id}>
      <div><b>{filename(file)}</b><small>{formatDate(file.createdAt)} · {(file.size/1024/1024).toFixed(1)} MB · Encrypted recovery kit</small>{file.relativePath&&<code>{file.relativePath}</code>}</div>
      {file.downloadable&&<div className="actions"><a className="button" href="/api/self-backup/download">Download recovery kit</a></div>}
     </div>)}</Paginated>}
     {tree.recovery?.limited&&<p>Showing the latest 1,000 recovery kits pending cleanup.</p>}
    </details>
   </div>
  </>}
 </section>;
}


const BETA='Tested against a simulated S3 server only. Run a restore test before relying on it.';
const Beta=()=><span className="badge beta-note" title={BETA}>Beta</span>;
const initialS3={region:'us-east-1',regionTouched:false,lock:false,lockMode:'GOVERNANCE',lockDays:30,confirmed:false};
const lockModeHelp={GOVERNANCE:'Administrators with a special permission can remove locked backups early.',COMPLIANCE:'Nobody can remove locked backups early, not even the account owner. You pay for storage until the date passes.'};

function S3Fields({Field,s3,update,invalid,sites,policies}) {
 const warnings=s3.lock?lockWarnings(s3.lockDays,sites,policies):[];
 function endpointChanged(event){if(s3.regionTouched)return;const region=regionFromEndpoint(event.target.value);if(region)update({region});}
 return <>
  <Field label="Endpoint URL" name="endpoint" type="url" required placeholder="https://s3.eu-central-1.amazonaws.com" onChange={endpointChanged} {...invalid('endpoint')} help="Use your provider's S3 API endpoint, for example https://<account-id>.r2.cloudflarestorage.com or https://s3.us-west-004.backblazeb2.com. HTTPS is required."/>
  <div className="form-grid"><Field label="Region" name="region" value={s3.region} onChange={event=>update({region:event.target.value,regionTouched:true})} required pattern="[a-z0-9\-]{1,40}" title="Lowercase letters, numbers and hyphens, for example us-east-1. Use auto for Cloudflare R2." {...invalid('region')} help="Filled in from your endpoint. Backblaze B2 uses the part after s3. (for example us-west-004); Cloudflare R2 uses auto."/><Field label="Bucket" name="bucket" required pattern="[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]" title="3 to 63 lowercase letters, numbers, dots or hyphens. Must start and end with a letter or number." {...invalid('bucket')} help="3 to 63 lowercase letters, numbers, dots or hyphens. Must start and end with a letter or number."/></div>
  <div className="form-grid"><Field label="Folder prefix in bucket" name="prefix" defaultValue="docknest" maxLength={200} {...invalid('prefix')}/><Field label="Addressing style" name="addressing" defaultValue="virtual" options={[['virtual','Virtual-hosted'],['path','Path-style']]} help="Path-style suits MinIO and bucket names with dots."/></div>
  <Field label="Access key ID" name="accessKeyId" autoComplete="off" spellCheck={false} required maxLength={128} {...invalid('accessKeyId')}/>
  <Field label="Secret access key" name="secretAccessKey" type="password" autoComplete="new-password" required maxLength={256} {...invalid('secretAccessKey')} help="Use a key limited to this bucket. DockNest encrypts it and never shows it again."/>
  <label className="check"><input type="checkbox" checked={s3.lock} onChange={event=>update({lock:event.target.checked,confirmed:false})} aria-describedby="object-lock-help"/> Keep immutable copies with S3 Object Lock</label>
  <p className="hint" id="object-lock-help">Backups cannot be deleted or overwritten until the date you choose, even by DockNest or by someone who steals your key. Your bucket must have Object Lock turned on when it is created (AWS S3, Backblaze B2, Wasabi; check R2).</p>
  {s3.lock&&<>
   <div className="form-grid"><Field label="Object Lock mode" name="lockMode" value={s3.lockMode} onChange={event=>update({lockMode:event.target.value,confirmed:false})} options={[['GOVERNANCE','Governance'],['COMPLIANCE','Compliance']]} help={lockModeHelp[s3.lockMode]} {...invalid('lockMode')}/><Field label="Keep each backup for (days)" name="lockDays" type="number" value={s3.lockDays} onChange={event=>update({lockDays:event.target.value})} min={1} max={36500} required {...invalid('lockDays')} help="Each backup is locked this many days after it is created. Retention can only remove a backup after this date. You pay for locked backups until then."/></div>
   {s3.lockMode==='COMPLIANCE'&&<label className="check"><input type="checkbox" name="complianceConfirmed" checked={s3.confirmed} onChange={event=>update({confirmed:event.target.checked})}/> I understand locked backups cannot be deleted before the date, by anyone.</label>}
   {warnings.map(warning=><AlertPanel variant="warning" key={warning}>{warning}</AlertPanel>)}
  </>}
  <p className="hint">DockNest will upload, copy, read and delete a small test file to check that your key works. This file is not locked and is removed afterwards.{s3.lock?' The bucket must have no default retention rule; DockNest applies the lock to each published backup. Locked backups stay usable and are removed by retention after the lock ends.':' Object storage does not report capacity; usage shown here covers DockNest backups.'}</p>
 </>;
}

export function StorageTargets({api,Field,onChanged,onSessionExpired,sites=[],policies=[]}) {
 const [data,setData]=useState(null),[adding,setAdding]=useState(false),[authType,setAuthType]=useState('password'),[kind,setKind]=useState('sftp'),[s3,setS3]=useState(initialS3),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(null),[formError,setFormError]=useState(null),[cardError,setCardError]=useState(null),[status,setStatus]=useState(''),[treeTarget,setTreeTarget]=useState(null),[refreshKey,setRefreshKey]=useState(0);
 const errorRef=useRef(null),update=changes=>setS3(previous=>({...previous,...changes}));
 const complianceBlocked=kind==='s3'&&s3.lock&&s3.lockMode==='COMPLIANCE'&&!s3.confirmed;
 const invalid=name=>formError?.fields[name]?{'aria-invalid':'true','aria-describedby':'storage-form-error'}:{};
 function resetForm(){setKind('sftp');setAuthType('password');setS3(initialS3);setFormError(null);}
 async function load(){try{setData(await api('/storage-targets'));}catch(error){if(error.status===401)onSessionExpired();else setError(error.message);}}
 useEffect(()=>{load();},[]);
 useEffect(()=>{if(formError&&errorRef.current){errorRef.current.scrollIntoView?.({block:'center'});errorRef.current.focus();}},[formError]);
 // Busy buttons use aria-disabled so keyboard focus stays on them; this guard ignores repeat activation.
 async function run(path,body,message,scope,busyText='Working…'){
  if(busy)return null;
  setBusy(true);setError('');setNotice(null);setFormError(null);setCardError(null);setStatus(busyText);
  try{const result=await api(path,body);setNotice({message,card:scope?.card});setStatus(message);await load();await onChanged();setRefreshKey(value=>value+1);return result;}
  catch(error){
   setStatus('');
   if(error.status===401){onSessionExpired();return null;}
   if(scope==='form')setFormError({...splitFieldErrors(error.message),errorClass:error.errorClass});else if(scope?.card)setCardError({id:scope.card,message:error.message,errorClass:error.errorClass});else setError(error.message);
   return null;
  }finally{setBusy(false);}
 }
 async function connect(event){
  event.preventDefault();if(busy)return;
  if(complianceBlocked){setFormError({fields:{},first:null,message:'Confirm that you understand Compliance mode before connecting.'});return;}
  const form=event.currentTarget,fields=Object.fromEntries(new FormData(form));
  const result=kind==='s3'?await run('/storage-targets/s3/connect',{name:fields.name,endpoint:fields.endpoint,region:fields.region,bucket:fields.bucket,prefix:fields.prefix,pathStyle:fields.addressing==='path',accessKeyId:fields.accessKeyId,secretAccessKey:fields.secretAccessKey,objectLock:s3.lock?{mode:s3.lockMode,days:Number(s3.lockDays)}:null},'Storage connected. Upload, copy, ranged read and delete checks passed.','form','Testing storage connection…'):await run('/storage-targets/connect',{name:fields.name,host:fields.host,port:Number(fields.port),username:fields.username,hostKey:fields.hostKey,root:fields.root,capacityBytes:Number(fields.capacityTB)*1e12,authType,...(authType==='password'?{password:fields.password}:{privateKey:fields.privateKey})},'Storage connected. Write, read and rename checks passed.','form','Testing storage connection…');
  if(result){form.reset();resetForm();setAdding(false);}
 }
 const busyProps=busy?{'aria-disabled':'true'}:{};
 return <>
  <p className="sr-only" role="status" aria-live="polite">{status}</p>
  <section className="panel padded storage-intro"><div><h2><BrandIcon name="storage" size={24}/>Remote backup destinations</h2><p>Backup files stay on the selected destination. The dashboard keeps metadata and the encryption key. Choosing another destination affects new backups; existing backups remain with their original destination.</p></div><div className="form-actions"><button className="primary" {...busyProps} onClick={()=>{if(busy)return;if(adding)resetForm();setAdding(value=>!value);setError('');}}>{adding?'Cancel connection':'Add storage destination'}</button></div></section>
  {error&&<AlertPanel variant="error">{error}</AlertPanel>}{notice&&!notice.card&&<AlertPanel variant="info">{notice.message}</AlertPanel>}
  {!data?<p role="status">Loading storage destinations…</p>:data.targets.length?<Paginated rows={data.targets} label="Storage destinations" pageSize={4} stableHeight>{visible=><div className="storage-grid">{visible.map(target=><article className="card storage-card" key={target.id}><div className="storage-card-content"><h3 className="storage-card-head"><BrandIcon name="storage" size={28}/><span className="storage-card-name" title={target.name}>{target.name}</span></h3><p className="storage-card-kind">{target.kind==='s3'?'S3 object storage':'SFTP'}{target.kind==='s3'&&<> {'\u00b7'} <Beta/></>}</p>{data.activeTargetId===target.id&&<StatusLabel state="success">Used for new backups</StatusLabel>}{target.kind==='s3'?<dl className="def-list"><div className="def-row"><dt>Bucket</dt><dd><code>{target.bucket}</code></dd></div><div className="def-row"><dt>Endpoint</dt><dd><code>{target.endpoint}</code></dd></div><div className="def-row"><dt>Folder</dt><dd><code>{target.root}</code></dd></div><div className="def-row"><dt>Object Lock</dt><dd>{target.objectLock?target.objectLock.mode.charAt(0)+target.objectLock.mode.slice(1).toLowerCase()+', '+target.objectLock.days.toLocaleString()+' days':'Off'}</dd></div><div className="def-row"><dt>Capacity</dt><dd>Not reported</dd></div></dl>:<dl className="def-list"><div className="def-row"><dt>Connection</dt><dd><code>{target.username}@{target.host}:{target.port}</code></dd></div><div className="def-row"><dt>Sign-in</dt><dd>{target.auth_type==='password'?'Password':'SSH key'}</dd></div><div className="def-row"><dt>Folder</dt><dd><code>{target.root}</code></dd></div><div className="def-row"><dt>Capacity</dt><dd>{(target.capacity_bytes/1e12).toLocaleString()} TB configured</dd></div></dl>}{cardError?.id===target.id&&<AlertPanel variant="error" action={cardError.errorClass?<div className="rp-actions"><ReportProblem summary="Storage connection test" excerptSource={catalogued(cardError.message)||!cardError.message?null:{error:cardError.message}} excerptLabel="Include the error message" build={(facts,opts)=>buildStorageReport({...facts,...opts,protocol:target.kind==='s3'?'s3':'sftp',errorClass:cardError.errorClass,message:cardError.message,explanation:EXPLAIN.storage})}/></div>:undefined}>{cardError.message}</AlertPanel>}{notice?.card===target.id&&<AlertPanel variant="info">{notice.message}</AlertPanel>}</div><div className="card-footer storage-card-actions"><button type="button" aria-label="Browse backup folders" title="Browse backup folders" onClick={()=>setTreeTarget(previous=>previous?.id===target.id?null:target)}><BrandIcon name="backups" size={20}/> Browse</button><button type="button" aria-label="Test connection" title="Test connection" {...busyProps} onClick={()=>run('/storage-targets/'+target.id+'/test',{},'Storage connection verified.',{card:target.id},'Testing storage connection…')}><BrandIcon name="refresh" size={20}/> Test</button>{data.activeTargetId!==target.id&&<button type="button" aria-label="Use for new backups" title="Use for new backups" {...busyProps} onClick={()=>run('/storage-targets/'+target.id+'/use',{},'New backups will use this destination.',{card:target.id},'Testing storage connection…')}><BrandIcon name="resume" size={20}/> Use for backups</button>}</div></article>)}</div>}</Paginated>:<div className="notice">Connect your first destination before running backups. Local fallback is disabled.</div>}
  {treeTarget&&<StorageTree api={api} target={treeTarget} refreshKey={refreshKey} onSessionExpired={onSessionExpired}/>}
  {adding&&<section className="panel padded"><h2>Connect storage</h2><form className="storage-form" onSubmit={connect}>
   <Field label="Destination name" name="name" maxLength={100} required {...invalid('name')}/>
   <Field label="Destination type" value={kind} onChange={event=>{setKind(event.target.value);setFormError(null);}} options={[['sftp','SFTP server'],['s3','S3-compatible object storage (beta)']]} help={kind==='s3'?<><Beta/> {BETA}</>:'S3-compatible covers AWS S3, Cloudflare R2, Backblaze B2, Wasabi and MinIO.'}/>
   {kind==='s3'?<S3Fields Field={Field} s3={s3} update={update} invalid={invalid} sites={sites} policies={policies}/>:<>
   <div className="form-grid"><Field label="Storage hostname" name="host" required {...invalid('host')}/><Field label="SFTP port" name="port" type="number" defaultValue={22} min={1} max={65535} required {...invalid('port')}/></div>
   <Field label="Storage username" name="username" required {...invalid('username')}/>
   <Field label="Authentication method" value={authType} onChange={event=>setAuthType(event.target.value)} options={[[ 'password','Password'],['ssh-key','SSH key']]}/>
   {authType==='password'?<Field key="password" label="Storage password" name="password" type="password" autoComplete="new-password" required maxLength={4096} {...invalid('password')}/>:<Field key="privateKey" label="Storage SSH private key" name="privateKey" multiline autoComplete="off" spellCheck={false} minLength={50} maxLength={30000} required {...invalid('privateKey')}/>}
   <Field label="Verified SSH host fingerprint" name="hostKey" required pattern="(?:[a-fA-F0-9]{64}|SHA256:[A-Za-z0-9+\/]{43}=?)" title="64 hexadecimal characters, or SHA256: followed by 43 base64 characters." {...invalid('hostKey')} help="This identifies the storage server, like an ID check. Copy its SSH fingerprint from the Storage Box overview in Hetzner Console. DockNest refuses changed fingerprints to protect your password and backups."/>
   <details><summary>Where do I find the fingerprint?</summary><p>Open Hetzner Console, select your Storage Box, and find its SSH host fingerprints in the overview. Copy the SHA256 fingerprint matching the SSH host-key algorithm. This is public server identification, not your password or private key.</p></details>
   <div className="form-grid"><Field label="Backup directory on storage" name="root" defaultValue="/home/docknest" required {...invalid('root')}/><Field label="Capacity (TB)" name="capacityTB" type="number" defaultValue={1} min={0.001} max={9000} step={0.001} required {...invalid('capacityTB')}/></div>
   <p className="hint">DockNest tests this directory before saving the encrypted credential. Capacity is your configured quota; usage shown here covers DockNest backups. Port 23 requires SSH support enabled in Hetzner Console.</p></>}
   {formError&&<div id="storage-form-error" tabIndex={-1} ref={errorRef}><AlertPanel variant="error" title="Could not connect storage." action={formError.errorClass?<div className="rp-actions"><ReportProblem summary="Storage connection test" excerptSource={catalogued(formError.message)||!formError.message?null:{error:formError.message}} excerptLabel="Include the error message" build={(facts,opts)=>buildStorageReport({...facts,...opts,protocol:kind==='s3'?'s3':'sftp',errorClass:formError.errorClass,message:formError.message,explanation:EXPLAIN.storage})}/></div>:undefined}>{formError.message}</AlertPanel></div>}
   {complianceBlocked&&<p className="hint" id="compliance-required">Confirm Compliance mode above to continue.</p>}
   <div className="form-actions"><button className="primary" {...(busy||complianceBlocked?{'aria-disabled':'true'}:{})} aria-describedby={complianceBlocked?'compliance-required':undefined}>{busy?'Testing storage…':'Test & connect storage'}</button></div>
  </form></section>}
 </>;
}
