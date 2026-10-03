import { Router } from 'express';
import { requireAdmin,rateLimit } from './auth.js';
import { audit } from './db.js';
import { selfBackupStatus,saveSelfBackupSettings,enqueueSelfBackup,readLatestSelfBackup } from './self-backup.js';
export const selfBackupRoutes=Router();
selfBackupRoutes.use(requireAdmin);
selfBackupRoutes.get('/',(_req,res)=>res.json(selfBackupStatus()));
selfBackupRoutes.post('/settings',rateLimit('manager-backup-settings',10),(req,res)=>res.json(saveSelfBackupSettings(req.body,req.user.id)));
selfBackupRoutes.post('/run',rateLimit('manager-backup-run',6),(req,res)=>res.status(202).json(enqueueSelfBackup(req.user.id)));
selfBackupRoutes.get('/download',rateLimit('manager-backup-download',10),async(req,res)=>{
 const {bytes,checksum}=await readLatestSelfBackup();audit(req.user.id,'manager-backup.download');
 res.set('X-Backup-SHA256',checksum).attachment('docknest-recovery.dkit').type('application/octet-stream').send(bytes);
});
