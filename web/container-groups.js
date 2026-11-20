export const containerName=container=>container.name||container.Name?.replace(/^\//,'')||container.id||container.Id;
export function containerGroups(containers){
 const groups=new Map();
 for(const container of containers){
  const labels={...container.Config?.Labels,...container.Labels,...container.labels};
  const project=labels['com.docker.compose.project'];
  const stack=labels['com.docker.stack.namespace'];
  const kind=project?'compose':stack?'swarm':'standalone';
  const name=project||stack||'Ungrouped containers';
  const id=kind+':'+(project||stack||'');
  if(!groups.has(id))groups.set(id,{id,name,kind,compose:kind==='compose',containers:[]});
  groups.get(id).containers.push({...container,service:labels['com.docker.compose.service']||labels['com.docker.swarm.service.name']||''});
 }
 return [...groups.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
// Plain containers that share a user-defined network (discovery's `networks`), offered as one suggested app. Containers
// joined through any chain of shared networks form one suggestion; only a pre-selection, the user can untick any of them.
export function suggestedGroups(containers){
 const plain=containerGroups(containers).find(group=>group.kind==='standalone')?.containers||[];
 let groups=[];
 for(const container of plain){
  const networks=container.networks||[];if(!networks.length)continue;
  const joined=groups.filter(group=>networks.some(name=>group.networks.has(name)));
  const merged={networks:new Set([...networks,...joined.flatMap(group=>[...group.networks])]),containers:[...joined.flatMap(group=>group.containers),containerName(container)]};
  groups=[...groups.filter(group=>!joined.includes(group)),merged];
 }
 return groups.filter(group=>group.containers.length>1).map(group=>({networks:[...group.networks].sort(),containers:group.containers.sort()})).sort((a,b)=>a.networks[0].localeCompare(b.networks[0]));
}
