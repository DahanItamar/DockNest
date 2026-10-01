import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { db, id, transaction, audit } from '../src/db.js';
import { config } from '../src/config.js';
import { passwordHash, seal, open, base32, digest, verifyTotp } from '../src/crypto.js';
import { qrEnrollment } from '../src/auth.js';

async function main() {
// Secrets arrive on stdin, never in process arguments or environment variables.
let input='';for await(const chunk of process.stdin)input+=chunk;
const data=JSON.parse(input), mode=process.argv[2];
const file=path.join(config.dataDir,'admin-enrollment.html');
if(mode==='password'){
 if(typeof data.password!=='string'||data.password.length<14||data.password.length>256)throw new Error('Choose a password between 14 and 256 characters.');
 const user=transaction(()=>{
  let user=db.prepare("SELECT * FROM users WHERE role='admin' AND disabled=0 ORDER BY created_at,id LIMIT 1").get();
  if(!user){
   if(db.prepare('SELECT 1 FROM users LIMIT 1').get())throw new Error('No active administrator exists. Restore an administrator before continuing.');
   user={id:id(),email:'administrator@accounts.invalid',name:'Administrator',role:'admin',enrolled:0,totp_secret:seal(base32(randomBytes(20)))};
   db.prepare('INSERT INTO users(id,email,name,role,password_hash,totp_secret,recovery_codes,created_at) VALUES(?,?,?,?,?,?,?,?)').run(user.id,user.email,user.name,user.role,'shared-password',user.totp_secret,'[]',new Date().toISOString());
  }
  db.prepare("INSERT INTO settings(key,value) VALUES('shared_password_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(passwordHash(data.password));
  db.prepare("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='auth_epoch'").run();
  db.exec('DELETE FROM sessions; DELETE FROM login_challenges; DELETE FROM enrollment_challenges; DELETE FROM challenges;');
  db.prepare('UPDATE invitations SET revoked_at=? WHERE consumed_at IS NULL AND revoked_at IS NULL').run(Date.now());
  audit('local-console','auth.password_rotated',null,{allSessionsRevoked:true});
  return user;
 });
 if(user.enrolled){console.log(JSON.stringify({enrollmentRequired:false}));}
 else{
  const qr=await qrEnrollment(user), codes=Array.from({length:10},()=>randomBytes(10).toString('hex'));
  db.prepare('UPDATE users SET recovery_codes=? WHERE id=? AND enrolled=0').run(JSON.stringify(codes.map(digest)),user.id);
  fs.writeFileSync(file,`<!doctype html><meta charset="utf-8"><title>Administrator authenticator setup</title><style>body{font:16px system-ui;background:#fafaf9;color:#292524;max-width:580px;margin:48px auto;padding:24px}img{width:280px}code{display:block;margin:8px 0;overflow-wrap:anywhere}</style><h1>Connect your authenticator</h1><p>Scan this QR in your authenticator app, then enter its six-digit code in PowerShell.</p><img src="${qr.qrDataUrl}" alt="Administrator authenticator QR"><details><summary>Manual setup secret</summary><code>${qr.secret}</code></details><h2>Save your recovery codes</h2><p>Store these securely before completing setup. Each works only once. This temporary page is deleted after confirmation.</p>${codes.map(c=>`<code>${c}</code>`).join('')}`,{mode:0o600});
  console.log(JSON.stringify({enrollmentRequired:true,enrollmentFile:file}));
 }
}else if(mode==='confirm'){
 const success=transaction(()=>{
  const user=db.prepare("SELECT * FROM users WHERE role='admin' AND disabled=0 AND enrolled=0 ORDER BY created_at,id LIMIT 1").get();
  if(!user)return false;
  const counter=verifyTotp(open(user.totp_secret),String(data.code).trim(),user.totp_last_counter);
  if(counter===null)return false;
  db.prepare('UPDATE users SET enrolled=1,totp_last_counter=? WHERE id=?').run(counter,user.id);
  audit('local-console','auth.admin_enrolled',user.id);
  return true;
 });
 if(!success)throw new Error('Invalid authenticator code. Run setup again to retry.');
 fs.rmSync(file,{force:true});console.log(JSON.stringify({enrolled:true}));
}else throw new Error('Unknown setup operation.');
db.close();

}
main().catch(error=>{
 const safeMessages=['Choose a password between 14 and 256 characters.','No active administrator exists. Restore an administrator before continuing.','Invalid authenticator code. Run setup again to retry.','Unknown setup operation.'];
 const message=safeMessages.includes(error.message)?error.message:
  error instanceof SyntaxError?'Could not read the password input. Please rerun the PowerShell script.':
  /locked|busy/i.test(error.message)?'The database is busy. Close the running API and worker, then retry.':
  error.code==='EACCES'||error.code==='EPERM'?'Windows denied access to the project data files. Run from your Windows account and check project permissions.':
  error.code==='ENOENT'?'A required setup file is missing. Run npm.cmd run setup, then retry.':
  'Administrator setup failed. Check Node.js 24 or newer and access to the project data directory.';
 console.log(JSON.stringify({error:message}));
 process.exitCode=1;
});