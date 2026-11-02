import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {IconKey,IconPlus,IconCopy,IconRefresh,IconTrash,IconX,IconLock} from '@tabler/icons-react';
import {AlertPanel,IconButton} from '../system.jsx';
import {DataTable} from '../data-table.jsx';
import {Paginated} from '../pagination.jsx';
import {ago} from './client.js';
import {useReauth} from './ConnectionDialog.jsx';
import './deploy-keys.css';

// Deploy keys (docs/launch-site.md, "Deploy keys"): one section on the Connections page, administrators only.
// A key is created in three steps: name, Git host and the server to read the host key from; the host key's SHA-256 to
// confirm; then the public key to add at the Git host as a read-only deploy key. The private key stays sealed in DockNest.
export function createDeployKeysClient(api){
 const id=x=>encodeURIComponent(x);
 return {
  list:()=>api('/deploy-keys'),
  // Without hostKeySha256 the server only reads the Git host's key and answers 409 HOST_KEY_CONFIRM with its fingerprint
  // (e.data.hostKey.sha256), creating nothing. With it, the key is read again, must still match, and is created.
  create:body=>api('/deploy-keys',body),
  // The same two steps to pin the host key again (after the Git host rotated its key, or from another server).
  pin:(keyId,body)=>api('/deploy-keys/'+id(keyId)+'/pin',body),
  remove:keyId=>api('/deploy-keys/'+id(keyId),undefined,'DELETE')
 };
}

function Dlg({labelId,title,onClose,foot,confirm,children}){
 const ref=useRef(null);
 useEffect(()=>{const d=ref.current;if(d&&!d.open)d.showModal();d?.querySelector('h2')?.focus();return()=>{if(d?.open)d.close()}},[]);
 return <dialog ref={ref} className={confirm?'cx-dialog cx-confirm':'site-wizard rt-dialog cx-dialog'} aria-labelledby={labelId} onCancel={e=>{e.preventDefault();onClose()}}>
  <div className="modal-head"><h2 id={labelId} tabIndex={-1}>{title}</h2><button type="button" className="icon" aria-label="Close dialog" onClick={onClose}><IconX size={20}/></button></div>
  <form className="modal-body cx-form" onSubmit={e=>e.preventDefault()}>{children}<div className="modal-foot">{foot}</div></form>
 </dialog>;
}
const Fingerprint=({label,id,value})=><div className="field" role="group" aria-labelledby={id}><span id={id}>{label}</span><pre className="command-preview cx-wrap" tabIndex={0} aria-labelledby={id}>{value}</pre></div>;

function useCopy(){
 const [copied,setCopied]=useState(false);
 return [copied,async text=>{try{await navigator.clipboard.writeText(text);setCopied(true)}catch{setCopied(false)}}];
}

const Private=({checked,onChange})=><label className="cx-check"><input type="checkbox" checked={checked} onChange={e=>onChange(e.target.checked)}/>Allow private address</label>;

function NewKeyDialog({client,connections,servers,onClose,onCreated}){
 const guard=useReauth(connections,{verifyLabel:'Verify'}),[step,setStep]=useState('form'),[name,setName]=useState(''),[host,setHost]=useState(''),[serverId,setServerId]=useState(servers[0]?.id||'');
 const [fp,setFp]=useState(''),[key,setKey]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[priv,setPriv]=useState(false),[showPriv,setShowPriv]=useState(false),[copied,copy]=useCopy();
 const hostName=host.trim().toLowerCase(),server=servers.find(s=>s.id===serverId);
 const ready=name.trim().length>0&&hostName.length>0&&!!serverId;
 const base={name:name.trim(),gitHost:hostName,serverId,...(priv?{allowPrivate:true}:{})};
 // Next: the server reads the host key and asks for the confirmation (409 HOST_KEY_CONFIRM); nothing is created yet.
 async function next(){
  setBusy(true);setError('');
  await guard.run(async()=>{await client.create(base);setError('The host key was not offered for confirmation.')},e=>{
   if(e.code==='HOST_KEY_CONFIRM'){setFp(e.data?.hostKey?.sha256||'');setStep('host');return}
   if(e.code==='PRIVATE_ADDRESS')setShowPriv(true);
   setError(e.message||'The host key could not be read.');
  });
  setBusy(false);
 }
 // Pin key: the server reads the key again and creates the pair only if it is still the one that was confirmed.
 async function pin(){
  setBusy(true);setError('');
  await guard.run(async()=>{const r=await client.create({...base,hostKeySha256:fp});setKey(r.key);setStep('pub');onCreated?.()},e=>{
   if(e.code==='HOST_KEY_CHANGED'&&e.data?.hostKey?.sha256)setFp(e.data.hostKey.sha256);
   setError(e.message||'The key could not be created.');
  });
  setBusy(false);
 }
 if(step==='pub')return <Dlg labelId="dk-title" title={key.name} onClose={onClose} foot={<button type="button" className="primary" onClick={onClose}>Done</button>}>
  <div className="field" role="group" aria-labelledby="dk-pub"><span id="dk-pub">Public key</span><pre className="command-preview cx-wrap" tabIndex={0} aria-labelledby="dk-pub">{key.publicKey}</pre></div>
  <div><button type="button" onClick={()=>copy(key.publicKey)}><IconCopy size={18} stroke={1.75} aria-hidden="true"/>{copied?'Copied':'Copy'}</button></div>
  <AlertPanel variant="info">Add it as a read-only deploy key at {key.gitHost}.</AlertPanel>
  <div className="field"><span>Pinned host key</span><div className="cx-saved"><span><IconLock size={18} stroke={1.75} aria-hidden="true"/>{key.gitHost}, from {key.pinnedFromServerName||server?.name||'the server'}</span></div></div>
 </Dlg>;
 if(step==='host')return <Dlg labelId="dk-title" title={'Confirm '+hostName} onClose={onClose} foot={<><button type="button" onClick={()=>{setStep('form');setError('')}}>Back</button><button type="button" className="primary" disabled={busy||guard.waiting} onClick={pin}>Pin key</button></>}>
  <p>{server?.name||'The server'} sees this host key for {hostName}. Compare it with the one your Git host publishes.</p>
  <Fingerprint label="SHA-256 fingerprint" id="dk-fp" value={fp}/>
  <AlertPanel variant="info">DockNest pins this key. A different key later is refused until you re-pin it.</AlertPanel>
  {error&&<AlertPanel variant="error">{error}</AlertPanel>}
  {guard.box}
 </Dlg>;
 return <Dlg labelId="dk-title" title="New deploy key" onClose={onClose} foot={<><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={!ready||busy||guard.waiting} onClick={next}>Next</button></>}>
  <label className="field"><span>Name</span><input type="text" autoComplete="off" spellCheck={false} maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label>
  <label className="field"><span>Git host</span><input type="text" autoComplete="off" spellCheck={false} inputMode="url" value={host} onChange={e=>setHost(e.target.value)}/></label>
  <label className="field"><span>Read from</span><select value={serverId} onChange={e=>setServerId(e.target.value)}>{servers.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
  {showPriv&&<Private checked={priv} onChange={setPriv}/>}
  <p className="t-caption">DockNest reads the host key from this server and asks you to confirm it.</p>
  {error&&<AlertPanel variant="error">{error}</AlertPanel>}
  {guard.box}
 </Dlg>;
}

// Pin the host key again: read it (again from the pinned server, or from another one), compare with the pinned key, confirm.
function RepinDialog({client,connections,item,servers,onClose,onDone}){
 const guard=useReauth(connections,{verifyLabel:'Verify'}),[serverId,setServerId]=useState(item.pinnedFromServerId||servers[0]?.id||''),[state,setState]=useState({loading:true}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[priv,setPriv]=useState(false),[showPriv,setShowPriv]=useState(false),[moved,setMoved]=useState(null);
 const base={serverId,...(priv?{allowPrivate:true}:{})};
 useEffect(()=>{
  let live=true;setState({loading:true});
  guard.run(async()=>{await client.pin(item.id,base);if(live)setState({error:'The host key was not offered for confirmation.'})},e=>{
   if(!live)return;
   if(e.code==='HOST_KEY_CONFIRM')return setState({fingerprint:e.data?.hostKey?.sha256||''});
   if(e.code==='PRIVATE_ADDRESS')setShowPriv(true);
   setState({error:e.message||'The host key could not be read.'});
  });
  return()=>{live=false};
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[client,item.id,serverId,priv]);
 const pinned=item.hostKey?.sha256,sameKey=state.fingerprint&&state.fingerprint===pinned,sameServer=serverId===item.pinnedFromServerId,nothing=sameKey&&sameServer;
 async function go(){setBusy(true);setError('');await guard.run(async()=>{const r=await client.pin(item.id,{...base,hostKeySha256:state.fingerprint});if(r?.replacedPin)setMoved(r.replacedPin);else await onDone()},e=>{
   if(e.code==='HOST_KEY_CHANGED'&&e.data?.hostKey?.sha256)setState({fingerprint:e.data.hostKey.sha256});
   setError(e.message||'The host key could not be pinned.');
  });setBusy(false)}
 if(moved)return <Dlg labelId="dk-title" title={'Re-pin '+item.gitHost} onClose={onDone} foot={<button type="button" className="primary" onClick={onDone}>Done</button>}>
  <AlertPanel variant="info">{moved.text}</AlertPanel>
 </Dlg>;
 return <Dlg labelId="dk-title" title={'Re-pin '+item.gitHost} onClose={onClose} foot={<><button type="button" onClick={onClose}>{nothing||state.error?'Close':'Cancel'}</button>{!nothing&&!state.error&&<button type="submit" className="primary" disabled={state.loading||busy||guard.waiting} onClick={go}>Re-pin</button>}</>}>
  {servers.length>1&&<label className="field"><span>Read from</span><select value={serverId} onChange={e=>setServerId(e.target.value)}>{servers.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
  {showPriv&&<Private checked={priv} onChange={setPriv}/>}
  {state.loading&&<p className="t-caption" role="status">Reading the host key…</p>}
  {state.error&&<AlertPanel variant="error">{state.error}</AlertPanel>}
  {nothing&&<AlertPanel variant="info">{item.gitHost} sends the same key as before. Nothing to change.</AlertPanel>}
  {state.fingerprint&&!nothing&&<>
   {sameKey?<AlertPanel variant="info">{item.gitHost} sends the same key. Pin it from this server to use the key there.</AlertPanel>
    :<AlertPanel variant="warning" title="Host key changed">{item.gitHost} now sends a different key. Continue only if you expect that.</AlertPanel>}
   {!sameKey&&<Fingerprint label="Pinned" id="dk-old" value={pinned}/>}
   <Fingerprint label={sameKey?'Host key':'Now'} id="dk-new" value={state.fingerprint}/>
  </>}
  {error&&<AlertPanel variant="error">{error}</AlertPanel>}
  {guard.box}
 </Dlg>;
}

function DeleteKeyDialog({client,connections,item,onClose,onDeleted}){
 const guard=useReauth(connections,{verifyLabel:'Verify'}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function go(){setBusy(true);setError('');await guard.run(async()=>{await client.remove(item.id);await onDeleted()},e=>setError(e.message||'This key could not be deleted.'));setBusy(false)}
 return <Dlg confirm labelId="dk-title" title={'Delete '+item.name+'?'} onClose={onClose} foot={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy||guard.waiting} onClick={go}>Delete</button></>}>
  <p>The key is removed from DockNest. Also remove its public key at {item.gitHost}.</p>
  {error&&<AlertPanel variant="error">{error}</AlertPanel>}
  {guard.box}
 </Dlg>;
}

export function DeployKeys({api,connections,servers=[]}){
 const client=useMemo(()=>createDeployKeysClient(api),[api]);
 const [keys,setKeys]=useState(null),[error,setError]=useState(null),[dialog,setDialog]=useState(null),[note,setNote]=useState(null);
 const load=useCallback(async()=>{try{const r=await client.list();setKeys(Array.isArray(r?.keys)?r.keys:[]);setError(null)}catch(e){setError(e)}},[client]);
 useEffect(()=>{load()},[load]);
 const byServer=useMemo(()=>Object.fromEntries(servers.map(s=>[s.id,s.name])),[servers]);
 async function copyKey(k){
  try{await navigator.clipboard.writeText(k.publicKey);setNote({ok:true,text:`Public key of ${k.name} copied.`})}
  catch(e){setNote({ok:false,text:`${k.name}: ${e.message||'The public key could not be copied.'}`})}
 }
 const close=()=>setDialog(null);
 const newButton=<button type="button" className="primary" disabled={!servers.length} onClick={()=>setDialog({kind:'new'})}><IconPlus size={16} stroke={2} aria-hidden="true"/>New key</button>;
 const rows=visible=>visible.map(k=><tr key={k.id}>
  <td><b className="cx-trunc" title={k.name}>{k.name}</b></td>
  <td><span className="cx-trunc" title={k.gitHost}>{k.gitHost}</span></td>
  <td><span className="cx-trunc">{k.pinnedFromServerName||byServer[k.pinnedFromServerId]||'Removed server'}</span></td>
  <td><span className="cx-trunc">{ago(k.createdAt)}</span></td>
  <td><div className="actions row-actions">
   <IconButton label={'Copy public key of '+k.name} icon={IconCopy} onClick={()=>copyKey(k)}/>
   <IconButton label={'Re-pin host key of '+k.name} icon={IconRefresh} onClick={()=>setDialog({kind:'repin',item:k})}/>
   <IconButton label={'Delete '+k.name} icon={IconTrash} onClick={()=>setDialog({kind:'delete',item:k})}/>
  </div></td>
 </tr>);
 return <>
  <div role="status" aria-live="polite">{note&&<AlertPanel variant={note.ok?'info':'error'}>{note.text}</AlertPanel>}</div>
  <section className="panel dk-panel" aria-labelledby="dk-heading">
   <div className="panel-head"><h2 id="dk-heading"><IconKey size={24} stroke={1.5} className="brand-icon" aria-hidden="true"/>Deploy keys</h2>{keys?.length>0&&newButton}</div>
   {error&&!keys?<div className="loading" role="alert">{error.message||'Deploy keys could not be loaded.'}<button type="button" onClick={load}>Retry</button></div>
    :!keys?<div className="loading" role="status">Loading deploy keys…</div>
    :keys.length?<Paginated rows={keys} label="Deploy keys" pageSize={10}>{visible=><DataTable headers={['Name','Git host','Pinned from','Created','Actions']} columns={['26%','20%','22%','18%','14%']} numeric={[4]}>{rows(visible)}</DataTable>}</Paginated>
    :<div className="empty"><span className="empty-icon"><IconKey size={28} stroke={1.5} aria-hidden="true"/></span><h3>No deploy keys yet</h3><p>A deploy key lets DockNest read one private Git repository. Add its public key at your Git host as read-only.</p>{newButton}</div>}
  </section>
  {dialog?.kind==='new'&&<NewKeyDialog client={client} connections={connections} servers={servers} onClose={()=>{close();load()}} onCreated={load}/>}
  {dialog?.kind==='repin'&&<RepinDialog client={client} connections={connections} item={dialog.item} servers={servers} onClose={close} onDone={async()=>{close();setNote({ok:true,text:`${dialog.item.gitHost} is pinned again.`});await load()}}/>}
  {dialog?.kind==='delete'&&<DeleteKeyDialog client={client} connections={connections} item={dialog.item} onClose={close} onDeleted={async()=>{const k=dialog.item;close();setNote({ok:true,text:`${k.name} is deleted.`});await load()}}/>}
 </>;
}
