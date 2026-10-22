import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm,stat,mkdir,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes,scryptSync,createCipheriv,createDecipheriv,createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { exportRecoveryKit,restoreRecoveryKit,updaterRunActive,updateRunningMessage } from '../src/recovery-kit.js';
const root=await mkdtemp(join(tmpdir(),'docknest-kit-'));
process.env.DATA_DIR=join(root,'manager');process.env.NODE_ENV='test';
const {db}=await import('../src/db.js');
const hold=value=>db.prepare("INSERT INTO settings VALUES('deployment_hold',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value);
const holdKey=join(root,'hold.key'),holdPassphrase=randomBytes(32).toString('base64url');await writeFile(holdKey,randomBytes(32).toString('base64'));
// Rewrites the snapshot inside a kit, as a kit exported by a release without the hold check (2.1.x) would contain it.
async function reseal(file,mutate){
 const envelope=await readFile(file),header=envelope.subarray(0,32),secret=scryptSync(holdPassphrase,header.subarray(4,20),32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
 const decipher=createDecipheriv('aes-256-gcm',secret,header.subarray(20));decipher.setAAD(header);decipher.setAuthTag(envelope.subarray(-16));
 const payload=JSON.parse(Buffer.concat([decipher.update(envelope.subarray(32,-16)),decipher.final()]).toString()),scratch=join(root,'reseal-'+randomBytes(4).toString('hex')+'.sqlite');
 await writeFile(scratch,Buffer.from(payload.files['state.sqlite'].body,'base64'));
 const state=new DatabaseSync(scratch);state.exec('PRAGMA journal_mode=DELETE');mutate(state);state.close();
 const bytes=await readFile(scratch);payload.files['state.sqlite']={sha256:createHash('sha256').update(bytes).digest('hex'),body:bytes.toString('base64')};
 const cipher=createCipheriv('aes-256-gcm',secret,header.subarray(20));cipher.setAAD(header);
 await writeFile(file,Buffer.concat([header,cipher.update(Buffer.from(JSON.stringify(payload))),cipher.final(),cipher.getAuthTag()]));
}
test('kit creation refuses under the deployment hold, also when the hold lands while the export starts',async()=>{
 const output=join(root,'held.dkit');hold('true');
 await assert.rejects(exportRecoveryKit({database:db,masterKey:holdKey,output,passphrase:holdPassphrase}),error=>error.status===409&&/Deployment verification is in progress/.test(error.message));
 await assert.rejects(stat(output));
 // The first check passes (the hold is not seen yet); the consistent snapshot then shows it and nothing is written.
 const prepare=db.prepare;let hidden=false;
 db.prepare=function(sql){if(!hidden&&sql.includes("key='deployment_hold'")){hidden=true;return {get:()=>undefined};}return prepare.call(this,sql);};
 try{await assert.rejects(exportRecoveryKit({database:db,masterKey:holdKey,output,passphrase:holdPassphrase}),/Deployment verification is in progress/);}finally{delete db.prepare;}
 assert.ok(hidden);await assert.rejects(stat(output));assert.deepEqual((await readdir(root)).filter(name=>name.startsWith('.docknest-kit-')),[]);
 hold('false');await exportRecoveryKit({database:db,masterKey:holdKey,output,passphrase:holdPassphrase});assert.ok((await stat(output)).size>0);
});
test('a kit taken during a hold restores with the hold cleared and its active update requests lost',async()=>{
 const at=new Date().toISOString(),dropRequests=state=>state.exec('DROP TABLE IF EXISTS update_events; DROP TABLE IF EXISTS update_requests;');
 const requests=state=>{
  // Same table and index as migration 5 (docs/update-center.md section 3); IF NOT EXISTS once that migration has run.
  state.exec(`CREATE TABLE IF NOT EXISTS update_requests (id TEXT PRIMARY KEY, from_version TEXT NOT NULL, to_version TEXT NOT NULL, from_schema INTEGER NOT NULL, to_schema INTEGER, requested_by TEXT NOT NULL REFERENCES users(id), requested_at TEXT NOT NULL, accepted_at TEXT, finished_at TEXT, state TEXT NOT NULL CHECK (state IN ('submitted','running','succeeded','refused','busy','rolled_back','needs_action','resolved','lost')), refusal TEXT CHECK (length(refusal) <= 64), exit_code INTEGER, retry_of TEXT REFERENCES update_requests(id), warning TEXT CHECK (length(warning) <= 1024), error TEXT CHECK (length(error) <= 2048), rollback_hint TEXT CHECK (length(rollback_hint) <= 4096));
   CREATE UNIQUE INDEX IF NOT EXISTS update_requests_active ON update_requests((1)) WHERE state IN ('submitted','running','needs_action');`);
  state.prepare("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at) VALUES('admin','admin@example.invalid','fixture','','[]',1,?)").run(at);
  const insert=state.prepare('INSERT INTO update_requests(id,from_version,to_version,from_schema,requested_by,requested_at,finished_at,state) VALUES(?,?,?,4,?,?,?,?)');
  insert.run('previous','2.1.0','2.1.1','admin',at,at,'succeeded');insert.run('active','2.1.1','2.2.0','admin',at,null,'running');
 };
 const cases=[['with update requests',state=>{state.exec("INSERT INTO settings VALUES('deployment_hold','true') ON CONFLICT(key) DO UPDATE SET value='true'");requests(state);}],['before schema 5',state=>{state.exec("INSERT INTO settings VALUES('deployment_hold','true') ON CONFLICT(key) DO UPDATE SET value='true'");dropRequests(state);}]];
 for(const [name,mutate] of cases){
  const input=join(root,name.replaceAll(' ','-')+'.dkit'),target=join(root,name.replaceAll(' ','-')+'-restored');
  await exportRecoveryKit({database:db,masterKey:holdKey,output:input,passphrase:holdPassphrase});await reseal(input,mutate);
  await restoreRecoveryKit({input,directory:target,passphrase:holdPassphrase});
  const restored=new DatabaseSync(join(target,'state.sqlite'));
  try{
   assert.equal(restored.prepare("SELECT value FROM settings WHERE key='deployment_hold'").get(),undefined,name);
   const table=restored.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='update_requests'").get();
   if(name==='before schema 5')assert.equal(table,undefined);
   else{
    assert.deepEqual(restored.prepare('SELECT id,state FROM update_requests ORDER BY id').all().map(row=>({...row})),[{id:'active',state:'lost'},{id:'previous',state:'succeeded'}]);
    assert.ok(restored.prepare("SELECT finished_at FROM update_requests WHERE id='active'").get().finished_at);
    assert.equal(restored.prepare("SELECT finished_at FROM update_requests WHERE id='previous'").get().finished_at,at);
   }
  }finally{restored.close();}
 }
});
test('kit restore refuses while the updater status mount shows an active run, and ignores a missing mount',async()=>{
 const mount=join(root,'updater-status'),write=(name,value)=>writeFile(join(mount,name),typeof value==='string'?value:JSON.stringify(value));
 const run={requestId:'4b0c9c1e-7d0f-4c55-9a0e-2a3c7b0d9f11',target:'v2.2.0',acceptedAt:'2026-10-22T10:00:00Z',events:[{phase:'verify',at:'2026-10-22T10:00:00Z'},{phase:'build',at:'2026-10-22T10:01:00Z'}],truncated:false};
 assert.equal(await updaterRunActive(join(root,'no-updater-mount')),false);assert.equal(await updaterRunActive(),false);
 await mkdir(mount);assert.equal(await updaterRunActive(mount),false);
 await write('current.json',run);assert.equal(await updaterRunActive(mount),true);
 const input=join(root,'active-run.dkit'),target=join(root,'active-run-restored');
 await exportRecoveryKit({database:db,masterKey:holdKey,output:input,passphrase:holdPassphrase});
 await assert.rejects(restoreRecoveryKit({input,directory:target,passphrase:holdPassphrase,updaterStatus:mount}),error=>error.status===409&&error.message===updateRunningMessage);await assert.rejects(stat(target));
 await write('status.json',{requestId:'another-request',ok:true});assert.equal(await updaterRunActive(mount),true);
 await write('status.json',{requestId:run.requestId,ok:null});assert.equal(await updaterRunActive(mount),true);
 await write('status.json',{requestId:run.requestId,ok:false});assert.equal(await updaterRunActive(mount),false);
 await rm(join(mount,'status.json'));
 await write('current.json',{...run,events:[...run.events,{phase:'done',at:'2026-10-22T10:05:00Z'}]});assert.equal(await updaterRunActive(mount),false);
 await write('current.json',{...run,events:[...run.events,{phase:'failed',at:'2026-10-22T10:05:00Z'}]});assert.equal(await updaterRunActive(mount),false);
 for(const broken of ['{not json',JSON.stringify({events:[]}),JSON.stringify({requestId:run.requestId}),'x'.repeat(16385)]){await write('current.json',broken);assert.equal(await updaterRunActive(mount),true,broken.slice(0,20));}
 await rm(join(mount,'current.json'));await mkdir(join(mount,'current.json'));assert.equal(await updaterRunActive(mount),true);
 await rm(mount,{recursive:true});await restoreRecoveryKit({input,directory:target,passphrase:holdPassphrase,updaterStatus:mount});assert.ok((await stat(join(target,'state.sqlite'))).isFile());
});
test('consistent WAL kit survives manager loss, wrong passphrases fail before writing, and live destinations cannot be overwritten',async()=>{
 const passphrase=randomBytes(32).toString('base64url'),masterKey=join(root,'master.key'),output=join(root,'manager.dkit');
 await writeFile(masterKey,randomBytes(32).toString('base64'));
 db.prepare("INSERT INTO settings VALUES('fixture_wal_value','preserved')").run();
 const evidence=await exportRecoveryKit({database:db,masterKey,output,passphrase,release:'fixture'});assert.match(evidence.sha256,/^[a-f0-9]{64}$/);
 const contents=await readFile(output);assert.ok(!contents.includes(Buffer.from('fixture_wal_value')));
 const target=join(root,'restored');await assert.rejects(restoreRecoveryKit({input:output,directory:target,passphrase:randomBytes(32).toString('base64url')}),/authentication/);await assert.rejects(stat(target));
 db.close();await rm(join(root,'manager'),{recursive:true,force:true});
 const result=await restoreRecoveryKit({input:output,directory:target,passphrase});assert.equal(result.sessionsRevoked,true);
 const restored=new DatabaseSync(join(target,'state.sqlite'));assert.equal(restored.prepare("SELECT value FROM settings WHERE key='fixture_wal_value'").get().value,'preserved');restored.close();
 assert.equal(await readFile(join(target,'master.key'),'utf8'),await readFile(masterKey,'utf8'));
 await assert.rejects(restoreRecoveryKit({input:output,directory:target,passphrase}),/EEXIST/);
 contents[50]^=1;await writeFile(join(root,'tampered.dkit'),contents);await assert.rejects(restoreRecoveryKit({input:join(root,'tampered.dkit'),directory:join(root,'tampered-output'),passphrase}),/authentication/);
 await rm(root,{recursive:true,force:true});
});
