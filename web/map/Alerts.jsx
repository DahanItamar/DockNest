import React,{useState} from 'react';
import {IconBrandTelegram,IconMail,IconDownload,IconCircleX,IconCircleCheck,IconInfoCircle} from '@tabler/icons-react';
import {Sheet,Note,useGuard} from './MoveFlow.jsx';
import {friendly} from './moves-client.js';
import {EVENT_LABEL,EVENTS_FOR,DEFAULT_EVENTS,KIND_LABEL,words,sameSource} from './alerts-client.js';

export const KindIcon=({kind,size=32,stroke=1.5})=>{const I=kind==='email'?IconMail:IconBrandTelegram;return <I size={size} stroke={stroke} aria-hidden="true"/>};
export const DockNestIcon=({size=32,stroke=1.5})=><IconDownload size={size} stroke={stroke} aria-hidden="true"/>;

// "Alerts from <source> to <channel>": which events a line carries. Checkboxes only offer events the source can have.
export function RuleSheet({source,channel,rule,client,onClose,onSaved}){
 const allowed=EVENTS_FOR[source.kind]||[],start=rule?rule.events.filter(e=>allowed.includes(e)):DEFAULT_EVENTS[source.kind]||[];
 const [picked,setPicked]=useState(()=>new Set(start)),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const list=allowed.filter(e=>picked.has(e));
 const toggle=e=>setPicked(p=>{const n=new Set(p);n.has(e)?n.delete(e):n.add(e);return n});
 async function save(){
  setBusy(true);setError('');
  try{
   if(rule)await client.updateRule(rule.id,{events:list});
   else await client.createRule({channelId:channel.id,sourceKind:source.kind,sourceId:source.id||null,events:list});
   await onSaved(rule?'Alerts changed.':'Alerts will go to '+channel.name+'.');
  }catch(e){setError(e.message||'Something went wrong.');setBusy(false)}
 }
 async function remove(){
  setBusy(true);setError('');
  try{await client.deleteRule(rule.id);await onSaved('Alerts removed.')}catch(e){setError(e.message||'Something went wrong.');setBusy(false)}
 }
 return <Sheet title={`Alerts from ${source.name} to ${channel.name}`} labelId="map-rule-title" onClose={onClose} actions={<>
  {rule&&<button type="button" className="map-foot-left" disabled={busy} onClick={remove}>Remove alerts</button>}
  <button type="button" onClick={onClose}>Cancel</button>
  <button type="button" className="primary" disabled={busy||!list.length} onClick={save}>Save</button></>}>
  <fieldset className="map-events"><legend>Tell me when</legend>
   {allowed.map(e=><label key={e} className="map-check"><input type="checkbox" checked={picked.has(e)} onChange={()=>toggle(e)}/>{EVENT_LABEL[e]}</label>)}
  </fieldset>
  {!list.length&&<p className="map-caption" role="status">Choose at least one.</p>}
  {error&&<Note kind="error" icon={IconCircleX} role="alert">{error}</Note>}
 </Sheet>;
}

// Phone, keyboard and "+" path: choose the channel for a source, then the same rule sheet opens.
export function PickSheet({source,channels,rules,onPick,onAdd,onClose}){
 return <Sheet title={`Send alerts from ${source.name} to`} labelId="map-pick-title" onClose={onClose} actions={<button type="button" onClick={onClose}>Cancel</button>}>
  {channels.length>0?<ul className="map-targets">{channels.map(c=>{const has=rules.some(r=>r.channelId===c.id&&sameSource(r,source));
   return <li key={c.id}><button type="button" onClick={()=>onPick(c)}><b>{c.name}</b><span className="map-caption">{KIND_LABEL[c.kind]}{has?'. Already connected, you can change it.':''}</span></button></li>})}</ul>
  :<p>You have no alert channels yet. Add one, then connect it.</p>}
  <div className="map-inline-actions"><button type="button" onClick={()=>onAdd('telegram')}>Add Telegram alerts</button><button type="button" onClick={()=>onAdd('email')}>Add Email alerts</button></div>
 </Sheet>;
}

// A secret is never shown again: "Saved" and a way to replace it.
function Secret({label,saved,value,onChange,replacing,onReplace,autoComplete='off'}){
 if(saved&&!replacing)return <div className="map-field" role="group" aria-label={label}><span>{label}</span><div className="map-saved"><span>Saved</span><button type="button" onClick={onReplace}>Replace</button></div></div>;
 return <label className="map-field">{label}<input type="password" autoComplete={autoComplete} value={value} onChange={e=>onChange(e.target.value)}/></label>;
}
const Field=({label,value,onChange,type='text',inputMode,autoComplete='off',hint})=><label className="map-field">{label}<input type={type} inputMode={inputMode} autoComplete={autoComplete} value={value} onChange={e=>onChange(e.target.value)}/>{hint&&<span className="map-caption">{hint}</span>}</label>;

export function TestBox({client,channel,onDone}){
 const [state,setState]=useState({busy:false,text:'',ok:false});
 async function run(){
  setState({busy:true,text:'',ok:false});
  try{await client.test(channel.id);setState({busy:false,ok:true,text:'Test message sent. Check '+(channel.kind==='email'?'your inbox.':'your chat.')})}
  catch(e){setState({busy:false,ok:false,text:e.message||'The test message could not be sent.'})}
  onDone?.();
 }
 return <div className="map-test"><button type="button" disabled={state.busy} onClick={run}>{state.busy?'Sending…':'Send test message'}</button>
  <div role="status" aria-live="polite">{state.text&&<Note kind={state.ok?'ok':'error'} icon={state.ok?IconCircleCheck:IconCircleX}>{state.text}</Note>}</div></div>;
}

// Add or change a channel. Saving needs the recent re-verification, shown inside the sheet like in the move flow.
export function ChannelSheet({kind,channel,client,onClose,onSaved}){
 const edit=!!channel,c=channel?.config||{},guard=useGuard(client);
 const [name,setName]=useState(channel?.name||KIND_LABEL[kind]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [token,setToken]=useState(''),[chatId,setChatId]=useState(c.chatId||''),[repToken,setRepToken]=useState(false);
 const [host,setHost]=useState(c.host||''),[port,setPort]=useState(String(c.port||587)),[security,setSecurity]=useState(c.security||'starttls'),[username,setUsername]=useState(c.username||''),[password,setPassword]=useState(''),[repPass,setRepPass]=useState(false),[from,setFrom]=useState(c.from||''),[to,setTo]=useState((c.to||[]).join(', '));
 const tokenSaved=edit&&!!c.tokenSet,passSaved=edit&&!!c.passwordSet&&!!username;
 function body(){
  if(kind==='telegram')return {name,config:{chatId,...(token?{token}:{})}};
  const recipients=to.split(/[,\s;]+/).filter(Boolean);
  return {name,config:{host,port:Number(port),security,username,from,to:recipients,...(password?{password}:{})}};
 }
 const ready=name.trim()&&(kind==='telegram'?chatId.trim()&&(token||tokenSaved):host.trim()&&Number(port)>0&&from.trim()&&to.trim()&&(!username||password||passSaved));
 async function save(){
  setBusy(true);setError('');
  const b=body();
  await guard.run(async()=>{
   const saved=edit?await client.updateChannel(channel.id,b):await client.createChannel({kind,...b});
   await onSaved(saved,!edit);
  },e=>setError(friendly(e)));
  setBusy(false);
 }
 function changeEncryption(v){setSecurity(v);if(v==='tls'&&['587','25'].includes(port))setPort('465');if(v==='starttls'&&port==='465')setPort('587')}
 return <Sheet title={edit?`Edit ${channel.name}`:kind==='email'?'Add Email alerts':'Add Telegram alerts'} labelId="map-channel-title" onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy||guard.waiting||!ready} onClick={save}>Save</button></>}>
  {edit&&channel.configReadable===false&&<Note kind="warn" icon={IconInfoCircle}>DockNest cannot read the saved settings of this channel. Enter them again to fix it.</Note>}
  <Field label="Name" value={name} onChange={setName}/>
  {kind==='telegram'?<>
   <Secret label="Bot token" saved={tokenSaved} replacing={repToken} onReplace={()=>setRepToken(true)} value={token} onChange={setToken}/>
   <Field label="Chat ID" value={chatId} onChange={setChatId} inputMode="text" hint="A number, or the @name of a public channel."/>
   {!edit&&<p className="map-caption">Create a bot with BotFather in Telegram, copy its token, then send the bot a message. DockNest only talks to api.telegram.org.</p>}
  </>:<>
   <Field label="SMTP server" value={host} onChange={setHost} hint="For example smtp.example.com."/>
   <label className="map-field">Port<input inputMode="numeric" autoComplete="off" value={port} onChange={e=>setPort(e.target.value.replace(/\D/g,''))}/></label>
   <label className="map-field">Encryption<select value={security} onChange={e=>changeEncryption(e.target.value)}><option value="starttls">STARTTLS (usually port 587)</option><option value="tls">TLS (usually port 465)</option></select><span className="map-caption">Email is always encrypted.</span></label>
   <Field label="User name" value={username} onChange={setUsername} autoComplete="off"/>
   <Secret label="Password" saved={passSaved} replacing={repPass} onReplace={()=>setRepPass(true)} value={password} onChange={setPassword} autoComplete="new-password"/>
   <Field label="From" value={from} onChange={setFrom} type="email" autoComplete="off"/>
   <Field label="Send to" value={to} onChange={setTo} hint="Up to 5 addresses, separated by commas."/>
  </>}
  {edit&&<div className="map-test-box"><TestBox client={client} channel={channel}/><p className="map-caption">Sends with the settings that are saved.</p></div>}
  {error&&<Note kind="error" icon={IconCircleX} role="alert">{error}</Note>}
  {guard.prompt}
 </Sheet>;
}

export function DeleteChannelSheet({channel,client,onClose,onDeleted}){
 const guard=useGuard(client),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function go(){setBusy(true);setError('');await guard.run(async()=>{await client.deleteChannel(channel.id);await onDeleted()},e=>setError(friendly(e)));setBusy(false)}
 return <Sheet title={`Delete ${channel.name}?`} labelId="map-delete-title" onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy||guard.waiting} onClick={go}>Delete</button></>}>
  <p>DockNest stops sending alerts to <b>{channel.name}</b> and removes its lines. Nothing else changes.</p>
  {error&&<Note kind="error" icon={IconCircleX} role="alert">{error}</Note>}
  {guard.prompt}
 </Sheet>;
}

// One sentence per line: "Frankfurt-1: Backup failed, Server unreachable"
export const ruleSentence=(rule,sourceName)=>`${sourceName}: ${words(rule.events)||'No events'}`;

// In a server, site or DockNest panel: the lines that start here and a way to add one.
export function SourceAlerts({source,rules,channels,onEdit,onAdd}){
 const mine=rules.filter(r=>sameSource(r,source)),name=id=>channels.find(c=>c.id===id)?.name||'a channel';
 return <section aria-labelledby={'map-alerts-'+source.kind}>
  <h3 id={'map-alerts-'+source.kind} className="map-group-title">Alerts</h3>
  {mine.length>0?<ul className="map-alert-rows">{mine.map(r=><li key={r.id}><span><b className="map-name">To {name(r.channelId)}</b><span className="map-caption">{words(r.events)}</span></span><button type="button" aria-label={`Edit alerts to ${name(r.channelId)}`} onClick={e=>onEdit(r,e.currentTarget)}>Edit</button></li>)}</ul>:<p className="map-caption">No alerts from here yet.</p>}
  <button type="button" onClick={e=>onAdd(source,e.currentTarget)}>Send alerts to{'…'}</button>
 </section>;
}

// Details of an alert node
export function ChannelDetails({channel,rules,sourceName,when,client,onEditRule,onReload}){
 const c=channel.config||{},mine=rules.filter(r=>r.channelId===channel.id);
 const last=channel.lastResult==='ok'?'Sent '+when(channel.lastResultAt):channel.lastResult==='failed'?'Could not send '+when(channel.lastResultAt)+(channel.lastError?'. '+channel.lastError:''):'Nothing sent yet';
 return <>
  {channel.configReadable===false&&<Note kind="warn" icon={IconInfoCircle}>DockNest cannot read the saved settings of this channel. Choose Edit to enter them again.</Note>}
  <dl className="map-defs">
   <div><dt>Kind</dt><dd>{KIND_LABEL[channel.kind]}</dd></div>
   <div><dt>Name</dt><dd>{channel.name}</dd></div>
   {channel.kind==='telegram'?<div><dt>Chat ID</dt><dd>{c.chatId||'Not set'}</dd></div>:<><div><dt>Server</dt><dd>{c.host?`${c.host}:${c.port}`:'Not set'}</dd></div><div><dt>Send to</dt><dd>{(c.to||[]).join(', ')||'Not set'}</dd></div></>}
   <div><dt>Secrets</dt><dd>Saved, never shown again</dd></div>
   <div><dt>Last result</dt><dd>{last}</dd></div>
  </dl>
  <TestBox client={client} channel={channel} onDone={onReload}/>
  <section aria-labelledby="map-channel-lines"><h3 id="map-channel-lines" className="map-group-title">Lines</h3>
   {mine.length?<ul className="map-alert-rows">{mine.map(r=>{const s=sourceName(r);return <li key={r.id}><span><b className="map-name">{s}</b><span className="map-caption">{words(r.events)}</span></span><button type="button" aria-label={`Edit alerts from ${s}`} onClick={e=>onEditRule(r,e.currentTarget)}>Edit</button></li>})}</ul>:<p className="map-caption">Nothing is connected to this channel yet. Drag from a site, a server or DockNest to it.</p>}
  </section>
 </>;
}

// Phone: channels and their lines in plain sentences
export function AlertsList({channels,rules,sourceName,onDetails,onEditRule,onAdd,onDocknest}){
 return <section className="map-list-group" aria-labelledby="map-list-alerts">
  <div className="map-list-head"><IconBrandTelegram size={20} stroke={1.75} aria-hidden="true"/><div><h2 id="map-list-alerts">Alerts</h2><span className="map-caption">Messages when something needs you</span></div></div>
  {channels.length>0?<ul>{channels.map(c=>{const mine=rules.filter(r=>r.channelId===c.id);return <li key={c.id}><KindIcon kind={c.kind} size={18} stroke={1.75}/><div className="map-list-text"><span className="map-name">{c.name}</span><span className="map-caption">{KIND_LABEL[c.kind]}</span>
   {mine.length>0?<ul className="map-list-sentences">{mine.map(r=><li key={r.id}><span className="map-caption">{ruleSentence(r,sourceName(r))}</span><button type="button" aria-label={`Edit alerts from ${sourceName(r)} to ${c.name}`} onClick={e=>onEditRule(r,e.currentTarget)}>Edit</button></li>)}</ul>:<span className="map-caption">No lines yet.</span>}</div>
   <div className="map-list-actions"><button type="button" onClick={e=>onDetails(c,e.currentTarget)}>Details</button></div></li>})}</ul>:<p className="map-caption map-none">No alert channels yet.</p>}
  <div className="map-list-actions map-list-add"><button type="button" onClick={e=>onAdd('telegram',e.currentTarget)}>Add Telegram alerts</button><button type="button" onClick={e=>onAdd('email',e.currentTarget)}>Add Email alerts</button><button type="button" onClick={e=>onDocknest(e.currentTarget)}>Alerts from DockNest</button></div>
 </section>;
}
