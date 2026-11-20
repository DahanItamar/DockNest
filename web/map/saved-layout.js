// Moved nodes are kept in this browser, per account, so the Map opens the way it was left. Tidy up clears it.
// Only {x,y} pairs of finite, sensible numbers under a node key are read back, so an old or edited value never breaks the Map.
const LIMIT=100000,NODE=/^(server|site|storage|alert|docknest):./;
const keyOf=userId=>'docknest-map-layout:'+(userId||'');
const ok=v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=LIMIT;

export function cleanPositions(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return {};
 return Object.fromEntries(Object.entries(value).filter(([k,p])=>NODE.test(k)&&p&&ok(p.x)&&ok(p.y)).map(([k,p])=>[k,{x:p.x,y:p.y}]));
}
export function loadPositions(userId){
 try{return cleanPositions(JSON.parse(localStorage.getItem(keyOf(userId))||'{}'))}catch{return {}}
}
export function savePositions(userId,positions){
 try{if(Object.keys(positions).length)localStorage.setItem(keyOf(userId),JSON.stringify(positions));else localStorage.removeItem(keyOf(userId))}catch{}
}
// Drops positions of nodes that no longer exist. known: {server, site, storage, alert} as id lists, or null while that kind is not
// loaded yet (its positions are kept until it is). Returns the same object when nothing is dropped.
export function prunePositions(positions,known){
 const ids=Object.fromEntries(Object.entries(known).map(([kind,list])=>[kind,list&&new Set(list)]));
 const keep=Object.entries(positions).filter(([key])=>{const at=key.indexOf(':'),set=ids[key.slice(0,at)];return !set||set.has(key.slice(at+1))});
 return keep.length===Object.keys(positions).length?positions:Object.fromEntries(keep);
}
