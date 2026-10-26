import React from 'react';
import {CheckCircle2,CircleX,Clock,InfoCircle,Loader,Minus,TriangleAlert} from '../icons.jsx';
import {age,summaryOf} from './model.js';

const ICON={success:CheckCircle2,failed:CircleX,queued:InfoCircle,running:Loader,'needs-review':TriangleAlert};
// The product's status label; "Not tested" uses the info icon (a state, not a wait).
export function TestLabel({state,children}){
 const Icon=ICON[state]||InfoCircle;
 return <span className={'status status-'+state}><Icon className="status-icon" size={16} stroke={2} aria-hidden="true"/>{children}</span>;
}
// "Last test" column: the status and how long ago, nothing else.
export function LastTest({card}){
 const sum=summaryOf(card),when=sum.at?age(sum.at):'';
 return <span className="rt-meta rt-main"><TestLabel state={sum.state}>{sum.label}</TestLabel>{when&&<> · {when}</>}</span>;
}
export const STEP_ICON={done:[CheckCircle2,'ok'],failed:[CircleX,'bad'],running:[Loader,'run'],skipped:[Minus,''],pending:[Clock,'']};
