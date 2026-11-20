import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {X} from '../icons.jsx';
import {AlertPanel} from '../system.jsx';
import {NOTE_MAX} from './model.js';
import './backup-coverage.css';

// Confirms "Skip". Nothing changes on the server: DockNest only remembers the name and the optional note.
export function SkipDialog({item,busy,error,onConfirm,onClose}){
 const ref=useRef(),[note,setNote]=useState('');
 useEffect(()=>{ref.current?.showModal?.();return()=>ref.current?.close?.();},[]);
 return createPortal(<dialog ref={ref} className="bc-dialog" aria-labelledby="bc-skip-title" onCancel={event=>{event.preventDefault();if(!busy)onClose();}} onClick={event=>{if(event.target===ref.current&&!busy)onClose();}}>
  <div className="modal-head"><h2 id="bc-skip-title">Skip {item.name}?</h2><button type="button" className="icon" onClick={onClose} disabled={busy} aria-label="Close dialog"><X size={20}/></button></div>
  <form className="modal-body" onSubmit={event=>{event.preventDefault();onConfirm(note.trim());}}>
   <p>DockNest will stop listing this {item.kind} as not backed up. It stays unprotected. Nothing changes on the server, and you can undo this at any time.</p>
   <label className="field"><span>Note (optional)</span><input type="text" name="note" maxLength={NOTE_MAX} value={note} onChange={event=>setNote(event.target.value)} aria-describedby="bc-note-help"/><small id="bc-note-help">For example: a cache that is rebuilt on start. {note.length}/{NOTE_MAX}</small></label>
   {error&&<AlertPanel variant="error" title="The change was not saved">{error}</AlertPanel>}
   <div className="modal-foot"><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy?'Saving…':'Skip'}</button></div>
  </form>
 </dialog>,document.body);
}
