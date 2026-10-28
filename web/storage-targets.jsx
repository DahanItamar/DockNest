import React,{useEffect,useMemo,useRef,useState} from 'react';
import {IconX,IconTrash,IconChevronDown} from '@tabler/icons-react';
import {BrandIcon} from './brand.jsx';
import {ZipButton} from './zip-export.jsx';
import {AlertPanel,StatusLabel,IconButton} from './system.jsx';
import {createCopiesClient} from './copies/copies-client.js';
import {useDestinationRemoval,RemovalPanel} from './copies/DestinationRemoval.jsx';
import {ReportProblem} from './report/ReportProblem.jsx';
import {buildStorageReport} from './report/builders.js';
import {catalogued,EXPLAIN} from './report/catalogue.js';
import {formatBytes} from '../shared/format-bytes.js';
import './storage-targets.css';
import {Paginated} from './pagination.jsx';
import {formatDate} from './date-format.js';
import {Combo} from './connections/parts.jsx';
import {PROVIDER_GROUPS,DEFAULT_PROVIDER,providerById,suggestedEndpoint} from './storage-providers.js';
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
       <div><b>{filename(backup)}</b><small>{formatDate(backup.capturedAt)} · {formatBytes(backup.size)} · {backup.verified?'Integrity checked':'Integrity unchecked'}{backup.pinned?' · Pinned':''}</small>{backup.relativePath&&<code>{backup.relativePath}</code>}</div>
       <div className="actions"><ZipButton backupId={backup.id} className="button" label={'Download full ZIP '+backup.id}>Full ZIP</ZipButton><a className="button" href={'/api/backups/'+backup.id+'/download'}>Encrypted backup</a><button disabled={busy} onClick={()=>pin(backup)}>{backup.pinned?'Unpin':'Pin'}</button></div>
      </div>)}</Paginated>
     </details>)}</Paginated>
    </details>)}</Paginated>}
    <details open><summary>docknest-recovery</summary>
     {!tree.recovery?.files.length?<p>No DockNest recovery kit stored here yet.</p>:<Paginated rows={tree.recovery.files} label="DockNest recovery kits" pageSize={5}>{files=>files.map(file=><div className="backup-tree-file" key={file.id}>
      <div><b>{filename(file)}</b><small>{formatDate(file.createdAt)} · {formatBytes(file.size)} · Encrypted recovery kit</small>{file.relativePath&&<code>{file.relativePath}</code>}</div>
      {file.downloadable&&<div className="actions"><a className="button" href="/api/self-backup/download">Download recovery kit</a></div>}
     </div>)}</Paginated>}
     {tree.recovery?.limited&&<p>Showing the latest 1,000 recovery kits pending cleanup.</p>}
    </details>
   </div>
  </>}
 </section>;
}


const fmt=formatBytes;
// Backup space used on one destination; with a configured capacity it also shows a slim bar.
function Usage({used,capacity}) {
 if(used==null)return null;
 const percent=capacity>0?Math.min(100,Math.max(used?1:0,Math.round(used/capacity*100))):null;
 return <div className="storage-usage"><div className="storage-usage-text"><span>{percent==null?'Used by DockNest backups':'Capacity used'}</span><b>{percent==null?fmt(used):percent+'% · '+fmt(used)+' of '+fmt(capacity)}</b></div>{percent!=null&&<progress value={percent} max="100" aria-label="Capacity used"/>}</div>;
}

const initialS3={region:'us-east-1',regionTouched:false,endpoint:'',endpointTouched:false,accountId:'',lock:false,lockMode:'GOVERNANCE',lockDays:30,confirmed:false};
const lockModeHelp={GOVERNANCE:'Administrators with a special permission can remove locked backups early.',COMPLIANCE:'Nobody can remove locked backups early, not even the account owner. You pay for storage until the date passes.'};

function S3Fields({Field,provider,s3,update,invalid,sites,policies}) {
 const warnings=s3.lock?lockWarnings(s3.lockDays,sites,policies):[];
 function endpointChanged(event){const endpoint=event.target.value,changes={endpoint,endpointTouched:true};if(!s3.regionTouched){const region=regionFromEndpoint(endpoint);if(region)changes.region=region;}update(changes);}
 function regionChanged(event){const region=event.target.value,changes={region,regionTouched:true};if(!s3.endpointTouched&&provider.template)changes.endpoint=suggestedEndpoint(provider,{region});update(changes);}
 function accountChanged(event){const accountId=event.target.value,changes={accountId};if(!s3.endpointTouched)changes.endpoint=suggestedEndpoint(provider,{accountId});update(changes);}
 return <>
  {provider.accountId&&<Field label="Account ID" name="accountId" value={s3.accountId} onChange={accountChanged} autoComplete="off" spellCheck={false} maxLength={64} help="Cloudflare dashboard, under R2. It builds the endpoint below."/>}
  <Field label="Endpoint URL" name="endpoint" type="url" required value={s3.endpoint} placeholder={provider.endpointPlaceholder} onChange={endpointChanged} {...invalid('endpoint')} help={provider.endpointHelp}/>
  <div className="form-grid"><Field label="Region" name="region" value={s3.region} onChange={regionChanged} required pattern="[a-z0-9\-]{1,40}" title="Lowercase letters, numbers and hyphens, for example us-east-1. Use auto for Cloudflare R2." {...invalid('region')} help={provider.regionHelp}/><Field label="Bucket" name="bucket" required pattern="[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]" title="3 to 63 lowercase letters, numbers, dots or hyphens. Must start and end with a letter or number." {...invalid('bucket')} help="3 to 63 lowercase letters, numbers, dots or hyphens. Must start and end with a letter or number."/></div>
  <div className="form-grid"><Field label="Folder prefix in bucket" name="prefix" defaultValue="docknest" maxLength={200} {...invalid('prefix')}/><Field label="Addressing style" name="addressing" defaultValue={provider.path?'path':'virtual'} options={[['virtual','Virtual-hosted'],['path','Path-style']]} help="Path-style suits MinIO and bucket names with dots."/></div>
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

export function StorageTargets({api,Field,onChanged,onSessionExpired,sites=[],policies=[],usage={}}) {
 const [data,setData]=useState(null),[adding,setAdding]=useState(false),[authType,setAuthType]=useState('password'),[providerId,setProviderId]=useState(DEFAULT_PROVIDER),[showSteps,setShowSteps]=useState(false),[s3,setS3]=useState(initialS3),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(null),[formError,setFormError]=useState(null),[cardError,setCardError]=useState(null),[status,setStatus]=useState(''),[treeTarget,setTreeTarget]=useState(null),[refreshKey,setRefreshKey]=useState(0);
 const removal=useDestinationRemoval(useMemo(()=>createCopiesClient(api),[api]),{onSessionExpired,onDone:async message=>{setNotice({message});await load();await onChanged();setRefreshKey(value=>value+1);}});
 const errorRef=useRef(null),update=changes=>setS3(previous=>({...previous,...changes}));
 const provider=providerById(providerId),kind=provider.kind;
 const pickProvider=id=>{const next=providerById(id);setProviderId(id);setFormError(null);setS3(previous=>({...previous,region:next.region||previous.region,regionTouched:false,endpointTouched:false,accountId:'',endpoint:suggestedEndpoint(next,{region:next.region})}));};
 const complianceBlocked=kind==='s3'&&s3.lock&&s3.lockMode==='COMPLIANCE'&&!s3.confirmed;
 const invalid=name=>formError?.fields[name]?{'aria-invalid':'true','aria-describedby':'storage-form-error'}:{};
 function resetForm(){setProviderId(DEFAULT_PROVIDER);setShowSteps(false);setAuthType('password');setS3(initialS3);setFormError(null);}
 async function load(){try{setData(await api('/storage-targets'));}catch(error){if(error.status===401)onSessionExpired();else setError(error.message);}}
 useEffect(()=>{load();},[]);
 useEffect(()=>{if(formError&&errorRef.current){errorRef.current.scrollIntoView?.({block:'center'});errorRef.current.focus();}},[formError]);
 // Busy buttons use aria-disabled so keyboard focus stays on them; this guard ignores repeat activation.
 // `busy` is state and only changes on the next render; the ref closes the gap between two fast submits.
 const inFlight=useRef(false);
 async function run(path,body,message,scope,busyText='Working…'){
  if(busy||inFlight.current)return null;
  inFlight.current=true;setBusy(true);setError('');setNotice(null);setFormError(null);setCardError(null);setStatus(busyText);
  try{const result=await api(path,body);setNotice({message,card:scope?.card});setStatus(message);await load();await onChanged();setRefreshKey(value=>value+1);return result;}
  catch(error){
   setStatus('');
   if(error.status===401){onSessionExpired();return null;}
   if(scope==='form')setFormError({...splitFieldErrors(error.message),errorClass:error.errorClass});else if(scope?.card)setCardError({id:scope.card,message:error.message,errorClass:error.errorClass});else setError(error.message);
   return null;
  }finally{inFlight.current=false;setBusy(false);}
 }
 async function connect(event){
  event.preventDefault();if(busy)return;
  if(complianceBlocked){setFormError({fields:{},first:null,message:'Confirm that you understand Compliance mode before connecting.'});return;}
  const form=event.currentTarget,fields=Object.fromEntries(new FormData(form));
  const result=kind==='s3'?await run('/storage-targets/s3/connect',{name:fields.name,endpoint:fields.endpoint,region:fields.region,bucket:fields.bucket,prefix:fields.prefix,pathStyle:fields.addressing==='path',accessKeyId:fields.accessKeyId,secretAccessKey:fields.secretAccessKey,objectLock:s3.lock?{mode:s3.lockMode,days:Number(s3.lockDays)}:null},'Storage connected. Upload, copy, ranged read and delete checks passed.','form','Testing storage connection…'):await run('/storage-targets/connect',{name:fields.name,host:fields.host,port:Number(fields.port),username:fields.username,hostKey:fields.hostKey,root:fields.root,capacityBytes:Math.round(Number(fields.capacityTB)*1e12),authType,...(authType==='password'?{password:fields.password}:{privateKey:fields.privateKey})},'Storage connected. Write, read and rename checks passed.','form','Testing storage connection…');
  if(result){form.reset();resetForm();setAdding(false);}
 }
 function closeForm(){if(busy)return;resetForm();setAdding(false);}
 const busyProps=busy?{'aria-disabled':'true'}:{};
 return <>
  <p className="sr-only" role="status" aria-live="polite">{status}</p>
  <header className="storage-intro"><div><h2><BrandIcon name="storage" size={24}/>Remote backup destinations</h2><p>Backup files stay on the selected destination. The dashboard keeps metadata and the encryption key. Choosing another destination affects new backups; existing backups remain with their original destination.</p></div><div className="form-actions"><button className="primary" {...busyProps} onClick={()=>{if(busy)return;resetForm();setAdding(true);setError('');}}>Add storage destination</button></div></header>
  {removal.prompt&&<div className="map-root">{removal.prompt}</div>}{error&&<AlertPanel variant="error">{error}</AlertPanel>}{notice&&!notice.card&&<AlertPanel variant="info">{notice.message}</AlertPanel>}
  {!data?<p role="status">Loading storage destinations…</p>:data.targets.length?<Paginated rows={data.targets} label="Storage destinations" pageSize={4} stableHeight>{visible=><div className="storage-grid" data-count={visible.length}>{visible.map(target=><article className="card storage-card" key={target.id}><div className="storage-card-content"><div className="storage-card-top"><h3 className="storage-card-head"><BrandIcon name="storage" size={28}/><span className="storage-card-name" title={target.name}>{target.name}</span></h3><IconButton className="cp-remove" label={'Remove '+target.name} icon={IconTrash} aria-expanded={removal.removal?.target.id===target.id} disabled={removal.busy||removal.waiting} onClick={()=>removal.ask(target)}/></div><p className="storage-card-kind">{target.kind==='s3'?'S3 object storage':'SFTP'}</p>{data.activeTargetId===target.id&&<StatusLabel state="success">Used for new backups</StatusLabel>}{target.kind==='s3'?<><dl className="def-list"><div className="def-row"><dt>Bucket</dt><dd><code>{target.bucket}</code></dd></div><div className="def-row"><dt>Endpoint</dt><dd><code>{target.endpoint}</code></dd></div><div className="def-row"><dt>Folder</dt><dd><code>{target.root}</code></dd></div><div className="def-row"><dt>Object Lock</dt><dd>{target.objectLock?target.objectLock.mode.charAt(0)+target.objectLock.mode.slice(1).toLowerCase()+', '+target.objectLock.days.toLocaleString()+' days':'Off'}</dd></div><div className="def-row"><dt>Capacity</dt><dd>Not reported</dd></div></dl><Usage used={usage[target.id]}/></>:<><dl className="def-list"><div className="def-row"><dt>Connection</dt><dd><code>{target.username}@{target.host}:{target.port}</code></dd></div><div className="def-row"><dt>Sign-in</dt><dd>{target.auth_type==='password'?'Password':'SSH key'}</dd></div><div className="def-row"><dt>Folder</dt><dd><code>{target.root}</code></dd></div><div className="def-row"><dt>Capacity</dt><dd>{formatBytes(target.capacity_bytes)} configured</dd></div></dl><Usage used={usage[target.id]} capacity={target.capacity_bytes}/></>}{cardError?.id===target.id&&<AlertPanel variant="error" action={cardError.errorClass?<div className="rp-actions"><ReportProblem summary="Storage connection test" excerptSource={catalogued(cardError.message)||!cardError.message?null:{error:cardError.message}} excerptLabel="Include the error message" build={(facts,opts)=>buildStorageReport({...facts,...opts,protocol:target.kind==='s3'?'s3':'sftp',errorClass:cardError.errorClass,message:cardError.message,explanation:EXPLAIN.storage})}/></div>:undefined}>{cardError.message}</AlertPanel>}{notice?.card===target.id&&<AlertPanel variant="info">{notice.message}</AlertPanel>}<RemovalPanel state={removal} target={target}/></div><div className="card-footer storage-card-actions"><button type="button" aria-label="Browse backup folders" title="Browse backup folders" onClick={()=>setTreeTarget(previous=>previous?.id===target.id?null:target)}><BrandIcon name="backups" size={20}/> Browse</button><button type="button" aria-label="Test connection" title="Test connection" {...busyProps} onClick={()=>run('/storage-targets/'+target.id+'/test',{},'Storage connection verified.',{card:target.id},'Testing storage connection…')}><BrandIcon name="refresh" size={20}/> Test</button>{data.activeTargetId!==target.id&&<button type="button" aria-label="Use for new backups" title="Use for new backups" {...busyProps} onClick={()=>run('/storage-targets/'+target.id+'/use',{},'New backups will use this destination.',{card:target.id},'Testing storage connection…')}><BrandIcon name="resume" size={20}/> Use for backups</button>}</div></article>)}</div>}</Paginated>:<div className="notice">Connect your first destination before running backups. Local fallback is disabled.</div>}
  {treeTarget&&<StorageTree api={api} target={treeTarget} refreshKey={refreshKey} onSessionExpired={onSessionExpired}/>}
  {adding&&<StorageDialog busy={busy} onClose={closeForm}><form className="storage-form" onSubmit={connect}><div className="modal-body storage-scroll">
   <div className="field" role="group" aria-labelledby="storage-l-provider"><span id="storage-l-provider">Provider</span><Combo labelledBy="storage-l-provider" value={providerId} onChange={pickProvider} items={PROVIDER_GROUPS.flatMap(group=>group.items.map(item=>({value:item.id,label:item.label,group:group.label,caption:item.sub})))}/></div>
   <Field label="Destination name" name="name" maxLength={100} required {...invalid('name')}/>
   {kind==='s3'?<S3Fields key={providerId} Field={Field} provider={provider} s3={s3} update={update} invalid={invalid} sites={sites} policies={policies}/>:<div key={providerId} className="storage-sftp">
   <div className="form-grid"><Field label="Hostname" name="host" required placeholder={provider.host} {...invalid('host')}/><Field label="Port" name="port" type="number" defaultValue={provider.port} min={1} max={65535} required help={provider.note} {...invalid('port')}/></div>
   <Field label="Username" name="username" required placeholder={provider.username||undefined} autoComplete="off" {...invalid('username')}/>
   <Field label="Sign-in method" value={authType} onChange={event=>setAuthType(event.target.value)} options={[[ 'password','Password'],['ssh-key','SSH key']]}/>
   {authType==='password'?<Field key="password" label="Password" name="password" type="password" autoComplete="new-password" required maxLength={4096} {...invalid('password')}/>:<Field key="privateKey" label="SSH private key" name="privateKey" multiline autoComplete="off" spellCheck={false} minLength={50} maxLength={30000} required {...invalid('privateKey')}/>}
   <Field label="Host fingerprint" name="hostKey" required placeholder="SHA256:..." pattern="(?:[a-fA-F0-9]{64}|SHA256:[A-Za-z0-9+\/]{43}=?)" title="64 hexadecimal characters, or SHA256: followed by 43 base64 characters." {...invalid('hostKey')} help={'This identifies the server, like an ID check. '+provider.fingerprint+' DockNest refuses a changed fingerprint.'}/>
   <details className="rt-adv storage-more" open={showSteps} onToggle={event=>setShowSteps(event.currentTarget.open)}><summary>Where do I find it?<IconChevronDown size={18} stroke={1.75} className="rt-chev" aria-hidden="true"/></summary>{provider.steps==='ssh'?<p>On a machine you trust, run <code>ssh-keyscan -t ed25519 HOST | ssh-keygen -lf -</code> and copy the SHA256 value. You can also read it from the server's console. This is public server identification, not your password or private key.</p>:<p>{provider.steps}</p>}</details>
   <div className="form-grid"><Field label="Backup directory" name="root" defaultValue={provider.root} required help="DockNest tests this directory before saving the encrypted credential." {...invalid('root')}/><Field label="Capacity (TB)" name="capacityTB" type="number" defaultValue={1} min={0.001} max={9000} step={0.001} required help="Your quota. Usage shown covers DockNest backups only." {...invalid('capacityTB')}/></div></div>}
   {formError&&<div id="storage-form-error" tabIndex={-1} ref={errorRef}><AlertPanel variant="error" title="Could not connect storage." action={formError.errorClass?<div className="rp-actions"><ReportProblem summary="Storage connection test" excerptSource={catalogued(formError.message)||!formError.message?null:{error:formError.message}} excerptLabel="Include the error message" build={(facts,opts)=>buildStorageReport({...facts,...opts,protocol:kind==='s3'?'s3':'sftp',errorClass:formError.errorClass,message:formError.message,explanation:EXPLAIN.storage})}/></div>:undefined}>{formError.message}</AlertPanel></div>}
   {complianceBlocked&&<p className="hint" id="compliance-required">Confirm Compliance mode above to continue.</p>}
  </div>
   <div className="modal-foot storage-foot"><button type="button" {...busyProps} onClick={closeForm}>Cancel</button><button className="primary" {...(busy||complianceBlocked?{'aria-disabled':'true'}:{})} aria-describedby={complianceBlocked?'compliance-required':undefined}>{busy?'Testing…':'Test & connect'}</button></div>
  </form></StorageDialog>}
 </>;
}

// Connect storage as a modal dialog, like New connection. Escape and the close button cancel unless a test is running.
function StorageDialog({busy,onClose,children}){
 const ref=useRef(null);
 useEffect(()=>{const d=ref.current;if(d&&!d.open)d.showModal();setTimeout(()=>d?.querySelector('input[name="name"]')?.focus(),0);return()=>{if(d?.open)d.close()}},[]);
 return <dialog ref={ref} className="site-wizard storage-dialog" aria-labelledby="storage-dialog-title" onCancel={e=>{e.preventDefault();onClose()}}>
  <div className="modal-head"><h2 id="storage-dialog-title">Connect storage</h2><button type="button" className="icon" aria-label="Close dialog" aria-disabled={busy||undefined} onClick={onClose}><IconX size={20}/></button></div>
  {children}
 </dialog>;
}
