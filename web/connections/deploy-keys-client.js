// The only place that knows the deploy key API (src/launches/deploy-keys.js). `api` is the app's fetch helper: api(path, body, method).
export function createDeployKeysClient(api){
 const id=x=>encodeURIComponent(x);
 return {
  list:()=>api('/deploy-keys'),
  // Reads the Git host's SSH key as the server sees it and answers {fingerprint,type}; stores nothing. With a key id
  // it also answers {changed, previous:{fingerprint,serverId,serverName,pinnedAt}} for the pinned key.
  hostKey:(a,b)=>b===undefined?api('/deploy-keys/host-key',a):api('/deploy-keys/'+id(a)+'/host-key',b),
  // The key is created only when the host key still has the confirmed fingerprint (else 409 HOST_KEY_CHANGED with hostKey.fingerprint).
  create:body=>api('/deploy-keys',body),
  // Pins the host key again; may answer replacedPin {serverId,serverName,text} when the pin moved from another server.
  repin:(keyId,body)=>api('/deploy-keys/'+id(keyId)+'/repin',body),
  remove:keyId=>api('/deploy-keys/'+id(keyId),undefined,'DELETE')
 };
}

// Request bodies. gitHost or serverId, plus allowPrivate once the owner ticked it for a Git server on their own network.
export const whereBody=({gitHost,serverId,priv})=>({...(gitHost?{gitHost}:{}),serverId,...(priv?{allowPrivate:true}:{})});
export const createBody=({name,where,fingerprint})=>({name,...where,fingerprint});
export const repinBody=({where,fingerprint})=>({...where,fingerprint});
