// Worker main loop. `active()` (not draining, lease still renewable) is re-checked after every await and immediately
// before claiming, so a drain signal or lease loss during slow maintenance can never start new work.
// Backup copies (docs/backup-copies.md) come last: a due copy step runs only when no site job waits, so a copy never
// delays a backup. Due copies are found by `next_attempt_at` in the database, never by a timer of their own.
export async function runWorkerLoop({active,maintain,tick,claimSelfBackup,executeSelfBackup,claimJob,executeJob,idle,claimInstall,executeInstall,claimCopy,executeCopy}){
 while(active()){
  await maintain();
  if(!active())break;
  tick();
  if(!active())break;
  const managerJob=claimSelfBackup();
  if(managerJob){await executeSelfBackup(managerJob);continue;}
  if(!active())break;
  const install=claimInstall?.();
  if(install){await executeInstall(install);continue;}
  const job=claimJob();
  if(job){await executeJob(job);continue;}
  const copy=active()?claimCopy?.():null;
  if(copy)await executeCopy(copy);else await idle();
 }
}
