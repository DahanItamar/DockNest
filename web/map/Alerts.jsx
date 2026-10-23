import React,{useEffect,useMemo,useState} from 'react';
import {IconBrandTelegram,IconMail,IconDownload,IconCircleX,IconCircleCheck,IconInfoCircle,IconAlertTriangle} from '@tabler/icons-react';
import {Sheet,Note,useGuard} from './MoveFlow.jsx';
import {SidePanel} from './Panels.jsx';
import {friendly} from './moves-client.js';
import {EVENT_LABEL,EVENTS_FOR,DEFAULT_EVENTS,KIND_LABEL,words,sameSource} from './alerts-client.js';

export const KindIcon=({kind,size=32,stroke=1.5})=>{const I=kind==='email'?IconMail:IconBrandTelegram;return <I size={size} stroke={stroke} aria-hidden="true"/>};
export const DockNestIcon=({size=32,stroke=1.5})=><IconDownload size={size} stroke={stroke} aria-hidden="true"/>;
export const srcKey=s=>s.kind+':'+(s.id||'');

// Phone, keyboard and "Send alerts to…": choose the channel for a source; its panel opens with that source added.
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

export function TestBox({client,channel,onDone,dirty}){
 const [state,setState]=useState({busy:false,text:'',ok:false});
 async function run(){
  setState({busy:true,text:'',ok:false});
  try{await client.test(channel.id);setState({busy:false,ok:true,text:'Test message sent. Check '+(channel.kind==='email'?'your inbox.':'your chat.')})}
  catch(e){setState({busy:false,ok:false,text:e.message||'The test message could not be sent.'})}
  onDone?.();
 }
 return <div className="map-test"><button type="button" className="primary" disabled={state.busy||!channel} onClick={run}>{state.busy?'Sending…':'Send test message'}</button>{dirty&&<span className="map-caption">Sends with the settings that are saved.</span>}
  <div role="status" aria-live="polite">{state.text&&<p className={'map-result '+(state.ok?'ok':'bad')}>{state.ok?<IconCircleCheck size={16} stroke={2} aria-hidden="true"/>:<IconCircleX size={16} stroke={2} aria-hidden="true"/>}<span>{state.text}</span></p>}</div></div>;
}

const draftOf=(source,rule)=>({key:srcKey(source),source,ruleId:rule?.id||null,events:new Set(rule?rule.events:DEFAULT_EVENTS[source.kind]||[]),first:rule?[...rule.events].join():null,gone:false});

// The one place to set an alert node up: the channel's own settings, then "Sends when" with one block per connected source.
// Save applies every change at once (channel, then lines); Cancel discards them all.
export function AlertPanel({narrow,kind,channel,rules,credentials,sourceList,sourceName,preselect,scrollTo,client,when,onClose,onSaved,onDelete,onReload}){
 const edit=!!channel,c=channel?.config||{},guard=useGuard(client),list=credentials.filter(x=>x.kind===kind);
 const [name,setName]=useState(channel?.name||KIND_LABEL[kind]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[made,setMade]=useState(null),[tab,setTab]=useState(scrollTo?'sends':'settings');
 const [credentialId,setCredentialId]=useState(channel?.credentialId||''),[chatId,setChatId]=useState(c.chatId||''),[to,setTo]=useState((c.to||[]).join(', ')),[newCred,setNewCred]=useState(false);
 const [drafts,setDrafts]=useState(()=>{
  const mine=channel?rules.filter(r=>r.channelId===channel.id).map(r=>draftOf({kind:r.sourceKind,id:r.sourceId||null,name:sourceName(r)},r)):[];
  if(preselect&&!mine.some(d=>d.key===srcKey(preselect)))mine.push(draftOf(preselect,null));
  return mine;
 });
 const [pick,setPick]=useState(''),live=made||channel;
 useEffect(()=>{if(scrollTo)document.querySelector(`[data-src="${scrollTo}"]`)?.scrollIntoView({block:'nearest'})},[scrollTo,tab]);
 const visible=drafts.filter(d=>!d.gone),free=useMemo(()=>sourceList.filter(s=>!visible.some(d=>d.key===srcKey(s))),[sourceList,drafts]);
 const setEvents=(key,fn)=>setDrafts(l=>l.map(d=>d.key===key?{...d,events:fn(new Set(d.events))}:d));
 const toggle=(key,e)=>setEvents(key,s=>{s.has(e)?s.delete(e):s.add(e);return s});
 const disconnect=key=>setDrafts(l=>l.flatMap(d=>d.key!==key?[d]:d.ruleId?[{...d,gone:true}]:[]));
 const addSource=()=>{const s=sourceList.find(x=>srcKey(x)===pick);if(!s)return;setDrafts(l=>[...l.filter(d=>d.key!==pick),draftOf(s,null)]);setPick('');setTimeout(()=>document.querySelector(`[data-src="${srcKey(s)}"]`)?.scrollIntoView({block:'nearest'}),0)};
 const recipients=to.split(/[,\s;]+/).filter(Boolean);
 const body=()=>({name,credentialId:credentialId||null,config:kind==='telegram'?{chatId}:{to:recipients}});
 const dirty=!live||name!==live.name||credentialId!==(live.credentialId||'')||(kind==='telegram'?chatId!==(live.config?.chatId||''):recipients.join()!==(live.config?.to||[]).join());
 const ready=name.trim()&&(kind==='telegram'?chatId.trim():recipients.length>0&&recipients.length<=5)&&visible.every(d=>d.events.size>0);
 async function save(){
  setBusy(true);setError('');
  await guard.run(async()=>{
   let ch=live;
   if(!ch){ch=await client.createChannel({kind,...body()});setMade(ch)}
   else if(dirty)ch=await client.updateChannel(ch.id,body());
   const next=[...drafts];
   try{
    for(let i=0;i<drafts.length;i++){
     const d=drafts[i],evs=EVENTS_FOR[d.source.kind].filter(e=>d.events.has(e));
     if(d.gone){await client.deleteRule(d.ruleId);next[i]=null}
     else if(d.ruleId){if(evs.join()!==d.first){await client.updateRule(d.ruleId,{events:evs});next[i]={...d,first:evs.join()}}}
     else{const r=await client.createRule({channelId:ch.id,sourceKind:d.source.kind,sourceId:d.source.id||null,events:evs});next[i]={...d,ruleId:r.id,first:evs.join()}}
    }
   }catch(e){setDrafts(next.filter(Boolean));throw e}
   await onSaved(ch,!edit&&!made);
  },e=>setError(friendly(e)));
  setBusy(false);
 }
 const cred=list.find(x=>x.id===credentialId);
 const title=edit?channel.name:kind==='email'?'Add Email alerts':'Add Telegram alerts';
 const last=live?.lastResult==='ok'?'Sent '+when(live.lastResultAt):live?.lastResult==='failed'?'Could not send '+when(live.lastResultAt)+(live.lastError?'. '+live.lastError:''):'Nothing sent yet';
 return <SidePanel narrow={narrow} labelId="map-panel-title" title={title} onClose={onClose} icon={<KindIcon kind={kind} size={24}/>} footer={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy||guard.waiting||!ready} onClick={save}>Save</button></>} sub={<>
  <TestBox client={client} channel={live&&credentialId?live:null} onDone={onReload} dirty={live&&dirty}/>
  <div className="map-tabs" role="tablist" aria-label="Alert settings">{[['settings','Settings'],['sends','Sends when']].map(([id,label])=><button key={id} type="button" role="tab" id={'map-tab-'+id} aria-selected={tab===id} aria-controls={'map-tabpanel-'+id} tabIndex={tab===id?0:-1} className={tab===id?'on':''} onClick={()=>setTab(id)} onKeyDown={e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();const n=tab==='settings'?'sends':'settings';setTab(n);setTimeout(()=>document.getElementById('map-tab-'+n)?.focus(),0)}}}>{label}</button>)}</div></>}>
  {tab==='settings'&&<section id="map-tabpanel-settings" role="tabpanel" aria-labelledby="map-tab-settings" className="map-cfg">
   <Field label="Name" value={name} onChange={setName}/>
   {edit&&channel.configReadable===false&&<Note kind="warn" icon={IconInfoCircle}>DockNest cannot read the saved settings of this channel. Enter them again to fix it.</Note>}
   {!credentialId&&<Note kind="warn" icon={IconAlertTriangle}>Needs a credential. Choose one below, or create a new one.</Note>}
   <label className="map-field">Credential<select value={credentialId} onChange={e=>{if(e.target.value==='__new')setNewCred(true);else setCredentialId(e.target.value)}}><option value="">Choose…</option>{list.map(x=><option key={x.id} value={x.id}>{x.name} ({KIND_LABEL[x.kind]})</option>)}<option value="__new">Create new credential</option></select>{cred&&<span className="map-caption">{kind==='telegram'?'Bot token: Saved':`${cred.config?.host||'Mail server'}${cred.config?.passwordSet?', password: Saved':''}`}</span>}</label>
   {kind==='telegram'?<Field label="Chat ID" value={chatId} onChange={setChatId} hint="A number, or the @name of a public channel."/>
    :<Field label="Recipients" value={to} onChange={setTo} hint="Up to 5 addresses, separated by commas."/>}
   {live&&<dl className="map-defs"><div><dt>Last result</dt><dd>{last}</dd></div></dl>}
   {edit&&<button type="button" className="map-delete" onClick={onDelete}>Delete this node</button>}
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
  {newCred&&<CredentialSheet kind={kind} client={client} onClose={()=>setNewCred(false)} onSaved={async saved=>{await onReload();setCredentialId(saved.id);setNewCred(false)}}/>}
 </SidePanel>;
}

// A credential (the secret part of a node): reusable by several nodes. Secrets are never shown again.
export function CredentialSheet({kind,credential,client,onClose,onSaved}){
 const edit=!!credential,c=credential?.config||{},guard=useGuard(client),[name,setName]=useState(credential?.name||(kind==='email'?'Mail account':'Telegram bot')),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [token,setToken]=useState(''),[repToken,setRepToken]=useState(false),[host,setHost]=useState(c.host||''),[port,setPort]=useState(String(c.port||587)),[security,setSecurity]=useState(c.security||'starttls'),[username,setUsername]=useState(c.username||''),[password,setPassword]=useState(''),[repPass,setRepPass]=useState(false),[from,setFrom]=useState(c.from||'');
 const tokenSaved=edit&&!!c.tokenSet,passSaved=edit&&!!c.passwordSet&&!!username;
 const config=()=>kind==='telegram'?(token?{token}:{}):{host,port:Number(port),security,username,from,...(password?{password}:{})};
 const ready=name.trim()&&(kind==='telegram'?token||tokenSaved:host.trim()&&Number(port)>0&&from.trim()&&(!username||password||passSaved));
 async function save(){
  setBusy(true);setError('');
  await guard.run(async()=>{const saved=edit?await client.updateCredential(credential.id,{name,config:config()}):await client.createCredential({kind,name,config:config()});await onSaved(saved)},e=>setError(friendly(e)));
  setBusy(false);
 }
 function changeEncryption(v){setSecurity(v);if(v==='tls'&&['587','25'].includes(port))setPort('465');if(v==='starttls'&&port==='465')setPort('587')}
 return <Sheet title={edit?`Edit ${credential.name}`:kind==='email'?'New Email credential':'New Telegram credential'} labelId="map-credential-title" onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy||guard.waiting||!ready} onClick={save}>Save</button></>}>
  <Field label="Name" value={name} onChange={setName}/>
  {kind==='telegram'?<>
   <Secret label="Bot token" saved={tokenSaved} replacing={repToken} onReplace={()=>setRepToken(true)} value={token} onChange={setToken}/>
   {!edit&&<p className="map-caption">Create a bot with BotFather in Telegram and copy its token. DockNest only talks to api.telegram.org.</p>}
  </>:<>
   <Field label="SMTP server" value={host} onChange={setHost} hint="For example smtp.example.com."/>
   <label className="map-field">Port<input inputMode="numeric" autoComplete="off" value={port} onChange={e=>setPort(e.target.value.replace(/\D/g,''))}/></label>
   <label className="map-field">Encryption<select value={security} onChange={e=>changeEncryption(e.target.value)}><option value="starttls">STARTTLS (usually port 587)</option><option value="tls">TLS (usually port 465)</option></select><span className="map-caption">Email is always encrypted.</span></label>
   <Field label="User name" value={username} onChange={setUsername}/>
   <Secret label="Password" saved={passSaved} replacing={repPass} onReplace={()=>setRepPass(true)} value={password} onChange={setPassword} autoComplete="new-password"/>
   <Field label="From" value={from} onChange={setFrom} type="email"/>
  </>}
  {edit&&<CredentialTest client={client} credential={credential}/>}
  {error&&<Note kind="error" icon={IconCircleX} role="alert">{error}</Note>}
  {guard.prompt}
 </Sheet>;
}
function CredentialTest({client,credential}){
 const [s,setS]=useState({busy:false,text:'',ok:false});
 async function run(){setS({busy:true,text:'',ok:false});try{await client.testCredential(credential.id);setS({busy:false,ok:true,text:'The login works.'})}catch(e){setS({busy:false,ok:false,text:e.message||'The login did not work.'})}}
 return <div className="map-test"><button type="button" disabled={s.busy} onClick={run}>{s.busy?'Testing…':'Test'}</button><p className="map-caption">Checks the saved login.</p><div role="status" aria-live="polite">{s.text&&<Note kind={s.ok?'ok':'error'} icon={s.ok?IconCircleCheck:IconCircleX}>{s.text}</Note>}</div></div>;
}

// "Credentials" from the "+" panel: list, edit, delete (refused by the API while a node uses it)
export function CredentialsPanel({narrow,credentials,channels,client,onClose,onReload}){
 const [sheet,setSheet]=useState(null),[note,setNote]=useState(null),[confirm,setConfirm]=useState(null),[err,setErr]=useState('');
 const uses=id=>channels.filter(c=>c.credentialId===id).length;
 async function del(cred){setErr('');try{await client.deleteCredential(cred.id);await onReload();setConfirm(null);setNote(cred.name+' is deleted.')}catch(e){setErr(e.message||'This credential could not be deleted.')}}
 return <SidePanel narrow={narrow} labelId="map-panel-title" title="Credentials" onClose={onClose} footer={<button type="button" className="primary" onClick={onClose}>Close</button>}>
  <p className="map-caption">A credential holds a login. Several alert nodes can use the same one.</p>
  {credentials.length>0?<ul className="map-alert-rows">{credentials.map(x=><li key={x.id}><span><b className="map-name">{x.name}</b><span className="map-caption">{KIND_LABEL[x.kind]}, used by {uses(x.id)===1?'1 node':uses(x.id)+' nodes'}</span></span><button type="button" aria-label={`Edit ${x.name}`} onClick={()=>setSheet({kind:x.kind,credential:x})}>Edit</button><button type="button" aria-label={`Delete ${x.name}`} onClick={()=>{setErr('');setConfirm(x)}}>Delete</button></li>)}</ul>:<p className="map-caption">No credentials yet.</p>}
  <div className="map-inline-actions"><button type="button" onClick={()=>setSheet({kind:'telegram'})}>New Telegram credential</button><button type="button" onClick={()=>setSheet({kind:'email'})}>New Email credential</button></div>
  <div role="status" aria-live="polite">{note&&<p className="map-caption">{note}</p>}</div>
  {sheet&&<CredentialSheet kind={sheet.kind} credential={sheet.credential} client={client} onClose={()=>setSheet(null)} onSaved={async()=>{await onReload();setSheet(null);setNote('Credential saved.')}}/>}
  {confirm&&<Sheet title={`Delete ${confirm.name}?`} labelId="map-cred-delete-title" onClose={()=>setConfirm(null)} actions={<><button type="button" onClick={()=>setConfirm(null)}>Cancel</button><button type="button" className="primary" onClick={()=>del(confirm)}>Delete</button></>}>
   <p>The login is removed from DockNest. A credential that a node still uses cannot be deleted.</p>
   {err&&<Note kind="error" icon={IconCircleX} role="alert">{err}</Note>}</Sheet>}
 </SidePanel>;
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

// In a server, site or DockNest panel: the alerts that start here and a way to add one.
export function SourceAlerts({source,rules,channels,onEdit,onAdd}){
 const mine=rules.filter(r=>sameSource(r,source)),name=id=>channels.find(c=>c.id===id)?.name||'a channel';
 return <section aria-labelledby={'map-alerts-'+source.kind}>
  <h3 id={'map-alerts-'+source.kind} className="map-group-title">Alerts</h3>
  {mine.length>0?<ul className="map-alert-rows">{mine.map(r=><li key={r.id}><span><b className="map-name">To {name(r.channelId)}</b><span className="map-caption">{words(r.events)}</span></span><button type="button" aria-label={`Open alerts to ${name(r.channelId)}`} onClick={e=>onEdit(r,e.currentTarget)}>Open</button></li>)}</ul>:<p className="map-caption">No alerts from here yet.</p>}
  <button type="button" onClick={e=>onAdd(source,e.currentTarget)}>Send alerts to{'…'}</button>
 </section>;
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
