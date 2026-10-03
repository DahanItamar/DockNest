import { Router } from 'express';
import { z } from 'zod';
import { db, id, audit, transaction } from './db.js';
import { seal } from './crypto.js';
import { requireAdmin, rateLimit } from './auth.js';
import { testStorageTarget, targetOptions, activeStorage } from './storage.js';

export const storageTargets=Router();
storageTargets.use(requireAdmin);
const schema=z.object({
 name:z.string().trim().min(1).max(100),host:z.string().regex(/^[a-zA-Z0-9_.:-]{1,253}$/),port:z.number().int().min(1).max(65535).default(23),username:z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
 hostKey:z.string().regex(/^(?:[a-fA-F0-9]{64}|SHA256:[A-Za-z0-9+/]{43}=?)$/),
 authType:z.enum(['password','ssh-key']),password:z.string().min(1).max(4096).optional(),privateKey:z.string().min(50).max(30000).optional(),
 root:z.string().regex(/^\/[a-zA-Z0-9_./-]+$/).refine(value=>value!=='/'&&!value.split('/').includes('..'),'Use a dedicated absolute storage directory.'),
 capacityBytes:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1000000000000),
}).superRefine((value,ctx)=>{if(value.authType==='password'&&!value.password)ctx.addIssue({code:'custom',message:'Enter the storage password.',path:['password']});if(value.authType==='ssh-key'&&!value.privateKey)ctx.addIssue({code:'custom',message:'Enter the SSH private key.',path:['privateKey']});});
function safe(row){
 const {credential,...rest}=row;
 const used=db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM backups WHERE path LIKE ?').get('sftp:'+row.id+':%').bytes+db.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM manager_backups WHERE status='completed' AND target_id=?").get(row.id).bytes;
 return {...rest,hasCredential:Boolean(credential),trackedBytes:used};
}
storageTargets.get('/',(_req,res)=>res.json({targets:db.prepare('SELECT * FROM storage_targets ORDER BY created_at').all().map(safe),activeTargetId:activeStorage().id}));
storageTargets.get('/:id/tree',(req,res)=>{
 const target=db.prepare('SELECT id,root FROM storage_targets WHERE id=?').get(req.params.id);
 if(!target)return res.status(404).json({error:'Storage destination not found.'});
 const prefix='sftp:'+target.id+':';
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
  site.days.get(day).backups.push({id:row.id,capturedAt:row.captured_at,size:row.size,pinned:Boolean(row.pinned),verified:Boolean(row.verified),relativePath:row.path.startsWith(root)?row.path.slice(root.length):null});
 }
 res.json({root:target.root,limited,servers:[...servers.values()].map(server=>({...server,sites:[...server.sites.values()].map(site=>({...site,days:[...site.days.values()]}))}))});
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
