import React, {useEffect,useRef,useState} from 'react';
import './job-details.css';

// Human labels for recorded result fields. Unknown keys fall back to sentence case.
export const FIELD_LABELS={backupId:'Backup ID',restoreId:'Restore ID',targetServerId:'Target server ID',downtimeSeconds:'Service downtime',sourceReady:'Source ready',verification:'Verification',integrity:'Package integrity',isolatedRestore:'Isolated restore',application:'Application check',status:'Status',method:'Method',networkMode:'Network mode',containerIds:'Container IDs',result:'Result',error:'Error',scope:'Check scope',checks:'Checks',passed:'Passed',restoreTested:'Restore tested',diagnostics:'Diagnostics',failure:'Failure point',lastStage:'Last stage',errorType:'Error type',remoteReported:'Reported by server',at:'Recorded at'};
const HIDDEN_JOB_FIELDS=new Set(['id','siteId','site_id','type','status','stage','error','details','createdAt','created_at','startedAt','started_at','finishedAt','finished_at']);

export function duration(seconds){if(!Number.isFinite(seconds)||seconds<0)return '—';const s=Math.round(seconds),h=Math.floor(s/3600),m=Math.floor(s%3600/60),r=s%60;return h?`${h} h ${m} min`:m?`${m} min ${r} s`:`${r} s`;}
export function byteSize(value){let n=Number(value);if(!Number.isFinite(n))return '—';const units=['B','KB','MB','GB','TB'];let i=0;while(n>=1024&&i<units.length-1){n/=1024;i++;}return (i>1?n.toFixed(1):Math.round(n))+' '+units[i];}
const shortDuration=ms=>ms==null?'':ms<1000?`${ms} ms`:ms<60000?`${(ms/1000).toFixed(1)} s`:`${Math.floor(ms/60000)} min ${Math.round(ms%60000/1000)} s`;
const clock=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?'':d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});};
const dateTime=(value,timeStyle='short')=>{const d=new Date(value);return value&&!Number.isNaN(d.getTime())?d.toLocaleString([],{dateStyle:'medium',timeStyle}):'—';};
const sentence=key=>String(key).replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/_/g,' ').replace(/^./,c=>c.toUpperCase()).replace(/ ([A-Z])(?=[a-z])/g,(_m,c)=>' '+c.toLowerCase()).replace(/\bId\b/g,'ID');
const labelFor=(key,inArray)=>inArray?`Item ${Number(key)+1}`:FIELD_LABELS[key]||sentence(key);
const isPrimitiveList=value=>Array.isArray(value)&&value.every(item=>item==null||typeof item!=='object');

function useTick(ms){const [,set]=useState(0);useEffect(()=>{const id=setInterval(()=>set(v=>v+1),ms);return()=>clearInterval(id);},[ms]);}
function Elapsed({from}){useTick(1000);return duration((Date.now()-Date.parse(from))/1000);}

export function explainError(error){
 if(/Backup plan changed; review configuration before capture/i.test(error||''))return {meaning:'The capture plan no longer matched the plan checked before capture.',next:'Review the site configuration and current Docker mounts, then run readiness checks before retrying.'};
 if(/Redis current graceful-shutdown proof is missing/i.test(error||''))return {meaning:'The helper could not confirm a graceful Redis shutdown for this attempt.',next:'Review Redis shutdown logs and logging configuration before retrying. A previous shutdown log is not proof for this run.'};
 if(/Online SQLite integrity check exceeded/i.test(error||''))return {meaning:'The database health check took longer than this site allows.',next:'Raise sqliteIntegrityCheck time (sqliteOnlineCheckTimeout) or switch the site to sqliteIntegrityCheck "off".'};
 return {meaning:'The worker reported this error for the attempt.',next:'Review the recorded details and relevant server logs before retrying.'};
}

// Translate raw helper diagnostics into plain-language phases.
const PHASES={prep:['Preparing the backup',"Reads container settings, checks tools and free space. 'Not installed' answers are normal."],finalCheck:['Final check before pausing','Re-reads settings right before the site is paused to make sure nothing changed.'],health:['Database health check','Reads the whole database to confirm it is not damaged.'],same:['Confirming database unchanged','Proves the database is identical to the last checked copy.'],stop:['Pausing the site','Stops the containers so files stop changing. Visitors see the maintenance page.'],verify:['Confirming a clean stop','Checks every container shut down cleanly.'],commit:['Snapshotting containers',"Saves each container's current state."],save:['Saving container images','Packs the program files of each container.'],pack:['Packaging files','Bundles data folders and config files into the backup.'],send:['Sending backup to storage','Uploads the finished backup package.'],start:['Restarting the site','Brings the containers back online.'],fail:['Backup stopped with an error','See the failure point above.']};
const PROBES=['docker inspect','docker ps','docker exec','docker image','docker info','du'];
function phaseOf(command,paused){
 if(command==='Helper stopped')return 'fail';if(command==='sqlite integrity_check')return 'health';if(command==='sqlite unchanged-file check')return 'same';
 return {'docker stop':'stop','docker start':'start','docker commit':'commit','docker save':'save',tar:'pack',cat:'send'}[command]||(PROBES.includes(command)?(paused?'verify':'prep'):'other');
}
function stepsFrom(items){
 const steps=[],open=new Map();
 for(const event of items){
  if(!event||typeof event!=='object')continue;const command=event.command||'helper';
  if(event.phase==='start'||event.phase==='artifact-start'){open.set(command,event);continue;}
  if(event.phase==='finish'||event.phase==='artifact-finish'){const started=open.get(command);open.delete(command);steps.push({start:started?.at,at:event.at,command,ms:event.elapsedMs,outcome:event.outcome,code:event.exitCode,limit:event.timeoutSeconds});}
  else if(event.phase==='helper-failure')steps.push({start:event.at,at:event.at,command:'Helper stopped',outcome:'failure',type:event.exceptionType});
 }
 for(const event of open.values())steps.push({start:event.at,at:event.at,command:event.command||'helper',outcome:'running'});
 return steps.sort((a,b)=>Date.parse(a.start||a.at)-Date.parse(b.start||b.at));
}
const failed=step=>step.outcome==='timeout'||step.outcome==='failure';
const normal=step=>step.outcome==='ok'||(step.command==='docker exec'&&step.outcome==='exit'&&step.code===127);
function groupSteps(steps){
 const rows=[];let paused=false,previousEnd=null;
 for(const step of steps){
  const begin=Date.parse(step.start||step.at),end=Date.parse(step.at);
  // Long silent gaps are real work the helper does not log line by line.
  if(previousEnd&&begin-previousEnd>30000)rows.push({gap:true,start:new Date(previousEnd).toISOString(),ms:begin-previousEnd,paused,label:paused?'Checking files while the site is paused':'Preparing',detail:paused?'Fingerprinting and checking the stopped data. No separate log lines.':'Working between logged steps.'});
  if(step.command==='docker stop'&&step.outcome==='ok')paused=true;
  if(step.command==='docker start'&&step.outcome==='ok')paused=false;
  let key=phaseOf(step.command,paused);if(key==='prep'&&rows.some(r=>r.key==='prep')&&rows.at(-1)?.key!=='prep')key='finalCheck';
  const [label,detail]=PHASES[key]||[step.command,''];
  const status=failed(step)?'bad':step.outcome==='running'?'running':normal(step)?'ok':'note';
  const last=rows.at(-1),rank={ok:0,note:1,running:2,bad:3};
  if(last&&!last.gap&&last.key===key&&last.paused===paused){last.ms=(last.ms||0)+(step.ms||0);if(rank[status]>rank[last.status]){last.status=status;last.step=step;}}
  else rows.push({key,label,detail,status,paused,ms:step.ms,start:step.start||step.at,step});
  previousEnd=Math.max(previousEnd||0,end);
 }
 return rows;
}
function failureText(step){return step.outcome==='timeout'?'Timed out'+(step.limit?` after ${step.limit} s`:''):step.type||'Failed';}

export function pausedWindow(items,downtimeSeconds){
 if(Number.isFinite(downtimeSeconds))return {ms:downtimeSeconds*1000};if(!Array.isArray(items))return null;
 let stop=null,start=null;for(const event of items){if(event?.outcome!=='ok')continue;if(event.command==='docker stop'&&stop==null)stop=Date.parse(event.at);if(event.command==='docker start'&&stop!=null)start=Date.parse(event.at);}
 return stop==null?null:start!=null&&start>stop?{ms:start-stop}:{from:stop};
}
function PausedFor({window}){useTick(window.from!=null?1000:60000);return duration((window.from!=null?Date.now()-window.from:window.ms)/1000);}

export function StepTimeline({items}){
 const [technical,setTechnical]=useState(false);const steps=stepsFrom(items);
 if(!steps.length)return <span className="dn-muted">No diagnostic steps recorded.</span>;
 const rows=groupSteps(steps);
 return <div className="dn-tl">
  {rows.some(r=>r.paused)&&!technical&&<p className="dn-tl-legend"><span aria-hidden="true"/>Site paused</p>}
  {technical?<ol className="dn-tl-raw">{steps.map((step,i)=><li key={i}><time>{clock(step.start||step.at)}</time><span className="dn-cmd">{step.command}</span><span>{shortDuration(step.ms)}</span><span className={step.outcome==='ok'?'':'dn-muted'}>{step.outcome==='exit'?'exit '+step.code:String(step.outcome||'')}</span></li>)}</ol>
  :<ol className="dn-tl-list">{rows.map((row,i)=><li key={i} title={row.detail||undefined} className={`dn-tl-item${row.paused?' is-paused':''} is-${row.gap?'gap':row.status}`}><span className="dn-tl-dot" aria-hidden="true"/><span className="dn-tl-name">{row.label}{row.status==='bad'&&<small>{failureText(row.step)}</small>}</span><time className="dn-tl-time">{clock(row.start)}</time><span className="dn-tl-dur">{row.status==='running'?'…':shortDuration(row.ms)}</span></li>)}</ol>}
  <button type="button" className="dn-link-button" aria-expanded={technical} onClick={()=>setTechnical(!technical)}>{technical?'Hide technical log':'Show technical log'}</button>
 </div>;
}

export function TransferProgress({job}){
 useTick(1000);const running=job.status==='running';const transfer=job.details&&typeof job.details==='object'?job.details.transfer:null;
 if(!transfer||!Number.isFinite(transfer.done))return running&&job.stage==='transferring'?<p className="dn-muted">Transfer started. Live progress appears for backups started with this version.</p>:null;
 const total=Number.isFinite(transfer.total)&&transfer.total>0?transfer.total:null,done=Math.min(transfer.done,total||transfer.done),percent=total?Math.min(100,done/total*100):null;
 const spent=(Date.parse(transfer.updatedAt)-Date.parse(transfer.startedAt))/1000,rate=spent>0?done/spent:0,left=total&&rate>0?(total-done)/rate:null;
 const finished=!running||(total&&done>=total),finishAt=left!=null?new Date(Date.parse(transfer.updatedAt)+left*1000):null;
 return <div className="dn-xfer">
  <div className="dn-xfer-head"><b>{finished?'Transfer complete':'Sending backup to storage'}</b><span>{percent!=null?percent.toFixed(1)+'%':byteSize(done)+' sent'}</span></div>
  <div className={'dn-bar'+(percent==null?' dn-bar-unknown':'')} role="progressbar" aria-label="Transfer progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent==null?undefined:Math.round(percent)}><div style={{width:(percent==null?100:percent)+'%'}}/></div>
  <dl className="dn-xfer-stats">
   <div><dt>Sent</dt><dd>{byteSize(done)}{total?' of '+byteSize(total):''}</dd></div>
   <div><dt>Average speed</dt><dd>{rate>0?byteSize(rate)+'/s':'—'}</dd></div>
   <div><dt>{finished?'Took':'Time left'}</dt><dd>{finished?duration(spent):left!=null?'~'+duration(left):'Calculating…'}</dd></div>
   {!finished&&finishAt&&<div><dt>Expected finish</dt><dd>{finishAt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</dd></div>}
  </dl>
 </div>;
}

function FailurePoint({failure}){
 const stage=String(failure.lastStage||'').replace(/[_-]+/g,' ').replace(/^./,c=>c.toUpperCase());
 return <div className="dn-fail"><p className="dn-fail-main">Stopped during <b>{stage||'an unknown stage'}</b>{failure.errorType&&<span> · {failure.errorType}</span>}</p><p className="dn-fail-meta">{failure.remoteReported?'Reported by the source server':'Detected by DockNest'}{failure.at&&<span> · <time dateTime={failure.at}>{dateTime(failure.at,'medium')}</time></span>}{failure.cause?.message&&<span> · {failure.cause.code?failure.cause.code+': ':''}{failure.cause.message}</span>}</p></div>;
}

function ReadableValue({value,field}){
 if(value==null||value==='')return <span className="dn-muted">—</span>;
 if(typeof value==='boolean')return value?'Yes':'No';
 if(typeof value==='number')return field==='downtimeSeconds'?duration(value):/bytes|size$/i.test(field||'')?byteSize(value):value.toLocaleString();
 if(typeof value==='string'){
  if(field==='status')return value.replace(/[-_]+/g,' ').replace(/^./,c=>c.toUpperCase());
  if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)&&!Number.isNaN(new Date(value).getTime()))return dateTime(value,'medium');
  return /^[0-9a-f-]{20,}$/i.test(value)||/^(sftp:|s3:|\/)/.test(value)?<code>{value}</code>:value;
 }
 return String(value);
}

// Readable key/value rows for any recorded object; snake_case twins of camelCase keys are hidden.
export function ReadableFields({value,depth=0}){
 const inArray=Array.isArray(value);
 const entries=Object.entries(value).filter(([key])=>inArray||!(key.includes('_')&&key.replace(/_([a-z])/g,(_m,c)=>c.toUpperCase()) in value));
 if(!entries.length)return <span className="dn-muted">{inArray?'None':'Nothing recorded'}</span>;
 if(isPrimitiveList(value))return <span>{value.map(item=>item==null?'—':String(item)).join(', ')}</span>;
 return <dl className={'dn-rec'+(depth?' dn-rec-nested':'')}>{entries.map(([key,item])=>{
  // A check object that only carries a status reads best as one row.
  if(item&&typeof item==='object'&&!Array.isArray(item)&&typeof item.status==='string'&&Object.keys(item).every(k=>['status','method','checkedAt','checked_at','jobId','job_id'].includes(k)))return <div className="dn-rec-row" key={key} title={item.method||undefined}><dt>{labelFor(key,inArray)}</dt><dd><ReadableValue value={item.status} field="status"/></dd></div>;
  if(item&&typeof item==='object'&&!isPrimitiveList(item))return <div className="dn-rec-group" key={key}><dt>{labelFor(key,inArray)}</dt><dd>{depth>4?<code>{JSON.stringify(item)}</code>:<ReadableFields value={item} depth={depth+1}/>}</dd></div>;
  return <div className="dn-rec-row" key={key}><dt>{labelFor(key,inArray)}</dt><dd>{Array.isArray(item)?<ReadableFields value={item} depth={depth+1}/>:<ReadableValue value={item} field={key}/>}</dd></div>;
 })}</dl>;
}

function JsonActions({json,showing,onToggle}){
 const [message,setMessage]=useState('');
 async function copy(){try{await navigator.clipboard.writeText(json);setMessage('Copied.');}catch{setMessage('Could not copy.');}}
 return <div className="dn-actions">{message&&<span className="dn-muted" role="status">{message}</span>}{showing&&<button type="button" onClick={copy}>Copy</button>}<button type="button" onClick={onToggle}>{showing?'Back to summary':'View JSON'}</button></div>;
}

export function ReadableRecord({value,title}){
 const [json,setJson]=useState(false);
 if(value==null||typeof value!=='object')return <span className={value?'':'dn-muted'}>{value||'No additional details'}</span>;
 const text=JSON.stringify(value,null,2);
 return <div className="dn-record"><div className="dn-record-head">{title?<h4>{title}</h4>:<span/>}<JsonActions json={text} showing={json} onToggle={()=>setJson(!json)}/></div>{json?<pre className="dn-json" tabIndex={0}>{text}</pre>:<ReadableFields value={value}/>}</div>;
}

function Facts({items}){return <dl className="dn-facts">{items.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;}

export function BackupDetails({backup,siteName}){
 const [json,setJson]=useState(false);const manifest=backup.manifest&&typeof backup.manifest==='object'?backup.manifest:{};
 const containers=Array.isArray(manifest.containers)?manifest.containers:[],captured=backup.capturedAt||backup.captured_at,verified=!!backup.verified,text=JSON.stringify(backup,null,2);
 const row=(label,value)=><div className="dn-rec-row" key={label}><dt>{label}</dt><dd>{value}</dd></div>;
 return <div className="dn-jd dn-bk">
  <section className={'dn-hero '+(verified?'is-ok':'is-run')}><div className="dn-hero-text"><div className="dn-hero-title"><h3>Recovery point</h3><span className="dn-chip">{verified?'Verified':'Not verified'}</span></div><p>{siteName||backup.siteId||''}</p></div><JsonActions json={text} showing={json} onToggle={()=>setJson(!json)}/></section>
  {json?<pre className="dn-json" tabIndex={0}>{text}</pre>:<div className="dn-jd-body">
   <Facts items={[['Captured',dateTime(captured)],['Size',byteSize(backup.size)],['Site paused',manifest.downtimeSeconds!=null?duration(manifest.downtimeSeconds):manifest.kind==='static'?'Not paused':'—'],['Delivery',manifest.kind==='static'?'Static files':manifest.deliveryMode==='direct'?'Direct stream':'Staged copy']]}/>
   {containers.length>0&&<section className="dn-card"><h4>Contents</h4><dl className="dn-rec">{containers.map((c,i)=>row(String(c.name||`Container ${i+1}`).replace(/^\//,''),<span><code>{c.image||'—'}</code>{c.mounts?.length>0&&<span className="dn-muted"> · {c.mounts.length} {c.mounts.length>1?'folders':'folder'}</span>}</span>))}</dl></section>}
   {backup.verification&&typeof backup.verification==='object'&&Object.keys(backup.verification).length>0&&<section className="dn-card"><h4>Checks</h4><ReadableFields value={backup.verification}/></section>}
   <section className="dn-card"><h4>Storage &amp; IDs</h4><dl className="dn-rec">{row('Checksum (SHA-256)',backup.checksum?<code>{backup.checksum}</code>:'—')}{row('Backup ID',<code>{backup.id}</code>)}{row('Job ID',backup.jobId||backup.job_id?<code>{backup.jobId||backup.job_id}</code>:'—')}{row('Pinned',backup.pinned?'Yes':'No')}</dl></section>
  </div>}
 </div>;
}

export function JobDetails({job,siteName,onRefresh}){
 const [view,setView]=useState('readable'),[refreshing,setRefreshing]=useState(false),[feedback,setFeedback]=useState(''),[failure,setFailure]=useState('');
 const times={createdAt:job.createdAt??job.created_at,startedAt:job.startedAt??job.started_at,finishedAt:job.finishedAt??job.finished_at},siteId=job.siteId??job.site_id;
 const bad=['failed','recovery_required'].includes(job.status),done=job.status==='completed',running=['running','queued'].includes(job.status);
 const details=job.details&&typeof job.details==='object'&&!Array.isArray(job.details)?job.details:{};
 const result=Object.fromEntries(Object.entries(details).filter(([key])=>!['diagnostics','failure','transfer'].includes(key)));
 const other=Object.fromEntries(Object.entries(job).filter(([key])=>!HIDDEN_JOB_FIELDS.has(key)));
 const explanation=explainError(job.error),paused=pausedWindow(details.diagnostics,details.downtimeSeconds),json=JSON.stringify(job,null,2);
 // Keep the latest refresh callback without restarting the 5 s timer on every parent render.
 const refreshRef=useRef(onRefresh);refreshRef.current=onRefresh;
 useEffect(()=>{if(!running)return;const id=setInterval(()=>{const f=refreshRef.current;f&&Promise.resolve(f()).catch(()=>{});},5000);return()=>clearInterval(id);},[running]);
 async function refresh(){setRefreshing(true);setFailure('');setFeedback('');try{await onRefresh();setFeedback('Refreshed.');}catch(e){setFailure(e.message||'Could not refresh this job. Try again.');}finally{setRefreshing(false);}}
 async function copy(){try{await navigator.clipboard.writeText(json);setFeedback('JSON copied.');}catch{setFeedback('Could not copy. Select the JSON text and copy it manually.');}}
 const type=job.type==='scrub'?'Integrity check':sentence(job.type||'Job');
 const status=sentence(job.status||'Unknown').replace(/ required$/,' required');
 return <div className="job-details dn-jd">
  {failure&&<p className="job-refresh-error" role="alert">{failure}</p>}{feedback&&<div className="job-feedback" role="status">{feedback}</div>}
  <section className={'dn-hero '+(bad?'is-bad':done?'is-ok':'is-run')} aria-label="Job outcome"><div className="dn-hero-text"><div className="dn-hero-title"><h3>{type}</h3><span className="dn-chip">{status}</span></div><p>{siteName||siteId||'Site not recorded'}</p></div>
   <div className="dn-actions"><button type="button" onClick={refresh} disabled={refreshing} aria-busy={refreshing}>{refreshing?'Refreshing…':'Refresh'}</button>{view==='json'&&<button type="button" onClick={copy}>Copy</button>}<button type="button" onClick={()=>setView(view==='json'?'readable':'json')}>{view==='json'?'Back to summary':'View JSON'}</button></div></section>
  {view==='json'?<pre className="dn-json" tabIndex={0} aria-label="Original job JSON">{json}</pre>:<div className="dn-jd-body">
   <Facts items={[['Started',dateTime(times.startedAt||times.createdAt)],['Duration',running&&times.startedAt?<Elapsed from={times.startedAt}/>:times.startedAt&&times.finishedAt?duration((Date.parse(times.finishedAt)-Date.parse(times.startedAt))/1000):'—'],['Site paused',paused?<PausedFor window={paused}/>:'Not paused'],['Stage',sentence(job.stage||'—')]]}/>
   {job.error&&<section className="dn-card dn-err"><h4>What happened</h4><p>{explanation.meaning}</p><p className="dn-err-msg">{job.error}</p>{details.failure&&typeof details.failure==='object'&&'lastStage' in details.failure&&<FailurePoint failure={details.failure}/>}<p className="dn-next"><b>Next step</b>{explanation.next}</p></section>}
   <TransferProgress job={job}/>
   {Array.isArray(details.diagnostics)&&details.diagnostics.length>0&&<section className="dn-card"><h4>Steps</h4><StepTimeline items={details.diagnostics}/></section>}
   {Object.keys(result).length>0&&<section className="dn-card"><h4>Result</h4><ReadableFields value={result}/></section>}
   {Object.keys(other).length>0&&<section className="dn-card"><h4>Other fields</h4><ReadableFields value={other}/></section>}
   <details className="dn-refs"><summary>Reference IDs &amp; times</summary><dl className="dn-refs-list">{[['Job ID',<code>{job.id}</code>],['Site ID',<code>{siteId||'—'}</code>],['Queued',dateTime(times.createdAt)],['Started',dateTime(times.startedAt)],['Finished',dateTime(times.finishedAt)]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>
  </div>}
 </div>;
}
