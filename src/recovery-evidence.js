import { db,transaction } from './db.js';

const kinds=new Set(['integrity','consistency','isolatedRestore','application']);
const statuses=new Set(['passed','declared','partial','failed','not-tested']);
export function recordVerification(backupId,kind,evidence,jobId=null){
 if(!kinds.has(kind)||!statuses.has(evidence?.status))throw new Error('Invalid recovery verification');
 // Callers pass purpose-built evidence, never raw Docker inspect or credentials.
 transaction(()=>{const values=[backupId,kind,evidence.status,JSON.stringify(evidence),jobId,new Date().toISOString()];db.prepare('INSERT INTO backup_verifications(backup_id,kind,status,evidence,job_id,checked_at) VALUES(?,?,?,?,?,?) ON CONFLICT(backup_id,kind) DO UPDATE SET status=excluded.status,evidence=excluded.evidence,job_id=excluded.job_id,checked_at=excluded.checked_at').run(...values);db.prepare('INSERT INTO backup_verification_history(backup_id,kind,status,evidence,job_id,checked_at) VALUES(?,?,?,?,?,?)').run(...values);});
}
export function backupVerification(backupId){
 const result=Object.fromEntries([...kinds].map(kind=>[kind,{status:'not-tested'}]));
 for(const row of db.prepare('SELECT * FROM backup_verifications WHERE backup_id=?').all(backupId))result[row.kind]={...JSON.parse(row.evidence),status:row.status,checkedAt:row.checked_at,jobId:row.job_id};
 return result;
}
