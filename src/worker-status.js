// Read-only worker status: lease holder/age, heartbeat and recovery_required jobs. Opens SQLite read-only and avoids
// db.js/config.js so it never migrates, creates directories or writes. Prints no credentials or configuration.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
try{process.loadEnvFile();}catch(error){if(error.code!=='ENOENT')throw error;}
const file=path.join(path.resolve(process.env.DATA_DIR||'data'),'state.sqlite');
if(!existsSync(file)){console.error(`No state database at ${file}. Set DATA_DIR.`);process.exit(1);}
const db=new DatabaseSync(file,{readOnly:true}),now=Date.now();
const age=at=>{if(at==null)return 'unknown';const s=Math.round((now-(typeof at==='number'?at:Date.parse(at)))/1000);return Number.isFinite(s)?(s<0?`in ${-s}s`:`${s}s ago`):'unknown';};
const one=line=>String(line??'').replace(/\s+/g,' ').trim().slice(0,300);
const table=name=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
try{
 const lease=table('worker_lease')?db.prepare("SELECT holder,acquired_at,renewed_at,expires_at FROM worker_lease WHERE name='worker'").get():null;
 if(!lease)console.log('Lease: free (no worker holds it)');
 else console.log(`Lease: ${lease.expires_at>now?'held':'EXPIRED (next worker may take over)'} by ${lease.holder}; acquired ${lease.acquired_at} (${age(lease.acquired_at)}); renewed ${age(lease.renewed_at)}; expires ${age(lease.expires_at)}`);
 let beat=null;try{beat=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='worker_heartbeat'").get()?.value||'null');}catch{/* Unreadable heartbeat is reported as missing. */}
 console.log(beat?`Heartbeat: ${beat.running?'running':'stopped'}; last seen ${beat.lastSeen} (${age(beat.lastSeen)})`:'Heartbeat: none recorded');
 const jobs=db.prepare("SELECT j.id,j.type,j.started_at,j.finished_at,j.error,s.name site FROM jobs j LEFT JOIN sites s ON s.id=j.site_id WHERE j.status='recovery_required' ORDER BY j.created_at").all();
 console.log(`Recovery required jobs: ${jobs.length}`);
 for(const job of jobs)console.log(`- ${job.id} ${job.type} site=${one(job.site)||'?'} started=${job.started_at||'?'} interrupted=${job.finished_at||'?'} error=${one(job.error)||'none'}`);
 const restores=db.prepare("SELECT COUNT(*) n FROM restores WHERE status='recovery_required'").get().n;
 if(restores)console.log(`Recovery required restores: ${restores}`);
}finally{db.close();}
