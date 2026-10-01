import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

test('local password setup requires confirmed TOTP and preserves enrolled administrator on rotation',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dbm-console-'));
 const key=path.join(dir,'master.key');fs.writeFileSync(key,randomBytes(32).toString('base64'));
 const env={...process.env,NODE_ENV:'development',DATA_DIR:dir,BACKUP_DIR:path.join(dir,'backups'),MASTER_KEY_FILE:key,APP_ORIGIN:'http://127.0.0.1:3000',SECURE_COOKIES:'false'};
 const run=(mode,data)=>spawnSync(process.execPath,['scripts/admin-password.js',mode],{env,input:JSON.stringify(data),encoding:'utf8'});
 let connection;
 try{
  assert.notEqual(run('password',{password:'123'}).status,0);
  assert.notEqual(run('password',{password:'12345678901234567'}).status,0);
  const bootstrap=run('password',{password:'1234'});assert.equal(bootstrap.status,0,bootstrap.stderr);
  const result=JSON.parse(bootstrap.stdout);assert.equal(result.enrollmentRequired,true);assert.equal(fs.existsSync(result.enrollmentFile),true);
  connection=new DatabaseSync(path.join(dir,'state.sqlite'));
  const user=connection.prepare('SELECT * FROM users').get();assert.equal(user.enrolled,0);
  process.env.MASTER_KEY_FILE=key;
  const {open,totp,passwordVerify}=await import('../src/crypto.js');
  const secret=open(user.totp_secret), code=totp(secret);
  assert.equal(run('confirm',{code}).status,0);
  assert.equal(connection.prepare('SELECT enrolled FROM users').get().enrolled,1);
  assert.equal(fs.existsSync(result.enrollmentFile),false);
  connection.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run('test-session',user.id,'csrf',Date.now()+10000,Date.now(),Date.now(),Date.now());
  const rotation=run('password',{password:'1234567890123456'});assert.equal(rotation.status,0,rotation.stderr);
  assert.equal(JSON.parse(rotation.stdout).enrollmentRequired,false);
  assert.equal(connection.prepare('SELECT totp_secret FROM users').get().totp_secret,user.totp_secret);
  assert.equal(connection.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
  const hash=connection.prepare("SELECT value FROM settings WHERE key='shared_password_hash'").get().value;
  assert.equal(passwordVerify('1234567890123456',hash),true);
  assert.equal(passwordVerify('1234',hash),false);
 }finally{connection?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
