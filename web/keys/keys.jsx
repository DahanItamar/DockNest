import React,{useEffect,useRef,useState} from 'react';
import {IconLockCheck,IconLockExclamation,IconLockX,IconCircleX} from '@tabler/icons-react';
import {StatusLabel} from '../system.jsx';
import {formatDate} from '../date-format.js';
import {count} from '../plural.js';
import {Note,useGuard} from '../map/MoveFlow.jsx';
import './keys.css';

// Keys safe (docs/keys-safe.md). The API gives names, places, statuses and the first 8 characters of a fingerprint, never a
// key value. This file only shows what /api/state returns for an app: `keys: {state,keys,changed,knownGood}`.
export const LOCK={
 green:{Icon:IconLockCheck,tone:'ok',label:'Every key was found in the last backup'},
 amber:{Icon:IconLockExclamation,tone:'changed',label:'A key or file changed since it was last known good'},
 red:{Icon:IconLockX,tone:'missing',label:'A key is missing from the last backup'}
};
const isStatic=site=>site?.config?.kind==='static';
// 'none' and static sites have no padlock: no badge never suggests safety.
export const keyState=site=>!isStatic(site)&&LOCK[site?.keys?.state]?site.keys.state:null;

export function Padlock({state,className='map-lock'}){
 const l=LOCK[state];if(!l)return null;
 return <span className={className+' lock-'+l.tone} role="img" aria-label={l.label} title={l.label}><l.Icon size={14} stroke={2} aria-hidden="true"/></span>;
}

const NO_BACKUP='This app has no backup yet.',NOT_INCLUDED='The file is not one of the files this app backs up.';
export const fp=value=>String(value||'').replace(/(.{4})(?=.)/g,'$1 ').trim();
export function ago(iso,now=Date.now()){
 const ms=now-new Date(iso).getTime();if(!Number.isFinite(ms))return '';
 const m=Math.floor(ms/60000);if(m<1)return 'just now';if(m<60)return count(m,'minute')+' ago';
 const h=Math.floor(m/60);if(h<24)return count(h,'hour')+' ago';return count(Math.floor(h/24),'day')+' ago';
}
const place=location=>String(location||'').startsWith('file:')?location.slice(5):String(location||'').startsWith('env:')?'Environment of '+location.slice(4):'';

// Plain words for the whole app: the card row and the panel agree.
export function keysWords(site){
 const k=site?.keys,state=keyState(site);if(!state)return null;
 const missing=k.keys.filter(x=>x.status==='missing'),verified=k.keys.length>0&&k.keys.every(x=>x.status==='verified');
 if(state==='red')return missing.every(x=>x.reasonCode?x.reasonCode==='no-backup':x.reason===NO_BACKUP)?`No backup yet, ${count(k.keys.length,'key')} found`:`${missing.length} missing from last backup`;
 if(state==='amber')return k.keys.some(x=>x.status==='changed')?'Key changed since last backup':'Changed since known-good';
 return verified?`${k.keys.length} found, verified in a restore test`:`${k.keys.length} found, in last backup`;
}

// Apps page card row, after Schedule and before Retention.
export function KeysRow({site}){
 const state=keyState(site),words=keysWords(site);if(!state)return null;
 const l=LOCK[state];
 return <div className="def-row"><dt>Keys</dt><dd><span className={'keys-word keys-'+l.tone}><l.Icon size={18} stroke={1.75} aria-hidden="true"/>{words}</span></dd></div>;
}

function keyStatus(k){
 if(k.status==='verified')return ['success',k.verifiedAt?'Verified in a restore test on '+formatDate(k.verifiedAt,{dateOnly:true}):'Verified in a restore test'];
 if(k.status==='changed')return ['needs-review',`Changed ${ago(k.changedAt)}, newer than the last backup`];
 if(k.status==='missing')return ['failed','Missing from last backup'];
 return ['success','In last backup'];
}
const changedName=c=>c.kind==='file'?c.item:'An app key';

// Map panel, below the facts. `api` is the page's fetch helper; known-good needs an administrator and a fresh sign-in check.
export function KeysSection({site,canEdit,api,onChanged}){
 const k=site?.keys;
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState(false);
 const guard=useGuard({reauth:(password,code)=>api('/auth/reauth',{password,code})}),askRef=useRef(null);
 // The sign-in check opens below the list in a scrolling panel: bring it into view.
 useEffect(()=>{if(guard.waiting)askRef.current?.scrollIntoView?.({block:'nearest'})},[guard.waiting]);
 if(!k||isStatic(site))return null;
 const none=!k.keys.length,changed=k.changed||[];
 const markable=canEdit&&changed.length>0;
 async function mark(){
  setBusy(true);setError('');setDone(false);
  await guard.run(async()=>{await api('/sites/'+encodeURIComponent(site.id)+'/keys/known-good',{});setDone(true);await onChanged?.()},
   e=>setError(e.code==='SITE_BUSY'?'This app is busy. Try again when its job finishes.':e.message||'Nothing was marked.'));
  setBusy(false);
 }
 const addFile=async key=>{
  setBusy(true);setError('');
  try{
   const row=await api('/sites/'+encodeURIComponent(site.id)),config=typeof row.config==='string'?JSON.parse(row.config):row.config,path=key.location.slice(5);
   await api('/sites/'+encodeURIComponent(site.id),{serverId:row.serverId||row.server_id,name:row.name,config:{...config,configFiles:[...new Set([...(config.configFiles||[]),path])]}},'PATCH');
   await onChanged?.();
  }catch(e){setError(e.message||'The file was not added.')}
  setBusy(false);
 };
 return <section className="keys-section" aria-labelledby={'keys-title-'+site.id}>
  <h3 className="map-group-title" id={'keys-title-'+site.id}>Keys this app needs</h3>
  {none?<p className="map-caption">No app keys found. DockNest looks for keys such as APP_KEY, N8N_ENCRYPTION_KEY and SECRET_KEY_BASE.</p>:<>
   <ul className="keys-list">{k.keys.map(key=>{const [state,word]=keyStatus(key),where=place(key.location),addable=key.status==='missing'&&(key.reasonCode?key.reasonCode==='not-included':key.reason===NOT_INCLUDED)&&String(key.location).startsWith('file:');
    return <li key={key.ruleId+key.location}>
     <code className="keys-name">{key.name}</code>
     <span className="map-caption">{where&&<>{where}{key.app?` (${key.app})`:''} · </>}<code>{fp(key.fingerprint)}</code></span>
     <StatusLabel state={state}>{word}</StatusLabel>
     {key.reason&&<p className="keys-reason">{addable?`${key.reason} Add ${where} to the app's configuration files.`:key.reason}</p>}
     {canEdit&&addable&&<button type="button" className="link-action" disabled={busy} onClick={()=>addFile(key)}>Add file</button>}
    </li>})}</ul>
   <p className="map-caption">DockNest never shows or stores key values. It compares fingerprints.</p>
  </>}
  {changed.length>0&&<>
   <h3 className="map-group-title">Changed since known-good</h3>
   <ul className="keys-list">{changed.map(c=><li key={c.item}><code className="keys-name">{changedName(c)}</code>
    <StatusLabel state="needs-review">{c.kind==='file'?'Changed outside Safe Edit':'Changed'}{c.firstSeenAt?', '+formatDate(c.firstSeenAt,{shortTime:true}):''}</StatusLabel></li>)}</ul>
   {markable&&<div className="keys-mark"><button type="button" className="link-action" disabled={busy||guard.waiting} onClick={mark}>Mark as known-good</button><p className="map-caption">Do this after you checked the change.</p></div>}
  </>}
  {!changed.length&&k.knownGood&&<p className="map-caption">Compose, env and configuration files unchanged since known-good, {formatDate(k.knownGood.at,{shortTime:true})}.</p>}
  {guard.prompt&&<div ref={askRef}>{guard.prompt}</div>}
  {done&&<p className="map-caption" role="status">Marked as known-good.</p>}
  {error&&<Note kind="error" icon={IconCircleX} role="alert">{error}</Note>}
 </section>;
}
