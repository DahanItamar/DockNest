import React from 'react';
import {IconClock} from '@tabler/icons-react';
import {CheckCircle2,CircleX,InfoCircle} from '../icons.jsx';
import {RecoveryBar,MayBeLow,RecoveryLine} from './parts.jsx';
import {aboutTime,clock,RESULT_TEXT,shortDay} from './model.js';

const RESULT_ICON={passed:[CheckCircle2,'success'],failed:[CircleX,'failed']};
// Top of the Restore tests dialog: how long a restore took in the newest passed test, split in three phases, then the
// recent tests with their times. `card` is the API card ({last, items}); with no passed test it says how to get a number.
export function RecoveryCard({card}){
 const recovery=card?.last?.recovery,items=(card?.items||[]).slice(0,5);
 const time=recovery&&aboutTime(recovery.seconds);
 return <section className="rec-card" aria-labelledby="rec-title">
  <h3 id="rec-title" className="t-section">Recovery time</h3>
  {time?<>
   <p className="rec-headline"><IconClock size={22} stroke={1.75} aria-hidden="true"/>Back in {time}</p>
   <p className="t-caption rec-from">From the test that passed on {shortDay(recovery.provenAt)} at {clock(recovery.provenAt)}</p>
   <RecoveryBar phases={recovery.phases}/>
   {recovery.mayBeLow&&<MayBeLow/>}
  </>:<p className="t-caption">Not measured yet. A passed test measures how long a restore takes.</p>}
  {recovery?.stale&&<p className="t-caption rec-stale"><InfoCircle size={16} stroke={1.75} aria-hidden="true"/> This test is not recent. Run a test for a fresh number.</p>}
  {items.length>0&&<>
   <h3 className="t-section rec-recent-title">Recent tests</h3>
   <table className="rec-recent"><thead><tr><th scope="col">Test</th><th scope="col">Result</th><th scope="col">Recovery time</th></tr></thead>
    <tbody>{items.map(item=>{const [Icon,tone]=RESULT_ICON[item.result]||[InfoCircle,'queued'],label=RESULT_TEXT[item.result]||'Not finished',value=aboutTime(item.recoverySeconds);
     return <tr key={item.id}><td>{shortDay(item.finishedAt)||'—'}</td><td><span className={'status status-'+tone}><Icon className="status-icon" size={16} stroke={2} aria-hidden="true"/>{label}</span></td><td>{value?value.charAt(0).toUpperCase()+value.slice(1):'No time'}</td></tr>})}</tbody></table>
  </>}
  {time&&card?.last?.serverName&&<p className="t-caption">Measured on {card.last.serverName}. A different server or a slower link to storage changes it.</p>}
 </section>;
}
