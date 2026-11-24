import React,{useEffect,useState} from 'react';
import {SwitchRow} from '../connections/parts.jsx';

// Settings > Synology support: off by default. Early access for Synology DSM; an administrator opts in here. The switch
// only changes what DockNest offers; nothing on a server changes.
export function SynologySetting({api}){
 const [enabled,setEnabled]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let live=true;api('/settings/synology').then(r=>{if(live)setEnabled(Boolean(r.enabled))}).catch(()=>{if(live)setError('The setting could not be loaded.')});return()=>{live=false}},[api]);
 async function change(next){
  if(enabled===null||busy)return;
  setBusy(true);setError('');
  try{const r=await api('/settings/synology',{enabled:next},'PUT');setEnabled(Boolean(r.enabled));}
  catch(e){setError(e.message||'The setting could not be saved.');}
  finally{setBusy(false);}
 }
 return <>
  <SwitchRow id="syn-switch" label={<>Synology support <span className="nas-label syn-beta">Beta</span></>} help="Early access for Synology DSM 7.2 with Container Manager. Share feedback through Report a problem." checked={Boolean(enabled)} disabled={enabled===null||busy} onChange={change}/>
  {error&&<p className="t-caption bad" role="alert">{error}</p>}
 </>;
}
