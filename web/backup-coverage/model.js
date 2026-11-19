// Coverage of one server, as GET /servers/:id/coverage answers it:
// {complete, problems:[string], items:[{kind:'container'|'volume', name, image?, state?, usedBy?:[name], status, app?:{id,name}, note?, skippedBy?, skippedAt?}]}
// status: 'backed-up' | 'pending' (an app covers it, first backup not verified yet) | 'not-backed-up' | 'skipped'.
const ORDER={'not-backed-up':0,pending:1,skipped:2,'backed-up':3};
export const NOTE_MAX=200;

export const sortItems=items=>[...(items||[])].sort((a,b)=>ORDER[a.status]-ORDER[b.status]||a.kind.localeCompare(b.kind)||a.name.localeCompare(b.name));

export function summarize(data){
 const items=data?.items||[],by=status=>items.filter(item=>item.status===status).length;
 return {total:items.length,backedUp:by('backed-up'),pending:by('pending'),notBackedUp:by('not-backed-up'),skipped:by('skipped'),partial:data?.complete===false,problems:data?.problems||[]};
}

// Containers that "Add app" selects: the container itself, or the containers that use a volume.
export const addTargets=item=>item.kind==='volume'?item.usedBy||[]:[item.name];

// Short text for a Map server node. An incomplete scan never reads as fully covered.
export function nodeLine(entry){
 if(!entry||entry.status==='loading')return {text:'Scanning…',tone:''};
 if(entry.status==='error')return {text:'Scan failed',tone:'warn'};
 const sum=summarize(entry.data);
 if(sum.notBackedUp)return {text:sum.notBackedUp+' not backed up',tone:'warn'};
 if(sum.partial)return {text:'Scan incomplete',tone:'warn'};
 return {text:sum.total?'All backed up':'Nothing to back up',tone:''};
}
