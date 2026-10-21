import React,{useEffect,useState} from 'react';
import {BrandIcon} from './brand.jsx';
import {Paginated} from './pagination.jsx';
import {formatDate} from './date-format.js';

function StorageTree({api,target,refreshKey,onSessionExpired}) {
 const [tree,setTree]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reload,setReload]=useState(0);
 useEffect(()=>{let current=true;setTree(null);setError('');api('/storage-targets/'+target.id+'/tree').then(result=>{if(current)setTree(result);}).catch(error=>{if(current){if(error.status===401)onSessionExpired();else setError(error.message);}});return()=>{current=false;};},[target.id,reload,refreshKey]);
 async function pin(backup){setBusy(true);setError('');try{await api('/backups/'+backup.id+'/pin',{pinned:!backup.pinned});setReload(value=>value+1);}catch(error){if(error.status===401)onSessionExpired();else setError(error.message);}finally{setBusy(false);}}
 const filename=file=>file.filename||file.relativePath?.split('/').at(-1)||'Encrypted backup';
 return <section className="panel padded">
  <h2>{target.name} · Backup folders</h2><p>Site backups are organized by server and site. DockNest recovery kits have their own folder.</p>
  {error&&<div className="alert" role="alert">{error}<button onClick={()=>setReload(value=>value+1)}>Retry</button></div>}
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
       <div className="actions"><a className="button" href={'/api/backups/'+backup.id+'/download?format=zip'}>Full ZIP</a><a className="button" href={'/api/backups/'+backup.id+'/download'}>Encrypted backup</a><button disabled={busy} onClick={()=>pin(backup)}>{backup.pinned?'Unpin':'Pin'}</button></div>
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

function S3Fields({Field,lock,setLock}) {
 return <>
  <Field label="Endpoint URL" name="endpoint" type="url" required placeholder="https://s3.eu-central-1.amazonaws.com" help="Use your provider's S3 API endpoint, for example https://<account-id>.r2.cloudflarestorage.com or https://s3.us-west-004.backblazeb2.com. HTTPS is required."/>
  <div className="form-grid"><Field label="Region" name="region" defaultValue="us-east-1" required pattern="[a-z0-9-]{1,40}" help="Use auto for Cloudflare R2."/><Field label="Bucket" name="bucket" required pattern="[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]"/></div>
  <div className="form-grid"><Field label="Folder prefix in bucket" name="prefix" defaultValue="docknest" maxLength={200}/><Field label="Addressing style" name="addressing" defaultValue="virtual" options={[['virtual','Virtual-hosted (bucket.endpoint)'],['path','Path-style (endpoint/bucket)']]} help="Choose path-style for MinIO and buckets with dots in their name."/></div>
  <Field label="Access key ID" name="accessKeyId" autoComplete="off" spellCheck={false} required maxLength={128}/>
  <Field label="Secret access key" name="secretAccessKey" type="password" autoComplete="new-password" required maxLength={256} help="Use a key limited to this bucket. DockNest encrypts it and never shows it again."/>
  <label className="check"><input type="checkbox" checked={lock} onChange={event=>setLock(event.target.checked)}/> Keep immutable copies with S3 Object Lock</label>
  {lock&&<div className="form-grid"><Field label="Object Lock mode" name="lockMode" defaultValue="GOVERNANCE" options={[['GOVERNANCE','Governance (privileged users can override)'],['COMPLIANCE','Compliance (nobody can delete early)']]}/><Field label="Keep each backup for (days)" name="lockDays" type="number" defaultValue={30} min={1} max={36500} required/></div>}
  <p className="hint">DockNest uploads a test object with multipart upload, copies, reads a byte range and deletes it before saving the encrypted key. {lock?'The bucket must have Object Lock enabled and no default retention rule. Retention is applied when each backup is published; locked backups are kept until it expires, even if retention would remove them sooner.':'Object storage does not report capacity; usage shown here covers DockNest backups.'}</p>
 </>;
}

export function StorageTargets({api,Field,onChanged,onSessionExpired}) {
 const [data,setData]=useState(null),[adding,setAdding]=useState(false),[authType,setAuthType]=useState('password'),[kind,setKind]=useState('sftp'),[lock,setLock]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[treeTarget,setTreeTarget]=useState(null),[refreshKey,setRefreshKey]=useState(0);
 async function load(){try{setData(await api('/storage-targets'));}catch(error){if(error.status===401)onSessionExpired();else setError(error.message);}}
 useEffect(()=>{load();},[]);
 async function run(path,body,message){setBusy(true);setError('');setNotice('');try{const result=await api(path,body);setNotice(message);await load();await onChanged();setRefreshKey(value=>value+1);return result;}catch(error){if(error.status===401)onSessionExpired();else setError(error.message);return null;}finally{setBusy(false);}}
 async function connect(event){event.preventDefault();if(busy)return;const form=event.currentTarget,fields=Object.fromEntries(new FormData(form));const result=kind==='s3'?await run('/storage-targets/s3/connect',{name:fields.name,endpoint:fields.endpoint,region:fields.region,bucket:fields.bucket,prefix:fields.prefix,pathStyle:fields.addressing==='path',accessKeyId:fields.accessKeyId,secretAccessKey:fields.secretAccessKey,objectLock:lock?{mode:fields.lockMode,days:Number(fields.lockDays)}:null},'Storage connected. Upload, copy, ranged read and delete checks passed.'):await run('/storage-targets/connect',{name:fields.name,host:fields.host,port:Number(fields.port),username:fields.username,hostKey:fields.hostKey,root:fields.root,capacityBytes:Number(fields.capacityTB)*1e12,authType,...(authType==='password'?{password:fields.password}:{privateKey:fields.privateKey})},'Storage connected. Write, read and rename checks passed.');if(result){form.reset();setAdding(false);}}
 return <>
  <section className="panel padded storage-intro"><div><h2><BrandIcon name="storage" size={24}/>Remote backup destinations</h2><p>Backup files stay on the selected destination. The dashboard keeps metadata and the encryption key. Choosing another destination affects new backups; existing backups remain with their original destination.</p></div><div className="form-actions"><button className="primary" disabled={busy} onClick={()=>{setAdding(value=>!value);setError('');}}>{adding?'Cancel connection':'Add storage destination'}</button></div></section>
  {error&&<div className="alert" role="alert">{error}</div>}{notice&&<div className="notice" role="status">{notice}</div>}
  {!data?<p role="status">Loading storage destinations…</p>:data.targets.length?<Paginated rows={data.targets} label="Storage destinations" pageSize={2}>{visible=><div className="storage-grid">{visible.map(target=><article className="storage-card" key={target.id}><div className="storage-card-content"><h3><BrandIcon name="storage" size={28}/><span>{target.name}{data.activeTargetId===target.id?' · Selected for new backups':''}</span></h3>{target.kind==='s3'?<><p>S3 bucket {target.bucket} · {target.endpoint}</p><small>{target.root} · {target.objectLock?'Object Lock '+target.objectLock.mode.toLowerCase()+', '+target.objectLock.days.toLocaleString()+' days':'No Object Lock'} · Capacity not reported</small></>:<><p>{target.username}@{target.host}:{target.port} · {target.auth_type==='password'?'Password':'SSH key'}</p><small>{target.root} · {(target.capacity_bytes/1e12).toLocaleString()} TB configured capacity</small></>}</div><div className="storage-card-actions"><button onClick={()=>setTreeTarget(previous=>previous?.id===target.id?null:target)}><BrandIcon name="backups" size={20}/> Browse backup folders</button><button disabled={busy} onClick={()=>run('/storage-targets/'+target.id+'/test',{},'Storage connection verified.')}><BrandIcon name="refresh" size={20}/> Test connection</button>{data.activeTargetId===target.id?<button disabled><BrandIcon name="readiness" size={20}/> Selected for new backups</button>:<button disabled={busy} onClick={()=>run('/storage-targets/'+target.id+'/use',{},'New backups will use this destination.')}><BrandIcon name="resume" size={20}/> Use for new backups</button>}</div></article>)}</div>}</Paginated>:<div className="notice">Connect your first destination before running backups. Local fallback is disabled.</div>}
  {treeTarget&&<StorageTree api={api} target={treeTarget} refreshKey={refreshKey} onSessionExpired={onSessionExpired}/>}
  {adding&&<section className="panel padded"><h2>Connect storage</h2><form onSubmit={connect}>
   <Field label="Destination name" name="name" maxLength={100} required/>
   <Field label="Destination type" value={kind} onChange={event=>setKind(event.target.value)} options={[['sftp','SFTP server'],['s3','S3-compatible object storage']]} help="S3-compatible covers AWS S3, Cloudflare R2, Backblaze B2, Wasabi and MinIO."/>
   {kind==='s3'?<S3Fields Field={Field} lock={lock} setLock={setLock}/>:<>
   <div className="form-grid"><Field label="Storage hostname" name="host" required/><Field label="SFTP port" name="port" type="number" defaultValue={22} min={1} max={65535} required/></div>
   <Field label="Storage username" name="username" required/>
   <Field label="Authentication method" value={authType} onChange={event=>setAuthType(event.target.value)} options={[[ 'password','Password'],['ssh-key','SSH key']]}/>
   {authType==='password'?<Field key="password" label="Storage password" name="password" type="password" autoComplete="new-password" required maxLength={4096}/>:<Field key="privateKey" label="Storage SSH private key" name="privateKey" multiline autoComplete="off" spellCheck={false} minLength={50} maxLength={30000} required/>}
   <Field label="Verified SSH host fingerprint" name="hostKey" required pattern="(?:[a-fA-F0-9]{64}|SHA256:[A-Za-z0-9+/]{43}=?)" help="This identifies the storage server, like an ID check. Copy its SSH fingerprint from the Storage Box overview in Hetzner Console. DockNest refuses changed fingerprints to protect your password and backups."/>
   <details><summary>Where do I find the fingerprint?</summary><p>Open Hetzner Console, select your Storage Box, and find its SSH host fingerprints in the overview. Copy the SHA256 fingerprint matching the SSH host-key algorithm. This is public server identification, not your password or private key.</p></details>
   <div className="form-grid"><Field label="Backup directory on storage" name="root" defaultValue="/home/docknest" required/><Field label="Capacity (TB)" name="capacityTB" type="number" defaultValue={1} min={0.001} max={9000} step={0.001} required/></div>
   <p className="hint">DockNest tests this directory before saving the encrypted credential. Capacity is your configured quota; usage shown here covers DockNest backups. Port 23 requires SSH support enabled in Hetzner Console.</p></>}
   <div className="form-actions"><button className="primary" disabled={busy}>{busy?'Testing storage…':'Test & connect storage'}</button></div>
  </form></section>}
 </>;
}
