import React from 'react';
import {CheckCircle2,Loader,Clock,CircleX,TriangleAlert,InfoCircle} from './icons.jsx';

// 2.3.0 shared primitives. Styles live in system.css (.status, .alert-panel, .icon-button).
const STATES={
 success:{Icon:CheckCircle2,label:'Succeeded'},
 running:{Icon:Loader,label:'Running'},
 queued:{Icon:Clock,label:'Queued'},
 failed:{Icon:CircleX,label:'Failed'},
 'needs-review':{Icon:TriangleAlert,label:'Needs review'}
};
// Maps any status string used by the API to one of the five states.
export function statusState(value){
 const v=String(value||'');
 if(/recovery|review/i.test(v))return 'needs-review';
 if(/fail|error|denied|invalid|revoked/i.test(v))return 'failed';
 if(/running|progress|^active$/i.test(v))return 'running';
 if(/complete|success|succeeded|ready|healthy|verified|online/i.test(v))return 'success';
 return 'queued';
}
const humanise=v=>{const t=String(v).replace(/[_-]+/g,' ').trim();return t.charAt(0).toUpperCase()+t.slice(1)};
// value: any status string (shown humanised); state: force one of success|running|queued|failed|needs-review.
export function StatusLabel({value,state,children}){
 const s=state||statusState(value),{Icon}=STATES[s]||STATES.queued;
 const text=children||(value?humanise(value):'Unknown');
 return <span className={'status status-'+s}><Icon className="status-icon" size={16} stroke={2} aria-hidden="true"/>{text}</span>;
}

const ALERT_ICON={error:CircleX,warning:TriangleAlert,info:InfoCircle};
// variant: error|warning|info. action: optional node, e.g. <a href="#">Open job</a>.
export function AlertPanel({variant='error',title,children,action}){
 const Icon=ALERT_ICON[variant]||CircleX;
 return <div className={'alert-panel alert-'+variant} role={variant==='info'?'status':'alert'}><Icon className="alert-panel-icon" size={20} stroke={2} aria-hidden="true"/><div className="alert-panel-body">{title&&<b>{title}</b>}{children&&<span>{children}</span>}{action}</div></div>;
}

// Frameless 40x40 icon button. label is required (aria-label and tooltip).
export function IconButton({label,icon:Icon,size=20,className='',...rest}){
 return <button type="button" className={('icon-button '+className).trim()} aria-label={label} title={label} {...rest}><Icon size={size} stroke={1.75} aria-hidden="true"/></button>;
}
