import { Router } from 'express';
import { z } from 'zod';
import { db, id, audit, transaction } from './db.js';
import { seal } from './crypto.js';
import { requireAdmin, requireRecentAuth, rateLimit } from './auth.js';
import { testStorageTarget, targetOptions, activeStorage, targetMode, targetPrefix, copyBytesOn } from './storage.js';
import { destinationUsage, destinationInUse, requestDestinationCopyDeletion } from './backup-copies.js';
import { isLoopback } from './storage/s3-client.js';
import { backupRoot } from './backup-layout.js';

export const storageTargets=Router();
storageTargets.use(requireAdmin);
const schema=z.object({
 name:z.string().trim().min(1).max(100),host:z.string().regex(/^[a-zA-Z0-9_.:-]{1,253}$/),port:z.number().int().min(1).max(65535).default(23),username:z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
 hostKey:z.string().regex(/^(?:[a-fA-F0-9]{64}|SHA256:[A-Za-z0-9+/]{43}=?)$/),
 authType:z.enum(['password','ssh-key']),password:z.string().min(1).max(4096).optional(),privateKey:z.string().min(50).max(30000).optional(),
 root:z.string().regex(/^\/[a-zA-Z0-9_./-]+$/).refine(value=>value!=='/'&&!value.split('/').includes('..'),'Use a dedicated absolute storage directory.'),
 capacityBytes:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1000000000000),
}).superRefine((value,ctx)=>{if(value.authType==='password'&&!value.password)ctx.addIssue({code:'custom',message:'Enter the storage password.',path:['password']});if(value.authType==='ssh-key'&&!value.privateKey)ctx.addIssue({code:'custom',message:'Enter the SSH private key.',path:['privateKey']});});
// S3 endpoints: HTTPS (plain HTTP only on loopback), no embedded credentials, query or fragment.
const endpoint=z.string().trim().max(512).transform((value,ctx)=>{
 let url;try{url=new URL(value);}catch{ctx.addIssue({code:'custom',message:'Enter the S3 endpoint as a URL, for example https://s3.eu-central-1.amazonaws.com.'});return z.NEVER;}
 if(!(url.protocol==='https:'||(url.protocol==='http:'&&isLoopback(url.hostname)))||url.username||url.password||url.search||url.hash){ctx.addIssue({code:'custom',message:'Use an HTTPS endpoint without credentials, query or fragment.'});return z.NEVER;}
 return url.origin+url.pathname.replace(/\/+$/,'');
});
const s3Schema=z.object({
 name:z.string().trim().min(1).max(100),endpoint,region:z.string().trim().regex(/^[a-z0-9-]{1,40}$/,'Enter the bucket region, for example us-east-1 (auto for Cloudflare R2).'),
 bucket:z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,'Enter a valid bucket name.'),
 prefix:z.string().trim().max(200).default('').transform(value=>value.replace(/^\/+|\/+$/g,'')).refine(value=>/^[a-zA-Z0-9_.\/-]*$/.test(value)&&!value.split('/').some(part=>part==='..'||part==='.'||(value&&!part)),'Use a simple folder prefix such as docknest or team/docknest.'),
 pathStyle:z.boolean().default(false),
 accessKeyId:z.string().trim().regex(/^[A-Za-z0-9+/=_.-]{1,128}$/,'Enter the access key ID.'),secretAccessKey:z.string().min(1).max(256),
 objectLock:z.object({mode:z.enum(['GOVERNANCE','COMPLIANCE']),days:z.number().int().min(1).max(36500)}).nullable().default(null),
});
function safe(row){
 const {credential,...rest}=row,mode=targetMode(row);
 // Main packages (a backup living only on its copies counts once, as a copy), copies held here, and recovery kits.
 const used=db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM backups WHERE path LIKE ? AND id NOT IN (SELECT backup_id FROM backup_main_removed)').get(targetPrefix({mode,id:row.id})+'%').bytes+copyBytesOn(row.id)+db.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM manager_backups WHERE status='completed' AND target_id=?").get(row.id).bytes;
 if(mode==='s3'){
  // Never return the sealed access key pair; only public connection settings.
  const settings=JSON.parse(db.prepare('SELECT settings FROM storage_target_settings WHERE target_id=?').get(row.id)?.settings||'{}');
  return {id:row.id,name:row.name,kind:'s3',status:row.status,created_at:row.created_at,last_tested_at:row.last_tested_at,endpoint:settings.endpoint,region:settings.region,bucket:settings.bucket,pathStyle:Boolean(settings.pathStyle),objectLock:settings.objectLock||null,root:row.root,hasCredential:Boolean(credential),trackedBytes:used};
 }
 return {...rest,kind:'sftp',hasCredential:Boolean(credential),trackedBytes:used};
}
storageTargets.get('/',(_req,res)=>res.json({targets:db.prepare('SELECT * FROM storage_targets ORDER BY created_at').all().map(safe),activeTargetId:activeStorage().id}));
storageTargets.get('/:id/tree',(req,res)=>{
 const target=db.prepare('SELECT id,root,auth_type FROM storage_targets WHERE id=?').get(req.params.id);
 if(!target)return res.status(404).json({error:'Storage destination not found.'});
 const prefix=targetPrefix({mode:targetMode(target),id:target.id});
 const rows=db.prepare(`SELECT b.id,b.captured_at,b.size,b.pinned,b.verified,b.path,s.id AS site_id,s.name AS site_name,v.id AS server_id,v.name AS server_name
 FROM backups b JOIN sites s ON s.id=b.site_id JOIN servers v ON v.id=s.server_id
 WHERE b.path LIKE ? ORDER BY b.captured_at DESC LIMIT 1001`).all(prefix+'%');
 const limited=rows.length>1000;if(limited)rows.pop();
 const servers=new Map();
 for(const row of rows){
  if(!servers.has(row.server_id))servers.set(row.server_id,{id:row.server_id,name:row.server_name,sites:new Map()});
  const server=servers.get(row.server_id);
  if(!server.sites.has(row.site_id))server.sites.set(row.site_id,{id:row.site_id,name:row.site_name,days:new Map()});
  const site=server.sites.get(row.site_id),day=row.captured_at.slice(0,10);
  if(!site.days.has(day))site.days.set(day,{date:day,backups:[]});
  const root=prefix+target.root+'/';
  site.days.get(day).backups.push({id:row.id,capturedAt:row.captured_at,size:row.size,pinned:Boolean(row.pinned),verified:Boolean(row.verified),filename:row.path.slice(row.path.lastIndexOf('/')+1),relativePath:row.path.startsWith(root)?row.path.slice(root.length):null});
 }
 const latest=db.prepare("SELECT id FROM manager_backups WHERE status='completed' ORDER BY rowid DESC LIMIT 1").get();
 const kits=db.prepare("SELECT id,created_at,size,path FROM manager_backups WHERE status='completed' AND target_id=? AND path IS NOT NULL ORDER BY rowid DESC LIMIT 1001").all(target.id);
 const recoveryLimited=kits.length>1000;if(recoveryLimited)kits.pop();
 const root=prefix+target.root+'/';
 const recovery={folder:'docknest-recovery',limited:recoveryLimited,files:kits.map(row=>({id:row.id,createdAt:row.created_at,size:row.size,filename:row.path.slice(row.path.lastIndexOf('/')+1),relativePath:row.path.startsWith(root)?row.path.slice(root.length):null,downloadable:row.id===latest?.id}))};
 res.json({root:target.root,managedRoot:backupRoot(target.root),limited,recovery,servers:[...servers.values()].map(server=>({...server,sites:[...server.sites.values()].map(site=>({...site,days:[...site.days.values()]}))}))});
});
storageTargets.post('/connect',rateLimit('storage-connect',10),async(req,res)=>{
 const data=schema.parse(req.body),targetId=id(),hostKey=data.hostKey.startsWith('SHA256:')?Buffer.from(data.hostKey.slice(7),'base64').toString('hex'):data.hostKey.toLowerCase();
 const root=data.root.replace(/\/+$/,'');
 await testStorageTarget({host:data.host,port:data.port,username:data.username,hostKey,root,...(data.authType==='password'?{password:data.password}:{privateKey:data.privateKey})});
 const credential=seal(data.authType==='password'?data.password:data.privateKey),now=new Date().toISOString();
 transaction(()=>{
  db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(targetId,data.name,data.host,data.port,data.username,hostKey,data.authType,credential,root,data.capacityBytes,'connected',now,now);
  db.prepare("INSERT OR IGNORE INTO settings VALUES('backup_storage_target',?)").run(targetId);
  audit(req.user.id,'storage.connected',targetId,{authType:data.authType});
 });
 res.status(201).json(safe(db.prepare('SELECT * FROM storage_targets WHERE id=?').get(targetId)));
});
storageTargets.post('/s3/connect',rateLimit('storage-connect',10),async(req,res)=>{
 const data=s3Schema.parse(req.body),targetId=id(),url=new URL(data.endpoint),root='/'+data.prefix;
 const settings={endpoint:data.endpoint,region:data.region,bucket:data.bucket,pathStyle:data.pathStyle,objectLock:data.objectLock};
 await testStorageTarget({mode:'s3',id:targetId,name:data.name,...settings,root,accessKeyId:data.accessKeyId,secretAccessKey:data.secretAccessKey});
 const credential=seal(JSON.stringify({accessKeyId:data.accessKeyId,secretAccessKey:data.secretAccessKey})),now=new Date().toISOString();
 transaction(()=>{
  db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(targetId,data.name,url.hostname,Number(url.port)||(url.protocol==='https:'?443:80),data.bucket,'','s3-access-key',credential,root,0,'connected',now,now);
  db.prepare("INSERT INTO storage_target_settings VALUES(?,'s3',?)").run(targetId,JSON.stringify(settings));
  db.prepare("INSERT OR IGNORE INTO settings VALUES('backup_storage_target',?)").run(targetId);
  audit(req.user.id,'storage.connected',targetId,{authType:'s3-access-key',objectLock:data.objectLock?.mode||null});
 });
 res.status(201).json(safe(db.prepare('SELECT * FROM storage_targets WHERE id=?').get(targetId)));
});
// Removing a destination (docs/backup-copies.md, "Safety rules"). Refused while it holds copies, is a site's main or copy
// destination, holds main packages or recovery kits, or is the default. "Move them" is not offered: storage migration
// only re-lays files out within one destination, so copies held here have to be deleted first (POST /:id/copies/delete).
function knownTarget(req){const target=db.prepare('SELECT id,name FROM storage_targets WHERE id=?').get(req.params.id);if(!target)throw Object.assign(new Error('Storage destination not found.'),{status:404});return target;}
storageTargets.get('/:id/usage',(req,res)=>{const target=knownTarget(req);res.json(destinationUsage(target.id));});
storageTargets.delete('/:id',requireRecentAuth,(req,res)=>{
 const target=knownTarget(req);
 const removed=transaction(()=>{
  const usage=destinationUsage(target.id);
  if(destinationInUse(usage)){
   const reasons=[usage.copies?`it holds ${usage.copies} backup ${usage.copies===1?'copy':'copies'} (delete these copies first; moving copies to another destination is not supported)`:null,usage.mainForSites.length?`it is the main destination of ${usage.mainForSites.length} ${usage.mainForSites.length===1?'site':'sites'}`:null,usage.copyForSites.length?`${usage.copyForSites.length} ${usage.copyForSites.length===1?'site copies':'sites copy'} to it`:null,usage.mainBackups?`it holds ${usage.mainBackups} main ${usage.mainBackups===1?'backup':'backups'}`:null,usage.recoveryKits?'it holds DockNest recovery kits':null,usage.isDefault?'it is the default destination':null].filter(Boolean);
   return {usage,refused:`${target.name} cannot be removed: ${reasons.join('; ')}.`};
  }
  db.prepare('DELETE FROM storage_targets WHERE id=?').run(target.id);
  audit(req.user.id,'storage.removed',target.id,{name:target.name});
  return {removed:true};
 });
 if(removed.refused)return res.status(409).json({error:removed.refused,code:'destination_in_use',...removed.usage});
 res.json({id:target.id,removed:true});
});
storageTargets.post('/:id/copies/delete',requireRecentAuth,(req,res)=>{
 const target=knownTarget(req),data=z.object({includePinned:z.boolean().default(false)}).parse(req.body??{});
 try{res.status(202).json(requestDestinationCopyDeletion(target.id,data,req.user.id));}
 catch(error){if(error.code==='pinned_copies')return res.status(409).json({error:error.message,code:error.code,pinned:error.pinned});throw error;}
});
storageTargets.post('/:id/test',rateLimit('storage-test',10),async(req,res)=>{
 const result=await testStorageTarget(targetOptions(req.params.id));
 db.prepare("UPDATE storage_targets SET status='connected',last_tested_at=? WHERE id=?").run(new Date().toISOString(),req.params.id);
 audit(req.user.id,'storage.test',req.params.id);res.json(result);
});
storageTargets.post('/:id/use',async(req,res)=>{
 const options=targetOptions(req.params.id);
 await testStorageTarget(options);
 transaction(()=>{
  db.prepare("INSERT INTO settings VALUES('backup_storage_target',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(req.params.id);
  audit(req.user.id,'storage.selected',req.params.id);
 });
 res.json({activeTargetId:req.params.id});
});
