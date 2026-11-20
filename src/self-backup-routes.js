import { Router } from 'express';
import { requireAdmin,requireRecentAuth,rateLimit } from './auth.js';
import { audit } from './db.js';
import { selfBackupStatus,saveSelfBackupSettings,enqueueSelfBackup,readLatestSelfBackup } from './self-backup.js';
import { kitCheckStatus,queueKitCheck } from './kit-check.js';
import { emergencyStatus,splitEmergencyKit,retireEmergencyKit } from './emergency/keys.js';
import { deleteOldEmergencyKits } from './emergency/kits.js';
export const selfBackupRoutes=Router();
selfBackupRoutes.use(requireAdmin);
selfBackupRoutes.get('/',(_req,res)=>res.json({...selfBackupStatus(),kitCheck:kitCheckStatus(),emergency:emergencyStatus()}));
selfBackupRoutes.post('/settings',rateLimit('manager-backup-settings',10),(req,res)=>res.json(saveSelfBackupSettings(req.body,req.user.id)));
selfBackupRoutes.post('/run',rateLimit('manager-backup-run',6),(req,res)=>res.status(202).json(enqueueSelfBackup(req.user.id)));
selfBackupRoutes.post('/kit-check',rateLimit('manager-backup-kit-check',6),(req,res)=>res.status(202).json(queueKitCheck(req.user.id)));
selfBackupRoutes.get('/download',rateLimit('manager-backup-download',10),async(req,res)=>{
 const {bytes,checksum}=await readLatestSelfBackup();audit(req.user.id,'manager-backup.download');
 res.set('X-Backup-SHA256',checksum).attachment('docknest-recovery.dkit').type('application/octet-stream').send(bytes);
});
// The optional split (docs/emergency-kit.md): administrators with a re-verification in the last 5 minutes, checked on
// the server. The parts are in the split response only, which is never cached.
selfBackupRoutes.post('/emergency/split',requireRecentAuth,rateLimit('emergency-split',10),(req,res)=>res.set('Cache-Control','no-store').json(splitEmergencyKit(req.body,req.user.id)));
selfBackupRoutes.post('/emergency/off',requireRecentAuth,rateLimit('emergency-off',10),(req,res)=>res.json(retireEmergencyKit(req.body,req.user.id)));
selfBackupRoutes.post('/emergency/delete-old-kits',requireRecentAuth,rateLimit('emergency-delete',10),async(req,res)=>res.json(await deleteOldEmergencyKits(req.user.id)));
