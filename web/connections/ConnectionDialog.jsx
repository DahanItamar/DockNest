import React,{useEffect,useMemo,useRef,useState} from 'react';
import {IconX,IconLock,IconPencil,IconExternalLink,IconChevronDown,IconCircleCheck,IconCircleX} from '@tabler/icons-react';
import {AlertPanel} from '../system.jsx';
import {Combo} from './parts.jsx';
import {GROUPS,LANGUAGES,SECURITY} from './client.js';

// New or edit connection (docs/alert-channels.md, "Screens"): Provider first (searchable, grouped; Other under Advanced),
// then Name and the provider's own fields from the registry, "More options" for the rarely changed ones, then Cancel,
// Send test and Save. Test and Save stay disabled with "Add the missing details." until every required field is filled.
// Edit locks the provider and shows saved secrets as "Saved, hidden"; the pencil only replaces. Changing a server (a
// `host` field) asks for the saved secrets again, as the API does. Writes that need a fresh sign-in check show it here
// and retry. A modal dialog on desktop, a bottom sheet on phones.
const WEBHOOK_SAMPLE={title:'Backup failed',site:'cinderbean.com',server:'Frankfurt-1',message:'Backup failed: cinderbean.com on Frankfurt-1 at 03:00 UTC. The backup did not finish. Open DockNest to see why.',url:'https://docknest.example.net/?job=8f2c1d4e',event:'backup.failed',at:'2026-10-27T03:00:00.000Z'};
const META_HELP='https://developers.facebook.com/docs/whatsapp/cloud-api/get-started';
const text=v=>Array.isArray(v)?v.join(', '):v===undefined||v===null?'':String(v);
// A field's starting value: its own default, else the first choice of a list, else Email's usual submission port.
const defaultOf=f=>f.default??(f.type==='select'?f.options?.[0]:f.key==='port'?587:undefined);
const listOf=v=>String(v||'').split(/[,;\s]+/).map(x=>x.trim()).filter(Boolean);
const wire=(field,v)=>field.type==='number'?(v===''?v:Number(v)):field.type==='email-list'?listOf(v):String(v).trim();

export function useReauth(client){
 const [need,setNeed]=useState(null);
 const run=async(fn,onError)=>{try{return await fn()}catch(e){if(e.code==='REAUTH_REQUIRED'){setNeed({fn,onError});return}onError?.(e)}};
 const box=need&&<ReauthBox client={client} onCancel={()=>setNeed(null)} onVerified={async()=>{const n=need;setNeed(null);await run(n.fn,n.onError)}}/>;
 return {run,box,waiting:!!need};
}
// The same check as the Update Center and the move flow: the shared password and a fresh authenticator code.
function ReauthBox({client,onVerified,onCancel}){
 const [password,setPassword]=useState(''),[code,setCode]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),first=useRef(null);
 useEffect(()=>{first.current?.focus()},[]);
 async function verify(){setBusy(true);setError('');try{await client.reauth(password,code.trim());await onVerified()}catch(e){setError(e.status===401?'That password or code was not right. Try again.':e.message||'The check did not go through.');setBusy(false)}}
 return <section className="cx-reauth" aria-labelledby="cx-reauth-title">
  <b id="cx-reauth-title">Please confirm it is you</b>
  <p className="t-caption">Enter the shared password and a fresh code from your authenticator.</p>
  <label className="field"><span>Password</span><input ref={first} type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} aria-invalid={!!error||undefined}/></label>
  <label className="field"><span>Authenticator code</span><input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e=>setCode(e.target.value)} aria-invalid={!!error||undefined}/></label>
  {error&&<AlertPanel variant="error">{error}</AlertPanel>}
  <div className="cx-reauth-actions"><button type="button" onClick={onCancel}>Not now</button><button type="button" className="primary" disabled={busy||!password||code.trim().length<6} onClick={verify}>Verify and continue</button></div>
 </section>;
}

export function ConnectionDialog({client,providers,connection,initialProvider,prefill,role,onClose,onSaved}){
 const edit=!!connection,ref=useRef(null),nameRef=useRef(null),guard=useReauth(client);
 const [providerId,setProviderId]=useState(connection?.provider||initialProvider||'');
 const item=providers.find(p=>p.id===providerId)||null;
 const initial=useMemo(()=>{const out={};for(const f of item?.fields||[]){if(f.secret)continue;const v=edit?connection.values?.[f.key]:prefill?.[f.key]??defaultOf(f);out[f.key]=text(v)}return out},[providerId]);
 const [values,setValues]=useState(initial),[name,setName]=useState(()=>connection?.name||(item?'My '+(item.id==='webhook'?'webhook':item.label):'')),[replacing,setReplacing]=useState(()=>new Set());
 const [busy,setBusy]=useState(false),[error,setError]=useState(null),[result,setResult]=useState(null),[testing,setTesting]=useState(false),[customLang,setCustomLang]=useState(false);
 const readOnly=(edit&&connection.editable===false)||(!!item?.adminOnly&&role!=='admin');
 useEffect(()=>{const d=ref.current;if(d&&!d.open)d.showModal();setTimeout(()=>(edit?nameRef.current:d?.querySelector('.cx-combo'))?.focus(),0);return()=>{if(d?.open)d.close()}},[]);
 // A new provider starts from its own defaults; the name follows the provider until the user types one.
 function pickProvider(id){const p=providers.find(x=>x.id===id);setProviderId(id);setResult(null);setError(null);setReplacing(new Set());setCustomLang(false);
  const next={};for(const f of p?.fields||[])if(!f.secret)next[f.key]=text(prefill?.[f.key]??defaultOf(f));setValues(next);
  if(!name.trim()||providers.some(x=>name==='My '+(x.id==='webhook'?'webhook':x.label)))setName('My '+(id==='webhook'?'webhook':p.label));}
 const set=(key,v)=>{setValues(s=>({...s,[key]:v}));setResult(null);if(error?.field===key)setError(null)};
 const saved=key=>edit&&!!connection.values?.[key+'Set'];
 // A changed server needs the saved secrets typed again, so they switch to "New ..." on their own.
 const hostChanged=edit&&(item?.host||[]).some(k=>!item.fields.find(f=>f.key===k)?.secret&&text(values[k])!==text(connection.values?.[k]));
 const forced=new Set(hostChanged?(item?.fields||[]).filter(f=>f.secret&&saved(f.key)&&!(item.host||[]).includes(f.key)).map(f=>f.key):[]);
 const isReplacing=key=>replacing.has(key)||forced.has(key);
 const shown=f=>!(item?.id==='email'&&f.key==='password'&&!values.username?.trim()&&!saved('password'));
 const missing=!item||!name.trim()||(item.fields||[]).filter(shown).some(f=>{
  const v=values[f.key]??'';
  if(f.secret){if(saved(f.key)&&!isReplacing(f.key))return false;if(item.id==='email'&&f.key==='password')return !!values.username?.trim()&&!v;return f.required&&!v.trim()}
  if(f.type==='email-list')return f.required&&!listOf(v).length;
  return f.required&&!String(v).trim();
 });
 // What goes to the API: everything for a new Connection; for an edit only what changed, and typed secrets.
 function payload(){
  const out={};
  for(const f of item.fields){
   const v=values[f.key]??'';
   if(f.secret){if(v&&(!edit||isReplacing(f.key)))out[f.key]=v;continue}
   if(edit&&text(v)===text(connection.values?.[f.key]))continue;
   if(!edit&&v===''&&!f.required)continue;
   out[f.key]=wire(f,v);
  }
  return out;
 }
 const fail=e=>{setError({text:e.message||'This did not work. Try again.',field:e.field});if(e.field)setTimeout(()=>ref.current?.querySelector(`[data-key="${e.field}"]`)?.focus(),0)};
 async function save(){
  setBusy(true);setError(null);
  await guard.run(async()=>{
   const body=edit?{...(name!==connection.name?{name}:{}),values:payload()}:{provider:item.id,name,values:payload()};
   if(edit&&!Object.keys(body.values).length)delete body.values;
   const view=edit?(body.name||body.values?await client.update(connection.id,body):connection):await client.create(body);
   await onSaved(view,!edit);
  },fail);
  setBusy(false);
 }
 async function test(){
  setTesting(true);setResult(null);setError(null);
  try{
   const changes=edit?payload():null;
   const r=edit&&!Object.keys(changes).length?await client.test(connection.id):await client.testValues({provider:item.id,values:edit?changes:payload(),...(edit?{connectionId:connection.id}:{})});
   setResult({ok:true,text:r.note||'Delivered.'});
  }catch(e){if(e.field)fail(e);setResult({ok:false,text:e.message||'The test message could not be sent.'})}
  setTesting(false);
 }
 const items=providers.map(p=>({value:p.id,label:p.label,icon:p.icon,group:GROUPS[p.group]||p.group}));
 function control(f){
  const v=values[f.key]??'',invalid=error?.field===f.key||undefined,id='cx-f-'+f.key,help=f.help||(f.type==='email-list'?`Up to ${f.max||5} addresses, separated by commas.`:'');
  const helpEl=help&&<small id={id+'-help'}>{help}</small>;
  if(f.secret&&saved(f.key)&&!isReplacing(f.key))return <div key={f.key} className="field" role="group" aria-labelledby={id}>
   <span id={id}>{f.label}</span>
   <div className="cx-saved"><span><IconLock size={18} stroke={1.75} aria-hidden="true"/>Saved, hidden</span>{!readOnly&&<button type="button" className="icon-button" data-key={f.key} aria-label={'Replace '+f.label.toLowerCase()} title={'Replace '+f.label.toLowerCase()} onClick={()=>{setReplacing(s=>new Set([...s,f.key]));setTimeout(()=>ref.current?.querySelector(`input[data-key="${f.key}"]`)?.focus(),0)}}><IconPencil size={20} stroke={1.75} aria-hidden="true"/></button>}</div>
  </div>;
  if(f.secret)return <label key={f.key} className="field"><span>{edit&&saved(f.key)?'New '+f.label.toLowerCase():f.label}</span><input type="password" data-key={f.key} autoComplete="new-password" spellCheck={false} value={v} disabled={readOnly} aria-invalid={invalid} aria-describedby={help?id+'-help':undefined} onChange={e=>set(f.key,e.target.value)}/>
   {edit&&saved(f.key)?<small>{forced.has(f.key)&&!replacing.has(f.key)?`Enter it again: it goes to the new ${(item.fields.find(x=>(item.host||[]).includes(x.key)&&!x.secret)?.label||'server').toLowerCase()}.`:'The saved one is replaced when you save.'}</small>:helpEl}</label>;
  if(f.type==='select')return <div key={f.key} className="field" role="group" aria-labelledby={id}><span id={id}>{f.label}</span><Combo labelledBy={id} disabled={readOnly} value={v} items={SECURITY.filter(([k])=>(f.options||[]).includes(k)).map(([value,label])=>({value,label}))} onChange={next=>{set(f.key,next);if(item.id==='email'){if(next==='tls'&&['587','25'].includes(values.port))set('port','465');if(next==='starttls'&&values.port==='465')set('port','587')}}}/>{f.key==='security'&&<small>Email is always encrypted.</small>}</div>;
  if(item.id==='whatsapp'&&f.key==='language'&&!customLang&&(!v||LANGUAGES.some(([k])=>k===v)))return <div key={f.key} className="field" role="group" aria-labelledby={id}><span id={id}>{f.label}</span><Combo labelledBy={id} disabled={readOnly} value={v} search searchLabel="Search languages" items={LANGUAGES.map(([value,label])=>({value,label}))} onChange={next=>set(f.key,next)} action={{label:'Add custom',onSelect:()=>{setCustomLang(true);setTimeout(()=>ref.current?.querySelector('input[data-key="language"]')?.focus(),0)}}}/>{helpEl}</div>;
  return <label key={f.key} className="field"><span>{f.label}</span><input type={f.type==='email'?'email':f.type==='url'?'url':'text'} inputMode={f.type==='number'?'numeric':undefined} data-key={f.key} autoComplete="off" spellCheck={false} value={v} disabled={readOnly} aria-invalid={invalid} aria-describedby={help?id+'-help':undefined} onChange={e=>set(f.key,f.type==='number'?e.target.value.replace(/\D/g,''):e.target.value)}/>{helpEl}</label>;
 }
 const main=(item?.fields||[]).filter(f=>!f.more&&shown(f)),more=(item?.fields||[]).filter(f=>f.more);
 const why=readOnly?'':missing?'Add the missing details.':'';
 return <dialog ref={ref} className="site-wizard rt-dialog cx-dialog" aria-labelledby="cx-dialog-title" onCancel={e=>{e.preventDefault();onClose()}}>
  <div className="modal-head"><h2 id="cx-dialog-title">{edit?(readOnly?connection.name:'Edit connection'):'New connection'}</h2><button type="button" className="icon" aria-label="Close dialog" onClick={onClose}><IconX size={20}/></button></div>
  <form className="modal-body cx-form" onSubmit={e=>{e.preventDefault();if(!missing&&!readOnly)save()}}>
   {item?.id==='webhook'&&<AlertPanel variant="warning" title="For advanced users">DockNest sends one fixed JSON message to your URL.</AlertPanel>}
   {readOnly&&<AlertPanel variant="info">Only an administrator can change this connection. You can pick it on an alert node and send a test.</AlertPanel>}
   <div className="field" role="group" aria-labelledby="cx-l-provider"><span id="cx-l-provider">Provider</span><Combo labelledBy="cx-l-provider" items={items} value={providerId} onChange={pickProvider} disabled={edit} search searchLabel="Search providers" placeholder="Choose a provider"/></div>
   {item&&<>
    <label className="field"><span>Name</span><input ref={nameRef} data-key="name" autoComplete="off" maxLength={80} value={name} disabled={readOnly} aria-invalid={error?.field==='name'||undefined} onChange={e=>{setName(e.target.value);if(error?.field==='name')setError(null)}}/></label>
    {main.map(control)}
    {item.id==='whatsapp'&&<><p className="cx-help"><a href={META_HELP} target="_blank" rel="noopener noreferrer">How to get these<IconExternalLink size={14} stroke={2} aria-hidden="true"/></a></p><AlertPanel variant="warning">Uses your own Meta WhatsApp Business account. Meta may charge for messages.</AlertPanel></>}
    {more.length>0&&<details className="rt-adv cx-more" open={more.some(f=>error?.field===f.key)||undefined}><summary>More options<IconChevronDown size={18} stroke={1.75} className="rt-chev" aria-hidden="true"/></summary><div className="cx-more-body">{more.map(control)}</div></details>}
    {item.id==='webhook'&&<div className="field" role="group" aria-labelledby="cx-l-json"><span id="cx-l-json">Message sent</span><pre className="command-preview" tabIndex={0} aria-labelledby="cx-l-json">{JSON.stringify(WEBHOOK_SAMPLE,null,2)}</pre></div>}
    {[...replacing,...forced].length>0&&<p className="t-caption">If this login leaked, also revoke it at the provider.</p>}
   </>}
   <div role="status" aria-live="polite" className="cx-result-box">{result&&<p className={'cx-result '+(result.ok?'ok':'bad')}>{result.ok?<IconCircleCheck size={16} stroke={2} aria-hidden="true"/>:<IconCircleX size={16} stroke={2} aria-hidden="true"/>}<span>{result.text}</span></p>}</div>
   {error&&<AlertPanel variant="error">{error.text}</AlertPanel>}
   {guard.box}
   <div className="modal-foot"><span className="t-caption rt-why" role="status">{why}</span><button type="button" onClick={onClose}>{readOnly?'Close':'Cancel'}</button><button type="button" disabled={!item||missing||testing||busy||guard.waiting} onClick={test}>{testing?'Sending…':'Send test'}</button>{!readOnly&&<button type="submit" className="primary" disabled={missing||busy||guard.waiting}>{busy?'Saving…':'Save'}</button>}</div>
  </form>
 </dialog>;
}

// Delete a Connection: refused while a node uses it, with the nodes named. The API checks again (a node made meanwhile).
export function DeleteConnectionDialog({client,connection,onClose,onDeleted}){
 const ref=useRef(null),guard=useReauth(client),[busy,setBusy]=useState(false),[error,setError]=useState(''),used=(connection.usedBy||[]).map(n=>n.name);
 useEffect(()=>{const d=ref.current;if(d&&!d.open)d.showModal();d?.querySelector('h2')?.focus();return()=>{if(d?.open)d.close()}},[]);
 async function go(){setBusy(true);setError('');await guard.run(async()=>{await client.remove(connection.id);await onDeleted()},e=>setError(e.code==='CONNECTION_IN_USE'?e.message:e.message||'This connection could not be deleted.'));setBusy(false)}
 return <dialog ref={ref} className="cx-dialog cx-confirm" aria-labelledby="cx-delete-title" onCancel={e=>{e.preventDefault();onClose()}}>
  <div className="modal-head"><h2 id="cx-delete-title" tabIndex={-1}>Delete {connection.name}?</h2><button type="button" className="icon" aria-label="Close dialog" onClick={onClose}><IconX size={20}/></button></div>
  <div className="modal-body cx-form">
   {used.length?<><p>This connection is used by {used.length===1?'one alert node':used.length+' alert nodes'}. Choose another connection on {used.length===1?'it':'them'} first.</p><p className="cx-used"><b>Used by</b> <span>{used.join(', ')}</span></p></>
    :<p>The login is removed from DockNest. If it leaked, also revoke it at the provider.</p>}
   {error&&<AlertPanel variant="error">{error}</AlertPanel>}
   {guard.box}
   <div className="modal-foot"><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy||guard.waiting||used.length>0} onClick={go}>Delete</button></div>
  </div>
 </dialog>;
}
