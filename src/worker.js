import { db } from './db.js';
import { config } from './config.js';
import { mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { claimJob, executeJob, tickScheduler,verifyEncrypted,finishReconciledBackup } from './engine.js';
import { reconcileArtifacts } from './artifact-journal.js';
import { tickSelfBackup,claimSelfBackup,executeSelfBackup,recoverInterruptedSelfBackups,pruneSelfBackups } from './self-backup.js';
import { acquireLease,renewLease,releaseLease,LEASE_TTL_MS } from './worker-lease.js';
import { runWorkerLoop } from './worker-loop.js';
import { tickUpdateCheck } from './updates/check.js';
import { tickMoves } from './moves/engine.js';
import { tickRestoreTests, recoverInterruptedRestoreTests } from './restore-tests/engine.js';
import { claimInstall, executeInstall, failInterruptedInstalls } from './installs.js';
import { tickAlerts, tickReachability } from './alerts/detect.js';
if(config.storage.mode==='local')await mkdir(config.backupDir,{recursive:true,mode:0o700});
// Single worker per state database, enforced by an expiring SQLite lease (src/worker-lease.js) rather than a PID file,
// so a SIGKILLed worker cannot crash-loop its replacement. A legacy worker.lock is only reported: exclusion lives in the
// lease, interrupted jobs are still marked recovery_required below, and claimJob refuses any server with
// running/recovery_required work, so ignoring the file cannot resume interrupted source work.
try{await access(join(config.dataDir,'worker.lock'));console.warn('Ignoring legacy worker.lock: single-worker exclusion now uses the SQLite worker lease. Delete it once no pre-lease worker or migration runs.');}catch{/* No legacy lock. */}
const holder=randomUUID();
let lease,waiting=false;
while(!(lease=acquireLease(db,holder)).acquired){if(!waiting){console.log(`Worker lease held by another process until ${new Date(lease.lease.expires_at).toISOString()}; waiting.`);waiting=true;}await new Promise(r=>setTimeout(r,5000));}
if(lease.takeover)console.warn(`Took over expired worker lease (last renewed ${lease.previous.renewed_at}); interrupted jobs become recovery_required.`);
// A site-move job only drives one journaled step; its move resumes from the journal (src/moves/engine.js).
db.prepare("UPDATE jobs SET status='failed',stage='failed',error='Worker interrupted; the move resumes from its journal.',finished_at=? WHERE status='move_running'").run(new Date().toISOString());
// A restore-test job drives one journalled step; an interrupted step ends its test and clean-up runs next.
recoverInterruptedRestoreTests();
// An install was a single helper call; it is not resumed. The person is told and can try again.
failInterruptedInstalls();
// Any job still 'running' belonged to a worker that no longer holds the lease.
db.prepare("UPDATE jobs SET status='recovery_required',stage='recovery_required',error='Worker interrupted. Inspect remote recovery.json and health before clearing recovery.',finished_at=? WHERE status='running'").run(new Date().toISOString());
let stopping=false,lost=false;
await recoverInterruptedSelfBackups();
function heartbeat(running=true){db.prepare("INSERT INTO settings VALUES ('worker_heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({running,lastSeen:new Date().toISOString()}));}
// Renewal fails only when the lease expired and another worker took it over: stop claiming at once.
function renew(){if(lost)return false;if(renewLease(db,holder))return true;lost=stopping=true;console.error('Worker lease lost to another process; no further jobs will be claimed.');return false;}
heartbeat();
const heartbeatTimer=setInterval(()=>{if(renew())heartbeat();},LEASE_TTL_MS/4);
// Drain: the first signal stops claiming and lets the current job finish, then the lease is released and the worker
// exits 0. A second signal exits at once and leaves the lease to expire; the next worker marks the job recovery_required.
let signals=0;
for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>{if(++signals>1){console.error(`${event} received again; exiting without draining. The lease expires in ${LEASE_TTL_MS/1000}s and interrupted jobs become recovery_required on next start.`);process.exit(1);}stopping=true;console.log(`${event} received; draining: no new jobs will be claimed, waiting for the current job to finish.`);});
try{
 let reconcileAt=0;
 const maintain=async()=>{if(Date.now()<reconcileAt)return;const reconciliation=await reconcileArtifacts(verifyEncrypted,{checkCompleted:true,onJobCompleted:finishReconciledBackup});db.prepare("INSERT INTO settings VALUES('artifact_reconciliation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({...reconciliation,checkedAt:new Date().toISOString()}));if(!stopping)try{await pruneSelfBackups();}catch{/* Optional kit cleanup does not stop site jobs. */}reconcileAt=Date.now()+300000;};
 await runWorkerLoop({active:()=>!stopping&&renew(),maintain,tick:()=>{tickScheduler();tickSelfBackup();tickUpdateCheck({db});tickMoves();tickRestoreTests();tickAlerts();tickReachability();},claimSelfBackup,executeSelfBackup,claimJob,executeJob,claimInstall,executeInstall,idle:()=>new Promise(r=>setTimeout(r,3000))});
}finally{clearInterval(heartbeatTimer);if(!lost){heartbeat(false);releaseLease(db,holder);console.log('Worker drained; lease released.');}}
// Exit explicitly so lingering SSH/SFTP handles cannot keep a drained worker alive past the grace period.
process.exit(lost?1:0);
