import {db,transaction} from '../src/db.js';
const mode=process.argv[2]||'check';
try{
 if(!['check','hold','release'].includes(mode))throw new Error('Invalid mode');
 const result=transaction(()=>{
  const pending=db.prepare("SELECT status,COUNT(*) AS count FROM jobs WHERE status IN ('queued','running','recovery_required') GROUP BY status").all();
  const artifacts=db.prepare("SELECT COUNT(*) AS count FROM artifact_operations WHERE state IN ('prepared','authenticated')").get().count;
  const deletions=db.prepare('SELECT COUNT(*) AS count FROM retention_operations').get().count;
  const reconciliation=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='artifact_reconciliation'").get()?.value||'{}');
  // DockNest self-backups count too, read in the same transaction that sets the hold; releasing never waits for them.
  const managerBackups=mode==='release'?0:db.prepare("SELECT COUNT(*) AS count FROM manager_backups WHERE status IN ('queued','running')").get().count;
  if(pending.length||artifacts||deletions||reconciliation.pending||managerBackups)throw new Error('Queue or recovery reconciliation needs review');
  if(mode!=='check')db.prepare("INSERT INTO settings VALUES('deployment_hold',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(mode==='hold'?'true':'false');
  return {queueEmpty:true,recoveryResolved:true,reconciliationClean:true,hold:mode==='hold'||(mode==='check'&&db.prepare("SELECT value FROM settings WHERE key='deployment_hold'").get()?.value==='true')};
 });console.log(JSON.stringify(result));
}catch{console.error('Deployment blocked: queued/running/recovery work, a DockNest self-backup or pending artifact operations must be resolved first.');process.exitCode=1;}finally{db.close();}
