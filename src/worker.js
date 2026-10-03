import { db } from './db.js';
import { config } from './config.js';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { claimJob, executeJob, tickScheduler,verifyEncrypted } from './engine.js';
import { reconcileArtifacts } from './artifact-journal.js';
import { tickSelfBackup,claimSelfBackup,executeSelfBackup,recoverInterruptedSelfBackups,pruneSelfBackups } from './self-backup.js';
if(config.storage.mode==='local')await mkdir(config.backupDir,{recursive:true,mode:0o700});
// Single worker per storage directory. Lock is deliberately retained after an unclean death.
const lock=join(config.dataDir,'worker.lock');
let handle;try{handle=await open(lock,'wx',0o600);await handle.writeFile(String(process.pid));}catch{console.error('Worker lock exists. Verify old worker is stopped and inspect remote recovery before removing worker.lock.');process.exit(1);}
db.prepare("UPDATE jobs SET status='recovery_required',stage='recovery_required',error='Worker interrupted. Inspect remote recovery.json and health before clearing recovery.',finished_at=? WHERE status='running'").run(new Date().toISOString());
let stopping=false;
await recoverInterruptedSelfBackups();
function heartbeat(running=true){db.prepare("INSERT INTO settings VALUES ('worker_heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({running,lastSeen:new Date().toISOString()}));}
heartbeat();
const heartbeatTimer=setInterval(()=>heartbeat(),15000);
for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>{stopping=true;});
try{
 let reconcileAt=0;
 while(!stopping){if(Date.now()>=reconcileAt){const reconciliation=await reconcileArtifacts(verifyEncrypted,{checkCompleted:true});db.prepare("INSERT INTO settings VALUES('artifact_reconciliation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({...reconciliation,checkedAt:new Date().toISOString()}));try{await pruneSelfBackups();}catch{/* Optional kit cleanup does not stop site jobs. */}reconcileAt=Date.now()+300000;}tickScheduler();tickSelfBackup();const managerJob=claimSelfBackup();if(managerJob)await executeSelfBackup(managerJob);else{const job=claimJob();if(job)await executeJob(job);else await new Promise(r=>setTimeout(r,3000));}}
}finally{clearInterval(heartbeatTimer);heartbeat(false);await handle.close();await unlink(lock);}
