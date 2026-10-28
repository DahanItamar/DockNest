import React from 'react';
import {CheckCircle2,Loader,Clock,CircleX,TriangleAlert} from '../icons.jsx';
import {copyLines,canRetry} from './model.js';
import './copies.css';

const ICONS={success:CheckCircle2,running:Loader,queued:Clock,failed:CircleX,'needs-review':TriangleAlert};

// One small label per destination: plain text and a semantic icon. Failed copies get a Retry button.
export function CopyLabel({name,state,word,title}){
 const Icon=ICONS[state]||Clock;
 return <span className={'status status-'+state+' cp-label'} title={title||name+', '+word}><Icon className="status-icon" size={16} stroke={2} aria-hidden="true"/><span className="cp-label-name">{name}</span><span className="cp-label-word">{word}</span></span>;
}

export function CopyLines({backup,busy,retrying,onRetry}){
 const lines=copyLines(backup);
 if(!lines.length)return null;
 return <div className="cp-copies" role="list" aria-label={'Copies of backup '+backup.id}>{lines.map(line=><div className="cp-copy" role="listitem" key={line.key}>
  <CopyLabel name={line.name} state={line.state} word={line.word} title={line.copy?.lastError?line.name+': '+line.copy.lastError:undefined}/>
  {line.copy&&canRetry(line.copy)&&<button type="button" className="cp-retry" aria-label={'Retry copy to '+line.name} disabled={busy||retrying===backup.id+':'+line.copy.targetId} onClick={()=>onRetry(backup,line.copy)}>Retry</button>}
 </div>)}</div>;
}
