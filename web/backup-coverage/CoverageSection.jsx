import React,{useState} from 'react';
import {IconRefresh} from '@tabler/icons-react';
import {AlertPanel,StatusLabel} from '../system.jsx';
import {sortItems,summarize,addTargets} from './model.js';
import {CoverageRows} from './CoverageRows.jsx';
import {SkipDialog} from './SkipDialog.jsx';
import './backup-coverage.css';

// Counts as one plain line. Zero counts are left out except "not backed up", which is the number that matters.
function Summary({sum}){
 const parts=[[sum.notBackedUp,'not backed up',true],[sum.pending,'waiting for a first backup'],[sum.skipped,'skipped'],[sum.backedUp,'backed up']].filter(([n,,always])=>n||always);
 return <p className="bc-summary" role="status">{parts.map(([n,label],index)=><React.Fragment key={label}>{index>0&&', '}<b>{n}</b> {label}</React.Fragment>)}.{!sum.partial&&!sum.notBackedUp&&!sum.pending&&sum.total>0&&' Everything here is covered by an app or skipped on purpose.'}</p>;
}

const ScanAgain=({label='Scan again',onScan})=><button type="button" className="bc-link" onClick={onScan}><IconRefresh size={18} stroke={1.75} aria-hidden="true"/>{label}</button>;

// One server's coverage: loading, error with retry, empty, partial and the list. Reads only through entry/onScan, so the Apps
// page and the Map share it. Skip and Unskip change the list in place and never start a scan.
export function CoverageSection({api,serverId,serverName,entry,onScan,patch,onAddApp,onOpenApp,onSessionExpired}){
 const [skip,setSkip]=useState(null),[busy,setBusy]=useState(false),[fail,setFail]=useState('');
 const path='/servers/'+encodeURIComponent(serverId)+'/coverage/ignores';
 async function change(item,note,remove){
  setBusy(true);setFail('');
  try{
   if(remove)await api(path+'/'+item.kind+'/'+encodeURIComponent(item.name),null,'DELETE');
   else await api(path,{kind:item.kind,name:item.name,...(note?{note}:{})},'PUT');
   patch(serverId,item,remove?{status:'not-backed-up',note:undefined}:{status:'skipped',note:note||undefined});setSkip(null);
  }catch(error){if(error.status===401)onSessionExpired?.();else setFail(error.message)}finally{setBusy(false)}
 }
 if(!entry||entry.status==='loading')return <div className="bc-state" role="status"><StatusLabel state="running">Scanning {serverName}…</StatusLabel><span className="t-caption">Reading Docker containers and volumes.</span></div>;
 if(entry.status==='error')return <AlertPanel variant="error" title="Could not scan this server" action={<ScanAgain label="Try again" onScan={onScan}/>}>{entry.error}</AlertPanel>;
 const sum=summarize(entry.data),items=sortItems(entry.data.items);
 return <div className="bc-section">
  {sum.partial&&<AlertPanel variant="warning" title="The scan was incomplete">{sum.problems.length?sum.problems.map(problem=><span className="bc-problem" key={problem}>{problem}</span>):'Some containers or volumes could not be read.'}</AlertPanel>}
  {items.length>0?<>
   <div className="bc-bar"><Summary sum={sum}/><ScanAgain onScan={onScan}/></div>
   {fail&&!skip&&<AlertPanel variant="error" title="The change was not saved">{fail}</AlertPanel>}
   <CoverageRows items={items} resetKey={serverId} onAdd={item=>onAddApp(serverId,addTargets(item))} onOpen={item=>onOpenApp(item.app.id)} onSkip={item=>{setFail('');setSkip(item)}} onUnskip={item=>change(item,'',true)}/>
  </>:<div className="bc-state"><b>{sum.partial?'Nothing was found':'No containers or volumes'}</b><span className="t-caption">{sum.partial?'The scan was incomplete, so this may not be everything on '+serverName+'.':serverName+' has no Docker containers, so there is nothing to back up yet.'}</span><ScanAgain onScan={onScan}/></div>}
  {skip&&<SkipDialog item={skip} busy={busy} error={fail} onClose={()=>{setSkip(null);setFail('')}} onConfirm={note=>change(skip,note,false)}/>}
 </div>;
}
