import React,{useEffect,useMemo,useRef,useState} from 'react';
import {IconX,IconTrash,IconChevronDown,IconFolder,IconLock} from '@tabler/icons-react';
import {BrandIcon} from './brand.jsx';
import {ZipButton} from './zip-export.jsx';
import {AlertPanel,StatusLabel,OverflowMenu} from './system.jsx';
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
import {splitFieldErrors,regionFromEndpoint,lockWarnings,capacityText} from './storage-form.js';
import {DriveFields} from './storage-drives/DriveFields.jsx';
import {DriveCardBody,NeedsSignIn,driveKindText,isDriveTarget} from './storage-drives/DriveCard.jsx';
import {StorageGlyph} from './storage-drives/StorageGlyph.jsx';
import {ReconnectDialog} from './storage-drives/ReconnectDialog.jsx';
import {isDriveKind} from './storage-drives/drive-model.js';
import {useReauth} from './connections/ConnectionDialog.jsx';
import {waitForTest} from './storage-drives/test-poll.js';
import './storage-drives/drives.css';

// Append-only SFTP (docs/storage-backends.md): what the last test found, what the storage keeps past retention, and a
// request to test again when a normal destination refused a delete.
const APPEND_ONLY_CONNECTED='Storage connected as append-only. The storage refused every delete and overwrite DockNest tried. Files already in this folder stay changeable until you make them read-only on the server.';
const OLDER_FILES='Files DockNest stored here before it became append-only can still be changed. Make them read-only on the storage server (chmod -R a-w on the DockNest folder).';
export function WriteMode({target}){
 const kept=target.keptByStorage;
 if(target.writeModeUnverifiedAt)return <AlertPanel variant="warning" title="Append-only is not verified.">The last test found that this storage refuses deletes but still lets files be changed. DockNest keeps every file here. Fix the server setup, then test again.</AlertPanel>;
 if(target.deletesRefusedAt&&target.writeMode!=='append-only')return <AlertPanel variant="warning" title="The storage refused a delete.">DockNest stopped deleting here and keeps every file. Test the destination to check whether it is now append-only.</AlertPanel>;
 if(target.writeMode!=='append-only')return null;
 return <div className="storage-write-mode"><StatusLabel state="success" icon={IconLock}>Append-only</StatusLabel><p className="hint">At the last test the storage refused every delete and overwrite. While it keeps doing so, DockNest, and anyone who takes it over, can add backups here but cannot delete or overwrite them. Backups past retention are kept by the storage: expire them on the storage server.</p>{target.unprotectedBefore&&<p className="hint">{OLDER_FILES}</p>}{kept?.backups>0&&<p className="hint">{kept.backups.toLocaleString()} {kept.backups===1?'backup':'backups'} ({formatBytes(kept.bytes)}) kept by the storage past retention.</p>}{kept?.leftovers>0&&<p className="hint">{kept.leftovers.toLocaleString()} unfinished or test {kept.leftovers===1?'file':'files'} kept too.</p>}</div>;
}

function StorageTree({api,target,refreshKey,onSessionExpired}) {
 const [tree,setTree]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reload,setReload]=useState(0);
 useEffect(()=>{let current=true;setTree(null);setError('');api('/storage-targets/'+target.id+'/tree').then(result=>{if(current)setTree(result);}).catch(error=>{if(current){if(error.status===401)onSessionExpired();else setError(error.message);}});return()=>{current=false;};},[target.id,reload,refreshKey]);
 async function pin(backup){setBusy(true);setError('');try{await api('/backups/'+backup.id+'/pin',{pinned:!backup.pinned});setReload(value=>value+1);}catch(error){if(error.status===401)onSessionExpired();else setError(error.message);}finally{setBusy(false);}}
 const filename=file=>file.filename||file.relativePath?.split('/').at(-1)||'Encrypted backup';
 return <section className="panel padded">
  <h2>{target.name} · Backup folders</h2><p>App backups are organized by server and app. DockNest recovery kits have their own folder.</p>
  {error&&<AlertPanel variant="error" action={<button onClick={()=>setReload(value=>value+1)}>Retry</button>}>{error}</AlertPanel>}
  {!tree&&!error&&<p role="status">Loading backup folders…</p>}
  {tree&&<>
   <p>New backups go under <code>{tree.managedRoot||tree.root}/</code>. Existing files show their recorded paths. Other files on the destination are not listed.</p>
   {tree.limited&&<p>Showing the latest 1,000 app backups. Use the backup library for other recovery points.</p>}
   <div className="backup-tree">
    {!tree.servers.length?<p>No app backups stored here yet.</p>:<Paginated rows={tree.servers} label="Storage servers" pageSize={5}>{servers=>servers.map(server=><details key={server.id} open>
     <summary>Server: {server.name}</summary>
     <Paginated rows={server.sites} label={'Storage apps on '+server.name} pageSize={5}>{sites=>sites.map(site=><details key={site.id} open>
      <summary>App: {site.name}</summary>
      <Paginated rows={site.days.flatMap(day=>day.backups)} label={'Stored backups for '+site.name} pageSize={5}>{points=>points.map(backup=><div className="backup-tree-file" key={backup.id}>
       <div><b>{filename(backup)}</b><small>{formatDate(backup.capturedAt)} · {formatBytes(backup.size)} · {backup.verified?'Integrity checked':'Integrity unchecked'}{backup.pinned?' · Pinned':''}{backup.backupKind==='incremental'?' · Increment '+backup.chainPosition+', download the chain from the backup library':''}</small>{backup.relativePath&&<code>{backup.relativePath}</code>}</div>
       <div className="actions">{backup.backupKind!=='incremental'&&<><ZipButton backupId={backup.id} className="button" label={'Download full ZIP '+backup.id}>Full ZIP</ZipButton><a className="button" href={'/api/backups/'+backup.id+'/download'}>Encrypted backup</a></>}<button disabled={busy} onClick={()=>pin(backup)}>{backup.pinned?'Unpin':'Pin'}</button></div>
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
 function endpointChanged(event){const endpoint=event.target.value,changes={endpoint,endpointTouched:endpoint.trim()!==''};if(!s3.regionTouched){const region=regionFromEndpoint(endpoint);if(region)changes.region=region;}update(changes);}
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
 const [data,setData]=useState(null),[adding,setAdding]=useState(false),[authType,setAuthType]=useState('password'),[providerId,setProviderId]=useState(DEFAULT_PROVIDER),[showSteps,setShowSteps]=useState(false),[capacity,setCapacity]=useState({text:'',source:'',touched:false,bytes:null}),capacityProbe=useRef({key:'',run:0,timer:null}),[sftp,setSftp]=useState({port:String(providerById(DEFAULT_PROVIDER).port),root:providerById(DEFAULT_PROVIDER).root,portTouched:false,rootTouched:false}),[s3,setS3]=useState(initialS3),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(null),[formError,setFormError]=useState(null),[cardError,setCardError]=useState(null),[status,setStatus]=useState(''),[treeTarget,setTreeTarget]=useState(null),[refreshKey,setRefreshKey]=useState(0);
 const removal=useDestinationRemoval(useMemo(()=>createCopiesClient(api),[api]),{onSessionExpired,onDone:async message=>{setNotice({message});await load();await onChanged();setRefreshKey(value=>value+1);}});
 const errorRef=useRef(null),update=changes=>setS3(previous=>({...previous,...changes})),driveRef=useRef(null),[driveReady,setDriveReady]=useState(true),[reconnect,setReconnect]=useState(null),reauthClient=useMemo(()=>({reauth:(password,code)=>api('/auth/reauth',{password,code})}),[api]),guard=useReauth(reauthClient);
 const provider=providerById(providerId),kind=provider.kind,isDrive=isDriveKind(kind);
 const pickProvider=id=>{const next=providerById(id),typeSwitch=next.kind!==kind;setProviderId(id);setFormError(null);
  if(next.kind==='sftp')setSftp(previous=>typeSwitch?{port:String(next.port),root:next.root,portTouched:false,rootTouched:false}:{...previous,port:previous.portTouched?previous.port:String(next.port),root:previous.rootTouched?previous.root:next.root});
  if(typeSwitch)setAuthType('password');setS3(previous=>({...previous,region:next.region||previous.region,regionTouched:false,endpointTouched:false,accountId:'',endpoint:suggestedEndpoint(next,{region:next.region})}));};
 const complianceBlocked=kind==='s3'&&s3.lock&&s3.lockMode==='COMPLIANCE'&&!s3.confirmed;
 const invalid=name=>formError?.fields[name]?{'aria-invalid':'true','aria-describedby':'storage-form-error'}:{};
 function resetForm(){setDriveReady(true);setCapacity({text:'',source:'',touched:false,bytes:null});clearTimeout(capacityProbe.current.timer);capacityProbe.current={key:'',run:0,timer:null};setSftp({port:String(providerById(DEFAULT_PROVIDER).port),root:providerById(DEFAULT_PROVIDER).root,portTouched:false,rootTouched:false});setProviderId(DEFAULT_PROVIDER);setShowSteps(false);setAuthType('password');setS3(initialS3);setFormError(null);}
 async function load(){try{setData(await api('/storage-targets'));}catch(error){if(error.status===401)onSessionExpired();else setError(error.message);}}
 useEffect(()=>{load();},[]);
 useEffect(()=>{if(formError&&errorRef.current){errorRef.current.scrollIntoView?.({block:'center'});errorRef.current.focus();}},[formError]);
 // Busy buttons use aria-disabled so keyboard focus stays on them; this guard ignores repeat activation.
 // `busy` is state and only changes on the next render; the ref closes the gap between two fast submits.
 const inFlight=useRef(false);
 async function run(path,body,message,scope,busyText='Working…'){
  if(busy||inFlight.current)return null;
  inFlight.current=true;setBusy(true);setError('');setNotice(null);setFormError(null);setCardError(null);setStatus(busyText);
  try{let result=await api(path,body);if(result?.checking&&path.endsWith('/test'))result=await waitForTest(api,path,{onWait:setStatus});setNotice({message,card:scope?.card});setStatus(message);await load();await onChanged();setRefreshKey(value=>value+1);return result;}
  catch(error){
   setStatus('');
   if(error.status===401){onSessionExpired();return null;}
   if(scope==='form')setFormError({...splitFieldErrors(error.message),errorClass:error.errorClass});else if(scope?.card)setCardError({id:scope.card,message:error.message,errorClass:error.errorClass});else setError(error.message);
   return null;
  }finally{inFlight.current=false;setBusy(false);}
 }
 // Asks the server what the storage reports once the connection details are filled in. Never blocks adding; the typed value wins.
 function checkCapacity(event){
  if(kind!=='sftp'||capacity.touched)return;
  const form=event.currentTarget.closest('form'),probe=capacityProbe.current;
  clearTimeout(probe.timer);
  // Debounced: moving between fields does not probe; only a settled, complete and distinct connection does.
  probe.timer=setTimeout(async()=>{
   if(!form.isConnected)return;
   const fields=Object.fromEntries(new FormData(form));
   const names=['host','port','username','hostKey','root',authType==='password'?'password':'privateKey'];
   if(!names.every(name=>fields[name])||!form.checkValidity())return;
   const body={host:fields.host,port:Number(fields.port),username:fields.username,hostKey:fields.hostKey,root:fields.root,authType,...(authType==='password'?{password:fields.password}:{privateKey:fields.privateKey})};
   const key=JSON.stringify(body);
   if(probe.key===key)return;
   probe.key=key;const run=++probe.run;
   setCapacity(previous=>({...previous,source:'checking'}));
   let bytes=null;try{bytes=(await api('/storage-targets/capacity',body)).capacityBytes;}catch{}
   if(run!==probe.run)return;
   setCapacity(previous=>previous.touched?{...previous,source:''}:capacityText(bytes)?{text:capacityText(bytes),source:'server',touched:false,bytes}:{...previous,source:''});
  },600);
 }
 async function connect(event){
  event.preventDefault();if(busy)return;
  if(complianceBlocked){setFormError({fields:{},first:null,message:'Confirm that you understand Compliance mode before connecting.'});return;}
  const form=event.currentTarget,fields=Object.fromEntries(new FormData(form));
  if(isDrive){await connectDrive(form,fields.name);return;}
  const result=kind==='s3'?await run('/storage-targets/s3/connect',{name:fields.name,endpoint:fields.endpoint,region:fields.region,bucket:fields.bucket,prefix:fields.prefix,pathStyle:fields.addressing==='path',accessKeyId:fields.accessKeyId,secretAccessKey:fields.secretAccessKey,objectLock:s3.lock?{mode:s3.lockMode,days:Number(s3.lockDays)}:null},'Storage connected. Upload, copy, ranged read and delete checks passed.','form','Testing storage connection…'):await run('/storage-targets/connect',{name:fields.name,host:fields.host,port:Number(fields.port),username:fields.username,hostKey:fields.hostKey,root:fields.root,...(capacity.touched&&fields.capacityTB?{capacityBytes:Math.round(Number(fields.capacityTB.replace(',','.'))*1e12)}:capacity.bytes?{capacityBytes:capacity.bytes}:{}),authType,...(authType==='password'?{password:fields.password}:{privateKey:fields.privateKey})},'Storage connected. Write, read and rename checks passed.','form','Testing storage connection…');
  if(result){form.reset();resetForm();setAdding(false);if(result.writeMode==='append-only')setNotice({message:APPEND_ONLY_CONNECTED});}
 }

 // Cloud drives, shares and local folders: the fields check themselves and finish the sign-in, then one API call connects.
 async function connectDrive(form,name){
  if(busy||inFlight.current)return;
  inFlight.current=true;setBusy(true);setError('');setNotice(null);setFormError(null);setStatus('Testing storage connection…');
  try{
   const request=await driveRef.current.build(String(name||'').trim()||provider.label);
   await new Promise((resolve,reject)=>guard.run(async()=>{
    await api(request.path,request.body);
    resolve();
   },reject));
   setNotice({message:'Storage connected. Upload, read-back and delete checks passed.'});setStatus('Storage connected.');
   form.reset();resetForm();setAdding(false);await load();await onChanged();setRefreshKey(value=>value+1);
  }catch(e){
   setStatus('');
   if(e.status===401)onSessionExpired();
   else if(e.code==='same_disk'){driveRef.current?.sameDisk();setFormError({fields:{},first:null,message:e.message});}
   else setFormError({fields:{},first:null,message:e.message||'The storage could not be connected.'});
  }finally{inFlight.current=false;setBusy(false);}
 }
 function closeForm(){if(busy)return;resetForm();setAdding(false);}
 const busyProps=busy?{'aria-disabled':'true'}:{};
 return <>
  <p className="sr-only" role="status" aria-live="polite">{status}</p>
  <header className="storage-intro"><div><h2><BrandIcon name="storage" size={24}/>Remote backup destinations</h2><p>Backup files stay on the selected destination. The dashboard keeps metadata and the encryption key. Choosing another destination affects new backups; existing backups remain with their original destination.</p></div><div className="form-actions"><button className="primary" {...busyProps} onClick={()=>{if(busy)return;resetForm();setAdding(true);setError('');}}>Add storage destination</button></div></header>
  {removal.prompt&&<div className="map-root">{removal.prompt}</div>}{error&&<AlertPanel variant="error">{error}</AlertPanel>}{notice&&!notice.card&&<AlertPanel variant="info">{notice.message}</AlertPanel>}
  {!data?<p role="status">Loading storage destinations…</p>:data.targets.length?<Paginated rows={data.targets} label="Storage destinations" pageSize={4} stableHeight>{visible=><div className="storage-grid" data-count={visible.length}>{visible.map(target=><article className="card storage-card" key={target.id}><div className="storage-card-content"><div className="storage-card-top"><h3 className="storage-card-head"><span className="icon-chip">{isDriveTarget(target)?<StorageGlyph target={target} size={20}/>:<BrandIcon name="storage" size={20}/>}</span><span className="storage-card-name" title={target.name}>{target.name}</span></h3><OverflowMenu label={'More actions for '+target.name} items={[{label:'Browse backup folders',icon:IconFolder,onSelect:()=>setTreeTarget(previous=>previous?.id===target.id?null:target)},{label:'Remove '+target.name,icon:IconTrash,disabled:removal.busy||removal.waiting,onSelect:()=>removal.ask(target)}]}/></div><p className="storage-card-kind">{isDriveTarget(target)?driveKindText(target):target.kind==='s3'?'S3 object storage':'SFTP'}</p>{target.needsReconnect?<NeedsSignIn/>:data.activeTargetId===target.id&&<StatusLabel state="success">Used for new backups</StatusLabel>}{isDriveTarget(target)?<DriveCardBody target={target} used={usage[target.id]}/>:target.kind==='s3'?<><dl className="def-list"><div className="def-row"><dt>Bucket</dt><dd><code>{target.bucket}</code></dd></div><div className="def-row"><dt>Endpoint</dt><dd><code>{target.endpoint}</code></dd></div><div className="def-row"><dt>Folder</dt><dd><code>{target.root}</code></dd></div><div className="def-row"><dt>Object Lock</dt><dd>{target.objectLock?target.objectLock.mode.charAt(0)+target.objectLock.mode.slice(1).toLowerCase()+', '+target.objectLock.days.toLocaleString()+' days':'Off'}</dd></div><div className="def-row"><dt>Capacity</dt><dd>Not reported</dd></div></dl><Usage used={usage[target.id]}/></>:<><dl className="def-list"><div className="def-row"><dt>Connection</dt><dd><code>{target.username}@{target.host}:{target.port}</code></dd></div><div className="def-row"><dt>Sign-in</dt><dd>{target.auth_type==='password'?'Password':'SSH key'}</dd></div><div className="def-row"><dt>Folder</dt><dd><code>{target.root}</code></dd></div><div className="def-row"><dt>Deletes</dt><dd>{target.writeMode==='append-only'?'Refused (append-only)':'Allowed'}</dd></div><div className="def-row"><dt>Capacity</dt><dd>{formatBytes(target.capacity_bytes)} configured</dd></div></dl><WriteMode target={target}/><Usage used={usage[target.id]} capacity={target.capacity_bytes}/></>}{cardError?.id===target.id&&<AlertPanel variant="error" action={cardError.errorClass?<div className="rp-actions"><ReportProblem summary="Storage connection test" excerptSource={catalogued(cardError.message)||!cardError.message?null:{error:cardError.message}} excerptLabel="Include the error message" build={(facts,opts)=>buildStorageReport({...facts,...opts,protocol:target.kind==='s3'?'s3':'sftp',errorClass:cardError.errorClass,message:cardError.message,explanation:EXPLAIN.storage})}/></div>:undefined}>{cardError.message}</AlertPanel>}{notice?.card===target.id&&<AlertPanel variant="info">{notice.message}</AlertPanel>}<RemovalPanel state={removal} target={target}/></div><div className="card-footer storage-card-actions"><button type="button" className="link-action" aria-label="Test connection" title="Test connection" {...busyProps} onClick={()=>run('/storage-targets/'+target.id+'/test',{},'Storage connection verified.',{card:target.id},'Testing storage connection…').then(result=>{if(result?.olderFilesWritable)setNotice({message:OLDER_FILES,card:target.id});})}><BrandIcon name="refresh" size={20}/> Test</button>{target.needsReconnect&&<button type="button" className="primary" {...busyProps} onClick={()=>setReconnect(target)}><BrandIcon name="refresh" size={20}/> Reconnect</button>}{data.activeTargetId!==target.id&&!target.needsReconnect&&<button type="button" className="primary" aria-label="Use for new backups" title="Use for new backups" {...busyProps} onClick={()=>run('/storage-targets/'+target.id+'/use',{},'New backups will use this destination.',{card:target.id},'Testing storage connection…')}><BrandIcon name="resume" size={20}/> Use for backups</button>}</div></article>)}</div>}</Paginated>:<AlertPanel variant="info">Connect your first destination before running backups. Local fallback is disabled.</AlertPanel>}
  {reconnect&&<ReconnectDialog api={api} target={reconnect} onClose={()=>setReconnect(null)} onSessionExpired={onSessionExpired} onDone={async message=>{setReconnect(null);setNotice({message});await load();await onChanged();setRefreshKey(value=>value+1);}}/>}
  {treeTarget&&<StorageTree api={api} target={treeTarget} refreshKey={refreshKey} onSessionExpired={onSessionExpired}/>}
  {adding&&<StorageDialog busy={busy} onClose={closeForm}><form className="storage-form" onSubmit={connect}><div className="modal-body storage-scroll">
   <div className="field" role="group" aria-labelledby="storage-l-provider"><span id="storage-l-provider">Provider</span><Combo labelledBy="storage-l-provider" value={providerId} onChange={pickProvider} items={PROVIDER_GROUPS.flatMap(group=>group.items.map(item=>({value:item.id,label:item.label,group:group.label,caption:item.sub,icon:item.icon||(item.kind==='s3'?'cloud':'server')})))}/></div>
   <Field key={isDrive?providerId:'name'} label="Destination name" name="name" maxLength={100} required defaultValue={isDrive?provider.label:undefined} {...invalid('name')}/>
   {isDrive?<><DriveFields ref={driveRef} key={provider.kind} api={api} kind={kind} guard={guard} Field={Field} disabled={busy} onReady={setDriveReady}/>{guard.box}</>:kind==='s3'?<S3Fields key={providerId} Field={Field} provider={provider} s3={s3} update={update} invalid={invalid} sites={sites} policies={policies}/>:<div className="storage-sftp" onBlur={checkCapacity}>
   <div className="form-grid"><Field label="Hostname" name="host" required placeholder={provider.host} {...invalid('host')}/><Field label="Port" name="port" type="number" value={sftp.port} onChange={event=>setSftp(previous=>({...previous,port:event.target.value,portTouched:true}))} min={1} max={65535} required help={provider.note} {...invalid('port')}/></div>
   <Field label="Username" name="username" required placeholder={provider.username||undefined} autoComplete="off" {...invalid('username')}/>
   <Field label="Sign-in method" value={authType} onChange={event=>setAuthType(event.target.value)} options={[[ 'password','Password'],['ssh-key','SSH key']]}/>
   {authType==='password'?<Field key="password" label="Password" name="password" type="password" autoComplete="new-password" required maxLength={4096} {...invalid('password')}/>:<Field key="privateKey" label="SSH private key" name="privateKey" multiline autoComplete="off" spellCheck={false} minLength={50} maxLength={30000} required {...invalid('privateKey')}/>}
   <Field label="Host fingerprint" name="hostKey" required placeholder="SHA256:..." pattern="(?:[a-fA-F0-9]{64}|SHA256:[A-Za-z0-9+\/]{43}=?)" title="64 hexadecimal characters, or SHA256: followed by 43 base64 characters." {...invalid('hostKey')} help={'This identifies the server, like an ID check. '+provider.fingerprint+' DockNest refuses a changed fingerprint.'}/>
   <details className="rt-adv storage-more" open={showSteps} onToggle={event=>setShowSteps(event.currentTarget.open)}><summary>Where do I find it?<IconChevronDown size={18} stroke={1.75} className="rt-chev" aria-hidden="true"/></summary>{provider.steps==='ssh'?<p>On a machine you trust, run <code>ssh-keyscan -t ed25519 HOST | ssh-keygen -lf -</code> and copy the SHA256 value. You can also read it from the server's console. This is public server identification, not your password or private key.</p>:<p>{provider.steps}</p>}</details>
   <div className="form-grid"><Field label="Backup directory" name="root" value={sftp.root} onChange={event=>setSftp(previous=>({...previous,root:event.target.value,rootTouched:true}))} required help="DockNest tests this directory before saving the encrypted credential." {...invalid('root')}/><Field label="Capacity (TB)" name="capacityTB" type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*" title="A number of terabytes, for example 1 or 0.5." placeholder="1" value={capacity.text} onChange={event=>setCapacity({text:event.target.value,source:'',touched:true,bytes:null})} help={capacity.source==='checking'?'Checking what the server reports…':capacity.source==='server'?'Reported by the server. You can change it. Usage shown covers DockNest backups only.':'Your quota. Leave empty to use what the server reports, or 1 TB. Usage shown covers DockNest backups only.'} {...invalid('capacityTB')}/></div></div>}
   {formError&&<div id="storage-form-error" tabIndex={-1} ref={errorRef}><AlertPanel variant="error" title="Could not connect storage." action={formError.errorClass?<div className="rp-actions"><ReportProblem summary="Storage connection test" excerptSource={catalogued(formError.message)||!formError.message?null:{error:formError.message}} excerptLabel="Include the error message" build={(facts,opts)=>buildStorageReport({...facts,...opts,protocol:kind==='s3'?'s3':'sftp',errorClass:formError.errorClass,message:formError.message,explanation:EXPLAIN.storage})}/></div>:undefined}>{formError.message}</AlertPanel></div>}
   {complianceBlocked&&<p className="hint" id="compliance-required">Confirm Compliance mode above to continue.</p>}
  </div>
   <div className="modal-foot storage-foot"><button className="link-action" type="button" {...busyProps} onClick={closeForm}>Cancel</button><button className="primary" {...(busy||complianceBlocked||(isDrive&&!driveReady)?{'aria-disabled':'true'}:{})} aria-describedby={complianceBlocked?'compliance-required':undefined}>{busy?'Testing…':'Test & connect'}</button></div>
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
