import React,{useEffect,useState} from 'react';
import {SwitchRow} from '../connections/parts.jsx';

// Settings > NAS servers: Synology and Unraid support, each off by default. Early access: an administrator opts in here.
// The switches only change what DockNest offers; nothing on a server changes.
const ROWS=[
 {kind:'synology',label:'Synology support',help:'Early access. Send feedback with Report a problem.'},
 {kind:'unraid',label:'Unraid support',help:'Early access. Send feedback with Report a problem.'},
];
export function NasSupportSettings({api}){
 const [gates,setGates]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let live=true;api('/settings/nas').then(r=>{if(live)setGates(r)}).catch(()=>{if(live)setError('The settings could not be loaded.')});return()=>{live=false}},[api]);
 async function change(kind,enabled){
  if(!gates||busy)return;
  setBusy(true);setError('');
  try{setGates(await api('/settings/nas/'+kind,{enabled},'PUT'));}
  catch(e){setError(e.message||'The setting could not be saved.');}
  finally{setBusy(false);}
 }
 return <div data-early-access="">
  {ROWS.map(({kind,label,help})=><SwitchRow key={kind} id={'nas-'+kind} label={<>{label} <span className="nas-label nas-beta">Beta</span></>} help={help} checked={Boolean(gates?.[kind])} disabled={!gates||busy} onChange={on=>change(kind,on)}/>)}
  {error&&<p className="t-caption bad" role="alert">{error}</p>}
 </div>;
}
