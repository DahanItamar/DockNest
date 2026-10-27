import React,{useEffect,useMemo,useState} from 'react';
import {IconDownload,IconCircleX,IconCircleCheck,IconAlertTriangle,IconBell,IconChevronRight,IconPencil,IconTrash} from '@tabler/icons-react';
import {IconButton} from '../system.jsx';
import {Sheet,Note,useGuard} from './MoveFlow.jsx';
import {SidePanel} from './Panels.jsx';
import {friendly} from './moves-client.js';
import {EVENT_LABEL,EVENTS_FOR,DEFAULT_EVENTS,words,sameSource,nodeOf} from './alerts-client.js';
import {Combo,ProviderIcon} from '../connections/parts.jsx';
import {ConnectionDialog} from '../connections/ConnectionDialog.jsx';
import {GROUPS,testState} from '../connections/client.js';

// The alert parts of the Map (docs/alert-channels.md, "Screens"): a node is one provider plus one Connection; lines say
// which events of a server, a site or DockNest it sends. Logins live in Connections (Administration), never on a node.
export const providerOf=(providers,id)=>providers.find(p=>p.id===id)||null;
export const NodeIcon=({provider,size=32,stroke=1.5})=>provider?<ProviderIcon icon={provider.icon} size={size} stroke={stroke} className="map-node-ic"/>:<IconBell size={size} stroke={stroke} aria-hidden="true"/>;
export const DockNestIcon=({size=32,stroke=1.5})=><IconDownload size={size} stroke={stroke} aria-hidden="true"/>;
export const srcKey=s=>s.kind+':'+(s.id||'');
const label=(providers,id)=>providerOf(providers,id)?.label||id;

// Phone, keyboard and "Add alert": choose the node for a source; its panel opens with that source added.
export function PickSheet({source,nodes,rules,providers,onPick,onAdd,onClose}){
 return <Sheet title={`Send alerts from ${source.name} to`} labelId="map-pick-title" onClose={onClose} actions={<button type="button" onClick={onClose}>Cancel</button>}>
  {nodes.length>0?<ul className="map-targets">{nodes.map(n=>{const has=rules.some(r=>nodeOf(r)===n.id&&sameSource(r,source));
   return <li key={n.id}><button type="button" onClick={()=>onPick(n)}><b>{n.name}</b><span className="map-caption">{label(providers,n.provider)}{has?'. Already connected, you can change it.':''}</span></button></li>})}</ul>
  :<p>You have no alert nodes yet. Add one, then connect it.</p>}
  <div className="map-inline-actions"><button type="button" onClick={onAdd}>Add alert node</button></div>
 </Sheet>;
}

// Send test through the node's Connection. WhatsApp and Teams say "Accepted": they only learn the service took it.
export function TestBox({onTest,disabled,dirty}){
 const [state,setState]=useState({busy:false,text:'',ok:false});
 async function run(){setState({busy:true,text:'',ok:false});try{const r=await onTest();setState({busy:false,ok:true,text:r?.note||'Delivered.'})}catch(e){setState({busy:false,ok:false,text:e.message||'The test message could not be sent.'})}}
 return <div className="map-test"><button type="button" className="primary" disabled={state.busy||disabled} onClick={run}>{state.busy?'Sending…':'Send test'}</button>{dirty&&<span className="map-caption">Sends through the chosen connection.</span>}
  <div role="status" aria-live="polite">{state.text&&<p className={'map-result '+(state.ok?'ok':'bad')}>{state.ok?<IconCircleCheck size={16} stroke={2} aria-hidden="true"/>:<IconCircleX size={16} stroke={2} aria-hidden="true"/>}<span>{state.text}</span></p>}</div></div>;
}

const draftOf=(source,rule)=>({key:srcKey(source),source,ruleId:rule?.id||null,events:new Set(rule?rule.events:DEFAULT_EVENTS[source.kind]||[]),first:rule?[...rule.events].join():null,gone:false});

// The one place to set an alert node up: Name, Provider and Connection, then "Sends when" with one block per connected
// source. Save applies every change at once (node, then lines); Cancel discards them all. No delete here: a node is
// deleted on the grid (Delete key or its corner icon) or in the phone list.
export function AlertPanel({narrow,node,startProvider,rules,connections,providers,sourceList,sourceName,preselect,scrollTo,client,connClient,role,onClose,onSaved,onReload}){
 const edit=!!node,guard=useGuard(client);
 const [name,setName]=useState(node?.name||providerOf(providers,startProvider)?.label||''),[providerId,setProviderId]=useState(node?.provider||startProvider||''),[connectionId,setConnectionId]=useState(node?.connectionId||'');
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[made,setMade]=useState(null),[tab,setTab]=useState(scrollTo?'sends':'settings'),[dialog,setDialog]=useState(null);
 const [drafts,setDrafts]=useState(()=>{
  const mine=node?rules.filter(r=>nodeOf(r)===node.id).map(r=>draftOf({kind:r.sourceKind,id:r.sourceId||null,name:sourceName(r)},r)):[];
  if(preselect&&!mine.some(d=>d.key===srcKey(preselect)))mine.push(draftOf(preselect,null));
  return mine;
 });
 const [pick,setPick]=useState(''),live=made||node,item=providerOf(providers,providerId);
 useEffect(()=>{if(scrollTo)document.querySelector(`[data-src="${scrollTo}"]`)?.scrollIntoView({block:'nearest'})},[scrollTo,tab]);
 const visible=drafts.filter(d=>!d.gone),free=useMemo(()=>sourceList.filter(s=>!visible.some(d=>d.key===srcKey(s))),[sourceList,drafts]);
 const setEvents=(key,fn)=>setDrafts(l=>l.map(d=>d.key===key?{...d,events:fn(new Set(d.events))}:d));
 const toggle=(key,e)=>setEvents(key,s=>{s.has(e)?s.delete(e):s.add(e);return s});
 const disconnect=key=>setDrafts(l=>l.flatMap(d=>d.key!==key?[d]:d.ruleId?[{...d,gone:true}]:[]));
 const addSource=()=>{const s=sourceList.find(x=>srcKey(x)===pick);if(!s)return;setDrafts(l=>[...l.filter(d=>d.key!==pick),draftOf(s,null)]);setPick('');setTimeout(()=>document.querySelector(`[data-src="${srcKey(s)}"]`)?.scrollIntoView({block:'nearest'}),0)};
 const mine=connections.filter(c=>c.provider===providerId),connection=mine.find(c=>c.id===connectionId)||null;
 // A new provider clears the Connection; Save waits until one of the new provider is chosen.
 function chooseProvider(id){if(id===providerId)return;const p=providerOf(providers,id);setProviderId(id);setConnectionId('');if(!name.trim()||providers.some(x=>name===x.label))setName(p?.label||'');setError('')}
 const dirty=!live||name!==live.name||providerId!==live.provider||connectionId!==(live.connectionId||'');
 const ready=name.trim()&&providerId&&connectionId&&visible.every(d=>d.events.size>0);
 async function save(){
  setBusy(true);setError('');
  await guard.run(async()=>{
   let n=live;
   if(!n){n=await client.createNode({name:name.trim(),provider:providerId,connectionId});setMade(n)}
   else if(dirty)n=await client.updateNode(n.id,{...(name!==n.name?{name:name.trim()}:{}),...(providerId!==n.provider?{provider:providerId}:{}),...(connectionId!==(n.connectionId||'')?{connectionId}:{})});
   const next=[...drafts];
   try{
    for(let i=0;i<drafts.length;i++){
     const d=drafts[i],evs=EVENTS_FOR[d.source.kind].filter(e=>d.events.has(e));
     if(d.gone){await client.deleteRule(d.ruleId);next[i]=null}
     else if(d.ruleId){if(evs.join()!==d.first){await client.updateRule(d.ruleId,{events:evs});next[i]={...d,first:evs.join()}}}
     else{const r=await client.createRule({nodeId:n.id,sourceKind:d.source.kind,sourceId:d.source.id||null,events:evs});next[i]={...d,ruleId:r.id,first:evs.join()}}
    }
   }catch(e){setDrafts(next.filter(Boolean));throw e}
   await onSaved(n,!edit&&!made);
  },e=>setError(friendly(e)));
  setBusy(false);
 }
 // The saved node is tested through its own route (audited on the node); anything unsaved through the chosen Connection.
 const test=()=>live&&!dirty?client.testNode(live.id):connClient.test(connectionId);
 const status=connection?testState(connection,item):null;
 const items=providers.map(p=>({value:p.id,label:p.label,icon:p.icon,group:GROUPS[p.group]||p.group}));
 const connItems=mine.map(c=>({value:c.id,label:c.name,icon:item?.icon,caption:(c.usedBy||[]).length?'Used by '+c.usedBy.map(u=>u.name).join(', '):'Not used yet'}));
 return <SidePanel narrow={narrow} labelId="map-panel-title" title={edit?node.name:'New alert node'} onClose={onClose} icon={<NodeIcon provider={item} size={24}/>} footer={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy||guard.waiting||!ready} onClick={save}>Save</button></>} sub={<>
  <TestBox onTest={test} disabled={!connectionId} dirty={!!live&&dirty&&!!connectionId}/>
  <div className="map-tabs" role="tablist" aria-label="Alert settings">{[['settings','Settings'],['sends','Sends when']].map(([id,l])=><button key={id} type="button" role="tab" id={'map-tab-'+id} aria-selected={tab===id} aria-controls={'map-tabpanel-'+id} tabIndex={tab===id?0:-1} className={tab===id?'on':''} onClick={()=>setTab(id)} onKeyDown={e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();const n=tab==='settings'?'sends':'settings';setTab(n);setTimeout(()=>document.getElementById('map-tab-'+n)?.focus(),0)}}}>{l}</button>)}</div></>}>
  {tab==='settings'&&<section id="map-tabpanel-settings" role="tabpanel" aria-labelledby="map-tab-settings" className="map-cfg">
   <label className="map-field">Name<input type="text" autoComplete="off" maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label>
   <div className="map-field" role="group" aria-labelledby="map-l-provider"><span id="map-l-provider">Provider</span><Combo labelledBy="map-l-provider" items={items} value={providerId} onChange={chooseProvider} search searchLabel="Search providers" placeholder="Choose a provider"/></div>
   {item&&<div className="map-field" role="group" aria-labelledby="map-l-connection"><span id="map-l-connection">Connection</span>
    <div className="cx-row"><Combo labelledBy="map-l-connection" items={connItems} value={connectionId} onChange={setConnectionId} placeholder={mine.length?'Choose a connection':'No '+item.label+' connection yet'} action={{label:'New connection',onSelect:()=>setDialog({kind:'new'})}}/>
     {connection&&<IconButton label={(connection.editable===false?'View ':'Edit ')+connection.name} icon={IconPencil} onClick={()=>setDialog({kind:'edit',connection})}/>}</div>
    {connection?<span className="map-caption">{status?.text}{connection.sendError?'. Last message: '+connection.sendError:''}</span>:<Note kind="warn" icon={IconAlertTriangle}>{edit&&node.needsConnection&&node.provider===providerId?'Needs a connection. Choose one, or create a new one.':'Choose a connection, or create a new one.'}</Note>}
   </div>}
  </section>}
  {tab==='sends'&&<section id="map-tabpanel-sends" role="tabpanel" aria-labelledby="map-tab-sends" className="map-sends">
   {visible.length===0&&<p className="map-caption">Nothing is connected yet. Drag from a server, site or DockNest to this node, or connect one below.</p>}
   {visible.map(d=><fieldset key={d.key} className="map-src" data-src={d.key}><legend>{d.source.name}<span className="map-caption"> {d.source.kind==='docknest'?'DockNest':d.source.kind==='server'?'Server':'Site'}</span></legend>
    {EVENTS_FOR[d.source.kind].map(e=><label key={e} className="map-check"><input type="checkbox" checked={d.events.has(e)} onChange={()=>toggle(d.key,e)}/>{EVENT_LABEL[e]}</label>)}
    {d.events.size===0&&<p className="map-caption" role="status">Choose at least one.</p>}
    <button type="button" aria-label={`Disconnect ${d.source.name}`} onClick={()=>disconnect(d.key)}>Disconnect</button>
   </fieldset>)}
   {free.length>0&&<div className="map-connect"><label className="map-field">Connect another source<select value={pick} onChange={e=>setPick(e.target.value)}><option value="">Choose…</option>{free.map(s=><option key={srcKey(s)} value={srcKey(s)}>{s.name}</option>)}</select></label><button type="button" disabled={!pick} onClick={addSource}>Connect</button></div>}
  </section>}
  {error&&<Note kind="error" icon={IconCircleX} role="alert">{error}</Note>}
  {guard.prompt}
  {dialog&&<ConnectionDialog key={dialog.connection?.id||'new-'+providerId} client={connClient} providers={providers} connection={dialog.connection} initialProvider={providerId} prefill={edit&&node.provider===providerId?node.prefill:null} role={role} onClose={()=>setDialog(null)} onSaved={async view=>{setDialog(null);await onReload();setConnectionId(view.id)}}/>}
 </SidePanel>;
}

// Deleting a node with sources asks first, naming what stops; one without sources goes at once (the page offers Undo).
export function DeleteNodeSheet({node,count,client,onClose,onDeleted}){
 const guard=useGuard(client),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function go(){setBusy(true);setError('');await guard.run(async()=>{await client.deleteNode(node.id);await onDeleted()},e=>setError(friendly(e)));setBusy(false)}
 return <Sheet title={`Delete ${node.name}?`} labelId="map-delete-title" onClose={onClose} actions={<div className="map-panel-foot"><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy||guard.waiting} onClick={go}>Delete</button></div>}>
  <p>It stops alerts from {count===1?'1 source':count+' sources'}. Its connection stays in Connections.</p>
  {error&&<Note kind="error" icon={IconCircleX} role="alert">{error}</Note>}
  {guard.prompt}
 </Sheet>;
}

// In a server, site or DockNest panel: the alerts that start here and a way to add one.
export function SourceAlerts({source,rules,nodes,onEdit,onAdd}){
 const mine=rules.filter(r=>sameSource(r,source)),name=id=>nodes.find(n=>n.id===id)?.name||'an alert node';
 return <section aria-labelledby={'map-alerts-'+source.kind}>
  <h3 id={'map-alerts-'+source.kind} className="map-group-title">Alerts</h3>
  {mine.length>0?<ul className="map-alert-rows">{mine.map(r=><li key={r.id}><span><b className="map-name">To {name(nodeOf(r))}</b><span className="map-caption">{words(r.events)}</span></span><button type="button" className="icon-button" title="Open" aria-label={`Open alerts to ${name(nodeOf(r))}`} onClick={e=>onEdit(r,e.currentTarget)}><IconChevronRight size={16} stroke={1.75} aria-hidden="true"/></button></li>)}</ul>:<p className="map-caption map-alerts-none">No alerts yet.</p>}
  <button type="button" className="map-alerts-add" onClick={e=>onAdd(source,e.currentTarget)}><IconBell size={16} stroke={1.75} aria-hidden="true"/>Add alert</button>
 </section>;
}

// Phone: one block per node (name, provider, delete), one row per connected source with its events, then the actions.
export function AlertsList({nodes,rules,providers,sourceName,onOpen,onEditRule,onDelete,onAdd,onDocknest}){
 return <section className="map-list-group" aria-labelledby="map-list-alerts">
  <div className="map-list-head"><IconBell size={20} stroke={1.75} aria-hidden="true"/><div><h2 id="map-list-alerts">Alerts</h2><span className="map-caption">Messages when something needs you</span></div></div>
  {nodes.length>0?<ul className="cx-nodes">{nodes.map(n=>{const mine=rules.filter(r=>nodeOf(r)===n.id),p=providerOf(providers,n.provider),warn=n.needsConnection||n.lastSend==='failed';return <li key={n.id} className="cx-node">
   <div className="cx-node-head"><button type="button" className="cx-node-open" aria-label={`Open ${n.name}`} onClick={e=>onOpen(n,e.currentTarget)}><NodeIcon provider={p} size={24}/><span className="cx-node-text"><b className="map-name">{n.name}</b><span className={'map-caption'+(warn?' warn':'')}>{n.needsConnection?'Needs a connection':n.lastSend==='failed'?'The last message failed':p?.label||n.provider}</span></span><IconChevronRight size={18} stroke={1.75} aria-hidden="true"/></button>
    <IconButton label={'Delete '+n.name} icon={IconTrash} onClick={e=>onDelete(n,e.currentTarget)}/></div>
   {mine.length>0?<ul className="cx-srcs">{mine.map(r=><li key={r.id}><button type="button" className="cx-src" aria-label={`Events from ${sourceName(r)} to ${n.name}`} onClick={e=>onEditRule(r,e.currentTarget)}><span className="cx-node-text"><span className="map-name">{sourceName(r)}</span><span className="map-caption cx-trunc">{words(r.events)||'No events'}</span></span><IconChevronRight size={18} stroke={1.75} aria-hidden="true"/></button></li>)}</ul>:<p className="map-caption cx-none">No sources yet.</p>}
  </li>})}</ul>:<p className="map-caption map-none">No alert nodes yet.</p>}
  <div className="map-list-actions map-list-add cx-stack"><button type="button" onClick={e=>onAdd(e.currentTarget)}>Add alert node</button><button type="button" onClick={e=>onDocknest(e.currentTarget)}>Alerts from DockNest</button></div>
 </section>;
}
