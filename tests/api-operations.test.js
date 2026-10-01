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
 const response=await request('/storage-targets/'+target+'/tree');assert.equal(response.status,200);const tree=await response.json();
 assert.equal(tree.root,'/home/docknest');assert.equal(tree.servers.length,1);
 const entry=tree.servers[0].sites[0].days[0].backups[0];
 assert.equal(entry.id,'catalog-one');assert.equal(entry.relativePath,'qa/site/date/backup/payload.enc');assert.equal(entry.size,42);
 assert.ok(!JSON.stringify(tree).includes('catalog-other'));assert.ok(!JSON.stringify(tree).includes('credential'));
 const targets=await (await request('/storage-targets')).json();
 assert.ok(targets.targets.every(target=>!('credential' in target)));assert.equal(targets.targets.find(row=>row.id===target).trackedBytes,42);
 assert.equal((await request('/storage-targets/'+id()+'/tree')).status,404);
 db.prepare("UPDATE users SET role='operator' WHERE id=?").run(user);
 try{assert.equal((await request('/storage-targets/'+target+'/tree')).status,403);}finally{db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user);}
});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();await rm(directory,{recursive:true,force:true});});
