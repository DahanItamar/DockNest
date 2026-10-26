import {isIntegrityChecked} from './verification-core.js';
export function bucketActivity({backups=[],jobs=[]},period='week',now=new Date()){
 const monthly=period==='year',count=monthly?12:period==='month'?30:7;
 const start=new Date(now);start.setHours(0,0,0,0);if(monthly){start.setDate(1);start.setMonth(start.getMonth()-11)}else start.setDate(start.getDate()-count+1);
 const dates=Array.from({length:count},(_,i)=>{const d=new Date(start);monthly?d.setMonth(d.getMonth()+i):d.setDate(d.getDate()+i);return d});
 const buckets=dates.map((date,i)=>({start:date,end:i<count-1?dates[i+1]:new Date(now.getTime()+1),label:date.toLocaleDateString('en-GB',monthly?{month:'short',year:'2-digit'}:{month:'short',day:'numeric'})}));
 const series=[{label:'Integrity-checked points',color:'#9E7EB5',values:Array(count).fill(0)},{label:'Integrity not checked',color:'#4E7FC4',values:Array(count).fill(0)},{label:'Completed restores',color:'#5E35B1',values:Array(count).fill(0)},{label:'Failed jobs',color:'#7A7585',values:Array(count).fill(0)}];
 function place(row,index){const time=new Date(row.capturedAt||row.createdAt||row.startedAt);const i=buckets.findIndex(b=>time>=b.start&&time<b.end);if(i>=0)series[index].values[i]++}
 backups.forEach(row=>place(row,isIntegrityChecked(row)?0:1));jobs.forEach(row=>{if(/failed|recovery_required/.test(row.status))place(row,3);else if(row.type==='restore'&&/complete|success/.test(row.status))place(row,2)});
 return {labels:buckets.map(b=>b.label),series};
}
