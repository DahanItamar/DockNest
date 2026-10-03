import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const directory=await mkdtemp(join(tmpdir(),'docknest-api-'));
Object.assign(process.env,{DATA_DIR:directory,BACKUP_DIR:join(directory,'backups'),BACKUP_STORAGE:'local',MASTER_KEY_FILE:join(directory,'master.key'),SETUP_TOKEN_FILE:join(directory,'setup.token'),SECURE_COOKIES:'false',NODE_ENV:'test',APP_ORIGIN:'http://127.0.0.1:3000'});
await writeFile(process.env.MASTER_KEY_FILE,randomBytes(32).toString('base64'));
const {app}=await import('../src/server.js');
const {db,id}=await import('../src/db.js');
const {digest}=await import('../src/crypto.js');
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}/api`;
const token=randomBytes(32).toString('base64url'),csrf='fixture-csrf',user=id(),site=id(),host=id(),job=id();
db.prepare("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)").run(user,'qa@example.invalid','fixture','fixture','[]',new Date().toISOString(),'QA','admin');
db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token),user,csrf,Date.now()+3600000,Date.now(),Date.now(),Date.now());
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(host,'QA','localhost',22,'root','fixture','0'.repeat(64),new Date().toISOString());
db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(site,host,'QA site','{}',new Date().toISOString());
db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','completed','completed',?)").run(job,site,new Date().toISOString());
function backup(name,path,size=100){db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(name,site,job,new Date().toISOString(),path,size,'a'.repeat(64),'{}',0,1,new Date().toISOString());}
function request(route,options={}){return fetch(base+route,{...options,headers:{Cookie:'dbm_session='+token,Origin:process.env.APP_ORIGIN,'x-csrf-token':csrf,'Content-Type':'application/json',...options.headers}});}

test('native Redis checks persist while ambiguous or mismatched check definitions are rejected',async()=>{
 const service={container:'fixture-redis',engine:'redis',database:'0',checks:[{name:'Cached record',key:'fixture:record'}]};
 const payload={serverId:host,name:'Redis contract fixture',config:{containers:['fixture-redis'],services:[service]}};
 const saved=await request('/sites',{method:'POST',body:JSON.stringify(payload)});assert.equal(saved.status,201);
 assert.deepEqual((await saved.json()).config.services[0].checks,service.checks);
 for(const invalid of [{...service,checks:[{name:'Both',key:'key',table:'records'}]},{...service,engine:'mysql'},{...service,database:'not_a_number'},{...service,checks:[{name:'Missing'}]}]){
  const response=await request('/sites',{method:'POST',body:JSON.stringify({...payload,config:{...payload.config,services:[invalid]}})});assert.equal(response.status,400);
 }
});

test('download range streams the selected bytes and releases its retention lease',async()=>{
 const file=join(process.env.BACKUP_DIR,'range.enc');await writeFile(file,Buffer.from('0123456789'));backup('range',file,10);
 const response=await request('/backups/range/download',{headers:{Range:'bytes=2-5'}});
 assert.equal(response.status,206);assert.equal(await response.text(),'2345');
 assert.equal(response.headers.get('content-range'),'bytes 2-5/10');
 assert.equal(response.headers.get('x-backup-sha256'),'a'.repeat(64));
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM downloads').get().n,0);
});
test('missing and outside-storage backup files do not leave retention leases',async()=>{
 backup('missing',join(process.env.BACKUP_DIR,'missing.enc'));
 const outside=join(directory,'outside.enc');await writeFile(outside,'outside');backup('outside',outside);
 for(const name of ['missing','outside']){const response=await request('/backups/'+name+'/download');assert.ok(response.status>=400);await response.text();}
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM downloads').get().n,0);
});
test('storage accounting includes backups beyond the displayed 1000 rows and metadata excludes paths',async()=>{
 for(let i=0;i<1001;i++)backup('count-'+i,join(process.env.BACKUP_DIR,'fixture'),100);
 const response=await request('/state');assert.equal(response.status,200);const state=await response.json();
 assert.equal(state.backups.length,1000);assert.equal(state.storage.used,100310);
 assert.equal(state.backups.some(backup=>'path' in backup),false);
 assert.equal(state.servers.some(server=>'private_key' in server||'privateKey' in server),false);
});
test('optional server notes persist and details edits preserve verified connection settings',async()=>{
 const payload={name:'DemoBlog_srv',note:'  DemoBlog production  ',host:'fixture.example.invalid',port:22,username:'root',privateKey:'fixture-only-key-'.repeat(5),hostKey:'a'.repeat(64)};
 const created=await request('/servers',{method:'POST',body:JSON.stringify(payload)});
 assert.equal(created.status,201);
 const saved=await created.json();assert.equal(saved.note,'DemoBlog production');assert.ok(!('private_key' in saved));
 db.prepare("UPDATE servers SET status='connected',capabilities=? WHERE id=?").run('{"uid":0}',saved.id);
 const before=db.prepare('SELECT * FROM servers WHERE id=?').get(saved.id);
 const route='/servers/'+saved.id+'/details';
 let response=await request(route,{method:'PATCH',body:JSON.stringify({name:'DemoBlog',note:'Website host'})});
 assert.equal(response.status,200);assert.equal((await response.json()).note,'Website host');
 const after=db.prepare('SELECT * FROM servers WHERE id=?').get(saved.id);
 for(const field of ['host','port','username','private_key','host_key','status','capabilities','created_at'])assert.equal(after[field],before[field],field+' must survive a details edit');
 response=await request(route,{method:'PATCH',body:JSON.stringify({name:'DemoBlog',note:'x'.repeat(201)})});assert.equal(response.status,400);
 response=await request(route,{method:'PATCH',body:JSON.stringify({name:'DemoBlog',note:'',host:'other.example.invalid'})});assert.equal(response.status,400,'Details endpoint rejects connection fields');
 db.prepare("UPDATE users SET role='operator' WHERE id=?").run(user);
 try{assert.equal((await request(route,{method:'PATCH',body:JSON.stringify({name:'DemoBlog',note:'changed'})})).status,403);}finally{db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user);}
 response=await request(route,{method:'PATCH',body:JSON.stringify({name:' ',note:' '})});assert.equal(response.status,200);
 const cleared=await response.json();assert.equal(cleared.name,payload.host);assert.equal(cleared.note,'');
});

test('site and schedule validation reject unsafe paths, invalid URLs and invalid cron/timezone',async()=>{
 const payload={serverId:host,name:'Invalid site',config:{containers:['fixture'],healthUrl:'file:///etc/passwd'}};
 let response=await request('/sites',{method:'POST',body:JSON.stringify(payload)});assert.ok(response.status>=400);
 for(const config of [{containers:['fixture'],stagingRoot:'/tmp/../site'},{containers:['fixture'],stagingRoot:'/'},{containers:['fixture'],healthUrl:'http://name:secret@example.invalid/'}]){
  response=await request('/sites',{method:'POST',body:JSON.stringify({...payload,config})});assert.equal(response.status,400);
 }
 response=await request('/sites/'+site+'/policy',{method:'POST',body:JSON.stringify({enabled:true,schedule:'bad cron',timezone:'UTC',retention:7})});assert.ok(response.status>=400);
 response=await request('/sites/'+site+'/policy',{method:'POST',body:JSON.stringify({enabled:true,schedule:'0 2 * * *',timezone:'No/SuchZone',retention:7})});assert.ok(response.status>=400);
});
test('site domains accept copied website URLs and reject credentials or invalid addresses with plain guidance',async()=>{
 const payload={serverId:host,name:'Domain fixture',config:{containers:['fixture'],domains:[' https://www.blog.example.invalid/ ','http://SHOP.example.org:8080/catalog','example.org/']}};
 const response=await request('/sites',{method:'POST',body:JSON.stringify(payload)});
 assert.equal(response.status,201);const created=await response.json();
 assert.deepEqual(created.config.domains,['www.blog.example.invalid','shop.example.org','example.org']);
 assert.equal(created.config.maintenance.publicUrl,'https://www.blog.example.invalid');
 for(const domain of ['ftp://example.org/','https://user:fixture@example.org/','not a domain']){
  const rejected=await request('/sites',{method:'POST',body:JSON.stringify({...payload,config:{...payload.config,domains:[domain]}})});
  assert.equal(rejected.status,400);
  const error=(await rejected.json()).error;assert.ok(error.includes('Enter a domain'));assert.ok(!error.includes('must match pattern'));assert.ok(!error.includes('fixture@example.org'));
 }
});
test('project file browser rejects malformed paths and operator access before contacting SSH',async()=>{
 const route='/servers/'+host+'/project-files';
 assert.equal((await request(route+'?containers=fixture&path=/tmp/../outside')).status,400);
 assert.equal((await request(route+'?containers=--bad&path=/tmp/project')).status,400);
 db.prepare("UPDATE users SET role='operator' WHERE id=?").run(user);
 try{assert.equal((await request(route+'?containers=fixture&path=/tmp/project')).status,403);}finally{db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user);}
});

test('removing a site pauses schedules, keeps backups and rejects active work or further edits',async()=>{
 const response=await request('/sites',{method:'POST',body:JSON.stringify({serverId:host,name:'Archive fixture',config:{containers:['fixture']}})});
 const saved=await response.json();assert.equal(response.status,201);
 const route='/sites/'+saved.id,archiveJob=id(),backupId=id(),file=join(process.env.BACKUP_DIR,'archive-fixture.enc');await writeFile(file,'preserved');
 db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','queued','queued',?)").run(archiveJob,saved.id,new Date().toISOString());
 db.prepare("UPDATE policies SET enabled=1,next_run=? WHERE site_id=?").run(new Date().toISOString(),saved.id);
 assert.equal((await request(route,{method:'DELETE'})).status,409,'Active jobs block removal');
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM site_archives WHERE site_id=?').get(saved.id).n,0);
 db.prepare("UPDATE jobs SET status='completed',stage='completed' WHERE id=?").run(archiveJob);
 db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(backupId,saved.id,archiveJob,new Date().toISOString(),file,9,'a'.repeat(64),'{}',0,1,new Date().toISOString());
 db.prepare("UPDATE users SET role='operator' WHERE id=?").run(user);
 try{assert.equal((await request(route,{method:'DELETE'})).status,403);}finally{db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user);}
 assert.equal((await request(route,{method:'DELETE'})).status,200);
 assert.equal(db.prepare('SELECT enabled FROM policies WHERE site_id=?').get(saved.id).enabled,0);
 const state=await (await request('/state')).json();assert.ok(!state.sites.some(site=>site.id===saved.id));assert.ok(state.archivedSites.some(site=>site.id===saved.id&&site.name==='Archive fixture'));
 assert.ok(db.prepare('SELECT 1 FROM backups WHERE id=?').get(backupId));
 assert.equal(await (await import('node:fs/promises')).readFile(file,'utf8'),'preserved');
 assert.equal((await request(route+'/backup',{method:'POST',body:'{}'})).status,409);
 assert.equal((await request(route+'/policy',{method:'POST',body:JSON.stringify({enabled:true,schedule:'0 2 * * *',timezone:'UTC',retention:7})})).status,409);
 assert.equal((await request(route,{method:'PATCH',body:JSON.stringify({serverId:host,name:'Edited removed site',config:{containers:['fixture']}})})).status,409);
});
test('origin probe preference survives configuration normalization and readiness rejects active work',async()=>{
 const response=await request('/sites',{method:'POST',body:JSON.stringify({serverId:host,name:'Origin fixture',config:{containers:['fixture'],domains:['www.example.org'],maintenanceProbeOrigin:true}})});
 assert.equal(response.status,201);const saved=await response.json();assert.equal(saved.config.maintenance.probeOrigin,true);
 const pending=id();db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','queued','queued',?)").run(pending,saved.id,new Date().toISOString());
 assert.equal((await request('/sites/'+saved.id+'/readiness',{method:'POST',body:'{}'})).status,409);
 assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(pending).status,'queued');
});

test('dashboard reports absent, current and stale worker heartbeats accurately',async()=>{
 assert.equal((await (await request('/state')).json()).worker.online,false);
 db.prepare("INSERT INTO settings VALUES('worker_heartbeat',?)").run(JSON.stringify({running:true,lastSeen:new Date().toISOString()}));
 assert.equal((await (await request('/state')).json()).worker.online,true);
 db.prepare("UPDATE settings SET value=? WHERE key='worker_heartbeat'").run(JSON.stringify({running:true,lastSeen:new Date(Date.now()-120000).toISOString()}));
 assert.equal((await (await request('/state')).json()).worker.online,false);
});
test('storage catalog separates destinations, redacts credentials and groups managed backups',async()=>{
 const target=id(),other=id(),stamp=new Date().toISOString();
 for(const targetId of [target,other])db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(targetId,'Fixture destination','box.example.invalid',22,'fixture','a'.repeat(64),'password','fixture-not-a-real-credential','/home/docknest',1e12,'connected',stamp,stamp);
 backup('catalog-one','sftp:'+target+':/home/docknest/qa/site/date/backup/payload.enc',42);
 backup('catalog-other','sftp:'+other+':/home/docknest/other/payload.enc',84);
 const kit=id(),kitFile='docknest_0123456789abcdef_2026-10-03_12-13-14Z--'+kit+'.dkit';
 db.prepare("INSERT INTO manager_backups(id,status,created_at,finished_at,size,target_id,path) VALUES(?,'completed',?,?,64,?,?)").run(kit,stamp,stamp,target,'sftp:'+target+':/home/docknest/BACKUP/docknest-recovery/'+kitFile);
 const response=await request('/storage-targets/'+target+'/tree');assert.equal(response.status,200);const tree=await response.json();
 assert.equal(tree.root,'/home/docknest');assert.equal(tree.managedRoot,'/home/docknest/BACKUP');assert.equal(tree.servers.length,1);
 const entry=tree.servers[0].sites[0].days[0].backups[0];
 assert.equal(entry.id,'catalog-one');assert.equal(entry.relativePath,'qa/site/date/backup/payload.enc');assert.equal(entry.size,42);
 assert.equal(entry.filename,'payload.enc');assert.equal(tree.recovery.folder,'docknest-recovery');assert.equal(tree.recovery.files.length,1);
 assert.equal(tree.recovery.files[0].filename,kitFile);assert.equal(tree.recovery.files[0].relativePath,'BACKUP/docknest-recovery/'+kitFile);assert.equal(tree.recovery.files[0].downloadable,true);
 assert.ok(!JSON.stringify(tree).includes('catalog-other'));assert.ok(!JSON.stringify(tree).includes('credential'));
 const targets=await (await request('/storage-targets')).json();
 assert.ok(targets.targets.every(target=>!('credential' in target)));assert.equal(targets.targets.find(row=>row.id===target).trackedBytes,106);
 assert.equal((await request('/storage-targets/'+id()+'/tree')).status,404);
 db.prepare("UPDATE users SET role='operator' WHERE id=?").run(user);
 try{assert.equal((await request('/storage-targets/'+target+'/tree')).status,403);}finally{db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user);}
});
test('full ZIP refuses tampered ciphertext before sending bytes and cleans private temporary files',async()=>{
 const {encryptStream}=await import('../src/engine.js');const {Readable}=await import('node:stream');const {createWriteStream}=await import('node:fs');const {readFile,readdir}=await import('node:fs/promises');const {createHash}=await import('node:crypto');
 const file=join(process.env.BACKUP_DIR,'zip-auth.enc');await encryptStream(Readable.from(Buffer.from('fixture payload')),createWriteStream(file));
 const bytes=await readFile(file);backup('zip-auth',file,bytes.length);db.prepare('UPDATE backups SET checksum=? WHERE id=?').run(createHash('sha256').update(bytes).digest('hex'),'zip-auth');
 bytes[20]^=1;await writeFile(file,bytes);
 const response=await request('/backups/zip-auth/download?format=zip');assert.ok(response.status>=400);assert.match(response.headers.get('content-type'),/json/);await response.text();
 assert.deepEqual(await readdir(join(directory,'private-exports')),[]);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM downloads').get().n,0);
 assert.equal((await request('/backups/zip-auth/download?format=zip',{headers:{Range:'bytes=0-9'}})).status,416);
});
test('static-site settings persist without Docker services and maintenance controls are disabled',async()=>{
 const config={kind:'static',documentRoot:'/var/www/example.org',containers:[],domains:['example.org'],healthUrl:'https://example.org',configFiles:['/etc/nginx/sites-available/example'],externalReferencesConfirmed:true,exclusiveSourcesConfirmed:true};
 let response=await request('/sites',{method:'POST',body:JSON.stringify({serverId:host,name:'Static website',config})});assert.equal(response.status,201);const saved=await response.json();
 assert.equal(saved.config.kind,'static');assert.equal(saved.config.maintenance.required,false);assert.equal(saved.config.maintenanceRequired,false);
 response=await request('/sites/'+saved.id+'/maintenance',{method:'POST',body:JSON.stringify({enabled:true})});assert.equal(response.status,400);
 for(const bad of [{...config,documentRoot:undefined},{...config,containers:['app']},{...config,composeFiles:['/app/compose.yml']},{...config,kind:'docker'}]){response=await request('/sites',{method:'POST',body:JSON.stringify({serverId:host,name:'Invalid static',config:bad})});assert.equal(response.status,400);}
});

test.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();await rm(directory,{recursive:true,force:true});});

test('maintenance design persists composition and supports previous clients',async()=>{
 const design={title:'A polished pause',message:'Please return soon.',color:'#5E35B1',layout:'editorial',theme:'light',typeScale:'bold'};
 let response=await request('/maintenance',{method:'PATCH',body:JSON.stringify(design)});assert.equal(response.status,200);assert.deepEqual(await response.json(),design);
 const state=await (await request('/state')).json();assert.deepEqual(state.maintenance,design);
 response=await request('/maintenance',{method:'PATCH',body:JSON.stringify({...design,layout:'unsafe'})});assert.equal(response.status,400);
 response=await request('/maintenance',{method:'PATCH',body:JSON.stringify({title:'Legacy',message:'Compatible',color:'#123456'})});assert.equal(response.status,200);const legacy=await response.json();assert.equal(legacy.layout,'studio');assert.equal(legacy.theme,'light');assert.equal(legacy.typeScale,'balanced');
});
