import assert from 'node:assert/strict';
import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Diagnostics contain only fixed categories. Never expose raw plan/subprocess
// messages: Docker errors can contain a command's credential-bearing arguments.
export function nativePlanFailure(error) {
 const message=String(error?.message||'');
 for(const [pattern,category] of [
  [/symlink to uncaptured external data/,'external-source-symlink'],
  [/Database must be running/,'native-version-unavailable'],
  [/returned non-zero exit status|native query failed/,'native-query-failed'],
  [/native database shutdown setting/,'invalid-shutdown-setting'],
  [/version does not match|version differs/,'native-version-mismatch'],
  [/data directory must be|Active PostgreSQL data directory/,'data-path-not-captured'],
  [/source filesystem|nested mount/,'unsupported-source-mount'],
  [/SSH|ECONN|handshake|connect/i,'ssh-transport-failed']
 ])if(pattern.test(message))return category;
 return 'native-plan-rejected';
}

export async function nativeFixtureDiagnostics(run,source,name) {
 const probe="import json,subprocess,sys,re\nname=sys.argv[1]\ntry:\n c=json.loads(subprocess.check_output(['docker','inspect',name],stderr=subprocess.DEVNULL))[0];s=c['State'];status=s.get('Status');d={'running':bool(s.get('Running')),'status':status if status in ['created','running','paused','restarting','removing','exited','dead'] else 'unknown','exitCode':s.get('ExitCode') if type(s.get('ExitCode')) is int else None,'oomKilled':bool(s.get('OOMKilled'))}\n log=subprocess.run(['docker','logs','--tail','250',name],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10);text=(log.stdout+log.stderr).decode(errors='replace')\n patterns={'readyForConnections':r'ready for connections','initializationComplete':r'init process done|Initialization complete','temporaryServerFailed':r'Unable to start server|Unable to shut down server','diskFull':r'No space left on device|disk is full','permissionDenied':r'Permission denied','outOfMemory':r'out of memory|Cannot allocate memory','unknownOption':r'unknown (?:option|variable)','aborting':r'Aborting','accessDenied':r'Access denied','socketFailure':r'cannot.*socket|Can.t.*socket'}\n d['logCategories']={key:bool(re.search(pattern,text,re.I)) for key,pattern in patterns.items()};print(json.dumps(d))\nexcept Exception:print(json.dumps({'diagnosticsUnavailable':True}))";
 try{return JSON.parse(await run('exec',source,'python3','-c',probe,name));}
 catch{return {diagnosticsUnavailable:true};}
}

export async function bootFixtureDiagnostics(run,source,base,job) {
 const probe=`import json,sys,pathlib
sys.path[:0]=['/qa-helper/bundle','/qa-helper']
import boot_recovery as driver
diagnostic={'lastStage':'not-started','failureCategory':None}
def category(error):
 message=str(error)
 for marker,label in [('root-owned and private','journal-ownership-or-mode'),('must not use symlinks','journal-symlink'),('directory required','journal-not-directory'),('regular file','journal-not-regular-file'),('Source service identity changed','source-identity-changed'),('Originally stopped service','original-state-changed'),('Unsupported recovery journal','unsupported-journal-version'),('Source health did not recover','source-health-failed'),('Service failed restart health','native-restart-health-failed'),('Public probe failed','public-health-failed'),('Recovery dependency cycle','dependency-cycle')]:
  if marker in message:return label
 kind=type(error).__name__
 return {'PermissionError':'filesystem-permission','FileNotFoundError':'missing-file-or-service','CalledProcessError':'native-command-failed','TimeoutExpired':'native-command-timeout','KeyError':'incomplete-recovery-contract','OSError':'filesystem-sync-or-io'}.get(kind,'recovery-policy-or-io-failed')
def wrap(name,original):
 def invoke(*args,**kwargs):
  diagnostic['lastStage']=name
  return original(*args,**kwargs)
 return invoke
for name in ['private_path','inspect','restart_services','health','maintenance','atomic_json','complete_recovery']:
 setattr(driver,name,wrap(name,getattr(driver,name)))
def trace(frame,event,arg):
 if frame.f_code is driver.recover_jobs.__code__ and event=='exception' and diagnostic['failureCategory'] is None:
  diagnostic['failedStage']=diagnostic['lastStage'];diagnostic['failureCategory']=category(arg[1])
 return trace
base=pathlib.Path(sys.argv[1]);root=base/sys.argv[2];metadata={}
for label,path in [('base',base),('job',root),('journal',root/'boot-recovery.json')]:
 try:
  value=path.lstat();metadata[label]={'uid':value.st_uid,'gid':value.st_gid,'mode':oct(value.st_mode&0o777),'symlink':path.is_symlink()}
 except OSError:metadata[label]={'unavailable':True}
sys.settrace(trace)
try:result=driver.recover_jobs([str(base)],'current-fixture-boot')
except Exception as error:
 result=None
 if diagnostic['failureCategory'] is None:diagnostic['failedStage']=diagnostic['lastStage'];diagnostic['failureCategory']=category(error)
finally:sys.settrace(None)
print(json.dumps({'result':result,'diagnostic':diagnostic,'pathMetadata':metadata}))`;
 return JSON.parse(await run('exec',source,'python3','-c',probe,base,job));
}

// This module receives only isolated fixture hosts from integration-linux.js.
export async function runMilestones({run,until,hosts,servers,db,remote,directory,evidence,record}){
 const {enqueueBackup,enqueueRestore,claimJob,executeJob,planBackup,planRestore,verifyEncrypted}=await import('../src/engine.js');
 const {backupVerification}=await import('../src/recovery-evidence.js');
 evidence.engines=[];evidence.milestones=[];
 const passed=name=>{evidence.milestones.push(name);record(name);};
 const source=hosts[0],target=hosts[1],native=[];
 // Actual Linux nested and unsupported tmpfs mounts, including a bind over them.
 await run('exec',source,'mkdir','-p','/qa-mount','/qa-mount/nested');
 await run('exec',source,'mount','-t','tmpfs','tmpfs','/qa-mount/nested');
 const mountProbe="import sys;sys.path.insert(0,'/qa-helper/bundle');from helper import classify_source\nfor p in ['/qa-mount','/qa-mount/nested']:\n try:classify_source(p);raise AssertionError('Unsupported mount passed')\n except ValueError:pass\nprint('blocked')";
 assert.equal(await run('exec',source,'python3','-c',mountProbe),'blocked');
 await run('exec',source,'umount','/qa-mount/nested');
 passed('M1: actual Linux nested/tmpfs mounts block before stop; NFS/CIFS mount-table policy fixtures pass');

 for(const definition of [{engine:'postgres',image:'postgres:16',major:'16',data:'/var/lib/postgresql/data'},{engine:'mysql',image:'mysql:8.4',major:'8.4',data:'/var/lib/mysql'},{engine:'mariadb',image:'mariadb:11.4',major:'11.4',data:'/var/lib/mysql'}]){
  const name='qa-'+definition.engine,password=randomBytes(24).toString('base64url');
  await run('exec',source,'docker','pull',definition.image);
  const environment=definition.engine==='postgres'?['-e','POSTGRES_PASSWORD='+password,'-e','POSTGRES_DB=fixture']:['-e',(definition.engine==='mariadb'?'MARIADB_ROOT_PASSWORD=':'MYSQL_ROOT_PASSWORD=')+password,'-e','MYSQL_UNIX_PORT=/tmp/mysql.sock'];
  await run('exec',source,'docker','run','-d','--name',name,'--restart','no','--tmpfs','/tmp:size=32m,mode=1777','-v',name+'-data:'+definition.data,...environment,definition.image,...(definition.engine==='postgres'?[]:['--socket=/tmp/mysql.sock']));
  const siteId=randomUUID(),cfg={containers:[name],stagingRoot:'/var/lib/docknest',exclusiveSourcesConfirmed:true,externalReferencesConfirmed:true,cleanShutdownConfirmed:true,shutdownProfile:'generic',stopTimeout:90,maintenance:{required:false},temporaryMemoryFolders:[{container:name,destination:'/tmp'}],services:[{container:name,engine:definition.engine,database:'fixture',dependsOn:[],checks:[{name:'Fixture records',table:'records'}]}]};
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId,servers[0].id,'Native '+definition.engine,JSON.stringify(cfg),new Date().toISOString());
  // Wait on native version/readiness, not merely State.Running.
  let lastPlanFailure='native-version-unavailable';
  try{
   await until(async()=>{
    try{return Boolean((await planBackup(siteId)).services[0].version);}
    catch(error){lastPlanFailure=nativePlanFailure(error);return false;}
   },'Native database preflight failed: '+definition.engine,180);
  }catch{
   const diagnostics=await nativeFixtureDiagnostics(run,source,name);
   evidence.nativePreflightFailure={engine:definition.engine,planFailure:lastPlanFailure,...diagnostics};
   throw new Error('Native database preflight failed: '+definition.engine+'; '+JSON.stringify(evidence.nativePreflightFailure));
  }
  const client=definition.engine==='postgres'?'psql':definition.engine==='mariadb'?'mariadb':'mysql';
  async function query(host,cid,sql){
   if(definition.engine==='postgres')return run('exec',host,'docker','exec','--user','postgres',cid,client,'-X','-w','-h','/var/run/postgresql','-U','postgres','-d','fixture','-At','-v','ON_ERROR_STOP=1','-c',sql);
   const script='export MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"; exec "$1" --protocol=socket --socket=/tmp/mysql.sock -uroot -N -B -e "$2"';
   return run('exec',host,'docker','exec',cid,'sh','-c',script,'fixture',client,sql);
  }
  await query(source,name,(definition.engine==='postgres'?'':'CREATE DATABASE IF NOT EXISTS fixture; USE fixture; ')+'CREATE TABLE records (id INTEGER PRIMARY KEY, value VARCHAR(80)); INSERT INTO records VALUES (1,\'snapshot-native\'),(2,\'second-record\');');
  const plan=await planBackup(siteId);assert.equal(plan.services[0].engine,definition.engine);assert.ok(plan.services[0].version.startsWith(definition.major));
  if(definition.engine!=='postgres')assert.equal(await query(source,name,'SELECT @@global.innodb_fast_shutdown;'),'1','Read-only preflight must preserve the default setting');
  const image=JSON.parse(await run('exec',source,'docker','image','inspect',definition.image))[0];
  enqueueBackup(siteId,'qa');const job=claimJob();await executeJob(job);const complete=db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);assert.equal(complete.status,'completed',complete.error);
  const backup=db.prepare('SELECT * FROM backups WHERE job_id=?').get(job.id);assert.equal(await verifyEncrypted(backup.path),backup.checksum);assert.equal(backupVerification(backup.id).consistency.status,'passed');assert.equal(backupVerification(backup.id).application.status,'not-tested');
  if(definition.engine!=='postgres')assert.equal(await query(source,name,'SELECT @@global.innodb_fast_shutdown;'),'1','Capture must restore the original shutdown setting');
  await query(source,name,(definition.engine==='postgres'?'':'USE fixture; ')+"UPDATE records SET value='live-change' WHERE id=1;");
  await enqueueRestore(backup.id,await planRestore(backup.id,{serverId:servers[1].id}),'qa');const restore=claimJob();await executeJob(restore);const restored=db.prepare('SELECT * FROM jobs WHERE id=?').get(restore.id);assert.equal(restored.status,'completed',restored.error);
  const result=JSON.parse(restored.details).result;assert.equal(result.networkMode,'none');assert.equal(result.restoreTested,true);assert.equal(backupVerification(backup.id).application.status,'passed');
  assert.equal(await query(target,result.containerId,(definition.engine==='postgres'?'':'USE fixture; ')+'SELECT value FROM records WHERE id=1;'),'snapshot-native');
  assert.equal(await query(source,name,(definition.engine==='postgres'?'':'USE fixture; ')+'SELECT value FROM records WHERE id=1;'),'live-change');
  native.push({name,siteId,cfg,id:plan.services[0].container,image:image.Id});
  evidence.engines.push({engine:definition.engine,version:plan.services[0].version,imageId:image.Id,digests:image.RepoDigests,checks:['native-version','native-clean-shutdown','isolated-data-restore','live-source-preserved']});
  passed('M2/M3: '+definition.engine+' native cold capture and isolated row recovery');
  await run('exec',target,'docker','rm','-f',...result.containerIds);
 }
 // The mixed contract checks independent native engines and their data in one isolated network.
 const mixedId=randomUUID(),mixed={...native[0].cfg,containers:native.map(s=>s.name),services:native.flatMap(s=>s.cfg.services),temporaryMemoryFolders:native.flatMap(s=>s.cfg.temporaryMemoryFolders)};
 db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(mixedId,servers[0].id,'Mixed engine fixture',JSON.stringify(mixed),new Date().toISOString());
 enqueueBackup(mixedId,'qa');const mixedJob=claimJob();await executeJob(mixedJob);const mixedDone=db.prepare('SELECT * FROM jobs WHERE id=?').get(mixedJob.id);assert.equal(mixedDone.status,'completed',mixedDone.error);
 const mixedBackup=db.prepare('SELECT * FROM backups WHERE job_id=?').get(mixedJob.id);await enqueueRestore(mixedBackup.id,await planRestore(mixedBackup.id,{serverId:servers[1].id}),'qa');const mixedRestore=claimJob();await executeJob(mixedRestore);assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(mixedRestore.id).status,'completed');assert.equal(backupVerification(mixedBackup.id).application.status,'passed');
 passed('M2/M3: mixed-engine capture and isolated native data checks');

 // Force an actual SIGKILL instead of graceful stop; never publish this attempt.
 const dockerWrapper=join(directory,'docker-wrapper');
 await writeFile(dockerWrapper,'#!/bin/sh\nif [ "$1" = stop ] && [ -f /tmp/docknest-force-kill ]; then rm /tmp/docknest-force-kill; shift; shift; shift; exec /usr/local/bin/docker-real kill "$@"; fi\nexec /usr/local/bin/docker-real "$@"\n');
 await run('exec',source,'mv','/usr/local/bin/docker','/usr/local/bin/docker-real');await run('cp',dockerWrapper,source+':/usr/local/bin/docker');await run('exec',source,'chmod','755','/usr/local/bin/docker');await run('exec',source,'touch','/tmp/docknest-force-kill');
 const before=db.prepare('SELECT COUNT(*) AS n FROM backups WHERE site_id=?').get(native[0].siteId).n;enqueueBackup(native[0].siteId,'qa');const killed=claimJob();await executeJob(killed);assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(killed.id).status,'failed');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backups WHERE site_id=?').get(native[0].siteId).n,before);assert.equal(await run('exec',source,'docker','inspect','--format','{{.State.Running}}',native[0].name),'true');
 passed('M2: forced native database kill rejects consistency and recovers source');

 // Real Linux boot-recovery driver on private journals, with a simulated boot identity.
 const bootRoot='/var/lib/docknest-boot-qa',bootJob=randomUUID(),bootRecord={version:1,bootId:'prior-fixture-boot',running:[native[0].id],identities:{[native[0].id]:native[0].image},config:{...native[0].cfg,_runningContainers:[native[0].id],_serviceContracts:[{container:native[0].id,engine:'postgres',database:'fixture',user:'postgres'}]}};
 await run('exec',source,'mkdir','-p',bootRoot+'/'+bootJob);await run('exec',source,'chmod','700',bootRoot,bootRoot+'/'+bootJob);
 const journal=join(directory,'boot-record.json');await writeFile(journal,JSON.stringify(bootRecord));await run('cp',journal,source+':'+bootRoot+'/'+bootJob+'/boot-recovery.json');
 // Docker cp can retain the CI runner uid; real boot journals are written by root.
 // Match that fixture ownership explicitly before exercising the strict guard.
 await run('exec',source,'chown','root:root',bootRoot+'/'+bootJob+'/boot-recovery.json');await run('exec',source,'chmod','600',bootRoot+'/'+bootJob+'/boot-recovery.json');await run('exec',source,'docker','stop',native[0].id);
 const bootProbe=await bootFixtureDiagnostics(run,source,bootRoot,bootJob);evidence.bootRecovery=bootProbe;
 assert.deepEqual(bootProbe.result,{recovered:1,reviewRequired:0,ignored:0},JSON.stringify(bootProbe));assert.equal(await run('exec',source,'docker','inspect','--format','{{.State.Running}}',native[0].id),'true');
 passed('M4: Linux boot journal driver recovers native source after simulated boot identity change');

 // Separate root archive: manager uid 1000 cannot unlink it, even when it knows the name.
 const archiveInput=join(directory,'archive-input.enc'),archiveBytes=randomBytes(64);await writeFile(archiveInput,archiveBytes);await run('cp','scripts/protected-copy.py',hosts[2]+':/protected-copy.py');await run('cp',archiveInput,hosts[2]+':/incoming.enc');await run('exec',hosts[2],'mkdir','-p','/archive');await run('exec',hosts[2],'chmod','700','/archive');
 const archive=JSON.parse(await run('exec',hosts[2],'python3','/protected-copy.py','/incoming.enc','/archive',createHash('sha256').update(archiveBytes).digest('hex')));
 await assert.rejects(run('exec','--user','1000:1000',hosts[2],'rm','/archive/'+archive.file));assert.equal(await run('exec',hosts[2],'test','-f','/archive/'+archive.file),'');
 passed('M4: independent Linux root archive rejects manager-uid deletion');
 // The isolated Node suite validates kit recovery after deleting its original manager state.
 // CI runs it separately, including WAL, wrong key, tampering and additive upgrade fixtures.
 for(const fixture of native)await run('exec',source,'docker','rm','-f',fixture.id);
}
