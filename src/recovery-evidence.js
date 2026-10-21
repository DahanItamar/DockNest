import { db,transaction } from './db.js';

const kinds=new Set(['integrity','consistency','isolatedRestore','application']);
const statuses=new Set(['passed','declared','partial','failed','not-tested']);
export function recordVerification(backupId,kind,evidence,jobId=null){
 if(!kinds.has(kind)||!statuses.has(evidence?.status))throw new Error('Invalid recovery verification');
 // Callers pass purpose-built evidence, never raw Docker inspect or credentials.
 const write=()=>{const values=[backupId,kind,evidence.status,JSON.stringify(evidence),jobId,new Date().toISOString()];db.prepare('INSERT INTO backup_verifications(backup_id,kind,status,evidence,job_id,checked_at) VALUES(?,?,?,?,?,?) ON CONFLICT(backup_id,kind) DO UPDATE SET status=excluded.status,evidence=excluded.evidence,job_id=excluded.job_id,checked_at=excluded.checked_at').run(...values);db.prepare('INSERT INTO backup_verification_history(backup_id,kind,status,evidence,job_id,checked_at) VALUES(?,?,?,?,?,?)').run(...values);};
 if(db.isTransaction)write();else transaction(write);
}
const empty=()=>Object.fromEntries([...kinds].map(kind=>[kind,{status:'not-tested'}]));
const evidence=row=>({...JSON.parse(row.evidence),status:row.status,checkedAt:row.checked_at,jobId:row.job_id});
export function backupVerification(backupId){
 const result=empty();
 for(const row of db.prepare('SELECT * FROM backup_verifications WHERE backup_id=?').all(backupId))result[row.kind]=evidence(row);
 return withLegacyIntegrity(result,db.prepare('SELECT verified FROM backups WHERE id=?').get(backupId)?.verified);
}
// List views load every requested backup's evidence in one indexed query; json_each avoids SQLite's bound-parameter limit.
// Legacy verified flags come from one more batched query, so the query count stays constant per list.
export function backupVerifications(backupIds){
 const ids=[...new Set(backupIds)],result=new Map(ids.map(backupId=>[backupId,empty()]));
 if(!ids.length)return result;
 const list=JSON.stringify(ids);
 for(const row of db.prepare('SELECT * FROM backup_verifications WHERE backup_id IN (SELECT value FROM json_each(?))').all(list))result.get(row.backup_id)[row.kind]=evidence(row);
 for(const row of db.prepare('SELECT id,verified FROM backups WHERE id IN (SELECT value FROM json_each(?))').all(list))result.set(row.id,withLegacyIntegrity(result.get(row.id),row.verified));
 return result;
}
// Display-time only: packages published before per-kind evidence carry verified=1 and no integrity row. A recorded row always wins; nothing is written.
export function withLegacyIntegrity(evidence,verified){return verified&&evidence?.integrity?.status==='not-tested'?{...evidence,integrity:{status:'passed',source:'legacy'}}:evidence;}
