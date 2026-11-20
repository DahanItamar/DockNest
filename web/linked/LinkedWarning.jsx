import React,{useState} from 'react';
import {AlertPanel} from '../system.jsx';
import './linked.css';

const SHOWN=2;
// Warn only: one plain sentence per linked app or unbacked container, the first two shown and "and N more" for the rest,
// which "Show fewer" hides again. The toggle keeps focus, so a keyboard user is not dropped when it is pressed.
// items come from warningsFor(); onOpenApp(appId) opens that app's page.
export function LinkedLines({items,onOpenApp}){
 const [all,setAll]=useState(false);
 const shown=all?items:items.slice(0,SHOWN),rest=items.length-SHOWN;
 return <span className="lw-lines" aria-live="polite">
  {shown.map(item=><span key={item.id} className="lw-line">{item.before}{item.app&&<button type="button" className="lw-link" onClick={()=>onOpenApp(item.app.id)}>{item.app.name}</button>}{item.after}</span>)}
  {rest>0&&<button type="button" className="lw-link" aria-expanded={all} onClick={()=>setAll(!all)}>{all?'Show fewer':`and ${rest} more`}</button>}
 </span>;
}
export const LinkedWarning=({items,onOpenApp})=>items.length>0&&<AlertPanel variant="warning"><LinkedLines items={items} onOpenApp={onOpenApp}/></AlertPanel>;
