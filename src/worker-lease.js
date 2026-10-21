// Single-worker lease kept in SQLite. Liveness comes from renewal, not from a PID or lock file, so a SIGKILLed
// worker cannot block its replacement forever: the lease expires and the next worker takes it over.
export const LEASE_NAME='worker',LEASE_TTL_MS=60000;
const tx=(database,work)=>{database.exec('BEGIN IMMEDIATE');try{const result=work();database.exec('COMMIT');return result;}catch(error){database.exec('ROLLBACK');throw error;}};
export const readLease=(database,name=LEASE_NAME)=>database.prepare('SELECT name,holder,acquired_at,renewed_at,expires_at FROM worker_lease WHERE name=?').get(name);
// Atomic: BEGIN IMMEDIATE serializes writers, so two workers can never both see a free or expired row.
export function acquireLease(database,holder,{name=LEASE_NAME,ttl=LEASE_TTL_MS,now=Date.now()}={}){
 return tx(database,()=>{const current=readLease(database,name);
  if(current&&current.holder!==holder&&current.expires_at>now)return {acquired:false,lease:current};
  const at=new Date(now).toISOString();
  database.prepare('INSERT INTO worker_lease(name,holder,acquired_at,renewed_at,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,acquired_at=excluded.acquired_at,renewed_at=excluded.renewed_at,expires_at=excluded.expires_at').run(name,holder,at,at,now+ttl);
  return {acquired:true,takeover:Boolean(current&&current.holder!==holder),previous:current||null,lease:readLease(database,name)};});
}
// Renewal only succeeds for the current holder; false means another process took the lease after it expired.
export const renewLease=(database,holder,{name=LEASE_NAME,ttl=LEASE_TTL_MS,now=Date.now()}={})=>database.prepare('UPDATE worker_lease SET renewed_at=?,expires_at=? WHERE name=? AND holder=?').run(new Date(now).toISOString(),now+ttl,name,holder).changes===1;
export const releaseLease=(database,holder,{name=LEASE_NAME}={})=>database.prepare('DELETE FROM worker_lease WHERE name=? AND holder=?').run(name,holder).changes===1;
