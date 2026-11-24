import React,{useCallback,useEffect,useState} from 'react';
import {IconFileTypePdf,IconBook2} from '@tabler/icons-react';
import {StatusLabel,AlertPanel} from '../system.jsx';
import {ExportDialog} from './ExportDialog.jsx';
import './recovery-guide.css';

// The Recovery Guide page (docs/recovery-guide.md): the guide as plain numbered steps, made from what DockNest knows now.
// The words "Verified" and "Not verified" follow the server's own status for each app; nothing is claimed here.
const Steps=({items})=><ol className="rb-steps">{items.map((item,i)=><li key={i}><span>{item.text??item}{item.command&&<pre className="rg-cmd"><code>{item.command}</code></pre>}</span></li>)}</ol>;
const Table=({head,rows})=><div className="data-table-wrap rg-table"><table className="data-table"><thead><tr>{head.map(h=><th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{rows.map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j} data-label={head[j]}>{cell}</td>)}</tr>)}</tbody></table></div>;
const testState=text=>/^Passed/.test(text)?'success':/^(Failed|Could not)/.test(text)?'failed':'queued';
const when=iso=>{const d=new Date(iso);return Number.isNaN(d.getTime())?'an unknown date':d.toLocaleString(undefined,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})};

function WhoToAsk({text,api,onSaved}){
 const [edit,setEdit]=useState(false),[value,setValue]=useState(text||''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function save(){setBusy(true);setError('');try{await api('/runbook/notes',{notes:value});setEdit(false);onSaved()}catch(e){setError(e.message)}setBusy(false)}
 return <section><h2>Who to ask</h2>
  {edit?<div className="rg-notes"><label className="rg-field">Who to ask, and where to find things<textarea rows={5} maxLength={4000} value={value} onChange={e=>setValue(e.target.value)} disabled={busy}/></label>
   {error&&<AlertPanel variant="error">{error}</AlertPanel>}
   <div className="rg-actions"><button type="button" className="link-action" disabled={busy} onClick={()=>{setEdit(false);setValue(text||'')}}>Cancel</button><button type="button" className="primary" disabled={busy} onClick={save}>Save note</button></div></div>
  :<div className="rb-note">{text?<p>{text}</p>:<p>No note yet. Write who to call first and where the shared accounts are kept. Do not write passwords here.</p>}<button type="button" className="link-action" onClick={()=>setEdit(true)}>{text?'Edit note':'Write a note'}</button></div>}
 </section>;
}

function Fleet({guide,api,reload}){
 const {startHere,order,fleet}=guide,addr=fleet.servers.some(s=>s.address);
 return <>
  <section><h2>Start here</h2><div className="rb-two rb-start">
   {[['Get a new server',startHere.server],['Install DockNest',startHere.install],['Connect the backup storage',startHere.storage]].map(([title,items])=><div className="rb-note" key={title}><h3 className="rb-sub">{title}</h3><Steps items={items}/></div>)}</div></section>
  <section><h2>Restore everything in this order</h2>{order.length?<Steps items={order.map(o=>({text:<span><b>{o.name}.</b> {o.reason}</span>}))}/>:<p>There are no apps to restore yet.</p>}</section>
  <section><h2>What this is</h2><p>{fleet.about}</p><p>Follow the numbered steps in order. If a step does not make sense, stop and ask the people listed below.</p></section>
  <WhoToAsk text={fleet.whoToAsk} api={api} onSaved={reload}/>
  <section><h2>Your servers</h2>{fleet.servers.length?<Table head={addr?['Server','What runs there','Provider note','Address']:['Server','What runs there','Provider note']} rows={fleet.servers.map(s=>[s.name,s.apps.join(', '),s.note||'None',...(addr?[<span className="rb-addr">{s.address}</span>]:[])])}/>:<p>No servers yet.</p>}</section>
  <section><h2>Your apps</h2>{fleet.apps.length?<Table head={['App','Server','Last good backup','Expected time to recover','Last restore test']} rows={fleet.apps.map(a=>[a.name,a.server,a.lastBackup,a.recovery,a.lastTest?<StatusLabel state={testState(a.lastTest)}>{a.lastTest.replace(/\.$/,'')}</StatusLabel>:'Not included'])}/>:<p>No apps yet.</p>}</section>
  <section><h2>Where the backups are</h2>{fleet.storage.length?<ul className="rg-list">{fleet.storage.map(s=><li key={s.name}><b>{s.name}</b> ({s.kind}){s.holds.length?` holds ${s.holds.join(', ')}.`:' holds no backups yet.'}{s.address?` Address: ${s.address}.`:''}</li>)}</ul>:<p>No backup storage is connected yet.</p>}</section>
  <section><h2>The emergency kit</h2><p>{fleet.kit.summary}</p>{fleet.kit.holders?.length>0&&<p>Held by: {fleet.kit.holders.join(', ')}.</p>}{fleet.kit.details.map(d=><p key={d}>{d}</p>)}</section>
 </>;
}

function AppPage({app}){
 const verified=app.status==='verified';
 return <>
  <section><h2>What {app.name} is</h2><p>{app.about}</p></section>
  <section><h2>How to tell it is working</h2><Steps items={app.works.steps}/>{app.works.command&&<pre className="rg-cmd"><code>{app.works.command}</code></pre>}</section>
  <section><h2>If it is down</h2><Steps items={app.down}/></section>
  <section><h2>Restore it from a backup</h2><Steps items={app.restore.steps}/>{app.restore.note&&<p>{app.restore.note}</p>}
   {app.restore.independent&&<><h3 className="rb-sub rg-gap">Without DockNest</h3><p>For someone who knows Linux. <a href={app.restore.expertGuide} target="_blank" rel="noreferrer">Read the full expert guide.</a></p><Steps items={app.restore.independent.map(item=>item.text?item:{text:String(item)})}/></>}</section>
  <section><h2>Last restore test</h2><p><StatusLabel state={verified?'success':'needs-review'}>{verified?'Verified':'Not verified'}</StatusLabel></p><p>{app.statusText}</p>
   {app.lastTest&&<p>{app.lastTest}</p>}
   {!verified&&<p>No restore test has passed on the newest backup of {app.name}, so these steps are written from its settings and have not been tried.</p>}
   {app.lastBackup&&<p>Newest backup: {app.lastBackup}.</p>}{app.schedule&&<p>{app.schedule}</p>}{app.keys&&<p>{app.keys}</p>}
   {app.keyGaps?.length>0&&<ul className="rg-list">{app.keyGaps.map(g=><li key={g}>Known gap: {g}</li>)}</ul>}</section>
 </>;
}

export function RecoveryGuide({api,onSessionExpired}){
 const [data,setData]=useState(null),[error,setError]=useState(''),[tab,setTab]=useState('Fleet overview'),[open,setOpen]=useState(false);
 const load=useCallback(async()=>{try{setData(await api('/runbook'));setError('')}catch(e){if(e.status===401){onSessionExpired?.();return}setError(e.message||'The Recovery Guide could not be loaded.')}},[api,onSessionExpired]);
 useEffect(()=>{load()},[load]);
 if(error&&!data)return <div className="rb"><AlertPanel variant="error" title="The Recovery Guide could not be loaded" action={<div><button type="button" className="link-action" onClick={load}>Try again</button></div>}>{error}</AlertPanel></div>;
 if(!data)return <div className="loading">Loading the Recovery Guide…</div>;
 const {guide}=data,app=guide.apps.find(a=>a.id===tab),untested=guide.apps.filter(a=>a.status!=='verified');
 const dialog=open&&<ExportDialog api={api} apps={guide.apps.map(a=>({id:a.id,name:a.name}))} only={app?.id} onClose={()=>setOpen(false)} onMade={load}/>;
 if(!data.made)return <div className="rb"><section className="card"><div className="card-body rg-empty"><IconBook2 size={32} stroke={1.5} aria-hidden="true"/><h2 className="card-title">No Recovery Guide yet</h2><p className="t-body">DockNest writes it from your servers, apps, backups and restore tests. Make it once so you can tell when it goes out of date.</p></div><div className="card-footer"><button type="button" className="primary" onClick={()=>setOpen(true)} disabled={!guide.apps.length}>Make the Recovery Guide</button></div></section>{dialog}</div>;
 return <div className="rb">
  {data.outdated&&<AlertPanel variant="warning" title="This Recovery Guide is out of date" action={<div><button type="button" className="primary" onClick={()=>setOpen(true)}>Make it again</button></div>}>{data.changes.length?data.changes.map(c=>c.label).join(' '):'Something it was made from changed after it was made.'}</AlertPanel>}
  {!data.outdated&&untested.length>0&&<AlertPanel variant="warning" title="Some steps are not verified"><ul className="rb-warnlist">{untested.map(a=><li key={a.id}>{a.name}: {a.status==='none'?'it has no backup yet.':'no restore test has passed on its newest backup yet.'} Its steps are not verified.</li>)}</ul></AlertPanel>}
  {error&&<AlertPanel variant="error">{error}</AlertPanel>}
  <div className="rb-tabs" role="group" aria-label="Recovery Guide pages">{[['Fleet overview','Fleet overview'],...guide.apps.map(a=>[a.id,a.name])].map(([id,label])=><button type="button" key={id} aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</div>
  <article className="rb-paper" aria-label="Recovery Guide">
   <header className="rb-head"><div><h2 className="rb-title">{app?app.name+': what to do':'If something happens to me'}</h2><div className="rb-meta"><span>Made on {when(data.madeAt)}{data.madeBy?` by ${data.madeBy}`:''}</span><button type="button" className="link-action" onClick={()=>setOpen(true)}><IconFileTypePdf size={16} stroke={1.75} aria-hidden="true"/>Download Recovery Guide (PDF)</button>{data.outdated?<StatusLabel state="needs-review">Out of date</StatusLabel>:<StatusLabel state="success">Up to date</StatusLabel>}</div></div></header>
   {app?<AppPage app={app}/>:<Fleet guide={guide} api={api} reload={load}/>}
  </article>
  {dialog}
 </div>;
}
