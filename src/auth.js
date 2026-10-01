import { Router } from 'express';
import fs from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import { db, id, audit, transaction } from './db.js';
import { config } from './config.js';
import { seal, open, passwordHash, passwordVerify, digest, base32, verifyTotp } from './crypto.js';

export const auth = Router();
export const securityPolicy = Object.freeze({ idleMinutes:30, absoluteHours:8, invitationMinutes:15, recentAuthMinutes:5 });
export const IDLE_MS = securityPolicy.idleMinutes*60_000;
export const INVITATION_MS = securityPolicy.invitationMinutes*60_000;
const ABSOLUTE_MS=securityPolicy.absoluteHours*3_600_000, RECENT_MS=securityPolicy.recentAuthMinutes*60_000;
const CHALLENGE_MS=5*60_000;
export const opaque = () => randomBytes(32).toString('base64url');
const tokenSchema=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const passwordSchema=z.string().min(1).max(256);
const cookieOptions={httpOnly:true,secure:config.secureCookies,sameSite:'strict',path:'/',maxAge:ABSOLUTE_MS};
const dummyHash=passwordHash('unavailable-credential-timing-protection');
const userView=user=>({id:user.id,name:user.name||user.email,email:user.email,role:user.role});
export const credentialEpoch=()=>Number(db.prepare("SELECT value FROM settings WHERE key='auth_epoch'").get()?.value||0);
export function sharedPasswordMatches(password){
 const row=db.prepare("SELECT value FROM settings WHERE key='shared_password_hash'").get();
 const result=passwordVerify(password,row?.value||dummyHash);
 return Boolean(row&&result);
}
export async function qrEnrollment(user){
 const secret=open(user.totp_secret);
 const uri='otpauth://totp/'+encodeURIComponent('DockNest:'+(user.name||user.email))+'?secret='+secret+'&issuer=DockNest&algorithm=SHA1&digits=6&period=30';
 const qrDataUrl=await QRCode.toDataURL(uri,{errorCorrectionLevel:'M',margin:2,width:320});
 return {secret,uri,qrDataUrl};
}
export function rateLimit(scope,limit=10,windowMs=15*60_000){
 return (req,res,next)=>{
  const key=scope+':'+req.ip,now=Date.now();
  const previous=db.prepare('SELECT * FROM rate_limits WHERE key=?').get(key);
  if(previous&&previous.reset_at>now&&previous.attempts>=limit){
   res.set('Retry-After',String(Math.ceil((previous.reset_at-now)/1000)));
   return res.status(429).json({error:'Too many attempts. Try again later.'});
  }
  db.prepare('INSERT INTO rate_limits VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts,reset_at=excluded.reset_at').run(key,previous&&previous.reset_at>now?previous.attempts+1:1,previous&&previous.reset_at>now?previous.reset_at:now+windowMs);
  next();
 };
}
function sessionTimes(row){
 return {idleExpiresAt:Math.min(row.last_activity_at+IDLE_MS,row.created_at+ABSOLUTE_MS,row.expires_at),absoluteExpiresAt:Math.min(row.created_at+ABSOLUTE_MS,row.expires_at),serverTime:Date.now()};
}
export function session(req,res,next){
 const raw=(req.headers.cookie||'').split(';').map(value=>value.trim()).find(value=>value.startsWith('dbm_session='))?.slice(12);
 if(raw&&/^[A-Za-z0-9_-]{43}$/.test(raw)){
  const row=db.prepare('SELECT sessions.*,users.email,users.name,users.role,users.enrolled,users.disabled FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=?').get(digest(raw));
  const now=Date.now();
  if(row&&!row.disabled&&row.enrolled===1&&row.expires_at>now&&row.created_at+ABSOLUTE_MS>now&&row.last_activity_at+IDLE_MS>now){
   req.user={id:row.user_id,name:row.name||row.email,email:row.email,role:row.role};req.session=row;
  }else{
   if(row)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(row.token_hash);
   req.sessionFailureCode=row?.disabled?'ACCOUNT_REVOKED':'SESSION_EXPIRED';
   res.clearCookie('dbm_session',cookieOptions);
  }
 }
 next();
}
export function requireAuth(req,res,next){return req.user?next():res.status(401).json({error:'Sign in to continue.',code:req.sessionFailureCode||'AUTH_REQUIRED'});}
export function requireAdmin(req,res,next){
 if(!req.user)return requireAuth(req,res,next);
 return req.user.role==='admin'?next():res.status(403).json({error:'Administrator access required.',code:'ADMIN_REQUIRED'});
}
export function requireRecentAuth(req,res,next){
 if(!req.user)return requireAuth(req,res,next);
 return req.session.authenticated_at+RECENT_MS>Date.now()?next():res.status(403).json({error:'Verify your own authenticator or recovery code before this change.',code:'REAUTH_REQUIRED'});
}
export function csrf(req,res,next){
 if(['GET','HEAD','OPTIONS'].includes(req.method))return next();
 const provided=req.headers['x-csrf-token'];
 if(!req.session||typeof provided!=='string'||digest(provided)!==digest(req.session.csrf_token))return res.status(403).json({error:'Your session needs to be refreshed.'});
 next();
}
function challengeFor(userId=null){
 const challenge=opaque(),now=Date.now();
 db.prepare('DELETE FROM login_challenges WHERE expires_at<=?').run(now);
 if(userId)db.prepare('DELETE FROM login_challenges WHERE user_id=?').run(userId);
 db.prepare('INSERT INTO login_challenges(token_hash,user_id,expires_at,credential_epoch) VALUES(?,?,?,?)').run(digest(challenge),userId,now+CHALLENGE_MS,credentialEpoch());
 return challenge;
}
function recoveryCodes(){return Array.from({length:10},()=>randomBytes(10).toString('hex'));}
function recoveryHash(code){
 const normalized=code.toLowerCase().replace(/[\s-]/g,'');
 return /^[a-f0-9]{20}$/.test(normalized)?digest(normalized):null;
}
function readRecovery(user){try{const values=JSON.parse(user.recovery_codes);return Array.isArray(values)?values:[];}catch{return [];}}
function factorMatch(user,code,allowRecovery=true){
 const counter=verifyTotp(open(user.totp_secret),code,-1);
 const hash=allowRecovery?recoveryHash(code):null;
 const recovery=readRecovery(user),index=hash?recovery.indexOf(hash):-1;
 return counter!==null||index!==-1?{user,counter,recovery,index}:null;
}
function consumeFactor(match){
 if(match.counter!==null){
  if(match.counter<=match.user.totp_last_counter)return false;
  const changed=db.prepare('UPDATE users SET totp_last_counter=? WHERE id=? AND disabled=0 AND totp_last_counter<?').run(match.counter,match.user.id,match.counter);
  return Boolean(changed.changes);
 }
 if(match.index<0)return false;
 match.recovery.splice(match.index,1);
 return Boolean(db.prepare('UPDATE users SET recovery_codes=? WHERE id=? AND disabled=0').run(JSON.stringify(match.recovery),match.user.id).changes);
}
function createSession(user){
 const token=opaque(),csrfToken=opaque(),now=Date.now();
 db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token),user.id,csrfToken,now+ABSOLUTE_MS,now,now,now);
 return {token,csrfToken,user:userView(user),idleExpiresAt:now+IDLE_MS,absoluteExpiresAt:now+ABSOLUTE_MS,serverTime:now};
}
function validSetupToken(provided){
 let expected;try{expected=fs.readFileSync(config.setupTokenFile,'utf8').trim();}catch{return false;}
 return Boolean(expected&&typeof provided==='string'&&timingSafeEqual(Buffer.from(digest(provided)),Buffer.from(digest(expected))));
}
async function firstEnrollment(user){
 const qr=await qrEnrollment(user);
 const current=db.prepare("SELECT * FROM users WHERE id=? AND disabled=0 AND enrolled=0 AND role='admin'").get(user.id);
 if(!current)throw Object.assign(new Error('Enrollment is no longer available.'),{status:410});
 const codes=recoveryCodes();
 db.prepare('UPDATE users SET recovery_codes=? WHERE id=? AND enrolled=0 AND disabled=0').run(JSON.stringify(codes.map(digest)),user.id);
 return {...qr,enrollmentRequired:true,recoveryCodes:codes,challenge:challengeFor(user.id)};
}
auth.get('/status',(req,res)=>{
 res.json({setupRequired:!db.prepare('SELECT 1 FROM users LIMIT 1').get(),authenticated:Boolean(req.user),securityPolicy,...(req.user?{user:req.user,csrfToken:req.session.csrf_token,...sessionTimes(req.session)}:{serverTime:Date.now()})});
});
auth.post('/setup',rateLimit('setup',5),async(req,res)=>{
 const data=z.object({email:z.email().max(254).transform(v=>v.toLowerCase()),name:z.string().trim().min(1).max(100).optional(),password:z.string().min(4).max(16),setupToken:z.string().min(1).max(256)}).parse(req.body);
 if(!validSetupToken(data.setupToken))return res.status(403).json({error:'Invalid setup token.'});
 const user=transaction(()=>{
  if(db.prepare('SELECT 1 FROM users LIMIT 1').get())throw Object.assign(new Error('Administrator already exists. Sign in instead.'),{status:409});
  const user={id:id(),email:data.email,name:data.name||data.email,role:'admin',totp_secret:seal(base32(randomBytes(20)))};
  const hash=passwordHash(data.password);
  db.prepare('INSERT INTO users(id,email,name,role,password_hash,totp_secret,recovery_codes,created_at) VALUES(?,?,?,?,?,?,?,?)').run(user.id,user.email,user.name,user.role,hash,user.totp_secret,'[]',new Date().toISOString());
  db.prepare("INSERT INTO settings(key,value) VALUES('shared_password_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(hash);
  audit(user.id,'auth.setup',user.id);
  return user;
 });
 res.status(201).json(await firstEnrollment(user));
});
auth.post('/login',rateLimit('login'),async(req,res)=>{
 const data=z.object({password:passwordSchema,setupToken:z.string().max(256).optional()}).parse(req.body);
 if(!sharedPasswordMatches(data.password)){audit('anonymous','auth.login_failed');return res.status(401).json({error:'Invalid password.'});}
 const users=db.prepare('SELECT * FROM users ORDER BY created_at,id').all();
 const pending=users[0];
 if(pending&&pending.role==='admin'&&!pending.enrolled&&!pending.disabled&&!users.some(user=>user.role==='admin'&&user.enrolled&&!user.disabled)){
  if(!validSetupToken(data.setupToken))return res.status(403).json({error:'The first administrator enrollment requires the local setup token.',code:'SETUP_RESUME_REQUIRED'});
  return res.json(await firstEnrollment(pending));
 }
 res.json({challenge:challengeFor()});
});
auth.post('/verify',rateLimit('verify',15),(req,res)=>{
 const data=z.object({challenge:tokenSchema,code:z.string().min(6).max(32)}).parse(req.body);
 const result=transaction(()=>{
  const now=Date.now(),challenge=db.prepare('SELECT * FROM login_challenges WHERE token_hash=? AND expires_at>? AND attempts<5 AND credential_epoch=?').get(digest(data.challenge),now,credentialEpoch());
  if(!challenge)return null;
  db.prepare('UPDATE login_challenges SET attempts=attempts+1 WHERE token_hash=?').run(challenge.token_hash);
  const users=challenge.user_id?db.prepare("SELECT * FROM users WHERE id=? AND disabled=0 AND role='admin'").all(challenge.user_id):db.prepare('SELECT * FROM users WHERE disabled=0 AND enrolled=1').all();
  // Identify all matches BEFORE checking replay. A reused matching code remains ambiguous.
  const matches=users.map(user=>factorMatch(user,data.code,Boolean(user.enrolled))).filter(Boolean);
  if(matches.length!==1||!consumeFactor(matches[0]))return null;
  const match=matches[0],user=match.user;
  if(!user.enrolled){
   if(!challenge.user_id||user.role!=='admin'||match.counter===null)return null;
   db.prepare('UPDATE users SET enrolled=1 WHERE id=? AND disabled=0').run(user.id);user.enrolled=1;
  }
  db.prepare('DELETE FROM login_challenges WHERE token_hash=? OR user_id=?').run(challenge.token_hash,user.id);
  const result=createSession(user);
  audit(user.id,match.index>=0?'auth.recovery_login':'auth.login',user.id);
  return result;
 });
 if(!result)return res.status(401).json({error:'Invalid, ambiguous, reused or expired code. Sign in again after five unsuccessful attempts.'});
 res.cookie('dbm_session',result.token,cookieOptions);
 const {token:_token,...view}=result;res.json(view);
});
auth.post('/reauth',requireAuth,csrf,rateLimit('reauth',10),(req,res)=>{
 const data=z.object({password:passwordSchema,code:z.string().min(6).max(32)}).parse(req.body);
 if(!sharedPasswordMatches(data.password))return res.status(401).json({error:'Invalid password or code.'});
 const result=transaction(()=>{
  const user=db.prepare('SELECT * FROM users WHERE id=? AND disabled=0 AND enrolled=1').get(req.user.id);
  const active=db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(req.session.token_hash),now=Date.now();
  if(!user||!active||active.last_activity_at+IDLE_MS<=now||active.created_at+ABSOLUTE_MS<=now||active.expires_at<=now)return false;
  const match=factorMatch(user,data.code);
  if(!match||!consumeFactor(match))return false;
  db.prepare('UPDATE sessions SET authenticated_at=?,last_activity_at=? WHERE token_hash=?').run(now,now,active.token_hash);
  audit(user.id,'auth.reauth',user.id);return {...active,authenticated_at:now,last_activity_at:now};
 });
 if(!result)return res.status(401).json({error:'Invalid password or code.'});
 res.json({reauthenticated:true,...sessionTimes(result)});
});
auth.post('/activity',requireAuth,csrf,(req,res)=>{
 const now=Date.now();
 const changed=db.prepare('UPDATE sessions SET last_activity_at=? WHERE token_hash=? AND last_activity_at>? AND created_at>? AND expires_at>? AND EXISTS(SELECT 1 FROM users WHERE users.id=sessions.user_id AND disabled=0 AND enrolled=1)').run(now,req.session.token_hash,now-IDLE_MS,now-ABSOLUTE_MS,now);
 if(!changed.changes)return res.status(401).json({error:'Session expired.',code:'SESSION_EXPIRED'});
 res.json({...sessionTimes({...req.session,last_activity_at:now})});
});
auth.post('/logout',requireAuth,csrf,(req,res)=>{
 db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.session.token_hash);
 audit(req.user.id,'auth.logout');res.clearCookie('dbm_session',cookieOptions);res.status(204).end();
});
function invitationFor(rawToken){
 return db.prepare('SELECT invitations.*,users.name,users.email,users.totp_secret,users.enrolled,users.disabled,users.role FROM invitations JOIN users ON users.id=invitations.user_id WHERE invitations.token_hash=?').get(digest(rawToken));
}
function invitationValid(invitation,now=Date.now()){
 return Boolean(invitation&&!invitation.revoked_at&&!invitation.consumed_at&&invitation.expires_at>now&&invitation.attempts<5&&!invitation.disabled&&!invitation.enrolled);
}
const inviteUnavailable=res=>res.status(410).json({error:'This invitation is expired, used, revoked or unavailable.'});
auth.post('/invite-info',rateLimit('invite-info',30),(req,res)=>{
 const data=z.object({token:tokenSchema}).parse(req.body),invitation=invitationFor(data.token);
 if(!invitationValid(invitation))return inviteUnavailable(res);
 res.json({name:invitation.name,expiresAt:invitation.expires_at,serverTime:Date.now()});
});
auth.post('/invite-start',rateLimit('invite-start',10),async(req,res)=>{
 const data=z.object({token:tokenSchema,password:passwordSchema}).parse(req.body);
 const invitation=invitationFor(data.token);
 if(!invitationValid(invitation))return inviteUnavailable(res);
 const epoch=credentialEpoch();
 if(!sharedPasswordMatches(data.password)){
  db.prepare('UPDATE invitations SET attempts=attempts+1 WHERE id=?').run(invitation.id);
  return res.status(401).json({error:'Invalid password.'});
 }
 const qr=await qrEnrollment({id:invitation.user_id,name:invitation.name,email:invitation.email,totp_secret:invitation.totp_secret});
 const enrollmentChallenge=transaction(()=>{
  const current=invitationFor(data.token);
  if(epoch!==credentialEpoch()||!invitationValid(current)||current.id!==invitation.id||current.totp_secret!==invitation.totp_secret)return null;
  const challenge=opaque();
  db.prepare('DELETE FROM enrollment_challenges WHERE invitation_id=? OR expires_at<=?').run(current.id,Date.now());
  db.prepare('INSERT INTO enrollment_challenges(token_hash,invitation_id,expires_at) VALUES(?,?,?)').run(digest(challenge),current.id,current.expires_at);
  return challenge;
 });
 if(!enrollmentChallenge)return inviteUnavailable(res);
 res.json({...qr,name:invitation.name,expiresAt:invitation.expires_at,enrollmentChallenge,serverTime:Date.now()});
});
auth.post('/invite-complete',rateLimit('invite-complete',15),(req,res)=>{
 const data=z.object({token:tokenSchema,enrollmentChallenge:tokenSchema,code:z.string().regex(/^\d{6}$/)}).parse(req.body);
 const result=transaction(()=>{
  const now=Date.now(),invitation=invitationFor(data.token);
  if(!invitationValid(invitation,now))return {unavailable:true};
  const proof=db.prepare('SELECT * FROM enrollment_challenges WHERE token_hash=? AND invitation_id=? AND expires_at>? AND attempts<5').get(digest(data.enrollmentChallenge),invitation.id,now);
  if(!proof)return {invalid:true};
  db.prepare('UPDATE invitations SET attempts=attempts+1 WHERE id=?').run(invitation.id);
  db.prepare('UPDATE enrollment_challenges SET attempts=attempts+1 WHERE token_hash=?').run(proof.token_hash);
  const user=db.prepare('SELECT * FROM users WHERE id=? AND disabled=0 AND enrolled=0').get(invitation.user_id);
  const counter=user?verifyTotp(open(user.totp_secret),data.code,user.totp_last_counter):null;
  if(counter===null)return {invalid:true};
  const codes=recoveryCodes();
  const changed=db.prepare('UPDATE users SET enrolled=1,totp_last_counter=?,recovery_codes=? WHERE id=? AND disabled=0 AND enrolled=0').run(counter,JSON.stringify(codes.map(digest)),user.id);
  if(!changed.changes)return {unavailable:true};
  db.prepare('UPDATE invitations SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL').run(now,invitation.id);
  db.prepare('DELETE FROM enrollment_challenges WHERE invitation_id IN(SELECT id FROM invitations WHERE user_id=?)').run(user.id);
  db.prepare('UPDATE invitations SET revoked_at=? WHERE user_id=? AND id<>? AND consumed_at IS NULL AND revoked_at IS NULL').run(now,user.id,invitation.id);
  audit(user.id,'auth.enrolled',user.id);
  return {enrolled:true,recoveryCodes:codes,user:userView(user)};
 });
 if(result.unavailable)return inviteUnavailable(res);
 if(result.invalid)return res.status(401).json({error:'Invalid, expired or reused enrollment proof or code.'});
 res.json(result);
});
