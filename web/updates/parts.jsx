import React,{useEffect,useRef,useState} from 'react';
import {IconX,IconCopy,IconCheck,IconExternalLink} from '@tabler/icons-react';
import {parseNotes} from './notes-parse.js';

export const REPO='https://github.com/DahanItamar/DockNest';
export const DOCS_ROLLBACK=REPO+'/blob/main/docs/upgrading.md#rolling-back';
export const DOCS_UPGRADE=REPO+'/blob/main/docs/upgrading.md#upgrade-with-one-command';
export const DOCS_SECURITY=REPO+'/blob/main/docs/security.md';
// Every link that leaves DockNest: new tab, no opener, no referrer.
export function ExtLink({href,children,className=''}){return <a className={'link-ext '+className} href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}<IconExternalLink size={14} aria-hidden="true"/><span className="sr-only"> (opens GitHub in a new tab)</span></a>}
// Native modal dialog: focus is trapped, Escape closes it, focus returns to the opener.
export function UCDialog({title,onClose,children,size='md',label,dismiss=true}){
 const ref=useRef(),opener=useRef(null);
 useEffect(()=>{opener.current=document.activeElement;ref.current.showModal();return()=>{ref.current?.close();const el=opener.current;if(el&&document.contains(el))el.focus()}},[]);
 const id=useRef('uc-dialog-'+Math.random().toString(36).slice(2,8)).current;
 return <dialog ref={ref} className={'uc-dialog dialog-'+size} aria-labelledby={id} onCancel={e=>{e.preventDefault();if(dismiss)onClose()}} onClick={e=>{if(dismiss&&e.target===ref.current)onClose()}}><div className="modal-head"><h2 id={id}>{title}</h2>{dismiss&&<button type="button" className="icon" onClick={onClose} aria-label={'Close '+(label||'dialog')}><IconX size={20}/></button>}</div><div className="modal-body">{children}</div></dialog>;
}
export function CodeBlock({command,label}){
 const [copied,setCopied]=useState(false);
 async function copy(){try{await navigator.clipboard.writeText(command);setCopied(true);setTimeout(()=>setCopied(false),2000)}catch{setCopied(false)}}
 return <div className="code-block"><pre><code>{command}</code></pre><button type="button" onClick={copy} aria-label={(copied?'Copied: ':'Copy: ')+(label||command)}>{copied?<IconCheck size={18}/>:<IconCopy size={18}/>}<span>{copied?'Copied':'Copy'}</span></button></div>;
}
function Inline({nodes}){return nodes.map((n,i)=>n.t==='text'?<React.Fragment key={i}>{n.v}</React.Fragment>:n.t==='bold'?<strong key={i}><Inline nodes={n.c}/></strong>:n.t==='code'?<code key={i}>{n.v}</code>:<a key={i} href={n.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><Inline nodes={n.c}/></a>)}
// Builds React elements from the parsed subset. Nothing is ever injected as markup.
export function Notes({markdown,tag}){
 const blocks=parseNotes(markdown,tag);
 return <div className="notes">{blocks.map((b,i)=>b.t==='h'?React.createElement('h'+Math.min(4,b.level+2),{key:i},<Inline nodes={b.c}/>):b.t==='p'?<p key={i}><Inline nodes={b.c}/></p>:b.t==='ul'?<ul key={i}>{b.items.map((item,j)=><li key={j}><Inline nodes={item}/></li>)}</ul>:<pre key={i}>{b.v}</pre>)}</div>;
}
