import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
const temp = await mkdtemp(path.join(tmpdir(), 'dbm-access-'));
Object.assign(process.env, { DATA_DIR: temp, BACKUP_DIR: path.join(temp,'backups'),
  MASTER_KEY_FILE: path.join(temp,'master.key'), SETUP_TOKEN_FILE: path.join(temp,'setup.token'),
  SECURE_COOKIES:'false', NODE_ENV:'test', APP_ORIGIN:'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await writeFile(process.env.SETUP_TOKEN_FILE, 'access-test-setup-token');
const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { totp, digest, seal } = await import('../src/crypto.js');
const server = app.listen(0,'127.0.0.1');
await new Promise(resolve => server.once('listening',resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
const password = 'shared-access-test-passphrase';
let admin, initial;
async function request(route, body, actor) {
  // Each scenario checks its own security invariant, independently of global throttle counters.
  db.prepare('DELETE FROM rate_limits').run();
  const response = await fetch(base+route,{method:body === undefined?'GET':'POST',headers:{
    'Content-Type':'application/json',Origin:process.env.APP_ORIGIN,
    ...(actor?{Cookie:actor.cookie,'x-csrf-token':actor.csrfToken}:{})
  },...(body === undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,data:await response.json().catch(()=>null),cookie:response.headers.get('set-cookie')};
}
function actor(response) {
  assert.equal(response.status,200,JSON.stringify(response.data));
  return {cookie:response.cookie.split(';')[0],csrfToken:response.data.csrfToken,user:response.data.user};
}
async function login(code, pass=password) {
  const challenge = await request('/auth/login',{password:pass});
  assert.equal(challenge.status,200,JSON.stringify(challenge.data));
  return request('/auth/verify',{challenge:challenge.data.challenge,code});
}
function token(invitation) {return decodeURIComponent(invitation.url.split('/enroll/')[1]);}
async function invite(name) {
  const result=await request('/access/invitations',{name},admin);
  assert.equal(result.status,201,JSON.stringify(result.data));
  assert.ok(result.data.expiresAt > Date.now() && result.data.expiresAt <= Date.now()+15*60_000, 'invitation has a 15-minute deadline');
  return result.data;
}
async function enroll(invitation) {
  const started=await request('/auth/invite-start',{token:token(invitation),password});
  assert.equal(started.status,200,JSON.stringify(started.data));
  assert.match(started.data.qrDataUrl,/^data:image\/png;base64,/);
  const uri=new URL(started.data.uri);
  assert.equal(uri.protocol,'otpauth:');
  assert.equal(uri.searchParams.get('secret'),started.data.secret);
  const completed=await request('/auth/invite-complete',{token:token(invitation),code:totp(started.data.secret),enrollmentChallenge:started.data.enrollmentChallenge});
  assert.equal(completed.status,200,JSON.stringify(completed.data));
  assert.equal(completed.data.enrolled,true);
  assert.ok(completed.data.recoveryCodes.length>0);
  return {...started.data,...completed.data};
}
test.before(async()=>{
  initial=await request('/auth/setup',{name:'Owner',email:'owner@example.org',password,setupToken:'access-test-setup-token'});
  assert.equal(initial.status,201);
  admin=actor(await request('/auth/verify',{challenge:initial.data.challenge,code:totp(initial.data.secret)}));
});
test('shared password requires per-person factor; invitations activate only after verified enrollment',async()=>{
  const invitation=await invite('Alice Operator');
  const pending=await request('/auth/login',{password});
  assert.equal(pending.status,200);
  assert.equal((await request('/state')).status,401);
  const start=await request('/auth/invite-start',{token:token(invitation),password});
  const challenge=await request('/auth/login',{password});
  assert.equal((await request('/auth/verify',{challenge:challenge.data.challenge,code:totp(start.data.secret)})).status,401);
  assert.equal((await request('/auth/invite-start',{token:token(invitation),password:'wrong'})).status,401);
  assert.ok([400,401].includes((await request('/auth/invite-complete',{token:token(invitation),code:totp(start.data.secret)})).status), 'password verification proof is required');
  assert.equal((await request('/auth/invite-complete',{token:token(invitation),enrollmentChallenge:start.data.enrollmentChallenge,code:totp(start.data.secret,Math.floor(Date.now()/30_000)+10)})).status,401, 'a distant future code must not enroll');
  const enrolled=await enroll(invitation);
  db.prepare('UPDATE users SET totp_last_counter=-1 WHERE id=?').run(invitation.userId);
  const loginCode=totp(enrolled.secret);
  const factorUser=actor(await login(loginCode));
  assert.equal(factorUser.user.name,'Alice Operator');
  assert.equal((await login(loginCode)).status,401,'successful TOTP cannot be replayed');
  db.prepare('UPDATE invitations SET expires_at=? WHERE id=?').run(Date.now()-1,invitation.id);
  const user=actor(await login(enrolled.recoveryCodes[0]));
  assert.equal(user.user.name,'Alice Operator');
  assert.equal(user.user.role,'operator');
  assert.equal((await request('/access',undefined,user)).status,403);
  assert.equal((await request('/access/invitations',{name:'Forbidden'},user)).status,403);
  assert.equal((await request('/servers',{name:'Forbidden host'},user)).status,403);
  assert.equal((await request('/auth/invite-info',{token:token(invitation)})).status,410);
});
test('expired, revoked and regenerated invitations cannot be redeemed',async()=>{
  const invitation=await invite('Expired Person');
  db.prepare('UPDATE invitations SET expires_at=? WHERE id=?').run(Date.now()-1,invitation.id);
  assert.equal((await request('/auth/invite-info',{token:token(invitation)})).status,410);
  assert.equal((await request('/auth/invite-start',{token:token(invitation),password})).status,410);
  assert.equal((await request('/auth/invite-complete',{token:token(invitation),code:'123456',enrollmentChallenge:'x'.repeat(43)})).status,410);
  const old=await invite('Regenerated Person');
  const replacement=await request('/access/users/'+old.userId+'/invitation',{},admin);
  assert.equal(replacement.status,201);
  assert.equal((await request('/auth/invite-info',{token:token(old)})).status,410);
  assert.equal((await request('/auth/invite-info',{token:token(replacement.data)})).status,200);
  assert.equal((await request('/access/invitations/'+replacement.data.id+'/revoke',{},admin)).status,200);
  assert.equal((await request('/auth/invite-info',{token:token(replacement.data)})).status,410);
});
test('enrollment proofs cannot outlive invitation expiry or revocation',async()=>{
  const expired=await invite('Proof Expiry Person');
  const started=await request('/auth/invite-start',{token:token(expired),password});
  assert.equal(started.status,200);
  db.prepare('UPDATE invitations SET expires_at=? WHERE id=?').run(Date.now()-1,expired.id);
  assert.equal((await request('/auth/invite-complete',{token:token(expired),enrollmentChallenge:started.data.enrollmentChallenge,code:totp(started.data.secret)})).status,410);
  assert.equal(db.prepare('SELECT enrolled FROM users WHERE id=?').get(expired.userId).enrolled,0);
  const revoked=await invite('Proof Revocation Person');
  const proof=await request('/auth/invite-start',{token:token(revoked),password});
  assert.equal(proof.status,200);
  assert.equal((await request('/access/invitations/'+revoked.id+'/revoke',{},admin)).status,200);
  assert.equal((await request('/auth/invite-complete',{token:token(revoked),enrollmentChallenge:proof.data.enrollmentChallenge,code:totp(proof.data.secret)})).status,410);
  assert.equal(db.prepare('SELECT enrolled FROM users WHERE id=?').get(revoked.userId).enrolled,0);
  const disabled=await invite('Pending Revoked Person');
  const disabledProof=await request('/auth/invite-start',{token:token(disabled),password});
  assert.equal(disabledProof.status,200);
  assert.equal((await request('/access/users/'+disabled.userId+'/revoke',{confirmation:'Pending Revoked Person'},admin)).status,200);
  assert.equal((await request('/auth/invite-complete',{token:token(disabled),enrollmentChallenge:disabledProof.data.enrollmentChallenge,code:totp(disabledProof.data.secret)})).status,410);
  assert.equal((await request('/access/users/'+admin.user.id+'/revoke',{confirmation:admin.user.name},admin)).status,409,'administrator cannot revoke themselves');
});

test('revocation immediately invalidates sessions and blocks factor-based login',async()=>{
  const invitation=await invite('Revoked Person'), enrollment=await enroll(invitation);
  const user=actor(await login(enrollment.recoveryCodes[0]));
  assert.equal((await request('/state',undefined,user)).status,200);
  assert.equal((await request('/access/users/'+user.user.id+'/revoke',{confirmation:'Revoked Person'},admin)).status,200);
  assert.equal((await request('/state',undefined,user)).status,401);
  assert.equal((await login(enrollment.recoveryCodes[1])).status,401);
  assert.equal(db.prepare('SELECT disabled FROM users WHERE id=?').get(user.user.id).disabled,1);
});
test('server enforces idle and absolute expiry; polling does not count as activity',async()=>{
  const invitation=await invite('Idle Person'), enrollment=await enroll(invitation);
  const user=actor(await login(enrollment.recoveryCodes[0]));
  const hash=digest(user.cookie.split('=')[1]), now=Date.now();
  db.prepare('UPDATE sessions SET last_activity_at=? WHERE token_hash=?').run(now-10*60_000,hash);
  const old=db.prepare('SELECT last_activity_at FROM sessions WHERE token_hash=?').get(hash).last_activity_at;
  assert.equal((await request('/state',undefined,user)).status,200);
  assert.equal(db.prepare('SELECT last_activity_at FROM sessions WHERE token_hash=?').get(hash).last_activity_at,old);
  assert.equal((await request('/auth/activity',{},user)).status,200);
  assert.ok(db.prepare('SELECT last_activity_at FROM sessions WHERE token_hash=?').get(hash).last_activity_at>old);
  db.prepare('UPDATE sessions SET last_activity_at=? WHERE token_hash=?').run(now-31*60_000,hash);
  assert.equal((await request('/auth/activity',{},user)).status,401);
  assert.equal((await request('/state',undefined,user)).status,401);
  const fresh=actor(await login(enrollment.recoveryCodes[1]));
  db.prepare('UPDATE sessions SET created_at=?,last_activity_at=? WHERE token_hash=?').run(now-9*60*60_000,now,digest(fresh.cookie.split('=')[1]));
  assert.equal((await request('/state',undefined,fresh)).status,401);
});
test('ambiguous authenticator factors fail closed',async()=>{
  const one=await invite('Collision One'), two=await invite('Collision Two');
  const first=await enroll(one), second=await enroll(two);
  db.prepare('UPDATE users SET totp_secret=?,totp_last_counter=-1 WHERE id IN (?,?)').run(seal(first.secret),one.userId,two.userId);
  assert.equal((await login(totp(first.secret))).status,401);
  db.prepare('UPDATE users SET totp_last_counter=? WHERE id=?').run(Math.floor(Date.now()/30_000),one.userId);
  assert.equal((await login(totp(first.secret))).status,401,'collision remains ambiguous even when one account has consumed the code');
  // Restore the second identity's independent secret so subsequent tests are isolated.
  db.prepare('UPDATE users SET totp_secret=? WHERE id=?').run(seal(second.secret),two.userId);
});
test('sensitive administration requires recent own-factor proof and password rotation signs out everyone',async()=>{
  const hash=digest(admin.cookie.split('=')[1]);
  db.prepare('UPDATE sessions SET authenticated_at=? WHERE token_hash=?').run(Date.now()-6*60_000,hash);
  const stale=await request('/access/invitations',{name:'Needs reauth'},admin);
  assert.equal(stale.status,403);
  assert.equal(stale.data.code,'REAUTH_REQUIRED');
  // Avoid waiting for a real TOTP clock tick; rewind only the stored replay counter in this isolated fixture.
  db.prepare('UPDATE users SET totp_last_counter=-1 WHERE id=?').run(admin.user.id);
  assert.equal((await request('/auth/reauth',{password,code:totp(initial.data.secret)},admin)).status,200);
  const invitation=await invite('Rotation Person'), enrolled=await enroll(invitation);
  const user=actor(await login(enrolled.recoveryCodes[0]));
  const pending=await invite('Rotation Pending Person');
  const pendingProof=await request('/auth/invite-start',{token:token(pending),password});
  assert.equal(pendingProof.status,200);
  const pendingLogin=await request('/auth/login',{password});
  const changed=await request('/access/password',{currentPassword:password,newPassword:'rotated-unique-long-passphrase'},admin);
  assert.equal(changed.status,200);
  assert.equal((await request('/auth/invite-complete',{token:token(pending),enrollmentChallenge:pendingProof.data.enrollmentChallenge,code:totp(pendingProof.data.secret)})).status,410);
  assert.equal((await request('/auth/verify',{challenge:pendingLogin.data.challenge,code:enrolled.recoveryCodes[1]})).status,401);
  assert.equal(db.prepare('SELECT enrolled FROM users WHERE id=?').get(pending.userId).enrolled,0);
  assert.equal((await request('/state',undefined,user)).status,401);
  assert.equal((await request('/state',undefined,admin)).status,401);
  assert.equal((await request('/auth/login',{password})).status,401);
  assert.equal((await request('/auth/login',{password:'rotated-unique-long-passphrase'})).status,200);
});
test('legacy database migration preserves the first administrator password',async()=>{
  const { DatabaseSync } = await import('node:sqlite');
  const { passwordHash, passwordVerify } = await import('../src/crypto.js');
  const { mkdir } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const directory=path.join(temp,'legacy');
  await mkdir(directory,{recursive:true});
  const legacy=new DatabaseSync(path.join(directory,'state.sqlite'));
  legacy.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,totp_secret TEXT NOT NULL,totp_last_counter INTEGER NOT NULL DEFAULT -1,recovery_codes TEXT NOT NULL,enrolled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf_token TEXT NOT NULL,expires_at INTEGER NOT NULL);`);
  const previousHash=passwordHash('preserved-legacy-password');
  legacy.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at) VALUES(?,?,?,?,?,1,?)').run('legacy-admin','legacy@example.org',previousHash,seal(initial.data.secret),'[]','2025-01-01T00:00:00.000Z');
  legacy.close();
  const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',`
    process.env.DATA_DIR=${JSON.stringify(directory)};
    process.env.BACKUP_DIR=${JSON.stringify(path.join(directory,'backups'))};
    const {db}=await import('./src/db.js');
    console.log(JSON.stringify({user:db.prepare('SELECT id,role FROM users WHERE id=?').get('legacy-admin'),hash:db.prepare('SELECT value FROM settings WHERE key=?').get('shared_password_hash').value}));
    db.close();
  `],{cwd:path.resolve(import.meta.dirname,'..'),env:process.env});
  const migrated=JSON.parse(result.stdout.trim());
  assert.equal(migrated.user.role,'admin');
  assert.equal(migrated.hash,previousHash);
  assert.equal(passwordVerify('preserved-legacy-password',migrated.hash),true);
});

test.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();await rm(temp,{recursive:true,force:true});});
