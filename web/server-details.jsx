import React,{useState} from 'react';

export function ServerDetails({api,Field,server,onSaved,onCancel,onSessionExpired}) {
 const [name,setName]=useState(server.name),[note,setNote]=useState(server.note||'');
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(event){
  event.preventDefault();if(busy)return;setBusy(true);setError('');
  try{await api('/servers/'+server.id+'/details',{name,note},'PATCH');onSaved();}
  catch(error){if(error.status===401)onSessionExpired();else setError(error.message);}
  finally{setBusy(false);}
 }
 return <form className="modal-body" onSubmit={submit}>
  <p>{server.host}:{server.port}</p>
  <Field label="Server name" aria-label="Server name" value={name} onChange={event=>setName(event.target.value)} maxLength={100} help="Optional. Uses the server address when left empty."/>
  <Field label="Server note (optional)" aria-label="Server note (optional)" value={note} onChange={event=>setNote(event.target.value)} maxLength={200} help="A short title or reminder shown with this server in lists."/>
  {error&&<div className="alert" role="alert">{error}</div>}
  <div className="modal-foot"><button type="button" disabled={busy} onClick={onCancel}>Cancel</button><button className="primary" disabled={busy}>{busy?'Saving…':'Save details'}</button></div>
 </form>;
}
