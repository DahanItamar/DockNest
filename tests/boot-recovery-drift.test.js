import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
const directory=await mkdtemp(join(tmpdir(),'docknest-boot-drift-'));
Object.assign(process.env,{DATA_DIR:directory,BACKUP_DIR:join(directory,'backups'),BACKUP_STORAGE:'local',NODE_ENV:'test',MASTER_KEY_FILE:join(directory,'master.key')});
await writeFile(process.env.MASTER_KEY_FILE,randomBytes(32).toString('base64'));
const {db,audit}=await import('../src/db.js');
const {bootRecoveryBundle,bootRecoveryStatus}=await import('../src/engine.js');
test.after(async()=>{db.close();await rm(directory,{recursive:true,force:true});});

test('boot recovery copies are flagged when the installed helper bundle differs from this release',async()=>{
 const [helper,boot]=await Promise.all(['../remote/helper.py','../remote/boot_recovery.py'].map(file=>readFile(new URL(file,import.meta.url))));
 assert.equal(bootRecoveryBundle.sha256,createHash('sha256').update(helper).update('\0').update(boot).digest('hex'));
 assert.ok(bootRecoveryBundle.helperVersion>=1);
 db.exec("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES('server','fixture','host.example.invalid',22,'root','sealed','fixture','2026-01-01')");
 for(const site of ['never','legacy','current','stale'])db.prepare("INSERT INTO sites VALUES(?,'server',?,'{}','2026-01-01')").run(site,site);
 assert.deepEqual(bootRecoveryStatus('never'),{installed:false,installedAt:null,helperVersion:null,outdated:false});
 audit('administrator','boot_recovery.installed','legacy',{});
 assert.equal(bootRecoveryStatus('legacy').outdated,true,'installs recorded only by an older release need reinstalling');
 const record=db.prepare('INSERT INTO boot_recovery_installs VALUES(?,?,?,?)');
 record.run('current',bootRecoveryBundle.sha256,bootRecoveryBundle.helperVersion,'2026-10-21T00:00:00.000Z');
 record.run('stale','0'.repeat(64),1,'2026-01-01T00:00:00.000Z');
 assert.deepEqual(bootRecoveryStatus('current'),{installed:true,installedAt:'2026-10-21T00:00:00.000Z',helperVersion:bootRecoveryBundle.helperVersion,outdated:false});
 assert.equal(bootRecoveryStatus('stale').outdated,true);
});
