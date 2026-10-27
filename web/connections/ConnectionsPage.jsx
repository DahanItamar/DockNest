import React,{useCallback,useEffect,useMemo,useState} from 'react';
import {IconPencil,IconSend,IconTrash,IconPlugConnected,IconPlus,IconEye} from '@tabler/icons-react';
import {AlertPanel,IconButton,StatusLabel} from '../system.jsx';
import {DataTable} from '../data-table.jsx';
import {Paginated} from '../pagination.jsx';
import {createConnectionsClient,testState,usedByText} from './client.js';
import {ProviderIcon,SwitchRow} from './parts.jsx';
import {ConnectionDialog,DeleteConnectionDialog,useReauth} from './ConnectionDialog.jsx';
import './connections.css';

// Administration, Connections (docs/alert-channels.md, "Screens"): the logins alerts use. One table with straight
// columns (Name, Provider, Used by, Last test, Actions); on phones the rows become labelled records. A failed real send
// shows a warning panel. The settings (administrators only) are two switches that ask for a fresh sign-in check.
// Loads once and after each change; nothing polls.
export function ConnectionsPage({api,user,openNew=0,onSessionExpired}){
 const client=useMemo(()=>createConnectionsClient(api),[api]);
 const [data,setData]=useState(null),[providers,setProviders]=useState([]),[error,setError]=useState(null),[dialog,setDialog]=useState(null),[note,setNote]=useState(null),[testing,setTesting]=useState(null);
 const load=useCallback(async()=>{
  try{const [list,p]=await Promise.all([client.list(),client.providers()]);setData(list);setProviders(p.providers||[]);setError(null)}
  catch(e){if(e.status===401)return onSessionExpired?.();setError(e)}
 },[client]);
 useEffect(()=>{load()},[load]);
 useEffect(()=>{if(openNew&&data)setDialog({kind:'new'})},[openNew]);
 const byId=useMemo(()=>Object.fromEntries(providers.map(p=>[p.id,p])),[providers]);
 const role=data?.role||user?.role;
 async function test(c){
  setTesting(c.id);setNote(null);
  try{const r=await client.test(c.id);setNote({ok:true,text:`${c.name}: ${r.note||'Delivered.'}`})}
  catch(e){setNote({ok:false,text:`${c.name}: ${e.message||'The test message could not be sent.'}`})}
  setTesting(null);await load();
 }
 if(error&&!data)return error.code==='ALERTS_ADMIN_REQUIRED'?<AlertPanel variant="info" title="Alerts are managed by an administrator">An administrator can let operators manage alerts in Connections settings.</AlertPanel>
  :<div className="loading" role="alert">{error.message||'Connections could not be loaded.'}<button type="button" onClick={load}>Retry</button></div>;
 if(!data)return <div className="loading" role="status">Loading connections…</div>;
 const list=data.connections||[],failed=list.filter(c=>c.lastSend==='failed'&&c.sendError);
 const close=()=>setDialog(null);
 const rows=visible=>visible.map(c=>{const p=byId[c.provider],s=testState(c,p),mine=c.editable!==false;return <tr key={c.id}>
  <td><b className="cx-trunc" title={c.name}>{c.name}</b></td>
  <td><span className="cx-prov"><ProviderIcon icon={p?.icon}/><span className="cx-trunc">{p?.label||c.provider}</span></span></td>
  <td><span className="cx-trunc" title={usedByText(c)}>{(c.usedBy||[]).length?usedByText(c):<span className="cx-muted">Not used</span>}</span></td>
  <td><StatusLabel state={s.state}>{testing===c.id?'Sending…':s.text}</StatusLabel></td>
  <td><div className="actions row-actions">
   <IconButton label={(mine?'Edit ':'View ')+c.name} icon={mine?IconPencil:IconEye} onClick={()=>setDialog({kind:'edit',connection:c})}/>
   <IconButton label={'Send test with '+c.name} icon={IconSend} disabled={testing===c.id} onClick={()=>test(c)}/>
   {mine&&<IconButton label={'Delete '+c.name} icon={IconTrash} onClick={()=>setDialog({kind:'delete',connection:c})}/>}
  </div></td>
 </tr>});
 return <div className="cx-page">
  {data.legacyChanged&&<AlertPanel variant="warning">Alert changes made in an older DockNest version are not shown here. Enter them again.</AlertPanel>}
  {failed.slice(0,3).map(c=><AlertPanel key={c.id} variant="error" title={`${c.name} failed`} action={c.editable!==false&&<div className="cx-panel-actions"><button type="button" className="primary" onClick={()=>setDialog({kind:'edit',connection:c})}>Edit connection</button></div>}>The last message did not reach {byId[c.provider]?.label||'the provider'}. {c.sendError}</AlertPanel>)}
  {failed.length>3&&<p className="t-caption">{failed.length-3} more connections failed. Their rows say Failed.</p>}
  <div role="status" aria-live="polite">{note&&<AlertPanel variant={note.ok?'info':'error'}>{note.text}</AlertPanel>}</div>
  <section className="panel" aria-label="Connections">
   {list.length?<Paginated rows={list} label="Connections" pageSize={10}>{visible=><DataTable headers={['Name','Provider','Used by','Last test','Actions']} columns={['22%','18%','20%','24%','16%']} numeric={[4]}>{rows(visible)}</DataTable>}</Paginated>
    :<div className="empty"><span className="empty-icon"><IconPlugConnected size={28} stroke={1.5} aria-hidden="true"/></span><h3>No connections yet</h3><p>A connection holds the login for one provider. Add one, then pick it on an alert node.</p><button type="button" className="primary" onClick={()=>setDialog({kind:'new'})}><IconPlus size={18} stroke={2} aria-hidden="true"/>New connection</button></div>}
  </section>
  {role==='admin'&&<Settings client={client} settings={data.settings} onChanged={load}/>}
  {(dialog?.kind==='new'||dialog?.kind==='edit')&&<ConnectionDialog key={dialog.connection?.id||'new'} client={client} providers={providers} connection={dialog.connection} role={role} onClose={close} onSaved={async(view,created)=>{close();setNote({ok:true,text:created?`${view.name} is saved. Pick it on an alert node on the Map.`:`${view.name} is saved.`});await load()}}/>}
  {dialog?.kind==='delete'&&<DeleteConnectionDialog client={client} connection={dialog.connection} onClose={close} onDeleted={async()=>{close();setNote({ok:true,text:`${dialog.connection.name} is deleted.`});await load()}}/>}
 </div>;
}

// "Allow private network" and "Operators can manage alerts": administrators only, each change after a fresh check.
function Settings({client,settings,onChanged}){
 const guard=useReauth(client),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function change(body){setBusy(true);setError('');await guard.run(async()=>{await client.settings(body);await onChanged()},e=>setError(e.message||'The setting was not changed.'));setBusy(false)}
 return <section className="panel padded cx-settings" aria-labelledby="cx-settings-title">
  <h2 id="cx-settings-title" className="t-section">Connections settings</h2>
  <SwitchRow id="cx-private" label="Allow private network" help="Connections an administrator saves while this is on may reach servers on your own network, such as a self-hosted ntfy, Gotify, Matrix or Mattermost. Loopback and cloud metadata addresses stay blocked." checked={!!settings?.allowPrivateNetwork} disabled={busy||guard.waiting} onChange={v=>change({allowPrivateNetwork:v})}/>
  <SwitchRow id="cx-operators" label="Operators can manage alerts" help="Operators can then add and change alert nodes and connections, and send their alert text to accounts they choose. They never see saved secrets. Other (webhook URL) and these settings stay with administrators." checked={!!settings?.operatorsManage} disabled={busy||guard.waiting} onChange={v=>change({operatorsManage:v})}/>
  {error&&<AlertPanel variant="error">{error}</AlertPanel>}
  {guard.box}
 </section>;
}
