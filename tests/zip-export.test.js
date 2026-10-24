import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, utimes, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const directory=await mkdtemp(join(tmpdir(),'docknest-zip-'));
Object.assign(process.env,{DATA_DIR:directory,BACKUP_DIR:join(directory,'backups'),BACKUP_STORAGE:'local',MASTER_KEY_FILE:join(directory,'master.key'),SETUP_TOKEN_FILE:join(directory,'setup.token'),SECURE_COOKIES:'false',NODE_ENV:'test',DOCKNEST_TEST_ZIP_READY_MS:'3000',APP_ORIGIN:'http://127.0.0.1:3000'});
await writeFile(process.env.MASTER_KEY_FILE,randomBytes(32).toString('base64'));
const {app}=await import('../src/server.js');
const {db,id}=await import('../src/db.js');
const {digest}=await import('../src/crypto.js');
const {encryptStream}=await import('../src/engine.js');
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}/api`;
const token=randomBytes(32).toString('base64url'),csrf='fixture-csrf',user=id(),site=id(),host=id(),job=id();
const python=process.platform==='win32'?'python':'python3';
db.prepare("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)").run(user,'zip@example.invalid','fixture','fixture','[]',new Date().toISOString(),'QA','admin');
db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token),user,csrf,Date.now()+3600000,Date.now(),Date.now(),Date.now());
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(host,'QA','localhost',22,'root','fixture','0'.repeat(64),new Date().toISOString());
db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(site,host,'QA site','{}',new Date().toISOString());
db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','completed','completed',?)").run(job,site,new Date().toISOString());
const request=(route,options={})=>fetch(base+route,{...options,headers:{Cookie:'dbm_session='+token,Origin:process.env.APP_ORIGIN,'x-csrf-token':csrf,'Content-Type':'application/json',...options.headers}});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

const BUILD=`import io,json,sys,tarfile
def add(t,name,data=b'',kind=tarfile.REGTYPE,link=''):
    i=tarfile.TarInfo(name);i.type=kind;i.linkname=link;i.size=len(data) if kind==tarfile.REGTYPE else 0
    t.addfile(i,io.BytesIO(data) if kind==tarfile.REGTYPE else None)
nested=io.BytesIO()
with tarfile.open(fileobj=nested,mode='w') as n:
    add(n,'data',kind=tarfile.DIRTYPE);add(n,'data/a.txt',b'alpha');add(n,'data/b.txt',kind=tarfile.LNKTYPE,link='data/a.txt');add(n,'data/c.txt',kind=tarfile.SYMTYPE,link='a.txt')
manifest=json.dumps({'formatVersion':1,'complete':True,'containers':[{'Name':'/app','Mounts':[{'Destination':'/var/data'}]}]}).encode()
with tarfile.open(sys.argv[1],'w:gz') as t:
    add(t,'images.tar',open(sys.argv[2],'rb').read());add(t,'mount-0-0.tar',nested.getvalue());add(t,'restore-guide.md',b'# Restore');add(t,'manifest.json',manifest)
`;
async function makeBackup(name,{broken=false,megabytes=3}={}){
 const filler=join(process.env.BACKUP_DIR,name+'.filler');await writeFile(filler,randomBytes(megabytes*1024*1024));
 const plain=join(process.env.BACKUP_DIR,name+'.tar.gz');
 if(broken)await writeFile(plain,Buffer.from('this is not a gzip tar'));else execFileSync(python,['-I','-c',BUILD,plain,filler]);
 const file=join(process.env.BACKUP_DIR,name+'.enc');await encryptStream(createReadStream(plain),createWriteStream(file));
 const bytes=await readFile(file);
 db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(name,site,job,new Date().toISOString(),file,bytes.length,createHash('sha256').update(bytes).digest('hex'),'{}',0,1,new Date().toISOString());
 await rm(filler);await rm(plain);
 return file;
}
async function list(dir){return (await readdir(dir,{recursive:true})).filter(name=>!/^state\.sqlite/.test(name)&&!/^backups[\\/]/.test(name)&&name!=='backups').sort();}
async function prepare(backupId){const response=await request('/backups/'+backupId+'/zip-exports',{method:'POST'});assert.equal(response.status,202);return response.json();}
async function until(backupId,exportId,status){for(let i=0;i<200;i++){const state=await (await request('/backups/'+backupId+'/zip-exports/'+exportId)).json();if(state.status===status)return state;if(state.status!=='preparing')return state;await sleep(50);}throw new Error('timeout');}
function zipEntries(bytes){
 const zip=join(directory,'check-'+id()+'.zip');
 return writeFile(zip,bytes).then(()=>JSON.parse(execFileSync(python,['-I','-c',"import json,sys,zipfile\nz=zipfile.ZipFile(sys.argv[1]);bad=z.testzip();assert bad is None,bad\nprint(json.dumps({n:z.read(n).decode('latin1') for n in z.namelist() if not n.endswith('/') and n!='recovery-originals/images.tar'}))",zip]).toString()));
}
const audits=action=>db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE action=?').get(action).n;

test('prepare verifies without writing any file, then streams a valid ZIP that can be fetched again after an interruption',async()=>{
 await makeBackup('zip-a');const before=await list(directory);
 const started=await prepare('zip-a');assert.equal(started.status,'preparing');assert.ok(started.id);
 // Starting again returns the same preparation instead of a second pass.
 assert.equal((await prepare('zip-a')).id,started.id);
 const seen=[];let state;
 for(let i=0;i<200;i++){state=await (await request('/backups/zip-a/zip-exports/'+started.id)).json();seen.push(state.bytesDone);if(state.status!=='preparing')break;assert.deepEqual(Object.keys(state).sort(),['backupId','bytesDone','bytesTotal','error','etaSeconds','expiresAt','id','status']);await sleep(20);}
 assert.equal(state.status,'ready');assert.equal(state.bytesDone,state.bytesTotal);assert.ok(state.bytesTotal>3*1024*1024);
 assert.deepEqual(seen,[...seen].sort((a,b)=>a-b),'progress never goes backwards');
 assert.ok(new Date(state.expiresAt)>new Date());
 assert.deepEqual(await list(directory),before,'preparing wrote no file');
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM downloads').get().n,0);
 // Interrupted download: read a little, then drop the connection. The token must stay usable.
 const url='/backups/zip-a/zip-exports/'+started.id+'/download';
 const partial=await request(url);assert.equal(partial.status,200);assert.equal(partial.headers.get('content-type'),'application/zip');assert.match(partial.headers.get('content-disposition'),/_full-site\.zip/);
 const reader=partial.body.getReader();await reader.read();await reader.cancel();await sleep(300);
 assert.equal((await (await request('/backups/zip-a/zip-exports/'+started.id)).json()).status,'ready');
 const full=await request(url);assert.equal(full.status,200);const bytes=Buffer.from(await full.arrayBuffer());
 assert.deepEqual(await list(directory),before,'downloading wrote no file');
 const files=await zipEntries(bytes);
 assert.match(files['START-HERE.txt'],/DockNest site backup/);
 assert.equal(files['site-files/app/var/data/a.txt'],'alpha');
 assert.match(files['site-files/app/var/data/b.txt.docknest-link.txt'],/hard link/);
 assert.match(files['site-files/app/var/data/c.txt.docknest-link.txt'],/Original Linux link/);
 for(const name of ['recovery-originals/manifest.json','recovery-originals/restore-guide.md','recovery-originals/mount-0-0.tar'])assert.ok(name in files,name);
 // A complete download ends the preparation.
 assert.equal((await (await request('/backups/zip-a/zip-exports/'+started.id)).json()).status,'expired');
 assert.equal((await request(url)).status,410);
 assert.ok(audits('backup.zip_prepare')>=1&&audits('backup.download_zip')>=2);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM downloads').get().n,0);
});

test('a backup changed between the two passes is refused or the download fails',async()=>{
 const file=await makeBackup('zip-b');const original=await stat(file),bytes=await readFile(file);
 let started=await prepare('zip-b');await until('zip-b',started.id,'ready');
 // Changed storage metadata: refused with a plain message before any byte is sent.
 await utimes(file,new Date(),new Date(original.mtimeMs+60000));
 let response=await request('/backups/zip-b/zip-exports/'+started.id+'/download');
 assert.equal(response.status,409);assert.match((await response.json()).error,/changed after it was checked/);
 assert.equal((await (await request('/backups/zip-b/zip-exports/'+started.id)).json()).status,'expired');
 // Same size and time, one flipped byte: the stream starts, then the connection is destroyed (a failed download).
 await utimes(file,original.atime,original.mtime);started=await prepare('zip-b');await until('zip-b',started.id,'ready');
 const tampered=Buffer.from(bytes);tampered[tampered.length-40]^=1;await writeFile(file,tampered);await utimes(file,original.atime,original.mtime);
 const failures=audits('backup.zip_download_failed');
 response=await request('/backups/zip-b/zip-exports/'+started.id+'/download');
 const received=[];let failed=false;
 try{const reader=response.body.getReader();for(;;){const {done,value}=await reader.read();if(done)break;received.push(Buffer.from(value));}}catch{failed=true;}
 assert.ok(failed,'the connection is destroyed');
 assert.ok(!Buffer.concat(received).includes(Buffer.from([0x50,0x4b,0x05,0x06])),'the end-of-central-directory record is never sent');
 await sleep(200);assert.equal(audits('backup.zip_download_failed'),failures+1);
 assert.deepEqual((await list(directory)).filter(name=>name.startsWith('private-exports')&&name!=='private-exports'),[]);
});

test('expiry stops new downloads but never aborts one that is streaming; storage errors stay plain',async()=>{
 await makeBackup('zip-h',{megabytes:48});
 const started=await prepare('zip-h');await until('zip-h',started.id,'ready');
 const url='/backups/zip-h/zip-exports/'+started.id+'/download';
 const response=await request(url);assert.equal(response.status,200);
 const reader=response.body.getReader();const received=[(await reader.read()).value];
 await sleep(3500);
 assert.equal((await (await request('/backups/zip-h/zip-exports/'+started.id)).json()).status,'expired');
 assert.equal((await request(url)).status,410);
 for(;;){const {done,value}=await reader.read();if(done)break;received.push(value);}
 const files=await zipEntries(Buffer.concat(received.map(c=>Buffer.from(c))));assert.equal(files['site-files/app/var/data/a.txt'],'alpha');
 const file=await makeBackup('zip-i');const again=await prepare('zip-i');await until('zip-i',again.id,'ready');
 await rm(file);
 const missing=await request('/backups/zip-i/zip-exports/'+again.id+'/download');
 assert.ok(missing.status>=400);const body=await missing.json();assert.doesNotMatch(body.error,/ENOENT|[\/]|no such file/i);assert.match(body.error,/could not be prepared/);
});

test('a tampered or invalid backup ends in failed with nothing on disk',async()=>{
 const file=await makeBackup('zip-c');const bytes=await readFile(file);bytes[60]^=1;await writeFile(file,bytes);
 const before=await list(directory);
 let started=await prepare('zip-c');let state=await until('zip-c',started.id,'failed');
 assert.equal(state.status,'failed');assert.match(state.error,/could not be verified/);
 await makeBackup('zip-d',{broken:true});started=await prepare('zip-d');state=await until('zip-d',started.id,'failed');
 assert.equal(state.status,'failed');assert.match(state.error,/not a complete DockNest package/);
 assert.deepEqual(await list(directory),before);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM downloads').get().n,0);
});

test('cancel, CSRF and one-pass-at-a-time rules',async()=>{
 await makeBackup('zip-e');
 assert.equal((await request('/backups/zip-e/zip-exports',{method:'POST',headers:{'x-csrf-token':'wrong'}})).status,403);
 assert.equal((await fetch(base+'/backups/zip-e/zip-exports',{method:'POST',headers:{Origin:process.env.APP_ORIGIN}})).status,401);
 const started=await prepare('zip-e');
 await makeBackup('zip-f');
 const busy=await request('/backups/zip-f/zip-exports',{method:'POST'});
 if(busy.status!==409)assert.equal(busy.status,202);
 const cancel=await request('/backups/zip-e/zip-exports/'+started.id,{method:'DELETE'});assert.equal(cancel.status,200);
 assert.equal((await request('/backups/zip-e/zip-exports/'+started.id)).status,404);
 assert.equal((await request('/backups/missing/zip-exports',{method:'POST'})).status,404);
 assert.equal((await request('/backups/zip-e/zip-exports/'+started.id+'/download')).status,404);
 assert.ok(audits('backup.zip_cancel')>=1);
});

test('the direct ZIP link still works for small backups',async()=>{
 await sleep(500);await makeBackup('zip-g');
 const response=await request('/backups/zip-g/download?format=zip');assert.equal(response.status,200);
 const files=await zipEntries(Buffer.from(await response.arrayBuffer()));assert.equal(files['site-files/app/var/data/a.txt'],'alpha');
 assert.equal((await request('/backups/zip-g/download?format=zip',{headers:{Range:'bytes=0-9'}})).status,416);
});

test.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();await rm(directory,{recursive:true,force:true});});
