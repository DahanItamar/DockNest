import {randomUUID} from 'node:crypto';
import {db} from '../src/db.js';
import {migrationPlan,migrateStorage} from '../src/storage-migration.js';
import {acquireLease,renewLease,releaseLease,LEASE_TTL_MS} from '../src/worker-lease.js';
// Migration holds the same SQLite lease as the worker, so neither can start while the other runs.
const mode=process.argv[2]||'plan',holder=`migrate-storage:${randomUUID()}`;let leased=false,timer;
try{
 if(mode==='plan')console.log(JSON.stringify({pending:migrationPlan().length}));
 else if(mode==='apply'){
  const attempt=acquireLease(db,holder);
  // Report the lease specifically; the generic message below lists every other blocking cause.
  if(!attempt.acquired){console.error(`Storage migration blocked: the worker lease is held by ${attempt.lease.holder} until ${new Date(attempt.lease.expires_at).toISOString()}. Stop the worker gracefully, or wait for the lease to expire after a crash (npm run worker:status). Originals are retained.`);process.exitCode=1;}
  else{leased=true;timer=setInterval(()=>{if(!renewLease(db,holder))console.error('Storage migration lost the worker lease.');},LEASE_TTL_MS/4);console.log(JSON.stringify(await migrateStorage()));}
 }else throw new Error('Invalid mode');
}catch{console.error('Storage migration blocked. Check stopped API/worker, worker lease, deployment hold, active operations, original file integrity and destination collisions. Originals are retained.');process.exitCode=1;}
finally{clearInterval(timer);if(leased)releaseLease(db,holder);db.close();}
