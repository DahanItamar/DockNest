// Worker main loop. `active()` (not draining, lease still renewable) is re-checked after every await and immediately
// before claiming, so a drain signal or lease loss during slow maintenance can never start new work.
export async function runWorkerLoop({active,maintain,tick,claimSelfBackup,executeSelfBackup,claimJob,executeJob,idle,claimInstall,executeInstall}){
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
  if(job)await executeJob(job);else await idle();
 }
}
