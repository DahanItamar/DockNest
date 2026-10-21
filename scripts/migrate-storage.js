import {randomUUID} from 'node:crypto';
import {db} from '../src/db.js';
import {migrationPlan,migrateStorage} from '../src/storage-migration.js';
import {acquireLease,renewLease,releaseLease,LEASE_TTL_MS} from '../src/worker-lease.js';
// Migration holds the same SQLite lease as the worker, so neither can start while the other runs.
const mode=process.argv[2]||'plan',holder=`migrate-storage:${randomUUID()}`;let leased=false,timer;
try{
 if(mode==='plan')console.log(JSON.stringify({pending:migrationPlan().length}));
 else if(mode==='apply'){
  if(!acquireLease(db,holder).acquired)throw new Error('Worker lease held');
  leased=true;timer=setInterval(()=>{if(!renewLease(db,holder))console.error('Storage migration lost the worker lease.');},LEASE_TTL_MS/4);
  console.log(JSON.stringify(await migrateStorage()));
 }else throw new Error('Invalid mode');
}catch{console.error('Storage migration blocked. Check stopped API/worker, worker lease, deployment hold, active operations, original file integrity and destination collisions. Originals are retained.');process.exitCode=1;}
finally{clearInterval(timer);if(leased)releaseLease(db,holder);db.close();}
