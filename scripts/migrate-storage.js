import {open,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {db} from '../src/db.js';
import {config} from '../src/config.js';
import {migrationPlan,migrateStorage} from '../src/storage-migration.js';
const mode=process.argv[2]||'plan';let lock;
try{
 if(mode==='plan')console.log(JSON.stringify({pending:migrationPlan().length}));
 else if(mode==='apply'){
  lock=await open(join(config.dataDir,'worker.lock'),'wx',0o600);
  await lock.writeFile(String(process.pid));await lock.sync();
  console.log(JSON.stringify(await migrateStorage()));
 }else throw new Error('Invalid mode');
}catch{console.error('Storage migration blocked. Check stopped API/worker, deployment hold, active operations, original file integrity and destination collisions. Originals are retained.');process.exitCode=1;}
finally{db.close();if(lock){await lock.close();await unlink(join(config.dataDir,'worker.lock'));}}
